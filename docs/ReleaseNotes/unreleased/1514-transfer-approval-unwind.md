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

Two further consequences of getting the confirmation right, both about
telling the user the truth afterwards.

A sped-up transaction genuinely has a new identity, and several success
panels were still showing the old one — so a link meant to prove the
thing happened pointed at a record that does not exist. Those panels now
show the identity the network actually recorded.

And when a step fails — or is stopped by one of the last-moment checks
that run after the approval — the app tries to tidy up the spending
approval it had asked for. That tidying can itself fail partway, in which case the
approval is left cleared rather than restored — something the person
needs to know about and act on. Previously only the original failure was
shown and the cleanup problem was silent. Both are now reported: the
original failure stays the headline, because it is what they were trying
to do, with the cleanup problem added after it.

Two last corrections, both about the tidy-up being honest rather than
merely quiet.

The tidy-up can reach a third outcome besides working and failing: it
can be unable to find out what happened, when the approval it is chasing
never resolves and the network cannot be re-read. That outcome was being
reported as nothing-to-undo, which is the same thing the app says when
an attempt genuinely left no approval behind — so the person saw only
the original failure while an approval sized for a payoff might still be
about to take effect, or an earlier standing figure might already have
been cleared. Not knowing is now said out loud, alongside the original
failure, because it is a wallet state they may need to act on. Standing
back from the approval in that case is unchanged and still correct: what
changes is that they are told.

And a sped-up approval is now handed to the tidy-up under the identity
the network recorded rather than the one the wallet first offered. A
speed-up replaces the transaction, and data providers stop answering for
the replaced one shortly afterwards — so the tidy-up was left waiting
for something that would never come back, giving up on an approval that
was standing the whole time. The success panels were corrected on this
point earlier; this is the same correction on the path that cleans up
after a failure.

Two more, both on the two-step version of the tidy-up — the one that has
to clear an approval to zero before it can write the earlier figure back.

The check that the clearing step had taken effect was asking about the
moment it happened rather than about the present. If someone granted a
fresh approval in the gap between the clearing and the putting-back —
another tab, another device — that grant was invisible to the check, and
the tidy-up wrote the old figure straight over a decision somebody had
just made. The other guard that might have caught it, which looks for a
transaction still waiting, cannot help here either: by then theirs has
already gone through. The app now asks what the approval is worth right
now, immediately before writing, and stands back if the answer is not
the zero it left there. If it cannot get an answer at all it also stands
back — and says so, because at that point the earlier approval has been
cleared and the person is the only one who can decide whether to grant
it again.

The second is a case where the tidy-up did nothing when it was the one
case it most needed to act. If the clearing step succeeded but the
approval that followed it did not take effect, the tidy-up compared what
was on chain against the figure that never happened, concluded the
approval was no longer its business, and reported success. What had
actually happened is that the person's earlier approval was cleared by
our own confirmed step and never put back. It now recognises that
situation and restores the earlier figure, while keeping the same
protection as everywhere else: it goes ahead only if what is on chain is
exactly what this attempt left there.

Three more places where the tidy-up stayed quiet about an outcome the
person needed. The rule they all break is the one already written down:
saying nothing is a promise that nothing needs acting on, and it can
only be made once that has actually been established.

Two of them are the tidy-up declining to act because another transaction
is in flight on the account. Declining is right — the other transaction
could take effect first and ours would write straight over it — but the
consequence is not nothing. Before the clearing step it means the
payoff-sized approval is still standing; after it, it means the person's
earlier grant is sitting erased and is not being put back. Both were
reported as a clean tidy-up. The same applied when the app could not
even find out whether anything was in flight, which is weaker ground for
staying silent, not stronger.

The third is the pair of checks that ask what the approval was left at.
When neither could get a trustworthy answer — no archive depth on one
side, an unreachable data source on the other — the app fell back to
comparing against a figure it had no confidence in, concluded the
approval was no longer its business, and reported success. What had
actually happened is that it could not tell. It now says so. The
deliberate exception is unchanged and still silent: where a data source
that demonstrably has the relevant block reports that someone else has
moved the approval, that is a real answer about a decision somebody
made, and standing back from it needs no warning.

A Spanish wording fix in the same area, found while checking one flagged
line and turning out to affect six. The offset screens use one Spanish
word, *cancelación*, for two different things: cancelling the offer, and
the payoff that gets collected. In the banner shown after a cancellation
the two meanings sat in the same sentence, so the line that warns "the
spending approval you granted for the payoff is left in place" read as
though the approval had been granted for the cancellation — understating
what the approval can still be used to collect. The payoff sense is now
*pago* throughout those screens, matching the wording the refinance
screens already use; the one place the word genuinely means cancelling
is unchanged. No other language had the problem.
