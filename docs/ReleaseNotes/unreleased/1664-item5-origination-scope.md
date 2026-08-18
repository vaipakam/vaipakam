## Copy about an existing loan's fee no longer presents the current rate as that loan's rate

The protocol stamps its fee percentages on a loan when the loan is created, so
a later change to the protocol fee never re-prices a loan that is already
open. Two passages in the user guide — both explaining what a lender's claim
on a settling loan pays out — quoted the treasury cut using the same live
figure the rest of the documentation uses for current rates. After a retune,
a reader holding an older position would have seen the new rate presented as
their loan's cut, while the contract kept using the one stamped when their
loan was created.

Both passages, in all ten languages, now say the percentage was fixed at the
loan's creation and that a later protocol change does not touch it, and
present the live figure only as what loans created at the current rate carry.
The figure stays on the page and stays live — it is useful context — but it
no longer claims to describe the reader's existing position.

A third passage using the same figure was examined and deliberately left
alone: it describes what a lender accepting an offer now will earn, and a
loan created by that acceptance stamps the current rate, so the live figure
is exactly right there. The distinction the specification now records is
whether the reader is being told about a position that exists or one they are
about to create.
