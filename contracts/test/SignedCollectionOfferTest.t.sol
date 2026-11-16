// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {CollectionOfferFacet} from "../src/facets/CollectionOfferFacet.sol";
import {SignedOfferFacet} from "../src/facets/SignedOfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSignedOffer} from "../src/libraries/LibSignedOffer.sol";
import {LibCollateralSet} from "../src/libraries/LibCollateralSet.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

/**
 * @title  SignedCollectionOfferTest
 * @notice The signed form of an NFT collection offer (#3328, design section
 *         6): a lender signs one order against a set of tokens for a number
 *         of loans; each borrower fill draws one loan from the lender's free
 *         vault balance. Nothing is reserved at signing.
 */
contract SignedCollectionOfferTest is SetupTest {
    MockRentableNFT721 internal nft;
    uint256 internal constant PER = 1000 ether;
    uint256 internal nonceSeq = 2_000_000;

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
    }

    // ─── Builders ─────────────────────────────────────────────────────────

    /// @dev A signed Range collection offer over tokens 1..10 for `loans`
    ///      loans, signed now.
    function _order(uint16 loans) internal view returns (LibSignedOffer.SignedOffer memory o) {
        o.offerType = uint8(LibVaipakam.OfferType.Lender);
        o.lendingAsset = mockERC20;
        o.amount = PER;
        o.interestRateBps = 500;
        o.collateralAsset = address(nft);
        o.durationDays = 30;
        o.assetType = uint8(LibVaipakam.AssetType.ERC20);
        o.collateralAssetType = uint8(LibVaipakam.AssetType.ERC721);
        o.expiresAt = uint64(block.timestamp + 7 days);
        o.fillMode = uint8(LibVaipakam.FillMode.Aon);
        o.maxTreasuryFeeBps = type(uint16).max;
        o.maxLoanInitiationFeeBps = type(uint16).max;
        o.signer = lender;
        o.nonce = 1;
        o.deadline = block.timestamp + 7 days;
        o.setKind = uint8(LibVaipakam.CollateralSetKind.Range);
        o.setLow = 1;
        o.setHigh = 10;
        o.loans = loans;
        o.startTime = uint64(block.timestamp);
    }

    function _sign(LibSignedOffer.SignedOffer memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lenderPk, SignedOfferFacet(address(diamond)).hashSignedOffer(o));
        return abi.encodePacked(r, s, v);
    }

    function _alone() internal pure returns (LibSignedOffer.OfferSet memory set) {}

    function _noAuth() internal pure returns (LibSignedOffer.FillAuth memory auth) {}

    function _take(uint256 tokenId) internal pure returns (CollectionOfferFacet.SignedTake memory t) {
        t.tokenId = tokenId;
    }

    function _hash(LibSignedOffer.SignedOffer memory o) internal view returns (bytes32) {
        return SignedOfferFacet(address(diamond)).signedOfferOrderHash(o);
    }

    /// @dev The borrower's acceptance of one loan of `o` against `tokenId`.
    function _terms(LibSignedOffer.SignedOffer memory o, uint256 tokenId)
        internal
        returns (LibAcceptTerms.AcceptTerms memory t, bytes memory sig)
    {
        t.acceptor = borrower;
        t.offerCreator = o.signer;
        t.offerKey = CollectionOfferFacet(address(diamond)).signedFillKey(_hash(o), tokenId);
        t.offerType = o.offerType;
        t.lendingAsset = o.lendingAsset;
        t.collateralAsset = o.collateralAsset;
        t.amount = o.amount;
        t.collateralAmount = o.collateralAmount;
        t.interestRateBps = o.interestRateBps;
        t.durationDays = o.durationDays;
        t.collateralTokenId = tokenId;
        t.collateralQuantity = o.collateralQuantity;
        t.assetType = o.assetType;
        t.collateralAssetType = o.collateralAssetType;
        t.prepayAsset = o.prepayAsset;
        t.useFullTermInterest = o.useFullTermInterest;
        t.allowsPartialRepay = o.allowsPartialRepay;
        t.allowsPrepayListing = o.allowsPrepayListing;
        t.allowsParallelSale = o.allowsParallelSale;
        t.periodicInterestCadence = o.periodicInterestCadence;
        t.riskAndTermsConsent = true;
        t.acknowledgedIlliquidCollateralAsset = address(nft);
        t.nonce = ++nonceSeq;
        t.deadline = block.timestamp + 1 hours;
        t.riskTermsHash = RiskAccessFacet(address(diamond)).getCurrentRiskTermsHash();
        sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
    }

    function _fill(
        LibSignedOffer.SignedOffer memory o,
        bytes memory sig,
        LibSignedOffer.OfferSet memory set,
        CollectionOfferFacet.SignedTake memory take
    ) internal returns (uint256) {
        (LibAcceptTerms.AcceptTerms memory t, bytes memory acceptSig) = _terms(o, take.tokenId);
        vm.prank(borrower);
        return CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(
            o, sig, set, take, t, acceptSig, _noAuth()
        );
    }

    // ─── The fill ─────────────────────────────────────────────────────────

    function test_fillsOneLoanPerTokenFromTheVault() public {
        LibSignedOffer.SignedOffer memory o = _order(2);
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER * 2);

        uint256 a = _fill(o, sig, _alone(), _take(3));
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(a);
        assertEq(loan.lender, lender, "lender is the signer");
        assertEq(loan.borrower, borrower, "borrower is the caller");
        assertEq(loan.principal, PER, "one loan's principal");
        assertEq(loan.collateralTokenId, 3, "against the token taken");
        assertEq(SignedOfferFacet(address(diamond)).signedOfferFilledAmount(_hash(o)), PER, "one loan counted");

        uint256 b = _fill(o, sig, _alone(), _take(4));
        assertTrue(b != a, "a second loan");
        assertEq(SignedOfferFacet(address(diamond)).signedOfferFilledAmount(_hash(o)), PER * 2, "two loans counted");
    }

    function test_refusesPastTheSignedLoans() public {
        LibSignedOffer.SignedOffer memory o = _order(1);
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER * 2);
        _fill(o, sig, _alone(), _take(3));

        (LibAcceptTerms.AcceptTerms memory t, bytes memory acceptSig) = _terms(o, 4);
        // The order's ledger stands at its ceiling (one loan), so the fill is
        // refused before anything moves.
        vm.expectRevert();
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), _take(4), t, acceptSig, _noAuth());
    }

    function test_refusesWhenTheVaultIsShort() public {
        LibSignedOffer.SignedOffer memory o = _order(2);
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER / 2);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory acceptSig) = _terms(o, 3);
        vm.expectRevert();
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), _take(3), t, acceptSig, _noAuth());
    }

    // ─── The set ──────────────────────────────────────────────────────────

    function test_refusesATokenOutsideTheRange() public {
        LibSignedOffer.SignedOffer memory o = _order(2);
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory acceptSig) = _terms(o, 11);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollectionOfferFacet.SignedCollectionTakeRefused.selector,
                _hash(o),
                uint256(11),
                CollectionOfferFacet.TakeFailure.NotInSet
            )
        );
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), _take(11), t, acceptSig, _noAuth());
    }

    function test_exclusionsAreCheckedAgainstTheSignedHash() public {
        uint256[] memory excl = new uint256[](1);
        excl[0] = 5;
        LibSignedOffer.SignedOffer memory o = _order(2);
        o.exclusionsHash = keccak256(abi.encodePacked(excl));
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER);

        // The excluded token is refused even though it is in the range.
        CollectionOfferFacet.SignedTake memory take = _take(5);
        take.exclusions = excl;
        (LibAcceptTerms.AcceptTerms memory t, bytes memory acceptSig) = _terms(o, 5);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollectionOfferFacet.SignedCollectionTakeRefused.selector,
                _hash(o),
                uint256(5),
                CollectionOfferFacet.TakeFailure.NotInSet
            )
        );
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), take, t, acceptSig, _noAuth());

        // Presenting no exclusions does not match the signed hash.
        CollectionOfferFacet.SignedTake memory bare = _take(6);
        (t, acceptSig) = _terms(o, 6);
        vm.expectRevert(LibCollateralSet.CollateralExclusionsMismatch.selector);
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), bare, t, acceptSig, _noAuth());

        // With the signed exclusions, another token fills.
        CollectionOfferFacet.SignedTake memory ok = _take(6);
        ok.exclusions = excl;
        _fill(o, sig, _alone(), ok);
    }

    function test_listedSetTakesAProvenMember() public {
        (bytes32 root, bytes32[4] memory leaves) = _tree();
        LibSignedOffer.SignedOffer memory o = _order(1);
        o.setKind = uint8(LibVaipakam.CollateralSetKind.Listed);
        o.setLow = 0;
        o.setHigh = 0;
        o.setRoot = root;
        o.setListCount = 4;
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER);

        CollectionOfferFacet.SignedTake memory take = _take(9);
        take.proof = new bytes32[](2);
        take.proof[0] = leaves[0];
        take.proof[1] = Hashes.commutativeKeccak256(leaves[2], leaves[3]);
        uint256 loanId = _fill(o, sig, _alone(), take);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).collateralTokenId, 9, "token 9 taken");
    }

    // ─── Lifetime and parties ─────────────────────────────────────────────

    function test_lifetimeRunsFromSigning() public {
        LibSignedOffer.SignedOffer memory o = _order(1);
        (, uint32 maxExpiry) = CollectionOfferFacet(address(diamond)).getCollectionOfferLimits();
        // Signed long ago: an expiry within the order's own window is still
        // past the governed lifetime from signing.
        vm.warp(block.timestamp + uint256(maxExpiry) + 2 days);
        o.expiresAt = uint64(vm.getBlockTimestamp() + 1 days);
        o.deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory acceptSig) = _terms(o, 3);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollectionOfferFacet.SignedCollectionLifetimeInvalid.selector,
                o.startTime,
                o.expiresAt,
                o.deadline,
                uint256(o.startTime) + maxExpiry
            )
        );
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), _take(3), t, acceptSig, _noAuth());
    }

    function test_refusesAnOutOfRangeKind() public {
        LibSignedOffer.SignedOffer memory o = _order(1);
        o.setKind = 9;
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory acceptSig) = _terms(o, 3);
        vm.expectRevert(CollectionOfferFacet.CollectionOfferShape.selector);
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), _take(3), t, acceptSig, _noAuth());
    }

    // ─── The route rule ───────────────────────────────────────────────────

    function test_collectionOrderIsRefusedOnTheOrdinaryRoute() public {
        LibSignedOffer.SignedOffer memory o = _order(1);
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER);
        LibAcceptTerms.AcceptTerms memory t;
        vm.expectRevert(abi.encodeWithSelector(LibSignedOffer.SignedOfferWrongRoute.selector, o.setKind));
        vm.prank(borrower);
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, _alone(), t, "", _noAuth());
    }

    function test_ordinaryOrderIsRefusedOnTheCollectionRoute() public {
        LibSignedOffer.SignedOffer memory o = _order(1);
        o.setKind = 0;
        o.setLow = 0;
        o.setHigh = 0;
        o.loans = 0;
        o.startTime = 0;
        bytes memory sig = _sign(o);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory acceptSig) = _terms(o, 3);
        vm.expectRevert(abi.encodeWithSelector(LibSignedOffer.SignedOfferWrongRoute.selector, uint8(0)));
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), _take(3), t, acceptSig, _noAuth());
    }

    /// @dev The security review's ask: a set signature whose members include
    ///      a collection offer. The collection member fills through its own
    ///      route under the set placement; the ordinary route refuses it.
    function test_setMemberWithACollectionKind() public {
        LibSignedOffer.SignedOffer[] memory set = new LibSignedOffer.SignedOffer[](2);
        set[0] = _order(1);
        set[1] = _order(1);
        set[1].setLow = 11;
        set[1].setHigh = 20;
        bytes32 d = SignedOfferFacet(address(diamond)).hashSignedOfferSet(set);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lenderPk, d);
        bytes memory sig = abi.encodePacked(r, s, v);
        _fundActorVault(lender, mockERC20, PER * 2);

        LibSignedOffer.OfferSet memory place1;
        place1.others = new bytes32[](1);
        place1.others[0] = _hash(set[0]);
        place1.index = 1;
        uint256 loanId = _fill(set[1], sig, place1, _take(15));
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).collateralTokenId, 15, "member 1 filled");

        // The other member, presented on the ordinary route, is refused by
        // the route rule before its signature is read.
        LibSignedOffer.OfferSet memory place0;
        place0.others = new bytes32[](1);
        place0.others[0] = _hash(set[1]);
        place0.index = 0;
        LibAcceptTerms.AcceptTerms memory t;
        vm.expectRevert(abi.encodeWithSelector(LibSignedOffer.SignedOfferWrongRoute.selector, set[0].setKind));
        vm.prank(borrower);
        SignedOfferFacet(address(diamond)).acceptSignedOffer(set[0], sig, place0, t, "", _noAuth());

        // And a wrong placement does not verify on the collection route.
        (LibAcceptTerms.AcceptTerms memory t2, bytes memory acceptSig) = _terms(set[0], 3);
        vm.expectRevert(LibSignedOffer.SignedOfferBadSignature.selector);
        vm.prank(borrower);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(set[0], sig, _alone(), _take(3), t2, acceptSig, _noAuth());
    }

    function test_signerCannotFillItsOwnOrder() public {
        LibSignedOffer.SignedOffer memory o = _order(1);
        bytes memory sig = _sign(o);
        _fundActorVault(lender, mockERC20, PER);
        LibAcceptTerms.AcceptTerms memory t;
        vm.expectRevert(
            abi.encodeWithSelector(
                CollectionOfferFacet.SignedCollectionTakeRefused.selector,
                _hash(o),
                uint256(3),
                CollectionOfferFacet.TakeFailure.OwnOffer
            )
        );
        vm.prank(lender);
        CollectionOfferFacet(address(diamond)).fillSignedCollectionOffer(o, sig, _alone(), _take(3), t, "", _noAuth());
    }

    /// @dev A four-id standard tree over 7, 9, 11, 13.
    function _tree() internal pure returns (bytes32 root, bytes32[4] memory leaves) {
        leaves[0] = LibCollateralSet.leaf(7);
        leaves[1] = LibCollateralSet.leaf(9);
        leaves[2] = LibCollateralSet.leaf(11);
        leaves[3] = LibCollateralSet.leaf(13);
        bytes32 a = Hashes.commutativeKeccak256(leaves[0], leaves[1]);
        bytes32 b = Hashes.commutativeKeccak256(leaves[2], leaves[3]);
        root = Hashes.commutativeKeccak256(a, b);
    }
}
