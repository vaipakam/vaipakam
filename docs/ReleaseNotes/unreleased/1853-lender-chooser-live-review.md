## The lender chooser's live review stops guessing at what it cannot see

The post-deploy review for the lender exit chooser drives the real page against
the live chain: it finds a wallet that actually holds lender positions, opens
each one, checks that the chooser card renders with all three of its options
explained, then switches the page into Advanced mode and exercises every jump
button the card offers.

Most of the work in this change is about a single question the review kept
answering badly: what does it mean when the card offers no way through to the
sale tools? That happens for two completely different reasons — the card is
still waiting on a read it needs, or there is genuinely nothing to jump to — and
from outside the card those look identical. The review used to wait forty-five
seconds and then assume the second one. On a chain where nearly every lender
position is past its due date, which is the situation today, that was both slow
and unsound: a real regression that hid the Advanced-mode switch would have
looked exactly like the ordinary, correct case.

The card now states its own answer, and the review reads it instead of
inferring. Where the card says it has settled and has a row worth jumping to,
but offers no way to reach it, that contradiction is reported as a product
failure — the check this review was always supposed to make and could not. Where
the card says it is still working, the review keeps waiting rather than
concluding. Where a read the card depends on stopped without answering, the run
ends as "could not observe" rather than "observed nothing wrong". And where the
deployed page is an older build that publishes no answer at all, the previous
behaviour is kept unchanged, so a deployment lagging behind a merge is never
reported as a defect.

### Measuring the jumps instead of trusting them

The other substantive change is to how the jump buttons are checked. The review
used to confirm that the anchor each row *should* lead to existed somewhere on
the page. That passes in exactly the situations worth catching: with both
targets present — the normal case — the two buttons could lead to each other's
destination, or to nothing at all, and the check would still be satisfied.

Each button is now clicked, and where it actually took the reader is recorded
and compared against where that row promised to go. A button that lands
somewhere else is named along with where it went, rather than being reported as
a missing element the reader would then fail to find. Buttons are counted
individually rather than per row, so a duplicate control cannot hide behind its
neighbour.

### What the review refuses to call a pass

Several outcomes that used to end a run cleanly now end it as an
unfinished observation, which is the more honest verdict and the one this
project keeps having to relearn:

- The reviewed position moved while the review was watching — sold, repaid,
  matured, or the status briefly left Active and returned. A card correctly
  withdrawing its options during that window is not a regression, and the review
  now samples the chain during its own wait so it can tell the difference.
- The card belongs to a wallet that no longer holds the position. It stays on
  screen for up to a minute after ownership moves, so a successful-looking
  review can be a review of somebody else's position.
- The card was seen and then vanished. Nothing in a before-and-after comparison
  can detect a change that reversed inside the window; only the disappearance
  itself can.

### A note on how the defects were found

The comparison the whole Advanced verdict rests on had shipped through four
review rounds without ever running, because the live chain never presents the
state that reaches it — every "re-ran live, clean" had skipped the code being
changed. Moving that logic into its own module with its own tests found, on the
first run, that it could never have worked. The rules added since — what a
missing switch means, when a mid-review transition explains an outcome — live in
that same tested module for the same reason, rather than as assertions inside a
driver that cannot be exercised.

The reporting layer that decides which observations become failures still has no
such seam, and remains the place where defects are found by reading rather than
by running. That is tracked separately (#1861).

Closes #1853.
