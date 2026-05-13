# Release notes — 2026-05-13

Two threads ran today on the `feat/market-rate-widget-and-tiered-ltv`
branch: a clutch of analytics-page fixes carried over from the morning,
and then the bulk of the day — landing the **depth-tiered-LTV** contract
work ("Piece B" of the market-rate-widget / depth-tiered-LTV design),
all behind a master kill-switch that ships off so nothing changes for
users until governance decides — chain by chain, after an audit — to
turn it on.

## Analytics page — crash, blank-page, and data-gap fixes

The `/analytics` page had three separate failures: it showed a
nonsense "tens-of-millions-of-blocks behind" sync figure on chains
where the indexer cursor was actually caught up; selecting certain
chains blanked the page entirely with a minified-React error; and
several fields ("Interest earned by lenders", recent-offer amounts,
the recent-loans feed) showed zeroes or nothing, flickering between
real values and blanks when the connected chain changed.

The blank page traced to an infinite render loop in the shared
info-tip tooltip component — it was re-measuring its position on
every parent render because a render-fresh value had crept into the
dependency list of its layout effect; that dependency is dropped and
the position update is now identity-stable. An app-wide error
boundary was also added so a future render crash decodes the minified
React code, shows the failing component stack in the diagnostics
drawer, and keeps the rest of the page usable instead of taking the
whole screen down. The data gaps were because the page was leaning on
a chain-multicall stats source that the happy path now leaves
disabled; the affected fields were rewired to the indexer-backed
feeds the rest of the page already uses, and the export buttons
(CSV/JSON) were rebuilt to match.

## "Lend / Borrow at market rate" widget (Piece A) — shipped

The market-rate widget landed on the Offer Book and was deployed to
the base-sepolia testnet. It's a small panel that appears once a
borrowing pair is fully specified: you enter the lending amount, it
shows the minimum collateral you'd need (computed from the same
health-factor rule the protocol already enforces, with a small safety
buffer), shows the current market rate as a hint when one exists, and
the "Lend at market rate" / "Borrow at market rate" buttons always
deep-link you into the Create Offer page with everything pre-filled —
there is no one-click post, the button is never disabled, and you
always go through the full Create-Offer review step. For an asset
that's thin or unsupported on the connected chain the widget still
deep-links (it just can't pre-fill collateral / rate, since those
need a price the asset lacks) and Create Offer shows a cautionary
banner. A separate cross-chain "this collateral is thin here — it may
be deeper on another chain" warning was added to the Create Offer and
Accept Offer review steps.

(Still to do as polish: proper translations for the nine non-English
locales — they currently fall back to English — and an optional
realistic-slippage pre-check inside the widget using the existing
aggregator-quote proxy.)

## Matcher pass ported into the keeper Worker

The off-chain offer-matcher (which pairs compatible range orders and
submits the on-chain match) was ported from the public reference bot
into the production `apps/keeper` Cloudflare Worker as a third pass in
its scheduled run, alongside the existing liquidation watcher and the
daily oracle snapshot. It is wired up but not yet deployed — pushing a
Worker that signs transactions, and turning on its enable flag, is a
deliberate step that goes with the testnet bake.

## On-chain liquidity check — the depth metric is now a real figure

