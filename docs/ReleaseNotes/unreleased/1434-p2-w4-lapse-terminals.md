## Thread — P2-w4: the lapse terminals, the one-in-flight gate, and the supplemental top-up (PR #TBD)

Fourth build slice of the #1434 P2 zeroed-day lapse mechanisms (design
§3, §5.1, §5.2, §2.5 — slice 4 of §8). The deferral states the earlier
slices created now have guaranteed, permissionless exits.

A never-compensated zeroed day whose frozen expiry passes takes the
FULL lapse: it retires at zero through the ordinary pricing machinery,
the cursor advances past it, and the loss is recorded at the terminal
itself — from the completed quote when one stands, else from the
accumulator's partial progress flagged as partial, never by an inline
scan that could make the guaranteed terminal itself run out of gas.
The record is non-blocking bookkeeping: it gates nothing and a later
completed accumulation may refine it.

A compensated day still funded below its quote after a bounded
deadline takes the SHORT lapse: pricing switches from
defer-on-shortfall to a pool-scaled delta, so every settlement path
pays proportionally within delivered funding and the cursor advances.
The deadline is absolutely bounded — a rolling window that only a
quarter-of-the-shortfall top-up extends, under a hard three-window
cap — so neither operator silence nor dust top-ups can park a day
(and every day behind it) unclaimable forever.

On the canonical chain, compensation dispatch gains the one-in-flight
gate: one outstanding compensation reservation per chain, cleared by
the consumption acknowledgement (or its operator-evidenced
equivalent), held by cancellations, with an enumerable
outstanding-chain inventory for rotation ceremonies. A consumed but
short delivery (fee-on-transfer, partial burn) now has its intended
remedy: the supplemental top-up funds the SAME receipt-bound
obligation — bounded per side by the standing quote cumulatively
across the original remit and every supplement — without touching the
day's closed markers; the mirror's deferral absorbs it naturally.

The activation precondition for these terminals is the legacy
migration: a pre-P2 manual remit carried neither the tagged wire nor a
per-side split, so an upgraded mirror could hold its value without a
priced compensation. An operator-evidenced stamp allocates such a
receipt pro-rata over the day's completed quote (one receipt, one
day), and a paginated canonical-side inventory lists reservations
matching the legacy shape — the arming checklist requires it to read
empty. No deployed environment holds any such receipt today.

Fitting the new surface within contract size limits also split the
remittance facet three ways: a read-only lens facet took the ledger's
view surface, a compensation-dispatch facet took the manual +
supplemental pair, and the shared dispatch primitives moved to one
library so the facets cannot diverge on them. Part of #1434 (P2);
umbrella #1349.
