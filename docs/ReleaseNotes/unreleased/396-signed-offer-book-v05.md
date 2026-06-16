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
