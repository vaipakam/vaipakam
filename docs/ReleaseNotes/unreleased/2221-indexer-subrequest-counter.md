### The indexer now counts the requests it makes, instead of estimating them

Each run of the indexer is allowed a fixed number of outbound requests before
the platform stops it. Until now, the indexer did not count them. The figure
lived in a note written by hand, and that note was corrected three times in
three consecutive reviews — and was wrong each time. Every correction came from
a person re-reading the sum, because nothing in the running system knew the
number.

Being wrong about it has a specific cost. Going over the allowance does not make
a run slower; it stops the run before it records how far it got. The next run
starts from the same place and does the same thing, so a chain can stop moving
forward entirely while appearing to run normally.

The indexer now keeps a live count. Every request it issues is counted as it
happens — reads from the chain and reads and writes to its own database alike —
and each run reports what it actually spent. When a run does pass the ceiling,
it now says so plainly, naming the chain, rather than leaving a stalled chain to
be noticed later.

Two details are worth stating because they are what made hand-counting
unreliable in the first place. Several database statements sent together travel
as a single request, not one each, so they are counted once. And a statement
that is prepared but never sent on its own costs nothing. A count that got
either of those wrong would be a confident number that was still incorrect,
which is what was there before.

The counting is built into the connection the indexer uses rather than written
beside each place a request is made. That is deliberate: this part of the system
makes requests from well over a hundred places, and a list maintained by hand is
exactly what fails when someone later adds the hundred-and-twenty-first. A
request added by code that knows nothing about the allowance is still counted.

This is the groundwork for the allowance being enforced rather than only
observed. The figures the indexer works to are still the conservative ones set
while the true cost was unknown; now that it can be measured, they can be set
from evidence.
