# Rate Desk — a trading-terminal page for the Vaipakam offer book

**Status:** Design pass — **ratified 2026-07-10** (operator answers folded into §10)
**Reference inspiration:** perp-DEX trade pages (chart + order book + ticket + positions in one dense screen)
**Prior art this builds on:** [`UxDirectionDexCexHybrid.md`](UxDirectionDexCexHybrid.md) (#166),
[`CanonicalLimitOrderPhase2Design.md`](CanonicalLimitOrderPhase2Design.md) (#183),
[`RangeOffersDesign.md`](RangeOffersDesign.md), [`OfferModificationDesign.md`](OfferModificationDesign.md) (#193),
[`OfferFillModesDesign.md`](OfferFillModesDesign.md) (#125), [`OfferExpiryGTTDesign.md`](OfferExpiryGTTDesign.md) (#195),
[`MarketRateWidgetAndDepthTieredLTV.md`](MarketRateWidgetAndDepthTieredLTV.md),
[`SignedOfferBookV05Design.md`](SignedOfferBookV05Design.md) (#396),
[`BasicUserUXSimplification.md`](BasicUserUXSimplification.md).

---

## TL;DR — verdict first

**Yes, it is possible — and it is mostly an assembly job, not a build job.** The scouting
pass found that the contract surface for a limit-order trading terminal already exists
end-to-end: limit interest rate (`interestRateBps` / `interestRateBpsMax`), GTC/GTT expiry
(`expiresAt`), fill modes (`Partial`/`AON`/`IOC`), partial fills with `amountFilled`, in-place
cancel/replace (`modifyOffer` / `setOfferRate` — contracts shipped, **no UI anywhere**), a
pair-keyed depth read (`getActiveOffersByAssetPairRanked`), positions via current-holder
reads hydrated with `getLoansBatch` + the HF/LTV risk overlay (§3), and partial repay. The executed-rate
history for a chart already exists **row-by-row** in the indexer's `loans` table
(`interest_rate_bps`, `start_at`, `lending_asset`, `collateral_asset`); the only data gap is
an OHLC aggregation endpoint + a pair index + a chart library (none in the workspace).

**The one structural divergence from a perp DEX**: Vaipakam's book is keyed by the triple
`(lendingAsset, collateralAsset, durationDays)` — the on-chain matcher requires *exact*
duration equality (`LibOfferMatch.sol` `DurationMismatch`). A perp has one perpetual market
per pair; we have one market per pair **per tenor**. The terminal must therefore surface a
**tenor selector** (the guided flows' duration buckets: 7/14/30/60/90/180/365d) next to the pair selector — closer to a futures
expiry picker than a perp market chip, and honest to the protocol's actual microstructure.

**Recommended approach**: build it as an **alpha02 Advanced-mode route** (`/desk`), not a
new app and not an apps/defi rework — phased, with the rate chart in phase 2. Rationale in §4.

---

## 1. Context — what the scout found

### 1.1 On-chain: the terminal surface is ~90% shipped

| Terminal concept | Vaipakam counterpart | Fit |
|---|---|---|
| Limit price → **limit interest rate** | `interestRateBps` (single-value) or `[interestRateBps, interestRateBpsMax]` band (`LibVaipakam.sol:1550/1585`) | 1:1 |
| Limit order (post to book) | `createOffer(CreateOfferParams)` (`OfferCreateFacet.sol:369`), mints a position NFT | 1:1 |
| GTC / GTT | `expiresAt == 0` sentinel / non-zero `expiresAt` + lazy expiry + permissionless clean-up of lapsed offers (#195) | 1:1 |
| IOC / AON | `FillMode { Partial, Aon, Ioc }` (`LibVaipakam.sol:731`); IOC requires expiry, AON requires single-value amount (#125). FOK folded into AON, POST deliberately not built (every offer is a maker) | 1:1 (FOK/POST rejected by design) |
| Order-book depth by rate | `MetricsFacet.getActiveOffersByAssetPairRanked(lend, coll)` → `OfferRanking[]` (`MetricsFacet.sol:634`) — the pair-keyed book read. Caveat: the skinny DTO omits `amountFilled`, so depth needs a `getOffersWithState` hydration step (§3) | 1:1 with hydration (client sorts/aggregates; must additionally slice by `durationDays`) |
| Taker crossing the book | Two paths: manual `acceptOffer` (full fill at maker terms, EIP-712 term-bound #662; rejects partially-filled offers) and the permissionless midpoint-crossing matcher `matchOffers(L, B)` + `previewMatch` (`OfferMatchFacet.sol:140/170`) | Partial — see §5.2 |
| Cancel / replace (amend) | `OfferMutateFacet.modifyOffer` / `setOfferRate` / `setOfferAmount` / `setOfferCollateral` (in-place, same offerId, unaccepted only) + `cancelOffer` | 1:1 — **contracts shipped, no UI in either app** |
| Open orders panel | `getUserOffersByStatePaginated`, `OfferView` DTO (state, filled, expiry) | 1:1 |
| Positions panel | `Loan` struct + `LoanWithRisk` (pre-computed `ltvBps` + `healthFactor`); position ownership follows the **position NFT's current holder**, so the panel reads current-holder routes, not the historical-party `getUserDashboardLoans` walk (§3) | 1:1 via current-holder reads |
| Reduce / partial close | `RepayFacet.repayPartial` (gated on `loan.allowsPartialRepay`) | 1:1 (opt-in per loan) |
| Mark / index price | `OracleFacet.getAssetPrice` (Chainlink + 2-of-N cross-validation) — spot only | Partial — no mark/funding construct, deliberately (see §6) |
| Gasless order posting | `SignedOfferFacet` EIP-712 signed offers (v0.5 shipped) + `matchSignedOffer` (v0.6) | Exists — phase-3 candidate |
| Self-trade prevention | Blocked in the matcher (`SelfTrade`) per `SelfTradePreventionADR.md` | 1:1 |

### 1.2 Data: the rate series exists; the aggregation doesn't

- The indexer's `loans` table (`apps/indexer/migrations/0005_loans_and_activity.sql:29-64`,
  with `interest_rate_bps` added by `0006_loan_token_ids.sql:26`) carries **every executed
  loan's** `interest_rate_bps`, `start_at`, `lending_asset`, `collateral_asset`,
  `principal`, `duration_days`, `status`. This is the trade tape.
- The `offers` table carries the live book (rate bands, `amount_filled`, `expires_at`,
  `fill_mode`). Depth is derivable per pair.
- **Missing**: an OHLC/candle endpoint (none), per-pair grouping on any endpoint
  (`/loans/timeseries` buckets TVL by `lending_asset` only; `/loans/stats` returns one
  global mean rate), a `(chain_id, lending_asset, collateral_asset, duration_days,
  start_at)` index, and a charting library (no viz dependency anywhere in the workspace).
- **Realtime**: the live-ingest rail is **already rolled out** — the indexer's per-chain
  WebSocket push (`/ws/chain/:chainId` → `ChainIngestDO`) runs with
  `CHAIN_INGEST_VIA_DO: "true"` (`apps/indexer/wrangler.jsonc:150`) and alpha02 mounts
  the client (`IndexerPushSync.tsx`) in the app shell. What's missing for the desk is
  only registering its query roots in the push `KEY_MAP` (§8 phase 3); until then its
  queries ride the 30s idle-aware poll.

### 1.3 UI: one order-book layout exists; the flagship app has none

- `apps/defi/src/pages/OfferBook.tsx` (2.6k lines) is already a two-sided book: lender
  table above, borrower table below, a **market-anchor rate band** between them,
  pair/duration/liquidity filters, rank-by-distance-to-anchor, accept modal with Permit2.
- `apps/alpha02` (the flagship redesign) has only a flat advanced-mode list
  (`pages/Offers.tsx`) — no table, no depth, no pair pivot.
- `packages/ui` is deliberately thin (5 primitives). No dense multi-panel layout
  primitive, no chart. Both would be net-new.
- The Basic/Advanced doctrine (`ModeContext`, `BasicUserUXSimplification.md`) gives the
  terminal a natural home: an advanced-only route, hidden from Basic nav, deep-linkable.

---

## 2. What the page is (and is not)

**It is**: the power-user surface for the offer book — a single dense screen where a rate
trader can (a) read the market for a (pair, tenor), (b) post/amend/cancel limit-rate
offers without leaving the screen, (c) hit the other side, and (d) watch their open
orders and live positions with HF risk. It is the culmination of the #166 ADR's Tier-A
program: every idiom it uses (limit ticket, book sides, GTC/GTT chips, fill-mode chips,
in-place amend, fill-progress bars) is already ratified there.

**It is not**: a perp venue. There is no leverage slider, no funding rate, no mark-price
liquidation, no 24h-ticker theatre. The #166 ADR explicitly rejected "funding rate",
"margin ratio", "stop-loss", and AMM depth idioms — this design inherits those
rejections wholesale (§6).

### 2.1 Vocabulary (locked per #166)

- The y-axis / price column is **"Rate (APR %)"** — never "price". BPS on hover (A.6).
- **Asks = lender offers** (each lender's `interestRateBps` floor — "I lend at ≥ X%"),
  sorted ascending; best ask = lowest lender rate.
- **Bids = borrower offers** (each borrower's `interestRateBpsMax` ceiling — "I pay ≤ Y%"),
  sorted descending; best bid = highest borrower rate.
- **Book mid** = midpoint of best bid / best ask when both exist. The market is **crossed**
  when best bid ≥ best ask — unlike a CEX this is a *normal resting state* here (see §5.2).
- A **market** = `(lendingAsset, collateralAsset, durationDays)`. UI: pair chip + tenor chip.

---

## 3. Page layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [WETH / USDC ▾]  [30d ▾]   last 5.20%   book 5.05 / 5.40   oracle $2,431     │  header strip
├───────────────────────────────────────────┬──────────────────────────────────┤
│                                           │  ORDER BOOK (rate ladder)        │
│   RATE CHART (phase 2)                    │   asks (lenders)   size   Σ      │
│   executed-rate candles / step-line       │   5.90%            12.0k  38.2k  │
│   + book-mid overlay                      │   5.40%            26.2k  26.2k  │
│   + trade markers when sparse             │   ── mid 5.23% · spread +0.35 ── │
│                                           │   5.05%            18.0k  18.0k  │
│                                           │   4.80%             7.5k  25.5k  │
│                                           │   bids (borrowers)               │
│                                           ├──────────────────────────────────┤
│                                           │  ORDER TICKET                    │
│                                           │  [Lend | Borrow]                 │
├───────────────────────────────────────────┤  amount ▸ rate ▸ collateral      │
│  TAPE — recent fills (loans initiated)    │  [GTC ▾] [Partial ▾]             │
│  5.20%  8.0k  2m ago   5.35%  1.2k  1h    │  live precheck (sim) ▸ [Post]    │
├───────────────────────────────────────────┴──────────────────────────────────┤
│  [Open orders]  [Positions]  [History]                                       │
│  own offers: rate/size/filled-bar/expiry/✎ amend/✕ cancel                     │
│  loans: side/principal/rate/HF-band/accrued/actions (repay·partial·top-up)   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Panel-by-panel, with the backing read/write:

| Panel | Reads | Writes | Notes |
|---|---|---|---|
| Header strip | book (see Order book row); last trade from indexer `/loans/recent` with the **pair+tenor server filter (phase 1, §7)**; `getAssetPrice` for the collateral oracle chip | — | Tenor chips are the SAME duration set the guided Lend/Borrow flows offer — `OFFER_DURATION_BUCKETS_DAYS` (7/14/30/60/90/180/365d, 30d default, `apps/alpha02/src/lib/offerSchema.ts:63`) — single source of truth, so a tenor postable from the guided flows is always selectable on the desk (a 1d bucket is a planned future addition there and flows through automatically). Chips with live orders are visually emphasized; empty tenors render with an honest empty state. The "last" seed must be tenor-scoped: `useMarketAnchorRate` is pair-only today (`useMarketAnchorRate.ts:32-101`) and MUST NOT seed a tenor market as-is — extend it with a `durationDays` check or seed from the tenor-filtered tape instead (a 7d fill must never seed the 30d header). |
| Order book | **two-step read**: `getActiveOffersByAssetPairRanked` for the pair's ids/ordering, then hydrate via `getOffersWithState(ids)` — the skinny `OfferRanking` DTO omits `amountFilled` (`MetricsFacet.sol:591-600`), so remaining depth is computable only from hydrated rows (`amountMax - amountFilled`). Hydration MUST be chunked at `MAX_BATCH_IDS = 250` (`MetricsDashboardFacet.sol:61` — the batch view reverts `BatchTooLarge` above it), so a busy pair degrades to a bounded ladder instead of blanking the book. Aggregate rate levels from **remaining** size, never `amountMax`; and **drop lazily-expired GTT rows** (`expiresAt != 0 && expiresAt <= chain time`) before computing best bid/ask, tenor chips, or depth — expiry is lazily enforced, so the ranked read can still return rows that `acceptOffer` rejects with `OfferExpired`. (Alternative: extend the ranking DTO with `amountFilled` — small contract change, phase-3 candidate.) | click a level → pre-fills the ticket at that rate (maker); taker affordance arms direct `acceptOffer` **only on unfilled, unexpired rows** — direct accept rejects partially-filled offers (`OfferAcceptFacet.sol:767-781`) and expired ones (`OfferExpired`); partially-filled rows are crossable only via the matcher | Fill-progress from hydrated `amountFilled/amountMax` (A.9); own orders highlighted |
| Order ticket | `useTxSimulation` precheck (reuses the #1112 under-collateral banner), `quoteOfferRateBps` as a "suggested rate" hint | `createOffer` / `createOfferWithPermit` | Side toggle, amount (+ optional range), limit rate (+ optional band), collateral, tenor, expiry preset (GTC/24h/7d/custom), fill-mode chip (Partial/AON/IOC) |
| Tape | indexer `/loans/recent` with the **pair+tenor server filter (phase 1, §7)** — the current handler is a global newest-first page capped at 200 rows (`loanRoutes.ts:764-774`, `:1171-1175`); client-filtering it misses any market not among the latest global fills, so the server filter is a phase-1 prerequisite, not a phase-2 nicety | — | Sparse-honest: shows "N fills this week" not a fake ticker |
| Open orders | **union of created + held**: `getUserOffersByStatePaginated` (creator walk) ∪ `/offers/by-current-holder` / `getUserPositionOffers` — offers are position NFTs, so an open offer bought/received by a wallet is invisible to the creator walk alone; alpha02's existing hook already does this union | **`modifyOffer` / `setOfferRate` (first UI for #193)**, `cancelOffer` — both gated on `offer.creator === wallet` (the contracts authorize only the creator; held-not-created rows render read-only) | Amend = pencil → inline edit of rate/size/collateral, one tx, same offerId — **for rate-only or shrinking edits**. A grow (more lender principal / more borrower collateral) pulls via `_pullOrRefundErc20` → vault deposit, consuming Diamond allowance, and there is **no `modifyOfferWithPermit`** — the amend modal needs the same allowance precheck + classic-approve fallback as create/accept, or the "one tx" claim reverts for under-approved wallets |
| Positions | **current-holder reads**, not historical parties: indexer `/loans/by-current-holder` (already exists) or position-NFT holder enumeration, hydrated via `getLoansBatch` + `calculateHealthFactor` overlay. `getUserDashboardLoans` walks historical `l.borrower`/`l.lender` (`MetricsDashboardFacet.sol:188-239`) and goes stale the moment a position NFT is transferred/sold — it would omit a buyer's position and show the seller dead manage actions | `repayLoan` / `repayPartial` / add-collateral | HF colour bands per B.1; accrued interest computed client-side (`LibEntitlement` mirror already exists in the dashboard flow) |
| History | requires a **true server-side historical-participant route** (new indexer endpoint deriving participation from the `loans`/`offers` tables' lender/borrower/creator columns, all statuses) — every client-side composition falls short of permanent history: the actor feed misses lender fills (`LoanInitiated` has `actor = borrower`, `chainIndexer.ts:3110-3175`), `/loans/by-lender`/`by-borrower`/`by-current-holder` are **current-owner** filtered, and burns are written to `0x0` (`chainIndexer.ts:2770-2775`) — a lender whose loan was repaid+claimed disappears from all of them (the gap `Activity.tsx:72-74` already documents). The History tab therefore ships in **phase 2 alongside that route** (§8); phase 1 has no History tab rather than a silently incomplete one | — | |

**Mobile (first-class, not a degraded stack).** alpha02 is mobile-first, and the
reference perp terminals treat mobile as its own layout rather than a reflow (verified
against the reference desk on a 390×844 viewport, 2026-07-10): a compact sticky market
header, then the **rate ladder and the order ticket side-by-side as the primary view**
(the ladder is a narrow column; tapping a ladder row pre-fills the adjacent ticket —
the highest-frequency loop stays on one screen), the **chart and tape behind a
bottom-center segmented toggle** (chart arrives in phase 2; the toggle ships with one
segment until then), and **Open orders / Positions as bottom tabs**. Amend/cancel/repay
actions stay reachable on mobile — nothing is desktop-only; density is what changes,
never capability. The honesty rules (§5.3) apply unchanged on the mobile chart view.

---

## 4. Where it lives — decision

**Option A (recommended): alpha02 Advanced-mode route `/desk`.**
- alpha02 is the flagship; it already has the mode doctrine (advanced routes hidden from
  Basic nav, deep-linkable), push-sync client, tx simulation, Permit2, kill-switch,
  GoPlus badges, EIP-712 accept — every flow the terminal composes is already built and
  live-reviewed there. The terminal becomes the *reveal payoff* of Advanced mode.
- Per the shell doctrine (`BasicUserUXSimplification.md`), `/desk` is **hidden from
  Basic navigation but stays URL-reachable in both modes** — the same
  hidden-not-blocked rule every advanced route follows today. No mode-based deep-link
  block. The guided Borrow/Lend flows remain the front door, preserving the
  naive-user-first thesis while giving power users a reason to stay.

**Option B: rework apps/defi's OfferBook into the terminal.** Rejected: defi already has
the two-sided book but is the legacy surface; investing the terminal there splits the
roadmap and duplicates alpha02's newer flow plumbing (simulation, push, kill-switch).

**Option C: a new `apps/pro` app.** Rejected: a third SPA to deploy/maintain for one
page; loses shared mode/session context; nothing about the terminal needs an app boundary.

**Naming**: route `/desk`, nav label + page title **"Rate Desk"** (advanced-only).
"Rates desk" is the real-world finance term for the desk that operates in
interest-rate products — exactly what this page is — and it keeps the vocabulary
rate-first per the lock in §2.1. Alternatives considered: **"Trade"/`/trade`
(rejected — implies asset swapping, the exact semantic drift the #166 ADR exists to
prevent)**; "Markets"/`/markets` (accurate but passive — names where you are, not what
you do); "Rates"/`/rates` (reads as a comparison/info page); "Terminal"/`/terminal`
(sterile, collides with the CLI sense); "Pro"/`/pro` (names the persona, not the
function).

---

## 5. Market-microstructure honesty (the load-bearing design constraints)

### 5.1 The tenor dimension is not optional

The matcher requires exact `durationDays` equality, so depth at "WETH/USDC" as a single
market **does not exist** on-chain — depth exists per tenor. Rendering one merged book
would advertise liquidity that cannot cross. The tenor chip is therefore a first-class
market selector, and the book/chart/tape all key on the triple. A "all tenors" overview
table (tenor → best bid/ask/depth) can sit in the header dropdown for discovery.

### 5.2 Two crossing regimes — and the UI must be honest about which is live

- **Direct accept** (always on): a taker fills a specific maker offer *in full* at the
  maker's terms. This is "hit the top of book" and is what the book's taker affordance does.
- **The crossing matcher** (`matchOffers`, midpoint rate/amount, partial fills, 1% LIF to
  the matcher) is gated by `ConfigFacet.partialFillEnabled`. **`DeployDiamond.s.sol:634`
  flips it ON during deployment, and both deploy-testnet.sh and deploy-mainnet.sh run
  that script — so the flag is expected ON everywhere**; it exists as a governance
  kill-switch, not a staged-enablement default. When it's on, a crossed book (best bid ≥
  best ask) is *matchable* and the UI shows a "crossable" band with `previewMatch`
  output ("these two orders can match at 5.23% midpoint — anyone can execute and earn
  the matcher fee"). If governance ever flips it off, the crossed band renders as
  informational only. The flag is read at runtime (`getMasterFlags`); the UI must not
  hard-code either state.
- There is **no price-time priority on-chain**. The book's sort is a UI ranking, not an
  execution queue. Copy must never promise "your order is #2 in the queue"; it can say
  "best rate on your side".

### 5.3 Thin-market honesty (this decides whether the chart adds or destroys value)

Testnet (and early mainnet) volumes are a handful of fills per day per pair. A
candlestick chart pretending to be a liquid market would be theatre — and misleading
theatre is exactly what alpha02's honesty rules (empty-state doctrine, F-20260702-001)
exist to prevent. Rules:

1. **Candles only when a bucket has ≥ 1 fill; no interpolation.** Gaps render as gaps.
2. Below a density threshold (e.g. < 10 fills in the visible range) the chart drops to
   **step-line + discrete trade markers** — visually "sparse tape", not "flat market".
3. Every bucket's tooltip shows **fill count + total principal**, not just OHLC.
4. The **book-mid overlay** (quoted, not executed) is drawn in a distinct style and
   labelled "quoted mid" — never blended with executed candles.
5. No 24h %-change ticker until a pair sustains meaningful daily fills; the header shows
   "last fill: 5.20% · 2h ago" instead. (A %-change on 2 trades is noise sold as signal.)

---

## 6. Explicitly out of scope (inherited rejections from #166 + new)

- **Funding rate, mark price, leverage, margin ratio, stop-loss** — no protocol
  counterpart; the loan rate is fixed at init (E2). Rejected in #166; stays rejected.
- **AMM-style depth curve** — we are an order book; the AMM idiom implies continuous fill.
- **Price-time priority / matching-engine telemetry** — doesn't exist on-chain (§5.2).
- **FOK / POST fill modes** — deliberately not built contract-side (#125 rationale).
- **An order-management backend** (server-held orders) — the book is on-chain + signed
  offers; the terminal never custodies intent server-side beyond what #396 already does.
- **New contract work.** Phase 1–2 require **zero** contract changes. (The only candidate
  — a paginated variant of `getActiveOffersByAssetPairRanked` if pair buckets grow large —
  is deferred until a real pair exceeds ~200 live offers.)

---

## 7. The rate chart — data plan (phase 2)

**Endpoint** (new, `apps/indexer`):
`GET /loans/rate-candles?chainId&lendingAsset&collateralAsset&durationDays&interval=1h|4h|1d&range=7d|30d|90d|all`
→ `{ buckets: [{ t, open, high, low, close, fills, principalTotal }] }` — `principalTotal`
is a **decimal string** (wei), matching every existing indexer amount field; a JSON
number would lose precision and a raw `BigInt` cannot be JSON-serialized,
`Cache-Control: max-age=60`. Executed fills only (`LoanInitiated`); no synthetic data.

**Aggregation split — BigInt-safe by construction**: the rate fields
(`open/high/low/close`, from `interest_rate_bps`) and `fills` counts are small integers
and MAY be SQL-aggregated. `principalTotal` MUST NOT be summed in SQL: `loans.principal`
is stored as a decimal **string** precisely because wei-denominated 18-dec amounts
overflow SQLite's 64-bit integers — the existing `/loans/stats` deliberately selects
rows and sums with JS `BigInt` (`loanRoutes.ts:676-703`). The candle endpoint follows
the same pattern: SQL selects the bucketed rows, JS `BigInt` folds the principal per
bucket. (Testnet row counts make this cheap; if a pair's range query ever gets hot, a
materialized per-bucket total is the escalation, never SQL `SUM`.)

**Migration**: add index `(chain_id, lending_asset, collateral_asset, duration_days,
start_at)` on `loans` (new file under `apps/indexer/migrations/`, per the D1 schema
discipline). The index key matches the market boundary exactly — omitting
`duration_days` would leave a hot multi-tenor pair scanning every fill for the pair and
post-filtering the tenor.

**Server-side pair+tenor filters** on `/loans/recent` (tape) and `/offers/active`
(book fallback when RPC is unavailable) are a **phase-1 prerequisite** (see §8) — both
endpoints today are global newest-first pages capped at 200 rows
(`loanRoutes.ts:764-774`, `offerRoutes.ts:225-234`); a market whose rows are older than
the first page would falsely render as empty if the terminal client-filtered them.

**Chart library**: `lightweight-charts` (TradingView's OSS canvas lib, ~45 kB gzipped,
zero network calls — CSP-clean, MIT-adjacent license (Apache-2.0), dark/light theming).
It is the de-facto standard for exactly this aesthetic and supports candles, step-lines,
and markers natively. Alternatives considered: recharts (SVG, wrong idiom for a
terminal, heavier per-point), d3 (a toolkit, not a chart — highest build cost), visx
(same). New dependency scoped to alpha02 only (`apps/alpha02/package.json`), lazy-loaded
with the `/desk` route chunk — users who never visit `/desk` (the Basic-nav default
path) never download it; a Basic-mode user following a direct `/desk` link does, by
design (§4 keeps the route URL-reachable in both modes).

**Chart content**: executed-rate series (candles/step per §5.3) + "quoted mid" overlay
derived from the live book + optional volume (principal) histogram. The header's
cold-start "last" value comes from the pair+tenor-filtered tape (or the last candle) —
NOT from `useMarketAnchorRate` as-is, which matches on pair only and would seed a 30d
market with a 7d fill (§3 header-strip note); if that hook is reused it must first gain
a `durationDays` parameter.

---

## 8. Phasing

**Phase 1 — Terminal shell (no chart), alpha02 `/desk`.** Header strip + pair/tenor
selectors, rate-ladder book (ranked ids + `getOffersWithState` hydration per §3 —
remaining-size depth, never headline size), order ticket (createOffer with expiry +
fill-mode chips, simulation precheck), tape, open-orders panel with **cancel + the
first amend UI (#193)**, positions panel (current-holder reads per §3) with HF bands +
repay/partial actions (no History tab in phase 1 — see the History row in §3).
**Includes the small indexer slice**: pair+tenor server filters
on `/loans/recent` + `/offers/active` — the tape and the book's RPC-outage fallback are
not honest without them (global 200-row pages can't scope to a market), so they are
phase-1 scope, not phase-2 — **plus the matching D1 indexes in the same migration**:
the filters need route-shaped market indexes (e.g. offers
`(chain_id, status, lending_asset, collateral_asset, duration_days)` and loans
`(chain_id, lending_asset, collateral_asset, duration_days, loan_id)`); the existing
offer indexes cover only `(chain_id, status)` / creator / current-holder lookups, so a
filter without its index devolves into a global scan exactly where the terminal depends
on it. All data on the existing 30s idle-aware poll + push-sync invalidation.
*Estimated: the largest single alpha02 page to date, but composed entirely of existing
flows — comparable to the OfferFlow build.*

**Phase 2 — Rate history + History tab.** Indexer OHLC endpoint + the
`(chain, pair, tenor, time)` candle index migration; BigInt-safe principal aggregation
(§7); lightweight-charts integration; sparse-honesty rules (§5.3); the
historical-participant route + the desk's History tab (§3 History row).

**Phase 3 — Live-ness + depth polish.** The live-ingest rail is **already rolled out**
(`CHAIN_INGEST_VIA_DO: "true"` in `apps/indexer/wrangler.jsonc:150`; alpha02 mounts
`IndexerPushSync` in the app shell) — phase 3's job is to **register the terminal's
query roots/keys in the push `KEY_MAP`** so book/tape/candle queries invalidate on
`offer.*`/`loan.*` frames instead of waiting for the 30s poll; book delta animations;
crossable-band `previewMatch` surfacing (runtime-gated on `getMasterFlags`, §5.2);
gasless signed-offer posting from the ticket — which requires the **indexer signed-offer
book** (storage + read path for unfilled signed offers, deliberately scoped out of the
v0.5 contract PR per `SignedOfferBookV05Design.md`): the shipped surface only
verifies/fills signatures, so without that plumbing a desk-generated signature is
undiscoverable by any taker. Phase 3 ships the relay/store/read path together with the
ticket toggle, or not at all.

Each phase is independently shippable and independently valuable; phase 1 alone already
delivers the two things no UI currently offers (a real book view in the flagship app +
amend-in-place).

**Verification (per the alpha02 DoD)**: each phase ships the e2e checks for what that
phase actually builds. Phase 1: CI-Anvil specs (book rendering from seeded offers,
ticket posting, amend, cancel) + a live driver under `e2e/live/` (post → amend → cancel
a real testnet offer). Phase 2 adds the chart assertions (candles/step-line from seeded
history, sparse-honesty behaviours) + History-tab coverage. Every phase updates
`apps/alpha02/e2e/COVERAGE.md` in the same diff.

---

## 9. Does this add value? (the honest take)

**For three personas, clearly yes:**
1. **Rate-shopping power users** — today comparing offers means scrolling a flat list;
   a rate ladder answers "what's the market for WETH/USDC 30d" in one glance. This is
   the single highest-leverage view the platform lacks.
2. **Lender market-makers** — range offers + partial fills + amend-in-place *are* a
   market-making toolkit; the contracts shipped it, but without a terminal UI nobody can
   actually operate it. The amend UI alone (one tx reprice, keeps offerId/NFT/indexer
   follow-state) is a real cost saving vs today's cancel+recreate.
3. **Keepers/solvers** — the crossable-band + `previewMatch` surfacing makes the 1% LIF
   matcher opportunity visible, which seeds the third-party matcher ecosystem the
   protocol design assumes.

**The rate chart adds value with the honesty rules, and destroys it without them.**
"What does this pair actually clear at?" is genuine price discovery that no lending
UI here answers today — even 20 lifetime fills, drawn honestly (markers + step-line +
fill counts), beat the current nothing. But a candlestick pretending thin data is a
liquid market misleads exactly the users a terminal attracts. §5.3 is the difference.

**The risk to manage is persona confusion, not effort.** Vaipakam's thesis (alpha02) is
naive-user-first; a terminal is the opposite persona. The Advanced-mode boundary already
solves this — `/desk` stays out of Basic navigation (URL-reachable per the shell
doctrine); the guided flows remain the front door.
The failure mode to avoid is letting terminal idioms leak back into Basic surfaces.

**Better-approach check**: the plausible alternatives — enriching the flat Offers list
incrementally, or building the terminal into apps/defi — were considered and rejected
(§4): the first can't express a two-sided ladder + ticket + positions in one screen
(which is the entire point), the second invests in the legacy surface. One genuinely
cheaper alternative exists: **phase 1 without the chart panel** (chart column collapsed
to the header sparkline) — that is in fact what phasing already does; the chart is
strictly additive.

---

## 10. Open questions — RATIFIED (operator answers, 2026-07-10)

1. **Route + nav** — ✅ CONFIRMED: "Rate Desk" at `/desk` with an advanced-only nav
   entry (naming rationale + rejected alternatives in §4).
2. **Pair universe** — ✅ CONFIRMED: chip row limited to pairs with live offers +
   curated defaults (stable × WETH), custom-address picker behind "more" (GoPlus
   screening already covers pasted assets).
3. **Tenor presets** — ✅ DECIDED: the chips mirror the guided flows' full duration
   set (`OFFER_DURATION_BUCKETS_DAYS`: 7/14/30/60/90/180/365d, 30d default) rather
   than a promoted subset — single source of truth with the Lend/Borrow pages. A 1d
   bucket is planned there in future and flows through automatically.
4. **Tape scope** — ✅ resolved during review + confirmed: the tape ships in phase 1
   **with** the pair+tenor server filter (+ index). Client-filtering the global
   `/loans/recent` page was considered and rejected — it silently blanks any market
   whose fills are older than the global first page (§3, §7, §8).
5. **lightweight-charts** — ✅ CONFIRMED as the chart dependency (Apache-2.0, one-line
   attribution link in the chart corner).
