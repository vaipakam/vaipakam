## The guide told users to press a button that does nothing in the state it was offered for (#1881)

The Advanced guide explained that a discount cached on another chain goes stale
after a couple of months, and that it comes back "until a fresh push lands" —
read alongside the two places the same guide offers a button to push your tier to
other chains, that reads as an instruction: your discount lapsed, press this.

Pressing it does nothing in exactly that situation. The push only sends when
something about your tier has actually changed; an unchanged tier is skipped
silently, nothing is broadcast, and the reader is left where they started while
believing they have fixed it.

The passage now says so directly: an expired cache on a tier that has not moved
is not something the button fixes, and the discount returns only when a later
broadcast carries a tier that has both CHANGED and still qualifies for a
discount. Neither half is enough alone: an unchanged tier is skipped and sent
nowhere, so an ordinary same-size deposit does nothing; and a change that drops
you below the lowest tier, or switches the discount off, is broadcast faithfully
and leaves you exactly where you were.

It also says plainly that there is no supported way to force a refresh
otherwise, and why: manufacturing broadcasts by toggling a value back and forth
drains a protocol-funded budget, and once that runs out legitimate broadcasts
fail for everyone. A workaround that is harmless once and harmful at scale does
not belong on a page anyone can read.

The button's other two uses — a newly activated tier, and crossing into a higher
one — are correct and unchanged. Only the stale-cache case was wrong.
