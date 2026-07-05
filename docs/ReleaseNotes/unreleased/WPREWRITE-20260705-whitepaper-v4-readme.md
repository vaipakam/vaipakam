## Thread — Whitepaper v4.0 blank-slate rewrite + GitHub-facing README (PR #1015)

The public technical whitepaper was rewritten from scratch (v4.0): nineteen
sections plus License, with every factual claim sourced from the
FunctionalSpecs and the contracts rather than from the previous text. The
rewrite corrects positions the v3.0 document had drifted on — the
slippage-at-floor liquidity test (there is no volume threshold), the
$50k/$500k/$5M depth-tier probes, the loan state machine (no separate
"Liquidated" state), the removal of the fixed-rate VPFI purchase program and
its cross-chain buy adapter, the five-chain Phase-1 set with BNB at the
testnet tier only, refinance paying the exiting lender full-term interest
regardless of interest mode, and the reconciled 100%-of-230M allocation
table. Governance-tunable figures render through live chain-read tokens so
marketing copy cannot go stale against a retune.

The repository root README was repurposed as the GitHub-facing project
landing page (the vaipakam/vaipakam README also renders on the GitHub
profile): an honest pre-live status banner, positioning, an architecture
sketch, a repository map, documentation links, and security pointers. The
whitepaper remains single-sourced in the content file, the whitepaper page
component stays a pure renderer, and a new legacy-citation map preserves the
old "README §N" section numbering that contract comments still reference.

A dedicated adversarial verification pass checked the assembled document
against the specs, contracts, and license before review; a Codex round then
tightened five statements (offer-NFT mint timing, the signed-offer off-chain
carve-out, the NFT-rental borrower-only close-out, the live-listing transfer
lock, and the rate-governor pause exception). Follow-up: the per-tier
liquidation-threshold defaults are deliberately omitted from the risk chapter
until the tier-direction divergence (#999) is settled.
