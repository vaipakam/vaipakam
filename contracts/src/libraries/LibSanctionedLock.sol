// src/libraries/LibSanctionedLock.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibERC721} from "./LibERC721.sol";
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

    /// @dev Cross-PAYER variant of {depositLocked}: parks a close-out payoff that
    ///      a THIRD-PARTY `payer` funds (via `IERC20.approve(diamond,≥amount)`)
    ///      into `owner`'s vault behind the receive-side exemption — the chokepoint
    ///      shape where the Diamond stays out of the funds path but the
    ///      protocol-tracked balance still ticks under `owner`. Resolves `owner`'s
    ///      EXISTING vault under the pin (so a flagged `owner` doesn't brick the
    ///      close-out), `safeTransferFrom`s `payer → vault`, ticks the counter, and
    ///      emits the lock event when `owner` is flagged. Mirror of
    ///      `VaultFactoryFacet.vaultDepositERC20From` + the `begin`/`end` window,
    ///      folded into one subroutine so an EIP-170-tight close-out facet can park
    ///      a lender payoff in a single cross-facet CALL (see
    ///      `EncumbranceMutateFacet.parkLenderPayoffAndFreeze`). Zero `amount` is a
    ///      no-op.
    function depositLockedFrom(
        LibVaipakam.Storage storage s,
        address payer,
        address owner,
        uint256 loanId,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        s.sanctionedDepositExemptUser = owner;
        address vault = LibFacet.getOrCreateVault(owner);
        s.sanctionedDepositExemptUser = address(0);
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(asset).safeTransferFrom(payer, vault, amount);
        LibVaipakam.recordVaultDeposit(owner, asset, amount);
        if (LibVaipakam.isSanctionedAddress(owner)) {
            emit SanctionedProceedsLocked(loanId, owner, asset, amount);
        }
    }

    // ─── #998 S10 (#1006) — frozen-claimant marker (fail-closed release) ──────

    /// @notice Record the FROZEN-CLAIMANT marker for a sanctioned-locked-proceeds
    ///         park. Call at a receive-side close-out freeze with the INTENDED
    ///         economic recipient — the CURRENT position-NFT holder the payout is
    ///         for — and the side (`lenderSide` selects the lender vs borrower
    ///         mapping).
    /// @dev    Records the address ONLY when it is affirmatively sanctions-flagged.
    ///         A park during an oracle outage (the predicate fails OPEN ⇒ false)
    ///         records nothing, so ordinary / unconfirmed parks stay fail-open at
    ///         claim time — an oracle blip must never freeze an honest claimant.
    ///         The recorded address (NOT the credited vault owner, NOT the eventual
    ///         `msg.sender`) is what the release gate re-checks FAIL-CLOSED, which
    ///         is what keeps a confirmed freeze from lifting during an oracle
    ///         outage AND closes the transfer-during-outage laundering hole (the
    ///         funds unlock only once the RECORDED party is proven de-listed,
    ///         regardless of who holds the position NFT at claim time). Keyed to
    ///         the current holder — not the `owner` the funds are parked into —
    ///         because a transferred position can be held by a flagged party while
    ///         the stored (credited) party is clean.
    /// @notice Registry-aware FREEZE decision (Codex #1122-rework r1 P1). Returns
    ///         true when `who`'s close-out proceeds must be PARKED (frozen), not
    ///         paid out. Unlike the bare fail-open {LibVaipakam.isSanctionedAddress}
    ///         (which waves a party through during ANY outage), this is FAIL-CLOSED
    ///         on a PRIOR confirmed flag: a wallet already in
    ///         `sanctionsConfirmedFlagged` stays frozen even while the oracle is
    ///         unreachable, so a close-out that lands during an outage can't hand a
    ///         previously-confirmed-flagged holder their payout (the ordinary claim
    ///         screen fails open in the same window).
    /// @dev    Mirrors the #1123 movement-gate tri-state exactly:
    ///           - oracle UNSET → false (screening regime disabled);
    ///           - Flagged (oracle up) → true (a fresh authoritative confirmation);
    ///           - Clean (oracle up) → false (never freeze a de-listed party);
    ///           - Unavailable (oracle set but reverts) → the registry: freeze IFF
    ///             `who` was previously confirmed. An address NEVER confirmed stays
    ///             fail-open during an outage — an oracle blip can't freeze an
    ///             honest claimant.
    function mustFreezeParty(LibVaipakam.Storage storage s, address who)
        internal
        view
        returns (bool)
    {
        if (who == address(0)) return false;
        if (s.sanctionsOracle == address(0)) return false; // regime disabled
        LibVaipakam.SanctionsRead st = LibVaipakam.sanctionsStatus(who);
        if (st == LibVaipakam.SanctionsRead.Flagged) return true;
        if (st == LibVaipakam.SanctionsRead.Clean) return false;
        // Unavailable: fail-closed on a prior authoritative confirmation only.
        return s.sanctionsConfirmedFlagged[who];
    }

    function recordFrozenClaimant(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        bool lenderSide,
        address intendedClaimant
    ) internal {
        if (intendedClaimant == address(0)) return;
        // FAIL-CLOSED freeze decision (Codex #1122-rework r1 P1): freeze on a fresh
        // authoritative flag OR on a prior confirmation during an outage — NOT the
        // bare fail-open `isSanctionedAddress`, which would skip the marker for a
        // previously-confirmed holder while the oracle is down and let their
        // (equally fail-open) claim through.
        if (!mustFreezeParty(s, intendedClaimant)) return;
        // #1123 registry population — a fresh oracle-reachable Flagged read enrols
        // this closing holder in the confirmed-flagged registry so the fail-closed
        // position-movement gate can bar them from shuffling a still-open position
        // during a later oracle outage (the close-out population #1123 left to S10,
        // same holder, keyed identically). Idempotent: a no-op when we reached here
        // via an already-registered outage confirmation. Cleared only by an
        // authoritative de-list (refresh / clean move), never by a fallback-cure of
        // the per-loan marker (the holder WAS confirmed flagged).
        s.sanctionsConfirmedFlagged[intendedClaimant] = true;
        // FIRST-WRITE-WINS (Codex r2 P1): never overwrite an already-recorded
        // frozen claimant for this side. A loan side can accrue proceeds across
        // multiple parks (an Active partial-internal-match `heldForLender`, then a
        // terminal); if a flagged holder transferred the position during an oracle
        // outage, a later park for a DIFFERENT flagged holder would otherwise
        // overwrite the original recorded address, and the release gate would then
        // only need the newer holder de-listed — releasing proceeds that were
        // frozen for the FIRST sanctioned holder while that holder is still listed
        // (re-opening the transfer-during-outage laundering path). The earliest
        // confirmed freeze sticks until a clean release clears the slot.
        if (lenderSide) {
            if (s.sanctionsLockedLenderClaimant[loanId] == address(0)) {
                s.sanctionsLockedLenderClaimant[loanId] = intendedClaimant;
            }
        } else {
            if (s.sanctionsLockedBorrowerClaimant[loanId] == address(0)) {
                s.sanctionsLockedBorrowerClaimant[loanId] = intendedClaimant;
            }
        }
    }

    /// @notice Convenience wrapper for the common receive-side park: resolve the
    ///         CURRENT position-NFT holder for `lenderSide` (the intended economic
    ///         claimant) and record it as the frozen claimant iff flagged.
    /// @dev    Reads the current position-NFT owner straight from Diamond storage
    ///         via `LibERC721._ownerOfRaw` — a plain SLOAD, NOT an external
    ///         `ownerOf` staticcall, which keeps the inlined cost at each of the
    ///         many EIP-170-tight park sites (RiskFacet / DefaultedFacet /
    ///         PrecloseFacet et al.) to a storage read. The raw read returns
    ///         `address(0)` for a burned / never-minted token, so a position with
    ///         no live holder records nothing (there is no distinct downstream
    ///         claimant to freeze) without needing a try/catch. Delegates the flag
    ///         test + the affirmative-only write to `recordFrozenClaimant`, so an
    ///         oracle-outage park still stays fail-open (no marker). Use this at the
    ///         standard park sites where the payout is owed to the position holder;
    ///         pass the address directly to `recordFrozenClaimant` at sites that
    ///         have already resolved the intended recipient (e.g. a surplus paid to
    ///         a passed `currentHolder`).
    function recordFrozenClaimantForLoan(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        bool lenderSide
    ) internal {
        uint256 tokenId = lenderSide ? loan.lenderTokenId : loan.borrowerTokenId;
        recordFrozenClaimant(s, loan.id, lenderSide, LibERC721._ownerOfRaw(tokenId));
    }

    /// @notice The recorded frozen claimant for a `(loanId, side)`, or
    ///         `address(0)` when that side's proceeds were not locked behind a
    ///         confirmed flag (the common case).
    function frozenClaimant(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        bool lenderSide
    ) internal view returns (address) {
        return lenderSide
            ? s.sanctionsLockedLenderClaimant[loanId]
            : s.sanctionsLockedBorrowerClaimant[loanId];
    }

    /// @notice Clear the frozen-claimant marker for a `(loanId, side)` after a
    ///         successful clean release (the fail-closed screen passed ⇒ the
    ///         oracle is up and the recorded claimant is de-listed), so the slot
    ///         doesn't leak and a later re-lock stays possible. Clears only the
    ///         side being released.
    function clearFrozenClaimant(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        bool lenderSide
    ) internal {
        if (lenderSide) {
            delete s.sanctionsLockedLenderClaimant[loanId];
        } else {
            delete s.sanctionsLockedBorrowerClaimant[loanId];
        }
    }
}
