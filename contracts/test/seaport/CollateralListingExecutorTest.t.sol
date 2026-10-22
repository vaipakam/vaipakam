// test/seaport/CollateralListingExecutorTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {CollateralListingExecutor} from "../../src/seaport/CollateralListingExecutor.sol";
import {
    FeeLeg,
    OfferContext,
    PREPAY_MODE_FIXED_PRICE,
    PREPAY_MODE_DUTCH
} from "../../src/seaport/PrepayTypes.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {
    ISeaportZone,
    ZoneParameters,
    ReceivedItem,
    SpentItem,
    ItemType
} from "../../src/seaport/ISeaportZone.sol";
import {IVaipakamPrepayContext} from "../../src/seaport/IVaipakamPrepayContext.sol";
import {IVaipakamPrepayCallbacks} from "../../src/seaport/IVaipakamPrepayCallbacks.sol";
import {ISeaportOrderHash, ISeaportCancel} from "../../src/seaport/ISeaportOrderHash.sol";

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/// @notice #1279 — the collateral as a real ERC-721, so the zone's
///         post-transfer holder read sees an owner. The fill harness moves no
///         NFT, so a test places the token where the fill would have.
contract ListingCollateral721 is ERC721 {
    constructor() ERC721("Collateral", "COL") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function move(address to, uint256 id) external {
        _transfer(ownerOf(id), to, id);
    }
}

/// @notice Mock diamond implementing the two interfaces the executor
///         calls into. Test can configure the returned `PrepayContext`
///         + assert that `executorFinalizePrepaySale` was invoked with
///         the right loanId.
contract MockVaipakamDiamond is IVaipakamPrepayContext, IVaipakamPrepayCallbacks {
    IVaipakamPrepayContext.PrepayContext public ctx;
    bool public finalizeCalled;
    uint256 public finalizeLoanId;
    address public finalizeCaller;

    function setContext(IVaipakamPrepayContext.PrepayContext memory c) external {
        ctx = c;
    }

    function getPrepayContext(uint256, uint256)
        external
        view
        override
        returns (IVaipakamPrepayContext.PrepayContext memory)
    {
        return ctx;
    }

    function executorFinalizePrepaySale(uint256 loanId) external override {
        finalizeCalled = true;
        finalizeLoanId = loanId;
        finalizeCaller = msg.sender;
    }

    // T-086 Round-8 (#358) — offer-keyed callback stubs. Test harness
    // for `CollateralListingExecutor` itself; the no-loan-branch
    // dispatch lands in Step 7 (this commit only needs the interface
    // to be satisfied so the executor compiles).
    bool public markConsumedCalled;
    uint96 public markConsumedOfferId;
    bool public recordProceedsCalled;
    uint96 public recordProceedsOfferId;
    address public recordProceedsAsset;
    uint256 public recordProceedsAmount;
    bool public sanctionsCalled;
    uint96 public sanctionsOfferId;
    address public sanctionsWallet;

    function markOfferConsumedBySale(uint96 offerId) external override {
        markConsumedCalled = true;
        markConsumedOfferId = offerId;
    }
    /// @dev #2440 — when set, `recordOfferSaleProceeds` pays the proceeds
    ///      onward as the real Diamond does (into the borrower's vault), so a
    ///      test can show one fill's settlement is never read as another's
    ///      arrival.
    address public forwardProceedsTo;
    function setForwardProceedsTo(address to) external {
        forwardProceedsTo = to;
    }
    function recordOfferSaleProceeds(
        uint96 offerId,
        address principalAsset,
        uint256 amount
    ) external override {
        recordProceedsCalled = true;
        recordProceedsOfferId = offerId;
        recordProceedsAsset = principalAsset;
        recordProceedsAmount = amount;
        if (forwardProceedsTo != address(0)) {
            IERC20(principalAsset).transfer(forwardProceedsTo, amount);
        }
    }
    function assertOfferFillNotSanctioned(uint96 offerId, address borrowerWallet)
        external
        override
    {
        sanctionsCalled = true;
        sanctionsOfferId = offerId;
        sanctionsWallet = borrowerWallet;
    }

    // #825-r3 — the executor's fill-time re-screen calls
    // `IVaipakamSanctionsView(diamond).isSanctionedAddress(...)`; the mock
    // answers it (default clean) so existing fill tests are unaffected, and a
    // test can flag a recipient via `setSanctioned`.
    mapping(address => bool) public sanctioned;
    function setSanctioned(address who, bool v) external {
        sanctioned[who] = v;
    }
    function isSanctionedAddress(address who) external view returns (bool) {
        return sanctioned[who];
    }
    // #1144 — the executor's fill-time screen now calls the registry-aware
    // `isRecipientBarred`. The mock answers it (default clean); `setSanctioned`
    // flags a recipient for both reads so existing fill tests are unaffected.
    function isRecipientBarred(address who) external view returns (bool) {
        return sanctioned[who];
    }
}

/// @notice #2440 — stands in for Seaport at the `seaport` address (etched
///         there). Seaport 1.6 runs every restricted order's `authorizeOrder`
///         before any transfer and every `validateOrder` after all of them,
///         inside ONE call. The zone's arrival record is transient, and forge
///         >= 1.8 does not carry transient storage across a test's top-level
///         calls, so the whole fill has to run inside one call, as here.
///         `delivered[k][i]` is what consideration item `i` of order `k`
///         actually brings its recipient (a short figure models a token that
///         delivers less than it sends).
contract SeaportFillHarness {
    function fill(
        CollateralListingExecutor zone,
        ZoneParameters[] calldata orders,
        uint256[][] calldata delivered
    ) external {
        for (uint256 k = 0; k < orders.length; k++) {
            zone.authorizeOrder(orders[k]);
        }
        for (uint256 k = 0; k < orders.length; k++) {
            for (uint256 i = 0; i < delivered[k].length; i++) {
                ERC20Mock(orders[k].consideration[i].token).mint(
                    orders[k].consideration[i].recipient,
                    delivered[k][i]
                );
            }
        }
        for (uint256 k = 0; k < orders.length; k++) {
            zone.validateOrder(orders[k]);
        }
    }
}

