### #594 (PR 1/3) — collateral/principal consolidation to the position-NFT holder: the primitive

When a position NFT is transferred, the underlying vaulted assets cannot move
with it (an ERC-721 transfer can't carry ERC-20/721/1155 balances), so they stay
in the *original* vault and the loan's custody anchor diverges from the current
holder. The funds were already safe (the close-time claim path + the encumbrance
lien protect them), but the divergence forced a "borrower-pin" special case
through every mutation path. #594 removes that by **consolidating** a transferred
position into the current holder's vault, restoring an ordinary loan.

This first PR ships the **primitive and the two standalone entry points** — the
eager (automatic) wiring at lifecycle events lands in the follow-up PRs.

What a user/operator can now do:

- **`consolidateCollateralToHolder(loanId)`** / **`consolidatePrincipalToHolder(loanId)`**
  — a position-NFT holder can proactively pull a transferred loan's collateral
  (or held lender proceeds) into their own vault. The collateral physically
  moves vault-to-vault inside the protocol (never to a wallet), the encumbrance
  lien re-keys to the new owner with the aggregate conserved, the loan's custody
  anchor re-points to the holder, and the reward / metrics / VPFI-tier accounting
  follows. After it runs, the position is indistinguishable from one that never
  transferred.

How it stays safe:

- The asset move is gated so it can only ever deliver value to the **rightful
  current holder** (resolved on-chain from the position NFT), never redirect it.
- A transferred position that is mid-flight in a special state — awaiting
  liquidation fallback, carrying a live collateral-sale listing, or inside a live
  swap-to-repay intent — is **skipped**, not forced; those are handled by the
  paths that already own them.
- The protocol's transient hold of an NFT during a vault-to-vault move is
  **pinned to the exact expected token** and released on first receipt, so the
  protocol never becomes an open NFT sink.
- A sanctioned holder is rejected on the proactive path; the equivalent
  automatic path (a later PR) will simply skip rather than block a close-out, in
  line with the retail sanctions policy.

No existing behaviour changes — this adds new, opt-in entry points. Internal
plumbing only: no migration, and the standalone calls are holder-only.
