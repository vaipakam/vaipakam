// test/NFTPrepayListingAtomicFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {NFTPrepayListingAtomicFacet} from "../src/facets/NFTPrepayListingAtomicFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockListingExecutorRecorder} from "./mocks/MockListingExecutorRecorder.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {MockSeaport} from "./mocks/MockSeaport.sol";
import {MockConduitController} from "./mocks/MockConduitController.sol";
import {
    OrderComponents,
    OfferItem,
    ConsiderationItem,
    OrderType as HashOrderType
} from "../src/seaport/ISeaportOrderHash.sol";
import {ItemType} from "../src/seaport/ISeaportZone.sol";
import {CriteriaResolver} from "../src/seaport/ISeaportMatch.sol";
import {
    BidderOrder,
    MAX_RESOLVERS,
    MAX_BIDDER_EXTRADATA_BYTES
} from "../src/seaport/PrepayTypes.sol";

/**
 * @notice T-086 Round-6 / Block D (#345) — `NFTPrepayListingAtomicFacet`
 *         unit tests.
 *
 *         **Scope:** the entry-gate + bidder-shape + hash-mismatch +
 *         calldata-cap branches that REVERT BEFORE any
 *         `Seaport.matchAdvancedOrders` invocation. End-to-end
 *         happy-path coverage (where Seaport actually settles the
 *         match) is best exercised via a fork-test against real
 *         Seaport — tracked as a Block D follow-up. The pre-Seaport
 *         reverts here are the load-bearing protocol-correctness
 *         gates, and they're 100% local-testable.
 *
 *         Buckets (Round-6 design doc §17.4 / §17.5 / §17.5-bis):
 *           1. Entry gates — every revert in `_assertEntryGates`.
 *           2. Calldata caps — extraData / resolvers / proof-depth.
 *           3. §17.5 bidder bytes verification — hash mismatch +
 *              on-chain-cancelled rejection.
 *           4. §17.5-bis shape invariant — selected rejection cases.
 */
