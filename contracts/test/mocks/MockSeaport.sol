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

    // ─── T-086 Round-6 / Block D (#345) — atomic-match-flow stubs ──

    /// @dev Per-orderHash cancelled flag — test-controlled. Atomic
    ///      facet calls `getOrderStatus` to early-reject cancelled
    ///      bidder offers; tests can flip this to drive that branch.
    mapping(bytes32 => bool) private _cancelled;

    /// @dev Per-orderHash {totalFilled, totalSize}. For fresh
    ///      off-chain-signed offers BOTH are 0 (Seaport's actual
    ///      behaviour for orders never validated/filled on-chain).
    ///      The atomic facet's check is `totalSize != 0 &&
    ///      totalFilled >= totalSize`, so the default-zero pair
    ///      passes through naturally.
    mapping(bytes32 => uint256) private _filled;
    mapping(bytes32 => uint256) private _size;

    function setCancelled(bytes32 orderHash, bool flag) external {
        _cancelled[orderHash] = flag;
    }

    function setFilled(bytes32 orderHash, uint256 filled, uint256 size) external {
        _filled[orderHash] = filled;
        _size[orderHash] = size;
    }

    /// @notice Match the `ISeaportMatch.getOrderStatus` shape.
    function getOrderStatus(bytes32 orderHash)
        external
        view
        returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)
    {
        // isValidated is the "the order has been pre-validated
        // on-chain via Seaport.validate" flag. For off-chain-signed
        // offers it's false; the atomic facet doesn't read this.
        return (false, _cancelled[orderHash], _filled[orderHash], _size[orderHash]);
    }
}
