# Release Notes — 2026-04-25

Functional record of everything delivered on 2026-04-25, written as
plain-English user-facing / operator-facing descriptions — no code.
Grouped by area, not by chronology. Continues from
[`ReleaseNotes-2026-04-23-to-24.md`](./ReleaseNotes-2026-04-23-to-24.md).

Coverage at a glance: **Phase 8a** (ENS resolution + liquidation-price
calculator + HF alerts + approval revoke surface), **Phase 8b**
(Uniswap Permit2 single-tx flows + Blockaid transaction-scan preview),
**Phase 7a** (4-DEX swap failover for liquidations + autonomous HF-
watcher keeper), **Phase 7b.1** (3-V3-clone OR-logic for oracle-layer
liquidity classification), and a UI-polish fix for the diagnostics
drawer.

## Phase 8a — UX polish: ENS, liq-price calculator, HF alerts, revoke surface

**ENS / Basenames handle resolution.** Anywhere the app shows a wallet
address — Activity, Loan Details, Offer Book, Profile chip in the header —
a resolved `name.eth` or `name.base.eth` handle now appears next to (or
in place of) the raw `0x…abcd` shortform. Resolution is cached per chain
for the session. Borrowers and lenders can recognize their counterparties
without copy-pasting addresses into a name service. Falls back silently
to the address shortform when no handle is registered or the lookup
times out.

**Liquidation-price calculator.** Loan Details now surfaces, for every
liquid loan, the exact collateral-asset price at which the loan would
become liquidatable (HF crosses 1.0). Two display flavours are shown
side by side: "If WETH falls to **$1,847**" (price view) and "WETH down
**14.3%** from current" (delta view) — covers both the "what number do I
need to watch" and "how much room do I have" mental models. Recomputes
live as oracle prices move. Hidden for illiquid loans where the concept
doesn't apply (no oracle = no on-chain liquidation price).

**Health-Factor alert subscription.** Borrowers can now opt into proactive
HF alerts for any loan they own, set by HF threshold (e.g. "warn me when
HF drops below 1.20"). Two notification channels: **Telegram** (via the
official @VaipakamHFBot, OAuth-linked to the wallet) and **Push Protocol**
(decentralized, opt-in via wallet signature). Subscriptions live in a
durable Cloudflare Worker + D1 database; a Cron Trigger sweeps every 5
minutes, re-prices each subscribed loan against fresh oracle data, and
fires alerts only when a threshold is newly crossed (no spam on stable
HF). The Push channel ID is staged but the actual `sendNotification` call
is stubbed pending the channel's on-chain creation — when the team flips
that stub to live, no client-side change is required.

**Approval revoke surface.** A new "Approvals" section in Profile lists
every ERC-20 / ERC-721 / ERC-1155 allowance the wallet has granted to
the Vaipakam Diamond, grouped into three asset buckets: principal-eligible,
collateral-eligible, and prepay-eligible. Each row has a one-click
**Revoke** button that issues an `approve(diamond, 0)` (or
`setApprovalForAll(false)` for NFTs) transaction. Useful when a user wants
to pause future Vaipakam interactions without disconnecting their wallet,
or when they're rotating a hot wallet's permissions for security hygiene.

## Phase 8b — single-tx flows + transaction-scan preview

### Phase 8b.1 — Uniswap Permit2 integration

**Single-signature alternative to the classic two-tx approve+action flow.**
For the most common Vaipakam interactions — accepting a lending offer,
creating an offer, depositing VPFI to escrow — the app now offers a
single-EIP-712-signature path through Uniswap's canonical Permit2
contract (deployed at the same address on every EVM,
`0x000000000022D473030F116dDEE9F6B43aC78BA3`). The user signs once;
the diamond pulls the asset via Permit2 in the same transaction as the
action. Old wallets that don't support EIP-712 v4 (or users who prefer
the explicit two-step flow) silently fall back to the classic approve+
action path — no error message, no degraded UX, just an extra wallet
popup. Permit signatures expire after 30 minutes (matching Uniswap's
default), each signature uses a high-entropy random nonce so two
parallel deposits can't collide, and approvals on the underlying token
contract are completely unchanged from before — Permit2 lives next to
the legacy path, never replaces it.

