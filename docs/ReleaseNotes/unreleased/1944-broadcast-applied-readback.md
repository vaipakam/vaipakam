# The arming ceremony can now read whether a chain already applied a day

Before a cross-chain reward day can be used to carry the recycling cutover
date, the operator has to pick a day that the target chains have not already
applied. That matters because applying a day is one-way: a chain that has
already applied a day treats a later re-send of the same day as a duplicate
and takes no further action from it — so the cutover date riding on that day
never lands, and that date can only be chosen once.

Until now the only way to find out whether a chain had already applied a
given day was to search back through its published event history. That is a
poor way to answer a question the ceremony asks under time pressure, and it
fails in the worst possible direction: a search that quietly misses part of
the history reports "not applied", which is exactly the answer that wastes
the candidate day.

Each chain now publishes that state directly, per day, as a public read. The
operator can check every target chain immediately before sending, and line up
several candidate days in advance, without reconstructing history.

This is a read-only addition. It does not change how days are applied, does
not change what a duplicate does, and does not by itself remove the
underlying constraint that a day already applied cannot carry the cutover
date — it makes the existing workaround dependable instead of best-effort.
The durable fix for that constraint is still open and wants its own design
pass.

Issue: #1944
