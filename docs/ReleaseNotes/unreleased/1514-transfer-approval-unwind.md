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

One more assumption sat underneath all of this, and it was wrong
everywhere the app used it. A wallet lets you cancel a transaction that
is waiting to be mined, by sending a do-nothing one in its place. The
app's way of asking "did my transaction go through?" was to wait for a
result and check that it succeeded — and for a cancelled transaction
that check passes, because the do-nothing replacement really did
succeed. A transaction that did none of what was asked was therefore
indistinguishable from one that did all of it.

The consequences differed by where it happened. A cancelled approval
was reported as granted, so the flow carried on to a step that could
only fail. A cancelled withdrawal reported the earlier approval as put
back when it was still cleared. A cancelled posting reported an offer
as live when nothing had been posted.

The app now checks that the result it is looking at belongs to the
transaction it sent, rather than to whatever replaced it, and says so
plainly when it does not. Where the intended effect is something the
app can simply look at afterwards — an approval figure, for instance —
it now confirms by looking at that instead, which is a better question
to ask: it answers "did what I wanted happen?" rather than merely "did
some transaction happen?", and so it also covers the chain reorganising
or the wallet's data source being wrong.

That check needed one correction of its own, worth recording because the
first version of it broke something that had been working. Wallets offer
two ways to interfere with a transaction that is waiting: cancelling it,
and speeding it up. Both give it a new identity, but only cancelling
stops it happening — a speed-up is the very same request, paid for more
generously. Rejecting every change of identity therefore told users that
a sped-up approval or offer had failed while it was going through
perfectly well. The app now distinguishes the two, and only treats the
cancelling kind as a failure.

The same care applies to how the app decides an approval landed. Asking
a public data provider what an approval is worth immediately after the
transaction confirms often gets an answer from just before it — the
provider has not caught up. Treating that as proof the approval never
happened would retract something that did happen, and leave the very
approval the app is trying to tidy up standing untouched. So a
disagreement is now only believed when it comes from a provider that
demonstrably has the relevant block; anything less is treated as not
knowing, and not knowing never overrules the app's own confirmation.
