// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {LibEncumbrance} from "../src/libraries/LibEncumbrance.sol";
import {LibTierExclusion} from "../src/libraries/LibTierExclusion.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  TierExclusionTest
 * @notice #2342 — VPFI owed to someone else leaves the vault owner's fee
 *         tier on EVERY close-out, not only the swap-to-repay-FULL family.
 *
 *         The rule under test (`LibTierExclusion`): once a loan is terminal,
 *         the VPFI in a side's per-loan encumbrance records is excluded from
 *         the stored party's tier whenever that side's position NFT is held by
 *         someone else. It is re-derived at the terminal transition, on every
 *         position transfer or burn, and on every change to those records.
 *
 *         The scenarios drive the real `RepayFacet.repayLoan` close-out — one
 *         of the paths that had no exclusion before — and the real
 *         `claimAsBorrower` / `transferFrom` entry points, so each assertion
 *         is about the wired behaviour rather than the library in isolation.
 */
contract TierExclusionTest is SetupTest {
    ERC20Mock internal principalAsset;
    ERC20Mock internal collateralAsset;

    address internal borrowerEoa = address(0xB0B);
    address internal lenderEoa = address(0x1ED4E2);
    address internal borrowerVault;
    address internal lenderVault;

    uint256 internal constant LOAN_ID = 1;
    uint256 internal constant LENDER_TOKEN = 1;
    uint256 internal constant BORROWER_TOKEN = 2;
    uint256 internal constant LOAN_PRINCIPAL = 1_000 ether;
    uint256 internal constant LOAN_COLLATERAL = 2_000 ether;
    /// @dev VPFI the stored borrower owns outright, on top of the collateral.
    ///      Larger than the collateral so an erroneous exclusion shows up as
    ///      a non-zero wrong balance rather than a floor at zero.
    uint256 internal constant OWN_VPFI = 5_000 ether;

    function setUp() public {
        setupHelper();
        vm.warp(100 days);

        principalAsset = new ERC20Mock("Principal", "PRIN", 18);
        collateralAsset = new ERC20Mock("Collateral", "COLL", 18);

        borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerEoa);
        lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lenderEoa);

        _mockAssetPrice(address(principalAsset));
        _mockAssetPrice(address(collateralAsset));
    }

    // ── Helpers ───────────────────────────────────────────────────────

    function _mockAssetPrice(address asset) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(uint256(1e8), uint8(8))
        );
    }

    /// @dev Stamp an Active ERC-20 loan, mint both position NFTs to the
    ///      original parties with the loan id recorded on each token (as
    ///      `mintNFT` does in production), seed the borrower's vault with the
    ///      collateral plus `ownVpfi` of the collateral token, and write the
    ///      collateral lien loan initiation would have written.
    function _scaffold(uint256 ownVpfi) internal {
        TestMutatorFacet(address(diamond)).mintNFTRaw(lenderEoa, LENDER_TOKEN);
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrowerEoa, BORROWER_TOKEN);
        vm.startPrank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(
            LENDER_TOKEN, LOAN_ID, LibVaipakam.LoanPositionStatus.LoanInitiated
        );
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(
            BORROWER_TOKEN, LOAN_ID, LibVaipakam.LoanPositionStatus.LoanInitiated
        );
        vm.stopPrank();

        LibVaipakam.Loan memory loan;
        loan.id = LOAN_ID;
        loan.principal = LOAN_PRINCIPAL;
        loan.principalAsset = address(principalAsset);
        loan.collateralAmount = LOAN_COLLATERAL;
        loan.collateralAsset = address(collateralAsset);
        loan.lender = lenderEoa;
        loan.borrower = borrowerEoa;
        loan.startTime = uint64(block.timestamp - 1 days);
        loan.durationDays = 30;
        loan.interestRateBps = 500;
        loan.lenderTokenId = uint128(LENDER_TOKEN);
        loan.borrowerTokenId = uint128(BORROWER_TOKEN);
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.assetType = LibVaipakam.AssetType.ERC20;
        loan.collateralAssetType = LibVaipakam.AssetType.ERC20;
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        loan.initLtvCapBpsAtInit = 8000;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);

        uint256 vaulted = LOAN_COLLATERAL + ownVpfi;
        collateralAsset.mint(borrowerVault, vaulted);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrowerEoa, address(collateralAsset), vaulted
        );
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            LOAN_ID, borrowerEoa, address(collateralAsset), 0, LOAN_COLLATERAL,
            LibVaipakam.AssetType.ERC20
        );
    }

    /// @dev Hand a position to `to` without going through the hooked public
    ///      transfer (the loan is still live, where the hook is a no-op
    ///      anyway), then flag `to` on a freshly wired sanctions oracle.
    function _moveThenFlag(uint256 tokenId, address to)
        internal
        returns (MockSanctionsList sanctions)
    {
        TestMutatorFacet(address(diamond)).burnNFTRaw(tokenId);
        TestMutatorFacet(address(diamond)).mintNFTRaw(to, tokenId);
        sanctions = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(sanctions));
        sanctions.setFlagged(to, true);
    }

    function _repayAsStoredBorrower() internal {
        _fundStoredBorrowerRepay();
        vm.prank(borrowerEoa);
        RepayFacet(address(diamond)).repayLoan(LOAN_ID);
    }

    /// @dev Split out so a test can arm `vm.expectEmit` between the funding
    ///      calls and the repay itself (an expectation binds to the NEXT call).
    function _fundStoredBorrowerRepay() internal {
        principalAsset.mint(borrowerEoa, 10_000 ether);
        vm.prank(borrowerEoa);
        IERC20(address(principalAsset)).approve(address(diamond), type(uint256).max);
    }

    function _exclusion()
        internal
        view
        returns (address lenderVault_, uint256 lenderVpfi, address borrowerVault_, uint256 borrowerVpfi)
    {
        return EncumbranceMutateFacet(address(diamond)).getTierExclusion(LOAN_ID);
    }

    function _owedToOthers(address who) internal view returns (uint256) {
        return EncumbranceMutateFacet(address(diamond)).getVpfiOwedToOthers(who);
    }

    function _tierBalance(address who) internal view returns (uint256 bal) {
        (, bal, ) = VPFIDiscountFacet(address(diamond)).getTrackedVPFIDiscountTier(who);
    }

    function _dayMinAndClose(address who) internal view returns (uint256 dayMin, uint256 dayClose) {
        (, , uint120 close, uint120 min_) =
            TestMutatorFacet(address(diamond)).getStakeRollupStateRaw(who);
        return (min_, close);
    }

    /// @dev Borrower side, sanctioned transferee: the repay close-out skips
    ///      consolidation, so the whole VPFI collateral stays liened in the
    ///      stored borrower's vault while it is owed to the holder.
    function _repayWithFlaggedBorrowerHolder(address holder)
        internal
        returns (MockSanctionsList sanctions)
    {
        TestMutatorFacet(address(diamond)).setVpfiTokenRaw(address(collateralAsset));
        _scaffold(OWN_VPFI);
        sanctions = _moveThenFlag(BORROWER_TOKEN, holder);
        _repayAsStoredBorrower();
    }

    // ── The gap #2342 closes: repay left owed VPFI in the stored tier ──

    /// @notice Repay — a close-out with no exclusion before #2342 — now keeps
    ///         the VPFI collateral owed to the sanctioned holder out of the
    ///         stored borrower's tier, and the stamp reflects it immediately.
    function test_repay_VpfiCollateralOwedToFlaggedHolder_LeavesStoredBorrowerTier() public {
        TestMutatorFacet(address(diamond)).setVpfiTokenRaw(address(collateralAsset));
        _scaffold(OWN_VPFI);
        _moveThenFlag(BORROWER_TOKEN, makeAddr("flaggedBorrowerHolder"));
        // The change is stated on-chain, not only applied.
        _fundStoredBorrowerRepay();
        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibTierExclusion.TierExclusionUpdated(LOAN_ID, false, borrowerEoa, LOAN_COLLATERAL);
        vm.prank(borrowerEoa);
        RepayFacet(address(diamond)).repayLoan(LOAN_ID);

        assertEq(
            uint256(LoanFacet(address(diamond)).getLoanDetails(LOAN_ID).status),
            uint256(LibVaipakam.LoanStatus.Repaid),
            "fixture: the repay close-out completed"
        );
        (address lv, uint256 lVpfi, address bv, uint256 bVpfi) = _exclusion();
        assertEq(bv, borrowerEoa, "borrower side charged to the stored borrower");
        assertEq(bVpfi, LOAN_COLLATERAL, "the whole liened VPFI collateral is owed to the holder");
        assertEq(lv, address(0), "lender side is self-held: no exclusion");
        assertEq(lVpfi, 0, "lender side is self-held: no amount");
        assertEq(_owedToOthers(borrowerEoa), LOAN_COLLATERAL, "aggregate equals the loan's record");

        assertEq(
            _tierBalance(borrowerEoa),
            OWN_VPFI,
            "the stored borrower's tier counts only the VPFI they own"
        );
        (, uint256 dayClose) = _dayMinAndClose(borrowerEoa);
        assertEq(dayClose, OWN_VPFI, "the tier stamp was refreshed at the terminal transition");
    }

    /// @notice Lender side: VPFI proceeds owed to a sanctioned lender-position
    ///         holder leave the stored lender's tier on a plain repay.
    function test_repay_VpfiProceedsOwedToFlaggedLenderHolder_LeavesStoredLenderTier() public {
        TestMutatorFacet(address(diamond)).setVpfiTokenRaw(address(principalAsset));
        _scaffold(0);
        _moveThenFlag(LENDER_TOKEN, makeAddr("flaggedLenderHolder"));
        _repayAsStoredBorrower();

        uint256 reserved =
            TestMutatorFacet(address(diamond)).getEncumberedRaw(lenderEoa, address(principalAsset), 0);
        assertGt(reserved, 0, "fixture: the repay reserved VPFI proceeds in the stored lender's vault");

        (address lv, uint256 lVpfi, address bv, ) = _exclusion();
        assertEq(lv, lenderEoa, "lender side charged to the stored lender");
        assertEq(lVpfi, reserved, "the reserved VPFI proceeds are excluded");
        assertEq(bv, address(0), "borrower side is self-held: no exclusion");
        assertEq(_owedToOthers(lenderEoa), reserved, "aggregate equals the loan's record");
        assertEq(_tierBalance(lenderEoa), 0, "none of the proceeds count toward the stored lender's tier");
    }

    // ── Claim: released before the payout, so the tier never dips ──────

    /// @notice When the delisted holder claims, the exclusion is dropped
    ///         BEFORE the VPFI leaves the stored borrower's vault. Dropping it
    ///         after would stamp a balance lowered by the payout while still
    ///         lowered by the exclusion — a dip the minimum-over-history clamp
    ///         would hold against the stored borrower for up to 30 days.
    function test_claim_ReleasesExclusionBeforePayout_NoTierDip() public {
        address holder = makeAddr("claimingHolder");
        MockSanctionsList sanctions = _repayWithFlaggedBorrowerHolder(holder);

        // A new day, so the claim's stamps open a fresh day slot and its
        // minimum records only what the claim itself did.
        vm.warp(block.timestamp + 1 days);
        sanctions.setFlagged(holder, false);
        vm.prank(holder);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN_ID);

        assertEq(collateralAsset.balanceOf(holder), LOAN_COLLATERAL, "fixture: the holder was paid");
        (, , address bv, uint256 bVpfi) = _exclusion();
        assertEq(bv, address(0), "claimed and burned: nothing left charged");
        assertEq(bVpfi, 0, "claimed and burned: no amount left");
        assertEq(_owedToOthers(borrowerEoa), 0, "aggregate back to zero");

        (uint256 dayMin, uint256 dayClose) = _dayMinAndClose(borrowerEoa);
        assertEq(dayClose, OWN_VPFI, "the stored borrower ends on the VPFI they own");
        assertEq(dayMin, OWN_VPFI, "no transient dip below it during the claim");
    }

    // ── Position transfers after the loan closed ──────────────────────

    /// @notice A claim sold after the loan closed moves the owed VPFI out of
    ///         the seller's tier — no sanctions involved — and selling it back
    ///         returns it. A self-held repay starts with no exclusion.
    function test_postTerminalTransfer_MovesExclusion_AndBack() public {
        TestMutatorFacet(address(diamond)).setVpfiTokenRaw(address(collateralAsset));
        _scaffold(OWN_VPFI);
        _repayAsStoredBorrower();

        (, , address bv, ) = _exclusion();
        assertEq(bv, address(0), "self-held at close: the VPFI is the stored borrower's own claim");
        assertEq(_tierBalance(borrowerEoa), OWN_VPFI + LOAN_COLLATERAL, "self-held: all of it counts");

        address buyer = makeAddr("claimBuyer");
        vm.prank(borrowerEoa);
        VaipakamNFTFacet(address(diamond)).transferFrom(borrowerEoa, buyer, BORROWER_TOKEN);

        uint256 bVpfi;
        (, , bv, bVpfi) = _exclusion();
        assertEq(bv, borrowerEoa, "sold claim: charged to the seller, whose vault holds it");
        assertEq(bVpfi, LOAN_COLLATERAL, "sold claim: the liened collateral is the buyer's");
        assertEq(_tierBalance(borrowerEoa), OWN_VPFI, "the seller keeps credit only on their own VPFI");

        vm.prank(buyer);
        VaipakamNFTFacet(address(diamond)).transferFrom(buyer, borrowerEoa, BORROWER_TOKEN);
        (, , bv, bVpfi) = _exclusion();
        assertEq(bv, address(0), "bought back: nothing owed to anyone else");
        assertEq(_owedToOthers(borrowerEoa), 0, "bought back: aggregate back to zero");
        assertEq(_tierBalance(borrowerEoa), OWN_VPFI + LOAN_COLLATERAL, "bought back: all of it counts again");
    }

    /// @notice Scope (#2342 option C): a LIVE loan's transferred position is
    ///         untouched — the stored party keeps credit until consolidation.
    function test_liveLoanTransfer_NoExclusion() public {
        TestMutatorFacet(address(diamond)).setVpfiTokenRaw(address(collateralAsset));
        _scaffold(OWN_VPFI);

        vm.prank(borrowerEoa);
        VaipakamNFTFacet(address(diamond)).transferFrom(borrowerEoa, makeAddr("liveBuyer"), BORROWER_TOKEN);

        (, , address bv, uint256 bVpfi) = _exclusion();
        assertEq(bv, address(0), "live loan: no exclusion");
        assertEq(bVpfi, 0, "live loan: no amount");
        assertEq(_owedToOthers(borrowerEoa), 0, "live loan: aggregate untouched");
    }

    /// @notice A position burned while its side still carries a charge ends
    ///         with no record at all: nobody holds it, so nothing on it can
    ///         stay excluded. The burn backstop releases the lien; the burn's
    ///         own sync then clears the (now zero) charge.
    function test_positionBurn_ClearsTheRecord() public {
        _repayWithFlaggedBorrowerHolder(makeAddr("burnedHolder"));
        (, , address bv, ) = _exclusion();
        assertEq(bv, borrowerEoa, "fixture: the borrower side carries a charge");

        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).burnNFT(BORROWER_TOKEN);

        uint256 bVpfi;
        (, , bv, bVpfi) = _exclusion();
        assertEq(bv, address(0), "burned: no vault charged");
        assertEq(bVpfi, 0, "burned: no amount");
        assertEq(_owedToOthers(borrowerEoa), 0, "burned: aggregate back to zero");
    }

    // ── Upgrade: pre-#2342 swap-freeze records are folded, not doubled ─

    /// @notice A loan frozen by the old swap-to-repay code carries a legacy
    ///         per-loan record already added to the aggregate. The first sync
    ///         folds it into the ledger-derived record, so the aggregate ends
    ///         at the ledger amount — not the ledger amount plus the legacy one.
    function test_legacyFreezeRecord_FoldedNotDoubleCounted() public {
        TestMutatorFacet(address(diamond)).setVpfiTokenRaw(address(collateralAsset));
        _scaffold(OWN_VPFI);
        _repayAsStoredBorrower();

        uint256 legacy = 700 ether;
        TestMutatorFacet(address(diamond)).setLegacyFrozenVpfiRaw(LOAN_ID, false, borrowerEoa, legacy);
        assertEq(_owedToOthers(borrowerEoa), legacy, "fixture: the legacy bump is in the aggregate");

        vm.prank(borrowerEoa);
        VaipakamNFTFacet(address(diamond)).transferFrom(borrowerEoa, makeAddr("legacyBuyer"), BORROWER_TOKEN);

        assertEq(
            _owedToOthers(borrowerEoa),
            LOAN_COLLATERAL,
            "the legacy amount was folded in, not added on top"
        );
    }

    // ── Wiring ────────────────────────────────────────────────────────

    /// @notice The ledger notify spells the host selector from its signature
    ///         (the host imports the library); pin it to the compiled one.
    function test_syncSelectorConstant_MatchesHost() public pure {
        assertEq(
            LibEncumbrance.TIER_EXCLUSION_SYNC_SELECTOR,
            EncumbranceMutateFacet.syncTierExclusion.selector,
            "notify selector must route to the host"
        );
    }

    function test_syncTierExclusion_RevertsForExternalCaller() public {
        vm.expectRevert(EncumbranceMutateFacet.OnlyDiamondInternal.selector);
        EncumbranceMutateFacet(address(diamond)).syncTierExclusion(LOAN_ID);
    }
}
