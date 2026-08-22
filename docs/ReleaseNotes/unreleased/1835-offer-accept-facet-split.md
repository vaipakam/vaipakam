## Contracts — the accept path can be changed again (PR #1836)

`OfferAcceptFacet` had reached 24,412 bytes against the 24,576-byte on-chain
limit. The 164 bytes left were less than one cross-facet call costs, so the
accept path had stopped being editable: any change to it — including the
pre-mirroring sale-listing refusal this unblocks — compiled fine and then
could not be deployed. This is the same wall `EarlyWithdrawalFacet` hit at 30
bytes, and the fix is the same shape: move a piece of the work to its own
facet rather than trim behaviour to fit.

The piece that moved is the borrower's Loan Initiation Fee charge and the
delivery of the net principal — the last money movement of an acceptance. It
was chosen because the acceptance **already** ran it in a separate execution
context: the accept had long reached it through an internal self-call, so that
the fee work's own depth would not be charged to the accept's call frame.
Moving it means the step now lives at a different address on the far side of a
boundary the code was already crossing on every accept. Nothing about the
observable sequence changes — same order, same shared state, same single
transaction, and a failure anywhere past the boundary still unwinds the whole
acceptance. Callers see no difference at all: they still send one transaction
to the one platform address, and the function's on-chain identity is unchanged
by the move.

Deployment shape is what changed. The platform now installs one more facet, so
every place that enumerates facets — the deploy script and the two refresh
scripts, the deploy-time guardrails, and the deployment record consumers read
— names it. The two halves must always be installed and refreshed **together**:
they are one behaviour separated by a call, so a partial refresh would leave an
acceptance running new code on one side of that call and old code on the
other. The refresh scripts carry both for exactly that reason, and the one
curated script that reinstalls the accept path re-points the moved step onto
its new host, so a platform upgraded from before this change does not strand it
on the old one.

Resulting sizes: 21,071 bytes for the accept facet (3,505 free, up from 164)
and 4,390 for the new one. `OfferAcceptFacet.chargeBorrowerLifAndDeliver` is
not a surface any app called — it rejects every caller except the platform
itself — so no application-facing behaviour is affected.

Closes #1835's blocking prerequisite; the refusal itself follows in its own
change.
