## Thread — P2-w1: the V3 broadcast carries the day's frozen lapse clock (PR #TBD)

First build slice of the #1434 P2 zeroed-day lapse mechanisms (design
record: Vpfi1434P2ZeroedDayMechanismsDesign.md §1.1/§1.2, slice 1 of §8).
The Base→mirror day broadcast gains a NEW wire generation that carries the
day's finalization clock facts: the finalization timestamp, the
lapse-schedule version in force at that moment with its two parameters
inline (lapse window, dispatch-cutoff gap), the destination's
deliberately-zeroed marker, and the identity of the Base deployment that
finalized the day. Every one of those facts is frozen ONCE at
finalization and only read back at send, so re-broadcasting a day is
deterministic by construction — an operator clearing the zeroed chain's
remit-ineligibility or creating a newer schedule version between two
sends can no longer change what the wire says. The old wire generation
stays accepted unchanged: an in-flight pre-upgrade packet still applies,
just without a clock, and a day finalized before the upgrade keeps
broadcasting on the old wire (it has no authentic clock to send).

The lapse schedule itself becomes a versioned, append-only table behind a
bounded admin setter (window 3–30 days, gap 6 hours–7 days, window at
least 48 hours above the gap — a version that would place the dispatch
cutoff at or before finalization is refused, never stored). Each
finalized day prices its clocks under the version frozen at its
finalization forever.

Mirror-side, the new ingress installs the clock beside the day's figures
with three protections: era binding (a delayed broadcast from a retired
Base deployment cannot install its clock into the new era), a
divergence check extended to every frozen clock fact on re-delivery, and
a clock-backfill branch for days whose figures were already applied by
the old wire — it verifies only the immutable global pair and writes
only the clock, so the one supported migration sequence stays healable.
A new permissionless single-destination re-broadcast heals a clockless
day even for a mirror that has been removed from the current broadcast
destination list, admitted on the destination's day-scoped historical
standing.

This slice is wire + storage only: the lapse terminals, the zeroed-day
suppression gate and the compensation remit tag are later slices
(w2–w4). Until they land, the clock facts are recorded and verifiable
but nothing lapses and no pricing changes. Part of #1434 (P2); the
umbrella recycling programme is #1349.
