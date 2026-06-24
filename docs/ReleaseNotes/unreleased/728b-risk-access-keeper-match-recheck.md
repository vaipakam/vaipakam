## Thread — Progressive risk access: keeper-match dual-creator re-assertion (PR #<n>)

Phase 2 of #671 (#728), PR-2b. The progressive-risk gate now also runs on the
**keeper-driven matching** path. When a keeper pairs a standing lender offer with
a standing borrower offer, the protocol re-checks **both** offers' creators
against the live tier/consent state — at the matcher, before any funds move.

This closes the gap the acceptor-side gate (PR-2a) left open. That gate runs
only on the direct-accept path, where one party signs an acceptance; a keeper
match authors no such signature, so neither side was being re-validated at match
time. A match is two self-authored offers meeting, so the right check is to
re-assert each offer against the party who created it — exactly mirroring the
create-time gate, but evaluated against the **current** state rather than the
snapshot taken when the offer was posted.

Why re-check rather than trust the create-time gate: an offer can outlive the
conditions it was posted under. The gate may have been switched on after the
offer was created; the creator may since have dropped their vault tier, revoked
an illiquid-pair consent, or gone stale after a risk-terms-version bump. Without
a re-check at the matcher, a keeper could settle a loan that neither creator
would currently be allowed to originate. Re-asserting both creators at match
time catches all of those before the loan is admitted.

The riskier of the two legs governs and NFT rentals are tiered off their
value-bearing prepayment token, identical to every other entry point. Each
creator is gated as a standing participant — there is no acceptance signature on
this path, so nothing substitutes for a missing tier or consent. As with the
rest of #671, the whole check is behind the off-by-default `riskAccessGateEnabled`
master switch and is a no-op when it is off. Part of #671 / #728 (does not close
them).
