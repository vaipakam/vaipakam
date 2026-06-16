## Thread — Keeper-matcher for signed offers, v0.6 (PR pending)

Builds directly on the v0.5 signed-offer book. A keeper (or any caller) can now
**match a signed off-chain offer against an existing on-chain counterparty
offer** — including **partial fills** — and earns the standard 1% matcher
kickback, exactly as the existing `matchOffers` matcher does for two on-chain
offers. This is what lets a signed offer get filled without a human counterparty
showing up to accept it directly: a keeper pairs it with a compatible on-chain
offer and the loan initiates.

Each match materializes exactly the slice it fills — a single-value on-chain
offer sized to that match — runs it through the same audited match-execution
core the on-chain matcher uses, and decrements the signed offer's remaining
amount in the off-chain ledger. So a large signed offer can be filled across
several smaller matches over time, while each individual match is a clean,
fully-consumed on-chain offer (no dangling state). Vault-backed signed offers
support partial fills this way; an all-or-nothing signed offer must still be
filled in a single full match, honoring the signer's intent. The match's
collateral and health-factor safety is enforced by the same matching engine
that protects every on-chain match, so an under-collateralized signed match
reverts rather than minting a bad loan.

Internally this reused the existing matcher by factoring its execution body into
a shared core, so both the on-chain matcher and the signed-offer matcher run the
exact same settlement, lien, and kickback logic — no divergence, and the
on-chain matcher's behaviour is unchanged (verified against its full test
suite). Cancellation, nonce invalidation, expiry, and replay protection from
v0.5 all carry over. Part of #396 (does not close the umbrella). Deferred to
later phases: signed-against-signed matching, wallet-backed partial fills, and
the programmatic lender-intent vault.
