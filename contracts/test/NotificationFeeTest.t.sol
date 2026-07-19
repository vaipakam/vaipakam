// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title NotificationFeeTest
 * @notice T-032 + Recycling M1 (#1346) — coverage for
 *         `LoanFacet.markNotifBilled` + the `LibNotificationFee` library
 *         + the `ConfigFacet.setNotificationFee` setter.
 *
 * M1 re-shapes the tariff (see `LibNotificationFee` /
 * `VpfiRecyclingBalanceGovernorDesign.md` §4.1):
 *   - **Flat native-VPFI tariff** — the configured fee IS the VPFI amount
 *     billed, a quantity, NOT a numeraire figure converted through the
 *     ETH/numeraire oracle + `VPFI_PER_ETH_FIXED_PHASE1` peg (the §14.2
 *     conversion class is forbidden at launch). No oracle in the path.
 *   - **Custody re-route into the recycle loop** — the tariff moves
 *     user-vault → Diamond custody and credits the recycle bucket
 *     (`RecycleSource.NotificationFee`), never routed to treasury.
 *   - **#973/L26 restamp** — the vault debit runs the mandatory discount
 *     accumulator rollup at the post-mutation balance.
 *   - **Numeraire de-link** — a `setNumeraire` rotation no longer touches
 *     the flat VPFI tariff.
 */
contract NotificationFeeTest is SetupTest {
    // #229: VPFIDiscountFacet now cut by `SetupTest.setupHelper()`.
    VPFIToken internal vpfiToken;
    address internal treasuryRecipient;
    address internal billerBot;

    // Recycling M1: the default flat tariff is 0.5 VPFI — the exact amount
    // billed with no config override (no oracle, no numeraire conversion).
    uint256 internal constant EXPECTED_VPFI_AMOUNT = 5e17; // 0.5 VPFI

    function setUp() public {
        setupHelper();

        // Treasury — a real address so we can assert it is NOT credited
        // (M1 routes the tariff into the recycle bucket, not treasury).
        treasuryRecipient = makeAddr("treasury");
        AdminFacet(address(diamond)).setTreasury(treasuryRecipient);

        // Off-chain biller bot — granted NOTIF_BILLER_ROLE explicitly.
        billerBot = makeAddr("bot.notif");
        AccessControlFacet(address(diamond)).grantRole(
            LibAccessControl.NOTIF_BILLER_ROLE,
            billerBot
        );

        // Deploy VPFI token behind UUPS proxy + register on Diamond.
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfiToken = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));

        // Fund lender + borrower with VPFI, then deposit into their vaults
        // so `markNotifBilled` has something to pull.
        vpfiToken.transfer(lender, 100e18);
        vpfiToken.transfer(borrower, 100e18);

        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), type(uint256).max);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(50e18);
        vm.stopPrank();

        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), type(uint256).max);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(50e18);
        vm.stopPrank();
    }

    /// @dev Scaffolds a minimal Loan record. `markNotifBilled` gates on
    ///      existence, not status, so the full offer→loan flow is
    ///      unnecessary for these tests.
    function _scaffoldLoan(uint256 loanId) internal {
        LibVaipakam.Loan memory loan;
        loan.lender = lender;
        loan.borrower = borrower;
        loan.principal = 100e18;
        loan.principalAsset = mockERC20;
        loan.interestRateBps = 500;
        loan.durationDays = 30;
        loan.status = LibVaipakam.LoanStatus.Active;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
        if (loanId > 0) {
            TestMutatorFacet(address(diamond)).setNextLoanId(loanId);
        }
    }

    // ─── Happy-path bills — custody re-route + recycle credit ────────────

    function test_markNotifBilled_LenderSide_DebitsVaultToRecycleBucket()
        public
    {
        _scaffoldLoan(1);
        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);

        uint256 vaultBefore = vpfiToken.balanceOf(lenderVault);
        uint256 treasuryBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 diamondBefore = vpfiToken.balanceOf(address(diamond));
        uint256 bucketBefore =
            ConfigFacet(address(diamond)).getRecycleBucket();

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);

        // Vault lost the flat tariff.
        assertEq(
            vaultBefore - vpfiToken.balanceOf(lenderVault),
            EXPECTED_VPFI_AMOUNT,
            "lender vault debited"
        );
        // Diamond GAINED the tariff — it now sits in Diamond custody.
        assertEq(
            vpfiToken.balanceOf(address(diamond)) - diamondBefore,
            EXPECTED_VPFI_AMOUNT,
            "Diamond took custody"
        );
        // Recycle bucket grew by the tariff (the absorption credit).
        assertEq(
            ConfigFacet(address(diamond)).getRecycleBucket() - bucketBefore,
            EXPECTED_VPFI_AMOUNT,
            "recycle bucket credited"
        );
        // Treasury UNCHANGED — the tariff is recycled, not a treasury cut.
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryBefore,
            "treasury not credited"
        );
        // Flag set.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(1);
        assertTrue(loan.lenderNotifBilled, "lender flag set");
        assertFalse(loan.borrowerNotifBilled, "borrower flag NOT set");
    }

    function test_markNotifBilled_BorrowerSide_DebitsVaultToRecycleBucket()
        public
    {
        _scaffoldLoan(1);
        address borrowerVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(borrower);

        uint256 vaultBefore = vpfiToken.balanceOf(borrowerVault);
        uint256 bucketBefore =
            ConfigFacet(address(diamond)).getRecycleBucket();

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, false);

        assertEq(
            vaultBefore - vpfiToken.balanceOf(borrowerVault),
            EXPECTED_VPFI_AMOUNT,
            "borrower vault debited"
        );
        assertEq(
            ConfigFacet(address(diamond)).getRecycleBucket() - bucketBefore,
            EXPECTED_VPFI_AMOUNT,
            "recycle bucket credited"
        );
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(1);
        assertFalse(loan.lenderNotifBilled, "lender flag NOT set");
        assertTrue(loan.borrowerNotifBilled, "borrower flag set");
    }

    /// @notice The credit surfaces on the `VpfiRecycled` feed under the
    ///         `NotificationFee` source, keyed by loanId — the first live
    ///         non-forfeit absorption class.
    function test_markNotifBilled_EmitsVpfiRecycledWithNotificationFeeSource()
        public
    {
        _scaffoldLoan(1);

        // Match indexed source + indexed refId (loanId); leave the data
        // (amount, dayId) unchecked — the bucket-delta assertions above
        // pin the amount, and dayId depends on schedule state.
        vm.expectEmit(true, true, false, false, address(diamond));
        emit LibVpfiRecycle.VpfiRecycled(
            uint8(LibVpfiRecycle.RecycleSource.NotificationFee),
            1,
            EXPECTED_VPFI_AMOUNT,
            0
        );

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);
    }

    // ─── #973 / L26 — discount restamp on the vault debit ────────────────

    /// @notice The bill runs the mandatory discount-accumulator rollup at
    ///         the post-mutation balance — closing the L26 gap where a
    ///         VPFI outflow left a stale fee-tier stamp behind.
    function test_markNotifBilled_RestampsPayerDiscountTier() public {
        _scaffoldLoan(1);

        // Assert the accumulator rollup is invoked during the bill (the
        // self-call routes through the Diamond by selector). A prefix
        // match on the selector proves the restamp tail runs, without
        // coupling to the TWA internals.
        vm.expectCall(
            address(diamond),
            abi.encodeWithSelector(
                VPFIDiscountAccumulatorFacet.rollupUserDiscount.selector
            )
        );

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);
    }

    // ─── Idempotent ──────────────────────────────────────────────────────

    function test_markNotifBilled_IsIdempotentOnSecondCall() public {
        _scaffoldLoan(1);
        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);
        uint256 vaultAfterFirst = vpfiToken.balanceOf(lenderVault);

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);

        assertEq(
            vpfiToken.balanceOf(lenderVault),
            vaultAfterFirst,
            "second call did not double-debit"
        );
    }

    // ─── Role gating ─────────────────────────────────────────────────────

    function test_markNotifBilled_RevertsWhenCallerLacksRole() public {
        _scaffoldLoan(1);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(); // AccessControlUnauthorizedAccount(attacker, NOTIF_BILLER_ROLE)
        LoanFacet(address(diamond)).markNotifBilled(1, true);
    }

    // ─── Loan-existence guard ────────────────────────────────────────────

    function test_markNotifBilled_RevertsOnLoanIdZero() public {
        _scaffoldLoan(1);
        vm.prank(billerBot);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        LoanFacet(address(diamond)).markNotifBilled(0, true);
    }

    function test_markNotifBilled_RevertsOnLoanIdAboveNext() public {
        _scaffoldLoan(1);
        vm.prank(billerBot);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        LoanFacet(address(diamond)).markNotifBilled(2, true);
    }

    // ─── Insufficient VPFI ───────────────────────────────────────────────

    function test_markNotifBilled_RevertsWhenPayerVaultEmpty() public {
        _scaffoldLoan(1);

        // Empty the lender's VPFI vault.
        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);
        uint256 lenderVaultBalance = vpfiToken.balanceOf(lenderVault);
        vm.prank(lender);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(
            lenderVaultBalance
        );

        vm.prank(billerBot);
        vm.expectRevert(); // ProxyCallFailed("Withdraw ERC20 failed") OR similar
        LoanFacet(address(diamond)).markNotifBilled(1, true);
    }

    // ─── Flat tariff — no oracle, exact configured amount ────────────────

    /// @notice The bill charges EXACTLY the configured flat VPFI tariff,
    ///         with no oracle/ETH-price dependence.
    function test_markNotifBilled_ChargesExactConfiguredFlatTariff() public {
        _scaffoldLoan(1);
        // Governance sets a distinct flat tariff (VPFI wei).
        ConfigFacet(address(diamond)).setNotificationFee(3e18); // 3 VPFI

        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);
        uint256 vaultBefore = vpfiToken.balanceOf(lenderVault);

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);

        assertEq(
            vaultBefore - vpfiToken.balanceOf(lenderVault),
            3e18,
            "charges the exact flat tariff"
        );
    }

    // ─── Both sides independent ──────────────────────────────────────────

    function test_markNotifBilled_BothSidesIndependent() public {
        _scaffoldLoan(1);

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);
        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, false);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(1);
        assertTrue(loan.lenderNotifBilled, "lender billed");
        assertTrue(loan.borrowerNotifBilled, "borrower billed");
    }

    // ─── Numeraire de-link (M1a) ─────────────────────────────────────────

    /// @notice A `setNumeraire` rotation MUST NOT touch the flat VPFI
    ///         tariff — it has no numeraire linkage. (Pre-M1 the fee lived
    ///         in the numeraire-denominated slot the rotation clobbered.)
    function test_setNumeraire_LeavesNotificationTariffUntouched() public {
        // Set a distinct flat tariff first.
        ConfigFacet(address(diamond)).setNotificationFee(7e18); // 7 VPFI

        // Rotate to a hypothetical EUR numeraire (structure-only; the
        // notification tariff is deliberately absent from the signature).
        NumeraireConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        NumeraireConfigFacet(address(diamond)).setNumeraire(
            makeAddr("ethEurFeed"),
            makeAddr("eurDenom"),
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32("eur"),
            bytes32(0),
            5_000 * 1e18, // threshold
            0, // kyc tier0
            0 // kyc tier1
        );

        (uint256 feeVpfi, ) =
            ConfigFacet(address(diamond)).getNotificationFeeConfig();
        assertEq(feeVpfi, 7e18, "tariff survived the numeraire rotation");
    }

    // ─── Governance bounds on setNotificationFee ──────────────────────

    function test_setNotificationFee_AcceptsValidValue() public {
        ConfigFacet(address(diamond)).setNotificationFee(5e18); // 5 VPFI
        (uint256 feeVpfi, ) = ConfigFacet(address(diamond))
            .getNotificationFeeConfig();
        assertEq(feeVpfi, 5e18, "tariff updated");
    }

    function test_setNotificationFee_ZeroResetsToDefault() public {
        ConfigFacet(address(diamond)).setNotificationFee(5e18);
        ConfigFacet(address(diamond)).setNotificationFee(0);
        (uint256 feeVpfi, ) = ConfigFacet(address(diamond))
            .getNotificationFeeConfig();
        assertEq(
            feeVpfi,
            LibVaipakam.NOTIFICATION_FEE_DEFAULT,
            "tariff reset to default (0.5 VPFI)"
        );
    }

    function test_setNotificationFee_RevertsBelowFloor() public {
        // Floor = 1e17 (0.1 VPFI); 5e16 (0.05 VPFI) is below floor.
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidNotificationFee.selector,
                uint256(5e16),
                LibVaipakam.MIN_NOTIFICATION_FEE_FLOOR,
                LibVaipakam.MAX_NOTIFICATION_FEE_CEIL
            )
        );
        ConfigFacet(address(diamond)).setNotificationFee(5e16);
    }

    function test_setNotificationFee_RevertsAboveCeiling() public {
        // Ceiling = 50e18 (50 VPFI); 60e18 is above ceiling.
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidNotificationFee.selector,
                uint256(60e18),
                LibVaipakam.MIN_NOTIFICATION_FEE_FLOOR,
                LibVaipakam.MAX_NOTIFICATION_FEE_CEIL
            )
        );
        ConfigFacet(address(diamond)).setNotificationFee(60e18);
    }

    // ─── Accrual counter ─────────────────────────────────────────────────

    function test_markNotifBilled_IncrementsAccruedCounter() public {
        _scaffoldLoan(1);

        (, uint256 accruedBefore) =
            ConfigFacet(address(diamond)).getNotificationFeeConfig();

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);
        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, false);

        (, uint256 accruedAfter) =
            ConfigFacet(address(diamond)).getNotificationFeeConfig();
        // Two bills × the flat tariff each.
        assertEq(
            accruedAfter - accruedBefore,
            2 * EXPECTED_VPFI_AMOUNT,
            "accrued counter saw both bills"
        );
    }
}