contract CollateralListingExecutorTest is Test {
    CollateralListingExecutor internal executor;
    MockVaipakamDiamond internal diamond;
    address internal seaport;
    address internal owner;
    address internal conduit;
    address internal lenderHolder;
    address internal borrowerHolder;
    address internal treasury;
    address internal principalAsset;
    address internal collateralAsset;
    address internal buyer;

    bytes32 internal constant TEST_ORDER_HASH = keccak256("test-order");
    uint256 internal constant TEST_LOAN_ID = 4242;
    uint256 internal constant TEST_COLLATERAL_TOKEN_ID = 777;

    function setUp() public {
        seaport = makeAddr("seaport");
        owner = makeAddr("owner");
        conduit = makeAddr("conduit");
        lenderHolder = makeAddr("lenderHolder");
        borrowerHolder = makeAddr("borrowerHolder");
        treasury = makeAddr("treasury");
        // #2440 — a real token: the zone reads each protocol leg recipient's
        // balance in both hooks.
        principalAsset = address(new ERC20Mock("Principal", "PRN", 18));
        buyer = makeAddr("buyer");
        // #1279 — the zone reads the ERC-721 collateral's holder at
        // `validateOrder`; in a single-order fill the buyer holds it by then.
        ListingCollateral721 collateral = new ListingCollateral721();
        collateral.mint(buyer, TEST_COLLATERAL_TOKEN_ID);
        collateralAsset = address(collateral);

        diamond = new MockVaipakamDiamond();

        // Deploy the executor behind an ERC1967 proxy + initialize.
        CollateralListingExecutor implementation = new CollateralListingExecutor();
        bytes memory initData = abi.encodeCall(
            CollateralListingExecutor.initialize,
            (seaport, address(diamond), owner)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        executor = CollateralListingExecutor(address(proxy));

        // Seed an approved conduit + a default context state.
        vm.prank(owner);
        executor.addApprovedConduit(conduit);

        _setDefaultContext();
        _stubSeaport();
    }

    /// @dev T-086 #316 — the executor's new {clearOrder} reconstructs
    ///      the canonical `OrderComponents` and calls
    ///      `ISeaportOrderHash.getOrderHash` / `ISeaportOrderHash.getCounter`
    ///      / `ISeaportCancel.cancel` on the `seaport` address. The
    ///      test's `seaport` is a `makeAddr` EOA (no code), so stub
    ///      those three calls so they don't revert with "Returned
    ///      data is too short". The stubbed `getOrderHash` returns
    ///      `bytes32(0)` — never equal to `TEST_ORDER_HASH` — so the
    ///      "drift" branch of `_tryCancelOnSeaport` fires, emitting
    ///      `SeaportCancelSkipped`. The `clearOrder` body then
    ///      continues with the same `delete orderContext[hash]` +
    ///      `emit OrderCanceled(...)` semantics as pre-#316, so the
    ///      existing happy-path test still asserts the same thing.
    function _stubSeaport() internal {
        vm.mockCall(
            seaport,
            abi.encodeWithSelector(ISeaportOrderHash.getOrderHash.selector),
            abi.encode(bytes32(0))
        );
        vm.mockCall(
            seaport,
            abi.encodeWithSelector(ISeaportOrderHash.getCounter.selector),
            abi.encode(uint256(0))
        );
        vm.mockCall(
            seaport,
            abi.encodeWithSelector(ISeaportCancel.cancel.selector),
            abi.encode(true)
        );
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _setDefaultContext() internal {
        IVaipakamPrepayContext.PrepayContext memory c;
        c.status = LibVaipakam.LoanStatus.Active;
        c.assetType = LibVaipakam.AssetType.ERC20;
        c.collateralAssetType = LibVaipakam.AssetType.ERC721;
        c.principalAsset = principalAsset;
        c.collateralAsset = collateralAsset;
        c.collateralTokenId = TEST_COLLATERAL_TOKEN_ID;
        c.collateralQuantity = 1;
        c.lenderLeg = 100e18;
        c.treasuryLeg = 1e18;
        c.graceEnd = block.timestamp + 30 days;
        c.lenderNftOwner = lenderHolder;
        c.borrowerNftOwner = borrowerHolder;
        c.treasury = treasury;
        // #306 fix — executor's _checkOrderPreconditions verifies
        // `params.offerer == pctx.borrowerVault`. Test's
        // `_validZoneParams` sets `p.offerer` to this same address.
        c.borrowerVault = makeAddr("mockBorrowerVault");
        diamond.setContext(c);
    }

    function _validZoneParams() internal returns (ZoneParameters memory p) {
        p.orderHash = TEST_ORDER_HASH;
        p.fulfiller = buyer;
        // #306 fix — must match `pctx.borrowerVault` set in
        // `_setDefaultContext`. Same makeAddr seed.
        p.offerer = makeAddr("mockBorrowerVault");

        // Single ERC721 offered item matching loan's collateral.
        p.offer = new SpentItem[](1);
        p.offer[0] = SpentItem({
            itemType: ItemType.ERC721,
            token: collateralAsset,
            identifier: TEST_COLLATERAL_TOKEN_ID,
            amount: 1
        });

        // Three consideration legs in [lender, treasury, borrower] order.
        p.consideration = new ReceivedItem[](3);
        p.consideration[0] = ReceivedItem({
            itemType: ItemType.ERC20,
            token: principalAsset,
            identifier: 0,
            amount: 110e18, // ≥ 100e18 lenderLeg
            recipient: payable(lenderHolder)
        });
        p.consideration[1] = ReceivedItem({
            itemType: ItemType.ERC20,
            token: principalAsset,
            identifier: 0,
            amount: 1e18, // ≥ 1e18 treasuryLeg
            recipient: payable(treasury)
        });
        p.consideration[2] = ReceivedItem({
            itemType: ItemType.ERC20,
            token: principalAsset,
            identifier: 0,
            amount: 5e18,
            recipient: payable(borrowerHolder)
        });

        p.startTime = block.timestamp;
        p.endTime = block.timestamp + 1 days;
        // A single-order fulfilment, as Seaport 1.6 builds it for
        // `fulfillOrder` / `fulfillAdvancedOrder` / basic orders: one entry.
        p.orderHashes = new bytes32[](1);
        p.orderHashes[0] = p.orderHash;
    }

    /// @dev T-086 #316 — `askPrice` MUST be ≥ lenderLeg + treasuryLeg
    ///      for the test fixture's pctx (set in `_setDefaultContext`:
    ///      lenderLeg=100e18, treasuryLeg=1e18). Otherwise the
    ///      cancel-time reconstruction in {clearOrder} would emit a
    ///      `SeaportCancelSkipped` for "floor-drift" reasons instead
    ///      of hitting the hash-match / hash-mismatch decision the
    ///      tests assert on. The real facet's
    ///      `_requireAskCoversFloor` enforces this invariant at
    ///      post-time; here we just pick a value comfortably above
    ///      the floor.
    uint256 internal constant TEST_ASK_PRICE = 200e18;

    function _recordValidOrder() internal {
        vm.prank(address(diamond));
        executor.recordOrder(
            TEST_ORDER_HASH,
            TEST_LOAN_ID,
            conduit,
            bytes32(0),
            uint256(0),
            uint256(block.timestamp),
            TEST_ASK_PRICE
        , TEST_ASK_PRICE, 0, PREPAY_MODE_FIXED_PRICE, _emptyFeeLegs(), uint256(0), uint256(0));
    }

    // ─── Admin: conduit allow-list ──────────────────────────────────────

    function test_addApprovedConduit_onlyOwner() public {
        address other = makeAddr("other");
        vm.prank(buyer);
        vm.expectRevert();
        executor.addApprovedConduit(other);

        vm.prank(owner);
        executor.addApprovedConduit(other);
        assertTrue(executor.approvedConduits(other));
    }

    function test_addApprovedConduit_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(CollateralListingExecutor.ZeroAddress.selector);
        executor.addApprovedConduit(address(0));
    }

    function test_removeApprovedConduit_clears() public {
        vm.prank(owner);
        executor.removeApprovedConduit(conduit);
        assertFalse(executor.approvedConduits(conduit));
    }

    // ─── recordOrder ───────────────────────────────────────────────────

    function test_recordOrder_onlyDiamond() public {
        vm.prank(buyer);
        vm.expectRevert(CollateralListingExecutor.NotDiamond.selector);
        executor.recordOrder(
            TEST_ORDER_HASH, TEST_LOAN_ID, conduit,
            bytes32(0), uint256(0), uint256(block.timestamp), uint256(0)
        , uint256(0), 0, PREPAY_MODE_FIXED_PRICE, _emptyFeeLegs(), uint256(0), uint256(0));
    }

    function test_recordOrder_rejectsUnapprovedConduit() public {
        address rogue = makeAddr("rogueConduit");
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(CollateralListingExecutor.ConduitNotApproved.selector, rogue)
        );
        executor.recordOrder(
            TEST_ORDER_HASH, TEST_LOAN_ID, rogue,
            bytes32(0), uint256(0), uint256(block.timestamp), uint256(0)
        , uint256(0), 0, PREPAY_MODE_FIXED_PRICE, _emptyFeeLegs(), uint256(0), uint256(0));
    }

    function test_recordOrder_alreadyRecorded() public {
        _recordValidOrder();
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.AlreadyRecorded.selector, TEST_ORDER_HASH
            )
        );
        executor.recordOrder(
            TEST_ORDER_HASH, TEST_LOAN_ID, conduit,
            bytes32(0), uint256(0), uint256(block.timestamp), uint256(0)
        , uint256(0), 0, PREPAY_MODE_FIXED_PRICE, _emptyFeeLegs(), uint256(0), uint256(0));
    }

    function test_recordOrder_uint96Overflow() public {
        uint256 tooBig = uint256(type(uint96).max) + 1;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(CollateralListingExecutor.LoanIdOverflow.selector, tooBig)
        );
        executor.recordOrder(
            TEST_ORDER_HASH, tooBig, conduit,
            bytes32(0), uint256(0), uint256(block.timestamp), uint256(0)
        , uint256(0), 0, PREPAY_MODE_FIXED_PRICE, _emptyFeeLegs(), uint256(0), uint256(0));
    }

    /// @dev T-086 #316 — bounds check on the new `startTime` narrowing
    ///      cast. uint64 overflow won't happen with `block.timestamp`
    ///      for ~580B years; the test passes a synthetic too-big
    ///      value to assert the check fires loudly.
    function test_recordOrder_uint64StartTimeOverflow() public {
        uint256 tooBig = uint256(type(uint64).max) + 1;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.StartTimeOverflow.selector, tooBig
            )
        );
        executor.recordOrder(
            TEST_ORDER_HASH, TEST_LOAN_ID, conduit,
            bytes32(0), uint256(0), tooBig, uint256(0)
        , uint256(0), 0, PREPAY_MODE_FIXED_PRICE, _emptyFeeLegs(), uint256(0), uint256(0));
    }

    /// @dev T-086 #316 — bounds check on the new `askPrice` narrowing
    ///      cast. uint192 is wider than any realistic NFT-floor wei
    ///      amount; the test passes a synthetic too-big value to
    ///      assert the check fires loudly.
    function test_recordOrder_uint192AskPriceOverflow() public {
        uint256 tooBig = uint256(type(uint192).max) + 1;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.AskPriceOverflow.selector, tooBig
            )
        );
        executor.recordOrder(
            TEST_ORDER_HASH, TEST_LOAN_ID, conduit,
            bytes32(0), uint256(0), uint256(block.timestamp), tooBig
        , tooBig, 0, PREPAY_MODE_FIXED_PRICE, _emptyFeeLegs(), uint256(0), uint256(0));
    }

    function test_recordOrder_happyPath() public {
        _recordValidOrder();
        // T-086 #316 + Round-5 Block B (#309) — OrderContext returns a
        // 9-tuple via the auto-generated public getter. The Block B
        // fields default to fixed-price stamps: `endAskPrice == askPrice`,
        // `auctionEndTime == 0`, `mode == PREPAY_MODE_FIXED_PRICE`.
        (
            uint96 storedLoanId,
            address storedConduit,
            bytes32 storedConduitKey,
            uint256 storedSalt,
            uint64 storedStartTime,
            uint192 storedAskPrice,
            uint128 storedEndAskPrice,
            uint64 storedAuctionEndTime,
            uint8 storedMode
        ) = executor.orderContext(TEST_ORDER_HASH);
        assertEq(uint256(storedLoanId), TEST_LOAN_ID);
        assertEq(storedConduit, conduit);
        assertEq(storedConduitKey, bytes32(0));
        assertEq(storedSalt, 0);
        assertEq(uint256(storedStartTime), block.timestamp);
        assertEq(uint256(storedAskPrice), TEST_ASK_PRICE);
        assertEq(uint256(storedEndAskPrice), TEST_ASK_PRICE);
        assertEq(uint256(storedAuctionEndTime), 0);
        assertEq(storedMode, PREPAY_MODE_FIXED_PRICE);
    }

    // ─── clearOrder ─────────────────────────────────────────────────────

    function test_clearOrder_onlyDiamond() public {
        _recordValidOrder();
        vm.prank(buyer);
        vm.expectRevert(CollateralListingExecutor.NotDiamond.selector);
        executor.clearOrder(TEST_ORDER_HASH);
    }

    function test_clearOrder_happyPath() public {
        _recordValidOrder();
        vm.prank(address(diamond));
        executor.clearOrder(TEST_ORDER_HASH);
        (uint96 storedLoanId, , , , , , , , ) = executor.orderContext(TEST_ORDER_HASH);
        assertEq(uint256(storedLoanId), 0);
    }

    /// @dev T-086 #316 — the cancel-time hash reconstruction WILL
    ///      mismatch in this test (the stubbed `seaport.getOrderHash`
    ///      returns `bytes32(0)` ≠ `TEST_ORDER_HASH`), so the
    ///      "drift" branch of `_tryCancelOnSeaport` fires. Expect
    ///      `SeaportCancelSkipped` (and NOT `SeaportCancelEmitted`)
    ///      to be emitted, then the existing cleanup proceeds.
    function test_clearOrder_emitsSeaportCancelSkippedOnDrift() public {
        _recordValidOrder();
        vm.expectEmit(true, true, false, false);
        emit CollateralListingExecutor.SeaportCancelSkipped(TEST_ORDER_HASH, TEST_LOAN_ID);
        vm.prank(address(diamond));
        executor.clearOrder(TEST_ORDER_HASH);
    }

    /// @dev T-086 #316 — when the cancel-time reconstruction hashes
    ///      to the SAME orderHash on file, the cancel emit fires
    ///      and Seaport is called. Test re-stubs `getOrderHash` to
    ///      return `TEST_ORDER_HASH` so the match branch runs.
    function test_clearOrder_emitsSeaportCancelEmittedOnHashMatch() public {
        _recordValidOrder();
        // Re-stub getOrderHash to return TEST_ORDER_HASH so the
        // reconstruction matches and the cancel emit path fires.
        vm.mockCall(
            seaport,
            abi.encodeWithSelector(ISeaportOrderHash.getOrderHash.selector),
            abi.encode(TEST_ORDER_HASH)
        );
        vm.expectEmit(true, true, false, false);
        emit CollateralListingExecutor.SeaportCancelEmitted(TEST_ORDER_HASH, TEST_LOAN_ID);
        vm.prank(address(diamond));
        executor.clearOrder(TEST_ORDER_HASH);
    }

    /// @dev T-086 #316 — if `Seaport.cancel` itself reverts (a
    ///      future Seaport version change, an unexpected zone-
    ///      caller-gate flip, etc.), the executor catches the
    ///      revert and emits `SeaportCancelSkipped`. The cleanup
    ///      proper still completes — binding is still cleared and
    ///      `OrderCanceled` still fires.
    function test_clearOrder_catchesSeaportCancelRevert() public {
        _recordValidOrder();
        // Same hash-match stub as the happy-cancel test...
        vm.mockCall(
            seaport,
            abi.encodeWithSelector(ISeaportOrderHash.getOrderHash.selector),
            abi.encode(TEST_ORDER_HASH)
        );
        // ...but make `cancel` revert.
        vm.mockCallRevert(
            seaport,
            abi.encodeWithSelector(ISeaportCancel.cancel.selector),
            abi.encode("seaport-cancel-reverted")
        );
        vm.expectEmit(true, true, false, false);
        emit CollateralListingExecutor.SeaportCancelSkipped(TEST_ORDER_HASH, TEST_LOAN_ID);
        vm.prank(address(diamond));
        executor.clearOrder(TEST_ORDER_HASH);
        // And the binding is still cleared regardless.
        (uint96 storedLoanId, , , , , , , , ) = executor.orderContext(TEST_ORDER_HASH);
        assertEq(uint256(storedLoanId), 0);
    }

    // ─── ERC-1271 isValidSignature ──────────────────────────────────────

    function test_isValidSignature_unknownOrder_invalid() public view {
        bytes4 result = executor.isValidSignature(keccak256("nope"), "");
        assertEq(result, bytes4(0xffffffff));
    }

    function test_isValidSignature_revokedConduit_invalid() public {
        _recordValidOrder();
        vm.prank(owner);
        executor.removeApprovedConduit(conduit);
        bytes4 result = executor.isValidSignature(TEST_ORDER_HASH, "");
        assertEq(result, bytes4(0xffffffff));
    }

    function test_isValidSignature_loanNotActive_invalid() public {
        _recordValidOrder();
        IVaipakamPrepayContext.PrepayContext memory c;
        c.status = LibVaipakam.LoanStatus.Settled;
        diamond.setContext(c);
        bytes4 result = executor.isValidSignature(TEST_ORDER_HASH, "");
        assertEq(result, bytes4(0xffffffff));
    }

    function test_isValidSignature_happyPath_returnsMagic() public {
        _recordValidOrder();
        bytes4 result = executor.isValidSignature(TEST_ORDER_HASH, "");
        assertEq(result, IERC1271.isValidSignature.selector);
    }

    // ─── Seaport zone: msg.sender gate ──────────────────────────────────

    function test_authorizeOrder_revertsNotSeaport() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        vm.prank(buyer);
        vm.expectRevert(CollateralListingExecutor.NotSeaport.selector);
        executor.authorizeOrder(p);
    }

    function test_validateOrder_revertsNotSeaport() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        vm.prank(buyer);
        vm.expectRevert(CollateralListingExecutor.NotSeaport.selector);
        executor.validateOrder(p);
    }

    /// @notice #825-r3 (P1) — fill-time re-screen of the CURRENT borrower
    ///         recipient. Clean at post time, flagged before fill → the Seaport
    ///         zone callback aborts the fill (no buyer funds committed).
    function test_authorizeOrder_revertsWhenBorrowerRecipientSanctioned() public {
        _setDefaultContext();
        _recordValidOrder();
        diamond.setSanctioned(borrowerHolder, true);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingRecipient.selector,
                borrowerHolder
            )
        );
        executor.authorizeOrder(p);
    }

    /// @notice #1279 (P1) — the BUYER (Seaport's `fulfiller`) is screened at
    ///         fill time on the loan-keyed branch: a flagged buyer cannot take
    ///         the collateral, from either zone hook.
    function test_authorizeOrder_revertsWhenBuyerSanctioned_loanKeyed() public {
        _setDefaultContext();
        _recordValidOrder();
        diamond.setSanctioned(buyer, true);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingBuyer.selector, buyer
            )
        );
        executor.authorizeOrder(p);

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingBuyer.selector, buyer
            )
        );
        executor.validateOrder(p);
    }

    /// @notice #1279 (P1) — same screen on the offer-keyed (parallel-sale,
    ///         pre-loan) branch, from both zone hooks.
    function test_authorizeOrder_revertsWhenBuyerSanctioned_offerKeyed() public {
        bytes32 h = keccak256("offer-order-sanctioned-buyer");
        _recordOfferOrderAs(h, TEST_OFFER_ID);
        diamond.setSanctioned(buyer, true);

        ZoneParameters memory p = _validOfferZoneParams(h);
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingBuyer.selector, buyer
            )
        );
        executor.authorizeOrder(p);

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingBuyer.selector, buyer
            )
        );
        executor.validateOrder(p);
        assertFalse(diamond.recordProceedsCalled());
    }

    /// @notice #1279 — a clean buyer is unaffected (the unflagged path still
    ///         fills); the screen keys on the fulfiller, not on any recipient.
    function test_fill_offerKeyed_cleanBuyerFills() public {
        bytes32 h = keccak256("offer-order-clean-buyer");
        _recordOfferOrderAs(h, TEST_OFFER_ID);
        diamond.setSanctioned(makeAddr("someoneElse"), true);
        ZoneParameters memory p = _validOfferZoneParams(h);
        _fillOne(p, _amountsOf(p));
        assertTrue(diamond.markConsumedCalled());
    }

    /// @notice #1279 — the fulfiller names another account as the NFT's
    ///         recipient, and that account is flagged: the fill is refused at
    ///         `validateOrder`, after the transfer, on the loan-keyed branch.
    function test_fill_loanKeyed_flaggedNftRecipient_refused() public {
        _recordValidOrder();
        address giftee = makeAddr("giftee");
        ListingCollateral721(collateralAsset).move(giftee, TEST_COLLATERAL_TOKEN_ID);
        diamond.setSanctioned(giftee, true);

        ZoneParameters memory p = _validZoneParams();
        // Before the transfer the zone cannot see the recipient: the
        // authorize hook passes (the fulfiller is clean).
        vm.prank(seaport);
        executor.authorizeOrder(p);

        _etchFillHarness();
        ZoneParameters[] memory orders = new ZoneParameters[](1);
        orders[0] = p;
        uint256[][] memory d = new uint256[][](1);
        d[0] = _amountsOf(p);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingBuyer.selector, giftee
            )
        );
        SeaportFillHarness(seaport).fill(executor, orders, d);
        assertFalse(diamond.finalizeCalled());
    }

    /// @notice #1279 — same post-transfer screen on the offer-keyed branch.
    function test_fill_offerKeyed_flaggedNftRecipient_refused() public {
        bytes32 h = keccak256("offer-order-flagged-giftee");
        _recordOfferOrderAs(h, TEST_OFFER_ID);
        address giftee = makeAddr("giftee");
        ListingCollateral721(collateralAsset).move(giftee, TEST_COLLATERAL_TOKEN_ID);
        diamond.setSanctioned(giftee, true);

        ZoneParameters memory p = _validOfferZoneParams(h);
        _etchFillHarness();
        ZoneParameters[] memory orders = new ZoneParameters[](1);
        orders[0] = p;
        uint256[][] memory d = new uint256[][](1);
        d[0] = _amountsOf(p);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingBuyer.selector, giftee
            )
        );
        SeaportFillHarness(seaport).fill(executor, orders, d);
        assertFalse(diamond.recordProceedsCalled());
    }

    /// @notice #1279 — an unflagged account other than the fulfiller may
    ///         receive the NFT (a gift purchase still fills).
    function test_fill_loanKeyed_cleanNftRecipient_fills() public {
        _recordValidOrder();
        ListingCollateral721(collateralAsset).move(makeAddr("giftee"), TEST_COLLATERAL_TOKEN_ID);
        ZoneParameters memory p = _validZoneParams();
        _fillOne(p, _amountsOf(p));
        assertTrue(diamond.finalizeCalled());
    }

    /// @notice #1279 — ERC-1155 collateral has no owner to read, so the zone
    ///         screens the fulfiller only and does not call the token. Pinned
    ///         so the stated residual stays the actual behaviour.
    function test_fill_offerKeyed_erc1155_screensFulfillerOnly() public {
        bytes32 h = keccak256("offer-order-1155");
        // A code-less address as the token: any call to it would revert.
        address noCode = makeAddr("erc1155NoCode");
        _recordOfferOrderAs1155(h, TEST_OFFER_ID, noCode);
        ZoneParameters memory p = _validOfferZoneParams(h);
        p.offer[0].itemType = ItemType.ERC1155;
        p.offer[0].token = noCode;
        p.offer[0].amount = 1;
        _fillOne(p, _amountsOf(p));
        assertTrue(diamond.markConsumedCalled());
    }

    /// @notice #825-r4 (P1) — fill-time re-screen of the live LENDER recipient
    ///         (`consideration[0]` is paid directly to `pctx.lenderNftOwner`).
    ///         Clean at post time, flagged before fill → fill aborts.
    function test_authorizeOrder_revertsWhenLenderRecipientSanctioned() public {
        _setDefaultContext();
        _recordValidOrder();
        diamond.setSanctioned(lenderHolder, true);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingRecipient.selector,
                lenderHolder
            )
        );
        executor.authorizeOrder(p);
    }

    /// @notice #825-r3 (P1) — fill-time re-screen of a recorded FEE-LEG
    ///         recipient. Clean at post time, flagged before fill → fill aborts.
    function test_authorizeOrder_revertsWhenFeeLegRecipientSanctioned() public {
        _setDefaultContext();
        address flaggedFee = makeAddr("flaggedFeeRecipientFill");
        FeeLeg[] memory legs = new FeeLeg[](1);
        legs[0] = FeeLeg({recipient: flaggedFee, startAmount: 1, endAmount: 1});
        vm.prank(address(diamond));
        executor.recordOrder(
            TEST_ORDER_HASH,
            TEST_LOAN_ID,
            conduit,
            bytes32(0),
            uint256(0),
            uint256(block.timestamp),
            TEST_ASK_PRICE,
            TEST_ASK_PRICE,
            0,
            PREPAY_MODE_FIXED_PRICE,
            legs,
            uint256(0),
            uint256(0)
        );
        diamond.setSanctioned(flaggedFee, true);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.SanctionedListingRecipient.selector,
                flaggedFee
            )
        );
        executor.authorizeOrder(p);
    }

    // ─── Precondition stack (via validateOrder for assertion coverage) ──

    function test_validateOrder_unknownOrder() public {
        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.UnknownOrder.selector, p.orderHash
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_conduitRevoked() public {
        _recordValidOrder();
        vm.prank(owner);
        executor.removeApprovedConduit(conduit);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ConduitNotApproved.selector, conduit
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_loanNotActive() public {
        _recordValidOrder();
        IVaipakamPrepayContext.PrepayContext memory c;
        c.status = LibVaipakam.LoanStatus.Settled;
        diamond.setContext(c);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.LoanNotActive.selector, TEST_LOAN_ID
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_graceExpired() public {
        _recordValidOrder();
        // Default ctx graceEnd was block.timestamp + 30 days at setUp.
        vm.warp(block.timestamp + 31 days);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.GraceExpired.selector, TEST_LOAN_ID
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongOfferCount() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.offer = new SpentItem[](2); // wrong count

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(CollateralListingExecutor.WrongOfferCount.selector, 1, 2)
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongOfferToken() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.offer[0].token = makeAddr("decoyNFT");

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongOfferToken.selector,
                collateralAsset,
                p.offer[0].token
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongOfferIdentifier() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.offer[0].identifier = TEST_COLLATERAL_TOKEN_ID + 1;

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongOfferIdentifier.selector,
                TEST_COLLATERAL_TOKEN_ID,
                TEST_COLLATERAL_TOKEN_ID + 1
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_unsupportedLendingAssetType() public {
        _recordValidOrder();
        IVaipakamPrepayContext.PrepayContext memory c;
        c.status = LibVaipakam.LoanStatus.Active;
        c.assetType = LibVaipakam.AssetType.ERC721; // NFT-rental → unsupported
        c.collateralAssetType = LibVaipakam.AssetType.ERC721;
        c.principalAsset = principalAsset;
        c.collateralAsset = collateralAsset;
        c.collateralTokenId = TEST_COLLATERAL_TOKEN_ID;
        c.collateralQuantity = 1;
        c.graceEnd = block.timestamp + 30 days;
        c.lenderNftOwner = lenderHolder;
        c.borrowerNftOwner = borrowerHolder;
        c.treasury = treasury;
        c.borrowerVault = makeAddr("mockBorrowerVault");
        diamond.setContext(c);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(CollateralListingExecutor.UnsupportedLendingAssetType.selector);
        executor.validateOrder(p);
    }

    function test_validateOrder_lenderShortPaid() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[0].amount = 50e18; // < 100e18 lenderLeg

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.LenderShortPaid.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_treasuryShortPaid() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[1].amount = 0; // < 1e18 treasuryLeg

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.TreasuryShortPaid.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongLenderRecipient() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[0].recipient = payable(buyer); // not lenderHolder

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongLenderRecipient.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongTreasuryRecipient() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[1].recipient = payable(buyer); // not the diamond treasury

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongTreasuryRecipient.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongBorrowerRecipient() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[2].recipient = payable(buyer); // not borrowerHolder

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongBorrowerRecipient.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    // ─── Happy paths ────────────────────────────────────────────────────

    function test_authorizeOrder_happyPath_returnsMagic() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();

        vm.prank(seaport);
        bytes4 result = executor.authorizeOrder(p);
        assertEq(result, ISeaportZone.authorizeOrder.selector);
        // authorizeOrder does NOT call the finalize callback.
        assertFalse(diamond.finalizeCalled());
    }

    function test_validateOrder_happyPath_callsFinalizeAndClears() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();

        // #2440 — through the one-call fill: authorize, every leg arrives in
        // full, validate.
        _fillOne(p, _amountsOf(p));

        assertTrue(diamond.finalizeCalled());
        assertEq(diamond.finalizeLoanId(), TEST_LOAN_ID);
        assertEq(diamond.finalizeCaller(), address(executor));

        // orderContext entry MUST be cleared so a Seaport-validated
        // re-fill on the same hash can't slip through.
        (uint96 storedLoanId, , , , , , , , ) = executor.orderContext(TEST_ORDER_HASH);
        assertEq(uint256(storedLoanId), 0);
    }
    // ─── #2440 — measured arrival of the protocol legs ───────────────────

    function _etchFillHarness() internal {
        vm.etch(seaport, address(new SeaportFillHarness()).code);
    }

    function _amountsOf(ZoneParameters memory p) internal pure returns (uint256[] memory a) {
        a = new uint256[](p.consideration.length);
        for (uint256 i = 0; i < a.length; i++) {
            a[i] = p.consideration[i].amount;
        }
    }

    function _fillOne(ZoneParameters memory p, uint256[] memory delivered) internal {
        ZoneParameters[] memory orders = new ZoneParameters[](1);
        orders[0] = p;
        uint256[][] memory d = new uint256[][](1);
        d[0] = delivered;
        _fill(orders, d);
    }

    function _fill(ZoneParameters[] memory orders, uint256[][] memory delivered) internal {
        _etchFillHarness();
        SeaportFillHarness(seaport).fill(executor, orders, delivered);
    }

    function _recordOrderAs(bytes32 orderHash, uint256 loanId) internal {
        vm.prank(address(diamond));
        executor.recordOrder(
            orderHash,
            loanId,
            conduit,
            bytes32(0),
            uint256(0),
            uint256(block.timestamp),
            TEST_ASK_PRICE
        , TEST_ASK_PRICE, 0, PREPAY_MODE_FIXED_PRICE, _emptyFeeLegs(), uint256(0), uint256(0));
    }

    function test_fill_loanKeyed_lenderLegShort_refused() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        uint256[] memory d = _amountsOf(p);
        d[0] = 109e18; // the lender leg pays 110e18; 1e18 is lost on the way

        _etchFillHarness();
        ZoneParameters[] memory orders = new ZoneParameters[](1);
        orders[0] = p;
        uint256[][] memory dd = new uint256[][](1);
        dd[0] = d;
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ListingLegDeliveryShort.selector,
                TEST_ORDER_HASH, uint256(0), uint256(110e18), uint256(109e18)
            )
        );
        SeaportFillHarness(seaport).fill(executor, orders, dd);
        assertFalse(diamond.finalizeCalled());
    }

    function test_fill_loanKeyed_onlyTheBookedLegIsMeasured() public {
        // The treasury leg is a fee its recipient bears the charge on, and the
        // borrower leg is the seller's own remainder: neither books anyone as
        // paid, so a short arrival there does not stop the sale.
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        uint256[] memory d = _amountsOf(p);
        d[1] = 1e18 - 1;
        d[2] = 4e18;
        _fillOne(p, d);
        assertTrue(diamond.finalizeCalled());
    }

    function test_fill_lenderBuysOwnCollateral_selfPaymentNotMeasured() public {
        // A lender filling the listing of their own loan pays the lender leg to
        // themselves, while their balance falls by the other legs: a rise
        // cannot be read, and the leg books no one else as paid.
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.fulfiller = lenderHolder;
        uint256[] memory d = _amountsOf(p);
        d[0] = 0;
        _fillOne(p, d);
        assertTrue(diamond.finalizeCalled());
    }

    function test_fill_lenderFulfillsCombinedCall_legIsMeasured() public {
        // Codex #2622 r3 — in a call that combines orders (a match, or a batch
        // of available orders) the fulfiller need not be the payer: a lender
        // who matches their own listing against a third party's bid is the
        // fulfiller while the bidder pays. Seaport passes one hash per order
        // there, and the leg is measured, so a short arrival is refused.
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.fulfiller = lenderHolder;
        p.orderHashes = new bytes32[](2);
        p.orderHashes[0] = p.orderHash;
        p.orderHashes[1] = keccak256("third-party-bid");
        uint256[] memory d = _amountsOf(p);
        d[0] = 109e18;

        _etchFillHarness();
        ZoneParameters[] memory orders = new ZoneParameters[](1);
        orders[0] = p;
        uint256[][] memory dd = new uint256[][](1);
        dd[0] = d;
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ListingLegDeliveryShort.selector,
                TEST_ORDER_HASH, uint256(0), uint256(110e18), uint256(109e18)
            )
        );
        SeaportFillHarness(seaport).fill(executor, orders, dd);
        assertFalse(diamond.finalizeCalled());

        // The same combined call with the leg delivered in full settles.
        _fillOne(p, _amountsOf(p));
        assertTrue(diamond.finalizeCalled());
    }

    function test_fill_balanceHeldBeforeAuthorize_isNotArrival() public {
        // A recipient's existing balance never counts: only the rise
        // between the two hooks does.
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        ERC20Mock(principalAsset).mint(lenderHolder, 1_000e18);
        uint256[] memory d = _amountsOf(p);
        d[0] = 0;

        _etchFillHarness();
        ZoneParameters[] memory orders = new ZoneParameters[](1);
        orders[0] = p;
        uint256[][] memory dd = new uint256[][](1);
        dd[0] = d;
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ListingLegDeliveryShort.selector,
                TEST_ORDER_HASH, uint256(0), uint256(110e18), uint256(0)
            )
        );
        SeaportFillHarness(seaport).fill(executor, orders, dd);
    }

    function test_validateOrder_withoutAuthorize_refusedAsUnmeasured() public {
        // A fill whose `authorizeOrder` did not run in this transaction has
        // no base to measure from, and is refused rather than accepted.
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ListingArrivalUnmeasured.selector,
                TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_fill_twoLoanKeyedOrders_sameRecipients_eachNeedsItsOwnArrival() public {
        // Both orders pay the same lender, treasury and borrower (the mock
        // context answers every loan id alike). Seaport authorizes both, then
        // transfers, then validates both: the second must find its own legs
        // above what the first claimed.
        bytes32 hashB = keccak256("test-order-b");
        _recordValidOrder();
        _recordOrderAs(hashB, TEST_LOAN_ID + 1);
        ZoneParameters memory pa = _validZoneParams();
        ZoneParameters memory pb = _validZoneParams();
        pb.orderHash = hashB;

        ZoneParameters[] memory orders = new ZoneParameters[](2);
        orders[0] = pa;
        orders[1] = pb;
        uint256[][] memory dd = new uint256[][](2);
        dd[0] = _amountsOf(pa);
        dd[1] = new uint256[](3); // the second order's legs never arrive
        _etchFillHarness();
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ListingLegDeliveryShort.selector,
                hashB, uint256(0), uint256(110e18), uint256(0)
            )
        );
        SeaportFillHarness(seaport).fill(executor, orders, dd);

        // Both arriving in full settles both.
        dd[1] = _amountsOf(pb);
        SeaportFillHarness(seaport).fill(executor, orders, dd);
        (uint96 a, , , , , , , , ) = executor.orderContext(TEST_ORDER_HASH);
        (uint96 b, , , , , , , , ) = executor.orderContext(hashB);
        assertEq(uint256(a) + uint256(b), 0);
    }

    // ── Offer-keyed branch: the Diamond is the proceeds recipient ──

    uint96 internal constant TEST_OFFER_ID = 77;
    uint192 internal constant TEST_OFFER_ASK = 50e18;

    function _recordOfferOrderAs(bytes32 orderHash, uint96 offerId) internal {
        OfferContext memory c;
        c.offerId = offerId;
        c.conduit = conduit;
        c.startTime = uint64(block.timestamp);
        c.askPrice = TEST_OFFER_ASK;
        c.endTime = uint64(block.timestamp + 1 days);
        c.principalAsset = principalAsset;
        c.mode = PREPAY_MODE_FIXED_PRICE;
        c.borrowerVault = makeAddr("mockBorrowerVault");
        c.borrowerWallet = borrowerHolder;
        c.collateralAsset = collateralAsset;
        c.collateralAssetType = uint8(LibVaipakam.AssetType.ERC721);
        c.collateralTokenId = TEST_COLLATERAL_TOKEN_ID;
        c.collateralQuantity = 1;
        vm.prank(address(diamond));
        executor.recordOfferOrder(orderHash, c, _emptyFeeLegs());
    }

    /// @dev #1279 — an offer-keyed order on ERC-1155 collateral at `token`.
    function _recordOfferOrderAs1155(bytes32 orderHash, uint96 offerId, address token) internal {
        OfferContext memory c;
        c.offerId = offerId;
        c.conduit = conduit;
        c.startTime = uint64(block.timestamp);
        c.askPrice = TEST_OFFER_ASK;
        c.endTime = uint64(block.timestamp + 1 days);
        c.principalAsset = principalAsset;
        c.mode = PREPAY_MODE_FIXED_PRICE;
        c.borrowerVault = makeAddr("mockBorrowerVault");
        c.borrowerWallet = borrowerHolder;
        c.collateralAsset = token;
        c.collateralAssetType = uint8(LibVaipakam.AssetType.ERC1155);
        c.collateralTokenId = TEST_COLLATERAL_TOKEN_ID;
        c.collateralQuantity = 1;
        vm.prank(address(diamond));
        executor.recordOfferOrder(orderHash, c, _emptyFeeLegs());
    }

    function _validOfferZoneParams(bytes32 orderHash) internal returns (ZoneParameters memory p) {
        p.orderHash = orderHash;
        p.fulfiller = buyer;
        p.offerer = makeAddr("mockBorrowerVault");
        p.offer = new SpentItem[](1);
        p.offer[0] = SpentItem({
            itemType: ItemType.ERC721,
            token: collateralAsset,
            identifier: TEST_COLLATERAL_TOKEN_ID,
            amount: 1
        });
        p.consideration = new ReceivedItem[](1);
        p.consideration[0] = ReceivedItem({
            itemType: ItemType.ERC20,
            token: principalAsset,
            identifier: 0,
            amount: TEST_OFFER_ASK,
            recipient: payable(address(diamond))
        });
        p.startTime = block.timestamp;
        p.endTime = block.timestamp + 1 days;
    }

    function test_fill_offerKeyed_fullArrival_recordsProceeds() public {
        bytes32 h = keccak256("offer-order");
        _recordOfferOrderAs(h, TEST_OFFER_ID);
        ZoneParameters memory p = _validOfferZoneParams(h);
        _fillOne(p, _amountsOf(p));
        assertTrue(diamond.recordProceedsCalled());
        assertEq(diamond.recordProceedsAmount(), TEST_OFFER_ASK);
        assertTrue(diamond.markConsumedCalled());
    }

    function test_fill_offerKeyed_proceedsShort_refused() public {
        bytes32 h = keccak256("offer-order");
        _recordOfferOrderAs(h, TEST_OFFER_ID);
        ZoneParameters memory p = _validOfferZoneParams(h);
        uint256[] memory d = _amountsOf(p);
        d[0] = TEST_OFFER_ASK - 1e18;

        _etchFillHarness();
        ZoneParameters[] memory orders = new ZoneParameters[](1);
        orders[0] = p;
        uint256[][] memory dd = new uint256[][](1);
        dd[0] = d;
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ListingLegDeliveryShort.selector,
                h, uint256(0), uint256(TEST_OFFER_ASK), uint256(TEST_OFFER_ASK - 1e18)
            )
        );
        SeaportFillHarness(seaport).fill(executor, orders, dd);
        assertFalse(diamond.recordProceedsCalled());
    }

    function test_fill_twoOfferKeyedOrders_settlementOutflowIsNotReadAsArrival() public {
        // The first fill's settlement pays its proceeds onward out of the
        // Diamond before the second fill is checked. The second must still be
        // measured against its own arrival: neither refused for the first
        // one's outflow, nor credited with it.
        diamond.setForwardProceedsTo(makeAddr("borrowerVaultSink"));
        bytes32 h1 = keccak256("offer-order-1");
        bytes32 h2 = keccak256("offer-order-2");
        _recordOfferOrderAs(h1, TEST_OFFER_ID);
        _recordOfferOrderAs(h2, TEST_OFFER_ID + 1);

        ZoneParameters[] memory orders = new ZoneParameters[](2);
        orders[0] = _validOfferZoneParams(h1);
        orders[1] = _validOfferZoneParams(h2);
        uint256[][] memory dd = new uint256[][](2);
        dd[0] = _amountsOf(orders[0]);
        dd[1] = _amountsOf(orders[1]);
        _fill(orders, dd);
        assertEq(IERC20(principalAsset).balanceOf(makeAddr("borrowerVaultSink")), 2 * uint256(TEST_OFFER_ASK));

        // Second order short: refused, although the Diamond's balance briefly
        // held the first order's proceeds.
        _recordOfferOrderAs(keccak256("offer-order-3"), TEST_OFFER_ID + 2);
        _recordOfferOrderAs(keccak256("offer-order-4"), TEST_OFFER_ID + 3);
        orders[0] = _validOfferZoneParams(keccak256("offer-order-3"));
        orders[1] = _validOfferZoneParams(keccak256("offer-order-4"));
        dd[1][0] = TEST_OFFER_ASK - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ListingLegDeliveryShort.selector,
                keccak256("offer-order-4"), uint256(0), uint256(TEST_OFFER_ASK), uint256(TEST_OFFER_ASK - 1)
            )
        );
        SeaportFillHarness(seaport).fill(executor, orders, dd);
    }

    /// @dev Round-5 Block A (#313) — most executor tests don't care
    ///      about the new feeLegs arg; this helper supplies an empty
    ///      array for back-compat with the pre-#313 call shape.
    function _emptyFeeLegs() internal pure returns (FeeLeg[] memory) {
        return new FeeLeg[](0);
    }

}
