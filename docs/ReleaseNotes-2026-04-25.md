# Release Notes — 2026-04-25

Functional record of everything delivered on 2026-04-25, written as
plain-English user-facing / operator-facing descriptions — no code.
Grouped by area, not by chronology. Continues from
[`ReleaseNotes-2026-04-23-to-24.md`](./ReleaseNotes-2026-04-23-to-24.md).

Coverage at a glance: **Phase 8a** (ENS resolution + liquidation-price
calculator + HF alerts + approval revoke surface), **Phase 8b**
(Uniswap Permit2 single-tx flows + Blockaid transaction-scan preview
+ real-Permit2 fork tests), **Phase 7a** (4-DEX swap failover for
liquidations + autonomous HF-watcher keeper + Balancer V2 quote +
worker rate-limit), **Phase 7b.1** (3-V3-clone OR-logic for
oracle-layer liquidity classification), **Phase 7b.2** (Tellor +
API3 + DIA secondary price-oracle quorum with Soft 2-of-N decision
rule; Pyth removed in favor of symbol-derived no-per-asset-config
alternatives), **Phase 9** (PWA manifest + service worker, public
keeper-bot reference repo at the sibling `vaipakam-keeper-bot/`
repository, Active-loan check
Farcaster Frame), and a UI-polish fix for the diagnostics drawer.

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
- **Balancer V2 quote integration** — ✅ shipped 2026-04-25 in Phase 7a
  polish (see "Phase 7a polish — Balancer V2 quote + worker rate-
  limit" section below).
- **Worker rate-limit** on the `/quote/*` routes — ✅ shipped 2026-04-25
  in Phase 7a polish.

## Phase 9 — growth sprint

Phase 9 ships three of the four originally-scoped growth items
(points/leaderboards was dropped after design review). All three
are pure additive lifts; none touch the on-chain protocol surface.

### Phase 9 — Progressive Web App (PWA)

The dApp is now installable on iOS and Android via the browser's
"Add to Home Screen" prompt. Installation produces a standalone
shell with the Vaipakam icon, branded indigo theme color, and a
list of one-tap shortcuts (Offer Book, My Loans, Buy VPFI, Alerts)
on supported platforms.

A minimal service worker (`/sw.js`) caches the app shell with a
stale-while-revalidate strategy for instant cold-start render. **All
dynamic data (RPC, subgraph, `/quote/*` worker) bypasses the
service worker** — chain state never gets a stale cache; only the
HTML / JS / CSS / image bundles are cached. The SW only registers
in production builds (Vite HMR conflicts otherwise) and is a no-op
on browsers without `serviceWorker` support.

Files: `frontend/public/manifest.json`, `frontend/public/sw.js`,
`frontend/index.html` (PWA + apple-touch meta tags),
`frontend/src/main.tsx` (registration on app load).

### Phase 9.A — Public keeper-bot reference repo

The keeper bot lives in its own standalone repo
(`vaipakam-keeper-bot`, sibling of the monorepo at
`/home/pranav/Codes/Vaipakam/vaipakam-keeper-bot` for local
checkouts; will be published as a separate GitHub repo for the
public release). Self-contained, MIT-licensed Node.js bot any
third-party operator can clone, configure with their own keeper
key + RPC endpoints + (optional) aggregator API keys, and run to
compete for Vaipakam liquidations. **Liquidation is
permissionless** — anyone whose `triggerLiquidation` lands first
earns the on-chain bonus. Decentralizing liquidation
infrastructure beyond the operator-run hf-watcher worker is a
healthy book hygiene measure.

The bot mirrors the autonomous-keeper logic in the existing
hf-watcher worker but as a vanilla Node.js process (no
Cloudflare dependency). Per tick (default 60s), per chain:

1. Page through `getActiveLoansPaginated` to list every active
   loan id (operator can pin a whitelist instead via env).
2. Read `calculateHealthFactor(loanId)` for each; skip HF ≥ 1.0.
3. Fetch the loan struct, orchestrate quotes from 0x / 1inch /
   UniV3 / Balancer V2 in parallel, rank by expected output.
4. Submit `triggerLiquidation(loanId, ranked)` from the keeper EOA.

The repo's README documents setup, MEV considerations
(Flashbots Protect / MEV Blocker integration), per-chain coverage
matrix, and the "what the bot does NOT do" list (no mempool
monitoring, no NFT-collateral defaults, no profit projection —
these are deliberate scope cuts for a reference implementation).

The orchestrator code is self-contained TypeScript with viem +
dotenv as the only runtime deps. JSON-lines logging for
Datadog / Loki / Splunk ingest. Node 22+ required (uses
`--experimental-strip-types` so no build step is needed).

### Phase 9.B — Active-loan check Farcaster Frame

A Farcaster Frame at `/frames/active-loans` (added to the
existing hf-watcher worker) lets users on Farcaster paste any
wallet address and see its active Vaipakam loans aggregated
across every supported chain — total count, lowest Health
Factor across all positions, per-chain breakdown — without
leaving their feed.

Three routes:

- `GET /frames/active-loans` — initial Frame card with a text
  input for the wallet address and a single Check button.
- `POST /frames/active-loans` — handles the button click,
  reads cross-chain active loans for the supplied address via
  the same `getActiveLoansByUser` view the alert watcher uses,
  returns a result Frame with a "View NFT Verifier" deep link.
- `GET /frames/active-loans/image` — stateless SVG renderer
  (1146×600, 1.91:1 ratio per Farcaster's recommendation)
  driven entirely by query parameters. Branded gradient
  background; HF coloring (red < 1, amber < 1.5, green ≥ 1.5).

The Frame complements the existing **public NFT Verifier** at
`/nft-verifier`: the Verifier handles per-NFT detail lookups
(role, HF, LTV, fallback split, mint / burn lifecycle); this
Frame handles per-wallet aggregate views. The result Frame's
"Open NFT Verifier" button deep-links to the Verifier so users
can drill into individual positions after seeing the wallet
summary.

Public read-only — no signing, no chain writes, no auth.
Embeddable from any Farcaster client (Warpcast, etc.) by
posting the `/frames/active-loans` URL.

### Phase 9.C — Points / leaderboards (DROPPED)

Originally scoped as part of the growth sprint. Dropped after
design review surfaced that the scoring-model + sybil-resistance
+ storage decisions are product-strategy choices, not engineering
choices, and adding a points layer this early in the protocol's
lifecycle pre-commits to a model that may not match how organic
user engagement actually develops. Revisit when there's a
specific user-acquisition goal a leaderboard would serve.

## Phase 8b.1 nice-to-have — Permit2 fork test against the real contract

The original Phase 8b.1 work shipped with a `MockPermit2` test stand-
in that records call args + executes the underlying transfer but
**skips signature verification entirely**. That's enough to assert
"the diamond hits Permit2 in the right shape" but doesn't catch a
signature regression that would only surface against the real
Permit2 contract.

`test/fork/Permit2RealForkTest.t.sol` closes that gap with 5 tests
that exercise the **real** Uniswap Permit2 at the canonical
`0x000000000022D473030F116dDEE9F6B43aC78BA3` address against a
forked mainnet:

1. **Happy path** — build a `PermitTransferFrom` with future
   deadline, sign the EIP-712 digest with `vm.sign`, call
   `permitTransferFrom` directly. Asserts the spender receives the
   tokens and the owner is debited.
2. **Expired deadline** — same flow with `deadline = block.timestamp - 1`.
   Real Permit2 reverts `SignatureExpired`.
3. **Wrong amount** — sign for amount X, request amount X+1.
   Real Permit2 reverts.
4. **Nonce reuse** — execute once, attempt the same `(owner, nonce)`
   pair again. Real Permit2 burned the bitmap slot on the first use,
   so the retry reverts `InvalidNonce`.
5. **Spender mismatch** — owner signs with `spender = X` bound, a
   different address tries to redeem. Permit2's enforced
   `msg.sender == bound spender` check causes a revert.

Each test reads Permit2's actual `DOMAIN_SEPARATOR()` from the
forked chain (rather than recomputing it), so the test stays
correct if Permit2 ever rolls. Each test consumes a unique nonce
derived from `keccak256(chainId, owner, testIdx)` so back-to-back
runs in the same fork session don't trip the replay guard.

**Gating**: same `FORK_URL_MAINNET` env var the rest of the fork
suite uses. Without the env, every test silently returns at the
top-level `if (!forkEnabled) return;` guard and reports PASS in
~600µs (5 no-ops). CI without archive-node credentials passes
unchanged.

To run the suite for real:

```bash
FORK_URL_MAINNET=$ALCHEMY_BASE_RPC \
  forge test --match-path test/fork/Permit2RealForkTest.t.sol -vv
```

Permit2 is deployed at the same canonical address on every EVM
chain via Nick's factory, so any of Ethereum / Base / Arbitrum /
Optimism / Polygon zkEVM / BNB Chain RPCs work for the fork URL.
Recommended: a low-traffic Base mainnet fork — minimal data
download, free Alchemy tier suffices.

**Status**: regression count after the addition is **1391 passing /
0 failed / 5 skipped** (+5 from the new fork tests, all silent-
skips in default CI mode).

## Phase 7a polish — Balancer V2 quote + worker rate-limit

Two follow-up items from Phase 7a's "queued polish" list landed
together:

**Balancer V2 quote orchestration**, previously stubbed as `null`,
is now active in both the frontend (`swapQuoteService.ts`) and the
hf-watcher worker (`serverQuotes.ts`). The orchestrator queries the
per-chain Balancer V2 subgraph for the deepest pool containing the
asset pair (filtered to `totalLiquidity > $10k` to skip dust pools)
and produces a first-order constant-product spot estimate from the
pool's reserves: `outAmount ≈ sellAmount × balanceOut / balanceIn`.
This estimate is good enough for ranking the try-list; the on-chain
Balancer V2 adapter still enforces the oracle-derived
`minOutputAmount` exactly, so a too-optimistic ranking estimate just
fails the slippage check and the failover library moves to the next
adapter.

Subgraph URLs are configured per chain in `swapRegistry.ts`
(frontend) and `serverQuotes.ts` (worker). Defaults point at The
Graph hosted endpoints; operators set
`VITE_<CHAIN>_BALANCER_V2_SUBGRAPH_URL` to override with paid /
decentralized-network endpoints. BNB Chain is left explicitly null
(Balancer V2 not deployed there).

**Worker per-IP rate-limit on /quote/0x and /quote/1inch.**
Configured via Cloudflare Workers' built-in `unsafe.bindings`
(rate-limit primitive) — 60 requests / 60 seconds per upstream per
IP. The handlers check the limit before parsing the request body
or proxying to the aggregator; over-budget IPs get 429 with
`{"error": "rate-limited"}`. Caps abusive scripted clients before
they exhaust the operator's 0x / 1inch API key budgets, while
leaving plenty of headroom for legitimate frontend flows (a
liquidation review issues ~4 quote requests across all venues; UI
debouncing keeps real users well under 60/min).

The bindings are scoped per upstream (`QUOTE_0X_RATELIMIT` and
`QUOTE_1INCH_RATELIMIT`) so heavy 0x usage doesn't burn the 1inch
budget. Bindings fail-OPEN when undefined (legacy deploys without
the new wrangler config still serve traffic, just unrate-limited).

**Files touched**:

- `frontend/src/contracts/swapRegistry.ts` — added
  `balancerV2SubgraphUrl` per chain; default URLs for Ethereum /
  Base / Arbitrum / Optimism / Polygon zkEVM; null for BNB Chain;
  env-var override per chain.
- `frontend/src/lib/swapQuoteService.ts` — `fetchBalancerV2Quote`
  re-implemented (was a stub returning null); shared
  `decimalStringToBigInt` helper for parsing subgraph balances.
- `ops/hf-watcher/src/serverQuotes.ts` — mirror of the frontend
  Balancer fetch; `fetchBalancerV2` replaces the previous
  `Promise.resolve(null)` placeholder.
- `ops/hf-watcher/src/quoteProxy.ts` — `checkRateLimit` helper +
  per-handler rate-limit gate at the top of `handle0xQuote` and
  `handle1inchQuote`.
- `ops/hf-watcher/src/env.ts` — typed bindings for the new
  rate-limit primitives.
- `ops/hf-watcher/wrangler.jsonc` — `unsafe.bindings` declaration
  for both rate-limit namespaces.

Frontend + worker TypeScript both clean.

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

**Status at end-of-day 2026-04-25**: 7b.1 contracts + 14 targeted
tests + frontend 0x preflight all landed. 7b.2 contracts (Tellor +
API3 + DIA + Soft 2-of-N quorum, Pyth removed) also landed clean.
1359 passing / 0 failed in the no-invariants regression (down from
1375 because the 16-test PythDeviation suite was deleted as part of
Pyth removal).

### Phase 7b.2 — symbol-derived secondary oracles + Soft 2-of-N quorum

**The original plan called for Tellor + API3 + DIA on top of an
existing Pyth integration. Research surfaced two findings that
reshaped the plan**:

1. **Pyth requires a per-asset `priceId` mapping** in diamond
   storage — every new collateral asset needs a governance write to
   install its priceId before pricing works. This conflicts with the
   no-per-asset-config policy locked in for Phase 7b.
2. **Tellor / API3 / DIA all key by string symbol**, not asset
   address. Their lookup keys are derivable on-chain from
   `IERC20.symbol()` — no per-asset config required.

**Decision**: remove Pyth entirely; replace with Tellor + API3 + DIA.
Three secondaries, all symbol-derived, zero per-asset governance
writes. The previous `setPythEndpoint` / `setPythFeedConfig` setters,
the `PythFeedConfig` struct, the `IPyth.sol` interface, the
`MockPyth.sol` test mock, and the 16-test `PythDeviation.t.sol`
suite were all stripped before any production write was made (the
diamond is pre-mainnet, so the storage-layout shift is safe).

**The new "Soft 2-of-N quorum" decision rule** (Interpretation B,
chosen over a strict 2-of-N that would have been operationally
fragile):

For each price read:

1. Run all three secondary probes (Tellor / API3 / DIA). Each
   returns one of:
   - **Unavailable** — silent skip (oracle not configured / symbol
     unreadable / no reporter coverage / stale read / read reverted).
   - **Agree** — value within the chain-level deviation tolerance
     of the Chainlink primary.
   - **Disagree** — value beyond tolerance.

2. Decision:
   - **All three Unavailable** → accept the Chainlink price
     (graceful fallback, preserves operability on chains / assets
     with sparse secondary coverage).
   - **At least one Agree** (regardless of any Disagree alongside)
     → accept the Chainlink price. The 2-source quorum is hit by
     Chainlink + the agreeing secondary.
   - **Some Disagree AND no Agree** → revert
     `OraclePriceDivergence`.

This mirrors the LayerZero DVN diversity model (Phase 1 cross-
chain hardening) but applied to spot pricing: a single oracle
compromise can no longer push a disagreeing price through the
gate; an attacker has to compromise (or DoS at the same time)
Chainlink AND every secondary that has data for the asset.

**Key derivation per source**:

- **Tellor**: `keccak256(abi.encode("SpotPrice", abi.encode(symbol, "usd")))` —
  symbol read on-chain via `IERC20.symbol()`, lowercased.
- **API3**: `keccak256(abi.encodePacked(bytes32("<SYMBOL>/USD")))` —
  symbol uppercased, packed left-aligned into 32 bytes.
- **DIA**: passes string `"<SYMBOL>/USD"` directly to the oracle's
  `getValue(string)` view.

The `IERC20.symbol()` helper accepts both string-returning tokens
(modern ERC-20) and bytes32-returning tokens (legacy MakerDAO-style)
and silently classifies non-decodable symbols as Unavailable.

**Symbol-collision concern**: an attacker could deploy a malicious
ERC-20 whose `symbol()` returns "ETH" (so the secondary lookups
return ETH's price). The pricing path STILL gates against Chainlink
as primary — the malicious token would need a Chainlink feed AND
match within the deviation tolerance. The risk is meaningfully
bounded but not zero; auditors should review.

**Why API3, Tellor, and DIA but not Pyth, Umbrella, UMA**:

| Source | Lookup keying | On-chain derivable? | Verdict |
|---|---|---|---|
| Chainlink Feed Registry | asset address | yes (registry resolves internally) | already used (primary) |
| Pyth | bytes32 priceId | no (no symbol bridge) | **REMOVED** in this phase |
| Tellor | symbol string in queryId | yes via `asset.symbol()` | **ADDED** |
| API3 | dAPI name (string symbol) | yes via `asset.symbol()` | **ADDED** |
| DIA | string key like "ETH/USD" | yes via `asset.symbol()` | **ADDED** |
| Umbrella Network | merkle proof per chunk | requires per-asset cfg | rejected |
| UMA | optimistic dispute window | hours-long delay | rejected (unsuitable for spot pricing) |

**New chain-level admin surface** (`OracleAdminFacet`):

- `setTellorOracle(address)` / `getTellorOracle()`
- `setApi3ServerV1(address)` / `getApi3ServerV1()`
- `setDIAOracleV2(address)` / `getDIAOracleV2()`
- `setSecondaryOracleMaxDeviationBps(uint16)` (default 500 = 5%)
- `setSecondaryOracleMaxStaleness(uint40)` (default 3600 = 1h)

All ADMIN_ROLE-gated; timelock-gated post-handover. Setting any
oracle address to zero disables that leg of the quorum; the
remaining sources still apply (or graceful fallback to Chainlink-
only if all three are zero).

**Operational guidance**: every chain that hosts loans should
configure at least 2 of the 3 secondaries to deliver real cross-
provider redundancy. Pre-deploy verification (`ChainByChainChecks.md`)
now includes a "≥ 2 of 3 secondaries configured" check.

**Files touched**:

- New interfaces: `contracts/src/interfaces/ITellor.sol`,
  `IApi3ServerV1.sol`, `IDIAOracleV2.sol`.
- Removed: `contracts/src/interfaces/IPyth.sol`,
  `contracts/test/mocks/MockPyth.sol`,
  `contracts/test/PythDeviation.t.sol`.
- `contracts/src/facets/OracleFacet.sol`: removed
  `_enforcePythDeviation` + `_normalizePythToPrimary`; added
  `_enforceSecondaryQuorum` + `_checkTellor` / `_checkApi3` /
  `_checkDIA` + symbol-derivation helpers (`_safeSymbol`, `_toLower`,
  `_toUpper`, `_rescale`); new `SecondaryStatus` enum
  (`Unavailable / Agree / Disagree`).
- `contracts/src/facets/OracleAdminFacet.sol`: removed
  `setPythEndpoint` / `getPythEndpoint` / `setPythFeedConfig` /
  `getPythFeedConfig`; added 10 new wrappers for the Tellor / API3
  / DIA / deviation / staleness setters + getters.
- `contracts/src/libraries/LibVaipakam.sol`: removed
  `PythFeedConfig` struct + `pythEndpoint` + `pythFeedConfigs`
  storage slots + `setPythEndpoint` / `setPythFeedConfig` internal
  setters + Pyth events; added `tellorOracle`, `api3ServerV1`,
  `diaOracleV2`, `secondaryOracleMaxDeviationBps`,
  `secondaryOracleMaxStaleness` slots + matching internal setters /
  effective-getter helpers + `SECONDARY_ORACLE_*_DEFAULT`
  constants.
- `contracts/test/SwapAdapterTest.t.sol` — unchanged; Phase 7a path
  is independent.
- `contracts/test/SecondaryQuorumTest.t.sol` (new) — 27 tests
  driving the Soft 2-of-N decision matrix end-to-end against
  `vm.mockCall`-stubbed Tellor / API3 / DIA. Coverage: per-source
  Agree / Disagree / Unavailable triggers (zero address, no data,
  stale, zero value, oracle revert, symbol unreadable), every
  meaningful 1-source / 2-source / 3-source combination, the
  graceful-fallback edge cases (all unavailable, no agreement and
  no disagreement), and the configuration knobs (deviation
  tightening rejects prior-agreeing data; staleness loosening
  accepts prior-rejected data). All 27 pass; full no-invariants
  regression at 1386 / 0 / 5.

**Storage-layout warning** (no impact in practice): removing the
mid-struct `pythEndpoint` and `pythFeedConfigs` slots shifts every
slot below them by 2 positions. Diamond is pre-mainnet so this is
safe. After the first mainnet deploy this kind of removal will
require a migration plan instead.

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
- **Phase 8b** (Permit2 + Blockaid simulation): shipped today,
  including the 5-test fork suite against real Uniswap Permit2 at
  the canonical address (`test/fork/Permit2RealForkTest.t.sol`).
  Covers the happy path, expired-deadline revert, wrong-amount
  revert, nonce-reuse revert, and spender-mismatch revert. Gated by
  `FORK_URL_MAINNET` env so CI without archive credentials passes
  unchanged. Mock-Permit2 still covers the integration-flow logic
  in the unit suite for sub-second iteration speed.
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
- **Phase 7b** (multi-venue oracle redundancy): both 7b.1 (depth
  classification, 3-V3-clone OR-logic) and 7b.2 (price feed,
  symbol-derived Tellor + API3 + DIA Soft 2-of-N quorum) shipped
  today. Pivoted from the originally-scoped UniV3 + Balancer V2 OR
  (would have required per-asset Balancer poolId mapping) to a
  3-V3-clone OR. Pivoted from Pyth-based price redundancy to
  symbol-derived Tellor + API3 + DIA after research surfaced that
  Pyth's `priceId` mapping is per-asset; chose Soft 2-of-N
  (Interpretation B) over Strict 2-of-N to preserve operability on
  long-tail assets and chains with sparse secondary coverage. Zero
  per-asset governance configuration required for either piece.
  Regression clean: 1359 passing / 0 failed in the no-invariants
  subset (down 16 from the 1375 figure earlier in the day, because
  the now-deleted 16-test PythDeviation suite was scrubbed as part
  of the Pyth removal). Targeted Soft 2-of-N quorum tests
  (`SecondaryQuorumTest.t.sol`) are queued as the remaining 7b
  follow-up.
- **Phase 9** (growth sprint): three of four sub-items shipped
  today — PWA manifest + service worker, public keeper-bot reference
  repo at the sibling `vaipakam-keeper-bot` repository, and an
  Active-loan check Farcaster Frame
  on the existing hf-watcher worker. Points/leaderboards (the fourth
  sub-item) was dropped after design review — revisit when a specific
  user-acquisition goal would benefit from a leaderboard.

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
