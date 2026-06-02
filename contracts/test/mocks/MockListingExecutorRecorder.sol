// test/mocks/MockListingExecutorRecorder.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IListingExecutorRecorder} from "../../src/seaport/IListingExecutorRecorder.sol";

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
    /// @dev T-086 #316 — extended to mirror the recorder's new
    ///      shape so facet tests can assert the diamond passed the
    ///      sign-time inputs (conduitKey, salt, startTime, askPrice)
    ///      alongside (orderHash, loanId, conduit).
    struct RecordedCall {
        bytes32 orderHash;
        uint256 loanId;
        address conduit;
        bytes32 conduitKey;
        uint256 salt;
        uint256 startTime;
        uint256 askPrice;
    }

    RecordedCall[] public recordOrderCalls;
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
        uint256 askPrice
    ) external override {
        recordOrderCalls.push(RecordedCall({
            orderHash: orderHash,
            loanId: loanId,
            conduit: conduit,
            conduitKey: conduitKey,
            salt: salt,
            startTime: startTime,
            askPrice: askPrice
        }));
    }

    function clearOrder(bytes32 orderHash) external override {
        clearOrderCalls.push(orderHash);
    }

    function approvedConduits(address conduit) external view override returns (bool) {
        return _approvedConduits[conduit];
    }

    // ─── Test inspection helpers ───────────────────────────────────────

    function recordCallCount() external view returns (uint256) {
        return recordOrderCalls.length;
    }

    function clearCallCount() external view returns (uint256) {
        return clearOrderCalls.length;
    }

    function lastRecordedOrderHash() external view returns (bytes32) {
        return recordOrderCalls[recordOrderCalls.length - 1].orderHash;
    }

    function lastClearedOrderHash() external view returns (bytes32) {
        return clearOrderCalls[clearOrderCalls.length - 1];
    }
}
