// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibProtectedAccount} from "./LibProtectedAccount.sol";
import {LibDepositoryLedger} from "./LibDepositoryLedger.sol";
import {LibReadyBalance} from "./LibReadyBalance.sol";
import {LibVaultOutflow} from "./LibVaultOutflow.sol";
import {LibPausable} from "./LibPausable.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";

/**
 * @title  LibVaultWithdraw
 * @author Vaipakam Developer Team
 * @notice THE one Withdraw (payout rule, owner decision 2026-11-19,
 *         PayoutDestinationRuleDesign.md §4.5): the only step that moves an
 *         account's own asset from its vault to a wallet. Everything a loan,
 *         an offer or a claim owes a party is paid into that party's vault as
 *         free balance; this is how it leaves. Its entries are
 *         `VaultDepositoryFacet.withdrawFromVault`, its batch form
 *         `withdrawCredited`, and the VPFI exit
 *         `VPFIDiscountFacet.withdrawVPFIFromVault`, which runs this same rule
 *         for the VPFI token. `check-wallet-payouts.mjs` refuses any other
 *         caller of the wallet-paying outflow doors.
 * @dev    Bounded by {withdrawableNow}: the depository holding, never more
 *         than the free holding (tracked minus liens minus the protected
 *         earmark), less a protected account's Ready balance. Without
 *         protected mode the asset is paid at once to the account's own
 *         wallet; with it, the payout is queued behind the delay.
 */
library LibVaultWithdraw {
    /// @notice A zero amount.
    error AmountZero();
    /// @dev #3205 part 2 — without protected mode a withdrawal pays only the
    ///      account's own wallet.
    error RecipientNotOwnWallet(address account, address recipient);

    /// @notice Same declaration as `VaultDepositoryFacet.VaultWithdrawRequested`
    ///         (one topic hash, whichever entry emits it).
    event VaultWithdrawRequested(
        address indexed account,
        address indexed asset,
        uint8 kind,
        uint256 tokenId,
        uint256 amount,
        address recipient,
        bool queued
    );

    /// @notice What `user` may withdraw of `asset` / `tokenId` now.
    function withdrawableNow(address user, uint8 kind, address asset, uint256 tokenId)
        internal
        view
        returns (uint256)
    {
        bool erc20 = kind == uint8(LibVaipakam.AssetType.ERC20);
        if (erc20) tokenId = 0;
        uint256 free = LibEncumbrance.vaultFree(user, erc20, asset, tokenId);
        // #3344 — Ready never pays a wallet: a protected account's Ready
        // balance leaves only after it is released back to Protected.
        if (erc20 && LibProtectedAccount.isProtected(user)) {
            uint256 ready = LibReadyBalance.spendableViaHost(user, asset);
            free = free > ready ? free - ready : 0;
        }
        return LibDepositoryLedger.withdrawable(user, asset, tokenId, free);
    }

    /**
     * @notice Withdraw `amount` of `account`'s own `asset` to `recipient`.
     * @dev    `kind` and `tokenId` are already normalised by the entry. Not
     *         pause-gated for a protected account during an open escape
     *         window. The ledger is debited when the withdrawal is asked
     *         for, paid or queued; a cancelled queued payout is credited back.
     * @return queuedId The pending payout id, or zero when paid at once.
     */
    function withdraw(
        address account,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) internal returns (uint256 queuedId) {
        if (
            LibPausable.paused()
                && !(LibProtectedAccount.isProtected(account)
                    && LibProtectedAccount.escapeOpen())
        ) revert LibPausable.EnforcedPause();
        LibProtectedAccount.requireManager(account);
        LibVaipakam._assertNotSanctioned(msg.sender);
        // Funds out to a caller-chosen address: the recipient is screened
        // too, whether it is paid now or queued (a queued payout is
        // screened again at release).
        LibVaipakam.assertRecipientNotBarred(recipient);
        if (amount == 0) revert AmountZero();
        {
            uint256 free = withdrawableNow(account, kind, asset, tokenId);
            if (amount > free) revert LibProtectedAccount.AmountExceedsFree(amount, free);
        }
        LibDepositoryLedger.debit(account, asset, tokenId, amount);
        if (LibProtectedAccount.isProtected(account)) {
            queuedId = LibProtectedAccount.queuePayout(account, kind, asset, tokenId, amount, recipient);
            emit VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, true);
            return queuedId;
        }
        if (recipient != account) revert RecipientNotOwnWallet(account, recipient);
        LibVaultOutflow.toOwner(account, kind, asset, tokenId, amount, OutflowReason.WITHDRAW);
        emit VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, false);
    }
}
