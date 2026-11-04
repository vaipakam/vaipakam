## Mesh watcher — one request per Diamond, fewer alert messages

The mesh watcher now reads every view it needs from a Diamond in a single
call, through the standard Multicall3 contract, at the block the tick has
pinned. Before, each view was its own request. On the live testnets a tick
went from 17–18 requests to 6–7, and the figures it observed were identical
on all three chains. The free Workers plan allows 50 requests per run, so
the watcher now has wide headroom: even reading the whole mesh in one tick
would take about 15. The one-chain-per-tick rotation stays, because it keeps
each tick's cost flat as mirrors are added.

Each view still fails on its own. A view that reverts, which is how a
selector missing from a Diamond's current cut shows, or one whose answer
does not decode, costs only the checks that need it, as before. Only a
failure of the whole call makes the chain unreadable for that tick, and it
is reported as a coverage gap, never as a pass. That includes a chain where
Multicall3 is not deployed. It is deployed on every chain the mesh runs on
today.

Alerts are packed too. One Telegram message now carries as many findings as
fit, instead of one message per finding, so a burst of alerts cannot use up
a tick's requests. Critical and advisory findings are never mixed in one
message, so a critical still notifies and an advisory stays silent.

CPU per tick also fell, from about 40–50 ms to about 15 ms when run in
Node. That is a guide, not a Workers measurement, and it is still above the
free plan's nominal 10 ms, which Cloudflare has so far allowed. The Workers
Paid plan remains the fix if ticks start being cut off for CPU.

Advances #1222 (M3 B4-c) and #1956.

> Caveat: a chain added to the mesh needs Multicall3 at its canonical address; without it that chain is reported unreadable on every tick.
> Caveat: the CPU figures are Node measurements, not Workers ones.
