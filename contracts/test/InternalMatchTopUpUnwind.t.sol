// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title InternalMatchTopUpUnwind.t.sol
 * @notice #591 (#585 Part B) — the internal-match top-up-aware unwind.
 *
 *         A `FallbackPending` loan that received an `AddCollateral`
 *         top-up has its collateral SPLIT:
 *           - `snapshotTotal` (the original collateral) sits in the
 *             Diamond's custody (moved there at fallback), and
 *           - the `topUp` sits in `loan.borrower`'s vault under an
 *             active (non-released) collateral lien.
 *         `loan.collateralAmount == snapshotTotal + topUp`.
 *
 *         Pre-#591 such loans were EXCLUDED from internal match (the
 *         draw would over-run Diamond custody, taking collateral
 *         belonging to OTHER fallback loans). #591 replaces the
 *         exclusion with top-up-aware accounting: the match sizes the
 *         leg's contribution against the Diamond portion only
 *         (`_diamondMatchable`) and the vault top-up is returned to the
 *         CURRENT borrower-position holder via `borrowerClaims` +
 *         `claimAsBorrower`.
 *
 *         This suite seeds a faithful topped-up loan (Diamond holds
 *         `snapshotTotal`; vault holds `topUp`, liened) and exercises
 *         the §5 matrix: full match, partial match, zero-residual,
 *         transferred borrower position, and the custody invariant.
 */
