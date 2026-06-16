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

Because slicing rewrites a fill to a single fixed-size on-chain offer, the
matcher also re-asserts — before slicing — the intent guarantees the signer
relies on and the matching engine can no longer see once the range is
collapsed: a partial fill can never be smaller than the signer's stated
minimum slice, can never leave a sub-minimum remainder stranded off-chain, a
zero minimum is rejected outright, and an all-or-nothing offer signed with a
range is rejected as malformed rather than silently filled at one end.

Collateral on a partially-fillable signed offer must scale at a CONSTANT ratio
across its range (the same collateral-to-principal proportion at the minimum
and the maximum) — exactly how mainstream signed-order books (0x, Seaport, CoW)
treat a single order: one price, pro-rata partial fills. A signer who wants
different ratios posts separate offers, or a single all-or-nothing offer. With
that rule, each slice's collateral is a clean pro-rata share that sums to
exactly the signed ceiling across the whole fill — a keeper can never split the
range into slices that, in aggregate, lock more collateral than the signer
agreed to. The signer's collateral is also honoured as a true floor on the
borrower side: when a signed borrower is matched against a lender asking for
less collateral than the borrower pledged, the loan locks what the borrower
signed (not the lender's lower minimum), and that floored amount is what the
health-factor / loan-to-value safety check evaluates — so a match that is safe
at the signed pledge is admitted rather than rejected on the lender's thinner
requirement.

Each transient slice is also fully retired once consumed — removed from
active-offer discovery, and (for a lender-side slice, whose loan position is a
separately-minted record) its one-transaction offer position is burned — so a
fully-filled slice never lingers as a phantom open offer in any listing or
position view.

Internally this reused the existing matcher by factoring its execution body into
a shared core, so both the on-chain matcher and the signed-offer matcher run the
exact same settlement, lien, and kickback logic — no divergence, and the
on-chain matcher's behaviour is unchanged (verified against its full test
suite). Cancellation, nonce invalidation, expiry, and replay protection from
v0.5 all carry over. Part of #396 (does not close the umbrella). Deferred to
later phases: signed-against-signed matching, wallet-backed partial fills, and
the programmatic lender-intent vault.
