// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {CollectionOfferFacet} from "../src/facets/CollectionOfferFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {Vm} from "forge-std/Vm.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibCollateralSet} from "../src/libraries/LibCollateralSet.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

/**
 * @title  CollectionOfferTest
 * @notice NFT collection offers (#3328): one lender offer against a set of
 *         tokens for a stated number of loans, filled one token at a time.
 */
contract CollectionOfferTest is SetupTest {
    MockRentableNFT721 internal nft;
    uint256 internal constant PER = 1000 ether;
    uint256 internal nonceSeq = 1_000_000;

    function setUp() public {
        setupHelper();
        nft = new MockRentableNFT721();
        for (uint256 id = 1; id <= 20; ++id) nft.mint(borrower, id);
        mockOracleLiquidity(address(nft), LibVaipakam.LiquidityStatus.Illiquid);
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.startPrank(borrower);
        nft.setApprovalForAll(address(diamond), true);
        nft.setApprovalForAll(bVault, true);
        vm.stopPrank();
        ERC20Mock(mockERC20).mint(lender, PER * 20);
        vm.prank(lender);
        IERC20(mockERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── Builders ─────────────────────────────────────────────────────────

    function _params() internal view returns (LibVaipakam.CreateOfferParams memory p) {
        p.offerType = LibVaipakam.OfferType.Lender;
        p.lendingAsset = mockERC20;
        p.amount = PER;
        p.interestRateBps = 500;
        p.collateralAsset = address(nft);
        p.durationDays = 30;
        p.assetType = LibVaipakam.AssetType.ERC20;
        p.creatorRiskAndTermsConsent = true;
        p.collateralAssetType = LibVaipakam.AssetType.ERC721;
        p.expiresAt = uint64(block.timestamp + 7 days);
        p.fillMode = LibVaipakam.FillMode.Aon;
    }

    function _set(LibVaipakam.CollateralSetKind kind) internal pure returns (LibCollateralSet.SetInput memory s) {
        s.kind = kind;
    }

    function _create(LibCollateralSet.SetInput memory set, uint16 loans) internal returns (uint256) {
        uint256[] memory none;
        vm.prank(lender);
        return CollectionOfferFacet(address(diamond)).createCollectionOffer(
            _params(), set, loans, none, uint64(block.timestamp + 1 hours)
        );
    }

    function _aged(uint256 offerId) internal {
        LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
    }

    /// @dev The borrower's terms for a fill of `offerId` with `tokenId`: the
    ///      parent's terms with the per-loan amount and the actual token.
    function _terms(uint256 offerId, uint256 tokenId)
        internal
        returns (LibAcceptTerms.AcceptTerms memory t, bytes memory sig)
    {
        t = LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        t.offerKey = CollectionOfferFacet(address(diamond)).fillKey(offerId, tokenId);
        t.amount = PER;
        t.collateralTokenId = tokenId;
        t.nonce = ++nonceSeq;
        sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
    }

    function _fill(uint256 offerId, uint256 tokenId, bytes32[] memory proof) internal returns (uint256 loanId) {
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _terms(offerId, tokenId);
        vm.prank(borrower);
        return CollectionOfferFacet(address(diamond)).fillCollectionOffer(offerId, tokenId, proof, t, sig);
    }

    function _take(uint256 offerId, uint256 tokenId, bytes32[] memory proof)
        internal
        view
        returns (CollectionOfferFacet.TakeFailure)
    {
        return CollectionOfferFacet(address(diamond)).wouldTake(offerId, tokenId, proof, borrower);
    }

    function _noProof() internal pure returns (bytes32[] memory p) {}

    /// @dev A four-id standard tree over 7, 9, 11, 13 (leaves sorted, pairs
    ///      hashed in sorted order).
    function _tree() internal pure returns (bytes32 root, bytes32[4] memory leaves) {
        leaves[0] = LibCollateralSet.leaf(7);
        leaves[1] = LibCollateralSet.leaf(9);
        leaves[2] = LibCollateralSet.leaf(11);
        leaves[3] = LibCollateralSet.leaf(13);
        bytes32 a = Hashes.commutativeKeccak256(leaves[0], leaves[1]);
        bytes32 b = Hashes.commutativeKeccak256(leaves[2], leaves[3]);
        root = Hashes.commutativeKeccak256(a, b);
    }

    function _proofFor9() internal pure returns (bytes32[] memory p) {
        (, bytes32[4] memory leaves) = _tree();
        p = new bytes32[](2);
        p[0] = leaves[0];
        p[1] = Hashes.commutativeKeccak256(leaves[2], leaves[3]);
    }

    function _listed() internal pure returns (LibCollateralSet.SetInput memory s) {
        (bytes32 root, ) = _tree();
        s.kind = LibVaipakam.CollateralSetKind.Listed;
        s.root = root;
        s.listCount = 4;
        s.listHash = keccak256("list");
        s.label = "Background: Gold";
    }

    // ─── Set membership ───────────────────────────────────────────────────

    function test_collectionTakesAnyTokenButExcluded() public {
        LibCollateralSet.SetInput memory s = _set(LibVaipakam.CollateralSetKind.Collection);
        s.exclusions = new uint256[](1);
        s.exclusions[0] = 5;
        uint256 id = _create(s, 3);
        _aged(id);
        assertEq(uint8(_take(id, 4, _noProof())), uint8(CollectionOfferFacet.TakeFailure.None));
        assertEq(uint8(_take(id, 5, _noProof())), uint8(CollectionOfferFacet.TakeFailure.NotInSet), "exclusion wins");
    }

    function test_rangeBoundsAreInclusive() public {
        LibCollateralSet.SetInput memory s = _set(LibVaipakam.CollateralSetKind.Range);
        s.low = 3;
        s.high = 6;
        uint256 id = _create(s, 3);
        _aged(id);
        assertEq(uint8(_take(id, 3, _noProof())), uint8(CollectionOfferFacet.TakeFailure.None), "low");
        assertEq(uint8(_take(id, 6, _noProof())), uint8(CollectionOfferFacet.TakeFailure.None), "high");
        assertEq(uint8(_take(id, 2, _noProof())), uint8(CollectionOfferFacet.TakeFailure.NotInSet));
        assertEq(uint8(_take(id, 7, _noProof())), uint8(CollectionOfferFacet.TakeFailure.NotInSet));
    }

    function test_listedSetChecksTheProof() public {
        uint256 id = _create(_listed(), 2);
        _aged(id);
        assertEq(uint8(_take(id, 9, _proofFor9())), uint8(CollectionOfferFacet.TakeFailure.None), "valid proof");
        assertEq(uint8(_take(id, 8, _proofFor9())), uint8(CollectionOfferFacet.TakeFailure.NotInSet), "wrong id");
        bytes32[] memory bad = _proofFor9();
        bad[1] = keccak256("other root");
        assertEq(uint8(_take(id, 9, bad)), uint8(CollectionOfferFacet.TakeFailure.NotInSet), "other root");
        bytes32[] memory deep = new bytes32[](21);
        vm.expectRevert(abi.encodeWithSelector(LibCollateralSet.CollateralProofTooDeep.selector, 21, 20));
        CollectionOfferFacet(address(diamond)).wouldTake(id, 9, deep, borrower);
    }

    function test_listCountAndHashAreStoredAsGiven() public {
        uint256 id = _create(_listed(), 2);
        (LibVaipakam.CollateralSet memory set, uint256 perLoan, uint16 loans, uint16 filled) =
            CollectionOfferFacet(address(diamond)).getCollectionOffer(id);
        assertEq(set.listCount, 4);
        assertEq(set.listHash, keccak256("list"));
        assertEq(set.label, "Background: Gold");
        assertEq(perLoan, PER);
        assertEq(loans, 2);
        assertEq(filled, 0);
    }

    // ─── Creation ─────────────────────────────────────────────────────────

    function test_creationReservesEveryLoan() public {
        uint256 before = IERC20(mockERC20).balanceOf(lender);
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 3);
        assertEq(before - IERC20(mockERC20).balanceOf(lender), 3 * PER, "every loan pulled");
        LibVaipakam.Offer memory o = OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(o.amount, 3 * PER);
        assertEq(o.amountMax, 3 * PER);
    }

    function test_expiryIsMandatoryAndBounded() public {
        LibVaipakam.CreateOfferParams memory p = _params();
        p.expiresAt = 0;
        uint256[] memory none;
        LibCollateralSet.SetInput memory s = _set(LibVaipakam.CollateralSetKind.Collection);
        vm.prank(lender);
        vm.expectPartialRevert(CollectionOfferFacet.CollectionExpiryOutOfRange.selector);
        CollectionOfferFacet(address(diamond)).createCollectionOffer(p, s, 2, none, uint64(block.timestamp + 1 hours));
        p.expiresAt = uint64(block.timestamp + 31 days);
        vm.prank(lender);
        vm.expectPartialRevert(CollectionOfferFacet.CollectionExpiryOutOfRange.selector);
        CollectionOfferFacet(address(diamond)).createCollectionOffer(p, s, 2, none, uint64(block.timestamp + 1 hours));
    }

    function test_loansAboveTheLimitAreRefused() public {
        uint256[] memory none;
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(CollectionOfferFacet.CollectionLoansOutOfRange.selector, 51, 50));
        CollectionOfferFacet(address(diamond)).createCollectionOffer(
            _params(), _set(LibVaipakam.CollateralSetKind.Collection), 51, none, uint64(block.timestamp + 1 hours)
        );
    }

    function test_positionTokenAsCollateralIsRefused() public {
        LibVaipakam.CreateOfferParams memory p = _params();
        // The position tokens live on the PositionNFT core, not the Diamond
        // (#3205); the refusal names the core.
        p.collateralAsset = VaipakamNFTFacet(address(diamond)).positionNFT();
        assertTrue(p.collateralAsset != address(0));
        uint256[] memory none;
        vm.prank(lender);
        vm.expectRevert(CollectionOfferFacet.CollectionOfferShape.selector);
        CollectionOfferFacet(address(diamond)).createCollectionOffer(
            p, _set(LibVaipakam.CollateralSetKind.Collection), 2, none, uint64(block.timestamp + 1 hours)
        );
    }

    // ─── Fills ────────────────────────────────────────────────────────────

    function test_fillsUpToTheStatedCountEachWithItsOwnToken() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        uint256 loanA = _fill(id, 4, _noProof());
        uint256 loanB = _fill(id, 9, _noProof());
        LibVaipakam.Loan memory a = LoanFacet(address(diamond)).getLoanDetails(loanA);
        LibVaipakam.Loan memory b = LoanFacet(address(diamond)).getLoanDetails(loanB);
        assertEq(a.collateralTokenId, 4);
        assertEq(b.collateralTokenId, 9);
        assertEq(a.principal, PER);
        assertEq(a.lender, lender);
        assertEq(a.borrower, borrower);
        assertEq(nft.ownerOf(4), VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower), "token locked");
        LibVaipakam.Offer memory o = OfferCancelFacet(address(diamond)).getOffer(id);
        assertTrue(o.accepted, "spent offer leaves the book");
        assertEq(uint8(_take(id, 5, _noProof())), uint8(CollectionOfferFacet.TakeFailure.Closed));
    }

    /// #3744 — the loans a collection offer opens belong to whoever holds
    /// the collection offer's token: each slice's token, and so each loan's
    /// lender side, goes to that holder; the creator's vault still funds it.
    function test_transferredParent_holderOwnsEachLoansLenderSide() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        address holder = makeAddr("collectionOfferHolder");
        LibTestPositionNFT.move(address(diamond), OfferCancelFacet(address(diamond)).getOffer(id).positionTokenId, holder);
        uint256 loanA = _fill(id, 4, _noProof());
        uint256 loanB = _fill(id, 9, _noProof());
        LibVaipakam.Loan memory a = LoanFacet(address(diamond)).getLoanDetails(loanA);
        LibVaipakam.Loan memory b = LoanFacet(address(diamond)).getLoanDetails(loanB);
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(a.lenderTokenId), holder, "first loan");
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(b.lenderTokenId), holder, "second loan");
        assertEq(a.lender, lender, "the creator's vault funded it");
    }

    /// #3744 (Codex round 1 on #3805) — a Full-tariff consent the parent's
    /// HOLDER gave carries to each slice, recorded with that holder.
    function test_transferredParent_holdersFullConsentCarriesToTheSlice() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        address holder = makeAddr("collectionOfferHolder");
        LibTestPositionNFT.move(address(diamond), OfferCancelFacet(address(diamond)).getOffer(id).positionTokenId, holder);
        vm.prank(holder);
        ProfileFacet(address(diamond)).setOfferCreatorFullTariff(id, true, type(uint128).max, true);
        vm.recordLogs();
        uint256 loanA = _fill(id, 4, _noProof());
        uint256 slice = LoanFacet(address(diamond)).getLoanDetails(loanA).offerId;
        assertTrue(OfferCancelFacet(address(diamond)).getOffer(slice).creatorFull, "the slice carries the consent");
        bytes32 topic = keccak256("OfferFullTariffConsentBy(uint256,address)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic && logs[i].emitter == address(diamond)) {
                (uint256 o, address by) = _consentLog(logs[i]);
                if (o == slice) {
                    assertEq(by, holder, "recorded with the holder");
                    found = true;
                }
            }
        }
        assertTrue(found, "the slice's consent was recorded");
    }

    function _consentLog(Vm.Log memory l) internal pure returns (uint256 o, address by) {
        o = l.topics.length > 1 ? uint256(l.topics[1]) : abi.decode(l.data, (uint256));
        if (l.topics.length > 2) by = address(uint160(uint256(l.topics[2])));
        else if (l.topics.length > 1) by = abi.decode(l.data, (address));
        else (, by) = abi.decode(l.data, (uint256, address));
    }

    function test_theNextFillAfterTheLastIsRefused() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 1);
        _fill(id, 4, _noProof());
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _terms(id, 5);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollectionOfferFacet.CollectionTakeRefused.selector, id, 5, CollectionOfferFacet.TakeFailure.Closed
            )
        );
        CollectionOfferFacet(address(diamond)).fillCollectionOffer(id, 5, _noProof(), t, sig);
    }

    function test_listedFillWithProof() public {
        uint256 id = _create(_listed(), 2);
        uint256 loanId = _fill(id, 9, _proofFor9());
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).collateralTokenId, 9);
    }

    function test_termsMustNameTheActualToken() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _terms(id, 4);
        vm.prank(borrower);
        vm.expectRevert(); // the terms were signed for token 4, the fill names 5
        CollectionOfferFacet(address(diamond)).fillCollectionOffer(id, 5, _noProof(), t, sig);
    }

    function test_lenderCannotFillOwnOffer() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        _aged(id);
        assertEq(
            uint8(CollectionOfferFacet(address(diamond)).wouldTake(id, 4, _noProof(), lender)),
            uint8(CollectionOfferFacet.TakeFailure.OwnOffer)
        );
    }

    function test_noFillAfterExpiry() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        vm.warp(block.timestamp + 8 days);
        assertEq(uint8(_take(id, 4, _noProof())), uint8(CollectionOfferFacet.TakeFailure.Expired));
    }

    // ─── Reduce and cancel ────────────────────────────────────────────────

    function test_reduceReturnsExactlyTheReleasedLoans() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 4);
        _fill(id, 4, _noProof());
        uint256 before = _vaultFree(lender, mockERC20);
        vm.prank(lender);
        CollectionOfferFacet(address(diamond)).reduceCollectionLoans(id, 1);
        assertEq(_vaultFree(lender, mockERC20) - before, 2 * PER, "two loans released");
        (, , uint16 loans, uint16 filled) = CollectionOfferFacet(address(diamond)).getCollectionOffer(id);
        assertEq(loans, 2);
        assertEq(filled, 1);
        _fill(id, 5, _noProof());
        assertEq(uint8(_take(id, 6, _noProof())), uint8(CollectionOfferFacet.TakeFailure.Closed));
    }

    function test_drawingOnTheReserveMarksTheParentToken() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 4);
        uint256 token = OfferCancelFacet(address(diamond)).getOffer(id).positionTokenId;
        (uint256 n0,,) = VaipakamNFTFacet(address(diamond)).positionState(token);
        _fill(id, 4, _noProof());
        (uint256 n1,,) = VaipakamNFTFacet(address(diamond)).positionState(token);
        assertGt(n1, n0, "a fill moves the parent's state");
        vm.prank(lender);
        CollectionOfferFacet(address(diamond)).reduceCollectionLoans(id, 1);
        (uint256 n2,, uint64 readyAt) = VaipakamNFTFacet(address(diamond)).positionState(token);
        assertGt(n2, n1, "a reduction moves the parent's state");
        assertGt(readyAt, block.timestamp, "the parent token waits");
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).requirePositionState(token, n1);
    }

    function test_reduceMustLeaveALoan() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(CollectionOfferFacet.CollectionReductionInvalid.selector, 2, 0));
        CollectionOfferFacet(address(diamond)).reduceCollectionLoans(id, 0);
    }

    function test_cancelReturnsTheUnusedLoans() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 3);
        _fill(id, 4, _noProof());
        uint256 before = _vaultFree(lender, mockERC20);
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(id);
        assertEq(_vaultFree(lender, mockERC20) - before, 2 * PER, "two unused loans back");
    }

    // ─── The parent fills only through its entry ──────────────────────────

    function test_plainAcceptRefusesTheParent() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(address(diamond), borrower, id, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.CollectionParentNotFillable.selector, id));
        OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig);
        assertEq(
            uint8(OfferPreviewFacet(address(diamond)).previewAccept(id, borrower).errorCode),
            uint8(OfferAcceptFacet.AcceptError.CollectionParent)
        );
    }

    function test_matchRefusesTheParentAndCollectionMatchFillsASlice() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        LibVaipakam.CreateOfferParams memory p = _params();
        p.offerType = LibVaipakam.OfferType.Borrower;
        p.collateralTokenId = 7;
        p.amountMax = p.amount;
        p.interestRateBpsMax = p.interestRateBps;
        p.prepayAsset = mockERC20;
        p.expiresAt = 0;
        vm.prank(borrower);
        uint256 borrowerOffer = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        _aged(id);
        _aged(borrowerOffer);
        assertEq(
            uint8(OfferMatchFacet(address(diamond)).previewMatch(id, borrowerOffer, address(this), address(this)).errorCode),
            uint8(LibOfferMatch.MatchError.CollectionParent)
        );
        uint256 loanId = CollectionOfferFacet(address(diamond)).matchCollectionOffer(id, borrowerOffer, _noProof());
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.collateralTokenId, 7);
        assertEq(l.lender, lender);
        (, , , uint16 filled) = CollectionOfferFacet(address(diamond)).getCollectionOffer(id);
        assertEq(filled, 1);
    }

    function test_parentTermsCannotBeEdited() public {
        uint256 id = _create(_set(LibVaipakam.CollateralSetKind.Collection), 2);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.CollectionParentNotFillable.selector, id));
        OfferMutateFacet(address(diamond)).setOfferRate(id, 600, 600, 0, 0, false, uint64(block.timestamp + 1 hours));
    }
}
