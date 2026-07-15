# Findings 2026-07-15 — alpha02 pagination / list-bounding audit (#1247)

Static code audit of **every list-rendering surface** in
`apps/alpha02/src`, per the owner directive (2026-07-14, issue #1247):
verify each list is properly paginated at BOTH layers — the data layer
(indexer routes / chain enumeration) and the UI layer (a bounded
render window with a load-more affordance) — not just the
known-paginated ones. Findings carry `PAG-###` IDs; unmarked findings
are OPEN.

## Method

Code-level sweep (not a live-browser pass): every `.map()` over
query-fed data in `pages/` and `components/` was traced to its source
bound, plus the indexer routes' server-side caps and the chain
enumeration helpers' page walks. Each surface gets a two-layer verdict:

- **bounded** — both layers bounded, or bounded by nature (static /
  distinct-set / contract-capped data).
- **data-bounded-only** — the fetch is capped (fail-loud past the
  cap), but the UI renders the ENTIRE fetched array as row components
  with no slice, virtualization, or pager.
- **UNBOUNDED** — no cap at either layer. **None found.**

## Reference: the standing caps

| Layer | Bound | Where |
| --- | --- | --- |
| Indexer offer/loan/activity routes | `DEFAULT_PAGE_LIMIT 50`, `MAX_PAGE_LIMIT 200` (clamped server-side) | `apps/indexer/src/offerRoutes.ts`, `loanRoutes.ts` |
| Indexer signed-offer book | ≤100 rows/side, price-ordered | `apps/indexer/src/signedOfferRoutes.ts` |
| `/claim-candidates` | 200-row cap + `truncated` flag | `loanRoutes.ts` (PR C, #1232) |
| `/claimables` | **no server LIMIT** (all terminal own-loans) | `loanRoutes.ts` — see PAG-007 |
| Client indexer walks | `limit 100` × ≤5 pages = 500/leg, `null` (fail-loud) past cap | `data/hooks.ts` (`fetchAllPages`), `data/desk.ts` |
| Chain enumeration | `getUserPositionLoansPaginated`/offers at page 200, `WALK_CAP 2000`, `null` past cap | `chain/chainPositions.ts` |

The caps are honest by design: overflow degrades to the explicit
unavailable state, never a silent truncation. The recurring gap is the
UI layer rendering everything the capped fetch returned — DOM size and
per-row RPC (token meta, claimable probes, security screens) scale
linearly up to 500–2000 rows.

**The house pattern to replicate** (already shipped in the Activity
feed, `pages/Activity.tsx`): render `rows.slice(0, visible)` with
`visible` starting at 25 and a "Load more" button adding 25 — plus an
honest truncation note where the data layer capped.

## Per-surface verdicts

| Surface | Data layer | UI layer | Verdict |
| --- | --- | --- | --- |
| My Positions — loans (`pages/Positions.tsx`) | chain ≤2000 / indexer ≤500 per side | renders ALL rows | **data-bounded-only → PAG-001** |
| My Positions — offers (`pages/Positions.tsx`) | chain ≤2000 / indexer ≤500 per side | renders ALL rows | **data-bounded-only → PAG-001** |
| Activity feed (`pages/Activity.tsx`) | ≤5 pages, early-stop at 50 txns, `truncated` surfaced | `slice(0, visible)` + Load more (25/page) | bounded |
| Offer Book, basic + advanced (`pages/Offers.tsx`) | ≤500, `null` past cap | renders ALL filtered rows | **data-bounded-only → PAG-002** |
| Claims candidate list (`pages/Claims.tsx`) | candidates ≤2000/500 + hint ≤200 | renders ALL confirmed rows | **data-bounded-only → PAG-003** |
| Rent listings (`pages/Rent.tsx`) | ≤500 source, NFT-filtered | renders ALL listings | **data-bounded-only → PAG-004** |
| Desk — open orders (`components/desk/OpenOrdersPanel.tsx`) | own offers ≤2000/500; signed ≤100/side | renders ALL rows | **data-bounded-only → PAG-005** |
| Settings — approvals (`components/ApprovalsCard.tsx`) | distinct tokens behind ≤500 offers (throws past cap) | renders ALL token rows | **data-bounded-only → PAG-006** |
| Desk — order-book ladder + signed book (`RateLadder.tsx`) | chain-ranked / ≤500 + ≤100/side | aggregated levels, `slice(0, 12)` per side | bounded |
| Desk — recent-fills tape (`TapePanel.tsx`) | ≤5×50 | `slice(0, 20)` | bounded |
| Desk — History tab (`HistoryPanel.tsx`) | infinite query, 25/page | grows 25 per explicit Load-more click | bounded |
| Desk — rate chart (`RateChart.tsx`) | range-bounded candles | chart canvas, not DOM rows | bounded (by nature) |
| Vault asset list (`pages/Vault.tsx`) | distinct ERC-20 set from own positions | renders all assets | bounded (by nature — distinct-asset count) |
| Guided-match offer list (`OfferFlow.tsx`) | ≤500 source | hard-capped at 5 | bounded |
| Early-exit offer picker (`EarlyExitFlow.tsx`) | ≤500 source | `slice(0, 5)` | bounded |
| Keeper lists (`KeeperSettingsCard`, `LoanKeeperCard`) | contract cap `MAX_APPROVED_KEEPERS = 5` | renders all | bounded (by nature) |
| Faucet rows / VPFI tier table / Help FAQ / Home jobs / Settings theme | static or fixed-4-slot config | fixed rows | bounded |
| Refinance / loan-sale pending cards | single-loan | one card | bounded (not a list) |
| Desk header market/tenor chips | `/offers/markets` aggregate (one row per distinct pair/tenor) | renders all | bounded (by nature) |

**Net:** zero UNBOUNDED surfaces; six `data-bounded-only` findings
(PAG-001…006) sharing one fix pattern, plus one server-side note
(PAG-007).

## Findings

### PAG-001 — My Positions renders every fetched position row (P2)

`pages/Positions.tsx` maps the FULL offers array and the full
partitioned loan groups (attention / live / ended) into `OfferRow` /
`LoanRow` components with no window. Each row fires its own token-meta
reads, and attention rows add claimable probes — a wallet holding
hundreds of positions pays hundreds of row mounts and their reads on
one navigation. Fix: the Activity window pattern per group (attention
group may stay unwindowed — it is the actionable set and naturally
small; live/ended groups get `slice + Load more`).

### PAG-002 — Offer Book renders every filtered offer (P2)

`pages/Offers.tsx` maps the entire filtered/sorted array (up to the
500-row data cap) into `OfferRow`s, each with up to three token-meta
reads and a batched security screen over every leg. A busy market
renders 500 rows. Fix: window after filter/sort; keep the batched
screen scoped to the VISIBLE window so Load-more grows the screen set
with the rows.

### PAG-003 — Claims renders every confirmed claimable row (P2)

`pages/Claims.tsx` maps all confirmed rows; each `ClaimRow` carries
claim-action state. Discovery is capped (2000/500/200) but a
long-lived wallet's terminal history accretes without bound over time
— this list only ever grows. Fix: window + Load more, newest first.

### PAG-004 — Rent listings render every NFT listing (P3)

`pages/Rent.tsx` maps all NFT-type listings from the ≤500-offer
source. Lower severity: rental listings are the thinnest slice of the
book today. Same one-line window fix while the file is open.

### PAG-005 — Desk open-orders tab renders every own order (P3)

`components/desk/OpenOrdersPanel.tsx` maps all own on-chain rows
(≤2000/500 cap) and all own signed rows (≤200 by server cap). A
market-maker wallet with hundreds of open orders renders them all,
each with amend/cancel state. Fix: window + Load more per block.

### PAG-006 — Settings approvals list renders every distinct token (P3)

`components/ApprovalsCard.tsx` maps the distinct-token set derived
from active positions plus the full (≤500) creator offer history, each
row holding a live allowance read. Distinct-token counts are small in
practice; the window is cheap insurance while the pattern is applied
elsewhere.

### PAG-007 — indexer `/claimables` has no server-side LIMIT (P3, indexer)

`apps/indexer/src/loanRoutes.ts` `handleClaimables` returns every
terminal own-loan with no LIMIT clause, unlike every other row route
(200-cap) and unlike `/claim-candidates` (200 + `truncated`). The
alpha02 Claims page consults `/claim-candidates`, so today's consumer
exposure is nil, but the route is public surface and a long-lived
wallet's terminal set grows without bound. Fix: same 200-cap +
`truncated` flag shape as `/claim-candidates`.

## Fix plan

One follow-up PR applies the shared window pattern (`slice(0,
visible)` + Load more, 25-row page, mirroring Activity) to PAG-001…006
and adds the `/claimables` cap (PAG-007). No data-layer changes are
needed — every fetch is already capped and fail-loud; the caps' values
stay as-is (re-tuning tracked separately under #1245 for push hints).
