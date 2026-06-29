## Sanctioned-recipient wind-down: vault-lock + freeze (#821)

Closing the last gap the #800 sanctions audit surfaced. Previously, if a loan
party became sanctions-flagged *after* a loan was struck, the wind-down
close-outs (full repayment, time-based default, HF-based liquidation, and the
internal-match settlement that liquidation/default try first) could **revert** —
because depositing that party's share routes through the receiving vault, which
is screened. A flagged lender could brick repayment; the unflagged counterparty
couldn't be made whole until the flag lifted.

The protocol now keeps these close-outs working **without ever handing spendable
value to a flagged wallet**, on the principle that *the wallet is sanctioned, not
the vault*:

- **In — the close-out completes.** The flagged recipient's share is deposited
  into their **own** per-user vault (an isolated, protocol-tracked balance) so
  the debt clears and the unflagged counterparty is made whole. Nothing is held
  in the shared protocol contract — no commingling of sanctioned-linked funds.
- **Frozen — nothing leaves.** While the wallet is flagged, the assets in its
  vault do **not** move. The claim paths now check the vault's stored owner, so a
  flagged party's proceeds can't be withdrawn — not even by transferring the
  position NFT to a clean wallet and claiming from there, and not through the
  keeper-assisted backstop buyout either (both loopholes are now closed). A
  genuine protocol sale of a position re-points it to the buyer, so a legitimate
  buyer's funds settle to their own vault and are unaffected.
- When the sanction is lifted, the preserved proceeds become claimable as normal.
- A new on-chain event records each time a close-out parks locked proceeds, so
  operators can reconcile them when a flag clears.
- The **NFT Verifier** now warns when a position's payout is frozen — both when
  the current owner is flagged and when the original loan party of record is
  flagged (the case where a flagged party moved the position NFT to a clean
  wallet), so a prospective buyer knows the position is currently unclaimable for
  anyone holding it.
- Cancelling an unfilled offer is intentionally left to revert for a flagged
  creator: that refund returns the creator's *own* escrowed funds, so with no
  counterparty to protect, the revert is simply the freeze — the escrow stays put
  until the flag clears.

No behaviour changes for unflagged users: their close-outs and claims work
exactly as before.

Closes #821.
