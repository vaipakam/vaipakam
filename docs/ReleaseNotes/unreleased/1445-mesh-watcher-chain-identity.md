### The mesh monitor now checks that each endpoint is the chain it is configured as

The monitor that watches every reward chain's recycled accounting reads
each chain through an operator-supplied endpoint, paired with that chain's
committed contract address. Until now nothing confirmed the endpoint was
actually the network it was configured for. A single mistyped or stale
setting — a copy-paste during setup, or a value left behind after a chain
migration — was adopted without complaint, and every figure read through
it was recorded under the configured chain's name.

The noisy version of that fault was survivable: reads fail, and the
failure surfaces as a gap in coverage. The quiet version was not. If the
contract address happens to hold compatible code on the wrong network,
every check runs to completion against an unrelated chain's books and the
monitor reports a clean tick. A watcher that is confidently silent about
the wrong subject is worse than one that is merely down, because nothing
downstream has any reason to look.

Each tick now asks every endpoint which chain it is and compares the
answer to the configuration. A disagreement is reported as its own kind of
problem, separate from an unreachable endpoint — the distinction matters
because the endpoint here is working perfectly, so every instinct about
providers, quotas and outages is the wrong one, and the fix is the
setting. The message names both the chain that was expected and the chain
that answered, so the wrong setting is identified rather than merely
suspected.

What happens next depends on which chain it is. A mismatched secondary
chain is dropped from that tick and compared against nothing — the same
treatment a chain serving an old block already gets, and for the same
reason: comparing an unrelated chain's ledger against the main one would
raise a false alarm of the most serious kind. A mismatch on the **main**
chain stops the tick outright, because every figure the tick rests on is
read through that one connection; a wrong main chain does not weaken the
result, it voids it.

The check rides along with a request each path already makes, so it adds
no waiting.

One limit is worth stating rather than leaving to be discovered: the
tests cover the identity check itself — that it detects a mismatch, names
both chains, keeps the distinction from an unreachable endpoint, never
leaks the endpoint's credentials into an alert when it fails, and never
aborts the run. They do not cover the surrounding wiring, which has no
test harness able to stand in for real network connections. That part is
reviewed rather than tested, and it is now the monitor's remaining
untested seam.

Closes #1445. Follows from #1443, under the #1222 mesh work and the #1349
umbrella.
