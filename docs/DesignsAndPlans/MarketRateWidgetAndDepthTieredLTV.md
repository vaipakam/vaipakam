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
**off-chain advisory input** — the keeper-demotion relay (§4.1.b) can
treat a large-FDV / thin-pool-depth discrepancy as a reason to demote,
and the widget can flag it — but that's heuristic judgment, not an
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
missed-opportunity, not a safety hole). Correcting under-counts upward
would need a *promotion* relay, which has a worse trust model than the
demotion-only relay (a compromised keeper could over-promote a junk
asset) — so if/when we want it, gate it behind the existing N-of-M
oracle quorum; or just integrate Uni-V2 + Curve on-chain, which closes
most of the gap. v1: Uni-V3-clone family only, accept the conservative
under-count.

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
2. **Keeper-fed *demotion* relay (optional, the "better approach").** A
   keeper periodically queries 0x / 1inch for the realistic slippage at
   the tier sizes ($50k/$500k/$5M) and, when the aggregator says the
   asset is *worse* than the on-chain check would conclude, pushes a
   per-asset **ceiling tier** on-chain — `s.assetTierCeiling[asset]`,
   settable only by a `KEEPER_ROLE`, **only able to lower** the tier
   (`effectiveTier = min(onChainSlippageTier(asset), assetTierCeiling[asset])`;
   default ceiling = 3 = no effect; a stale/down keeper → no ceiling →
   the on-chain check governs). This (a) corrects the on-chain
   approximation's *one* real weakness — a thin-adjacent-tick pool the
   single-tick math over-tiers — using the most accurate available data;
   (b) is fail-safe by construction — a compromised keeper can only make
   assets *more* conservative, never less, so no user funds are at risk
   from it, at worst some high-LTV loans get blocked; (c) is *not* an
   allowlist — every asset is still auto-tiered by the on-chain check;
   the keeper only ever *trims*; (d) is structurally identical to the
   secondary-price-oracle quorum (Tellor/API3/DIA) the project already
   runs, and can be put behind the same N-of-M quorum if single-keeper
   trust is a concern. Recommended as a Phase-2-or-2.5 addition;
   the on-chain check stands on its own without it.
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
- **Keeper-fed demotion (optional, §4.1.b):** `mapping(address ⇒ uint8)
  assetTierCeiling`, default `3` (no effect), settable only by
  `KEEPER_ROLE` and **only able to lower** an asset's tier; effective
  tier = `min(getLiquidityTier(asset), assetTierCeiling[asset])`. Fed by
  a keeper that queries 0x/1inch — corrects the on-chain approximation
  downward, never upward; fail-safe if the keeper is down/compromised;
  optionally behind an N-of-M quorum. Can ship after the base check.
- **Init gate (`LoanFacet._runInitGates` + `LibOfferMatch`'s synthetic
  HF check on the `matchOffers` path):** when `depthTieredLtvEnabled`,
  cap init-LTV at `min(assetRiskParams.maxLtvBps, tierMaxInitLtvBps[
  effectiveTier(collateralAsset)])` **instead of** relying purely on
  `HF ≥ 1.5`. Per-asset `liqThresholdBps` (the liquidation trigger) is
  untouched. A loan that fails the tier cap reverts `InitLtvAboveTier`.

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
2. **Piece B model — confirmed?** Permissionless: the on-chain
   simulated-swap-slippage check (§4.1) *is* the tier authority — no
   governance per-asset allowlist/tier-list; the only per-asset lever is
   the existing `pauseAsset` / blacklist (a *remove*, never an *admit*);
   governance owns only the global knobs. V3 uses the cheap virtual-
   reserve constant-product approximation (not the gas-heavy Quoter),
   accepting the large-trade-on-a-thin-adjacent-tick caveat, bounded by
   the conservative top-tier LTV + the spot≈feed + TWAP-consistency
   guards. (Trade-off acknowledged: single-hop only, so an asset like
   SHIB with deep liquidity *via* SHIB/stable pairs but a thin direct
   pool stays low-tier / manual until a multi-hop-aware check exists.)
3. **Tier LTVs**: Tier 1 50% / Tier 2 60% / Tier 3 **65%** (set
   2026-05-12; init HF ≈ 1.26 vs an ~82% liq-threshold) — confirm, or
   open Tier 3 even lower and ramp? (Risk-committee call.)
4. **Route-search scope** (§4.1): {asset/WETH, asset/USDC, asset/USDT}
   × {Uni/Sushi/Pancake V3, by availability} × fee tiers ≤ 0.3% (drops
   the 1% tier — also slightly tightens the base `Liquid` gate) — confirm.
5. **Test sizes + slippage bound**: $5 k floor / $50 k / $500 k / $5 M
   tiers at ≤2% slippage — confirm as the launch defaults, pending the
   per-chain census re-validation.
6. **Market cap as a criterion?** Recommendation: **no** on-chain gate
   (`totalSupply() × price` measures FDV not liquidity, is manipulable,
   and is redundant with the $5 k slippage floor) — use it advisory-only
   off-chain (keeper demotion relay / widget flag). Agree?
7. Fix the *base* `checkLiquidity` floor to the slippage-at-$5 k check
   now (independent of Piece B — today's `liquidity() × ethPrice` floor
   is mislabeled: "$1 M" ≈ "pool isn't empty"), or only as part of
   Piece B?
8. **Which spot-DEX families on-chain?** v1 = Uni-V3 clones only
   (current). Add Uni-V2 forks and/or Curve StableSwap (the two
   highest-value additions — V2 covers long-tail, Curve covers
   stables/LSTs)? Balancer V2 via `Vault.queryBatchSwap`? (Each is new
   audited read-math.) Note: **perps DEXs — dYdX / AsterDEX — are out**
   (perp orderbook depth ≠ spot liquidity; nothing for a liquidator to
   sell into; dYdX isn't EVM). Chain-native AMMs we *don't* integrate
   (Aerodrome/Base, Velodrome/OP, Camelot/Arb, …) → assets that live
   only there are conservatively under-tiered on-chain (fail-safe —
   0x/1inch still route there at liquidation); closing that gap = add
   more on-chain families *or* a quorum-gated promotion relay (Phase 3).
9. **Aggregator usage** (§4.1.b): (i) widget pre-check via the existing
   0x/1inch Worker proxy — yes? (recommended); (ii) the keeper-fed
   *demotion* relay (`assetTierCeiling`, keeper can only lower) — in
   Phase 2, deferred to 2.5, or skip? If yes, single keeper or behind
   the existing N-of-M oracle quorum?
10. **Cross-chain "thin here" warning** (§2.b) on Create Offer + Accept
    Offer — ship the generic version with Piece A; "which chain is
    deeper" hint is a Phase 2.5/3 follow-up (needs a cross-(asset,chain)
    depth index). OK?
11. Master kill-switch name/shape: `depthTieredLtvEnabled` in
    `ProtocolConfig`, default `false`, à la the Range-Orders flags — OK?
