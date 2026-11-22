## Thread — repatriation returns and ceremony inflows recorded as packets

Every value-bearing reward arrival on the canonical chain is now recorded
as an ingress packet before it is credited. Deliveries, compensations and
stranded returns already were. Two arrivals were not: the planned-surplus
repatriation return, and the value a recovery ceremony brings back. Both
credited the books with no packet record, so they had neither the audit
trail the other arrivals carry nor the guard that refuses a second
landing under the same identity.

A repatriation return is now recorded under its transport identity: the
return receiver passes on the cross-chain message id it already had, and
the canonical chain records the arrival as a new packet kind before
crediting it to the recycle bucket. The whole arrival is recorded as
recycled value, as it was absorbed on the mirror. A second landing under
the same identity is refused whole and can be re-executed. The receiver's
wire generation goes up by one because its call into the Diamond changed.

A recovery-ceremony inflow is recorded as its own packet kind every time,
whether fresh, recycled or both, and whether it settles a local
reservation or one imported from a retired deployment. No transport
carries a ceremony, so its record is keyed by the platform's own sequence
and names the reservation it settles. Before this change the recycled half
of a ceremony, and a fresh inflow for an already-attributed receipt, left
no record at all.

These records are for audit and replay protection only. They hold nothing
in the unclassified row. Every step that reads the packet record now names
each kind it accepts: the reconciliation classification refuses the two new
kinds by name, the return of an untyped remainder accepts only a budget
delivery (so a ceremony record, which has no source chain, can never be
sent anywhere), and a kind the record does not know is refused rather than
read as a default.

Closes #2204
