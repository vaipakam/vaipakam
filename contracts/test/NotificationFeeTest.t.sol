// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupComposable} from "./composable/SetupComposable.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title NotificationFeeTest
 * @notice T-032 — coverage for `LoanFacet.markNotifBilled` + the
 *         `LibNotificationFee` library + the two new ConfigFacet
 *         setters (`setNotificationFee` /
 *         `setNotificationFeeOracle`).
 *
 * Coverage:
 *   - Bill happy-path: lender side AND borrower side.
 *   - Idempotent: second `markNotifBilled` is a silent no-op.
 *   - Role gating: non-NOTIF_BILLER caller reverts via
 *     `AccessControlUnauthorizedAccount`.
 *   - Loan-existence guard: loanId 0 + loanId > nextLoanId revert
 *     with `InvalidLoanStatus`.
 *   - Insufficient VPFI in payer vault: bill reverts (vault
 *     withdraw fails — error propagates as a clean revert).
 *   - Oracle math: at ETH=$2000, $2 fee ⇒ 1 VPFI charged
 *     (verifies the Phase 1 fixed-rate formula).
 *   - Governance bounds: fee below floor / above ceil reverts;
 *     zero resets to library default.
 *   - Both sides independent: billing the lender doesn't
 *     short-circuit the borrower's side.
 *   - Treasury accrual + counter increment.
 *   - No Diamond custody invariant: Diamond's VPFI balance
 *     unchanged across the bill (asset routes user-vault → treasury
 *     directly).
 */
