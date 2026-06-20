// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC4907Mock} from "./mocks/ERC4907Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title CollateralConsolidation.t.sol
 * @notice #594 PR-1 — exercises {LibConsolidation} via the standalone
 *         {ConsolidationFacet} entry points: a transferred borrower position is
 *         consolidated into the current NFT-holder's vault (collateral moved +
 *         lien re-keyed + anchor re-pointed), the no-op fast paths, the excluded
 *         states, and the holder/sanctions gates. Eager-path wiring lands in
 *         PR-2/PR-3; here we drive the primitive directly.
 *
 *         Loans are direct-seeded via {TestMutatorFacet} (bypassing the offer /
 *         accept / HF≥1.5 flow) and the position-NFT `ownerOf` is mocked to the
 *         transferred holder, mirroring the `InternalMatchExecution` harness.
 */
contract CollateralConsolidationTest is SetupTest {
    uint256 internal constant LOAN = 7001;

    address internal lenderA;
    address internal borrowerOrig;
    address internal holder;
    ERC20Mock internal collat;
    ERC20Mock internal principal;

    uint256 internal constant COLL_AMT = 1_000e18;

    function setUp() public {
        setupHelper();
        lenderA = makeAddr("lenderA");
        borrowerOrig = makeAddr("borrowerOrig");
        holder = makeAddr("holder");
        collat = new ERC20Mock("Collateral", "COLL", 18);
        principal = new ERC20Mock("Principal", "PRN", 18);
    }

    // ─── scaffold ───────────────────────────────────────────────────────────

    /// @dev Seed an Active ERC-20 loan, fund the original borrower's vault with
    ///      the collateral, mirror the protocol-tracked counter, and create the
    ///      collateral lien + aggregate keyed under the original borrower.
    function _seedBorrowerLoan() internal {
        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lenderA;
        l.borrower = borrowerOrig;
        l.borrowerTokenId = LOAN; // mock ownerOf(LOAN)
        l.lenderTokenId = LOAN + 1;
        l.principalAsset = address(principal);
        l.principal = 500e18;
        l.collateralAsset = address(collat);
        l.collateralAmount = COLL_AMT;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);

        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrowerOrig
        );
        collat.mint(bVault, COLL_AMT);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrowerOrig, address(collat), COLL_AMT
        );
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            LOAN, borrowerOrig, address(collat), 0, COLL_AMT, LibVaipakam.AssetType.ERC20
        );
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrowerOrig, address(collat), 0, COLL_AMT
        );
    }

    /// @dev Mock `ownerOf(borrowerTokenId)` → `who` (the transferred holder).
    function _mockBorrowerHolder(address who) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, LOAN),
            abi.encode(who)
        );
    }

    function _getLoan() internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(LOAN);
    }

    function _enc(address user) internal view returns (uint256) {
        return MetricsFacet(address(diamond)).getEncumbered(user, address(collat), 0);
    }

    function _tracked(address user) internal view returns (uint256) {
        return VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(
            user, address(collat)
        );
    }

    // ─── tests ──────────────────────────────────────────────────────────────

    /// Test 1 — borrower NFT transferred, then standalone consolidation:
    /// collateral physically moves to the holder's vault, lien aggregate
    /// conserved (old → 0, new → amount), `loan.borrower == holder`.
    function test_StandaloneBorrower_MovesCollateralAndReanchors() public {
        _seedBorrowerLoan();
        _mockBorrowerHolder(holder);

        vm.prank(holder);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);

        assertEq(_getLoan().borrower, holder, "anchor re-pointed to holder");

        address hVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(holder);
        assertEq(collat.balanceOf(hVault), COLL_AMT, "collateral physically in holder vault");
        assertEq(_tracked(holder), COLL_AMT, "tracked balance moved to holder");
        assertEq(_tracked(borrowerOrig), 0, "tracked balance left original vault");

        // Lien aggregate conserved.
        assertEq(_enc(borrowerOrig), 0, "old encumbered zeroed");
        assertEq(_enc(holder), COLL_AMT, "new encumbered == amount");
    }

    /// Test 3 — no-op fast path: a non-transferred loan (holder == stored)
    /// consolidates to a no-op (no asset move, no revert).
    function test_NoOpFastPath_NotTransferred() public {
        _seedBorrowerLoan();
        _mockBorrowerHolder(borrowerOrig); // current == stored

        vm.prank(borrowerOrig);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);

        // Nothing moved.
        assertEq(_getLoan().borrower, borrowerOrig, "anchor unchanged");
        assertEq(_tracked(borrowerOrig), COLL_AMT, "collateral stays put");
        assertEq(_enc(borrowerOrig), COLL_AMT, "lien stays put");
    }

    /// Test 6 — FallbackPending is excluded entirely → ConsolidationNotAllowed.
    function test_FallbackPending_Reverts() public {
        _seedBorrowerLoan();
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            LOAN, LibVaipakam.LoanStatus.Active, LibVaipakam.LoanStatus.FallbackPending
        );
        _mockBorrowerHolder(holder);

        vm.prank(holder);
        vm.expectRevert(IVaipakamErrors.ConsolidationNotAllowed.selector);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);
    }

    /// Test (auth) — a non-holder caller reverts NotNFTOwner.
    function test_NonHolderCaller_Reverts() public {
        _seedBorrowerLoan();
        _mockBorrowerHolder(holder);

        vm.prank(makeAddr("randomCaller"));
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);
    }

    /// Test 10 — double consolidation is idempotent (second call is a no-op).
    function test_DoubleConsolidation_Idempotent() public {
        _seedBorrowerLoan();
        _mockBorrowerHolder(holder);

        vm.prank(holder);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);
        // After the first, the anchor is the holder; ownerOf is still the holder,
        // so the second call hits the AlreadyConsolidated no-op (no revert).
        vm.prank(holder);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);

        assertEq(_getLoan().borrower, holder, "still anchored to holder");
        assertEq(_enc(holder), COLL_AMT, "lien unchanged on second call");
    }

    /// Test 9 — ERC-721 collateral moves via the Diamond-mediated two-leg move
    /// (arming the ReceiverFacet pin): the NFT ends up in the holder's vault,
    /// the lien re-keys, the anchor re-points, and (iWB) no ERC-20
    /// `protocolTrackedVaultBalance` is touched.
    function test_ERC721Collateral_TwoLegMoveViaReceiver() public {
        ERC4907Mock nft = new ERC4907Mock("NFT", "NFT");
        uint256 tokenId = 42;

        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lenderA;
        l.borrower = borrowerOrig;
        l.borrowerTokenId = LOAN;
        l.lenderTokenId = LOAN + 1;
        l.principalAsset = address(principal);
        l.principal = 500e18;
        l.collateralAsset = address(nft);
        l.collateralTokenId = tokenId;
        l.collateralAssetType = LibVaipakam.AssetType.ERC721;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);

        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrowerOrig
        );
        nft.mint(bVault, tokenId);
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            LOAN, borrowerOrig, address(nft), tokenId, 1, LibVaipakam.AssetType.ERC721
        );
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrowerOrig, address(nft), tokenId, 1
        );

        _mockBorrowerHolder(holder);
        address hVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(holder);

        vm.prank(holder);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);

        // NFT physically ended up in the holder's vault (two-leg move worked).
        assertEq(nft.ownerOf(tokenId), hVault, "NFT moved to holder vault");
        assertEq(_getLoan().borrower, holder, "anchor re-pointed");
        // Lien re-keyed (keyed by tokenId for NFTs).
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(borrowerOrig, address(nft), tokenId),
            0, "old NFT lien zeroed"
        );
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(holder, address(nft), tokenId),
            1, "new NFT lien == 1"
        );
        // The pin was consumed — the Diamond is no longer armed to accept NFTs.
        // (A follow-up call with the flag cleared would revert UnexpectedNFTReceipt.)
    }

    /// Test 8 — a sanctioned current holder reverts on the Tier-1 standalone
    /// path (SanctionedAddress), before any move.
    function test_SanctionedHolder_Reverts() public {
        _seedBorrowerLoan();
        _mockBorrowerHolder(holder);

        MockSanctionsList oracle = new MockSanctionsList();
        oracle.setFlagged(holder, true);
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));

        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, holder)
        );
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);
    }

    /// Test 16 — a live borrower-side prepay listing excludes BORROWER
    /// consolidation (side-scoped, D-3 principle 1) → ConsolidationNotAllowed.
    function test_PrepayListing_BorrowerExcluded() public {
        _seedBorrowerLoan();
        TestMutatorFacet(address(diamond)).setPrepayListingOrderHash(
            LOAN, keccak256("live-listing")
        );
        _mockBorrowerHolder(holder);

        vm.prank(holder);
        vm.expectRevert(IVaipakamErrors.ConsolidationNotAllowed.selector);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);
    }

    /// Test 23 — lender side, no `lenderProceedsEncumbered` reservation (the
    /// common active-transfer case): consolidation succeeds as anchor-only (no
    /// collateral move, no assert on the absent lien).
    function test_LenderSide_AnchorOnly_NoReservation() public {
        _seedBorrowerLoan();
        // Transfer the LENDER position NFT (lenderTokenId == LOAN + 1).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, LOAN + 1),
            abi.encode(holder)
        );

        vm.prank(holder);
        ConsolidationFacet(address(diamond)).consolidatePrincipalToHolder(LOAN);

        assertEq(_getLoan().lender, holder, "lender anchor re-pointed");
        // Borrower side untouched; collateral stays in the original vault.
        assertEq(_getLoan().borrower, borrowerOrig, "borrower anchor unchanged");
        assertEq(_tracked(borrowerOrig), COLL_AMT, "collateral untouched on lender consolidation");
    }

    /// #655 Msj — an NFT-rental loan (assetType != ERC20) is excluded entirely
    /// (out of #594 scope) → ConsolidationNotAllowed, no asset moved.
    function test_NftRental_Excluded() public {
        _seedBorrowerLoan();
        // Flip the loan into a rental: the LENT asset is an NFT.
        LibVaipakam.Loan memory l = _getLoan();
        l.assetType = LibVaipakam.AssetType.ERC721;
        TestMutatorFacet(address(diamond)).setLoan(LOAN, l);
        _mockBorrowerHolder(holder);

        vm.prank(holder);
        vm.expectRevert(IVaipakamErrors.ConsolidationNotAllowed.selector);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);
        assertEq(_tracked(borrowerOrig), COLL_AMT, "collateral untouched on excluded rental");
    }

    /// #655 Msm — a VPFI heldForLender amount with no reservation excludes the
    /// LENDER side (the #597-gated drain case) → ConsolidationNotAllowed.
    function test_VpfiHeldForLender_LenderExcluded() public {
        _seedBorrowerLoan();
        // Point principalAsset at the configured VPFI token + park an unreserved
        // heldForLender so the exclusion's VPFI check fires.
        LibVaipakam.Loan memory l = _getLoan();
        l.principalAsset = TestMutatorFacet(address(diamond)).vpfiTokenRaw();
        TestMutatorFacet(address(diamond)).setLoan(LOAN, l);
        TestMutatorFacet(address(diamond)).setHeldForLenderRaw(LOAN, 100e18);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, LOAN + 1),
            abi.encode(holder)
        );
        vm.prank(holder);
        vm.expectRevert(IVaipakamErrors.ConsolidationNotAllowed.selector);
        ConsolidationFacet(address(diamond)).consolidatePrincipalToHolder(LOAN);
    }

    /// #655 Msl — re-anchoring to a holder ALREADY indexed for the loan must not
    /// duplicate the userLoanIds entry.
    function test_AppendIndex_NoDuplicate() public {
        _seedBorrowerLoan();
        _mockBorrowerHolder(holder);
        // Pre-index the loan for the holder (simulate a prior indexing).
        TestMutatorFacet(address(diamond)).pushUserLoanIdRaw(holder, LOAN);

        vm.prank(holder);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);

        // Exactly one entry for the holder (dup-protected).
        assertEq(
            MetricsFacet(address(diamond)).getUserLoanCount(holder), 1,
            "no duplicate loan index"
        );
    }

    /// Test 17 — terminal loan with the (mock-burned) NFT takes the no-op path
    /// (status-gated before ownerOf), does NOT revert.
    function test_Terminal_NoOp() public {
        _seedBorrowerLoan();
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            LOAN, LibVaipakam.LoanStatus.Active, LibVaipakam.LoanStatus.Settled
        );
        // No ownerOf mock — a terminal loan must not resolve the holder.
        vm.prank(holder);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);
        // Benign no-op: nothing moved, no revert.
        assertEq(_getLoan().borrower, borrowerOrig, "anchor unchanged on terminal");
    }
}
