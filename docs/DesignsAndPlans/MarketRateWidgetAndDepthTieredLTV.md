# "Lend / Borrow at market rate" widget + depth-tiered LTV

Status: **design — not yet implemented.** Two related but separable
pieces. Piece A (the widget) is a frontend-only change on top of the
already-shipped Range Orders Phase 1 and the existing `HF ≥ 1.5e18`
init gate. Piece B (depth-tiered LTV) is a contract risk-parameter
change that **requires an audit + risk sign-off** and is queued behind
the Range-Orders + matcher-bot testnet bake.

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

**Illiquid asset** (`checkLiquidity → Illiquid` for either leg): button
disabled, info-tip *"This asset isn't liquid enough for instant
market-rate matching — use Create Offer to post a custom offer."*
("Market rate" is meaningless for an asset that can't be matched at
market; the tip points to Create Offer, where a custom offer is still
possible.)

### Why this needs no contract change

The widget only ever *deep-links to Create Offer*; the loan still goes
through `initiateLoan`, which enforces `HF ≥ 1.5`. The auto-filled
`minCollateral` is, by construction, exactly the smallest collateral
that passes today's gate. Nothing on-chain changes — it's a "smart
prefilled Create Offer" shortcut, end to end.

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

### 4.1 The metric problem (from §3) forces a choice

The proposal as originally floated — "tier on the existing on-chain
pool-depth check" — **doesn't work**, because that check's metric isn't
a USD figure. Three viable approaches:

- **(a) Fix the depth computation to a real USD figure** and tier on
  it. Replace `_v3DepthLiquid`'s `liquidity() × ethPrice` with
  `2 × wethLegVirtualReserve × ethPriceUsd`, where `wethLegVirtualReserve`
  comes from `pool.slot0().sqrtPriceX96` + `pool.liquidity()` (it's
  `L × sqrtPriceX96 / 2^96` when WETH is token1, `L × 2^96 / sqrtPriceX96`
  when WETH is token0 — needs `mulDiv` for overflow). `MIN_LIQUIDITY_USD`
  becomes a *real* $1 M. Pros: keeps the "zero per-asset config, on-chain
  discovery" property; same OR-over-3-venues structure. Cons: touches
  Phase-7b oracle code with new fixed-point math; still over-states for
  correlated pairs and misses multi-hop routes (SHIB/cbBTC cases).
- **(b) Per-asset admin/governance tier** — `s.assetLiquidityTier[asset]
  ∈ {0,1,2,3}` set by `ConfigFacet` under `onlyRole(ADMIN_ROLE)` based
  on off-chain analysis (market cap + 24h volume + a depth census like
  §3). Pros: honest; matches how Aave / Compound / Morpho actually set
  risk tiers (governance, informed by Gauntlet/Chaos-Labs sims, not an
  on-chain formula); handles the SHIB/cbBTC edge cases naturally; no
  audited-oracle-code change. Cons: a manual knob, not "automatic via
  Uniswap".
