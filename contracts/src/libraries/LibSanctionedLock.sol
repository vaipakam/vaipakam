// src/libraries/LibSanctionedLock.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";

/**
 * @title  LibSanctionedLock
 * @author Vaipakam Developer Team
 * @notice #821 — wraps a wind-down close-out's deposit into a sanctioned
 *         recipient's OWN vault so the close-out completes (the unflagged
 *         counterparty is made whole) while the flagged party's share stays
 *         LOCKED until the sanction clears.
 *
 * @dev    Usage at each close-out deposit site (`repayLoan`, `triggerDefault`,
 *         HF-liquidation, `cancelOffer` refund, …):
 *
 *           LibSanctionedLock.begin(s, recipient);
 *           <existing deposit into `recipient`'s vault>;   // screen now exempt
 *           LibSanctionedLock.end(s, recipient, loanId, asset, amount);
 *
 *         `begin` pins the receive-side `getOrCreateUserVault` exemption to the
 *         EXACT recipient (so a reentrant transfer can't resolve a different
 *         flagged wallet's vault, and a new vault is never minted for a flagged
 *         wallet — see `VaultFactoryFacet.getOrCreateUserVault`). `end` clears
 *         the pin and, only when the recipient was actually flagged, emits
 *         `SanctionedProceedsLocked` so operators can reconcile the parked
 *         proceeds when the flag is lifted.
 *
 *         The LOCK itself is enforced elsewhere and needs no new storage: the
 *         deposit is protocol-tracked (so `recoverStuckERC20` can't reach it)
 *         and `claimAsLender` / `claimAsBorrower` screen the stored vault owner,
 *         so nothing leaves the vault while the owner is flagged.
 *
 *         Setting the pin is unconditional (cheap, and harmless for a clean
 *         recipient — its passing screen is simply skipped); the event only
 *         fires for a genuinely sanctioned recipient.
 */
library LibSanctionedLock {
    /// @notice A wind-down close-out deposited a sanctioned recipient's share
    ///         into their own vault, where it stays locked behind the Tier-1
    ///         claim gate until the sanction clears.
    /// @param loanId    The loan (or, for an offer-cancel refund, the offer id
    ///                  cast to uint256) whose close-out parked the proceeds.
    /// @param recipient The sanctioned vault owner whose share is locked.
    /// @param asset     The ERC-20 asset parked.
    /// @param amount    The amount parked.
    event SanctionedProceedsLocked(
        uint256 indexed loanId,
        address indexed recipient,
        address asset,
        uint256 amount
    );

    /// @dev Pin the receive-side vault-screen exemption to `recipient` for the
    ///      duration of the following close-out deposit.
    function begin(LibVaipakam.Storage storage s, address recipient) internal {
        s.sanctionedDepositExemptUser = recipient;
    }

    /// @dev Clear the pin and, when `recipient` is sanctions-flagged, emit the
    ///      audit event recording that this close-out parked locked proceeds.
    function end(
        LibVaipakam.Storage storage s,
        address recipient,
        uint256 loanId,
        address asset,
        uint256 amount
    ) internal {
        s.sanctionedDepositExemptUser = address(0);
        if (LibVaipakam.isSanctionedAddress(recipient)) {
            emit SanctionedProceedsLocked(loanId, recipient, asset, amount);
        }
    }

    /// @dev Drop-in replacement for `LibFacet.getOrCreateVault(owner)` at a
    ///      wind-down close-out settlement site that resolves a loan party's
    ///      vault and then `safeTransfer`s + `recordVaultDeposit`s their share
    ///      (default / liquidation / cancel). Pins the receive-side exemption
    ///      around the resolution so a flagged `owner`'s EXISTING vault resolves
    ///      (instead of bricking the close-out), then emits the lock event when
    ///      `owner` is flagged AND a non-zero amount is being parked. The lock
    ///      is enforced by the claim-side stored-owner screen (see
    ///      `ClaimFacet`). `loanId` is the loan (or, for an offer-cancel refund,
    ///      the offer id cast to uint256) for the audit trail.
    function getOrCreateVaultLocked(
        LibVaipakam.Storage storage s,
        address owner,
        uint256 loanId,
        address asset,
        uint256 amount
    ) internal returns (address vault) {
        s.sanctionedDepositExemptUser = owner;
        vault = LibFacet.getOrCreateVault(owner);
        s.sanctionedDepositExemptUser = address(0);
        if (amount > 0 && LibVaipakam.isSanctionedAddress(owner)) {
            emit SanctionedProceedsLocked(loanId, owner, asset, amount);
        }
    }
}
