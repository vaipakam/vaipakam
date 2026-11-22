// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibBatchCredit
 * @author Vaipakam Developer Team
 * @notice "And withdraw" (payout rule, owner decision 2026-11-19,
 *         PayoutDestinationRuleDesign.md §4.4). While a batch
 *         (`MulticallFacet.multicall`) is open, the free-balance ledger keeps,
 *         per asset, what it credited to the batch's caller less what it
 *         debited or spent from it, so the batch's last item can withdraw
 *         exactly what the batch released (`VaultDepositoryFacet.
 *         withdrawCredited`): a claim's amount moves with per-second interest,
 *         a part-filled offer returns less than was signed for, a
 *         fee-charging token delivers less than was sent.
 * @dev    Transient storage only. The figure SIZES a withdrawal and grants
 *         nothing: the withdrawal runs every check of the ordinary Withdraw.
 *         Each batch takes a new epoch, part of every figure's key, so a
 *         second batch in the same transaction never reads the first one's
 *         figures; {close} ends the batch, and the transaction's end clears
 *         everything.
 */
library LibBatchCredit {
    bytes32 private constant OWNER = keccak256("vaipakam.batchCredit.owner");
    bytes32 private constant EPOCH = keccak256("vaipakam.batchCredit.epoch");
    bytes32 private constant FIGURE = keccak256("vaipakam.batchCredit.figure");

    /// @notice A batch is already open; batches do not nest.
    error BatchAlreadyOpen();

    /// @notice Open a batch for `batchCaller`, under a new epoch.
    function open(address batchCaller) internal {
        bytes32 ownerSlot = OWNER;
        bytes32 epochSlot = EPOCH;
        address cur;
        assembly ("memory-safe") {
            cur := tload(ownerSlot)
        }
        if (cur != address(0)) revert BatchAlreadyOpen();
        assembly ("memory-safe") {
            tstore(epochSlot, add(tload(epochSlot), 1))
            tstore(ownerSlot, batchCaller)
        }
    }

    /// @notice End the open batch.
    function close() internal {
        bytes32 ownerSlot = OWNER;
        assembly ("memory-safe") {
            tstore(ownerSlot, 0)
        }
    }

    /// @notice The open batch's caller, or zero outside a batch.
    function owner() internal view returns (address a) {
        bytes32 ownerSlot = OWNER;
        assembly ("memory-safe") {
            a := tload(ownerSlot)
        }
    }

    /// @notice What the open batch credited to its caller in `asset` /
    ///         `tokenId`, net of what it debited or spent; zero outside a batch.
    function credited(address asset, uint256 tokenId) internal view returns (uint256 v) {
        address who = owner();
        if (who == address(0)) return 0;
        bytes32 key = _key(who, asset, tokenId);
        assembly ("memory-safe") {
            v := tload(key)
        }
    }

    /// @notice The free-balance ledger credited `amount` to `user`: counted
    ///         when `user` is the open batch's caller.
    function onCredit(address user, address asset, uint256 tokenId, uint256 amount) internal {
        if (amount == 0 || user == address(0) || user != owner()) return;
        bytes32 key = _key(user, asset, tokenId);
        assembly ("memory-safe") {
            tstore(key, add(tload(key), amount))
        }
    }

    /// @notice The free-balance ledger debited or spent `amount` of `user`'s:
    ///         the open batch's figure falls by it, never below zero.
    function onDebit(address user, address asset, uint256 tokenId, uint256 amount) internal {
        if (amount == 0 || user == address(0) || user != owner()) return;
        bytes32 key = _key(user, asset, tokenId);
        assembly ("memory-safe") {
            let v := tload(key)
            switch gt(amount, v)
            case 1 { tstore(key, 0) }
            default { tstore(key, sub(v, amount)) }
        }
    }

    function _key(address user, address asset, uint256 tokenId) private view returns (bytes32 key) {
        bytes32 epochSlot = EPOCH;
        uint256 epoch;
        assembly ("memory-safe") {
            epoch := tload(epochSlot)
        }
        key = keccak256(abi.encode(FIGURE, epoch, user, asset, tokenId));
    }
}