- **(c) Hybrid (recommended)** — on-chain proper-depth (approach a)
  computes a *ceiling* tier; governance can *cap* it lower per asset
  (`s.assetTierCap[asset]`, default = no cap = Tier 3). So:
  `effectiveTier = min(onChainDepthTier(asset), assetTierCap[asset])`.
  The on-chain depth can never *promote* an asset above what governance
  allows; governance can knock down a thin-float token whose direct
  WETH pool happens to look deep, or — until/unless the depth check
  becomes multi-hop-aware — promote nothing but at least not block a
  legitimately-liquid asset (governance just doesn't cap it). This is
  the Aave-style "automated discovery + governance override" pattern.

**Decision needed:** (a) pure-on-chain, (b) pure-governance, or (c)
hybrid. I lean (c).

### 4.2 Mechanics (assuming approach (a) or (c))

- `OracleFacet` gains a `getLiquidityTier(asset) → uint8 {0,1,2,3}`
  view: 0 = illiquid (below the floor / no fresh feed), else the
  highest tier whose USD-depth threshold the deepest asset/WETH pool
  clears (max over the 3 V3 venues, same as `_checkLiquidity`).
- `ProtocolConfig` gains (all `onlyRole(ADMIN_ROLE)`, bounded, with
  `0 ⇒ default` sentinels):
  - `tier2DepthUsd`, `tier3DepthUsd` — alongside the existing
    `MIN_LIQUIDITY_USD` (= Tier 1 floor), in real USD scale.
  - `tier1MaxInitLtvBps`, `tier2MaxInitLtvBps`, `tier3MaxInitLtvBps`.
  - (hybrid only) `assetTierCap` mapping.
- `LoanFacet._runInitGates` (and `LibOfferMatch`'s synthetic HF check
  on the `matchOffers` path) cap init-LTV at
  `min(assetRiskParams.maxLtvBps, tierMaxInitLtvBps[tier])` **instead
  of** relying purely on `HF ≥ 1.5`. The per-asset `liqThresholdBps`
  (the liquidation trigger) is untouched. A loan that fails the tier
  cap reverts with a new `InitLtvAboveTier` error.
- The tier is read **on-chain per-tx**, so an LP yanking liquidity can
  momentarily drop an asset a tier and block a new high-LTV loan —
  fail-safe direction; **existing loans are untouched** (the tier only
  gates *init*, never re-liquidation).

### 4.3 Proposed launch defaults

Using the **proper** USD-depth metric (§3). All four numbers are
governance knobs; these are starting values to be **re-validated by a
per-chain depth census before the feature is enabled** (testnet mock
pools won't reflect mainnet at all):

| Tier | Depth threshold (proper USD, direct asset/WETH pool) | Max **init**-LTV | Init HF vs an ~82% liq-threshold | Census members |
|---|---|---|---|---|
| illiquid | < $1 M (or no fresh feed) | — (widget disabled) | — | SHIB* (direct pool only) |
| **Tier 1** | ≥ **$1 M** (= existing `MIN_LIQUIDITY_USD`) | **50%** (≈ today's `liqThreshold/1.5`) | ~1.6 (unchanged behaviour) | cbBTC*, PEPE |
| **Tier 2** | ≥ **$10 M** | **60%** | ~1.37 | DAI*, UNI, AAVE |
| **Tier 3** | ≥ **$50 M** | **73%** | ~1.12 | USDC, WBTC, USDT, LINK, wstETH, weETH |

\* edge cases where the *direct* asset/WETH pool understates real
liquidity — exactly what the governance per-asset cap/override in
approach (c) is for (and, conversely, why SHIB landing "illiquid" on a
pure-on-chain check would be wrong → another vote for the hybrid).

Note on the 73% top tier: at 73% init-LTV against an ~82% liq-threshold
the init HF is ≈ 1.12 — i.e. a ~9% adverse price move puts the position
near the liquidation line. That's tighter than the current 1.5 buffer
and tighter than Maker's conservative vaults, but in the neighbourhood
of Aave v3 core-market LTVs (WETH ~80.5%/83%) — except Aave has
per-second liquidation bots; Vaipakam's liquidation is permissionless-
but-not-instant + 0x-swap-dependent. **The 73% should not ship until
the matcher + liquidator bots are proven on testnet**, and it's
explicitly a risk-committee call (e.g. could open at 65–70% and ramp).

### 4.4 Sequencing & gates

1. Ship Piece A (the widget) — frontend-only, no dependency on Piece B;
   can land with / just after the matcher-bot work.
2. Port the matcher bot into `apps/keeper` (see `KeeperBotTopology`
   memory / Range Orders plan) and bake the matching + liquidation path
   on testnet for ~2 weeks.
3. Implement Piece B contracts behind a master kill-switch
   (`depthTieredLtvEnabled` in `ProtocolConfig`, default `false`, à la
   the Range-Orders flags) so it can be flipped on chain-by-chain after
   a per-chain depth census.
4. **Audit + risk sign-off on Piece B before mainnet enable** — it is a
   direct loosening of the init safety buffer; bundle with the
   Range-Orders audit or run as a follow-up.

---

## 5. Open decisions

1. **Piece A**: ship the widget now on the existing `HF ≥ 1.5` math (no
   tiers), as a pure prefilled deep-link to Create Offer (no one-click
   post)? (Recommended yes — it's the UX you asked for, it's
   contract-change-free, and the all-clicks-through-Create-Offer
   simplification keeps it to one submit path with full review.)
2. **Piece B metric/discovery**: approach (a) pure-on-chain proper-depth,
   (b) pure per-asset governance tier, or (c) hybrid (on-chain ceiling +
   governance per-asset cap)? (Recommended (c).)
3. **Tier-3 init-LTV**: 73% as proposed, or a more conservative 65–70%
   with a ramp, given non-instant liquidation? (Risk-committee call.)
4. **Depth thresholds**: $1 M / $10 M / $50 M (proper-USD metric) as the
   launch defaults — confirm, pending the per-chain census re-validation.
5. Should the `MIN_LIQUIDITY_USD` *current* gate be fixed to the proper
   metric independently of Piece B (it's mislabeled today), or only as
   part of Piece B?
