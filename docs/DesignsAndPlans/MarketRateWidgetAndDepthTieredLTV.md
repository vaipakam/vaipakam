# "Lend / Borrow at market rate" widget + depth-tiered LTV

Status: **design locked 2026-05-13 (§5). Piece A SHIPPED; Piece B
contracts LANDED behind the `depthTieredLtvEnabled` kill-switch (default
`false` ⇒ no behaviour change); audit + the §4.4 follow-ups pending
before the switch flips on any chain.**

Implementation snapshot (branch `feat/market-rate-widget-and-tiered-ltv`):
- **§4.4 step 1 — Piece A — SHIPPED & deployed** (base-sepolia
  `a1eb9fcb`): the widget on OfferBook, auto min-collateral, deep-link to
  Create Offer, cross-chain "thin here" warnings on Create Offer +
  Accept Offer. (Polish left: i18n for the 9 non-en locales; optional
  full 0x/1inch slippage preflight inside the widget.)
- **§4.4 step 2 — matcher ported into `apps/keeper`** — `matcher.ts`
  wired into the cron. Not deployed (the signing-Worker push / testnet
  bake is the deliberate step).
- **§4.4 step 3 (partial) — base `_v3DepthLiquid` made a real PAD
  figure** (`2 × WETH-leg-virtual-reserve × ethPrice`; `MIN_LIQUIDITY_USD`
  → `MIN_LIQUIDITY_PAD`, value unchanged). The *full* step 3 (replace
  the depth-at-tick gate with a slippage-at-`floorSizePad` simulation —
  §4.2) is still a follow-up; until then `MIN_LIQUIDITY_PAD` is the
  binary `Liquid` threshold and `floorSizePad` is just a tier-test size.
- **§4.4 step 4 — rest of Piece B — LANDED behind `depthTieredLtvEnabled`:**
  `LibSlippage` (fee-aware CPMM price-impact, decimal-independent; V3
  virtual-reserve in-tick approximation, *not* the gas-heavy Quoter) +
  `OracleFacet.getLiquidityTier` / `getEffectiveLiquidityTier` (the
  on-chain tier authority; best route over `paaAssets × {Uni/Pancake/Sushi
  V3} × fee ≤ 0.3%`; value-balance + best-effort TWAP-tick guards;
  `effectiveTier = min(onChain, keeperTier ∈ {1,2,3}, default 1)`) +
  `ProtocolConfig` knobs (`liquiditySlippageBps` / `twapWindowSec` /
  `twapConsistencyBps` / `floorSizePad` / `tier{1,2,3}SizePad` in PAD ×
  1e6 — "PAD" = the T-048 Predominantly Available Denominator, USD on
  the retail deploy; `tier{1,2,3}MaxInitLtvBps`) + `Storage.paaAssets[]`
  (PAA — the per-chain quote tokens the depth probe looks at; empty ⇒
  `[wethContract]`) + `keeperTier` mapping + `KEEPER_ROLE` + `ConfigFacet`
  setters (`set{DepthTieredLtvEnabled, LiquiditySlippageBps, TwapGuard,
  LiquidityTierSizes, TierMaxInitLtvBps, PaaAssets}` under `ADMIN_ROLE`;
  `setKeeperTier` under `KEEPER_ROLE`) + `LoanFacet._checkInitialLtvAndHf`
  cap (`min(maxLtvBps, tierMaxInitLtvBps[effectiveTier(collateral)])`,
  HF floor relaxed to `≥ 1e18`) + `IVaipakamErrors.InitLtvAboveTier`. All
  6 commits, full forge suite green throughout (1718 passing).
- **§4.4 step 5 — `apps/keeper` liquidity-confidence relay — LANDED**
  (`liquidityConfidence.ts`): periodic 0x/1inch slippage-at-tier-sizes
  per active ERC-20 collateral asset (best route over the on-chain PAA
  list) ⇒ aggregator-confirmed tier ⇒ D1-backed promote/demote state
  machine (`LIQ_CONFIDENCE_MIN_CHECKS` / `LIQ_CONFIDENCE_MIN_WINDOW_DAYS`
  env knobs; demote immediately on degradation) ⇒ `setKeeperTier`
  on-chain (gated on `isKeeperEnabled` AND `depthTieredLtvEnabled` for
  the chain; the D1 counter is tracked regardless so the catch-up after
  a switch-flip is fast). Tier-3 promotion additionally needs the
  "battle-tested elsewhere" advisory (Aave v3 / Compound v3 /
  Morpho-curated listing + TVL on this chain) — STUBBED in v1 ⇒ relay
  caps at Tier 2. Cron-wired, tsc clean; not deployed.
- **Piece B follow-up (c) — `LibOfferMatch.previewMatch` tier-cap
  alignment — LANDED**: synthetic init-gate check now mirrors
  `LoanFacet._checkInitialLtvAndHf` (the binding gate) under
  `depthTieredLtvEnabled` — new `LibRiskMath.minCollateralForLtvCap` +
  `MatchError.LtvAboveTier`. Closes the "bot submits reverting
  matchOffers" gap when the switch flips. (Preclose/Refinance HF
  re-checks deliberately stay at `HF ≥ 1.5` — they aren't fresh-loan
  inits and the legacy bound is more conservative than the tier cap.)
- **Piece B follow-up (a) — init-gate integration tests — LANDED** (5
  cases extending `LoanFacetTest`: above/below Tier-1 cap, HF≥1e18 floor
  relaxed, HF<1 still reverts, Tier-0 collateral rejected). The
  `if (depthTieredLtvEnabled)` branch of `_checkInitialLtvAndHf` is no
  longer unit-untested.
- **Piece B follow-up (b) — Uni-V2-fork family in the route search —
  LANDED**: per-chain `uniswapV2Factory` / `sushiswapV2Factory` /
  `pancakeswapV2Factory` storage + `AdminFacet` setters/getters + a V2
  probe (`factory.getPair(a, b)` + `pool.getReserves()` ⇒ real reserves
  ⇒ exact CPMM math, same value-balance guard as V3, no on-chain TWAP
  guard — value-balance is the only manipulation check on V2) +
  selector plumbing + 3 new `DepthTieredLtv.t.sol` cases (V2 pulls an
  asset up to Tier 3 above its V3-only Tier 1; V2 value-balance guard
  excludes a mismatched pool; V2 alone can't make an asset `Liquid` —
  `_checkLiquidity` deliberately stays V3-only). A zero V2 factory
  skips that leg; a fresh deploy has all three zero ⇒ V3-only route
  search, no behaviour change vs the pre-(b) state.
- **Not done — must precede flipping `depthTieredLtvEnabled` on any
  chain (the §4.4-step-6 audit covers the remaining items):** (e)
  frontend `useProtocolConfig` wiring for the new bundle /
  `getEffectiveLiquidityTier` (ABIs exported, no consumer reads them
  yet); (advisory) wiring the Tier-3 "battle-tested elsewhere" check in
  the keeper relay (currently stubbed ⇒ caps at Tier 2); deferred /
  parallel — harden the liquidator keeper bot for higher LTV (gates
  the Tier-3 LTV ramp past its conservative opening).

Author note: this doc records a real-pool depth census (§3) that
changed the recommendation for Piece B — read §3 and §4 before
implementing anything tier-related.

---

## 1. Background — how "liquidity" is determined today

It is **Chainlink price-feed freshness + on-chain AMM pool depth — NOT
24-hour trade volume.** 24h volume isn't readable on-chain (Uniswap V3
pools don't expose it), so the protocol never used it.

`OracleFacet._checkLiquidity(asset)` returns `Liquid` iff **all** of:

