# Findings 2026-07-15 — alpha02 pagination / list-bounding audit (#1247)

Static code audit of **every list-rendering surface** in
`apps/alpha02/src`, per the owner directive (2026-07-14, issue #1247):
verify each list is properly paginated at BOTH layers — the data layer
(indexer routes / chain enumeration) and the UI layer (a bounded
render window with a load-more affordance) — not just the
known-paginated ones. Findings carry `PAG-###` IDs; unmarked findings
are OPEN. (Revised after Codex review of PR #1264: one missed surface,
three data-layer gaps the first pass mis-classified as bounded, and
two overstated claims corrected.)

## Method

Code-level sweep (not a live-browser pass): every `.map()` over
query-fed data in `pages/` and `components/` was traced to its source
bound, plus the indexer routes' server-side caps, the chain
enumeration helpers' page walks, and the contract views the chain-first
paths call. Each surface gets a two-layer verdict:

- **bounded** — both layers bounded, or bounded by nature (static /
  contract-capped data).
- **data-bounded-only** — the fetch is capped, but the UI renders the
  ENTIRE fetched array as row components with no slice,
  virtualization, or pager.
- **data-layer gap** — the fetch itself has no cap (a walk without a
  ceiling, a route without a LIMIT, or a contract view returning a
  whole bucket).

## Reference: the standing caps (and their two soft spots)

| Layer | Bound | Where |
| --- | --- | --- |
| Indexer offer/loan/activity row routes | `DEFAULT_PAGE_LIMIT 50`, `MAX_PAGE_LIMIT 200` (clamped server-side) | `apps/indexer/src/offerRoutes.ts`, `loanRoutes.ts` |
| Indexer signed-offer book | ≤100 best-priced rows/side + `truncated` flag + optional `signer` scope (PAG-011, fixed) | `apps/indexer/src/signedOfferRoutes.ts` |
| `/claim-candidates` | 200-row cap + `truncated` flag | `loanRoutes.ts` (PR C, #1232) |
| `/claimables` | 200 newest terminal loans + `truncated` (PAG-007, fixed) | `loanRoutes.ts` |
| `/offers/markets` | 200 deepest markets + `truncated` (PAG-010, fixed) | `offerRoutes.ts` |
| `/loans/rate-candles` | newest 10,000 fills scanned + `truncated` (PAG-009, fixed) | `loanRoutes.ts` |
| Client indexer walks | `limit 100` × ≤5 pages = 500/leg, `null` (fail-loud) past cap | `data/hooks.ts` (`fetchAllPages`), `data/desk.ts` |
| Chain enumeration (positions/offers) | page 200, `WALK_CAP 2000`, `null` past cap | `chain/chainPositions.ts` |
| Chain enumeration (Claims discovery) | page-walks `getUserPositionLoansPaginated` **until `offset >= total` — no WALK_CAP** | `data/claimables.ts` — PAG-003 |
| Chain ladder read | `getActiveOffersByAssetPairRanked(pair)` returns the **whole active pair bucket** (no offset/limit args) | `contracts/src/facets/MetricsFacet.sol` — PAG-012 |

Most caps are honest (overflow degrades to the explicit unavailable
state); the signed-book slice was the exception — it silently dropped
lower-priority depth until the PAG-011 fix added the `truncated` flag. The recurring UI gap is rendering
everything the capped fetch returned: DOM size and per-row RPC (token
meta, claimable probes, security screens) scale linearly up to
500–2000 rows.

**The house pattern to replicate** (already shipped in the Activity
feed, `pages/Activity.tsx`): render `rows.slice(0, visible)` with
`visible` starting at 25 and a "Load more" button adding 25 — plus an
honest truncation note where the data layer capped. Where per-row
reads fan out inside the QUERY (not the row component), the window
must scope the read set too, not just the DOM (see PAG-006).

## Per-surface verdicts

| Surface | Data layer | UI layer | Verdict |
| --- | --- | --- | --- |
| My Positions — loans (`pages/Positions.tsx`) | chain ≤2000 / indexer ≤500 per side | renders ALL rows | **data-bounded-only → PAG-001** |
| My Positions — offers (`pages/Positions.tsx`) | chain ≤2000 / indexer ≤500 per side | renders ALL rows | **data-bounded-only → PAG-001** |
| Activity feed (`pages/Activity.tsx`) | ≤5 pages, early-stop at 50 txns, `truncated` surfaced | `slice(0, visible)` + Load more (25/page) | bounded |
| Offer Book, basic + advanced (`pages/Offers.tsx`) | ≤500, `null` past cap | renders ALL filtered rows | **data-bounded-only → PAG-002** |
| Claims candidate list (`pages/Claims.tsx`, `data/claimables.ts`) | **chain walk UNCAPPED** (no WALK_CAP); hint ≤200 | renders ALL confirmed rows | **data-layer gap + UI → PAG-003** |
| Rent listings (`pages/Rent.tsx`) | ≤500 source, NFT-filtered | renders ALL listings | **data-bounded-only → PAG-004** |
| Desk — open orders (`components/desk/OpenOrdersPanel.tsx`) | own offers ≤2000/500; own signed derived from a silently-capped 100/side slice | renders ALL rows | **data-bounded-only → PAG-005 (+ PAG-011)** |
| Desk — Positions tab (`components/desk/PositionsPanel.tsx`) | own loans ≤2000/500 | renders ALL rows, each with token meta + `useLoanRisk` | **data-bounded-only → PAG-008** |
| Settings — approvals (`components/ApprovalsCard.tsx`) | distinct tokens behind ≤500 offers; per-token reads fan out INSIDE the query | renders ALL token rows | **data-bounded-only → PAG-006** |
| Desk — order-book ladder + signed book (`RateLadder.tsx`, `data/desk.ts`) | chain path returns the WHOLE pair bucket (no paging args), all ids hydrated; indexer fallback ≤500; signed ≤100/side | aggregated levels, `slice(0, 12)` per side | **data-layer gap → PAG-012** |
| Desk — recent-fills tape (`TapePanel.tsx`) | ≤5×50 | `slice(0, 20)` | bounded |
| Desk — History tab (`HistoryPanel.tsx`) | infinite query, 25/page | grows 25 per explicit Load-more click | bounded |
| Desk — rate chart (`RateChart.tsx`) | range-bounded EXCEPT `range=all` (unbounded server scan) | chart canvas | **data-layer gap (server) → PAG-009** |
| Desk — market/tenor picker (`DeskHeader.tsx`) | `/offers/markets` has NO LIMIT; distinct pairs/tenors are maker-spammable | renders every pair option + tenor chip | **data-layer gap (server) + UI → PAG-010** |
| Vault asset list (`pages/Vault.tsx`, `data/vault.ts`) | distinct ERC-20 set behind the 500/2000 source caps (not fixed; per-asset reads scale with it) | renders all assets | **data-bounded-only (P3) → included in PAG-001 fix batch** |
| Guided-match offer list (`OfferFlow.tsx`) | ≤500 source | hard-capped at 5 | bounded |
| Early-exit offer picker (`EarlyExitFlow.tsx`) | ≤500 source | `slice(0, 5)` | bounded |
| Keeper lists (`KeeperSettingsCard`, `LoanKeeperCard`) | contract cap `MAX_APPROVED_KEEPERS = 5` | renders all | bounded (by nature) |
| Faucet rows / VPFI tier table / Help FAQ / Home jobs / Settings theme | static or fixed-4-slot config | fixed rows | bounded |
| Refinance / loan-sale pending cards | single-loan | one card | bounded (not a list) |

## Findings

### PAG-001 — My Positions renders every fetched position row (P2)

`pages/Positions.tsx` maps the FULL offers array and the full
partitioned loan groups (attention / live / ended) into `OfferRow` /
`LoanRow` components with no window. Each row fires its own token-meta
reads, and attention rows add claimable probes. Fix: the Activity
window pattern per group (the attention group may stay unwindowed — it
is the actionable set and naturally small; live/ended groups get
`slice + Load more`). The Vault asset list rides the same fix batch
(its distinct-asset set and per-asset balance reads grow with the same
source caps).

### PAG-002 — Offer Book renders every filtered offer (P2)

`pages/Offers.tsx` maps the entire filtered/sorted array (up to the
500-row data cap) into `OfferRow`s, each with up to three token-meta
reads and a batched security screen over every leg. Fix: window after
filter/sort; scope the batched screen to the VISIBLE window so
Load-more grows the screen set with the rows.

### PAG-003 — Claims: uncapped chain walk + unwindowed rows (P2)

Two layers. (a) **Data**: `data/claimables.ts` page-walks
`getUserPositionLoansPaginated` until `offset >= total` with NO
`WALK_CAP` — unlike `chainPositions.ts`, a wallet with thousands of
position NFTs keeps walking and then probes every candidate instead of
failing loud at 2,000. (b) **UI**: `pages/Claims.tsx` maps all
confirmed rows unbounded, and a long-lived wallet's terminal history
only ever grows. Fix: add the same `WALK_CAP 2000` fail-loud guard to
the claimables walk, then window the rows (newest first + Load more).

### PAG-004 — Rent listings render every NFT listing (P3)

`pages/Rent.tsx` maps all NFT-type listings from the ≤500-offer
source. Lower severity today; same one-line window fix.

### PAG-005 — Desk open-orders tab renders every own order (P3)

`components/desk/OpenOrdersPanel.tsx` maps all own on-chain rows
(≤2000/500 cap) and all own signed rows. Note the own-signed block is
derived from the silently-capped book slice — see PAG-011 for why that
can HIDE a user's own cancellable orders entirely. Fix: window + Load
more per block.

### PAG-006 — Settings approvals: window the READ set, not just the DOM (P3)

`components/ApprovalsCard.tsx` fans out per-token allowance +
symbol/decimals reads inside the QUERY (`Promise.all` over the
distinct-token set) before anything renders — so a naive
`slice + Load more` on `approvals.data.map` would shrink the DOM but
still issue every read up front. Fix: window the token CANDIDATE set
and let Load-more extend the queried window (or defer per-token reads
into the row components so the window scopes them naturally).

### PAG-007 — indexer `/claimables` has no server-side LIMIT (P2, indexer)

`apps/indexer/src/loanRoutes.ts` `handleClaimables` returns every
terminal own-loan with no LIMIT clause. This is NOT a dormant surface:
`apps/defi/src/hooks/useIndexedClaimables.ts` consumes it live for the
defi Claim Center / Dashboard path (alpha02 moved to
`/claim-candidates`). Fix: the same 200-cap + `truncated` flag shape
as `/claim-candidates`, and the defi consumer keeps its on-chain
verify layered on top.

### PAG-008 — Desk Positions tab renders every active loan row (P2)

`components/desk/PositionsPanel.tsx` filters `useMyLoansFull()` to
active ERC-20 loans and maps every row — each mounting token metadata
AND `useLoanRisk` (an HF read per row). The first pass missed this
tab entirely; it is the same shape as PAG-001/PAG-005 with a heavier
per-row cost. Fix: same window pattern; the risk read then scopes to
the visible window for free.

### PAG-009 — `/loans/rate-candles` `range=all` is an unbounded scan (P3, indexer)

`handleLoansRateCandles` maps `range=all` to no `start_at` lower bound
and runs the market query with NO LIMIT, folding every matching fill
before bucketing. A long-lived busy market makes this an unbounded
D1 scan per request (the UI canvas is irrelevant — the cost is
server-side). Fix: cap the scanned rows (LIMIT + `truncated` flag, or
clamp `all` to a maximum lookback).

### PAG-010 — `/offers/markets` has no LIMIT and the picker renders every market (P3)

The markets aggregate groups all active + signed offers by
`(lendingAsset, collateralAsset, durationDays)` with no LIMIT, and
`DeskHeader` renders every distinct pair as a select option and every
selected-pair tenor as a chip. Distinct markets are maker-spammable
(post 1-wei offers across fabricated pairs), so "one row per distinct
market" is not a bound. Fix: server-side LIMIT (e.g. top-N markets by
depth/recency + `truncated`), picker orders by depth so real markets
stay reachable.

### PAG-011 — signed-book cap silently truncates (P3, indexer + desk)

`signedOfferRoutes.ts` hard-limits each side to the 100 best-priced
rows with no cursor and no `truncated` flag — lower-priority depth is
silently omitted, unlike every other capped surface in the app. For
the LADDER that is acceptable-by-design (price-ordered top-of-book),
but `OpenOrdersPanel` derives the user's OWN signed orders from that
slice, so a maker with orders outside the top-100 cannot see or cancel
them from the desk. Fix: add a `truncated` flag to the route response
and, for the own-orders view, a signer-scoped query (or cursor) so own
orders are never hidden by other makers' depth.

### PAG-012 — ladder chain path hydrates the whole pair bucket (P3)

`useDeskBook`'s primary path calls
`getActiveOffersByAssetPairRanked(pair)` which returns the ENTIRE
active pair bucket (the contract view takes no offset/limit), and the
client hydrates every id (chunked ≤250 per call, but ALL chunks). A
spammed pair makes the "chain-first" path strictly worse than the
500-capped indexer fallback. Fix: cap the hydrated id set client-side
(e.g. first N ranked ids, N sized to the ladder's 12 levels/side plus
honest depth-count display), fail over to the indexer fallback past
the cap.

## Fix plan

Two follow-up PRs:

1. **alpha02 UI/data batch** — the shared window pattern
   (`slice(0, visible)` + Show more, 25-row page, mirroring Activity)
   for PAG-001 (Positions + the Vault asset-list rider), PAG-002 (with
   window-scoped screening), PAG-003 (plus the claimables `WALK_CAP`),
   PAG-004, PAG-005, PAG-008; PAG-006's read-set windowing; PAG-012's
   hydration cap. **SHIPPED** — `lib/visibleWindow.tsx`
   (`useVisibleWindow` / `WindowedRowList`) + the release fragment
   `1247-alpha02-list-windows.md`.
2. **indexer batch** — PAG-007 (`/claimables` 200-cap + `truncated`;
   coordinate the defi consumer), PAG-009 (candles `all`-range clamp),
   PAG-010 (markets top-N + `truncated`), PAG-011 (signed-book
   `truncated` flag + signer-scoped own-orders read). **SHIPPED** —
   `/claimables` caps at the 200 newest terminal loans; candles scan
   the newest 10,000 fills; `/offers/markets` serves the 200 deepest
   markets; the signed book reports `truncated` and takes an optional
   validated `signer` param, which the desk's own-orders block passes
   so a maker's off-market orders are never hidden behind other
   makers' depth. All four responses carry `truncated` (additive —
   the defi `/claimables` consumer ignores it and keeps its on-chain
   verify). Release fragment `1247-indexer-caps.md`.
