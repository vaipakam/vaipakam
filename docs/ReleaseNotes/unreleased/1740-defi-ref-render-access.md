# apps/defi: nine "reading a ref while rendering" complaints, sorted into three real fixes and six not-faults

The lending app's linting flagged nine places that touch a short-term scratch
value — the kind of holder a component uses to remember something across
renders without redrawing when it changes — while the screen is being drawn.
The tool treats every one of these as a fault. Six of them are not — five are
deliberate, and one is a plain false alarm — and much of this change is about
writing down which is which, so the next person to see the warnings does not
"fix" a guard that exists on purpose. The other three are real, and one of those
only became clear during review; it is described last, because it started out on
the "deliberate" side of the ledger.

**Two were obviously genuine and are now fixed.** The active-offer list and the loan list
each keep a note of the newest block the app is confident about, so that a
background refresh can catch up on anything it missed. The note was being
updated while the screen was drawn, which is not safe in the drawing model React
is moving toward — a draw can be abandoned halfway, and an update made during an
abandoned draw has still happened. Both now update just after the screen is
committed instead. The only reader in each case runs after a network round-trip,
so it sees the settled value; even in the theoretical case where it did not, it
would use the previous block number, which shortens one catch-up pass that the
next one covers anyway.

**Five are deliberate and now say so.** The risk-acknowledgement gate deliberately
consults its notes mid-draw, and that timing is the entire mechanism. Two of them
answer "was this answer worked out for the offer and wallet being drawn right
now?", so that the moment a user switches offer or wallet, the previous offer's
answer is withheld rather than shown for one frame. Three more do the same for a
risk verdict, so a stale "you're clear to proceed" cannot enable an action that
is already doomed. Deferring any of these by one frame would reopen exactly the
window they were added to close — an earlier review round put them there for
that reason.

**A sixth looked deliberate and was not**, and review caught it. The same
risk-acknowledgement gate keeps a note of the current wallet-and-chain so that a
transaction already in flight can check whether it is still relevant before
applying its result. That note was being updated mid-draw. The argument for
doing it then was that updating it later leaves a gap in which work started
under the *new* wallet compares against the old one and cancels itself for no
reason — which is true of the later of the two available moments, but not of the
earlier one. Updating it at the point the screen is committed, before anything
can be clicked, closes that gap too, and avoids a worse problem: the browser may
begin preparing a screen for a different wallet and then throw that work away,
and a mid-draw update would already have overwritten the note. A transaction
running against the wallet still on screen would then look stale to itself and
bail — and because the "am I still relevant" check also guards the code that
clears the busy state, the button would have stayed spinning even though the
transaction succeeded. It now updates at commit time, matching what the
terms-of-service check in this app already does for the same reason.

**The last is a plain false alarm.** A tooltip passes a callback down to whatever
element it wraps so it can find that element on screen. Nothing reads the value
at that moment — React calls the callback later, once the element exists. The
tool cannot tell that apart from handing out a value to be used immediately.

No intended change to what the app does — none of this alters a feature or a
rule. One of the three fixes does change observable behaviour, though, and
saying "no behaviour changes" would deny the very bug it repairs: under the old
mid-draw update, a wallet switch that the browser started preparing and then
abandoned could make a transaction already in flight look irrelevant to itself
and bail, leaving its button spinning after the transaction had actually
succeeded. That button now clears.