1. The L2 sequencer circuit-breaker is healthy (on L2s).
2. There is a fresh Chainlink **asset/USD OR asset/ETH** price feed —
   the same hybrid chain `getAssetPrice` uses.
3. There is an **asset/WETH pool on ≥ 1 of three V3-style venues**
   (Uniswap V3 / PancakeSwap V3 / SushiSwap V3 — all UniV3 forks at the
   contract layer; pools discovered on-chain via `factory.getPool`,
   zero per-asset config) whose **depth proxy** clears
   `LibVaipakam.MIN_LIQUIDITY_USD`.

   The depth proxy in `OracleFacet._v3DepthLiquid`:
   ```
   approxUsdLiquidity = pool.liquidity() * ethPriceRaw / 10^ethDec
                      ≈ pool.liquidity() * ethPriceUsd
   return approxUsdLiquidity >= MIN_LIQUIDITY_USD   // = 1_000_000 * 1e6
   ```
   Special case: WETH itself is `Liquid` iff ETH/USD is fresh (no
   asset/WETH pool — circular). Fail-closed: any failure → `Illiquid`.

And the **loan-init gate** (`LoanFacet`, both legs `Liquid` + real
collateral, not a lender-sale vehicle):

- `LTV ≤ assetRiskParams[collateral].maxLtvBps` (per-asset admin knob;
  bounded min 10% / max 100%), AND
- `HF = collateralValueNumeraire × liqThresholdBps / borrowBalance ≥
  MIN_HEALTH_FACTOR (1.5e18)`.

→ effective **max init-LTV = `min(maxLtvBps, liqThresholdBps / 1.5)`** —
≈ `min(maxLtvBps, 53%)` for a typical 80% liq-threshold. There is no
"liquidity tier" concept anywhere; `MIN_LIQUIDITY_USD` is one global
constant; `RiskParams` is `{maxLtvBps, liqThresholdBps, liqBonusBps,
reserveFactorBps, minPartialBps}` per asset.

---

## 2. Piece A — the "market rate" widget (Phase 1, UI only)

A small widget on the OfferBook, sat next to the **Market anchor** (the
mid interest rate from the book): two buttons — **"Lend at market
rate"** / **"Borrow at market rate"** — plus a **lending-amount** input
and a **collateral-amount** input.

### The widget is a *smart prefilled deep-link*, nothing more

**Every click on either button navigates to the Create Offer page,
prefilled — there is no one-click-post-directly path.** Decided
2026-05-12; this is the simpler and safer design:

- **One submit path.** The widget never gains its own create-tx
  affordance, risk-ack checkbox, error handling, etc. — all of that
  already lives on Create Offer. Less code, less surface area, less to
  test, no parallel mini-flow to keep in sync.
- **Informed consent every time.** The user always lands on Create
  Offer's review step (rate, duration, partial-repay opt-in, HF/LTV
  preview, collateral, risk warnings) before signing. No "I tapped a
  button and it posted an offer" surprise — for a financial action,
  "land on a prefilled form → glance → confirm in wallet" is the right
  ceremony, and the extra step *is* the review (a feature, not a cost).
- **Uniform flow.** Same path whether or not a market anchor exists;
  the only difference is whether the rate field arrives prefilled.

The widget's own job is therefore just:

1. The **lending-amount + collateral-amount inputs**, with the
   collateral pre-populated to the auto-computed minimum:
   `minCollateral = borrowUsd × 1.5 / liqThresholdBps / collateralPriceUsd`
   (rounded up, plus a small slippage buffer) — so the user sees the
   floor *before* leaving the page. Math source: a thin external view
   wrapping `LibRiskMath.minCollateralForLending` (already exists,
   internal), or the CreateOffer Advanced-mode HF/LTV preview computed
   client-side (reads `getAssetPrice` + the collateral's
   `liqThresholdBps` + `MIN_HEALTH_FACTOR`). Create Offer re-validates
   and likewise blocks decreasing below the minimum.
2. Showing the **current Market anchor rate** as a hint next to the
   buttons (and "—" / "no market rate yet" when the book is empty for
   the pair).
3. On click → `navigate("/create-offer?side=lend|borrow&lendingAsset=…
   &collateralAsset=…&lendingAmount=…&collateralAmount=…
   &rate=<mid-or-omitted>&duration=<bucket-if-the-filter-is-concrete>
   &source=market-widget")`. Create Offer reads `source=market-widget`
   to show the right banner: *"Posting at the current market rate of
   X% APR"* when `rate` is prefilled, or *"No market rate exists for
   this pair yet — you're posting the first offer. Set the rate
   below."* when it isn't.

**The button is never disabled — every click deep-links.** For an
**illiquid** leg (`checkLiquidity → Illiquid`, i.e. no fresh feed
and/or no deep-enough pool) the protocol has no oracle price, so the
widget can't compute a minimum collateral, can't run the HF/LTV
preview, and there is no "market rate". In that case the widget:
- shows the lending-amount input + a note next to the buttons —
  *"This asset isn't on a liquid market — set collateral terms on the
  offer page"* (the rate hint reads *"no liquid market"* instead of a
  mid rate); the collateral input is hidden (there's no min to anchor
  it to);
- on click → `navigate("/create-offer?side=lend|borrow
  &lendingAsset=…&lendingAmount=…&collateralAsset=<if-known-from-the-
  book-filter>&source=market-widget")` — note **no `collateralAmount`,
  no `rate`, no auto-min** (those need a price the asset doesn't have).
  The collateral asset/amount are required fields on Create Offer, so
  the user fills them there.
- Create Offer shows a cautionary banner: *"⚠ This offer involves an
  asset without a liquid market (no oracle price). The protocol can't
  compute a minimum collateral or run the standard health-factor / LTV
  checks — you and your counterparty are pricing this directly, and
  both sides must consent. Set all terms below."*

Rationale for routing illiquid through the same page rather than
blocking it: posting an offer for an illiquid asset is a legitimate
action (illiquid offers exist — they require explicit both-parties
consent and full collateral transfer on default); the only thing the
widget *can't* do for them is the auto-fill, so it deep-links with
whatever it knows and the banner sets expectations. One code path, no
special-cased disabled state.

### Why this needs no contract change

The widget only ever *deep-links to Create Offer*; the loan still goes
through `initiateLoan`, which enforces `HF ≥ 1.5`. The auto-filled
`minCollateral` is, by construction, exactly the smallest collateral
that passes today's gate. Nothing on-chain changes — it's a "smart
prefilled Create Offer" shortcut, end to end.

### 2.b — Cross-chain "thin here" warning (Create Offer + Accept Offer)

`checkLiquidity` (and the §4 tier) are evaluated **per chain** — they
read this chain's pools. So an asset can be deep on chain A and thin on
chain B (a token whose primary liquidity lives on its home chain). When
an offer involves a **collateral** asset that is `Illiquid` — or only
Tier 0/1 — on the *current* chain, both **Create Offer** and the
**Accept Offer** review steps show a warning alongside the existing risk
copy: *"⚠ This collateral asset has thin liquidity on \<chain\>. If it
gets liquidated here, the swap may be costly or fail — and this asset
may be much deeper on another chain. Consider creating/taking this offer
on the chain where it has more liquidity."* (Frontend-only — both pages
already know the asset + chain and can read `checkLiquidity` /
`getLiquidityTier`.) This fires regardless of whether the offer came via
the widget. **Better-approach refinement (Phase 2.5/3):** also tell the
user *which* chain is deeper — needs a cross-(asset, chain) depth index
the keeper/indexer maintains (or the frontend queries the aggregator API
per chain) — then the warning links straight to the chain picker
("switch to Base — 5× the depth there"). v1 ships the generic warning;
the "which chain" hint is a follow-up.

---

## 3. Real-pool depth census (Ethereum mainnet, ETH ≈ $2,264)

