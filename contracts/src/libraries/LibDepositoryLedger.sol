// src/libraries/LibDepositoryLedger.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibDepositoryLedger
 * @notice The depository ledger: what of each asset in a user's vault is the
 *         user's to take out through `VaultDepositoryFacet.withdrawFromVault`.
 * @dev    A vault holds two kinds of balance side by side. One is the
 *         owner's: what they deposited or adopted, and payments the protocol
 *         made to them that stayed in the vault (credited to a protected
 *         account's vault, kept there while it is locked, or a queued payout
 *         that was cancelled). The other is purpose-bound: an offer's escrow,
 *         a loan's collateral or rental prepayment, the NFT a lender has lent
 *         out, a claim owed to whoever now holds a position NFT, a reserve.
 *         The tracked ledger counts both, so it cannot by itself say which
 *         part the owner may take.
 *
 *         This ledger counts only the first kind, and the depository withdraw
 *         is bounded by `min(this ledger, tracked − liens − earmark)`. A
 *         purpose-bound balance never enters it, so it stays out of the
 *         withdraw's reach whether or not some lifecycle path liened it: the
 *         lien model was built to protect the routes that existed before the
 *         depository, and only VPFI had a user-facing exit then, so many
 *         purpose-bound balances in other assets carry no lien.
 *
 *         Credits: a depository deposit, an adoption, a payment credited to
 *         a protected account's vault, a payout kept in a locked vault, a
 *         cancelled queued payout. Debits: a depository withdraw (paid now
 *         or queued), and the owner spending free vault balance through
 *         another route (a vault-backed signed offer, the part of an
 *         auto-extension charge drawn beyond its reserve), which is taken
 *         from this ledger first. VPFI spent from the vault (an unstake, a
 *         fee paid in VPFI) is not debited here: every VPFI balance owed to
 *         someone else was already reserved, because VPFI always had an
 *         exit, so a stale VPFI figure can reach only the owner's own free
 *         VPFI.
 *
 *         Written only through this library; storage is
 *         `LibVaipakam.Storage.depositoryHolding`, with the per-owner asset
 *         list `depositoryAssets` / `depositoryAssetListed`.
 */
library LibDepositoryLedger {
    /// @notice A depository withdraw asked for more than the ledger holds.
    ///         The caller bounds the request by {withdrawable} first, so
    ///         this is an accounting fault, never an expected refusal.
    error DepositoryHoldingExceeded(uint256 requested, uint256 holding);

    /// @notice The owner's depository holding of `asset` / `tokenId`.
    function holding(address user, address asset, uint256 tokenId) internal view returns (uint256) {
        return LibVaipakam.storageSlot().depositoryHolding[user][asset][tokenId];
    }

    /// @notice What the depository withdraw may take now: the depository
    ///         holding, never more than `free` (the tracked holding minus
    ///         liens minus earmark, capped at what the vault holds).
    function withdrawable(address user, address asset, uint256 tokenId, uint256 free)
        internal
        view
        returns (uint256)
    {
        uint256 h = holding(user, asset, tokenId);
        return h < free ? h : free;
    }

    /// @notice Credit `amount` to the owner's depository holding.
    ///         The first credit of `asset` for `user` also lists it in
    ///         `depositoryAssets`, so a deposited asset no loan or offer
    ///         names can still be found.
    function credit(address user, address asset, uint256 tokenId, uint256 amount) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.depositoryHolding[user][asset][tokenId] += amount;
        if (!s.depositoryAssetListed[user][asset]) {
            s.depositoryAssetListed[user][asset] = true;
            s.depositoryAssets[user].push(asset);
        }
    }

    /// @notice A page of the asset contracts ever credited to `user`'s
    ///         depository holding, in first-credit order, and the list's
    ///         length. An asset stays listed after its holding returns to
    ///         zero.
    function assets(address user, uint256 offset, uint256 limit)
        internal
        view
        returns (address[] memory page, uint256 total)
    {
        address[] storage all = LibVaipakam.storageSlot().depositoryAssets[user];
        total = all.length;
        if (offset >= total) return (new address[](0), total);
        uint256 end = total - offset < limit ? total : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = all[i];
        }
    }

    /// @notice Debit a depository withdraw. Checked: the caller has bounded
    ///         `amount` by {withdrawable}.
    function debit(address user, address asset, uint256 tokenId, uint256 amount) internal {
        mapping(uint256 => uint256) storage m = LibVaipakam.storageSlot().depositoryHolding[user][asset];
        uint256 h = m[tokenId];
        if (amount > h) revert DepositoryHoldingExceeded(amount, h);
        unchecked {
            m[tokenId] = h - amount;
        }
    }

    /// @notice The owner spent `amount` of free vault balance through
    ///         another route; take it from the depository holding first
    ///         (saturating: what the holding does not cover came from the
    ///         owner's other free balance).
    function spend(address user, address asset, uint256 tokenId, uint256 amount) internal {
        mapping(uint256 => uint256) storage m = LibVaipakam.storageSlot().depositoryHolding[user][asset];
        uint256 h = m[tokenId];
        if (h == 0 || amount == 0) return;
        unchecked {
            m[tokenId] = amount < h ? h - amount : 0;
        }
    }
}
