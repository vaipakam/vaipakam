# Release Notes — 2026-06-16

The day advanced the intent surface of the #401 hybrid-intent-layer program:
a gasless EIP-712 signed off-chain offer book (v0.5) and the keeper-driven
matcher that fills those signed offers on-chain (v0.6).

## Thread — Gasless signed off-chain offer book, v0.5 (PR #615)

Offer *creation* can now be gasless. A lender or borrower signs the binding
terms of an offer once, off-chain (an EIP-712 typed-data signature — no
transaction, no gas), and a counterparty fills it on-chain later. Until a
counterparty fills it, the offer lives entirely off-chain (in the front-end /
indexer order book), so a deep book costs nothing to maintain. This is the
first building block of the broader liquidity/intent program (#401) and the
lowest-risk one: it never introduces pooled custody — funds stay in each
user's own isolated vault until the exact instant of a fill.

At fill time the signed offer is **materialized into an ordinary on-chain
offer and immediately accepted**, so the resulting loan and everything after
it (position NFTs, claims, VPFI discounts, sanctions screening, the liquidity
and health-factor gates) run through the same audited path a normal on-chain
offer would. The signer's stake is sourced one of two ways: **vault-backed**
(the signer already holds the stake as free balance in their Vaipakam vault —
nothing is pulled, the balance is simply checked and locked), or
**wallet-backed** (the stake is pulled from the signer's wallet via a single
Permit2 signature that simultaneously authorizes the token transfer and
commits to the offer terms). Wallet-backed offers are all-or-nothing in this
version. The act of signing is the creator's risk-and-terms consent.

Signed offers are protected against replay and can be cancelled: each fill is
recorded against the offer's order hash so it can never be filled twice, a
signer can cancel a specific offer on-chain, and a signer can batch-cancel
every offer carrying a given nonce at once (the secure complement to a free
off-chain delete). Smart-contract wallets can sign offers too (ERC-1271), so
this is forward-compatible with the programmatic lender vaults and aggregator
adapters planned in later phases.

This version supports direct counterparty acceptance (full fills) of ERC-20
lender-principal and ERC-20-collateral borrower offers. Partial fills (which
arrive with the keeper-matcher phase), the programmatic LenderIntentVault +
auto-roll, and the aggregator ERC-4626 adapter are deliberately deferred to
later phases of #401. NFT-collateral and refinance-tagged offers are out of
scope for v0.5 and are rejected explicitly. Part of #396 (does not close the
umbrella).

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
