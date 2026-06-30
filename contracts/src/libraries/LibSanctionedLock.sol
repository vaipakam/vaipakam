// src/libraries/LibSanctionedLock.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

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
    using SafeERC20 for IERC20;

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

    /// @dev Arm the FROM-side move-out exemption (`consolidationMoveFromUser`)
    ///      for `payer` around a wind-down vault WITHDRAWAL (Codex #832 P1). The
    ///      in-kind / vault-to-vault default, liquidation and internal-match
    ///      settlements pull the paying borrower's collateral OUT of their vault
    ///      via `VaultFactoryFacet.vaultWithdraw*`, which resolves that vault
    ///      through the Tier-1-gated `getOrCreateUserVault`. A borrower flagged
    ///      AFTER loan-init would otherwise brick the forced close-out here. The
    ///      payer is LOSING custody (asset pushed to the already-screened
    ///      recipient), so the receive-side gate must not apply; their vault
    ///      already exists, so no proxy is minted for a flagged wallet. Pinned to
    ///      the exact `payer` so a reentrant transfer can't resolve a DIFFERENT
    ///      flagged vault — the same window `LibConsolidation` opens around its
    ///      move-out. `endMoveOut` clears it; always pair them.
    function beginMoveOut(LibVaipakam.Storage storage s, address payer) internal {
        s.consolidationMoveFromUser = payer;
    }

    /// @dev Clear the from-side move-out exemption armed by `beginMoveOut`.
    function endMoveOut(LibVaipakam.Storage storage s) internal {
        s.consolidationMoveFromUser = address(0);
    }

    /// @dev Single-call ERC-20 vault WITHDRAW under the from-side move-out
    ///      exemption: folds `beginMoveOut` + the `vaultWithdrawERC20` cross-facet
    ///      call + `endMoveOut` into one shared subroutine for the common
    ///      wind-down case where a forced default / liquidation pulls a
    ///      (possibly-flagged) `payer`'s collateral OUT to an already-screened
    ///      `recipient`. Folding the call here keeps each site a single CALL,
    ///      which matters for the EIP-170-tight liquidation facets (RiskFacet et
    ///      al.). Use the raw `beginMoveOut`/`endMoveOut` window directly where
    ///      several withdrawals — or the ERC-721/1155 variants — must share one
    ///      exemption span. Reverts `VaultWithdrawFailed` on a failed withdraw,
    ///      matching the inline call sites this replaces.
    function vaultWithdrawERC20MoveOut(
        LibVaipakam.Storage storage s,
        address payer,
        address asset,
        address recipient,
        uint256 amount
    ) internal {
        s.consolidationMoveFromUser = payer;
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                payer,
                asset,
                recipient,
                amount
            ),
            IVaipakamErrors.VaultWithdrawFailed.selector
        );
        s.consolidationMoveFromUser = address(0);
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
        // Emit whenever `owner` is flagged — unlike `depositLocked` there is NO
        // `amount > 0` gate here. This is the in-kind / vault-to-vault / NFT
        // helper: the caller parks a real asset regardless of the numeric
        // `amount` (an ERC-721 carries its payload in `tokenId` with a
        // structurally-zero `collateralAmount`), so the parked-proceeds audit
        // event must still fire (Codex #832 P3). Callers pass the most
        // descriptive amount they have (token amount, NFT quantity, or 0 for a
        // bare ERC-721).
        if (LibVaipakam.isSanctionedAddress(owner)) {
            emit SanctionedProceedsLocked(loanId, owner, asset, amount);
        }
    }

    /// @dev Single-call ERC-20 close-out deposit for the common case where a
    ///      wind-down settlement holds the share in the Diamond and pushes it
    ///      to a loan party's vault: resolves `owner`'s vault behind the pinned
    ///      receive-side exemption (so a flagged `owner` doesn't brick the
    ///      close-out), `safeTransfer`s `amount` of `asset` from the Diamond
    ///      into that vault, ticks the protocol-tracked balance, and emits the
    ///      lock event when `owner` is flagged. Folds the
    ///      `getOrCreateVaultLocked` + `safeTransfer` + `recordVaultDeposit`
    ///      trio into one shared subroutine so each call site stays a single
    ///      `CALL` (keeps the close-out facets under the EIP-170 size limit) —
    ///      use this where the share is a plain ERC-20 sitting in the Diamond;
    ///      use `getOrCreateVaultLocked` directly when the move is in-kind /
    ///      vault-to-vault / NFT and the caller needs the vault address.
    ///      A zero `amount` is a no-op (no vault is force-created, nothing is
    ///      transferred, no event) — matching the prior `if (amount > 0)` guards.
    function depositLocked(
        LibVaipakam.Storage storage s,
        address owner,
        uint256 loanId,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        s.sanctionedDepositExemptUser = owner;
        address vault = LibFacet.getOrCreateVault(owner);
        s.sanctionedDepositExemptUser = address(0);
        IERC20(asset).safeTransfer(vault, amount);
        LibVaipakam.recordVaultDeposit(owner, asset, amount);
        if (LibVaipakam.isSanctionedAddress(owner)) {
            emit SanctionedProceedsLocked(loanId, owner, asset, amount);
        }
    }
}
