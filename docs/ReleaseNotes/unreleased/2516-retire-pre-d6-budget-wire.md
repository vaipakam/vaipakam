## Thread — The rooted wire is the only reward-budget wire (PR #2669)

A mirror's remittance receiver now refuses every reward-budget payload older
than the rooted (d6) wire: the bare day list, the list with a receipt, and the
list with a stated split each revert with a named error before anything reaches
the platform, and the transport keeps the message for re-execution. No current
sender produces those shapes, and every chain running the transport-epoch slices
is a fresh deploy, so none is in flight anywhere. The owner chose to retire them
outright while the platform is pre-live (2026-10-22) rather than keep dormant
paths for a population that cannot exist.

Everything that existed only for those older deliveries is gone with them: the
canonical chain's split-attestation message and its fee quote (an arriving one
is now refused as an unknown message kind on the mirror), the flat-list day
writer, the flat-list proof for a delivery that holds no epoch, the
retrospective admission of an older delivery into the epoch ledger, and the
budget ingress for the flat-list wire. The receiver and the reward messenger
both move to generation 7. On a chain whose reward custody is activated, a rooted
delivery is attested by its own wire on arrival and opens a transport epoch;
before activation it is booked to the typed ledger from the split it carries.
Either way its days land one proven chunk at a time against the root: indexed
into its transport epoch when it holds one, or proven for the day-delivery gate
when it arrived before custody activation.
Compensation deliveries are unaffected.

The keeper's delivery-proof pass drops its flat route to match. It lists as work
only deliveries whose packet carries a stamped root, so a flat-list delivery is
never queued, and its only "already done" signal is a chunk already indexed. The
runbook, the keeper's README and coverage matrix, and the tokenomics spec now
describe the rooted routes only; the spec marks the old-wire bullets as
superseded, and the code-versus-docs audit records the owner decision behind the
spec change. Refs #2516, #1566.
