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
tradeable depth by 2–4 orders of magnitude). So a robust on-chain depth
check should take the **max over {asset/WETH, asset/USDC, asset/USDT}**
pools AND apply a correlated-pair guard (e.g. ignore a pool whose price
sits within ~1% of a stable/peg unless it's the asset being priced, or
simply exclude stable-stable + LST-correlated pools from the tier
signal). Even then it stays blind to multi-hop liquidity (the SHIB
case). All of which is a strong vote for the **hybrid** approach in §4
— the on-chain signal is too noisy to be the sole authority.

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

### 4.1 "Is there a better on-chain liquidity check?" — and why the answer is *governance sets the tier*

Short answer: **no cheap on-chain read reliably measures an asset's
liquidity.** The §3 census makes this concrete — `pool.liquidity()`
isn't a USD figure at all; the "proper" `L × sqrtP × price` reconstruction
*is* USD but over-states correlated/stable pools by 2–4 orders of
magnitude and only sees one pool at a time, missing multi-hop routes
(SHIB looked sub-$1 M; cbBTC's real depth is on Base). You can patch
some of that (max over {WETH, USDC, USDT} pools, a correlated-pair
guard) and it gets *less* wrong, but it never gets *right*. The options
to do better, in increasing accuracy and cost:

- **(A) Quote-based check** — instead of reading reserves, `staticcall`
  a V3 Quoter (`QuoterV2.quoteExactInputSingle` / a multi-hop quote, and
  optionally a 1inch/0x off-chain quote surfaced on-chain) for a fixed
  trade size and compare the realized price to the oracle price. This is
  *the* correct measure of liquidity — it's literally "can a liquidator
  dump $X of this without crushing the price?", which is what
  liquidation needs — and it naturally handles concentrated liquidity,
  multi-hop, and correctly *values* stable pairs (a USDC→USDT quote is
  great, so it reports high liquidity, not fiction). **Killer downside:**
  a Quoter call that crosses many ticks is ~100k–500k gas, and a graded
  check needs three of them ($1 M / $10 M / $50 M) — that's 0.3–1.5 M
  gas added to *every* `createOffer` / `initiateLoan`, in a hot path.
  Caching the result (compute once per N blocks, store the tier) brings
  the gas down but reintroduces staleness + cross-block manipulability.
  Not viable hot; only as a cached/keeper-fed value — which is just (B).
- **(B) Off-chain depth oracle pushed on-chain** — a keeper periodically
  reads aggregated cross-DEX/CEX depth (CoinGecko / DeFiLlama /
  1inch-API "liquidity at ±2%") and pushes a per-asset depth (or tier)
  on-chain, with a freshness/staleness model — directly analogous to the
  secondary-price-oracle quorum (Tellor / API3 / DIA) already in the
  codebase. Most accurate; most infrastructure (a new feed, a keeper, a
  trust/quorum model). Reasonable Phase-3+ if graded automation turns
  out to matter.
- **(C) Per-asset tier set by governance, with a coarse on-chain *floor*
  — recommended.** The on-chain check stays a simple binary "is this
  asset liquid *at all*?" gate: a fresh Chainlink feed AND at least one
  asset/{WETH,USDC,USDT} pool clearing a real ~$1 M floor (max over the
  3 V3 venues, correlated-pair guard so a stable-stable pool can't be
  the thing that clears it). If that passes the asset is at least
  **Tier 1**; **governance promotes to Tier 2 / Tier 3** per asset, set
  from an off-chain depth census (like §3) + market-cap/volume data.
  This is exactly how Aave / Compound / Morpho do it — nobody derives an
  LTV cap from an on-chain liquidity formula; risk tiers are governance
  parameters informed by Gauntlet/Chaos-Labs-style off-chain analysis.
  Pros: honest about what's measurable on-chain; handles every §3 edge
  case (SHIB, cbBTC, the stable pools) the obvious way — a human looks;
  minimal new audited code (no graded-depth math, no `mulDiv` curve
  reconstruction in the oracle); the on-chain floor still keeps the
  obviously-illiquid stuff off the high-LTV path even if governance is
  asleep. Con: not "automatic via Uniswap" — but the census proves
  "automatic via Uniswap" can't be done safely on-chain anyway.

(There is also the earlier "hybrid": on-chain *proper-depth* computes a
ceiling tier, governance caps it lower. It's strictly more code than (C)
for the same practical outcome — the on-chain ceiling would mostly just
agree with governance, and where it disagrees governance wins anyway —
so (C) supersedes it.)

**Recommendation: (C).** Also worth doing independently of the tier
work: fix the *base* `checkLiquidity` floor to a real USD figure
(replace `_v3DepthLiquid`'s `liquidity() × ethPrice` with
`2 × stableLegVirtualReserve × stablePrice` — `L × sqrtPriceX96 / 2^96`
or `L × 2^96 / sqrtPriceX96` depending on token order, `mulDiv` for
overflow — max over the 3 denominators, correlated-pair guard) so the
"$1 M" label stops being fiction. That's a Phase-7b-area change, not
blocking, but it makes both the floor and any future Tier-1 cut-off
mean what they say.

### 4.2 Mechanics (approach (C))

- **On-chain (`OracleFacet`):** `checkLiquidity(asset)` keeps its
  binary `Liquid` / `Illiquid` shape (ideally with the floor metric
  fixed per §4.1) — this gates the *widget* and is the Tier-1 floor.
  No new graded-depth view.
- **Governance tier (`ProtocolConfig` / `ConfigFacet`):**
  - `mapping(address ⇒ uint8) assetLiquidityTier` — `0` = "not set"
    (→ treated as Tier 1 when the asset is `Liquid`), `1`/`2`/`3` =
    governance-assigned. Setter `setAssetLiquidityTier(asset, tier)`
    under `onlyRole(ADMIN_ROLE)` (later governance), bounded `tier ≤ 3`.
  - `tier1MaxInitLtvBps`, `tier2MaxInitLtvBps`, `tier3MaxInitLtvBps`
    (each `0 ⇒ default`, bounded; `tier1 ≤ tier2 ≤ tier3` enforced).
  - `bool depthTieredLtvEnabled` master kill-switch, default `false`.
    While `false`, the init gate is exactly today's `HF ≥ 1.5`
    (i.e. everyone is effectively Tier 1 @ ~53%); flip per chain after
    its depth census.
  - Effective tier at init = `!depthTieredLtvEnabled ? 1 :
    !isLiquid(asset) ? 0 : max(1, assetLiquidityTier[asset])`.
- **Init gate (`LoanFacet._runInitGates` + `LibOfferMatch`'s synthetic
  HF check on the `matchOffers` path):** when `depthTieredLtvEnabled`,
  cap init-LTV at `min(assetRiskParams.maxLtvBps, tierMaxInitLtvBps[tier])`
  **instead of** relying purely on `HF ≥ 1.5`. Per-asset
  `liqThresholdBps` (the liquidation trigger) is untouched. A loan that
  fails the tier cap reverts `InitLtvAboveTier`.
- **Existing loans untouched** — the tier only gates *init*, never
  re-liquidation. A governance tier downgrade (or an asset flipping
  `Illiquid`) blocks *new* high-LTV loans on that asset; open positions
  are unaffected.

### 4.3 Proposed launch defaults

Under approach (C): the on-chain floor decides `Liquid` / `Illiquid`
(real ~$1 M floor, max over the 3 denominators, correlated-pair guard);
**governance assigns the 1/2/3 tier per asset** from an off-chain depth
census (§3) + market data. The "≈ depth" column below is the §3-census
figure governance would weigh; the "members" column is where these
assets would *plausibly* land — but governance has the final call (it
can promote SHIB despite its thin direct WETH pool, hold DAI at Tier 2
despite the over-stated DAI/USDT stable pool, etc.). All LTVs are
`ProtocolConfig` knobs; flip `depthTieredLtvEnabled` per chain only
after that chain's census + risk review:

| Tier | ≈ depth governance would weigh (best non-correlated pool) | Max **init**-LTV | Init HF vs an ~82% liq-threshold | Plausible members (governance decides) |
|---|---|---|---|---|
| illiquid (Tier 0) | no fresh feed, or all {WETH,USDC,USDT} pools < ~$1 M | — | — | (none in the census; SHIB's *direct* pools fall here but its real liquidity is via SHIB/stable → governance would not leave it Illiquid) |
| **Tier 1** | ≥ ~$1 M | **50%** (≈ today's `liqThreshold/1.5`) | ~1.6 (= unchanged behaviour) | cbBTC, PEPE |
| **Tier 2** | ≥ ~$10 M | **60%** | ~1.37 | DAI, UNI, AAVE |
| **Tier 3** | ≥ ~$50 M | **69%** | ~1.19 | USDC, WBTC, USDT, LINK, wstETH, weETH |

Note on the 69% top tier (was 73%, reduced 2026-05-12): at 69%
init-LTV against an ~82% liq-threshold the init HF is ≈ 1.19 — a ~16%
adverse price move before the position hits the liquidation line. Still
well below the current 1.5 buffer, but a meaningful cushion above the
~1.05 a 78%/82% pair would give, and conservative-leaning vs Aave v3's
core-market LTVs (WETH ~80.5%/83%) — appropriate given Vaipakam's
liquidation is permissionless-but-not-instant + 0x-swap-dependent (no
per-second bots). **Still shouldn't ship until the matcher + liquidator
bots are proven on testnet**, and the number stays a risk-committee
call — it can ramp up from a lower opening figure once liquidation
behaviour is observed.

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
   post, button never disabled)? (Recommended yes — it's the UX you
   asked for, contract-change-free, one submit path with full review.)
2. **Piece B discovery model**: approach (C) — governance sets the
   per-asset 1/2/3 tier, on-chain check is just the `Liquid`/`Illiquid`
   floor — confirmed? (Recommended; the §3 census shows no cheap
   on-chain read can reliably grade liquidity. (A) quote-based is the
   only "correct" on-chain metric and it's too gas-heavy for the hot
   path; (B) an off-chain depth oracle is the accurate-but-infra-heavy
   alternative for later.)
3. **Tier-3 init-LTV**: **69%** (current) — or open lower (65%) and
   ramp? (Risk-committee call; 69% → init HF ≈ 1.19 vs an ~82%
   liq-threshold.) Tier-2 60% / Tier-1 50% — confirm.
4. **Census thresholds governance weighs** (~$1 M / ~$10 M / ~$50 M
   best-non-correlated-pool depth) — confirm as the rough bands, pending
   per-chain re-census.
5. Fix the *base* `checkLiquidity` floor to a real USD figure now
   (independent of Piece B — it's mislabeled today: "$1 M" ≈ "non-empty
   pool"), or only as part of Piece B?
6. Master kill-switch name/shape: `depthTieredLtvEnabled` in
   `ProtocolConfig`, default `false`, à la the Range-Orders flags — OK?
