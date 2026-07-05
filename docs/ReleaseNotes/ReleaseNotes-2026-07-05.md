# Release Notes — 2026-07-05

The secondary market completes: alpha02 gains the BUY side of the
lender position-sale flow (#991), reviewed across four Codex rounds and
verified end-to-end through the app on Base Sepolia. Alongside it, the
consolidated deployments bundle was synced with the day-before's
post-#989 catch-up re-cut on all three testnets and the hardened
Base Sepolia faucet mocks (#990), so every consumer reads the facet
addresses and mock assets actually live on-chain.

The rest of the day attacked staleness on every front. The docs side
reconciled the FunctionalSpecs with the owner's fourteen intent-
decisions (#1011) and rewrote the public whitepaper from a blank slate
(v4.0, #1015) so both now state what the platform is meant to do
rather than what old text remembered. The app side made freshness
real: an executable regression tier that drives the actual app against
an anvil fork of Base Sepolia in CI (#995), chain-authoritative
discovery of the wallet's own positions so a confirmed transaction is
visible within a block (#1016), and a subscription to the indexer's
realtime push channel so everyone else's actions reflect within
seconds of ingestion (#1020).

## Thread — alpha02 loan-sale BUY flow (#986 Part 3 surface)

The last blocked corner of the secondary market opens: alpha02 can now
BUY a listed lender position. Previously an offer tied to a running
loan was flat-out unacceptable in the app (the #951 honesty block) —
the fresh-loan review would have misdescribed the deal. The accept
review now recognises a position sale and replaces the block with a
real buy-a-running-loan review.

Everything the buyer sees comes from the linked loan read live, never
from the listing's stored row (which carries zero collateral and a
term that already partly elapsed): the price is the loan's current
outstanding principal, the earnings projection covers only the
remaining slice of the term at the listing's rate (the same figure the
protocol settles against), the collateral shown is what the borrower
actually has locked, and the end date is the running loan's real due
date. A banner introduces the deal plainly: you are buying the lender
side of a named, already-running loan — the borrower and their
obligations do not change.

The purchase is signable only when every gate is positively clear.
Beyond the loan being active and unmatured, the review preflights the
SELLER's settlement funding: completing a sale pulls the seller's
accrued-interest forfeit from the seller's wallet, and a seller who
revoked or spent their standing approval after listing would make the
buy fail on-chain with an opaque error. The review blocks that case
with a plain reason instead of letting a doomed transaction be signed.
What the buyer signs is bound to the same live loan numbers the review
showed (principal, original term, live collateral floor) — the
protocol enforces exactly this binding, so any movement between review
and signing aborts before the wallet prompt. Offset-linked offers (and
linked offers whose kind can't be positively identified) keep the
previous block.

Verified end-to-end on Base Sepolia before the UI landed: a listed
position (sale offer #21 on loan #11) was bought by a second test
wallet through the same contract path the flow drives — lender
handoff, principal payout to the seller, and the accrued forfeit all
confirmed on-chain.

## Thread — FunctionalSpecs reconciled with 2026-07-05 owner intent-decisions (PR #1011)

The spec-vs-code conformance review (2026-07-05, recorded in PR #997) produced
fourteen owner intent-decisions. This PR lands the "spec is stale" half of
those decisions in the FunctionalSpecs test oracle, so the documented intended
behaviour matches what the owner has confirmed the platform should do: the
risk-adjusted Health Factor formula (collateral times its liquidation
threshold, over borrowed value), the 30-day grace bucket for loans of 365 days
and longer, grace-window interest accrual with late fees charged in addition
to it, the yield-fee base covering interest and late fees, the widened
peer-LTV agreement band, the governance-cap stale-tier fallback, the
KYC-valuation base of principal plus collateral (dormant industrial-fork spec
only), the launch-versus-ceiling loan-duration distinction, and the
keeper-initiation execution class with per-action opt-in grants.

The tokenomics allocation table was also normalized to exactly 100% of the
230M supply cap by the owner's reconciliation: the Reserve line becomes 24%
(the freed staking pool only — the removed 1% fixed-rate-sale slice is
dropped), and Exchange/Market-Making is fixed canonically at 12%, with the
public whitepaper's allocation table aligned to the same numbers in the same
change-set. The bug-bounty allocation is consistently described as a
multisig-held operational treasury bucket — never an insurance product — and
any automated surplus recycling is disabled-by-default and industrial-fork
gated.

A Codex review pass then propagated these decisions to every stale echo:
the deployment runbook's production-readiness gate now points at the VPFI
TokenPool per-lane CCIP rate limits (the removed buy-adapter caps are
tombstoned as historical), the reward-mesh funding formula and accounting
identity are stated per side (lender and borrower halves each scaled by their
own chain-over-global ratio, matching the implementation), the public
overview's yield-fee copy states the interest-plus-late-fee base with the
principal-first exception, and the create-offer duration copy derives from
the live configured maximum. Follow-ups deferred: locale translation sync
for the overview copy (nine non-English locales), and a shell-comment cleanup
in the deploy scripts.

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

## Thread — alpha02 automatic regression: the anvil fork tier

The regression procedure documented in
`docs/TestScopes/Alpha02RegressionFlows.md` gets its executable half: a
checked-in Playwright suite (`apps/alpha02/e2e/`) that runs the real
app against an anvil FORK of Base Sepolia — the deployed Diamond's
live bytecode and state, but disposable and time-travelable.

The pieces: an injected EIP-1193/6963 test wallet whose keys are
generated fresh per run and funded via anvil (no secrets exist,
anywhere); an "instant indexer" stub that serves the app's exact
indexer routes hydrated live from the fork's own paginated chain
views (zero ingestion lag); fork seeding that gives each role wallet
WETH and faucet tLIQ; and time travel via evm_increaseTime, which
makes the protocol's time behaviours — the 300-second cancel
cooldown today; maturities, grace windows and time-based default
next — testable in seconds instead of days.

Six scenarios land first (connect, post offer, guided-match accept,
full repay, cancel-inside-then-after-cooldown, faucet mint with the
wallet watch-asset affordance), each asserting BOTH the visible UI
state and the on-chain result. A new `alpha02 e2e (anvil fork)`
workflow runs them automatically on pull requests touching
`apps/alpha02/**` or `packages/contracts/**` (the artifacts through
which contract changes actually reach the app), plus a nightly run
that catches the live testnet moving under an unchanged app.

## Thread — My positions reflect transactions instantly (chain-authoritative own positions)

Posting an offer or opening a loan used to take 30–60 seconds to show
up under My positions: the list was fed entirely by the indexer, whose
ingestion runs on a once-per-minute schedule, and nothing in the UI
admitted the wait. The wallet's own positions are now discovered from
the chain itself — open offers it created and loan positions it
currently holds (side decided by which position token the wallet
holds, so bought or transferred positions surface for their new
holder) — which makes a just-confirmed transaction visible within a
block. The indexed history still contributes what the chain can no
longer enumerate: closed positions whose position tokens are burned
and listings received by transfer.

Live chain state also now outranks stale indexed snapshots in both
directions: a just-cancelled offer can no longer linger looking
cancellable (the chain's terminal verdict suppresses the lagging
indexed row), and a loan whose position token the wallet no longer
holds no longer ghosts in the list. Received/bought open listings are
chain-discovered too.

Availability improves with honesty preserved: an indexer outage no
longer blanks the page (live current positions still render), but the
page then shows a plain warning that a data source is degraded —
never a confident partial list. The full unavailable state appears
only when both the chain and the indexer fail. The Activity page,
which remains indexer-fed by nature (event history has no chain
view), refuses to render without the indexed loan list its
participation filter needs, and carries the market lists' self-gating
staleness note on empty and non-empty feeds alike.

Follow-up tracked separately: push-based indexer ingestion (webhook →
immediate scan) to shrink the freshness gap for everyone else's views
of the market, not just one's own positions.

## Thread — alpha02 subscribes to the indexer's realtime push channel

The retail app now listens to the indexing service's per-chain push
channel (the same one the pro dapp already uses): after each ingest
write, the service broadcasts a tiny "this slice changed" signal and
the app immediately refreshes the matching indexed views — the offer
book, the wallet's listed positions, loan rows, claimables and the
activity feed. Other people's actions (a new offer appearing on the
book, a repayment landing) now reflect within seconds of ingestion
instead of on the next 30–60 second poll.

The channel is additive and trust-preserving: frames carry only a
change signal, every refresh still goes through the normal read
surface, the regular polling cadence keeps running underneath as the
fallback, and a missing or disabled channel leaves the app exactly as
fresh as it was before. Bursts coalesce into a single refresh and a
hidden tab defers its refresh to one pass on focus, so the push never
drives background traffic.
