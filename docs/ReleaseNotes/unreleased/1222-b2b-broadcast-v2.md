## Thread — Per-destination day broadcast + mesh consumer coupling (PR #TBD)

The recycling mesh goes live end-to-end (#1222 M3 B2-b): the two-pass
per-chain funding resolution that the previous stage computed as pure
records now drives the real ledgers, and the day broadcast evolves —
once — into a per-destination shape so every mirror receives its OWN
funded figures instead of one shared payload.

Each post-cutover day's broadcast now carries, per mirror: its per-side
fresh floors, its side-specific recycled equivalents (the numerators
that make the existing claim arithmetic pay exactly that chain's funded
budget), the slice it must surrender from its own recycled bucket, and
a reserved keeper-allocation field. Every packet embeds its destination
chain identity and a mirror rejects packets not addressed to it, so a
delayed delivery or replay can never apply another chain's figures. The
same evolution folds in the long-planned cap-family fields (#1351 2g):
pre-cutover days ship the legacy threshold, post-cutover days ship
per-side daily user ceilings computed once on the canonical chain —
closing the documented gap where mirrors had no cap family for
post-cutover days.

Consumers flip together, per a prior review round's finding that stamps
and consumers must switch atomically: claim accumulators on every chain
(canonical included) price armed days from that chain's own stamp, the
day-level aggregate becomes a metric only, and per-side daily ceilings
replace the former shared value. Reservations split by funding source —
the global ledger holds only canonical-funded shares, while each
mirror's locally-funded share is booked consumed at finalization and
surrendered by the mirror's bucket exactly once at broadcast arrival
(whole-day idempotent, so re-deliveries can never double-debit).
Mirror-side recycled claim legs stop debiting the local bucket (they
are funded by the arrival surrender plus remittances, with skipped
amounts publicly counted), and remittances now ship only the
canonical-funded share of a mirror's recycled budget — the
locally-funded share already sits there.

Rollout keeps every upgrade-order combination live: mirrors still
accept the legacy shared broadcast, the canonical trigger falls back to
the legacy send when its transport predates the evolution, and a
per-destination packet to a not-yet-upgraded chain stays a failed,
re-executable delivery — arming the distribution cutover remains gated
on the whole mesh decoding the new shape. On a single-chain deployment
every figure equals the previous behaviour exactly. Part of #1222;
completes the #1351 (2g) tail.
