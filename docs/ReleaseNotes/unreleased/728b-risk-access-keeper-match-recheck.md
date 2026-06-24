## Thread — Progressive risk access: keeper-match re-assertion (PR #<n>)

Phase 2 of #671 (#728), PR-2b. The progressive-risk gate now also runs on the
**keeper-driven matching** path. When a keeper pairs a standing lender offer with
a standing borrower offer, the protocol re-checks the resulting loan against the
live tier/consent state — at the matcher, before any funds move.

This closes the gap the acceptor-side gate (PR-2a) left open. That gate runs
only on the direct-accept path, where one party signs an acceptance; a keeper
match authors no such signature, so neither side was being re-validated at match
time. The check is evaluated against the **current** state rather than the
snapshot taken when the offers were posted: an offer can outlive the conditions
it was posted under — the gate may have been switched on after it was created, or
its creator may since have dropped their vault tier, revoked an illiquid-pair
consent, or gone stale after a risk-terms-version bump. Without a re-check at the
matcher, a keeper could settle a loan that the parties would not currently be
allowed to originate.

For an ordinary match, **both** offer creators are checked against the **borrower
offer's** pair — which is the pair the resulting loan actually carries, because
the match builds the loan from the borrower offer (its token ids and prepayment
token win over the lender offer's). Checking the actual loan pair, rather than
each offer's own declared pair, means the lender must satisfy the gate for the
position it really joins, not a looser pair it happened to advertise. When the
borrower offer is a protocol-mediated **loan-sale vehicle**, the split matches
the direct-accept semantics: the exiting seller is exempt (that risk was accepted
at the original loan) and only the incoming buyer is checked, against the assets
of the loan being sold.

To keep keeper bots from burning gas, a read-only **companion preview** reports
whether a candidate match would be blocked by this gate, and why (tier too low
versus illiquid pair needing consent), so a match the gate would revert is never
quoted as matchable.

The riskier of the two legs governs and NFT rentals are tiered off their
value-bearing prepayment token, identical to every other entry point. Each gated
party is checked as a standing participant — there is no acceptance signature on
this path, so nothing substitutes for a missing tier or consent. As with the rest
of #671, the whole check is behind the off-by-default `riskAccessGateEnabled`
master switch and is a no-op when it is off. Part of #671 / #728 (does not close
them).
