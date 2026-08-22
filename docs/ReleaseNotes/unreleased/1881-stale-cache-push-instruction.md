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
is not something the button fixes, and restoring it takes two separate things.
Your standing with the protocol has to differ from whatever you last sent
ANYWHERE — the check is one per person, not one per chain, so a chain that was
added later or that missed a delivery will not get a replacement copy just
because it is behind — and it has to still be good enough to earn a discount, since dropping below the
lowest band or switching the discount off is a difference that gets sent
faithfully and leaves you no better off. And then something has to actually send
it: changing your standing does not broadcast anything on its own, so a push is
still required to carry it. Note that a governance change to the tier table
counts as a difference even when nothing about you has moved.

It also says plainly that there is no supported way to force a refresh
otherwise, and why: manufacturing broadcasts by toggling a value back and forth
drains a protocol-funded budget, and once that runs out legitimate broadcasts
fail for everyone. A workaround that is harmless once and harmful at scale does
not belong on a page anyone can read.

The button's other two uses — a newly activated tier, and crossing into a higher
one — are correct and unchanged. Only the stale-cache case was wrong.
