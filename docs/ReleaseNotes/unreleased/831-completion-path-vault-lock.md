## Sanctioned-buyer loan-sale completion: vault-lock (#831)

The final follow-up to the #821 sanctions wind-down work. #821 made the
direct close-outs (repay / default / liquidation) complete-and-freeze when a
loan party is sanctions-flagged. This closes the matching gap on the
**completion** path of a loan sale, where a buyer is already committed.

If a buyer of a lender position became sanctions-flagged **after** committing to
the purchase but before the sale was finalised, completing the sale used to
**revert** — because the buyer's share is paid into their own vault, which is
screened. That would have stranded the committed seller (and everyone else in
the trade) on something outside their control.

Now the completion finishes regardless: the buyer's share is deposited into
their **own** vault, frozen behind the same protections as #821 (the buyer can
neither move the acquired position out of their wallet nor claim its payout
while flagged), and an on-chain event records the parked proceeds for operator
reconciliation. A buyer who is not flagged is unaffected.

The offset-completion path was reviewed in the same pass and needed no change —
it only records the parties' claims and transitions the loan; the actual
proceeds move later at claim time, which #821 already handles.

Closes #831.
