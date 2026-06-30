## Sanctioned-recipient wind-down: vault-lock + freeze (#821)

Closing the repay / default / liquidation gaps the #800 sanctions audit surfaced.
(One audit item remains deferred: the **completion** paths where a buyer is
already committed — `completeLoanSale` / `completeOffset` — are tracked separately
as **#831** and are not part of this change.) Previously, if a loan party became
sanctions-flagged *after* a loan was struck, the wind-down close-outs (full
repayment, time-based default, HF-based liquidation, and the internal-match
settlement that liquidation/default try first) could **revert** — because
depositing that party's share routes through the receiving vault, which is
screened. A flagged lender could brick repayment; the unflagged counterparty
couldn't be made whole until the flag lifted.

The protocol now keeps these close-outs working **without ever handing spendable
value to a flagged wallet**, on the principle that *the wallet is sanctioned, not
the vault*:

- **In — the close-out completes.** The flagged recipient's share is deposited
  into their **own** per-user vault (an isolated, protocol-tracked balance) so
  the debt clears and the unflagged counterparty is made whole. Nothing is held
  in the shared protocol contract — no commingling of sanctioned-linked funds.
  This holds across **every** wind-down branch: the ERC-20 lender payment, the
  NFT-rental lender share, the fallback-cure collateral restore, the in-kind /
  NFT collateral transfer on default and liquidation, and the internal-match
  settlement. Where the close-out has to *withdraw* a flagged borrower's
  collateral out of their vault (the in-kind and internal-match paths), that
  withdrawal is permitted too — the flagged party is losing custody to the
  unflagged counterparty, not receiving — so the forced default/liquidation can
  never be bricked by flagging either party after the loan was struck.
- **Frozen at the source — positions can't move.** A position NFT (lender or
  borrower) can no longer be transferred **into or out of** a sanctions-flagged
  wallet. This is the primary freeze mechanism: it stops a flagged party from
  laundering its position to a clean wallet to escape the payout freeze, and it
  means a flagged wallet's position is simply frozen in place until the flag
  clears. (Minting, burning, and protocol-internal settlement use separate
  authorized paths, so a flagged party's loan can still be settled and its
  position burned at terminal — the close-out always completes.) A position
  transferred while both parties were clean — a legitimate secondary-market sale
  made *before* any later flag — is unaffected.
- **Frozen on payout — nothing leaves the flagged vault.** With the position
  pinned in place, a flagged wallet that holds its own position can't extract the
  payout either: the claim paths screen the live recipient, and the proceeds sit
  vault-locked behind that screen until the flag clears.
- When the sanction is lifted, the preserved proceeds become claimable as normal.
- A new on-chain event records each time a close-out parks locked proceeds, so
  operators can reconcile them when a flag clears.
- The **NFT Verifier** warns when a position's current owner is sanctions-flagged
  — meaning the position is frozen (the owner can neither claim it nor transfer
  it) and can't be bought or claimed until the owner is delisted. (A stale
  original loan party is *not* flagged as frozen: a transfer made before any
  later flag is a legitimate secondary-market sale that settles normally.)
- Cancelling an unfilled offer is intentionally left to revert for a flagged
  creator: that refund returns the creator's *own* escrowed funds, so with no
  counterparty to protect, the revert is simply the freeze — the escrow stays put
  until the flag clears.

No behaviour changes for unflagged users: their close-outs and claims work
exactly as before.

Closes #821.
