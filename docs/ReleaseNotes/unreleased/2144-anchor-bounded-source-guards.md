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

Every such region is now bounded by a second anchor: something in
the code that means the region has ended, such as the declaration that
follows it. A new helper takes a region between two anchors and refuses
to return anything when either anchor is missing, or when the closing one
does not follow the opening one — that last case would otherwise hand
back an empty region, and a rule asserted over nothing passes by checking
nothing, which is the failure this whole family of helpers exists to
refuse. Regions that are brace-delimited blocks use the existing
block helper rather than a second anchor.

Review caught the same mistake twice, and the second time is the more
useful one. Both attempts claimed the conversion was complete on the
strength of a search written by hand, and both searches were narrower
than the thing they were looking for: the first demanded a particular
starting point and missed several, the second could not see a window
written across four lines because it stopped at the first closing bracket
it met. Each time the claim read as verified and was not.

So the claim is no longer made in prose. The suite asserts it: it reads
every check in this family, works out what bounds each region it takes,
and fails when that bound is a number rather than something in the code.
It reads the bound as a whole — however many lines and nested calls it
spans — and ignores numbers that appear inside quoted fragments of the
code being searched for, which is what a hand-written pattern could not
be trusted to do. Reintroducing one of the removed windows turns it red.

Three of the windows survived both earlier passes for a reason worth
naming: they bounded a declaration spread over several lines, which is
neither a block nor a call, so there was nothing to convert them to. That
missing bound now exists — a region may be taken as the statement it
belongs to, ending where that statement ends.

The effect is that these checks now fail when the thing they describe
changes, and not when the file grows. A check that fails because a file
got longer teaches nothing, and trains the next reader to widen the
number rather than ask what it was supposed to bound.

Closes #2144. No product surface changes.
