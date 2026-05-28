// test/mocks/MockSeaport.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {
    ISeaportOrderHash,
    OrderComponents
} from "../../src/seaport/ISeaportOrderHash.sol";

/**
 * @title MockSeaport
 * @notice Minimal Seaport stand-in for unit tests. Implements just
 *         the three views the diamond needs: `getOrderHash`,
 *         `getCounter`, `conduitController`. The on-chain Seaport
 *         computes `getOrderHash` via EIP-712 typed-data hashing;
 *         this mock uses `keccak256(abi.encode(components))` so the
 *         result is deterministic per-input but NOT the same as
 *         what real Seaport would return. Sufficient for tests
 *         that need a stable hash to verify against (`postPrepayListing`
 *         returns the hash; tests check it was stored correctly).
 */
contract MockSeaport is ISeaportOrderHash {
    address public override conduitController;

    /// @dev Per-offerer counter. The diamond reads this to derive
    ///      a fresh orderHash on every post / update — bumping
    ///      after a post would invalidate any uncalled hashes.
    mapping(address => uint256) private _counter;

    constructor(address _conduitController) {
        conduitController = _conduitController;
    }

    function getOrderHash(OrderComponents calldata order)
        external
        pure
        override
        returns (bytes32)
    {
        // Deterministic per-input hash for tests. NOT EIP-712-
        // compliant — real Seaport uses typed-data hashing. The
        // diamond's tests only care that the hash is stable per
        // input + non-zero.
        return keccak256(abi.encode(order));
    }

    function getCounter(address offerer)
        external
        view
        override
        returns (uint256)
    {
        return _counter[offerer];
    }

    // ─── Test-side helpers ──────────────────────────────────────────

    function bumpCounter(address offerer) external {
        _counter[offerer] += 1;
    }
}