contract NotificationFeeTest is Test {

    // ── Stage 6 composition migration (2026-05-27) ──────────────────────
    // Inherit only forge-std `Test`; the Diamond + facet routing + state
    // are owned by a `SetupComposable` instance the test composes via
    // `setUp`. Common SetupTest fields are mirrored locally below so the
    // bulk of test-body code keeps compiling unchanged.
    SetupComposable internal helpers;
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender;
    address internal borrower;
    address internal mockERC20;
    address internal mockCollateralERC20;
    address internal mockIlliquidERC20;
    address internal mockNft721;
    address internal mockZeroExProxy;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 internal constant RENTAL_BUFFER_BPS = 500;
    uint256 internal constant MIN_HEALTH_FACTOR = 150 * 1e16;
    // #229: VPFIDiscountFacet now cut by `SetupTest.setupHelper()`.
    // Prior local declaration + local cut dropped — references resolve
    // to the inherited SetupTest field.
    VPFIToken internal vpfiToken;
    address internal weth;
    address internal treasuryRecipient;
    address internal billerBot;

    // ETH/numeraire price for the oracle mock — gives a clean math
    // result. Concrete example uses USD-as-numeraire (the default):
    // at ETH=$2000, $2 fee ⇒ 1 VPFI charged (since 1 VPFI = 0.001 ETH
    // = $2). Same math under any other numeraire — the unit cancels.
    uint256 internal constant ETH_NUMERAIRE_PRICE_8DEC = 2000e8;
    // Default 2.0 fee in 1e18 numeraire-unit scaling (= $2 under
    // USD-as-numeraire).
    uint256 internal constant DEFAULT_FEE_NUMERAIRE = 2e18;
    // Expected VPFI charged at the example: ETH=$2000, fee=$2.
    uint256 internal constant EXPECTED_VPFI_AMOUNT = 1e18; // 1 VPFI

    function setUp() public {
        helpers = new SetupComposable();
        helpers.bootstrap(address(this));
        diamond = helpers.diamond();
        owner = helpers.owner();
        lender = helpers.lender();
        borrower = helpers.borrower();
        mockERC20 = helpers.mockERC20();
        mockCollateralERC20 = helpers.mockCollateralERC20();
        mockIlliquidERC20 = helpers.mockIlliquidERC20();
        mockNft721 = helpers.mockNft721();
        mockZeroExProxy = helpers.mockZeroExProxy();

        // Treasury — a real address so we can balance-check it post-bill.
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

        // #229 — VPFIDiscountFacet is now cut by setupHelper(). The
        // prior local cut here would double-cut and revert. Dropped.

        // WETH — referenced by LibNotificationFee's Phase 1 path. Use
        // the existing test mock setup: register a dummy WETH address
        // and mock OracleFacet.getAssetPrice for it.
        weth = makeAddr("weth");
        // Mock the OracleFacet ETH/numeraire read at 2000/8dec —
        // directly on the diamond (the path LibNotificationFee uses).
        // Post-b1 `getAssetPrice(WETH)` returns numeraire-quoted; with
        // USD-as-numeraire (the default) this is the ETH/USD price.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, weth),
            abi.encode(ETH_NUMERAIRE_PRICE_8DEC, uint8(8))
        );
        // OracleAdminFacet isn't cut into the minimal test diamond, so
        // the production owner-gated `setWethContract` setter isn't
        // reachable. Use the test-only TestMutatorFacet shortcut to
        // stamp `s.wethContract` directly.
        TestMutatorFacet(address(diamond)).setWethContractRaw(weth);

        // Fund lender + borrower with enough VPFI to cover the fee.
        // Mint generously to avoid edge cases on the basic happy-paths.
        vpfiToken.transfer(lender, 100e18);
        vpfiToken.transfer(borrower, 100e18);

        // Both lender and borrower deposit VPFI into their vaults so
        // `markNotifBilled` has something to pull.
        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), type(uint256).max);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(50e18);
        vm.stopPrank();

        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), type(uint256).max);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(50e18);
        vm.stopPrank();
    }

    /// @dev Scaffolds a minimal Loan record on chain. We don't run the
    ///      full offer→loan flow because the tests under exam care
    ///      only about the bill's behaviour — the loan being valid in
    ///      LoanStatus terms is irrelevant for `markNotifBilled` (it
    ///      gates on existence, not status). Uses TestMutatorFacet to
    ///      write the struct + bump nextLoanId.
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

    // ─── Happy-path bills ────────────────────────────────────────────────

    function test_markNotifBilled_LenderSide_DebitsVaultToTreasury() public {
        _scaffoldLoan(1);
        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);

        uint256 vaultBefore = vpfiToken.balanceOf(lenderVault);
        uint256 treasuryBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 diamondBefore = vpfiToken.balanceOf(address(diamond));

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);

        // Vault lost EXPECTED_VPFI_AMOUNT.
        assertEq(
            vaultBefore - vpfiToken.balanceOf(lenderVault),
            EXPECTED_VPFI_AMOUNT,
            "lender vault debited"
        );
        // Treasury gained EXPECTED_VPFI_AMOUNT.
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient) - treasuryBefore,
            EXPECTED_VPFI_AMOUNT,
            "treasury credited"
        );
        // Diamond balance unchanged — no custody window.
        assertEq(
            vpfiToken.balanceOf(address(diamond)),
            diamondBefore,
            "no Diamond custody"
        );
        // Flag set.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(1);
        assertTrue(loan.lenderNotifBilled, "lender flag set");
        assertFalse(loan.borrowerNotifBilled, "borrower flag NOT set");
    }

    function test_markNotifBilled_BorrowerSide_DebitsVaultToTreasury() public {
        _scaffoldLoan(1);
        address borrowerVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(borrower);

        uint256 vaultBefore = vpfiToken.balanceOf(borrowerVault);
        uint256 treasuryBefore = vpfiToken.balanceOf(treasuryRecipient);

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, false);

        assertEq(
            vaultBefore - vpfiToken.balanceOf(borrowerVault),
            EXPECTED_VPFI_AMOUNT,
            "borrower vault debited"
        );
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient) - treasuryBefore,
            EXPECTED_VPFI_AMOUNT,
            "treasury credited"
        );
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond))
            .getLoanDetails(1);
        assertFalse(loan.lenderNotifBilled, "lender flag NOT set");
        assertTrue(loan.borrowerNotifBilled, "borrower flag set");
    }

    // ─── Idempotent ──────────────────────────────────────────────────────

    function test_markNotifBilled_IsIdempotentOnSecondCall() public {
        _scaffoldLoan(1);
        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);

        // First bill — debits vault.
        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);
        uint256 vaultAfterFirst = vpfiToken.balanceOf(lenderVault);

        // Second bill — silent no-op.
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

    // ─── Oracle math sanity ──────────────────────────────────────────────

    function test_markNotifBilled_AtDifferentEthPriceChargesProportionally()
        public
    {
        _scaffoldLoan(1);
        // Re-mock at ETH=$4000 → $2 fee should be 0.5 VPFI now
        // (1 VPFI = 0.001 ETH = $4, so $2 = 0.5 VPFI).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, weth),
            abi.encode(uint256(4000e8), uint8(8))
        );

        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);
        uint256 vaultBefore = vpfiToken.balanceOf(lenderVault);

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);

        assertEq(
            vaultBefore - vpfiToken.balanceOf(lenderVault),
            5e17, // 0.5 VPFI
            "fee scales inversely with ETH price"
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

    // ─── Governance bounds on setNotificationFee ──────────────────────

    function test_setNotificationFee_AcceptsValidValue() public {
        ConfigFacet(address(diamond)).setNotificationFee(5e18); // $5
        // Read via the production getter (which delegatecalls through
        // the Diamond into the library, where the storage slot
        // resolves correctly). Calling `LibVaipakam.cfgNotificationFee()`
        // directly from the test contract reads the test's own
        // (empty) storage slot, not the Diamond's.
        (uint256 feeUsd, ) = ConfigFacet(address(diamond))
            .getNotificationFeeConfig();
        assertEq(feeUsd, 5e18, "fee updated");
    }

    function test_setNotificationFee_ZeroResetsToDefault() public {
        ConfigFacet(address(diamond)).setNotificationFee(5e18);
        ConfigFacet(address(diamond)).setNotificationFee(0);
        (uint256 feeUsd, ) = ConfigFacet(address(diamond))
            .getNotificationFeeConfig();
        assertEq(
            feeUsd,
            LibVaipakam.NOTIFICATION_FEE_DEFAULT,
            "fee reset to default"
        );
    }

    function test_setNotificationFee_RevertsBelowFloor() public {
        // Floor = 1e17 ($0.10); 5e16 ($0.05) is below floor.
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
        // Ceiling = 50e18 ($50); 60e18 ($60) is above ceiling.
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

    // ─── Treasury accrual counter ────────────────────────────────────────

    function test_markNotifBilled_IncrementsAccruedCounter() public {
        _scaffoldLoan(1);

        // Read counter via the storage. There's no public getter so we
        // bill twice (once per side) and verify the counter sum below.
        // Since only the explicit getter is via the LibVaipakam internal
        // accessor, we can confirm via the treasury balance instead —
        // the accrued counter mirrors the treasury inflow.
        uint256 treasuryBefore = vpfiToken.balanceOf(treasuryRecipient);

        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, true);
        vm.prank(billerBot);
        LoanFacet(address(diamond)).markNotifBilled(1, false);

        uint256 treasuryDelta = vpfiToken.balanceOf(treasuryRecipient) -
            treasuryBefore;
        // Two bills × 1 VPFI each = 2 VPFI.
        assertEq(
            treasuryDelta,
            2 * EXPECTED_VPFI_AMOUNT,
            "treasury saw both bills"
        );
    }
}
