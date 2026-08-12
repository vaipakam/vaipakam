## Connected app — time-based readouts now advance on their own (PR #TBD)

Several parts of the connected app compare against "now": how long ago the
indexer last ingested, whether an offer has expired, whether a risk-tier
cooldown has lapsed. All of them read the clock while the screen was being
drawn, which sounds harmless and is not — it means the value was fixed at
whatever moment React happened to render, and then stayed there. A freshness
note could sit at the same age indefinitely, an offer already past its expiry
could keep occupying a tenor chip and a rung of the rate ladder, and a
cooldown that had in fact elapsed could keep reporting as still counting,
until something unrelated on the page forced a redraw.

These surfaces now read the time through a small shared clock that advances
every thirty seconds, so each of them reaches its own threshold on its own:
the age keeps counting, the expired offer drops out, the cooldown lapses on
screen. Thirty seconds is deliberately coarse — every one of these thresholds
is measured in minutes or longer, so a finer tick would cost redraws without
changing anything a user could see.

The order ticket is the one place that deliberately keeps reading the clock
exactly rather than on the tick. Its preset expiries ("24 hours", "7 days")
are relative to the moment you post, and the ticket already promised to
re-resolve that deadline fresh at submit so a form left open does not post a
stale one. The validation you see while filling the ticket in now follows the
ticking clock, while the deadline actually submitted is still resolved to the
second. As a side effect the preview numbers are steadier than before: each
recalculation used to take its own reading, so a preset expiry differed
slightly every time the preview was rebuilt.

With these cleared, the rule that forbids reading such values mid-render is
enforced as an error, joining the two rules promoted in the previous slices.
One suppression remains, on the submit path described above, and it records
why: the check cannot tell that the code runs from a button press rather than
during drawing, and following the tick there would be the regression.

Behaviour worth watching after release: anything that shows an age or hides an
expired row should now change without being prompted. The tick is real time
passing, which is why it is verified on the deployed site rather than in the
unit suite.
