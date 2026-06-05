// test/mocks/MockListingExecutorRecorder.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IListingExecutorRecorder} from "../../src/seaport/IListingExecutorRecorder.sol";
import {FeeLeg, OfferContext} from "../../src/seaport/PrepayTypes.sol";

/**
 * @title MockListingExecutorRecorder
 * @notice Minimal stand-in for `CollateralListingExecutor` in
 *         `NFTPrepayListingFacet` unit tests. Implements
 *         {IListingExecutorRecorder} surface only.
 *
 *         Records every call so the test can assert the facet
 *         issued the expected `recordOrder` / `clearOrder` calls
 *         with the right arguments — without standing up a full
 *         Seaport + UUPS-proxy + governance executor.
 */
contract MockListingExecutorRecorder is IListingExecutorRecorder {
    /// @dev T-086 #316 + Round-5 Block A (#313) + Round-5 Block B
    ///      (#309) — mirrors the recorder's multi-mode shape so
    ///      facet tests can assert the diamond passed every sign-
    ///      time input alongside the mode tag + Dutch fields.
    struct RecordedCall {
        bytes32 orderHash;
        uint256 loanId;
        address conduit;
        bytes32 conduitKey;
        uint256 salt;
        uint256 startTime;
        uint256 askPrice;
        uint256 endAskPrice;
        uint256 auctionEndTime;
        uint8 mode;
        FeeLeg[] feeLegs;
        // T-086 Round-7 (Issue #355) — signed-leg snapshot fields so
        // tests can assert each post path forwarded the new args.
        uint256 signedLenderAmount;
        uint256 signedTreasuryAmount;
    }

    /// @notice T-086 Round-7 (Issue #355) — mirrors the executor's
    ///         `_orderProtocolLegs` mapping so tests that exercise the
    ///         auto-list-at-floor B-cond-2 read path can stage a
    ///         `(lender, treasury)` snapshot independently of an actual
    ///         `recordOrder` call.
    struct SignedProtocolLegs {
        uint128 lender;
        uint128 treasury;
    }
    mapping(bytes32 => SignedProtocolLegs) internal _orderProtocolLegs;

    RecordedCall[] internal _recordOrderCalls;
    bytes32[] public clearOrderCalls;

    mapping(address => bool) private _approvedConduits;

    /// @notice #306 — the real `CollateralListingExecutor` exposes
    ///         `seaport` as a public state variable; the diamond's
    ///         `postPrepayListing` reads it to derive the canonical
    ///         orderHash via Seaport's view. Mirror the field so
    ///         `CollateralListingExecutor(address(mock)).seaport()`
    ///         resolves in tests.
    address public seaport;

    // ─── Test-side configuration (NOT in the real executor) ─────────────

    function setApprovedConduit(address conduit, bool approved) external {
        _approvedConduits[conduit] = approved;
    }

    function setSeaport(address newSeaport) external {
        seaport = newSeaport;
    }

    // ─── IListingExecutorRecorder ───────────────────────────────────────

    function recordOrder(
        bytes32 orderHash,
        uint256 loanId,
        address conduit,
        bytes32 conduitKey,
        uint256 salt,
        uint256 startTime,
        uint256 askPrice,
        uint256 endAskPrice,
        uint256 auctionEndTime,
        uint8 mode,
        FeeLeg[] calldata feeLegs,
        uint256 signedLenderAmount,
        uint256 signedTreasuryAmount
    ) external override {
        // Push an empty entry first, then copy each FeeLeg field
        // explicitly — Solidity rejects a direct
        // `_recordOrderCalls.push(RecordedCall({…, feeLegs: feeLegs}))`
        // assignment from calldata into the storage struct's dynamic
        // array field. Per-element copy is the canonical pattern.
        RecordedCall storage call = _recordOrderCalls.push();
        call.orderHash = orderHash;
        call.loanId = loanId;
        call.conduit = conduit;
        call.conduitKey = conduitKey;
        call.salt = salt;
        call.startTime = startTime;
        call.askPrice = askPrice;
        call.endAskPrice = endAskPrice;
        call.auctionEndTime = auctionEndTime;
        call.mode = mode;
        for (uint256 i = 0; i < feeLegs.length; ) {
            call.feeLegs.push(feeLegs[i]);
            unchecked { ++i; }
        }
        call.signedLenderAmount = signedLenderAmount;
        call.signedTreasuryAmount = signedTreasuryAmount;

        // T-086 Round-7 (Issue #355) — mirror the executor's parallel
        // snapshot so `orderProtocolLegs(orderHash)` reads from the
        // same source the production executor uses.
        _orderProtocolLegs[orderHash] = SignedProtocolLegs({
            lender: uint128(signedLenderAmount),
            treasury: uint128(signedTreasuryAmount)
        });
    }

    function clearOrder(bytes32 orderHash) external override {
        clearOrderCalls.push(orderHash);
        // T-086 Round-7 (Issue #355) — match the executor's clear path.
        delete _orderProtocolLegs[orderHash];
    }

    function approvedConduits(address conduit) external view override returns (bool) {
        return _approvedConduits[conduit];
    }

    /// @inheritdoc IListingExecutorRecorder
    function orderProtocolLegs(bytes32 orderHash) external view override returns (uint128 lender, uint128 treasury) {
        SignedProtocolLegs storage legs = _orderProtocolLegs[orderHash];
        return (legs.lender, legs.treasury);
    }

    /// @notice T-086 Round-7 (Issue #355) — test-only setter so unit
    ///         tests can stage a `(lender, treasury)` snapshot
    ///         independently of running a full `recordOrder` flow.
    function setOrderProtocolLegs(bytes32 orderHash, uint128 lender, uint128 treasury) external {
        _orderProtocolLegs[orderHash] = SignedProtocolLegs({
            lender: lender,
            treasury: treasury
        });
    }

    /// @notice Round-5 Block B (#309) post-merge polish — Codex P2
    ///         (mode-aware cleanup): per-orderHash stub for the
    ///         real executor's `orderContext` getter. Defaults to
    ///         the FIXED-PRICE sentinel (mode=0, auctionEndTime=0)
    ///         so unit tests of the cancel path keep falling
    ///         through to the existing grace-window logic. Tests
    ///         that need to exercise the Dutch cleanup branch
    ///         configure the per-orderHash mode + auctionEndTime
    ///         via {setOrderContextMode}.
    struct OrderContextStub {
        uint64 auctionEndTime;
        uint8 mode;
    }
    mapping(bytes32 => OrderContextStub) internal _orderContextStubs;

    function setOrderContextMode(
        bytes32 orderHash,
        uint8 mode,
        uint64 auctionEndTime
    ) external {
        _orderContextStubs[orderHash] = OrderContextStub({
            auctionEndTime: auctionEndTime,
            mode: mode
        });
    }

    function orderContext(bytes32 orderHash)
        external
        view
        returns (
            uint96 loanId,
            address conduit,
            bytes32 conduitKey,
            uint256 salt,
            uint64 startTime,
            uint192 askPrice,
            uint128 endAskPrice,
            uint64 auctionEndTime,
            uint8 mode
        )
    {
        OrderContextStub memory stub = _orderContextStubs[orderHash];
        return (0, address(0), bytes32(0), 0, 0, 0, 0, stub.auctionEndTime, stub.mode);
    }

    // ─── Test inspection helpers ───────────────────────────────────────

    function recordCallCount() external view returns (uint256) {
        return _recordOrderCalls.length;
    }

    function clearCallCount() external view returns (uint256) {
        return clearOrderCalls.length;
    }

    function lastRecordedOrderHash() external view returns (bytes32) {
        return _recordOrderCalls[_recordOrderCalls.length - 1].orderHash;
    }

    function lastClearedOrderHash() external view returns (bytes32) {
        return clearOrderCalls[clearOrderCalls.length - 1];
    }

    /// @notice Read accessor for a recorded call at `idx` — Solidity's
    ///         auto-generated getter for a struct array containing a
    ///         dynamic-type field can't return the full struct in
    ///         one call. This helper returns the whole RecordedCall.
    function recordedCallAt(uint256 idx) external view returns (RecordedCall memory) {
        return _recordOrderCalls[idx];
    }

    // ─── T-086 Round-7 (Issue #355) — auto-list reads ───────────────────

    function orderFeeLegs(bytes32 orderHash)
        external
        view
        override
        returns (FeeLeg[] memory)
    {
        for (uint256 i = _recordOrderCalls.length; i > 0; ) {
            unchecked { --i; }
            if (_recordOrderCalls[i].orderHash == orderHash) {
                return _recordOrderCalls[i].feeLegs;
            }
        }
        return new FeeLeg[](0);
    }

    /// @notice Per-order context staging used by the auto-list path's
    ///         B-cond gates. Tests stage via {setOrderContext} then
    ///         assert on the facet's rotation behavior; if not
    ///         staged, falls back to the most recent matching
    ///         `recordOrder` call so post-then-read tests don't need
    ///         an explicit staging step.
    struct StoredOrderContext {
        uint8 mode;
        uint192 askPrice;
        uint128 endAskPrice;
        uint64 startTime;
        uint64 auctionEndTime;
        bool isSet;
    }
    mapping(bytes32 => StoredOrderContext) internal _orderContexts;

    function orderContextRead(bytes32 orderHash)
        external
        view
        override
        returns (
            uint8 mode,
            uint192 askPrice,
            uint128 endAskPrice,
            uint64 startTime,
            uint64 auctionEndTime
        )
    {
        StoredOrderContext storage ctx = _orderContexts[orderHash];
        if (ctx.isSet) {
            return (ctx.mode, ctx.askPrice, ctx.endAskPrice, ctx.startTime, ctx.auctionEndTime);
        }
        for (uint256 i = _recordOrderCalls.length; i > 0; ) {
            unchecked { --i; }
            if (_recordOrderCalls[i].orderHash == orderHash) {
                RecordedCall storage rc = _recordOrderCalls[i];
                return (
                    rc.mode,
                    uint192(rc.askPrice),
                    uint128(rc.endAskPrice),
                    uint64(rc.startTime),
                    uint64(rc.auctionEndTime)
                );
            }
        }
        return (0, 0, 0, 0, 0);
    }

    function setOrderContext(
        bytes32 orderHash,
        uint8 mode,
        uint192 askPrice,
        uint128 endAskPrice,
        uint64 startTime,
        uint64 auctionEndTime
    ) external {
        _orderContexts[orderHash] = StoredOrderContext({
            mode: mode,
            askPrice: askPrice,
            endAskPrice: endAskPrice,
            startTime: startTime,
            auctionEndTime: auctionEndTime,
            isSet: true
        });
    }

    /// @inheritdoc IListingExecutorRecorder
    /// @notice T-086 Round-7 follow-up (Codex round-12 P2 #1) —
    ///         returns the conduit + key from the most recent matching
    ///         `recordOrder` call (or zeros for an unknown orderHash).
    function orderContextConduit(bytes32 orderHash)
        external
        view
        override
        returns (address conduit, bytes32 conduitKey)
    {
        for (uint256 i = _recordOrderCalls.length; i > 0; ) {
            unchecked { --i; }
            if (_recordOrderCalls[i].orderHash == orderHash) {
                return (_recordOrderCalls[i].conduit, _recordOrderCalls[i].conduitKey);
            }
        }
        return (address(0), bytes32(0));
    }

    // ─── T-086 Round-8 (#358) — offer-keyed mock surface ───────────────

    /// @dev Captured calls into `recordOfferOrder` (Round-8 test
    ///      harness counterpart to `_recordOrderCalls` above).
    struct RecordOfferOrderCall {
        bytes32 orderHash;
        OfferContext ctx;
        FeeLeg[] feeLegs;
    }
    RecordOfferOrderCall[] internal _recordOfferOrderCalls;
    bytes32[] public clearOfferOrderCalls;

    function recordOfferOrder(
        bytes32 orderHash,
        OfferContext calldata ctx,
        FeeLeg[] calldata feeLegs
    ) external override {
        RecordOfferOrderCall storage c = _recordOfferOrderCalls.push();
        c.orderHash = orderHash;
        c.ctx = ctx;
        for (uint256 i = 0; i < feeLegs.length; ) {
            c.feeLegs.push(feeLegs[i]);
            unchecked { ++i; }
        }
    }

    function clearOfferOrder(bytes32 orderHash) external override {
        clearOfferOrderCalls.push(orderHash);
    }

    /// @inheritdoc IListingExecutorRecorder
    function offerFeeLegs(bytes32 orderHash)
        external
        view
        override
        returns (FeeLeg[] memory)
    {
        for (uint256 i = _recordOfferOrderCalls.length; i > 0; ) {
            unchecked { --i; }
            if (_recordOfferOrderCalls[i].orderHash == orderHash) {
                return _recordOfferOrderCalls[i].feeLegs;
            }
        }
        return new FeeLeg[](0);
    }

    /// @notice Test inspection helper for the offer-keyed record path.
    function recordOfferOrderCallCount() external view returns (uint256) {
        return _recordOfferOrderCalls.length;
    }

    /// @notice Read the recorded OfferContext + feeLegs at index.
    function recordedOfferOrderAt(uint256 idx)
        external
        view
        returns (RecordOfferOrderCall memory)
    {
        return _recordOfferOrderCalls[idx];
    }
}
