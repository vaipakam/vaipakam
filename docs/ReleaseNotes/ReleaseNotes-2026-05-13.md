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

## Liquidator hardening — split-route swaps + partial liquidations

The depth-tiered-LTV work above lets governance open the borrow
ceiling higher per asset (50% / 60% / 65% by tier), which only makes
sense if the liquidation side can handle the consequence: a thinner
cushion at the moment a position falls below water. Today's session
shipped the two main pieces of that follow-up — both of which are
already on by default and don't depend on the depth-tiered-LTV
kill-switch.

### Split-route swaps

When a single decentralised-exchange venue can't absorb the full
collateral size at acceptable slippage on long-tail collateral, the
keeper can now split the swap across two routes in the same
transaction. The on-chain side is a new permissionless entry point
that takes a list of (route, amount) pairs whose amounts sum to the
loan's total collateral, runs each leg one after the other, and
checks at the end that the combined output cleared the same
oracle-derived floor a single-route liquidation would have to clear.
Any leg that reverts unwinds the whole transaction — there is
deliberately no "two-out-of-three is fine" half-settled state.

The keeper now fetches a half-size quote on every distressed loan
alongside the full-size quote it already had (the two requests run in
parallel, so per-loan latency is unchanged). When the half-size pair
on two different aggregators combined would clear a configurable
margin above the single best full-size quote (default 1%), the
keeper picks split-route; below the threshold the gas overhead isn't
worth the marginal fill improvement and it falls back to the existing
single-route try-list with its soft-fallback to the claim-time
settlement.

### Partial liquidations

The bigger of the two: when a loan is only mildly underwater, the
keeper no longer needs to swap the whole position. It can sweep just
a fraction of the collateral, apply the proceeds to the borrower's
accrued interest and principal, and leave the loan alive — at smaller
size, with the same maturity date, and with the interest clock
restarted on the reduced principal from that moment forward. The
borrower keeps the rest of their collateral and their position; the
keeper still gets paid the dynamic incentive bonus on the slice.

The on-chain entry point only operates inside the loan's term (after
maturity, late fees apply and the cleaner close-out is a full
liquidation or the time-based default route, so the partial path
deliberately stays out). The fraction is bounded by a new governance
knob: by default the keeper picks the smallest fraction that brings
the health factor back above 1.0, but governance can tighten the cap
per chain (e.g. to Aave's classic 50%) if it wants to limit how
aggressive a single partial call may be. The function will only
commit the mutation if the post-call health factor strictly improves
AND lands at or above 1.0 — any single call that would leave the
loan still liquidatable reverts, so the keeper picks a larger fraction
or falls back to full liquidation. If the proceeds would happen to
zero out all remaining principal, the call also reverts — a "full
close" by partial is undefined, the keeper retries through full
liquidation which closes the loan, refunds the borrower's surplus
collateral, and emits the terminal event. Repeated partials are
allowed; each emits a fresh non-terminal event for indexers to track.

What's deliberately unlike full liquidation: partial has no soft
fallback. If every adapter in the keeper's try-list reverts, the
whole transaction reverts and the borrower's escrow is untouched.
A still-Active loan can't be in a half-settled state without
corrupting the lender / borrower claim flow and the position-NFT
state, so the choice is "complete the partial cleanly OR change
nothing" — never a partial half-settlement. The keeper retries with
a smaller fraction, a different route mix, or full liquidation
(which DOES have the soft-fallback path) on the next tick.

### Keeper decision rule

The keeper's autonomous-liquidation pass now picks between three
paths per distressed loan in this order: if the loan is in-term AND
its health factor is in a configurable mildly-distressed band (default
the [0.95, 1.0) range) AND a half-size quote is available, submit a
50% partial liquidation; otherwise, if a half-size pair on two
different aggregators beats the full-size single best by at least the
configured improvement threshold, submit a split-route swap;
otherwise, submit the existing single-route failover liquidation.
The half-size quote is fetched only once and reused for both the
partial and the split decision, so there is no extra remote-procedure
call cost from adding the partial branch.

Why the [0.95, 1.0) heuristic: the math says a 50% partial restores
the health factor back over 1.0 with a small buffer in that band,
given typical asset risk parameters and an effective swap-fee
overhead of around 5%. Below 0.95 a 50% partial isn't enough — the
on-chain "must restore" gate would revert the transaction — so the
keeper falls back to full liquidation in that regime, no wasted gas.
A finer model (compute the smallest fraction per-loan that restores
the health factor by buffer) is the natural next step but isn't
needed for the current launch envelope; that lands when liquidator
competition or observed reverts under live operation justify the
tighter math.

### Test coverage

The validation-gate surface (every revert path BEFORE the swap) has
13 dedicated tests: every setter bound (admin gate, ≤100% ceiling,
zero-as-reset, event emission), every entry-point gate (status must
be Active, health factor must be below 1, must be in-term, fraction
must be in the bounded range), plus a positive test that the
post-mutation "health factor must strictly improve" gate fires
correctly. Three happy-path tests then exercise the full mutation
end-to-end with real (non-mocked) health-factor math: a loan whose
collateral price is dropped via the oracle mock to put it just below
water, a 50% partial sweep, and assertions that the loan stays
Active, collateral and principal both decreased, the maturity date
is preserved exactly across the mutation (including a time-warped
case so the maturity preservation is non-trivial), and the
"LoanPartiallyLiquidated" event fires with the right payload. Four
more tests cover the failure branches: the "must restore" gate (deep
distress + tiny fraction so the partial strictly improves but stays
below 1), the "full close by partial" guard (mild distress + large
fraction so proceeds would zero out all principal), the
all-adapters-failed path (empty try-list), and the multi-partial
regression (two consecutive partials with time-warps between, asserting
monotonic decrease on collateral and principal AND maturity preserved
across both calls).

The full contract test suite stays green throughout — 1785 passing,
0 failed, 5 skipped (the 5 skipped are pre-existing time-locked
ratification tests, unrelated to this work).

Still deferred to a lower-priority follow-up: sanctions-Tier-1 revert
on the partial path, sequencer-down circuit-breaker on the partial
path, and the non-liquid-collateral guard on the partial path. None
block landing — those gates are inherited from the shared sanctions
/ sequencer / liquidity check pattern that the existing full
liquidation already exercises in the same test file.
