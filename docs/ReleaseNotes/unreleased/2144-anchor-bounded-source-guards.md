## Thread — The drive's source guards are bounded by meaning, not by character count (PR #TBD)

Parts of the drive that reviews the deployed build cannot be run from a
unit test, because importing the file runs the whole drive. Those parts
are checked by reading the drive's own source instead, and each such
check needs a region of that source to reason about. Several still took
their region as a fixed number of characters from a starting point, which
is wrong in both directions and moves with edits that have nothing to do
with the rule being checked. Too short, and the check is blind to the end
of the region while looking exact: one such check counted the assignments
recording an outcome, found two where there are three, and asserted that
count as exact, so deleting the very line it exists to protect would have
left it passing. Too long, and a rule about one region silently starts
matching its neighbours.

Every such region is now bounded by something that means the region has
ended — the statement it belongs to, the block it opens, or a named
landmark in the code that follows it. The helpers refuse to return
anything when a landmark is missing, or when the closing one does not
follow the opening one; that last case would otherwise hand back an empty
region, and a rule asserted over nothing passes by checking nothing,
which is the failure this whole family exists to refuse.

Review caught the same mistake three times, and the third time is what
changed the approach. Each attempt established that the conversion was
complete using something that read the file as plain text, and each
reader was narrower than what it was looking for. The first missed
several windows because it insisted they start a particular way. The
second could not see a window written across four lines, because it
stopped at the first closing bracket it met. The third, a hand-written
reader of its own, missed a bound hidden behind a comment, a bound
written as text rather than as a number, and a bound given a name — and
quietly skipped any call whose brackets it could not pair up, so ordinary
formatting was enough to slip past it.

Each fix was correct and the next gap was already waiting, because
"where does this piece of code end" is a question the language's own
grammar answers, and a reader assembled by hand is a worse answer to it
every time. So these checks no longer read the file as text. They parse
it, the way the language itself does, and every region is a piece of the
parse rather than a stretch of characters. Quotes, comments, patterns and
the punctuation that means two different things stop being special cases
to remember.

That also fixed a fault the hand-written reader had been shipping: a
declaration containing a search pattern was cut in half, and one
containing an unbalanced bracket was reported as having no end at all —
the same silent truncation this whole effort exists to remove, produced
by the tool meant to remove it.

The completeness claim is now made by the suite rather than in prose, and
it is made the safe way round: rather than working out which values hold
source code and checking only those — a question with no bounded answer,
and every gap in it a hiding place — it checks every such bound in the
family, and the handful that legitimately count characters say so in a
short note at their own declaration, naming what they count. Nine of
those became three notes, because saying it once per reason is also how
a fourth gets noticed. Putting a removed window back, in any of the four
disguises review demonstrated, turns the suite red.

Three of the windows survived the earlier passes for a reason worth
naming: they bounded a declaration spread over several lines, which is
neither a block nor a call, so there was nothing to convert them to. That
missing bound now exists — a region may be taken as the statement it
belongs to, ending where that statement ends.

The effect is that these checks now fail when the thing they describe
changes, and not when the file grows. A check that fails because a file
got longer teaches nothing, and trains the next reader to widen the
number rather than ask what it was supposed to bound.

Closes #2144. No product surface changes.
