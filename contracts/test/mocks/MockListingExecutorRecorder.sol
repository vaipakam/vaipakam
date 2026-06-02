// test/mocks/MockListingExecutorRecorder.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IListingExecutorRecorder} from "../../src/seaport/IListingExecutorRecorder.sol";
import {FeeLeg} from "../../src/seaport/PrepayTypes.sol";

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
    /// @dev T-086 #316 + Round-5 Block A (#313) — extended to mirror
    ///      the recorder's new shape so facet tests can assert the
    ///      diamond passed the sign-time inputs (conduitKey, salt,
    ///      startTime, askPrice, feeLegs) alongside (orderHash,
    ///      loanId, conduit).
    struct RecordedCall {
        bytes32 orderHash;
        uint256 loanId;
        address conduit;
        bytes32 conduitKey;
        uint256 salt;
        uint256 startTime;
        uint256 askPrice;
        FeeLeg[] feeLegs;
    }

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
        FeeLeg[] calldata feeLegs
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
        for (uint256 i = 0; i < feeLegs.length; ) {
            call.feeLegs.push(feeLegs[i]);
            unchecked { ++i; }
        }
    }

    function clearOrder(bytes32 orderHash) external override {
        clearOrderCalls.push(orderHash);
    }

    function approvedConduits(address conduit) external view override returns (bool) {
        return _approvedConduits[conduit];
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
}
