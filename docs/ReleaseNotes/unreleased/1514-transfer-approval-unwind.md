## Thread — The handover no longer leaves a spending approval behind (#1514)

Handing a loan's obligation over to a replacement borrower asks for a
spending approval just before it executes. If anything then stopped the
handover — the transaction reverted, the borrower declined to sign it,
or a last-moment interlock refused it — that approval stayed granted,
against a form that had nothing left to cancel.

The app's stated intent was already that a handover which does not
happen should leave no pointless approval behind, and it achieved that
by running its eligibility checks BEFORE asking for the approval. One
check cannot work that way: the interlock that watches for a sale of
the lender's position being accepted has to be asked as late as
possible, because catching an acceptance that lands while the review
sits open is its entire purpose. So it necessarily runs after the
approval, and the guarantee no longer held.

Now the handover withdraws an approval it obtained but did not use.
This is best-effort by design: if the withdrawal is itself declined,
the original failure stays the reported one rather than being replaced
by a second, more confusing error. An approval the wallet already held
before the attempt is never touched — it was granted for some other
purpose and is not this flow's to revoke.

The sibling refinance flow already behaved this way; the handover is
now consistent with it.
