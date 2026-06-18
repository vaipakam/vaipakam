// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";

/**
 * @title  BackstopAbsorbTest
 * @notice #399 / #401 v2.5 — backstop Role B (liquidator-of-last-resort).
 *         A FallbackPending loan whose lender opts into the cash exit is bought
 *         out by the keeper-executed `claimAsLenderViaBackstop`: the current
 *         lender-NFT owner is paid `lenderPrincipalDue` from the absorb-cash
 *         bucket, the backstop warehouses the lender collateral slice, and the
 *         treasury / borrower slices route normally. Plus the par-guard,
 *         cap, kill-switch, opt-in, and exposure-release paths.
 *
 * @dev    Reuses the InternalMatchExecution scaffolding pattern: seed an Active
 *         loan via TestMutatorFacet, populate a FallbackSnapshot, transition to
 *         FallbackPending, and mock the position NFT. `owner` holds KEEPER_ROLE
 *         (granted at init) so it doubles as the designated keeper. $1/18-dec
 *         oracle ⇒ the snapshot's 1:1 collateral≡principal equivalence holds.
 */
contract BackstopAbsorbTest is SetupTest {
    address internal vault;

    uint256 internal constant LOAN = 7001;
    uint256 internal constant SEED_CASH = 10_000 ether;
    uint256 internal constant CAP = 100_000 ether;
    uint256 internal constant PRINCIPAL = 500 ether;
    uint256 internal constant COLLATERAL = 1_000 ether;
    // FallbackSnapshot split (sums to COLLATERAL). 1:1 oracle ⇒ due == lenderCol.
    uint256 internal constant LENDER_COL = 550 ether;
    uint256 internal constant TREASURY_COL = 10 ether;
    uint256 internal constant BORROWER_COL = 440 ether;
    uint256 internal constant DUE = 550 ether;

    function setUp() public {
        setupHelper();

        vm.startPrank(owner);
        // Provision the backstop vault (Role A PR1 prerequisite).
        BackstopFacet(address(diamond)).initializeBackstopVaultImplementation();
        vault = BackstopFacet(address(diamond)).provisionBackstopVault();
        // Role B governance: enable master + absorb, set the cap, seed cash.
        BackstopFacet(address(diamond)).setBackstopEnabled(true);
        BackstopFacet(address(diamond)).setBackstopAbsorbEnabled(true);
        BackstopFacet(address(diamond)).setBackstopAbsorbCap(
            mockERC20,
            mockCollateralERC20,
            CAP
        );
        vm.stopPrank();

        _seedAbsorbCash(SEED_CASH);
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    function _seedAbsorbCash(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(address(diamond), amount);
        vm.startPrank(owner);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, amount);
        BackstopFacet(address(diamond)).seedBackstopAbsorb(
            mockERC20,
            mockCollateralERC20,
            amount
        );
        vm.stopPrank();
    }

    /// @dev Scaffold an Active loan (lends mockERC20 vs mockCollateralERC20).
    function _seedLoan(uint256 id, address lender_, address borrower_) internal {
        LibVaipakam.Loan memory l;
        l.id = id;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = mockERC20;
        l.principal = PRINCIPAL;
        l.collateralAsset = mockCollateralERC20;
        l.collateralAmount = COLLATERAL;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);

        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower_
        );
        ERC20Mock(mockCollateralERC20).mint(bVault, COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower_, mockCollateralERC20, COLLATERAL
        );
    }

    /// @dev Move the seeded loan into FallbackPending with the Diamond holding
    ///      the collateral and a snapshot recorded (`lenderCol` overridable for
    ///      the par-guard test).
    function _moveToFallbackPending(
        uint256 id,
        address borrower_,
        uint256 lenderCol
    ) internal {
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower_
        );
        vm.prank(bVault);
        IERC20(mockCollateralERC20).transfer(address(diamond), COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower_, mockCollateralERC20, 0
        );
        LibVaipakam.FallbackSnapshot memory snap = LibVaipakam.FallbackSnapshot({
            lenderCollateral: lenderCol,
            treasuryCollateral: TREASURY_COL,
            borrowerCollateral: BORROWER_COL,
            lenderPrincipalDue: DUE,
            treasuryPrincipalDue: TREASURY_COL,
            active: true,
            retryAttempted: false
        });
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(id, snap);
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            id,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.FallbackPending
        );
    }

    /// @dev Mock the lender position NFT: `ownerOf(lenderTokenId)` → owner_, and
    ///      the void updateNFTStatus / burnNFT cross-facet calls no-op.
    function _mockLenderNft(uint256 id, address owner_) internal {
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(id).lenderTokenId;
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, tokenId),
            abi.encode(owner_)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            ""
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            ""
        );
    }

    /// @dev Full FallbackPending fixture with the lender opted into the cash exit.
    function _fallbackOptedIn(address lender_, address borrower_) internal {
        _seedLoan(LOAN, lender_, borrower_);
        _moveToFallbackPending(LOAN, borrower_, LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
    }

    function _emptyRetry() internal pure returns (LibSwap.AdapterCall[] memory) {
        return new LibSwap.AdapterCall[](0);
    }

    // ─── opt-in ───────────────────────────────────────────────────────────────

    function test_optIn_byNftOwner() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"), LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
        // (no revert) — flag set; exercised by the absorb happy path.
    }

    function test_optIn_notNftOwner_reverts() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"), LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(); // NotNFTOwner (LibAuth)
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
    }

    // ─── absorb happy path ──────────────────────────────────────────────────

    function test_absorb_paysCashToOwner_warehousesCollateral() public {
        address lender_ = makeAddr("lender7");
        address borrower_ = makeAddr("borrower7");
        _fallbackOptedIn(lender_, borrower_);

        uint256 ownerCashBefore = IERC20(mockERC20).balanceOf(lender_);
        uint256 treasuryColBefore =
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockCollateralERC20);
        address bsVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(vault);
        uint256 bsColBefore = IERC20(mockCollateralERC20).balanceOf(bsVault);

        // owner holds KEEPER_ROLE (granted at init) → it is the designated keeper.
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());

        // Lender (NFT owner) paid cash = lenderPrincipalDue.
        assertEq(IERC20(mockERC20).balanceOf(lender_) - ownerCashBefore, DUE, "cash to owner");
        // Backstop warehouses the lender collateral slice.
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(bsVault) - bsColBefore,
            LENDER_COL,
            "collateral warehoused"
        );
        // Treasury slice routed normally.
        assertEq(
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockCollateralERC20) - treasuryColBefore,
            TREASURY_COL,
            "treasury slice"
        );
        // Exposure incremented by the cash spent.
        (uint256 cash, uint256 exposure, ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);
        assertEq(exposure, DUE, "exposure ++ by due");
        assertEq(cash, SEED_CASH - DUE, "cash bucket debited");
        // Loan terminal.
        LibVaipakam.LoanStatus st = LoanFacet(address(diamond)).getLoanDetails(LOAN).status;
        assertTrue(
            st == LibVaipakam.LoanStatus.Defaulted || st == LibVaipakam.LoanStatus.Settled,
            "loan terminal"
        );
    }

    // ─── guards ────────────────────────────────────────────────────────────

    function test_absorb_parGuard_underwater_reverts() public {
        address lender_ = makeAddr("lender7");
        address borrower_ = makeAddr("borrower7");
        // lenderCollateral (500) worth LESS than lenderPrincipalDue (550) at 1:1.
        _seedLoan(LOAN, lender_, borrower_);
        _moveToFallbackPending(LOAN, borrower_, 500 ether);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);

        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopUndercollateralized.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_capExceeded_reverts() public {
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopAbsorbCap(
            mockERC20, mockCollateralERC20, 100 ether // below DUE (550)
        );
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopAbsorbCapExceeded.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_insufficientCash_reverts() public {
        // Fresh pair with a cap but no seeded cash.
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopAbsorbCap(
            mockERC20, mockCollateralERC20, CAP
        );
        // Drain the seeded cash by spending it: simplest is a separate unseeded
        // pair — here re-point by zeroing via a large absorb is complex, so use a
        // loan whose due exceeds the bucket. Seed bucket is SEED_CASH (10k) >> DUE,
        // so instead assert the guard via a cap-sized-but-cashless fresh deploy:
        // spin a second collateral with a cap but no cash.
        address lender_ = makeAddr("lender7");
        address borrower_ = makeAddr("borrower7");
        _seedLoan(LOAN, lender_, borrower_);
        _moveToFallbackPending(LOAN, borrower_, LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);

        // Zero the absorb-cash bucket to isolate the insufficient-cash guard.
        TestMutatorFacet(address(diamond)).setBackstopAbsorbCashRaw(
            mockERC20, mockCollateralERC20, 0
        );
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopAbsorbInsufficientCash.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_notOptedIn_reverts() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"), LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        // no opt-in
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.NotBackstopAbsorbable.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_disabled_reverts() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopAbsorbEnabled(false);
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopAbsorbDisabled.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_nonKeeper_reverts() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(makeAddr("notKeeper"));
        vm.expectRevert(); // AccessControl: missing KEEPER_ROLE
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    // ─── realized-cash release ───────────────────────────────────────────────

    function test_releaseExposure_decrementsOnRealizedCash() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());

        (, uint256 exposureBefore, ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);
        assertEq(exposureBefore, DUE, "exposure outstanding");

        // Governance attests realized cash from selling the warehoused collateral.
        vm.prank(owner);
        BackstopFacet(address(diamond)).releaseBackstopAbsorbExposure(
            mockERC20, mockCollateralERC20, DUE
        );
        (, uint256 exposureAfter, ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);
        assertEq(exposureAfter, 0, "exposure released");
    }

    function test_seedAbsorb_vpfiLending_reverts() public {
        vm.startPrank(owner);
        // Rotate vpfiToken onto the seed's principal asset.
        // (Reuses the same post-rotation guard as the origination seed.)
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        ERC20Mock(mockERC20).mint(address(diamond), SEED_CASH);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, SEED_CASH);
        vm.expectRevert(BackstopFacet.VpfiLendingUnsupported.selector);
        BackstopFacet(address(diamond)).seedBackstopAbsorb(
            mockERC20, mockCollateralERC20, SEED_CASH
        );
        vm.stopPrank();
    }
}
