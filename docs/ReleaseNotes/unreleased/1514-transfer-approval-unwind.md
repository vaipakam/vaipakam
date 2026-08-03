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

Now the handover puts the approval back to whatever it was before the
attempt. Putting it back is the right description rather than
withdrawing it: an approval is not only ever created from nothing, it
is also sometimes raised from an existing smaller figure, and revoking
in that case would destroy a standing arrangement the wallet holds for
some other purpose. Whatever was there before the attempt is what is
there after it.

That care runs in the other direction too. If the approval has changed
since this attempt set it — a second tab, another flow, or the spender
having already drawn on it — the unwind leaves it entirely alone. Its
own idea of the earlier figure is stale by then, and writing it back
would be the same destructive overwrite pointed the opposite way.

Withdrawal is best-effort by design: if it is itself declined, the
original failure stays the reported one rather than being replaced by a
second, more confusing error.

The sibling refinance flow already withdrew its unused approval, and
shared both of the flaws above; it is fixed in the same way. Both are
now covered by tests that pin the exact sequence of approval writes,
including the awkward middle case where a two-step approval is
interrupted after the first step — the point at which the wallet's
earlier figure has already been cleared and genuinely does need
restoring.
