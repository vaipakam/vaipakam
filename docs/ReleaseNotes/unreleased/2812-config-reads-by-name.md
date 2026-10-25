## Thread — Configuration reads by name, at their own shape (PR #2839)

The app, its protocol console and the indexer now read the protocol
configuration bundle field by field, by name, and only when the chain's
answer has the shape they were built for. Retiring the range flags took two
values out of the middle of that bundle, which moved every value after them.
Until now the app took the offer-duration cap from a fixed position. On a
Diamond still running the older configuration facet, that position would
have held a different number, on the screen and in the check made before
signing. The same was true of the indexer's snapshot and the console's
labels.

Every reader now checks the length of the answer first. If the length is
not the one its own build describes, the answer comes from a facet it was
not built against, so the reader reports the figures as unknown and gives
the reason instead of decoding them. A signing step refuses, as it would
on any failed read. A display keeps its stated default and stays marked as
not ready. The indexer's snapshot records why it holds no figures for the
bundle, while the grace schedule, the pause log and the other settings are
still captured. The snapshot endpoint no longer serves the retired
three-flag list. The matching switch is now one of its named values, and
the app reads it from its own getter, which answers the same on every build.
The protocol console shows that switch as the one remaining feature flag
and says what it does.

Until the testnets get the next fresh deploy, they still run the older
facet. In that window the indexer stores their bundle as unknown, and the
app deployed there today, which still expects the retired list, falls back
to its own chain reads. Dropping the two unused snapshot columns
(#2840) and bringing the same shape check into the live test drives (#2841)
are follow-ups. Refs #2812.