The protocol's "is this asset liquid?" gate used to score a pool by
multiplying its concentrated-liquidity number by the ETH price — a
quantity whose magnitude is dominated by the paired token's decimals
and unit price, not its real depth, so the "$1M" threshold it was
compared against was effectively just "the pool isn't empty". That
metric is now a genuine value-of-the-tradeable-depth figure (the
value of the pool's WETH side at the current price, doubled, in the
chain's reference currency). The threshold constant was renamed from
`MIN_LIQUIDITY_USD` to `MIN_LIQUIDITY_PAD` to reflect that the
reference currency is governance-configurable ("PAD" — the
Predominantly Available Denominator — which is the US dollar on the
retail deploy and whatever a fork's governance has rotated it to
otherwise); the value is unchanged. The full intended change — making
even the binary liquid/illiquid gate a "could a liquidator sell $5k of
this at ≤ 2% slippage" check — is a follow-up.

## Depth-tiered LTV (Piece B) — contracts landed, dormant

Today the platform's collateral all gets roughly the same conservative
borrow ceiling (about 53% of the collateral's value) regardless of how
deep its market is. Piece B lets demonstrably-liquid "blue-chip"
collateral support a higher ceiling — 50% / 60% / 65% across three
liquidity tiers — graded by an on-chain measurement, with every cut-off
and per-tier ceiling a governance knob. None of it changes anything
yet: a master "depth-tiered LTV enabled" switch ships off, and while
it's off the loan-initiation gate is exactly today's behaviour.

What landed:

- **A pure slippage library.** A small, side-effect-free piece of
  arithmetic that answers "if someone sold $X of this asset against
  this pool right now, how far below the market price would they net?"
  — the question liquidation actually cares about. It works on
  Uniswap-V2-style pools exactly and on Uniswap-V3-style pools via a
  cheap approximation (the pool's notional reserves at the current
  price), deliberately *not* the gas-heavy exact tick-walking quoter —
  that exact answer is reserved for the off-chain keeper to compute.
  The metric is decimal-independent, so a stablecoin pair correctly
  scores as deep rather than (as the old metric would have it) thin or
  bottomless.

- **An on-chain liquidity-tier view.** The oracle now exposes "what
  tier is this asset?" (0 = illiquid / untierable, else 1-3) and "what
  tier *effectively* applies?" The tier is derived by simulating sells
  of progressively larger sizes ($5k / $50k / $500k / $5M by default)
  against the best route it can find over a configurable set of
  "predominantly available" quote tokens (WETH plus the chain's deep
  stablecoins) and the low-fee Uniswap-V3-clone pools, with two
  anti-manipulation guards: the pool's price must agree with the trusted
  Chainlink feed, and (when the pool's on-chain price history is
  available) its recent average price must agree with its current
  price. This view *is* the tier authority — there is deliberately no
  governance per-asset allowlist; the only per-asset lever stays the
  existing pause/blacklist, which is remove-only.

- **A keeper "liquidity-confidence" floor.** The *effective* tier is the
  smaller of the on-chain tier and a per-asset value an off-chain keeper
  can set (defaulting to tier 1). So a brand-new asset opens at today's
  conservative ceiling no matter what the on-chain check reads; the
  keeper promotes it one step only after its own aggregator-based checks
  have stayed healthy for a while, and demotes it immediately on
  degradation. A compromised keeper can only ever *lower* a tier, never
  raise one above what the on-chain check has already vetted. A new
  keeper role was added for this; the keeper *process* itself is a
  later step.

- **Governance knobs.** Setters for the slippage budget, the
  price-history-agreement window and band, the four test sizes, the
  three per-tier ceilings, and the predominantly-available-assets list
  — all bounded so a fat-fingered or hostile vote can't push a value to
  a degenerate setting, and all defaulting to sensible library
  constants — plus the keeper-tier setter and a frontend-facing bundle
  getter.

- **The init-gate change.** When (and only when) the master switch is
  on, a new loan's borrow-to-value is capped at the smaller of the
  asset's existing ceiling and the per-tier ceiling for the
  collateral's effective tier (a tier-0 collateral ⇒ no borrow), and
  the health-factor floor is relaxed from 1.5 to 1.0 — because the tier
  ceiling, sitting well below the liquidation threshold, is now the
  binding safety buffer. A loan that would exceed the tier ceiling
  reverts with a clear new error.

The test suite was extended with a unit suite for the slippage library
and a 24-case suite for the tier resolution, the manipulation guard,
the effective-tier floor, and every governance-knob bound. The full
contract test suite stays green throughout.

Still to do before the switch is flipped on any chain (an audit covers
all of it): a loan-initiation integration test for the
switch-on branch; adding the Uniswap-V2-fork family to the route
search; bringing the bot-facing match preview and the
preclose/refinance health-factor re-checks in line with the new tier
ceiling; the off-chain keeper liquidity-confidence relay process
(which, before promoting an asset to the top tier, also checks whether
it's listed as collateral with meaningful supply on at least one of
Aave / Compound / Morpho on that chain — a "battle-tested elsewhere"
advisory, not a parameter source); the frontend wiring to read the new
config bundle; and — tracked separately — hardening the liquidation
keeper bot for the thinner cushion a higher borrow ceiling implies,
which gates the top tier ramping past its conservative opening value.
