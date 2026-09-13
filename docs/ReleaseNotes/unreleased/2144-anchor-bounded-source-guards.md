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

Every remaining region is now bounded by a second anchor: something in
the code that means the region has ended, such as the declaration that
follows it. A new helper takes a region between two anchors and refuses
to return anything when either anchor is missing, or when the closing one
does not follow the opening one — that last case would otherwise hand
back an empty region, and a rule asserted over nothing passes by checking
nothing, which is the failure this whole family of helpers exists to
refuse. Regions that are brace-delimited blocks use the existing
block helper rather than a second anchor.

The effect is that these checks now fail when the thing they describe
changes, and not when the file grows. A check that fails because a file
got longer teaches nothing, and trains the next reader to widen the
number rather than ask what it was supposed to bound.

Closes #2144. No product surface changes.
