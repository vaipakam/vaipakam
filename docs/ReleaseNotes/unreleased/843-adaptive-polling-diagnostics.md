## Thread — Realtime push Phase B: adaptive polling + live-updates diagnostics (PR #845)

The connected app now spends less RPC and Worker budget while the realtime
WebSocket push channel is healthy. Previously the watermark poll kept running at
its full per-view cadence (as fast as every 5 seconds for a hot Offer Book) even
when the push channel was already delivering near-instant invalidation signals —
so the investment in push from the earlier Phase B work wasn't actually reducing
background polling. With this change, whenever the push transport is `live` the
poll relaxes to a 60-second backstop floor (a 12× reduction for the hottest
view); any disconnect, fallback, or chain switch restores the normal tier
cadence immediately. Correctness is unchanged — the poll only ever slows as a
backstop, never stops, and the push carries a signal only, never authoritative
data.

The diagnostics drawer gained a "Live updates" section so an operator or
power-user can see, at a glance, why the app is as fresh as it is: the transport
state (live / polling / reconnecting), the age of the last push event, a
session reconnect count, the effective poll interval (and whether it is
push-backed), and the measured push-to-refetch latency. The latency is anchored
to the moment the invalidation frame arrived — including any debounce and any
wait behind an in-flight probe — so it reflects what the user actually
experiences rather than under-reporting. All of these readings reset cleanly on
a chain switch so the drawer never attributes the previous chain's freshness,
reconnect count, or latency to a newly selected one, and the reconnect count
increments only when an established-live channel actually drops, not on every
failed retry during an outage.

Closes #843. The remaining Phase B polish items — narrower, slice-specific
invalidations and the diagnostics surfacing of dropped/duplicated frames — were
split out to #844 so this card could close on the adaptive-polling +
diagnostics deltas alone.
