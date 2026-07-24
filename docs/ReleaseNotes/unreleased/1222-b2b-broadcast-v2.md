## Thread — Per-destination day broadcast + canonical consumer pricing (PR #TBD)

The recycling mesh's day broadcast evolves — once — into a per-destination
shape, and the canonical chain begins pricing its own rewards and
remittances from per-chain funding stamps (#1222 M3 B2-b).

Each post-cutover day's broadcast now carries, per mirror, that chain's
OWN funded figures: its per-side fresh floors, its side-specific recycled
equivalents (the numerators that make the existing claim arithmetic pay
exactly that chain's funded budget), a reserved consume-instruction field,
and a reserved keeper-allocation field. Every packet embeds its
destination chain identity and a mirror rejects packets not addressed to
it, so a delayed delivery or replay can never apply another chain's
figures. The same evolution folds in the long-planned cap-family fields:
pre-cutover days ship the legacy threshold, post-cutover days ship
per-side daily user ceilings computed once on the canonical chain —
closing the documented gap where mirrors had no cap family for
post-cutover days.

The canonical chain's finalization now runs the per-chain funding
resolution live: each chain gets its own funded per-day stamp, the
canonical chain prices its own claims and remittances from its stamp
(never the summed aggregate, which stays a metric), and per-side daily
ceilings replace the former single shared value. On a single-chain
deployment every figure equals the previous single-pool behaviour exactly.

**Scope boundary (deliberate).** The mirror-side half of the mesh — a
mirror consuming its own recycled bucket to fund its slice, and the
two-sided netting that pairs it with the canonical ledger — is **not**
turned on here. Making that safe requires tracking each mirror's actually
delivered recycled backing (its own surrendered slice plus received
cross-chain remittances); enabling mirror consumption before that backing
is tracked would let a mirror pay rewards from value still in transit and
report availability it does not yet hold. So until the delivered-backing
ledger lands in the next mesh stage, the canonical chain funds the whole
mesh budget: mirrors receive their funding entirely by remittance, the
per-destination stamp + cap family ride the wire ready for the next stage
to arm against, and no mirror is instructed to consume its bucket. The
distribution-coupling cutover remains gated on the full mesh being
deployed, so none of this is reachable on the current single-chain
testnet.

Rollout keeps every upgrade-order combination live: mirrors still accept
the legacy shared broadcast, the canonical trigger falls back to the
legacy send when its transport predates the evolution, and a
per-destination packet to a not-yet-upgraded chain stays a failed,
re-executable delivery. Part of #1222; carries the #1351 cap-family (2g)
tail.
