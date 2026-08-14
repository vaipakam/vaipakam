# apps/defi: nine "reading a ref while rendering" complaints, sorted into two real fixes and seven deliberate designs

The lending app's linting flagged nine places that touch a short-term scratch
value — the kind of holder a component uses to remember something across
renders without redrawing when it changes — while the screen is being drawn.
The tool treats every one of these as a fault. Seven of them are not, and this
change is mostly about writing down which is which, so the next person to see
the warnings does not "fix" a guard that exists on purpose.

**Two were genuine and are now fixed.** The active-offer list and the loan list
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
that reason. A sixth keeps the current wallet-and-chain identity where
already-running background work can check whether it is still relevant before
applying its result; moving that update later would leave a gap in which work
started under the *new* identity compares against the old one and cancels itself
for no reason.

**The last is a plain false alarm.** A tooltip passes a callback down to whatever
element it wraps so it can find that element on screen. Nothing reads the value
at that moment — React calls the callback later, once the element exists. The
tool cannot tell that apart from handing out a value to be used immediately.

No behaviour changes.