**Three on-chain entry points** added on the diamond — `createOfferWithPermit`,
`acceptOfferWithPermit`, `depositVPFIToEscrowWithPermit` — sitting alongside
their classic counterparts. Each pre-validates the offer / asset shape
before forwarding to Permit2 so a malformed signature can't drain extra
tokens or hit unintended assets. Foundry test suite has three integration
tests asserting that the new entry points (a) actually pull tokens via
Permit2 (proven by `vm.etch`-installed mock at the canonical address
recording call args), (b) leave the classic path's behaviour unchanged
when the new path isn't taken, (c) reject malformed asset configurations
up front. Frontend wires the `try Permit2 → fall back to classic` pattern
into all four review modals (Offer Book accept, Create Offer submit,
Repay flow, Add Collateral flow) without breaking the existing UX.

### Phase 8b.2 — Blockaid transaction-scan preview

**Inline review-card showing what an upcoming transaction will actually do.**
Before the user clicks the final **Confirm** button on any review modal
(Offer Book accept, Create Offer submit, Repay, Add Collateral), the
calldata is sent to Blockaid's Transaction Scanner API and the response
is rendered as a colour-coded panel:
- **Green** "Transaction preview" — Blockaid classified it as benign,
  shows the expected state changes ("Send 1,000 USDC", "Receive Vaipakam
  position NFT", etc.) so the user can sanity-check the impact before
  signing.
- **Orange** "Surfaced warnings" — Blockaid found something unusual but
  not necessarily malicious; reasons listed.
- **Red** "Flagged as malicious — do NOT proceed" — Blockaid scored the
  transaction high-risk; user is loudly told to back out.
- Silent fail-soft if the API is unreachable (rate-limit, region, API
  key missing) — the panel collapses to a subtle "preview unavailable"
  footer rather than blocking the flow. The on-chain transaction is the
  source of truth; the preview is informational.

Live in front of every Phase-8b-affected modal. No on-chain changes — the
preview reads what's about to be submitted via the wallet, never affects
the actual transaction. API key lives server-side in the existing
Cloudflare Worker; the frontend calls a worker-internal proxy so the key
never ships to the browser.

## Phase 7a — DEX swap failover (liquidation-path resilience)

**Background.** Every Vaipakam loan secured by liquid collateral can be
liquidated in two ways — a Health-Factor-based liquidation (any keeper
when HF < 1) or a time-based default (any keeper after the grace period
expires). Both paths sell the seized collateral on a DEX to repay the
lender's principal. Pre-Phase-7a, the only DEX route was a single
hard-coded call to 0x's legacy `swap()` simplified ABI. If 0x had an
outage, censored our pair, or simply moved off the legacy ABI, every
liquidation in the system would either fail and fall back to the
collateral-claim path (lender gets the raw collateral instead of
principal — a worse outcome) or block entirely.

**What's now in place.** A pluggable swap-adapter abstraction with four
production adapters and a caller-ranked failover chain.

- **Four adapters**: 0x (canonical Settler integration via keeper-supplied
  calldata), 1inch v6 AggregationRouter (keeper-supplied calldata),
  Uniswap V3 SwapRouter (single-hop, fee tier supplied per pair),
  Balancer V2 Vault (poolId supplied per pair). Curve and dYdX were
  evaluated and dropped — Curve adds code surface for stable-pair
  edges we don't liquidate against; dYdX runs on its own Cosmos
  app-chain and is a perpetuals exchange, not a spot AMM, so
  structurally unusable for our spot-swap need.
- **Caller-ranked failover**: the frontend / HF watcher / any keeper
  fetches quotes from all available venues, ranks them by expected
  output (best first), and submits the ranked try-list. The diamond
  iterates in the submitted order — best-quote tries first, next-best
  fallback if the market moved between quote and tx. Only when *every*
  adapter reverts does the loan fall to the existing claim-time
  collateral-split path.
- **Per-adapter exact-scope approvals**: the diamond approves an adapter
  only for the exact `inputAmount` for the duration of one swap attempt,
  and revokes immediately afterwards regardless of outcome. No persistent
  allowances, no cross-adapter leak.
- **Oracle-anchored slippage floor preserved**: the existing 6% slippage
  ceiling (computed from Chainlink/Pyth prices on-chain) is the floor.
  No keeper-supplied minOut can weaken it. A malicious or lazy keeper
  can pick a worse-than-optimal route and capture sub-floor MEV; this is
  the same surface every permissionless liquidation has on every DeFi
  protocol, and is bounded by the on-chain oracle price.

**No governance asset gating.** The decision was deliberately made to
*not* store per-pair UniV3 fee tiers or Balancer pool IDs in
governance-controlled diamond storage. The caller (frontend, HF watcher,
MEV keeper) supplies all routing data — keeping the contract surface
minimal, removing a privileged config knob, and shifting per-pair
knowledge to the off-chain layer where it actually belongs (subgraphs
already index every UniV3 / Balancer pool exhaustively). Trade-off: a
caller hitting `triggerLiquidation` directly via Etherscan with no
adapter data gets nothing — every adapter reverts and the loan falls
to claim-time collateral-split. The frontend, HF watcher, and any
production keeper bring quotes; only manual contract-poking breaks.

**Permissionless-trigger semantics preserved.** Any address can still
call `triggerLiquidation(loanId, calls)` or `triggerDefault(loanId, calls)` —
no new role, no new gate. The new second argument is the ranked try-list.
A separate `claimAsLenderWithRetry(loanId, retryCalls)` overload is
available so a lender (or a keeper acting on the lender's NFT) can
supply a fresh ranked try-list when the loan is in `FallbackPending`
state — the original `claimAsLender(loanId)` no longer auto-retries the
swap, it goes straight to the recorded fallback split. This split is
intentional: a lender can choose to bring quotes for one more attempt,
or take the recorded split as-is.

**Operational change.** Mainnet deployments must register at least one
swap adapter (typically the four production adapters in priority order)
via the new `addSwapAdapter` admin function before any loan settles.
A diamond with zero registered adapters reverts every liquidation —
there is no implicit fallback to the legacy 0x slot. Existing test
fixtures register a legacy-shim adapter that wraps the original
`IZeroExProxy.swap()` ABI behind the new interface, so the entire
test corpus continues to exercise the same 0x mock without rewriting
1300+ liquidation assertions.

**Frontend quote orchestration shipped.** A new `LiquidateButton` lands
on every Active loan with on-chain Health Factor below 1.0 (visible
both to the loan's lender / borrower and to any third-party watcher
who navigated to the loan-details page — liquidation is permissionless).
Click flow:
1. Frontend opens four parallel quote requests — 0x v2 Swap API +
   1inch v6 Swap API (both routed through a Cloudflare Worker that
   injects the operator API keys server-side, so neither key ships
   to a browser); UniswapV3 QuoterV2 (direct on-chain `eth_call`,
   probing 500 / 3000 / 10000 fee tiers and picking whichever pool
   returns the most output); Balancer V2 (stubbed pending the
   subgraph integration follow-up).
2. Successful responses are sorted by expected output (best first)
   and surfaced as "Best quote: 12,459 USDC via 1inch · Fallback
   plan: UniV3 → 0x · Unavailable: Balancer V2".
3. On click, the ranked list submits via wagmi to
   `triggerLiquidation(loanId, calls)`. The diamond runs the failover
   in the submitted order — best-quote tries first, next-best on
   stale-revert.
4. A "Refresh quotes" button re-fetches if quotes have been sitting
   too long.

**HF watcher — autonomous liquidator.** Phase 7a.4. The cron-triggered
HF watcher in the existing Cloudflare Worker now optionally submits
`triggerLiquidation` itself when a subscribed user's loan crosses the
1.0 Health-Factor line. Eligibility is independent of the user's
notification thresholds — purely on-chain HF below 1.0. Per-tick
dedupe prevents resubmitting the same loan twice in one cron sweep
(the diamond would revert on a status check anyway, but this saves an
RPC roundtrip + gas griefing). Routing is identical to the frontend
flow: same four DEX venues quoted in parallel, ranked by expected
output, packed as `AdapterCall[]`, and submitted from the keeper's
EOA on whichever chain the loan lives on. Disabled by default —
operator must set both `KEEPER_ENABLED=true` and `KEEPER_PRIVATE_KEY`
in the Worker's secret store, and pre-fund the keeper EOA with gas
on every chain it should operate against. Losing the race to another
keeper or MEV bot is fine: the second `triggerLiquidation` reverts
on the status check, no funds at risk. Logs each attempt with the
chain, loan id, expected proceeds, and which adapter the diamond
committed against.

**Cloudflare Worker quote-proxy routes** (extended on the existing
hf-watcher worker). Two new POST endpoints, `/quote/0x` and
`/quote/1inch`, accept the same JSON body shape (chainId, sellToken,
buyToken, sellAmount, taker, optional slippageBps), forward to the
respective aggregator with the operator's API key injected
server-side, and pass the response through verbatim. Returns 503 if
the matching key isn't configured, so the frontend's other quote
sources (UniV3 + Balancer) still populate the try-list when one
aggregator is offline. Hosted alongside the existing HF-alert
endpoints under the same CORS gate; frontend origin is the only
allowed caller.

**What still ships in a follow-up.**
- **Balancer V2 quote integration** — needs Balancer V2 subgraph for
  pool discovery + on-chain `BalancerQueries.queryBatchSwap` for
  exact output. Stubbed as `null` for now; the orchestrator handles
  null returns gracefully (drops the venue from the try-list).
- **Worker rate-limit** on the `/quote/*` routes — Cloudflare's built-in
  rate-limit feature configured via the dashboard, layered on top of
  the existing CORS gate. Not yet wired.

## Phase 7b — multi-venue liquidity classification (oracle-layer redundancy)

**Background.** Vaipakam's `OracleFacet.checkLiquidity` decides whether
an asset is "liquid" — meaning it has a price feed plus enough on-chain
depth that the protocol is willing to value it as collateral and route
its liquidations through a DEX. Pre-Phase-7b, this check ran exclusively
against a single Uniswap V3 pool at the 0.3% fee tier. One outage,
one drained pool, or one missing UniV3 deployment (BNB Chain, Polygon
zkEVM) was enough to flip every asset on that chain to "illiquid",
blocking new collateralized loans entirely. Phase 7a addressed the
liquidation-routing redundancy; Phase 7b is the corresponding fix at
the loan-classification layer.

### Phase 7b.1 — three-venue OR-logic, zero per-asset config

**The realisation that drove the design**: Uniswap V3, **PancakeSwap V3**,
and **SushiSwap V3** are all forks of the same Uniswap V3 codebase at
the contract layer. They expose the identical `getPool(token0, token1,
fee)` factory lookup and the identical `slot0()` / `liquidity()` pool
views. The exact same depth-probe code runs against any of the three —
just point it at a different factory address. Adding the two clones to
the on-chain liquidity check requires **zero per-asset governance
configuration**: pool discovery still happens automatically via the
factory, the same way it does today for Uniswap V3.

**Decision rule**: an asset is now classified Liquid iff its price
feed is fresh AND **at least one** of the three V3-clone factories
exposes an asset/WETH pool meeting the `MIN_LIQUIDITY_USD` depth floor.
Any single venue going offline (factory paused, pool drained, BNB
Chain having no UniV3 deployment) doesn't matter as long as one other
clone still meets the floor.

**Per-chain coverage matrix** (which V3 forks we'll register on
each chain at deploy time):

| Chain | Uniswap V3 | PancakeSwap V3 | SushiSwap V3 |
|---|---|---|---|
| Ethereum | ✓ | ✓ | ✓ |
| Base | ✓ | ✓ | (V2 only) |
| Arbitrum | ✓ | ✓ | ✓ |
| Optimism | ✓ | (limited) | ✓ |
| Polygon zkEVM | ✗ | ✓ | ✓ |
| BNB Chain | ✗ | ✓ | ✓ |

The two chains where Uniswap V3 isn't deployed (BNB Chain and Polygon
zkEVM) — previously stuck with no liquidity classification at all —
now get coverage via PancakeSwap V3 + SushiSwap V3.

**Fee-tier set extended.** Pre-Phase-7b the depth probe only checked
the 0.3% (3000 bps) tier. PancakeSwap V3 uses a 0.25% (2500 bps) tier
in place of 0.3%, and several blue-chip pairs live on UniV3's 0.05%
(500 bps) tier instead. The probe now iterates `[3000, 500, 2500,
10000, 100]` against every configured factory and returns the first
non-empty pool — a strictly more permissive change with zero
backward-compatibility risk (every asset that was liquid pre-Phase-7b
remains liquid).

**Governance footprint.** Two new admin functions:
- `setPancakeswapV3Factory(address)` — chain-specific PancakeV3 factory.
- `setSushiswapV3Factory(address)` — chain-specific SushiV3 factory.

Setting either to zero disables that leg of the OR-combine; the check
collapses to whichever factories are configured. **No per-asset
mapping anywhere** — pool discovery is on-chain through the factory,
exactly like today's Uniswap V3 path.

**What was reconsidered and dropped**: an earlier draft considered
adding **Balancer V2** as the third venue. Research surfaced that
Balancer V2 has no canonical on-chain `getPoolByTokens(token0, token1)`
view — pool indexing is off-chain via subgraph, so Balancer's
on-chain depth probe would have required a per-asset poolId mapping
in governance storage. That conflicted with the no-per-asset-config
constraint, and adding PancakeSwap V3 + SushiSwap V3 instead delivers
strictly better coverage for less ongoing ops effort. The prior
storage slot for `balancerV2Vault` was removed before any production
write was made; Balancer integration is deferred to a possible future
phase that wires an off-chain depth attestation oracle.

**What's queued for Phase 7b follow-up**:

- **Targeted unit-test suite** for the new OR-combine — UniV3-only
  pass, PancakeV3-only pass, SushiV3-only pass, all-empty fail, mock
  factories at distinct addresses to confirm short-circuit behaviour.
- **Frontend 0x-based pre-flight check** at offer create / accept
  flows. Calls the existing `/quote/0x` Cloudflare Worker route to
  confirm a $1M-equivalent route exists for the (collateral,
  principal) pair before the wallet popup. Pure UX guard; the
  on-chain attack surface stays exactly as the V3-clone OR-logic
  defines it. Anyone calling the diamond directly via Etherscan
  bypasses the preflight, exactly as today's UniV3-only gate works.

### Phase 7b.2 — price-feed redundancy upgrade (queued)

The same redundancy pattern, applied to price feeds (where the threat
profile is **price manipulation** rather than venue outage, so the
combine semantics flip from OR to "2-of-3 within deviation tolerance"):

- **Required #1**: Chainlink Feed Registry (already live).
- **Required #2**: **Tellor** with on-chain-derivable `queryId`
  (`keccak256(abi.encode("SpotPrice", abi.encode(asset, "usd")))`).
  Decentralised oracle, dispute-resolved data, no per-asset
  governance mapping needed because the queryId is computed from the
  asset address.
- **Optional**: Pyth (already integrated, currently used as the
  cross-validation oracle). Stays as the third source.

The on-chain price view will accept any 2-of-3 sources whose values
fall within a configurable deviation band; outliers get flagged but
don't block valuation. This further hardens the liquidation /
loan-init paths against single-oracle compromise. Other research
options (API3, DIA, Umbrella Network, UMA) were evaluated and
rejected: API3 needs per-asset symbol mapping, DIA needs per-asset
string keys, Umbrella has limited chain coverage, UMA's optimistic
delay (hours-long dispute window) is incompatible with spot-price
freshness requirements.

**Status at end-of-day 2026-04-25**: contract scaffolding for 7b.1
landed and regression-clean (1361 passing / 0 failed in the
no-invariants subset, identical to the pre-Phase-7b baseline). 7b.1.c
test additions, 7b.1 frontend pre-flight, and 7b.2 Tellor integration
all queued.

## UI polish

**Diagnostics drawer — horizontal scrollbar removed.** The "Diagnostics"
slide-over (the LifeBuoy floating button) was rendering a horizontal
scrollbar inside its events list any time a long error message or step
identifier overflowed the card width. Long content now wraps inside the
card; the drawer's overall width is unchanged, only the unwanted scroll
chrome went away.

## Status snapshot at end-of-day 2026-04-25

- **Phase 5** (Time-weighted VPFI fee discount + borrower LIF rebate):
  shipped in the 2026-04-23/24 window, no further work today.
- **Phase 6** (Per-action keeper authorization): shipped in the
  2026-04-23/24 window, targeted regression tests added today
  (Profile bitmask validation + Preclose per-action isolation),
  now 1402-test green baseline as of pre-Phase-7a.3 state.
- **Phase 8a** (UX polish bundle): shipped today. HF-alert push-channel
  send remains stubbed pending Push channel registration on-chain.
- **Phase 8b** (Permit2 + Blockaid simulation): shipped today.
  A real-Permit2 fork test (signature path, expired deadlines, wrong-
  amount, nonce reuse) is queued as a nice-to-have before the eventual
  mainnet cutover; mock-Permit2 covers the integration logic in the
  forge suite.
- **Phase 7a** (4-DEX swap failover): COMPLETE end-to-end. Contract
  layer (4 adapters + LibSwap failover library + AdminFacet adapter-
  management surface + RiskFacet / DefaultedFacet / ClaimFacet rewired
  through the failover library + full test-corpus migration via a
  legacy ZeroEx shim). Frontend (swap-quote orchestrator hook +
  LiquidateButton with best-quote preview wired into Loan Details).
  Cloudflare Worker (`/quote/0x` and `/quote/1inch` proxies with
  server-side API-key injection). HF watcher autonomous keeper
  (Phase 7a.4 — submits `triggerLiquidation` on any subscribed-user
  loan whose on-chain HF crosses 1.0, disabled by default until
  `KEEPER_ENABLED=true` and `KEEPER_PRIVATE_KEY` are populated in
  the Worker secret store). Full regression: 1406 passing / 0 failed
  / 5 skipped. Worker + frontend TypeScript both clean.
- **Phase 7b** (multi-venue liquidity classification at the oracle
  layer): contract layer landed today. Pivoted from the originally-
  scoped UniV3 + Balancer V2 OR (which would have required a per-
  asset Balancer poolId mapping in governance storage) to a 3-V3-clone
  OR — Uniswap V3 + PancakeSwap V3 + SushiSwap V3, all of them
  Uniswap V3 forks at the contract layer. Fee-tier set extended to
  cover PancakeV3's 2500 bps tier in addition to UniV3's standard
  set. Zero per-asset governance configuration required. Regression
  clean (1361 passing / 0 failed in the no-invariants subset).
  Targeted unit tests for the new OR-combine, the 0x-based frontend
  pre-flight UX guard, and the Phase 7b.2 Tellor-as-third-price-
  source upgrade are all queued.
- **Phase 9** (growth sprint — points, leaderboards, Frames, PWA):
  queued, not started.

**Mainnet deployment**: deferred. With Phase 7b follow-ups (tests +
frontend pre-flight + Tellor) and Phase 9 still in flight, there is
no near-term cutover; the focus stays on landing the remaining
changes in any order, then a single combined deployment.

## Documentation convention

Same as carried forward from the prior file: every completed phase
gets a functional, plain-English write-up under `docs/ReleaseNotes-…md`.
No code. Function names, tables, and exact selectors live in the code
base; this file describes behaviour to a non-engineer reader (auditor,
partner team, regulator).
