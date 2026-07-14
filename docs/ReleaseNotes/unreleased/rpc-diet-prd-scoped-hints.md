# RPC read-diet PR D — scoped push hints with causative context

Final slice of the read-diet design. Push invalidation frames now
carry a bounded list of the loan and offer ids the scan actually
touched, plus the causative linkage for creations (which offer was
consumed and who the parties are). A tab whose wallet provably has
nothing to do with a frame skips refreshing its own-position surfaces
for it; shared surfaces (books, tape, activity) refresh as before.

The contract is truncation-honest end to end: hints only ever narrow
work when they are complete. A busy scan past the id cap, any event
whose affected row cannot be identified centrally (position-NFT
transfers, signed-offer lifecycle), an older worker without hints, a
malformed field, or a tab that cannot derive its own id sets — all of
these degrade to today's coarse behaviour. Scoping can only remove
redundant refreshes, never suppress a needed one. The launch cap is a
conservative guess; a follow-up tracks re-tuning it from real
per-scan volume once rehearsal load exists.