contract InternalMatchTopUpUnwindTest is SetupTest {
    uint256 internal constant LOAN_A = 6001; // topped-up FallbackPending leg
    uint256 internal constant LOAN_B = 6002; // opposing counterparty
    uint256 internal constant LOAN_D = 6003; // unrelated fallback loan (custody-invariant test)

    address internal matcher;
    address internal borrowerB;
    address internal lenderB;
    address internal borrowerD;
    address internal lenderD;

    function setUp() public {
        setupHelper();
        matcher = makeAddr("matcher");
        borrowerB = makeAddr("borrowerB");
        lenderB = makeAddr("lenderB");
        borrowerD = makeAddr("borrowerD");
        lenderD = makeAddr("lenderD");

        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
    }

    // ─────────────────────────── fixtures ───────────────────────────

    /// @dev Seed an Active loan struct + fund the borrower's vault with
    ///      the collateral (mirrors InternalMatchExecution's `_seedLoan`).
    function _seedLoan(
        uint256 id,
        address lender_,
        address borrower_,
        address principal,
        uint256 principalAmt,
        address collateral,
        uint256 collateralAmt
    ) internal {
        LibVaipakam.Loan memory l;
        l.id = id;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = principal;
        l.principal = principalAmt;
        l.collateralAsset = collateral;
        l.collateralAmount = collateralAmt;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        // #691 — distinct position-NFT ids + `ownerOf`→stored-owner mocks so the
        // #658 eager-consolidation hook resolves `ownerOf` on an Active match
        // leg (holder == stored ⇒ no-op). FallbackPending legs are skipped by
        // the primitive before any `ownerOf`, so they need nothing here.
        l.borrowerTokenId = id * 2;
        l.lenderTokenId = id * 2 + 1;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, id * 2),
            abi.encode(borrower_)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, id * 2 + 1),
            abi.encode(lender_)
        );

        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        ERC20Mock(collateral).mint(bVault, collateralAmt);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower_, collateral, collateralAmt
        );
    }

    /// @dev Move an Active loan into FallbackPending with the WHOLE
    ///      `collateralAmt` in Diamond custody (no top-up). Mirrors
    ///      InternalMatchExecution's `_moveToFallbackPending`.
    function _moveToFallbackPending(
        uint256 loanId,
        address borrower_,
        address collateral,
        uint256 collateralAmt,
        uint256 lenderEntitlement,
        uint256 treasuryEntitlement
    ) internal {
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        vm.prank(bVault);
        IERC20(collateral).transfer(address(diamond), collateralAmt);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower_, collateral, 0);

        uint256 borrowerEntitlement = collateralAmt > (lenderEntitlement + treasuryEntitlement)
            ? collateralAmt - lenderEntitlement - treasuryEntitlement
            : 0;
        LibVaipakam.FallbackSnapshot memory snap = LibVaipakam.FallbackSnapshot({
            lenderCollateral: lenderEntitlement,
            treasuryCollateral: treasuryEntitlement,
            borrowerCollateral: borrowerEntitlement,
            lenderPrincipalDue: lenderEntitlement,
            treasuryPrincipalDue: treasuryEntitlement,
            active: true,
            retryAttempted: false
        });
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(loanId, snap);
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            loanId, LibVaipakam.LoanStatus.Active, LibVaipakam.LoanStatus.FallbackPending
        );
    }

    /// @dev Seed a FAITHFUL topped-up FallbackPending loan:
    ///        - `loan.collateralAmount == snapshotTotal + topUp`,
    ///        - the Diamond holds `snapshotTotal` of the collateral,
    ///        - `loan.borrower`'s vault holds `topUp`, under an active
    ///          (non-released) collateral lien,
    ///        - the fallback snapshot describes ONLY `snapshotTotal`
    ///          (split lender/treasury/borrower entitlement),
    ///        - status is FallbackPending.
    ///      `principalAmt` is the loan's outstanding principal.
    function _seedToppedUpFallback(
        uint256 id,
        address lender_,
        address borrower_,
        address principal,
        uint256 principalAmt,
        address collateral,
        uint256 snapshotTotal,
        uint256 topUp,
        uint256 lenderEntitlement,
        uint256 treasuryEntitlement
    ) internal {
        // Loan carries the FULL (snapshot + top-up) collateral.
        LibVaipakam.Loan memory l;
        l.id = id;
        l.status = LibVaipakam.LoanStatus.FallbackPending;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = principal;
        l.principal = principalAmt;
        l.collateralAsset = collateral;
        l.collateralAmount = snapshotTotal + topUp;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);

        // Diamond custody holds the snapshot portion.
        ERC20Mock(collateral).mint(address(diamond), snapshotTotal);

        // Borrower vault holds the top-up, protocol-tracked + liened.
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        ERC20Mock(collateral).mint(bVault, topUp);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower_, collateral, topUp);
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            id, borrower_, collateral, 0, topUp, LibVaipakam.AssetType.ERC20
        );

        // Snapshot describes the Diamond portion only.
        uint256 borrowerEntitlement = snapshotTotal > (lenderEntitlement + treasuryEntitlement)
            ? snapshotTotal - lenderEntitlement - treasuryEntitlement
            : 0;
        LibVaipakam.FallbackSnapshot memory snap = LibVaipakam.FallbackSnapshot({
            lenderCollateral: lenderEntitlement,
            treasuryCollateral: treasuryEntitlement,
            borrowerCollateral: borrowerEntitlement,
            lenderPrincipalDue: lenderEntitlement,
            treasuryPrincipalDue: treasuryEntitlement,
            active: true,
            retryAttempted: false
        });
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(id, snap);
    }

    function _mockLtv(uint256 loanId, uint256 ltv) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId),
            abi.encode(ltv)
        );
    }

    function _getLoan(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    function _mockBorrowerNftHolder(uint256 loanId, address holder) internal {
        uint256 tokenId = _getLoan(loanId).borrowerTokenId;
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, tokenId),
            abi.encode(holder)
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

    // ──────────────────── 1. topped-up FULL match ───────────────────

    /// @notice §5.1 — a topped-up FallbackPending loan that is FULLY
    ///         matched: the Diamond portion is consumed by the match, the
    ///         loan transitions to InternalMatched, and the top-up + the
    ///         Diamond residual are claimable (via `claimAsBorrower`) by
    ///         the current borrower-position holder. Lender proceeds are
    ///         routed per #585 (lenderClaims).
    function test_toppedUp_fullMatch_residualToBorrowerHolder() public {
        // A: 600 principal X, collateral split = 800 Diamond + 200 vault
        //    (= 1000 total Y). B: 600 Y debt, 600 X collateral.
        // Match: movedX = min(600, _diamondMatchable(A)=800) = 600 of A's
        //        Diamond Y → B... wait, A pays B with A's collateral.
        // Leg Y consumes A's collateral: movedY = min(B.principal=600,
        //        _diamondMatchable(A)=800) = 600. A.principal cleared by
        //        Leg X = min(A.principal=600, _diamondMatchable(B)=600)=600.
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 600, mockCollateralERC20, 800, 200, 760, 20);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600, mockERC20, 600);
        _mockLtv(LOAN_B, 9_000);

        uint256 diamondYBefore = IERC20(mockCollateralERC20).balanceOf(address(diamond));

        vm.prank(matcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);

        LibVaipakam.Loan memory a = _getLoan(LOAN_A);
        // A fully matched.
        assertEq(uint8(a.status), uint8(LibVaipakam.LoanStatus.InternalMatched), "A InternalMatched");
        assertEq(a.principal, 0, "A principal cleared");
        // collateralAmount after = 1000 - movedY(600) = 400 residual
        // (= diamondAfter 200 + topUp 200).
        assertEq(a.collateralAmount, 400, "A collateral residual = diamondAfter + topUp");

        // The entire Diamond-held snapshot (800) exits the Diamond: movedY=600
        // matched out to B's lender, and the diamondAfter=200 residual pushed
        // to the borrower's vault. The vault top-up (200) was never in the
        // Diamond, so custody never over-drew.
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(address(diamond)),
            diamondYBefore - 800,
            "Diamond released only its own 800 snapshot (600 matched + 200 residual)"
        );

        // Borrower residual claim covers the WHOLE residual (400).
        (, uint256 borrowerClaimAmt, ) =
            ClaimFacet(address(diamond)).getClaimableAmount(LOAN_A, false);
        assertEq(borrowerClaimAmt, 400, "borrowerClaims = full residual");

        // The lien now covers the whole residual (200 top-up + 200 diamondAfter).
        (uint256 lienAmt, bool released) =
            TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(LOAN_A);
        assertEq(lienAmt, 400, "lien grew to cover the whole residual");
        assertFalse(released, "lien not released at match");

        // The CURRENT borrower-position holder (transferred away) claims the
        // residual via claimAsBorrower; both the top-up (already in vault)
        // and the diamondAfter (pushed to vault at match) are paid out.
        address newHolder = makeAddr("newHolder");
        _mockBorrowerNftHolder(LOAN_A, newHolder);
        uint256 holderYBefore = IERC20(mockCollateralERC20).balanceOf(newHolder);
        vm.prank(newHolder);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN_A);
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(newHolder) - holderYBefore,
            400,
            "current holder receives the full residual (top-up + diamondAfter)"
        );
    }

    /// @notice #591 (Codex #605 round-2 P1) — a topped-up FallbackPending loan
    ///         partially matched such that the match consumes the ENTIRE Diamond
    ///         portion while principal remains. The vault top-up must NOT be
    ///         stranded: the loan resolves terminally (InternalMatched), the
    ///         top-up is recorded as a borrowerClaims and recovered by the
    ///         CURRENT holder, and the remaining principal is written off.
    function test_toppedUp_partialMatch_exhaustsDiamond_topUpStillClaimable() public {
        // A: principal 600 (X); collateral = Diamond 800 (Y) + topUp 200 (Y).
        // B: principal 800 (Y) ≥ A's Diamond 800 (so movedY=800 consumes it all),
        //    collateral 500 (X) < A's principal 600 (so movedX=500, A.principal=100 remains).
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 600, mockCollateralERC20, 800, 200, 760, 20);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 800, mockERC20, 500);
        _mockLtv(LOAN_B, 9_000);

        uint256 diamondYBefore = IERC20(mockCollateralERC20).balanceOf(address(diamond));

        vm.prank(matcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);

        LibVaipakam.Loan memory a = _getLoan(LOAN_A);
        // Diamond fully consumed (movedY=800) → terminal resolution, not stuck FallbackPending.
        assertEq(uint8(a.status), uint8(LibVaipakam.LoanStatus.InternalMatched), "A resolved terminally");
        assertEq(a.principal, 0, "remaining principal written off (lender fallback shortfall)");
        assertEq(a.collateralAmount, 200, "only the top-up remains");

        // Diamond released exactly its own 800 snapshot (all matched out); never over-drew.
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(address(diamond)),
            diamondYBefore - 800,
            "Diamond released only its 800 snapshot"
        );

        // Top-up is NOT stranded — recorded as a borrower claim.
        (, uint256 borrowerClaimAmt, ) = ClaimFacet(address(diamond)).getClaimableAmount(LOAN_A, false);
        assertEq(borrowerClaimAmt, 200, "top-up recorded as borrower claim");

        // Current (transferred-away) holder recovers the top-up.
        address newHolder = makeAddr("newHolderExhaust");
        _mockBorrowerNftHolder(LOAN_A, newHolder);
        uint256 holderBefore = IERC20(mockCollateralERC20).balanceOf(newHolder);
        vm.prank(newHolder);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN_A);
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(newHolder) - holderBefore,
            200,
            "current holder recovers the top-up (not stranded)"
        );
    }

    // ──────────────────── 2. topped-up PARTIAL match ────────────────

    /// @notice §5.2 — a topped-up FallbackPending loan PARTIALLY matched:
    ///         stays FallbackPending, the snapshot is scaled on the
    ///         DIAMOND base (not the full collateralAmount), and the
    ///         top-up lien is left intact.
    function test_toppedUp_partialMatch_snapshotScaledOnDiamondBase() public {
        // A: 10_000 principal X, collateral = 8_000 Diamond + 2_000 vault.
        //    Snapshot: lender 6_800 / treasury 200 / borrower 1_000 (= 8_000).
        // B: 3_000 Y debt, 3_000 X collateral (Active).
        // Leg Y consumes A's collateral: movedY = min(B.principal 3_000,
        //   _diamondMatchable(A)=8_000) = 3_000. A's principal cleared by
        //   Leg X = min(A.principal 10_000, _diamondMatchable(B)=3_000)=3_000.
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 10_000, mockCollateralERC20, 8_000, 2_000, 6_800, 200);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 3_000, mockERC20, 3_000);
        _mockLtv(LOAN_B, 9_000);

        (uint256 lienBefore, ) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(LOAN_A);
        assertEq(lienBefore, 2_000, "precondition: top-up lien = 2_000");

        vm.prank(matcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);

        LibVaipakam.Loan memory a = _getLoan(LOAN_A);
        assertEq(uint8(a.status), uint8(LibVaipakam.LoanStatus.FallbackPending), "A stays FallbackPending");
        assertEq(a.principal, 7_000, "A principal reduced by 3_000");
        // collateralAmount = 10_000 - 3_000 = 7_000 (= diamondAfter 5_000 + topUp 2_000).
        assertEq(a.collateralAmount, 7_000, "A collateral residual");

        // Snapshot scaled on the DIAMOND base: factor = 5_000/8_000.
        // lenderCollateral 6_800 * 5000/8000 = 4_250.
        (
            uint256 lenderCollat,
            ,
            ,
            ,
            ,
            bool active,
        ) = ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN_A);
        assertTrue(active, "snapshot stays active");
        assertEq(lenderCollat, 4_250, "lenderCollateral scaled on Diamond base 5000/8000");

        // Top-up lien UNTOUCHED.
        (uint256 lienAfter, bool released) =
            TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(LOAN_A);
        assertEq(lienAfter, 2_000, "top-up lien intact");
        assertFalse(released, "top-up lien not released");
    }

    // ─────────────────── 3. topped-up ZERO-residual ─────────────────

    /// @notice §5.3 — the Diamond portion is EXACTLY consumed by the
    ///         match: the loan settles (InternalMatched) and only the
    ///         top-up remains, returned to the borrower holder.
    function test_toppedUp_zeroDiamondResidual_topUpAloneReturned() public {
        // A: 600 principal X, collateral = 600 Diamond + 200 vault.
        //    Snapshot: lender 580 / treasury 20 / borrower 0 (= 600).
        // B: 600 Y debt, 600 X collateral.
        // Leg Y consumes A's Diamond collateral fully: movedY =
        //   min(B.principal 600, _diamondMatchable(A)=600) = 600 → diamondAfter 0.
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 600, mockCollateralERC20, 600, 200, 580, 20);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600, mockERC20, 600);
        _mockLtv(LOAN_B, 9_000);

        vm.prank(matcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);

        LibVaipakam.Loan memory a = _getLoan(LOAN_A);
        assertEq(uint8(a.status), uint8(LibVaipakam.LoanStatus.InternalMatched), "A InternalMatched");
        assertEq(a.principal, 0, "A principal cleared");
        // Residual = diamondAfter(0) + topUp(200) = 200.
        assertEq(a.collateralAmount, 200, "only the top-up remains");

        (, uint256 borrowerClaimAmt, ) =
            ClaimFacet(address(diamond)).getClaimableAmount(LOAN_A, false);
        assertEq(borrowerClaimAmt, 200, "borrowerClaims = top-up only");

        // Lien unchanged (no diamondAfter to add) — still the 200 top-up.
        (uint256 lienAmt, bool released) =
            TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(LOAN_A);
        assertEq(lienAmt, 200, "lien still the top-up");
        assertFalse(released, "lien not released at match");

        // The borrower holder claims the 200 top-up out of their vault.
        address newHolder = makeAddr("newHolder3");
        _mockBorrowerNftHolder(LOAN_A, newHolder);
        uint256 holderYBefore = IERC20(mockCollateralERC20).balanceOf(newHolder);
        vm.prank(newHolder);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN_A);
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(newHolder) - holderYBefore,
            200,
            "holder receives the top-up"
        );
    }

    // ─────────────── 4. transferred borrower position ───────────────

    /// @notice §5.4 — the top-up always pays the CURRENT borrower-position
    ///         NFT holder, never a stale `loan.borrower`. The stored
    ///         borrower (transferred away) is blocked from withdrawing the
    ///         liened residual.
    function test_toppedUp_fullMatch_transferredPositionPaysNewHolder() public {
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 600, mockCollateralERC20, 800, 200, 760, 20);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600, mockERC20, 600);
        _mockLtv(LOAN_B, 9_000);

        vm.prank(matcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);

        // Stored `loan.borrower` (position transferred away) cannot drain the
        // liened residual.
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactoryFacet.WithdrawWouldUnderflowLien.selector,
                borrower, mockCollateralERC20, uint256(0), uint256(1), uint256(0)
            )
        );
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(borrower, mockCollateralERC20, borrower, 1);

        // Current holder claims the full residual.
        address newHolder = makeAddr("newHolder4");
        _mockBorrowerNftHolder(LOAN_A, newHolder);
        uint256 holderYBefore = IERC20(mockCollateralERC20).balanceOf(newHolder);
        vm.prank(newHolder);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN_A);
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(newHolder) - holderYBefore,
            400,
            "new holder receives the residual, not the stale borrower"
        );
    }

    // ─────────────────── 5. custody invariant ───────────────────────

    /// @notice §5.5 — the Diamond's same-token balance never under-runs
    ///         while a topped-up match settles alongside ANOTHER fallback
    ///         loan holding the same collateral asset. The match must draw
    ///         only the matched loan's Diamond portion, leaving the
    ///         unrelated loan's custody untouched.
    function test_toppedUp_match_doesNotUnderrunOtherFallbackCustody() public {
        // Unrelated fallback loan D parks 5_000 Y in Diamond custody.
        _seedLoan(LOAN_D, lenderD, borrowerD, mockERC20, 5_000, mockCollateralERC20, 5_000);
        _moveToFallbackPending(LOAN_D, borrowerD, mockCollateralERC20, 5_000, 4_800, 100);

        // Topped-up A: 800 Diamond + 200 vault of the SAME asset (Y).
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 600, mockCollateralERC20, 800, 200, 760, 20);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600, mockERC20, 600);
        _mockLtv(LOAN_B, 9_000);

        uint256 diamondYBefore = IERC20(mockCollateralERC20).balanceOf(address(diamond));
        // Diamond holds D's 5_000 + A's snapshot 800 = 5_800 Y.
        assertEq(diamondYBefore, 5_800, "Diamond holds D + A snapshot Y");

        vm.prank(matcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);

        // A's entire 800 snapshot exits the Diamond (600 matched to B's lender
        // + 200 residual pushed to A's borrower vault). D's 5_000 is untouched.
        uint256 diamondYAfter = IERC20(mockCollateralERC20).balanceOf(address(diamond));
        assertEq(diamondYAfter, 5_800 - 800, "Diamond released only A's own 800 snapshot");
        // Still covers D's full custody — never under-ran.
        assertGe(diamondYAfter, 5_000, "Diamond still holds D's full 5_000 custody");
    }

    // ──────────── direct-trigger eligibility (former exclusion) ──────

    /// @notice §5.6 / #591 — the direct trigger no longer reverts
    ///         `InternalMatchFallbackTopUpUnsupported` for a topped-up
    ///         FallbackPending leg; it matches successfully.
    function test_toppedUp_directTrigger_matchesInsteadOfReverting() public {
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 600, mockCollateralERC20, 800, 200, 760, 20);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600, mockERC20, 600);
        _mockLtv(LOAN_B, 9_000);

        vm.prank(matcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);

        assertEq(
            uint8(_getLoan(LOAN_A).status),
            uint8(LibVaipakam.LoanStatus.InternalMatched),
            "topped-up leg now matches instead of reverting"
        );
    }

    /// @notice §5.6 / #591 — a topped-up FallbackPending candidate is now
    ///         SURFACED by `hasInternalMatchCandidate` (no longer filtered).
    function test_toppedUp_candidate_surfacedByScan() public {
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1_000, mockCollateralERC20, 1_000);
        _mockLtv(LOAN_A, 9_000);
        // Topped-up opposing FallbackPending candidate B.
        _seedToppedUpFallback(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600, mockERC20, 800, 200, 760, 20);

        (bool found, uint256 cid) =
            MetricsFacet(address(diamond)).hasInternalMatchCandidate(LOAN_A);
        assertTrue(found, "topped-up FallbackPending candidate is now surfaced");
        assertEq(cid, LOAN_B, "candidate is B");
    }

    // ───── #591 Codex #605 P1 — exhausted Diamond portion is non-matchable ─────

    /// @notice A topped-up FallbackPending leg whose at-fallback Diamond
    ///         snapshot is fully exhausted (snapshotTotal == 0; only the vault
    ///         top-up remains, so `collateralAmount > 0` but the Diamond-
    ///         matchable portion is 0) must be rejected by the direct trigger
    ///         BEFORE any funds move — otherwise it would receive a one-sided
    ///         match draining the counterparty.
    function test_toppedUp_exhaustedDiamond_directTrigger_reverts() public {
        // A: principal 600, snapshotTotal 0 + topUp 500 = 500 collateral, all vault.
        //    _diamondMatchable(A) == 500 − 500 == 0.
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 600, mockCollateralERC20, 0, 500, 0, 0);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600, mockERC20, 600);
        _mockLtv(LOAN_B, 9_000);

        uint256 bCollatBefore = _getLoan(LOAN_B).collateralAmount;

        vm.prank(matcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskMatchLiquidationFacet.InternalMatchNoMatchableCollateral.selector, LOAN_A
            )
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);

        // Counterparty untouched — the revert rolled back before any transfer.
        assertEq(_getLoan(LOAN_B).collateralAmount, bCollatBefore, "counterparty not drained");
    }

    /// @notice An exhausted-Diamond topped-up FallbackPending loan must NOT be
    ///         surfaced as a match candidate (so it can't drain a scanning
    ///         counterparty via auto-dispatch). It is filtered WHILE scanning.
    function test_toppedUp_exhaustedDiamond_notSurfacedByScan() public {
        // B (the scanning loan) is a viable Active leg looking for a partner.
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600, mockERC20, 600);
        _mockLtv(LOAN_B, 9_000);
        // A is the exhausted-Diamond topped-up FallbackPending candidate.
        _seedToppedUpFallback(LOAN_A, lender, borrower, mockERC20, 600, mockCollateralERC20, 0, 500, 0, 0);

        (bool found, uint256 cid) =
            MetricsFacet(address(diamond)).hasInternalMatchCandidate(LOAN_B);
        assertTrue(!found || cid != LOAN_A, "exhausted-Diamond leg must not be a candidate");
    }
}
