## Thread — Protocol two-chain reward and VPFI scenarios (PR #<n>)

A new test suite, `packages/protocol-e2e`, drives the protocol's
cross-chain positive flows on two local Anvil chains, a canonical Base and a
mirror, built from the repository's current contracts on the shared harness.
It covers a full reward day on both chains: each chain reports, Base
finalizes the global figures from both reports and broadcasts them, and
lender and borrower claim on Base. The mirror's budget is remitted over the
real VPFI token pools, indexed on the mirror and claimed there. The suite
also sends VPFI from Base to the mirror and back, checking that the mirror's
supply always equals what Base holds locked. It covers the tier push to the
mirror and the guardian pause on the mirror's reward receiver. Every claim
is checked against the claim's own simulation. Every call is one a user or
operator makes, so the suite proves the protocol underneath the keeper
rather than the keeper.

The suite found a defect, recorded as #2821. When Base remits several days in
one send, the mirror receives one shared batch and holds it back while more
than one of its days is open. A loan's reward entry covering those days
keeps them open until its own claim pays, so that claim is refused for
good. Remitting one day per send pays in full, and the suite does that. The
fix is a contract change left to #2821.

The day-list wire rules the keeper's delivery-proof pass used moved into the
shared library, so the keeper and the new suite rebuild a remittance's day
list with one implementation. The keeper's behaviour is unchanged. A new CI
workflow runs the suite; it is not a required check yet. The positive-flow
catalog marks the rows these scenarios cover, and names the parts they do
not. Test tooling only; no contract, deployment or user-facing behaviour
changed. Refs #848.