Run 2026-05-12 against `ethereum-rpc.publicnode.com`. For each asset:
the deepest asset/WETH V3 pool across fee tiers {0.01%, 0.05%, 0.3%,
1%}, two depth measures:

- **"contract metric"** = `pool.liquidity() × ethPriceUsd` — i.e. the
  exact quantity `_v3DepthLiquid` compares to `MIN_LIQUIDITY_USD`.
- **"≈ USD depth"** = `2 × (WETH-leg virtual reserve) × ethPriceUsd` —
  a proper dollar figure (the pool is balanced at the current price, so
  the WETH leg's USD value ×2 is the depth-at-tick). Over-states for
  price-correlated pairs (LSTs) where almost all `L` sits in a razor-
  thin band; reasonable order-of-magnitude for non-correlated pairs.

| Asset | Best fee | `liquidity()` (raw uint128) | "contract metric" `L×$ETH` | **≈ USD depth** (proper) |
|---|---|---|---|---|
| weETH | 0.01% | 7.44e24 | 1.7e28 | **$35.2 B** ⚠️ correlated, over-stated |
| wstETH | 0.01% | 6.05e24 | 1.4e28 | **$30.4 B** ⚠️ correlated, over-stated |
| USDT | 0.3% | 9.75e18 | 2.2e22 | **$854 M** |
| WBTC | 0.05% | 1.99e17 | 4.5e20 | **$536 M** |
| USDC | 0.05% | 3.93e18 | 8.9e21 | **$374 M** |
| LINK | 0.3% | 1.19e24 | 2.7e27 | **$362 M** |
| AAVE | 0.3% | 2.52e22 | 5.7e25 | **$23.5 M** |
| UNI | 0.3% | 1.08e23 | 2.4e26 | **$19.8 M** |
| DAI | 0.3% | 1.28e23 | 2.9e26 | **$12.1 M** (direct WETH pool only — most DAI liquidity is now in stable-stable pools) |
| PEPE | 0.3% | 2.44e25 | 5.5e28 | **$4.7 M** |
| cbBTC | 0.3% | 6.49e14 | 1.5e18 | **$1.7 M** (most cbBTC depth lives on Base, not Ethereum) |
| SHIB | 0.3% | 2.87e24 | 6.5e27 | **$0.69 M** (direct SHIB/WETH pool only — SHIB routes mostly through SHIB/stable pairs) |

### 3.b — same census against asset/USDT pools

(USDT is "the predominant denominator" Tier-1 was framed around, so the
asset/**USDT** pool depth matters too. `2 × USDT-leg-virtual-reserve ×
$1`; USDT is token1 in all of these.)

| Asset | Best fee | tiers found (raw `liquidity()`) | **≈ USD depth** (proper) |
|---|---|---|---|
| WETH | 0.3% | 0.3% deepest (`9.0e18`) | **$854 M** |
| WBTC | 0.05% | `5.1e12` | **$290 M** |
| AAVE | 0.3% | `2.3e18` | **$44.8 M** (deeper than AAVE/WETH's $23.5 M!) |
| LINK | 0.3% | `8.2e17` | **$5.2 M** (much thinner than LINK/WETH's $362 M) |
| UNI | 0.3% | `9.0e17` | **$3.5 M** (vs UNI/WETH $19.8 M) |
| PEPE | 0.3% | `6.3e18` | **$0.026 M** (vs PEPE/WETH $4.7 M) |
| SHIB | 0.3% | `4.3e17` | **$0.0022 M** (vs SHIB/WETH $0.69 M) |
| USDC | 0.01% | `9.1e16` | **$183 B** ⚠️ stable-stable, wildly over-stated |
| DAI | 0.01% | `6.0e21` | **$12.0 B** ⚠️ stable-stable, wildly over-stated |
| wstETH | 0.05% | `8.9e11` | **$95** (the wstETH/USDT pool is effectively dead — wstETH liquidity lives vs WETH) |
| cbBTC | — | (no direct asset/USDT V3 pool) | — |
| weETH | — | (no direct asset/USDT V3 pool) | — |

Takeaway from comparing the two: **which single pool is deepest varies
per asset** — WETH-pool for WBTC/LINK/UNI/PEPE/SHIB, USDT-pool for
AAVE, *neither USDT pool exists* for cbBTC/weETH — and **stable-stable /
price-correlated pools (USDC/USDT, DAI/USDT, the LST/WETH pools)
massively over-state the proper-depth metric** (the "virtual reserve"
formula assumes liquidity straddles the price symmetrically; for a 1:1
pair almost all `L` sits in a ±0.05% band, so `L × sqrtP` over-states
tradeable depth by 2–4 orders of magnitude). So whatever on-chain check
we use should evaluate the asset's **{asset/WETH, asset/USDC,
asset/USDT}** pools and take the **best route**, with a correlated-pair
guard (ignore a pool whose spot sits within ~1% of a stable/peg unless
it's the asset being priced) and a spot-vs-Chainlink-feed guard — and
even then it stays blind to multi-hop routes (the SHIB case). This is
exactly why §4.1 moves from a *raw-depth read* to a *simulated-swap
slippage* check (which directly answers the trade question and is far
less sensitive to concentration / decimals), and accepts the residual
noise (single-hop; large-trade approximation) bounded by conservative
tier LTVs + the manipulation guards rather than by a governance
override.

### What the census tells us

1. **The current "contract metric" (`liquidity() × ethPrice`) is NOT a
   USD figure and cannot be graded into tiers.** It spans ~10 orders of
   magnitude across this set, and the ordering does not track real USD
   depth: PEPE's number (5.5e28) is larger than weETH's (1.7e28) and
   ~10⁶× larger than USDT's (2.2e22), yet USDT has $854 M of depth and
   PEPE has $4.7 M. `pool.liquidity()`'s magnitude is dominated by the
   paired token's **decimals** (18-dec tokens → huge `L`) and the
   token's **unit price** (cheap tokens like PEPE/SHIB → enormous token
   counts → huge `L`). `MIN_LIQUIDITY_USD = 1_000_000 × 1e6 = 1e12` is
   tiny against any non-empty pool here (smallest is cbBTC at 1.5e18),
   so the present gate is effectively **"the pool exists and isn't
   empty"** — the "$1 M" label is fiction.
2. **The proper metric (`2 × WETH-leg × $ETH`) is a real, decimal-
   independent dollar figure** that orders roughly by actual depth and
   is comparable across assets — with two caveats it shares with *any*
   single-pool on-chain depth check: (a) it over-states for price-
   correlated pairs (LST/ETH), and (b) it only sees the **direct
   asset/WETH pool**, missing multi-hop liquidity — which is why SHIB
   (a top-15 market-cap token) shows < $1 M here and cbBTC shows $1.7 M
   (its real depth is on Base). A risk committee would want a per-asset
   override for exactly those cases.

---

## 4. Piece B — depth-tiered LTV (Phase 2, contract change, audited)

Goal: let demonstrably-liquid ("blue-chip") collateral support a higher
init-LTV than the flat ~53% the `HF ≥ 1.5` gate gives everything today,
graded by liquidity depth, with the cut-offs and the per-tier LTVs as
governance knobs.

### 4.1 The on-chain liquidity check — slippage-at-a-fixed-size (permissionless)

**Constraint (user, 2026-05-12):** the tier must be **permissionless** —
no governance allowlist / per-asset tier-list (that would gate
"numerous tokens" the way the project deliberately avoids). The only
per-asset lever stays the existing **remove** lever (`AdminFacet.pauseAsset`
/ asset blacklist) — used to *exclude* a bad actor, never to *admit*.
Governance owns only the **global** knobs (test sizes, slippage
thresholds, per-tier LTVs, kill-switch). So the on-chain check has to
*be* the tier authority. Good news: a useful one is cheap.

**The metric: simulated-swap slippage.** Instead of `pool.liquidity()`
(not a USD figure — see §3) or its `L × sqrtP × price` reconstruction
(over-states correlated/stable pools by 2–4 orders of magnitude),
**simulate a fixed-size swap and measure the slippage** — "if I sold
$X of this asset right now, how far would the executed price fall below
the spot/oracle price?" That is *the* question liquidation actually
cares about ("can a liquidator dump the collateral without crushing the
price?"), it's decimal-independent, it correctly values stable pairs
(a $5 k USDC→USDT swap has ~0 slippage → correctly "deep"), and it can
be computed cheaply:

- **Uniswap-V2-style pools** (`getReserves()`): exact. `dy = r_out −
  (r_out · r_in) / (r_in + dx · (1 − fee))`; slippage =
  `1 − (dy/dx) / (r_out/r_in)`. Pure arithmetic on one read.
- **Uniswap-V3-style pools** (what we use today — `slot0().sqrtPriceX96`
  + `liquidity()`): take the **virtual reserves at the current tick**
  (`x_v = L · 2^96 / sqrtPriceX96`, `y_v = L · sqrtPriceX96 / 2^96`, in
  base units; net `1 − feePips/1e6` on the input), then the same
  constant-product swap math. This is an **approximation** — exact while
  the trade stays inside the current tick, which a small trade against a
  pool with millions in `L` does (and which the *bigger* test trades do
  iff the pool is deep enough to be in that tier anyway), but it can
  under-state slippage for a large trade against a pool whose *adjacent*
  ticks are thin. Walking the ticks for an exact answer is the
  Quoter (`QuoterV2.quoteExactInputSingle`) — ~100k–500k gas per call,
  ~3 calls for a graded check → 0.3–1.5 M gas added to every
  `createOffer` / `initiateLoan`. Too heavy for the hot path; the
  virtual-reserve approximation is ~3 SLOADs + arithmetic per pool —
  roughly free relative to what `_checkLiquidity` already does (it
  already `getPool`s × fee tiers × 3 venues and reads `slot0` /
  `liquidity`). So: **use the virtual-reserve constant-product
  approximation, accept the large-trade-on-a-thin-adjacent-tick caveat,
  and bound the consequences (below).**

**Scope of the route search** (a deliberate narrowing — these are the
"predominantly-available" denominators / venues / fee tiers; anything
outside this is enough of a signal that the asset isn't blue-chip that
we don't bother): the asset's **{asset/WETH, asset/USDC, asset/USDT}**
pools, across whichever of **{Uniswap V3, SushiSwap V3, PancakeSwap V3}**
is configured on this chain (a zero factory is skipped — same as
`_checkLiquidity` today), at fee tiers **≤ 0.3% only** (`100` / `500` /
`2500` PancakeV3 / `3000` — *not* the `10000` 1%-tier; from the §3
census every deep pool is in a ≤0.3% tier, the 1% tier is where dust
pairs live, so requiring depth in a ≤0.3% pool is the conservative
choice — and it's one fewer probe). Take the **best route** (lowest
slippage). Two acknowledged narrownesses: (i) **single-hop only** — a
SHIB→USDC→WETH route isn't covered without a Quoter path or composing
two single-hop slippages (a possible later refinement), so an asset
whose liquidity is mainly *via* a stable pair, not *against* one,
under-scores here; (ii) restricting to ≤0.3% pools also slightly
**tightens the base `Liquid`/`Illiquid` gate** vs today (which probes
the 1% tier too) — fail-safe direction. The spot price used in the
slippage ratio must agree with the **Chainlink feed** the asset already
needs to be `Liquid` — if the pool's spot deviates from the trusted
price by more than a small bound, the pool is manipulated/stale →
`Illiquid` (this is the manipulation guard, and the project already
requires a fresh feed here).

**Why not market cap (`totalSupply() × price`)?** It's trivially
readable on-chain, but it's the *wrong* signal and a weak one: it
measures *fully-diluted* notional (`totalSupply()` includes locked /
vested / treasury supply — a token with a $5 B FDV and a 1 M circulating
float and a $2 M pool is the classic thin-float-pump pattern), not "can
a liquidator dump $X without crushing the price" — which is the only
thing that matters at liquidation, and which the slippage check
*directly* measures. It's also **manipulable** — `totalSupply()` is
whatever the token contract returns (rebasing, mintable, malicious).
And it's redundant: the $5 k slippage floor already filters out junk
tokens (a junk token has no ≤0.3% pool deep enough to clear $5 k at
≤2%). So **don't gate on market cap on-chain.** If you want more Tier-3
conservatism, a tighter `slippageBps` for the top tier (or a larger
`tier3SizeUsd`) is a far better lever. Market cap *is* useful as an
**off-chain advisory input** — the keeper liquidity-confidence relay
(§4.1.b item 2) can treat a large-FDV / thin-pool-depth discrepancy as
a reason *not* to promote (or to demote), and the widget can flag it —
but that's heuristic judgment, not an
on-chain rule.

**On "add more DEXs" — and specifically *not* dYdX / AsterDEX.** dYdX
(v4 — its own Cosmos appchain, not even EVM-readable) and AsterDEX are
**perpetual-futures** DEXs: orderbooks for *perps*, no spot liquidity
pools. A liquidator sells the collateral *spot* — there is nothing on a
perps venue to sell into. Perp open-interest / orderbook depth is
*derivative* liquidity, unrelated to "can the spot token be dumped".
So perps DEXs are simply the wrong place to look — don't include them.
The right universe is **spot AMMs**, and it's chain-specific and
ABI-heterogeneous: Uni-V3 forks (Uni/Sushi/Pancake V3 — the current
set), Uni-V2 forks (lots of long-tail + Sushi/Pancake V2), **Curve
StableSwap** (the deepest venue for stables + LSTs — wstETH/weETH/
USDC/USDT — and present on every chain), Balancer V2 (weighted +
stable pools, `Vault.queryBatchSwap` is on-chain-callable),
Solidly/ve(3,3) pools (**Aerodrome** on Base, **Velodrome** on
Optimism, THENA on BNB), Camelot/Algebra on Arbitrum, Maverick, …
Each new *family* is new audited read-math; you can't realistically
enumerate them all on-chain. **Highest-value additions if we add any:
Uni-V2 forks and Curve StableSwap.** Beyond that it's a per-chain
integration treadmill with diminishing returns — which is precisely
why the §4.1.b answer is *use the aggregators off-chain*: 0x / 1inch
already integrate *every* spot DEX per chain (Uni, Sushi, Curve,
Balancer, Aerodrome, Velodrome, Camelot, Pancake, Maverick, …) plus
private market makers plus multi-hop. So treat the on-chain check as a
**conservative subset** — it under-counts an asset whose depth lives
*only* on a chain-native DEX we don't integrate (Aerodrome-only on
Base, say) → that asset gets a lower tier or `Illiquid` here, which is
**fail-safe** (the *actual* liquidation still works — 0x/1inch *do*
route to Aerodrome — so the under-count is a false negative in the
pre-screen, not in the liquidation itself; the only cost is a
missed-opportunity, not a safety hole). Note the §4.1.b keeper relay
*can't* fix this kind of under-count — it can only ever promote an
asset *up to* the on-chain ceiling, and here the ceiling itself is too
low (the on-chain check missed the chain-native DEX). Fixing it would
need either (a) integrating those DEX families on-chain (Uni-V2 +
Curve closes most of the gap — decision 8), or (b) an *override*
relay that can promote *above* the on-chain ceiling — which is the
dangerous unbounded-up variant and would require a quorum + time-lock.
v1: Uni-V3-clone trio (Uni/Pancake/Sushi V3) **plus** the Uni-V2-clone
trio (Uni V2 / Sushi V2 @ 30bps, Pancake V2 @ 25bps — landed as Piece B
follow-up b: `factory.getPair(a, b)` + `pool.getReserves()` ⇒ real
reserves, exact CPMM math, same value-balance guard as V3); a zero
factory on any leg skips it. Curve StableSwap is the next-most-valuable
on-chain expansion; the broader "every chain-native DEX" gap is fixed
off-chain by the keeper relay (0x/1inch route over everything).

**The tier = which size the asset clears at ≤ the slippage bound** (all
governance globals):

| | clears `≤ slippageBps` at a trade of… | → tier |
|---|---|---|
| floor | `floorSizeUsd` (e.g. **$5 k**) — fails this → `Illiquid` | gate for the widget; below this = Tier 0 |
| Tier 1 | `tier1SizeUsd` (e.g. **$50 k**) | 50% init-LTV |
| Tier 2 | `tier2SizeUsd` (e.g. **$500 k**) | 60% init-LTV |
| Tier 3 | `tier3SizeUsd` (e.g. **$5 M**) | 65% init-LTV |

(`slippageBps` default 200 = 2%. If a token clears $5 k but not $50 k it
is `Liquid` but only ever Tier 1 at ~53%; if it doesn't clear $5 k it is
`Illiquid` — the widget routes it to manual Create Offer per §2.)

**Manipulation / approximation-error budget** (since there's no
governance override to catch a mis-tier):
- The top tier's 65% init-LTV against an ~82% liq-threshold still leaves
  a ~17-point cushion — even if a flash-loan-deepened pool over-tiers an
  asset, the loan is materially over-collateralized and the cushion
  absorbs a chunk of the gap before the (already-degraded) liquidity
  becomes a problem at liquidation.
- The spot-vs-Chainlink-feed bound catches a manipulated *price*;
  add a cheap **TWAP-consistency** check (pool spot vs its own
  N-minute TWAP within X%) to also catch a pool that's been
  *recently* manipulated. A flash-loan that *adds liquidity* without
  moving the price is the residual vector — bounded by the cushion
  above, and the same vector exists for any on-chain liquidity check
  (incl. today's). A future hardening if needed: a per-asset
  *outstanding-debt cap per tier* (Aave's isolated-mode analog) — a
  global-shaped knob, still permissionless.
- Re-evaluated **on-chain per-tx**, fail-safe direction: a pool that
  thins out drops the asset a tier and blocks *new* high-LTV loans;
  open positions are untouched.

### 4.1.b — Aggregators (0x / 1inch / Balancer): great signal, can't gate on-chain — so use them off-chain

The most accurate "how much would a liquidator actually get for $X of
this asset" answer is an **aggregator quote** — 0x / 1inch route across
*every* DEX + private market makers + multi-hop paths. But those are
**off-chain HTTP APIs** — a smart contract can't call `api.0x.org`. So
they cannot back the on-chain `checkLiquidity` / init gate directly.
What you *can* do on-chain is read individual venues yourself (Uni-V3
`liquidity`/`slot0`, V2 `getReserves`, **Balancer V2's
`Vault.queryBatchSwap`** — the one aggregator-ish primitive that *is*
`staticcall`-able) and take the best route — i.e. exactly the §4.1
slippage check, optionally over more venues. Adding Balancer's
`queryBatchSwap` as a venue is doable (it's heavier than reading
`liquidity()`, lighter than the Uni Quoter) but probably overkill for
v1 — the V3 clones cover the bulk of depth; revisit if a meaningful
asset's liquidity lives mainly in Balancer.

So aggregators slot in **off-chain**, in two places — neither an
allowlist, both permissionless-compatible:

1. **Widget pre-check (UX).** Before the user leaves for Create Offer,
   the widget calls 0x / 1inch (via the existing `apps/keeper` /
   `apps/agent` `/quote/0x` + `/quote/1inch` Worker proxy — already
   built for liquidation quoting in `swapQuoteService`) and shows the
   *realistic* slippage at the user's actual size: *"At your size,
   selling this collateral on a liquidation would cost ~X% — within /
   above the protocol's Y% comfort band."* This is the best possible
   user-facing liquidity signal; it doesn't gate anything on-chain (it
   can't), it just informs.
2. **Keeper "liquidity-confidence tier" relay — `effectiveTier =
   min(onChainSlippageTier, keeperTier)`** (refined model, user
   2026-05-13; supersedes the earlier demotion-only relay). On-chain we
   store `mapping(address ⇒ uint8) keeperTier`, **default `1`**,
   settable by a `KEEPER_ROLE`. The effective tier a loan-init sees is
   `min(getLiquidityTier(asset), keeperTier(asset))`. Consequences:
   - **Every new asset starts at Tier 1 (today's `HF ≥ 1.5`)** — even
     one the on-chain slippage check immediately reads as deep (WBTC,
     say) has `keeperTier = 1` until promoted, so `effectiveTier =
     min(3, 1) = 1`. Brand-new assets are conservative by default; the
     widget / Create Offer at `HF ≥ 1.5` always works for them in the
     meantime.
   - **The keeper *promotes* on accumulated confidence.** A pass in
     `apps/keeper` periodically queries 0x / 1inch for the realized
     slippage of selling the next tier's size of the asset; once that's
     stayed `≤ slippageBps` across a confidence window (N consecutive
     checks over D days — globals), the keeper raises `keeperTier` one
     step. So Tier 2 / Tier 3 require **both** the on-chain check *and*
     the aggregator-confirmed history.
   - **Plus, for the *top* tier, a "battle-tested elsewhere" advisory**
     (user 2026-05-13). Before promoting an asset to Tier 3 the keeper
     additionally checks whether it's **listed as collateral on ≥ 1
     major, long-lived lending protocol on this chain** — Aave v3,
     Compound v3, Morpho-curated vaults — with a non-trivial collateral
     factor *and* non-trivial TVL there (each readable on-chain:
     Aave `PoolDataProvider.getReserveConfigurationData` + `getReserveData`,
     Compound `Comet.getAssetInfoByAddress`, Morpho market params; or
     off-chain via their APIs / DeFiLlama). The signal it gives: "a
     battle-tested risk team has vetted this asset and it has survived
     real liquidations in production" — a *track-record* signal that
     complements the *direct* "can a liquidator dump it now" signal from
     0x/1inch. **Important:** we use their *listing + TVL* as a
     **classification input** ("Aave has WBTC supported with $500 M
     supplied → that's Tier-3 material for us"), **not** their *LTV
     numbers* as a parameter source — Aave's 73% WBTC LTV is tuned to
     Aave's per-second-bot liquidation machinery, not ours; our tier
     LTVs (50 / 60 / 65) stay our own conservative numbers. An asset not
     listed on any of them can still reach Tier 2 on the slippage check
     alone (Tier 2's 60% LTV isn't as demanding) but Tier 3 wants the
     extra corroboration. This is purely an off-chain heuristic in the
     keeper's promotion logic — no contract impact; a compromised keeper
     ignoring it still can't promote past the on-chain ceiling.
   - **The keeper *demotes* immediately** the moment a check shows
     degradation (drops `keeperTier` toward 1) — fail-safe direction,
     no window.
   - **Trust model — bounded.** A compromised keeper can shove
     `keeperTier` to 3 for anything, but `effectiveTier =
     min(onChainSlippageTier, keeperTier)` — for a junk asset the
     on-chain check already says Tier 0/1, so the compromise has *no
     effect*; for a genuinely-deep asset it can only *prematurely*
     promote within what the (approximate) on-chain check already
     vetted — worst case "we relied on the on-chain approximation
     alone", i.e. the no-keeper baseline. So a compromised keeper
     degrades *to baseline*, never below. **Fail-open** — keeper down /
     never ran → `keeperTier` stuck at `1` everywhere → effectively
     `HF ≥ 1.5` for all assets → today's behaviour, fully safe, just no
     high-LTV. **Not an allowlist** — the on-chain check still tiers
     every asset; the keeper's *demotions* are unbounded-down
     (fail-safe), its *promotions* are capped by the on-chain ceiling.
     **Recoverable** — governance can reset `keeperTier`.
   - **Optional hardenings:** a *time-lock on promotions* (a posted
     promotion takes effect D′ hours later; demotions immediate) and/or
     an N-of-M keeper quorum on promotions (the existing
     Tellor/API3/DIA-style quorum machinery). Single keeper, no
     time-lock is fine for v1 given the bound above; quorum/time-lock
     are later hardenings.
   - **Simpler alternative considered (rejected for now):** make the
     on-chain check *binary only* (`Liquid`/`Illiquid` at the $5 k
     floor) and let `keeperTier` be the *sole* tier authority. Smaller
     on-chain footprint (no graded virtual-reserve `mulDiv` math) — but
     then the keeper is unbounded-up, so a compromised keeper *could*
     promote a junk asset to Tier 3 → bad-debt risk → would *require* a
     quorum + time-lock. Keeping the on-chain graded check as the
     ceiling is the safer call and worth the extra read-math.
3. **Liquidation already is aggregator-backed.** Worth keeping in mind:
   the *actual* sale of collateral at liquidation routes through 0x /
   1inch (the swap adapters), with the adapter's own slippage floor. So
   the ultimate safety is already aggregator-quality regardless; the
   on-chain `checkLiquidity` / tier check is a *pre-screen* — "is this
   asset the kind of thing that's liquid enough that we expect the
   liquidation swap to work?" — which is exactly why a cheap
   approximate on-chain check (bounded by conservative LTVs) is the
   right tool there, not a heavyweight on-chain Quoter.

### 4.2 Mechanics

- **On-chain (`OracleFacet`):**
  - `checkLiquidity(asset)` — keep its binary `Liquid` / `Illiquid`
    shape, but back it with the slippage-at-`floorSizeUsd` check
    (best route over {WETH,USDC,USDT} × venues, spot≈feed guard)
    instead of `liquidity() × ethPrice`. Gates the widget.
  - new `getLiquidityTier(asset) → uint8 {0,1,2,3}` view — `0` if not
    `Liquid`, else the highest tier whose `tierNSizeUsd` the asset
    clears at `≤ slippageBps`. Pure derivation from the same simulated
    swaps; no per-asset storage.
- **Governance globals (`ProtocolConfig` / `ConfigFacet`, all
  `onlyRole(ADMIN_ROLE)` → later governance, bounded, `0 ⇒ default`):**
  `liquiditySlippageBps`, `floorSizeUsd`, `tier1SizeUsd`,
  `tier2SizeUsd`, `tier3SizeUsd`, `tier1MaxInitLtvBps`,
  `tier2MaxInitLtvBps`, `tier3MaxInitLtvBps`
  (`tier1 ≤ tier2 ≤ tier3` enforced on both the sizes and the LTVs),
  `twapConsistencyBps` + `twapWindowSec`, and `bool depthTieredLtvEnabled`
  master kill-switch (default `false`; while `false` the init gate is
  exactly today's `HF ≥ 1.5`, i.e. everyone effectively Tier 1 @ ~53% —
  flip per chain after that chain's slippage census). **No per-asset
  tier mapping, no allowlist.** Bad actors are removed via the existing
  `AdminFacet.pauseAsset` / blacklist path, not via this.
- **Keeper liquidity-confidence tier (§4.1.b item 2):**
  `mapping(address ⇒ uint8) keeperTier`, **default `1`**, settable by
  `KEEPER_ROLE` (raises one step on accumulated 0x/1inch confidence,
  drops immediately on degradation; optional promotion time-lock /
  quorum). `effectiveTier(asset) = min(getLiquidityTier(asset),
  keeperTier(asset))` — so a new asset opens at Tier 1 (`HF ≥ 1.5`)
  until the keeper confirms; a compromised keeper is bounded by the
  on-chain ceiling (degrades to the no-keeper baseline, never below);
  keeper down ⇒ everyone effectively Tier 1 (fail-open). The on-chain
  *storage + role* land with the rest of Piece B (§4.4 step 4); the
  keeper *process* is §4.4 step 5 (Phase 2.5).
- **Init gate (`LoanFacet._runInitGates` + `LibOfferMatch`'s synthetic
  HF check on the `matchOffers` path):** when `depthTieredLtvEnabled`,
  cap init-LTV at `min(assetRiskParams.maxLtvBps, tierMaxInitLtvBps[
  effectiveTier(collateralAsset)])` **instead of** relying purely on
  `HF ≥ 1.5`. Per-asset `liqThresholdBps` (the liquidation trigger) is
  untouched. A loan that fails the tier cap reverts `InitLtvAboveTier`.
  (Lender-sale vehicles / both-legs-illiquid loans keep their existing
  LTV/HF skip.)

### 4.3 Proposed launch defaults (all governance globals)

| Knob | Default | Meaning |
|---|---|---|
| `liquiditySlippageBps` | 200 (2%) | the slippage bound a test trade must clear |
| `floorSizeUsd` | $5 k | clear at this → `Liquid`; fail → `Illiquid` (widget routes it to manual Create Offer) |
| `tier1SizeUsd` / `tier2SizeUsd` / `tier3SizeUsd` | $50 k / $500 k / $5 M | clear at the largest of these you can → that tier |
| `tier1MaxInitLtvBps` / `tier2` / `tier3` | 5000 / 6000 / **6500** (50% / 60% / 65%) | the init-LTV cap at that tier |
| `twapWindowSec` / `twapConsistencyBps` | ~30 min / ~300 (3%) | pool spot vs its own TWAP must agree within this (manipulation guard) |
| `depthTieredLtvEnabled` | `false` | master kill-switch; while off, init gate = today's `HF ≥ 1.5` |

Sanity-check against the §3 depth census (an asset's deepest
non-correlated pool roughly maps to "can it clear an $X test trade at
≤2%" — a $5 M trade at ≤2% needs ≳$250 M of depth, $500 k needs
≳$25 M, $50 k needs ≳$2.5 M; **only ≤0.3%-fee-tier pools count** —
see §4.1): WBTC/USDC/USDT/LINK/wstETH/weETH would land **Tier 3**
(65%); AAVE/UNI/DAI **Tier 2** (60%); PEPE/cbBTC **Tier 1** (50%);
SHIB's *direct* {WETH,USDC,USDT} pools are thin enough that on a strict
single-hop check it'd be **Tier 1 at best** (possibly fail $5 k →
`Illiquid`) — that's the single-hop limitation biting, and the honest
answer is "it's then a manual Create-Offer asset until a multi-hop-aware
check exists". These are starting numbers to be **re-validated by a
per-chain slippage census before `depthTieredLtvEnabled` is flipped**
(testnet mock pools won't reflect mainnet).

Note on the 65% top tier (was 73% → 69% → 65%, reduced over
2026-05-12): at 65% init-LTV against an ~82% liq-threshold the init HF
is ≈ 1.26 — a ~26% adverse price move before the position hits the
liquidation line. Comfortably more conservative than Aave v3's
core-market LTVs (WETH ~80.5%/83%) — appropriate given Vaipakam's
liquidation is permissionless-but-not-instant + 0x-swap-dependent (no
per-second bots), and there's no governance per-asset override to catch
a mis-tier (§4.1). **Still shouldn't ship until the matcher +
liquidator bots are proven on testnet**, and the number stays a
risk-committee call — it can ramp up from a lower opening figure once
liquidation behaviour is observed.

### 4.4 Sequencing & gates

**Status as of 2026-05-13 (branch `feat/market-rate-widget-and-tiered-ltv`):**

- Step 1 — Piece A: **DONE & deployed** base-sepolia (`a1eb9fcb`). Widget + cross-chain "thin here" warning + 0x/1inch slippage preflight + i18n for all 10 locales all shipped.
- Step 2 — matcher port: **DONE.** `apps/keeper/src/matcher.ts` + `runMatcher` wired into the cron. Not deployed yet — that's the deliberate ~2-week testnet-bake gate.
- Step 3 — base `checkLiquidity` floor: **DONE.** Two-stage rollout: first the depth-at-tick metric was upgraded to a real PAD figure (`2 × WETH-leg-virtual-reserve × ethPrice`, was just `pool.liquidity()`); then the FULL upgrade in `050e1ea` retired `_v3DepthLiquid` entirely and replaced it with `_passesFloorSlippage` — a slippage-at-`floorSizePad` route search reusing the same machinery `_liquidityTier` uses. Adds value-balance + TWAP-consistency guards, includes V2 routes in the base check, drops the 1% fee tier. 1795 / 0 / 5 regression green.
- Step 4 — rest of Piece B behind `depthTieredLtvEnabled`: **DONE.** 7 contract commits, `getLiquidityTier` view + `effectiveTier` + tier-size/tier-LTV/TWAP-guard/confidence-window globals + `LoanFacet._checkInitialLtvAndHf` cap + `keeperTier` mapping + `KEEPER_ROLE` + the Uni-V2-fork-family route search (`055af76`), the `LibOfferMatch.previewMatch` tier-cap alignment (`96d6697`), the init-gate integration tests (`cc6419a`), the frontend `useProtocolConfig` + `useAssetTier` wiring (`7118200`). Kill-switch default `false` ⇒ today's HF≥1.5 still binding.
- Step 5 — liquidity-confidence relay: **DONE.** `apps/keeper/src/liquidityConfidence.ts` (`89920f4`) + the Tier-3 2-of-3 ensemble advisory (DeFiLlama listing + CoinGecko market cap + CoinGecko 24h volume — `2af421e`).
- Step 6 — per-chain slippage census + audit + risk sign-off: **OPEN.** Required before `depthTieredLtvEnabled` flips on any chain.

**Deferred / parallel — liquidator keeper bot hardening: SUBSTANTIALLY DONE.**

- Multicall HF + priority sort (faster monitoring): `43f7b6c`.
- Best/split-route swaps (`LibSwap.swapWithSplit` + `RiskFacet.triggerLiquidationSplit` + keeper decision logic): `4246a46` + `7d43034`.
- Partial liquidations (`RiskFacet.triggerPartialLiquidation` + governance close-factor cap + full test sweep + keeper optimal-fraction math): `1ca7cba` + `8da2c8d` + `a3c53dd` + `c487239` + `3a0f81a` + `738c7c7` + `5bc4cd6`.
- Flash-loan-funded execution: **BLOCKED** on a risk-committee decision about the keeper-incentive model. Under the current model the keeper EOA needs zero working capital (the diamond does the atomic swap from collateral custody) so flash-loans have no clear motivating use case; would need a switch to Aave-style "liquidator buys collateral at a discount" first. No code; surface to risk committee.

The Tier-3 LTV ramp past its conservative opening (currently 65%) is gated on the above plus the Step-6 audit. Tiers 1 and 2 don't depend on flash-loan execution.

---

**Original plan (preserved for reference):**

1. **Ship Piece A** — the widget + the §2.b cross-chain "thin here"
   warning + the §4.1.b 0x/1inch widget pre-check. Frontend-only, no
   contract dependency; can land with / just after the matcher-bot work.
2. Port the matcher bot into `apps/keeper` (see `KeeperBotTopology`
   memory / Range Orders plan) and bake the matching + liquidation path
   on testnet for ~2 weeks.
3. **Fix the base `checkLiquidity` floor** to the slippage-at-`floorSizeUsd`
   check (best route over {WETH,USDC,USDT} × Uni-V3 clones × fee ≤0.3%,
   spot≈feed guard) — replaces the mislabeled `liquidity() × ethPrice`
   floor. Standalone Phase-7b-area change; can land independently of /
   ahead of the rest of Piece B.
4. **Implement the rest of Piece B** behind `depthTieredLtvEnabled`
   (`ProtocolConfig`, default `false`, à la the Range-Orders flags):
   `getLiquidityTier` view + `effectiveTier()` + the tier-size /
   tier-LTV / TWAP-guard / confidence-window globals + the
   `LoanFacet._runInitGates` cap + the `keeperTier` mapping (default
   `1`) & `KEEPER_ROLE` (relay storage; the keeper process itself is
   step 5).
5. **Keeper liquidity-confidence relay (Phase 2.5)** — the `apps/keeper`
   process that periodically queries 0x/1inch for realized slippage at
   the tier sizes and `setKeeperTier(asset, tier)`s (promotes one step
   on an accumulated-confidence window, demotes immediately on
   degradation — see §4.1.b item 2 / §9.ii). Lands *before*
   `depthTieredLtvEnabled` is flipped on any chain, so high-LTV tiers
   never go live without the aggregator-confirmed confidence having
   accumulated. Single keeper to start; optional promotion time-lock /
   N-of-M oracle-quorum are later hardenings.
6. **Per-chain slippage census + audit + risk sign-off**, then flip
   `depthTieredLtvEnabled` chain-by-chain. The audit covers steps 3–5
   (a direct loosening of the init safety buffer) — bundle with the
   Range-Orders audit or run as a follow-up.

**Deferred / parallel — improve the liquidator keeper bot for higher
LTV.** A higher init-LTV means a thinner cushion at liquidation (HF
crosses 1.0 with less margin), so the liquidator must be *faster*
(tighter HF monitoring) and *smarter about execution* (best-route /
split-route swaps via the aggregators, partial liquidations,
possibly flash-loan-funded so the bot needs no working capital). This
is a `apps/keeper` (+ public reference `vaipakam-keeper-bot`)
improvement, tracked separately — flagged here because the Tier-3 LTV
shouldn't ramp past its conservative opening figure until the
liquidator bot has been hardened for it.

---

## 5. Decisions (locked 2026-05-13)

1. **Piece A — ship now. ✅** The widget on the existing `HF ≥ 1.5`
   math (no tiers), a pure prefilled deep-link to Create Offer — no
   one-click post, button never disabled. Includes the §2.b cross-chain
   warning and the §4.1.b 0x/1inch widget pre-check (decision 9.i).
2. **Piece B model — confirmed. ✅** Permissionless: the on-chain
   simulated-swap-slippage check (§4.1) *is* the tier authority — no
   governance per-asset allowlist/tier-list; the only per-asset lever is
   the existing `pauseAsset` / blacklist (remove-only, never admit);
   governance owns only the global knobs. V3 uses the cheap virtual-
   reserve constant-product approximation (not the gas-heavy Quoter),
   accepting the large-trade-on-a-thin-adjacent-tick caveat, bounded by
   the conservative top-tier LTV + the spot≈feed + TWAP-consistency
   guards + the keeper liquidity-confidence relay (§4.1.b item 2 — every
   asset opens at Tier 1 / `HF ≥ 1.5` and is promoted only on
   accumulated 0x/1inch confidence, demoted immediately on degradation;
   `effectiveTier = min(onChainSlippageTier, keeperTier)`). Acknowledged
   trade-off: single-hop only — SHIB-likes (deep *via* a stable pair,
   thin *against* one) stay low-tier / manual until a multi-hop-aware
   check exists.
3. **Tier LTVs — Tier 1 50% / Tier 2 60% / Tier 3 65%. ✅** (Init HF ≈
   1.26 vs an ~82% liq-threshold.) Risk committee may open Tier 3 lower
   and ramp; ramp gated on the liquidator-bot hardening (§4.4 deferred).
4. **Route-search scope — confirmed. ✅** {asset/WETH, asset/USDC,
   asset/USDT} × {Uniswap / SushiSwap / PancakeSwap V3, whichever's
   configured on the chain} × fee tiers ≤ 0.3% (drops the 1% tier — also
   slightly tightens the base `Liquid` gate; fail-safe).
5. **Test sizes + slippage bound — confirmed as launch defaults. ✅**
   $5 k floor / $50 k → T1 / $500 k → T2 / $5 M → T3, all at ≤ 2%
   slippage; re-validated per chain before `depthTieredLtvEnabled` flips.
6. **Market cap — NOT an on-chain criterion. ✅** `totalSupply() × price`
   measures FDV not liquidity, is manipulable (`totalSupply()` is
   whatever the token returns), and is redundant with the $5 k slippage
   floor. Advisory-only off-chain (keeper-relay heuristic — a big-FDV /
   thin-pool discrepancy is a reason to *not* promote — / widget flag).
7. **Base `checkLiquidity` floor — fix it now. ✅** Replace
   `liquidity() × ethPrice` ("$1 M" ≈ "pool isn't empty") with the
   slippage-at-`floorSizeUsd` check. Standalone Phase-7b-area change,
   ahead of the rest of Piece B (§4.4 step 3).
8. **Spot-DEX families on-chain — v1 = Uniswap-V3 clones only. ✅**
   Accept the conservative under-count for assets that live only on a
   chain-native AMM we don't integrate (Aerodrome/Base, Velodrome/OP,
   Camelot/Arb, …) — fail-safe (0x/1inch still route there at
   liquidation). Adding Uni-V2 forks + Curve StableSwap is the
   highest-value later addition; Balancer V2 via `Vault.queryBatchSwap`
   optional. **Perps DEXs (dYdX / AsterDEX) are out** — perp orderbook
   depth ≠ spot liquidity; nothing for a liquidator to sell into; dYdX
   isn't EVM-readable.
9. **Aggregators (§4.1.b):** (i) **widget pre-check via the existing
   0x/1inch Worker proxy — yes, ships with Piece A. ✅** (ii) **keeper
   liquidity-confidence relay — Phase 2.5, single keeper to start,
   promotion time-lock / quorum as later hardenings. ✅** Model (user
   2026-05-13): a new asset always starts at Tier 1 (`HF ≥ 1.5`); the
   keeper promotes it one step at a time only after its periodic
   0x/1inch slippage checks have stayed within the bound across a
   confidence window, and demotes immediately on degradation;
   `effectiveTier = min(onChainSlippageTier, keeperTier)` so the keeper
   can never promote past the on-chain ceiling. (rationale: see §9.ii.)
10. **Cross-chain "thin here" warning — ship the generic version with
    Piece A. ✅** "Which chain is deeper" hint is a Phase 2.5/3 follow-up
    (needs a cross-(asset, chain) depth index).
11. **Master kill-switch — `depthTieredLtvEnabled` in `ProtocolConfig`,
    default `false`. ✅** While off, the init gate is exactly today's
    `HF ≥ 1.5`; flip per chain after that chain's census + the relay
    being live.

### 9.ii — the keeper liquidity-confidence relay, in detail

*The model* (user 2026-05-13): a brand-new asset always opens at **Tier
1** (`HF ≥ 1.5` — today's behaviour) regardless of what the on-chain
slippage check reads, and the keeper *earns it up* from there.
On-chain: `mapping(address ⇒ uint8) keeperTier`, **default `1`**,
settable by `KEEPER_ROLE` via `setKeeperTier(asset, tier)`. The
loan-init gate uses `effectiveTier(asset) = min(getLiquidityTier(asset),
keeperTier(asset))`. An `apps/keeper` pass (next to the liquidator)
periodically queries 0x / 1inch for the realized slippage of selling
the *next* tier's test size of each in-scope collateral asset; once
that's stayed `≤ slippageBps` across a confidence window (N consecutive
checks over D days — globals), it `setKeeperTier(asset, currentTier+1)`.
If a check shows the slippage has degraded past the bound, it demotes
**immediately** (one or more steps, toward `1`) — no window for
demotions.

*Why it's safe by construction.* (1) **Bounded promotions** — a
*compromised* keeper can `setKeeperTier(asset, 3)` for anything, but
`effectiveTier = min(getLiquidityTier(asset), keeperTier(asset))`: for a
junk asset the on-chain slippage check already returns Tier 0/1, so the
forced promotion has *no effect*; for a genuinely-deep asset the
compromise can only grant the tier the (approximate) on-chain check
already vetted, *prematurely* — i.e. the worst case is "we relied on
the on-chain approximation alone for this asset", which is the
no-keeper baseline. A compromised keeper degrades *to baseline*, never
below it. (2) **Unbounded demotions = fail-safe** — the keeper can
always pull `keeperTier` down to `1`; that just makes things more
conservative. (3) **Fail-open** — keeper down / never ran ⇒ `keeperTier`
stuck at `1` everywhere ⇒ every asset effectively Tier 1 ⇒ exactly
today's `HF ≥ 1.5` for everything. The relay is what *enables* the
higher tiers; without it the system is just today's protocol. (4) **Not
an allowlist** — the on-chain check still tiers every asset (it's the
ceiling); the keeper only adds a confidence delay before that ceiling is
granted, and can drop it any time. (5) **Recoverable** — governance can
reset `keeperTier` for any asset / rotate the keeper key.

*The one residual risk* — and its mitigations: a compromised keeper that
*prematurely promotes* a genuinely-deep asset to Tier 3 removes exactly
the confidence delay the relay exists to provide. The asset is still
gated by the (approximate) on-chain check, and the Tier-3 LTV (65%
default) keeps a ~17-point cushion to the ~82% liq-threshold, so the
loss is "the confidence window, not real over-collateralisation". If
that's still too much, the **optional hardenings**: a *promotion
time-lock* (a `setKeeperTier`-up takes effect D′ hours later, demotions
immediate — governance can veto in the window); and/or an *N-of-M
keeper quorum on promotions* (reuse the Tellor/API3/DIA-style quorum
machinery — a promotion needs M of N keepers to agree; demotions from
any one are honoured). Single keeper, no time-lock is acceptable for
v1; quorum + time-lock are tracked hardenings.

*The simpler alternative (rejected for now):* drop the *graded* on-chain
slippage check and keep only the binary `Liquid`/`Illiquid` floor —
then `keeperTier` is the *sole* tier authority. Less on-chain math (no
graded virtual-reserve `mulDiv`), but the keeper is then unbounded-up:
a compromised keeper could promote a junk asset to Tier 3 → real
bad-debt risk → would *require* the quorum + time-lock. Keeping the
graded on-chain check as the ceiling is the safer call.

*Timing.* Phase 2.5 — the `keeperTier` *storage* + `KEEPER_ROLE` +
`setKeeperTier` setter land with the rest of Piece B (§4.4 step 4); the
keeper *process* (the 0x/1inch polling + confidence accumulation) is
step 5, and lands *before* `depthTieredLtvEnabled` is flipped on any
chain — so a high-LTV tier never goes live without the aggregator-
confirmed confidence having actually accumulated. From your side the
effect is the same as "Phase 2"; the split just lets Piece B's audit
not wait on the keeper process being written.