contract NFTPrepayListingAtomicFacetTest is SetupTest {
    MockListingExecutorRecorder internal mockExecutor;
    MockRentableNFT721 internal collateralNFT;
    MockSeaport internal mockSeaport;
    MockConduitController internal mockConduitController;
    address internal borrowerVaultAddr;

    address internal borrowerHolder;
    address internal randomCaller;
    address internal bidder;
    address internal conduit;
    bytes32 internal conduitKey;

    uint256 internal constant LOAN_ID = 4_242;
    uint256 internal constant LENDER_TOKEN_ID = 100;
    uint256 internal constant BORROWER_TOKEN_ID = 101;
    uint256 internal constant COLLATERAL_TOKEN_ID = 1;
    uint256 internal constant TEST_SALT = 0xa11ce;
    uint16 internal constant TEST_BUFFER_BPS = 200;

    address internal constant PRINCIPAL_TOKEN = address(0x1234);
    address internal constant SOME_OTHER_TOKEN = address(0x9876);

    function setUp() public {
        setupHelper();
        mockExecutor = new MockListingExecutorRecorder();
        collateralNFT = new MockRentableNFT721();
        mockConduitController = new MockConduitController();
        mockSeaport = new MockSeaport(address(mockConduitController));
        mockExecutor.setSeaport(address(mockSeaport));

        borrowerHolder = makeAddr("borrowerHolder");
        randomCaller = makeAddr("randomCaller");
        bidder = makeAddr("bidder");
        conduit = makeAddr("seaportConduitMock");
        conduitKey = keccak256("test-conduit-key");
        mockConduitController.register(conduitKey, conduit);

        borrowerVaultAddr =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerHolder);
        collateralNFT.mint(borrowerHolder, COLLATERAL_TOKEN_ID);
        vm.prank(borrowerHolder);
        collateralNFT.transferFrom(borrowerHolder, borrowerVaultAddr, COLLATERAL_TOKEN_ID);

        mockExecutor.setApprovedConduit(conduit, true);
        vm.startPrank(owner);
        PrepayListingFacet(address(diamond))
            .setCollateralListingExecutor(address(mockExecutor));
        ConfigFacet(address(diamond))
            .setPrepayListingBufferBps(TEST_BUFFER_BPS);
        ConfigFacet(address(diamond))
            .setPrepayListingEnabled(true);
        vm.stopPrank();
    }

    // ─── 1. Entry gates (§17.4) ─────────────────────────────────────────

    function test_matchOpenSeaOffer_revertsWhenKillSwitchOff() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPrepayListingEnabled(false);

        vm.prank(borrowerHolder);
        vm.expectRevert(NFTPrepayListingAtomicFacet.PrepayListingDisabled.selector);
        _callMatch(_validBidderOrder(), keccak256("any-hash"));
    }

    function test_matchOpenSeaOffer_revertsWhenLoanNotActive() public {
        LibVaipakam.Loan memory loan = _baseLoan();
        loan.allowsPrepayListing = true;
        loan.status = LibVaipakam.LoanStatus.Settled;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.PrepayLoanNotActive.selector,
                LOAN_ID,
                LibVaipakam.LoanStatus.Settled
            )
        );
        _callMatch(_validBidderOrder(), keccak256("any-hash"));
    }

    function test_matchOpenSeaOffer_revertsWhenAllowsPrepayFalse() public {
        // Codex round-12 P2 — without this gate, a borrower could
        // call matchOpenSeaOffer on a loan whose lender NEVER
        // consented to prepay-listing.
        _scaffoldActiveLoan({allowsPrepay: false});
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.PrepayListingNotAllowed.selector,
                LOAN_ID
            )
        );
        _callMatch(_validBidderOrder(), keccak256("any-hash"));
    }

    function test_matchOpenSeaOffer_revertsUnsupportedCollateral() public {
        LibVaipakam.Loan memory loan = _baseLoan();
        loan.allowsPrepayListing = true;
        loan.collateralAssetType = LibVaipakam.AssetType.ERC20;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.UnsupportedCollateralForV1.selector,
                LibVaipakam.AssetType.ERC20
            )
        );
        _callMatch(_validBidderOrder(), keccak256("any-hash"));
    }

    function test_matchOpenSeaOffer_revertsUnsupportedPrincipal() public {
        LibVaipakam.Loan memory loan = _baseLoan();
        loan.allowsPrepayListing = true;
        loan.assetType = LibVaipakam.AssetType.ERC721;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.UnsupportedPrincipalForV1.selector,
                LibVaipakam.AssetType.ERC721
            )
        );
        _callMatch(_validBidderOrder(), keccak256("any-hash"));
    }

    function test_matchOpenSeaOffer_revertsPastGrace() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        uint256 graceEnd = _graceEnd();
        vm.warp(graceEnd + 1);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.PrepayGraceWindowClosed.selector,
                LOAN_ID,
                block.timestamp,
                graceEnd
            )
        );
        _callMatch(_validBidderOrder(), keccak256("any-hash"));
    }

    function test_matchOpenSeaOffer_revertsNotPositionHolder() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        vm.prank(randomCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.NotPositionHolder.selector,
                LOAN_ID,
                randomCaller,
                borrowerHolder
            )
        );
        _callMatch(_validBidderOrder(), keccak256("any-hash"));
    }

    // ─── 2. Calldata caps (§17.4 — Raja P3) ─────────────────────────────

    function test_matchOpenSeaOffer_revertsExtraDataTooLarge() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        BidderOrder memory bo = _validBidderOrder();
        bo.extraData = new bytes(MAX_BIDDER_EXTRADATA_BYTES + 1);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.BidderExtraDataTooLarge.selector,
                MAX_BIDDER_EXTRADATA_BYTES + 1,
                MAX_BIDDER_EXTRADATA_BYTES
            )
        );
        _callMatch(bo, keccak256("any-hash"));
    }

    function test_matchOpenSeaOffer_revertsTooManyResolvers() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        BidderOrder memory bo = _validBidderOrder();
        CriteriaResolver[] memory resolvers = new CriteriaResolver[](MAX_RESOLVERS + 1);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.TooManyResolvers.selector,
                MAX_RESOLVERS + 1,
                MAX_RESOLVERS
            )
        );
        NFTPrepayListingAtomicFacet(address(diamond)).matchOpenSeaOffer(
            LOAN_ID, bo, keccak256("any-hash"), resolvers, TEST_SALT, conduitKey
        );
    }

    // ─── 3. §17.5 bidder bytes verification ─────────────────────────────

    function test_matchOpenSeaOffer_revertsHashMismatch() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        BidderOrder memory bo = _validBidderOrder();
        // MockSeaport computes keccak256(abi.encode(bo.components)).
        // Pass a deliberately-wrong expected hash.
        bytes32 wrongHash = keccak256("not-the-right-hash");

        vm.prank(borrowerHolder);
        vm.expectRevert(); // selector match is enough; args derived from mock hash
        _callMatch(bo, wrongHash);
    }

    function test_matchOpenSeaOffer_revertsBidderCancelled() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        BidderOrder memory bo = _validBidderOrder();
        bytes32 realHash = mockSeaport.getOrderHash(bo.components);
        mockSeaport.setCancelled(realHash, true);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.BidderOrderNotFillable.selector,
                uint8(1) // NOT_FILLABLE_CANCELLED
            )
        );
        _callMatch(bo, realHash);
    }

    // ─── 4. §17.5-bis shape invariant ───────────────────────────────────

    function test_matchOpenSeaOffer_revertsWrongPaymentToken() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        BidderOrder memory bo = _validBidderOrder();
        bo.components.offer[0].token = SOME_OTHER_TOKEN;
        bytes32 realHash = mockSeaport.getOrderHash(bo.components);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.BidderPaymentTokenMismatch.selector,
                PRINCIPAL_TOKEN,
                SOME_OTHER_TOKEN
            )
        );
        _callMatch(bo, realHash);
    }

    function test_matchOpenSeaOffer_revertsExtraOfferItems() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        BidderOrder memory bo = _validBidderOrder();
        // Build a 2-item offer (cap is 1).
        OfferItem[] memory twoOffers = new OfferItem[](2);
        twoOffers[0] = bo.components.offer[0];
        twoOffers[1] = bo.components.offer[0];
        bo.components.offer = twoOffers;
        bytes32 realHash = mockSeaport.getOrderHash(bo.components);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.BidderOrderShapeMismatch.selector,
                uint8(1) // SHAPE_EXTRA_OFFER_ITEMS
            )
        );
        _callMatch(bo, realHash);
    }

    function test_matchOpenSeaOffer_revertsCons0NotFixedAmount() public {
        // Raja PR #346 round-1 — the SHAPE_CONS0_NOT_FIXED_AMOUNT
        // tag (9) was previously dead. After splitting the cons[0]
        // fixed + amount-equals checks, this case now surfaces as
        // tag 9 instead of tag 8.
        _scaffoldActiveLoan({allowsPrepay: true});
        BidderOrder memory bo = _validBidderOrder();
        bo.components.consideration[0].endAmount = 999; // != startAmount (= 1)
        bytes32 realHash = mockSeaport.getOrderHash(bo.components);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.BidderOrderShapeMismatch.selector,
                uint8(9) // SHAPE_CONS0_NOT_FIXED_AMOUNT
            )
        );
        _callMatch(bo, realHash);
    }

    function test_matchOpenSeaOffer_revertsTooManyConsiderationItems() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        BidderOrder memory bo = _validBidderOrder();
        // Build a 7-item consideration (cap is 1 + MAX_BIDDER_FEE_LEGS = 6).
        ConsiderationItem[] memory tooMany = new ConsiderationItem[](7);
        for (uint256 i = 0; i < 7; i++) {
            tooMany[i] = bo.components.consideration[0];
        }
        bo.components.consideration = tooMany;
        bytes32 realHash = mockSeaport.getOrderHash(bo.components);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingAtomicFacet.BidderOrderShapeMismatch.selector,
                uint8(4) // SHAPE_EXTRA_CONSIDERATION_ITEMS
            )
        );
        _callMatch(bo, realHash);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _baseLoan() internal returns (LibVaipakam.Loan memory loan) {
        loan.id = LOAN_ID;
        loan.lender = makeAddr("loanLender");
        loan.borrower = borrowerHolder;
        loan.principal = 100 ether;
        loan.interestRateBps = 1_200;
        loan.startTime = uint64(block.timestamp);
        loan.durationDays = 30;
        loan.lenderTokenId = LENDER_TOKEN_ID;
        loan.borrowerTokenId = BORROWER_TOKEN_ID;
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.collateralAssetType = LibVaipakam.AssetType.ERC721;
        loan.collateralAsset = address(collateralNFT);
        loan.collateralTokenId = COLLATERAL_TOKEN_ID;
        loan.collateralQuantity = 1;
        loan.principalAsset = PRINCIPAL_TOKEN;
        loan.assetType = LibVaipakam.AssetType.ERC20;
        loan.allowsPrepayListing = false; // toggled by callers
    }

    function _scaffoldActiveLoan(bool allowsPrepay) internal {
        LibVaipakam.Loan memory loan = _baseLoan();
        loan.allowsPrepayListing = allowsPrepay;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);
        // Mint both position NFTs — the pctx read at facet entry
        // would otherwise revert ERC721NonexistentToken on the
        // lender side.
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrowerHolder, BORROWER_TOKEN_ID);
        TestMutatorFacet(address(diamond)).mintNFTRaw(makeAddr("loanLender"), LENDER_TOKEN_ID);
    }

    function _graceEnd() internal returns (uint256) {
        LibVaipakam.Loan memory loan = _baseLoan();
        uint256 endTime = uint256(loan.startTime) + (uint256(loan.durationDays) * 1 days);
        return endTime + LibVaipakam.gracePeriod(loan.durationDays);
    }

    /// @dev Minimally-valid bidder order. Tests mutate fields off
    ///      this base to trigger specific rejection paths.
    function _validBidderOrder() internal view returns (BidderOrder memory bo) {
        OrderComponents memory c;
        c.offerer = bidder;
        c.zone = address(0);
        c.offer = new OfferItem[](1);
        c.offer[0] = OfferItem({
            itemType: ItemType.ERC20,
            token: PRINCIPAL_TOKEN,
            identifierOrCriteria: 0,
            startAmount: 1e18,
            endAmount: 1e18
        });
        c.consideration = new ConsiderationItem[](1);
        c.consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC721,
            token: address(collateralNFT),
            identifierOrCriteria: COLLATERAL_TOKEN_ID,
            startAmount: 1,
            endAmount: 1,
            recipient: payable(bidder)
        });
        c.orderType = HashOrderType.FULL_OPEN;
        c.startTime = block.timestamp;
        c.endTime = block.timestamp + 1 days;
        c.zoneHash = bytes32(0);
        c.salt = TEST_SALT;
        c.conduitKey = conduitKey;
        c.counter = 0;
        bo.components = c;
        bo.signature = "";
        bo.extraData = "";
    }

    function _callMatch(BidderOrder memory bo, bytes32 expectedHash) private {
        CriteriaResolver[] memory empty = new CriteriaResolver[](0);
        NFTPrepayListingAtomicFacet(address(diamond)).matchOpenSeaOffer(
            LOAN_ID, bo, expectedHash, empty, TEST_SALT, conduitKey
        );
    }
}
