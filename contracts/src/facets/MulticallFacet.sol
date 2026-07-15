// src/facets/MulticallFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibRevert} from "../libraries/LibRevert.sol";

/**
 * @title  MulticallFacet
 * @author Vaipakam Developer Team
 * @notice Batches several state-changing Diamond calls into ONE transaction —
 *         the on-chain substance behind the E-10 "Claim All" one-click flow
 *         (#1212): a user claims every eligible payout (lender/borrower loan
 *         proceeds, interaction rewards, vault VPFI, lender-intent capital,
 *         payroll) in a single signature instead of one tx per claim.
 *
 * @dev    ── Why delegatecall-to-self, un-guarded, best-effort ───────────────
 *
 *         Vaipakam's reentrancy guard is a SINGLE global `status`
 *         (`LibReentrancyGuard`, one ERC-7201 slot shared by every facet), and
 *         nearly every claim is `nonReentrant`. Two consequences shape this
 *         facet:
 *
 *         1. It must NOT be `nonReentrant`. Each batched call is executed with
 *            its OWN `address(this).delegatecall`, i.e. a fresh EVM message
 *            frame that enters AND exits the shared guard within that frame.
 *            Sequential guarded claims therefore never collide. A `nonReentrant`
 *            multicall, by contrast, would hold `status == ENTERED` across the
 *            loop and revert `ReentrancyGuardReentrantCall` on the second
 *            guarded call.
 *
 *         2. It uses `delegatecall` (not `address(this).call`) so `msg.sender`
 *            is PRESERVED as the original user. Every batched call keeps its own
 *            authorization exactly as if the user had called it directly —
 *            NFT-owner checks, beneficiary checks, sanctions gates, pause gates
 *            all evaluate against the real caller. (A plain `call` would rewrite
 *            `msg.sender` to the Diamond and break every claim's auth.)
 *
 *         Security posture: `multicall` grants NO capability a user does not
 *         already have. Each target self-authorizes against the preserved
 *         `msg.sender`, so admin/owner-gated and internal-only
 *         (`msg.sender == address(this)`) functions stay unreachable through
 *         the batch. The function is non-payable, so there is no `msg.value`
 *         re-use footgun (the classic payable-multicall vulnerability). Because
 *         `delegatecall` only ever routes back through this Diamond's own
 *         fallback to a cut facet, all return data is trusted (no return-bomb
 *         surface). Direct `multicall`-in-`multicall` recursion is rejected to
 *         bound nesting/gas griefing.
 *
 *         Best-effort semantics: each item carries `allowFailure`. With
 *         `allowFailure == true` (the "Claim All" default) an item that reverts
 *         — a loan not yet terminal, or one finalized by another party between
 *         the UI preview and the tx — is skipped and recorded as
 *         `success == false`; the rest of the batch still executes. A reverted
 *         `delegatecall` rolls back only its own frame, so a skipped item
 *         leaves no partial state. With `allowFailure == false` the inner
 *         revert is re-raised verbatim and the whole batch aborts.
 *
 *         Residual note: `claimInteractionRewards` is bounded to
 *         `MAX_INTERACTION_CLAIM_DAYS` finalized days per call (and can truncate
 *         on pool-cap exhaustion), so a single batch may not fully drain a
 *         long-dormant user's rewards — the caller/UI must tolerate a residual.
 */
contract MulticallFacet {
    /// @notice One item in a batch.
    /// @param callData     ABI-encoded call to a Diamond function selector
    ///                     (target is always this Diamond — self).
    /// @param allowFailure When true, a revert of this item is captured and the
    ///                     batch continues; when false, the revert aborts the
    ///                     whole batch.
    struct Call {
        bytes callData;
        bool allowFailure;
    }

    /// @notice Per-item outcome, index-aligned with the input `calls`.
    /// @param success    Whether the item's delegatecall succeeded.
    /// @param returnData The item's raw return data (empty on a skipped failure).
    struct Result {
        bool success;
        bytes returnData;
    }

    /// @dev Upper bound on batch size — a clean revert instead of an opaque
    ///      out-of-gas, and a guard against absurd calldata. Claims are heavy
    ///      (~1e5–3e5 gas each), so a caller near this bound is already near the
    ///      block gas limit; UIs should chunk beyond it.
    uint256 internal constant MAX_MULTICALL_CALLS = 30;

    // No batch-level event is emitted: each batched call emits its OWN
    // lifecycle event (LoanRepaid, RewardsClaimed, …) inside its delegatecall
    // frame, which is what indexers consume. A wrapper event would add nothing
    // an indexer needs and would require a taxonomy leaf the closed
    // event-category allow-list does not define for generic aggregation.

    /// @notice Thrown when the batch is empty.
    error MulticallEmpty();
    /// @notice Thrown when the batch exceeds {MAX_MULTICALL_CALLS}.
    error MulticallTooLarge(uint256 count, uint256 max);
    /// @notice Thrown when an item tries to re-invoke {multicall} (nesting is
    ///         disallowed to bound gas/stack griefing).
    error MulticallSelfRecursion();
    /// @notice Thrown when an item's `callData` is shorter than a 4-byte
    ///         selector — such an item would route to the Diamond's
    ///         `receive()`/empty fallback and report success without executing
    ///         any call, so it is rejected as a malformed batch.
    /// @param index The offending item's position in the batch.
    error MulticallItemMissingSelector(uint256 index);

    /**
     * @notice Execute a batch of Diamond calls in one transaction, preserving
     *         `msg.sender` for each. Primary use: E-10 "Claim All".
     * @dev    Non-payable, un-guarded, delegatecall-per-item (see the contract
     *         NatSpec for the full rationale). Reverts {MulticallEmpty} on an
     *         empty batch, {MulticallTooLarge} past {MAX_MULTICALL_CALLS}, and
     *         {MulticallSelfRecursion} if any item targets this selector.
     * @param  calls The batch; each item's `callData` is a self-call and its
     *         `allowFailure` decides whether a revert is skipped or fatal.
     * @return results Index-aligned per-item outcomes.
     */
    function multicall(Call[] calldata calls)
        external
        returns (Result[] memory results)
    {
        uint256 len = calls.length;
        if (len == 0) revert MulticallEmpty();
        if (len > MAX_MULTICALL_CALLS) {
            revert MulticallTooLarge(len, MAX_MULTICALL_CALLS);
        }

        results = new Result[](len);
        bytes4 selfSelector = this.multicall.selector;

        for (uint256 i; i < len; ) {
            bytes calldata cd = calls[i].callData;
            // Every item MUST carry at least a 4-byte selector. Empty/short
            // calldata would route to the Diamond's `receive()`/empty fallback
            // and return success WITHOUT executing any call, so a malformed
            // item would masquerade as a successful claim. Reject it
            // unconditionally — a structurally-invalid batch is a caller bug,
            // not a tolerable runtime failure that `allowFailure` should absorb.
            if (cd.length < 4) revert MulticallItemMissingSelector(i);
            // Reject direct multicall recursion — bounds nesting/gas griefing.
            if (bytes4(cd[:4]) == selfSelector) revert MulticallSelfRecursion();

            // delegatecall preserves msg.sender; each item enters+exits the
            // shared reentrancy guard within its own frame.
            (bool ok, bytes memory ret) = address(this).delegatecall(cd);
            if (!ok && !calls[i].allowFailure) {
                // Re-raise the inner revert verbatim; abort the batch.
                LibRevert.bubbleOnFailure(ok, ret, "multicall: item reverted");
            }
            results[i] = Result({success: ok, returnData: ret});

            unchecked {
                ++i;
            }
        }
    }
}
