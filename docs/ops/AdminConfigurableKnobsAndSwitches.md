# Protocol-Configurable Knobs and Switches

Functional reference for every governance-tunable parameter in the
Vaipakam Diamond. Audience: protocol auditors, governance signers, ops.

This document is **prose-only** — no Solidity, no selector signatures,
no addresses. The intent is to surface the policy each knob enforces,
the operational range it can move within, and what would happen if a
compromised admin or governance multisig pushed it to either extreme.
For the on-chain wiring, cross-reference `contracts/src/facets/*` and
the constants in `contracts/src/libraries/LibVaipakam.sol`.

---

## How range guards protect the protocol

Every governance-tunable numeric parameter on the Diamond is bounded
by a compiled-in `[min, max]` window. The setter rejects any write
outside the window with a structured `ParameterOutOfRange(name, value,
min, max)` revert. The point of the guard is **defense against admin
or governance compromise** — even if a multisig is taken over, the
attacker cannot push the parameter to a degenerate value (zero
on a load-bearing constant, infinity on a freshness budget, etc.)
without first deploying a contract upgrade. Upgrades themselves go
through a separate timelocked path with its own multisig requirement.

The guards are **policy-encoded, not pure validation**. Each window is
chosen so the values inside it are credible operational settings;
values outside represent either operator error (typo, pasting wrong
denomination) or hostile intent. Either case warrants a hard revert
rather than acceptance.

A knob defaulting to "library default" (often signalled by a stored
`0`) is fine and intended. The fallback values live alongside the
range constants in the library; reading the `getX()` view always
returns the _effective_ value (default OR stored, whichever applies).

---

## Fees and protocol economics

### Treasury fee on lender interest

Default 1% of accrued lender
interest goes to treasury. Range: 0% – `MAX_FEE_BPS` (the cap is
defined alongside the setter; conventionally 10% to leave headroom
for protocol-fee experiments without ever crossing into "majority of
interest goes to treasury" territory). Zero is a valid setting — it
turns the cut off entirely.

### Loan-initiation fee

Default 0.1% of principal, paid by the
borrower in VPFI at loan start. Range matches the treasury fee cap.
Time-weighted VPFI tier discounts can take the borrower's effective
fee to zero — the setter cap is on the gross rate.

### LIF matcher kickback

Out of the loan-initiation fee VPFI, the
matcher (the bot or wallet that called `matchOffers`) takes 1% of
the treasury slice as a kickback. Range: 0% – `MAX_FEE_BPS`. Zero
disables the kickback entirely; useful if matcher economics need to
shift.

### VPFI tier discount thresholds + tier discount BPS

(4 values
each). Configures the time-weighted VPFI staking tier system that
discounts the loan-initiation fee. Thresholds must be strictly
monotonic; discount BPS each ≤ `MAX_DISCOUNT_BPS` and
non-decreasing across tiers. Setter rejects non-monotone or
above-cap writes.

### Liquidation handling fee + max slippage + max liquidator incentive

(3 values, set together via `setLiquidationConfig`). Each
bounded by its own `MAX_*_BPS` cap. The `liqBonusBps` per asset (set
via `updateRiskParams`) cannot exceed the chain-level
`maxLiquidatorIncentiveBps` — the latter is the hard ceiling.

### Graduated partial-liquidation sizing (#395)

(3 values, set together via `AdminFacet.setPartialLiquidationSizing` —
hosted on `AdminFacet` rather than `ConfigFacet` because the latter is at
the EIP-170 ceiling, same as the #633 kill-switches). These bound how much
collateral a single *intentional* partial liquidation
(`RiskFacet.triggerPartialLiquidation`) may sell, so a routine partial sizes
itself to "as much as needed" and can't over-liquidate the borrower. Each
parameter accepts `0` to reset to its library default, and any non-zero
value is range-checked, so the reads are trusted unconditionally.

- **`partialLiqTargetHfCeilingBps`** — the upper health-factor a *routine*
  partial may leave the borrower at, in BPS of `HF_SCALE` (default `12_000`
  = HF 1.20). A partial that lands the borrower above this — i.e. it sold
  more than needed — reverts `PartialOverLiquidates`, unless an escalation
  case below applies. Bounded `[10_500, 15_000]` (HF 1.05–1.50) so it always
  sits strictly above the HF-1.00 restore floor.
- **`partialLiqDeepUnderwaterHfBps`** — the health factor at/below which the
  ceiling is **waived** so a keeper may delever aggressively to restore
  solvency, in BPS of `HF_SCALE` (default `9_500` = HF 0.95). Bounded
  `[8_000, 9_900]` (HF 0.80–0.99), always strictly below the restore floor.
- **`liquidationDustFloorNumeraire`** — governs dust handling. **Default `0`
  = DISABLED** (there is no universally-correct default because the active
  oracle numeraire can be rotated away from USD, so a hard-coded value would
  mis-classify ordinary loans as dust on a non-USD deployment — governance
  sets an explicit floor *in the active numeraire* to switch it on). When set
  (`> 0`) it does two things: (1) **waives** the over-liquidation ceiling for
  a position that was **already** dust-sized at entry (its pre-partial debt OR
  collateral below the floor) so a genuinely-tiny loan isn't blocked from
  clearing — keyed on *entry* size, not the manufacturable residual, so a
  keeper can't self-waive by over-liquidating; and (2) **prevents** a routine
  partial from leaving a *fresh* dust position out of a non-dust loan (both
  residual debt AND collateral below the floor) — that reverts
  `PartialLeavesDust` and the keeper must use full liquidation. **Units:
  whole-numeraire**, the same
  scale `RiskFacet._computeNumeraireValues` returns (whole-USD with standard
  8-decimal feeds — `$1k == 1_000`, NOT `1e18`-scaled). Capped at `100_000`
  ($100k) so a misconfigured floor can't turn every routine partial into a
  full close. **Setting a nonzero floor both widens (the pre-existing-dust
  waiver) AND narrows (the leave-fresh-dust prevention) what a keeper may do —
  it is not a harmless one-way knob — and `0` is the explicit disable path.**
  Plan for keeper partials to start reverting `PartialLeavesDust` (and require
  full liquidation) on small loans once a floor is set.

The over-liquidation **ceiling** and **deep-underwater** thresholds default to
sensible values and are active on a fresh deploy with no operator action; the
**dust floor defaults to `0` (disabled)** and is opt-in (set it in the active
numeraire to switch dust handling on). The whole guardrail governs only *how
much* collateral a partial sells (via HF/value bounds) — never how the loan is
priced — and leaves full liquidation (`triggerLiquidation`) unchanged as the
alternative.

### Quote-time interest-rate model (#400)

(`AdminFacet.setRateModel(address)` / `getRateModel()`.) The active
`IRateModel` — a pluggable, view-only quote function used for **rate
guidance + automated/delegated pricing**, NOT to override human-typed offer
rates. **Default `address(0)` = the IDENTITY model: the user-supplied rate
stands, today's behaviour, zero-config.** Vaipakam's market rate is set by the
human P2P order book (price discovery); registering a model never rewrites a
manually-created offer — it is consulted only by the dApp (as a suggestion)
and by automated flows (auto-lend / auto-roll / keeper-posted intents, #393;
risk premiums, #394) that price the offers they post on a user's behalf.

- **Enable-slow / disable-fast asymmetry.** REGISTERING / changing a model
  (`setRateModel`, non-zero, risk-increasing) is ADMIN → governance **timelock**
  after handover. DISABLING it (`disableRateModel()` → identity) is the fast
  risk-decreasing path: callable by **WATCHER_ROLE** (the constrained
  fast-incident key, like `autoPause`) *or* ADMIN, so a misbehaving model is
  killed instantly without waiting on the enable-side timelock. `setRateModel`
  rejects `address(0)` (`UseDisableRateModel`) — disabling always goes through
  the fast path. A non-zero model must be a contract (`RateModelNotContract`
  on an EOA).
- **On-chain deviation cap (anti-rate-setting guarantee).**
  `setRateModelMaxDeviationBps(uint16)` / `getRateModelMaxDeviationBps()` —
  default `500` (5%), range `[50, 2500]` (0.5%–25%). The resolver **clamps**
  the model's output to `±maxDeviation` of the caller's reference (market)
  rate, so a registered model — even buggy or adversarial — can only nudge the
  rate around the market anchor, never drive an automated offer far off-market
  (instant-loss-fill if too low, idle capital if too high). This is enforced in
  the substrate (`OfferCreateFacet.quoteOfferRateBps`) so every consumer
  inherits it, not trusted to each caller.
- **E2-safe.** A model only ever sets the value written into a *new* offer; a
  matched / live loan's rate is snapshotted immutably at init and never
  re-priced.
- **Consumers still market-anchor.** The clamp bounds deviation from whatever
  reference is supplied, so automated callers (#393/#394) must still pass the
  **live cleared-market rate** as the reference (the clamp then bounds drift
  from the real market). The registry itself never auto-posts.

### Swap-to-Repay max slippage (T-090)

(`setMaxSwapToRepaySlippageBps` / `getMaxSwapToRepaySlippageBps`)

Caps the slippage a borrower-initiated swap-to-repay transaction
may realize. Sibling to `maxLiquidationSlippageBps` with a tighter
default (300 bps / 3% vs. 600 bps / 6%) because the borrower picks
the moment and is not on an adversarial clock. Bounded by the same
protocol-wide `MAX_SLIPPAGE_BPS` ceiling (2500 bps / 25%) as the
liquidation knob. Storage-zero fallback returns the 300-bps default
until governance explicitly tunes, so no post-deploy operator action
is required on a fresh deploy.

### Risk config — volatility-LTV threshold + rental buffer

`volatilityLtvThresholdBps` must be > `BASIS_POINTS` (i.e. > 100%) —
it's a "collapse the position when LTV exceeds this" guard, must be
above the normal liquidation threshold to be meaningful. `rentalBufferBps`
≤ `MAX_FEE_BPS`.

### Loan-default grace buckets

(`setGraceBuckets` / `clearGraceBuckets` / `getGraceBuckets` /
`getEffectiveGraceSeconds` / `getGraceSlotBounds` — T-044)

The window between a loan's `endTime` and the moment the loan
becomes default-able is duration-tiered. Short loans get short grace;
long loans get longer grace. The schedule is a **fixed 6-slot
positional table** — admin can edit the values inside each slot but
cannot add or remove rows.

Default schedule (also the compile-time fallback when no override is
configured):

| Slot | Bucket label | Default `maxDurationDays` | Default `graceSeconds` |
| ---- | ------------ | ------------------------- | ---------------------- |
| 0    | < 7 days     | 7                         | 1 hour                 |
| 1    | < 30 days    | 30                        | 1 day                  |
| 2    | < 90 days    | 90                        | 3 days                 |
| 3    | < 180 days   | 180                       | 1 week                 |
| 4    | < 365 days   | 365                       | 2 weeks                |
| 5    | catch-all    | 0 (marker)                | 30 days                |

Per-slot bounds (the admin console exposes these via `getGraceSlotBounds`
and renders them inline next to each editable row):

| Slot | `maxDurationDays` window | `graceSeconds` window |
| ---- | ------------------------ | --------------------- |
| 0    | [1, 14]                  | [1 hour, 5 days]      |
| 1    | [7, 60]                  | [1 hour, 15 days]     |
| 2    | [30, 180]                | [1 day, 30 days]      |
| 3    | [90, 270]                | [3 days, 45 days]     |
| 4    | [180, 540]               | [7 days, 60 days]     |
| 5    | (must be 0)              | [14 days, 90 days]    |

Plus two absolute global bounds applied to every slot as a defence-
in-depth check:

- `GRACE_SECONDS_MIN = 1 hour` — below this, TZ tolerance / RPC lag
  could fire false defaults.
- `GRACE_SECONDS_MAX = 90 days` — above this, the lender's
  principal is effectively locked indefinitely past the loan
  end-date.

Setter validation:

- The schedule must contain exactly 6 entries.
- For slots 0-4: `maxDurationDays` lies inside the slot's window
  AND is strictly greater than the previous slot's value
  (monotonic). `graceSeconds` lies inside the slot's window AND
  inside the global floor / ceiling.
- For slot 5: `maxDurationDays == 0` (catch-all marker enforced).
  `graceSeconds` lies inside the slot's window.
- Any violation reverts with `ParameterOutOfRange` (per-slot
  bounds) or `GraceBucketsInvalid` (shape errors —
  `wrong-count` / `catchall-not-zero` / `not-monotonic`).

`clearGraceBuckets` reverts the storage to empty; the contract
falls back to the compile-time defaults above. Useful as an
emergency rollback if a bad schedule was pushed by mistake.

### Per-asset risk parameters

(`updateRiskParams`):

- `maxLtvBps`: range **[10%, 100%]**. The 10% floor prevents a
  compromised admin from setting a degenerate `maxLtv = 1` that
  effectively disables borrowing for that asset.
- `liqThresholdBps`: range **[15%, 100%]**, must also be `> maxLtvBps`.
  The 15% absolute floor prevents misconfigs even if `maxLtvBps` is
  set near its own floor.
- `liqBonusBps`: ≤ `cfgMaxLiquidatorIncentiveBps()` (chain-level cap).
- `reserveFactorBps`: range **[0%, 50%]**. The 50% ceiling prevents a
  compromised admin from setting `reserveFactor = 100%` (lender
  receives 0% interest, defeats the lending product).

### Staking APR

Range **[0%, 20%]**. APRs above 20% on VPFI staking
are unrealistic and a higher cap is a governance-error vector rather
than a feature. Zero permitted (disables rewards while preserving
staked principal accounting).

### Notification fee (per loan-side)

Per-loan-side notification fee charged in VPFI at the first paid-tier
notification. Stored in **numeraire-units** (1e18-scaled — interpreted
as USD when `numeraireSymbol == bytes32(0)`, the post-deploy default).
Range: `[MIN_NOTIFICATION_FEE_FLOOR, MAX_NOTIFICATION_FEE_CEIL]` —
0.1 to 50.0 numeraire-units (= $0.10 to $50 under USD-as-numeraire).
Zero means "use library default" (2.0 numeraire-units = $2). Setter:
`setNotificationFee(uint256)`. Governance-tunable so a market shift
in Push Protocol fees can be passed through without redeploy.

> **Numeraire generalization (2026-05-03).** The retired per-knob
> `notificationFeeUsdOracle` slot was removed from
> `ProtocolConfig`. The notification fee's denomination now flows
> through `OracleFacet.getAssetPrice(WETH)` which returns the
> numeraire-quoted ETH price natively after generalizing the
> numeraire to the oracle layer (B1) — single
> source of truth across the protocol. To change the notification
> fee's reference currency, governance rotates the numeraire via
> the atomic `setNumeraire` setter (under "Periodic Interest Payment"
> below); the per-knob setter only re-tunes within the same
> numeraire.

## Order matching and durations

### Max offer duration days

Range: `[MIN_OFFER_DURATION_DAYS_FLOOR,
MAX_OFFER_DURATION_DAYS_CEIL]` (currently 1 to 365). Zero means use
library default.

### Auto-pause duration seconds

Range: `[MIN_AUTO_PAUSE_SECONDS,
MAX_AUTO_PAUSE_SECONDS]` (currently bounded so a misfire can't
disable the safety net or set an indefinite freeze ceiling). Zero
means use library default.

## Oracle stack

### Secondary-oracle max deviation BPS

(Tellor / API3 / DIA quorum
agreement window vs Chainlink primary). Range **[1%, 20%]**. Tighter
than 1% would fail-close on legitimate cross-oracle drift in fast
markets and DoS the protocol; looser than 20% effectively disables
the divergence check (a 20%+ drift between independent oracles is
already "one of them is compromised" no matter how charitable the
variance assumption). Default is 5%.

### Secondary-oracle max staleness seconds

Range **[1 min, 29 h]**.
The 29h ceiling sits 5 hours above the 24h heartbeat that some
stablecoin price feeds (USDC, USDT) publish on — tightening below
24h would soft-skip those legitimate-but-slow feeds on every update.
Default is 1 hour.

### Pyth oracle address

(T-033 cross-check oracle, single feed per
chain — ETH/<numeraire> on the active deploy; rotates with the
numeraire when governance switches). Address-only; no numeric range.
Zero disables the cross-check gate globally — the protocol falls
back to Chainlink-only on the WETH/numeraire leg.

> **Naming note (Generalizing Numeraire — B1)**: This Pyth oracle implements the
> cross-oracle DIVERGENCE check between Chainlink and Pyth on the
> protocol's ETH-base reference. Distinct from T-034's "numeraire"
> concept (the protocol's reference currency). The slot was renamed
> from `pythNumeraireFeedId` → `pythCrossCheckFeedId` to remove the
> overload.

### Pyth cross-check feed id (pythCrossCheckFeedId)

Single 32-byte Pyth price feed identifier — Pyth's ETH/<numeraire>
peg ID for cross-validating the Chainlink ETH/<numeraire> reading.
Zero disables at the feed-id layer (same soft-skip semantics as a
zero `pythOracle`). Governance updates this together with
`ethNumeraireFeed` whenever the numeraire rotates (atomic
`setNumeraire` setter takes both as args).

### Pyth max staleness seconds

Range **[1 min, 1 h]**. Tighter and a
transient mempool jam soft-skips Pyth too often; looser and a
stale-but-manipulated reading could drive the divergence outcome.
Default is 5 minutes.

### Pyth cross-check max deviation BPS (pythCrossCheckMaxDeviationBps)

Range **[1%, 20%]**. Tolerated divergence between Chainlink
ETH/<numeraire> and Pyth ETH/<numeraire> before the price view
fails-closed with `OracleCrossCheckDivergence`. Same 1%-20% window as
the secondary-oracle deviation. Default is 5%.

### Pyth confidence max BPS

(`conf / price` ceiling). Range **[0.5%,
5%]**. Tighter and Pyth gets soft-skipped too often during fast
markets; looser and the "Pyth said X" claim becomes too uncertain to
be a useful cross-check. Default is 1%.

### Per-asset Chainlink feed override

(staleness + minimum valid
answer). Per-feed override of the chain's default feed-staleness
budget. Useful for a feed that the operator knows publishes at a
different cadence than the chain default. The override pair is set
together; either field non-zero replaces the chain default for that
feed.

### Stable-token feed override

Per-symbol override that pins a
specific Chainlink feed to a token's symbol; used when the Feed
Registry doesn't have an entry. Address-only.

### Sequencer uptime feed

Address of the chain's L2 sequencer
uptime feed (Arbitrum, Optimism). Zero means "no sequencer-down
guard" — appropriate on L1s but a misconfig on L2s. Address-only.

### Chainlink Feed Registry / USD denominator / ETH denominator / WETH contract / ETH-USD feed / Uniswap V3 factory

All address-only
configs that wire the chain-specific oracle stack. No numeric range;
zero disables the corresponding flow.

## Reward subsystem (cross-chain interest aggregation)

### Reward grace seconds

(T-031 Layer 4a-adjacent — different lane,
same governance pattern). After day `D` closes, this is how long
`finalizeDay(D)` may be called even if not every expected mirror has
reported. Range **[5 min, 30 days]**. The 5min floor prevents a
transient outage from being confused with real grace; the 30-day
ceiling prevents the window from being set to "indefinite" (defeats
the purpose). Default is 4 hours.

### Reward OApp / local eid / base eid / canonical reward chain flag

Address + integer + bool fields configuring the cross-chain
reward reporter. Eid values are LayerZero V2 endpoint ids (40000s
testnet, 30000s mainnet); no numeric range beyond "a known eid".
Setter accepts and emits.

### Interaction-rewards launch timestamp

One-time-set; further
writes revert. Range: must be > 0 (cannot un-set). Effectively a
deploy-day knob.

### Interaction-rewards cap (VPFI per ETH)

Range **[1, 1,000,000]**
whole-VPFI-per-whole-ETH (NOT 1e18-scaled). Two intentional
sentinels: `0` resets to library default at read time;
`type(uint256).max` is the emergency "disable cap" knob. The bounded
window applies only to non-sentinel values. The sentinels are
preserved as documented escape paths but are themselves a
governance-trust point — a compromised admin flipping to the
disable-cap sentinel is something the policy explicitly tolerates as
an emergency lever.

## KYC (industrial-fork only — OFF on retail)

### KYC tier 0 / tier 1 thresholds (numeraire)

Range each: **[100, 1,000,000]** in 1e18-scaled numeraire-units —
which, under the post-deploy default (`numeraireSymbol` empty,
`ethNumeraireFeed` pointing at Chainlink ETH/USD), is read as USD
($100 to $1M). Tier 0 must be < tier 1.

> KYC is **OFF on the retail deploy** per CLAUDE.md — the
> `kycEnforcementEnabled` flag stays `false` post-deploy; the
> threshold values aren't read. These bounds are
> belt-and-suspenders for the retail deploy and load-bearing for
> the industrial fork.

> **Generalizing Numeraire — B1 (2026-05-03).** The thresholds are stored in
> numeraire-units (storage fields `kycTier0ThresholdNumeraire` /
> `kycTier1ThresholdNumeraire`). After B1, both the threshold AND
> the asset value are in numeraire-units (`getAssetPrice` returns
> numeraire-quoted natively from the rotated Chainlink feeds), so
> the comparison sites (`OfferFacet`, `RiskFacet`,
> `DefaultedFacet`) compare numeraire-vs-numeraire — no boundary
> conversion. To rotate the reference currency, governance uses the
> atomic multi-arg `setNumeraire` (under "Periodic Interest Payment"
> below) which re-anchors every feed-side slot AND every
> numeraire-denominated value in the same tx; the per-knob
> `updateKYCThresholds` setter only re-tunes within the same
> numeraire.

## Range Orders Phase 1 (master kill switches — bool flags)

### Range Orders kill-switch flags (rangeAmountEnabled, rangeRateEnabled, partialFillEnabled)

All three default `false` post-deploy. Governance flips each on once
the corresponding mechanic is ready to ship. No range bound (bool).
Each flip emits a config event so off-chain monitoring can correlate
behavior changes to the governance action.

## Liquidator-buys-at-discount path (FlashLoanLiquidationPath.md)

The optional Aave-V3 / Compound-V3 / Morpho-Blue-style liquidation
path: liquidator pays the full outstanding debt in the principal
asset, protocol seizes the borrower's collateral at a per-tier
discount and delivers it to a liquidator-supplied recipient (typically
funded via a same-tx flash-loan from Aave V3 `flashLoanSimple` or
Balancer V2 `flashLoan`). See
[`FlashLoanLiquidatorRollout.md`](FlashLoanLiquidatorRollout.md) for
the per-chain operational rollout.

### Master kill-switch — `discountPathEnabled`

`ProtocolConfig.discountPathEnabled` (bool, default `false`).
`RiskFacet.triggerLiquidationDiscounted` reverts
`DiscountPathDisabled` immediately while the flag is off, so a fresh
deploy never exposes the path before the per-chain audit + risk-
committee sign-off. Independent of `depthTieredLtvEnabled` —
governance can flip each one per chain (e.g. enable the discount
path on Base while autonomous-LTV still bakes on Polygon).
ADMIN_ROLE pre-handover; TimelockController-gated (48h) post-handover.
Setter: `ConfigFacet.setDiscountPathEnabled(bool)`.

### Per-tier liquidator discount (BPS)

Three values, set atomically via
`ConfigFacet.setTierLiqDiscountBps(tier1Bps, tier2Bps, tier3Bps)`.
Each tier slot in storage is `0 ⇒ TIER{N}_LIQ_DISCOUNT_DEFAULT_BPS`
(library constant). Defaults: T1 770 (7.7%) / T2 600 (6.0%) /
T3 500 (5.0%) — thinner tier carries wider discount because
liquidator slippage risk is higher on thin order books, so the
incentive to attract competing liquidators must be larger.

Per-tier bounds enforced at the setter:

| Tier | Floor (BPS) | Ceiling (BPS) | Library default |
|---|---|---|---|
| Tier 1 (thinnest) | 300 (3.0%) | 1500 (15.0%) | 770 (7.7%) |
| Tier 2 | 300 (3.0%) | 1000 (10.0%) | 600 (6.0%) |
| Tier 3 (deepest) | 200 (2.0%) | 800 (8.0%) | 500 (5.0%) |

Cross-tier monotonic invariant `T1 ≥ T2 ≥ T3` enforced atomically
across all three slots, including the subtle zero-fallback path
(passing `0` for a tier falls through to its library default, which
participates in the monotonic check against the other two tiers'
effective values). A hostile-governance attack cannot push the
discount to a degenerate value (0% would starve the liquidator
market; 50% would gut borrower surplus) — the per-tier ceilings
bound the worst case at 15% / 10% / 8%.

The 1% kickback / matcher-fee story (Range Orders LIF) is
unrelated to this discount; the discount is paid to the liquidator
in collateral at settle time, not from any treasury or LIF pool.

## Periodic Interest Payment (T-034)

The Periodic Interest Payment mechanic lets a lender opt their loans
into mandatory mid-loan interest checkpoints. The borrower must pay
each period's accrued interest by the period close; if they miss the
period beyond the grace window, anyone can call a permissionless
settler that sells just enough collateral to cover the shortfall (or
just-stamps the period when the borrower paid in time). Multi-year
loans (`durationDays > 365`) carry a mandatory annual floor — even
small-principal multi-year loans must settle interest yearly.

The feature ships dormant on every fresh deploy. Five governance
levers control its visibility and behavior; each is bounded the same
way every other knob in this document is.

### Periodic interest enabled flag (periodicInterestEnabled)

Master kill-switch for the entire mechanic. Default `false`
post-deploy. While off:

- `OfferFacet.createOffer` rejects any cadence other than `None`
  with `PeriodicInterestDisabled`.
- `RepayFacet.settlePeriodicInterest` reverts wholesale.
- `RepayFacet.repayPartial` skips the interest-first checkpoint
  accounting fold — today's allocation behavior is preserved.
- The frontend hides every cadence-related UI surface
  (CreateOffer dropdown, AcceptOffer acknowledgement callout,
  LoanDetails countdown card).

Governance flips this on once the rest of the protocol is ready to
honor cadence-bearing loans on-chain. Boolean — no range.

### Numeraire swap enabled flag (numeraireSwapEnabled)

Independent kill-switch gating the atomic `setNumeraire` rotation
setter. Default `false`. While off, governance cannot rotate the
numeraire away from the USD-as-default behavior — the protocol ships
USD-denominated until this flag flips AND governance has all the
numeraire-side feed addresses on hand. Threshold-only updates within
the same numeraire (`setMinPrincipalForFinerCadence`,
`setNotificationFee`, `updateKYCThresholds`) are NOT gated by this
flag — governance can re-tune individual values freely. Boolean — no
range.

### Numeraire-rotation surface — Generalizing Numeraire (B1)

After Generalizing Numeraire to the oracle layer (B1, 2026-05-03), the
protocol's reference currency
is captured by **four feed-side slots** + **four numeraire-denominated
value knobs**. The per-knob `INumeraireOracle` boundary-conversion
oracle was retired — `OracleFacet.getAssetPrice` now returns
numeraire-quoted prices natively, sourced from the renamed feed
slots. Comparison sites compare numeraire-vs-numeraire with no
intermediate USD detour.

**Feed-side slots** (drive `OracleFacet.getAssetPrice` paths 1/2/3

- Tellor / API3 / DIA query construction + Pyth cross-check):
  - `s.ethNumeraireFeed` — Chainlink AggregatorV3 returning ETH/<numeraire>
    price. ETH/USD on USD-as-numeraire deploys; rotates to ETH/EUR /
    ETH/XAU / etc. when the numeraire changes.
  - `s.numeraireChainlinkDenominator` — Chainlink Feed Registry
    constant for the active numeraire. `Denominations.USD` by default;
    `Denominations.EUR` / etc. on rotation. Drives Path 2 of
    `_primaryPrice` (direct asset/<numeraire> registry lookup).
  - `s.numeraireSymbol` — `bytes32` lowercase ASCII symbol of the
    active numeraire (e.g. `bytes32("eur")`). Empty default is
    interpreted as `"usd"` so the post-deploy behaviour is unchanged
    out of the box. Drives Tellor / API3 / DIA query construction
    (`<symbol>/<numeraireSymbol>`).
  - `s.pythCrossCheckFeedId` — Pyth ETH/<numeraire> feed id for the
    T-033 cross-check gate (see "Pyth cross-check feed id" above).

**Value-side knobs** (each per-knob bounded; settable individually
within the same numeraire OR atomically as part of `setNumeraire`):

- `minPrincipalForFinerCadence` (numeraire-units, 1e18-scaled)
- `notificationFee` (numeraire-units)
- `kycTier0ThresholdNumeraire` + `kycTier1ThresholdNumeraire`

**Atomic rotation setter** —
`setNumeraire(ethNumeraireFeed, numeraireChainlinkDenominator,
numeraireSymbol, pythCrossCheckFeedId, threshold, notificationFee,
kycTier0, kycTier1)`. Eight args, single Safe transaction. By
construction governance cannot rotate the numeraire without
simultaneously re-anchoring every value denominated in it AND every
oracle-side input that produces numeraire-quoted prices.

Inconsistent intermediate state ("numeraire = EUR but notification
fee still in USD-units" or "Tellor still queries `<symbol>/usd`") is
unreachable.

Each numeraire-denominated value carries its per-knob bounded
validator. KYC tier monotonicity is enforced when both tier values
come in non-zero. The three feed-side inputs (`ethNumeraireFeed`,
`numeraireChainlinkDenominator`, `numeraireSymbol`) reject zero —
they're load-bearing and missing them would brick `_primaryPrice` /
secondary queries. `pythCrossCheckFeedId` accepts zero (disables the
Pyth gate).

Per-knob within-the-same-numeraire updates remain available:
`setMinPrincipalForFinerCadence(uint256)`, `setNotificationFee(uint256)`,
`updateKYCThresholds(uint256, uint256)`. Use these when governance
just wants to tune a value within the active currency, not rotate.

> **PredominantlyAvailableDenominator (T-047, planned)**: secondary
> oracle coverage in non-USD numeraires (Tellor / API3 / DIA) is
> sparse — the cross-validation property weakens after a non-USD
> rotation. The T-048 follow-up below ships the
> `predominantDenominator` (PAD = USD by default) so primary
> pricing routes through Chainlink's universally-🟢-rated USD feed
> set when the active numeraire is non-USD; the secondary-oracle
> quorum follow-up still tracks separately under T-047 for the
> divergence-detection layer.

### Predominantly Available Denominator (PAD)

Anchor for **primary pricing** when the active numeraire is non-USD.
PAD is a Chainlink Feed Registry denomination constant
(`Denominations.USD` by post-deploy default — the universally-
covered, near-100%-🟢-verified-rated denomination across every
chain Vaipakam supports). `OracleFacet._primaryPrice` queries
`asset/PAD` first and converts to the active numeraire only when
PAD ≠ numeraire.

**Why PAD-first instead of asset/<numeraire>-first**: Chainlink's
feed-rating metadata (🟢 verified / 🟡 monitored / 🔴 specialized)
is **off-chain**. A direct asset/<numeraire> Chainlink feed for
non-USD pairs is rare AND frequently 🟡-rated when it exists,
with looser deviation thresholds and slower heartbeats than the
🟢 USD equivalents. Routing all pricing through PAD biases toward
verified-rated feeds **structurally**, without requiring operators
to manually curate per-asset feed quality. The FX-multiply cost
(one extra Chainlink read for PAD/<numeraire>) is bounded; the
trust gain from never accidentally pricing through a 🟡 feed is
real.

**Per-asset opt-in override**: when an operator explicitly verifies
a specific asset/<numeraire> feed is 🟢-rated on their chain, they
can call `setAssetNumeraireDirectFeedOverride(asset, feed)` and
that asset's pricing skips the PAD pivot entirely. Operator vouches
for the feed quality; the protocol does not cross-check overrides
against Pyth.

**Four feed-side slots, atomic rotation via `setPredominantDenominator(denom, symbol, ethPadFeed, padNumeraireRateFeed)`**:

- **`predominantDenominator`** (address) — Chainlink Feed Registry
  denomination constant. `Denominations.USD` (`0x0000…0000348`)
  post-deploy default. Reverts `ParameterOutOfRange` on zero.
- **`predominantDenominatorSymbol`** (bytes32) — lowercase ASCII
  symbol used by Tellor / API3 / DIA when querying asset/PAD pairs.
  Empty bytes32 reads as `"usd"` per the existing fallback
  convention.
- **`ethPadFeed`** (address) — Chainlink ETH/<PAD> AggregatorV3.
  REQUIRED on every chain post-T-048 — load-bearing for (a) WETH
  pricing and (b) the derived PAD/<numeraire> rate when no direct
  feed is set. Reverts `ParameterOutOfRange` on zero.
- **`padNumeraireRateFeed`** (address, optional) — Chainlink direct
  PAD/<numeraire> AggregatorV3 (e.g. USD/EUR on Ethereum mainnet).
  Zero is valid; the protocol derives the rate from
  `ETH/<numeraire> ÷ ETH/PAD` using existing infrastructure.

**Activation gate**:

- **Retail (PAD == numeraire == USD)** — PAD reads collapse to the
  single Feed Registry asset/USD query. Zero added gas, zero new
  failure modes, math identical to pre-T-048.
- **Pre-T-048 deploy (predominantDenominator == 0)** — legacy
  numeraire-direct path stays active. Existing deploys keep working
  unchanged until the operator opts in.
- **Industrial-fork (PAD ≠ numeraire, e.g. PAD=USD numeraire=EUR)**
  — PAD pivot activates. Per-asset override takes priority when set;
  otherwise asset/USD × USD/EUR multiplication composes the
  numeraire-quoted price.

**New error types**: `PadNumeraireRateUnavailable` (no FX rate path
reachable), `PadPivotFeedUnavailable(asset)` (asset has no
PAD-quoted feed AND no asset/ETH-pivot feed), `PadNumeraireRateFeedStale`
(direct rate feed is stale beyond budget).

**Operator deploy checklist (post-T-048)**: every chain's deploy
script MUST call `setPredominantDenominator(Denominations.USD,
bytes32("usd"), <chain's Chainlink ETH/USD feed>, address(0))`
before opening offers. Pre-mainnet pre-flight should assert
`getEthPadFeed() != address(0)` after deploy.

### Min principal for finer cadence (minPrincipalForFinerCadence)

Principal threshold above which the lender can opt into finer-than-
mandatory cadences (Monthly / Quarterly / SemiAnnual on any duration;
finer-than-Annual on multi-year). Stored in numeraire-units
(1e18-scaled). Default $100,000 (USD-as-numeraire).

> **Range bounds.** Values outside `[1_000e18,
10_000_000e18]` revert `ParameterOutOfRange`. Floor stops a
> "everyone qualifies" misconfig that would burden small borrowers
> with monthly settlements; ceiling caps the worst-case "nobody
> qualifies" misfire that would silently disable finer cadences for
> the entire deploy.

### Pre-notify lead time in days (preNotifyDays)

Single shared knob: how many days before each periodic-interest
checkpoint AND each loan-maturity deadline the off-chain hf-watcher
fires push notifications to subscribers. Default 3 days.

> **Range bounds.** Values outside `[1, 14]` revert
> `ParameterOutOfRange`. Floor (1) ensures at least a day's notice;
> ceiling (14) prevents desensitizing alert spam.

When governance changes this value, the next watcher tick picks it
up automatically (no Worker redeploy needed) — both the maturity
pre-notify lane (HF watcher's existing surface) and the periodic-
interest pre-notify lane (T-034) read from the same `getPreNotifyDays()`
view.

## Cross-chain VPFI buy (T-031 Layer 4a)

### Reconciliation watchdog enabled flag (reconciliationWatchdogEnabled)

Master switch for the
off-chain buy-flow reconciliation watchdog. Default `true`
post-init. The watchdog Worker reads this flag before each pass —
when `false`, it skips reconciliation and emits no alerts. Same
governance auth as every other lever. Lets governance silence the
watchdog during a planned bridge ceremony or known reconciliation
gap without redeploying the Worker. Boolean — no range.

## Range Orders match constraints

### Range-orders cancel cooldown

Compile-time constant
(`MIN_OFFER_CANCEL_DELAY = 5 min`); not governance-tunable at
runtime. Documented here for completeness — would require a
contract upgrade to change.

---

## Treasury and adapters

### Treasury address

Zero rejected at the setter level. The
treasury is the destination for all yield-fee and loan-initiation-fee
flows that don't go to the matcher kickback or VPFI tier rebates.
Misconfig surfaces as fees disappearing into the wrong wallet —
no on-chain bound stops this beyond the "non-zero" check. Operators
must sanity-check the address against the published treasury
multisig.

### 0x proxy / Pancakeswap V3 factory / Sushiswap V3 factory

Address-
only configs. Zero disables that adapter; non-zero enables it.

## Reward + cross-chain pairs

### Reward OApp address / Buy receiver address / Buy adapter mapping

Address-only; non-zero enforced; zero disables that
specific cross-chain lane.

### LayerZero peers

(set per-eid, per-OApp). Standard LZ V2 peer
mesh. Mismatch surfaces as undelivered packets; not a runtime
exploit vector under the DVN policy.

## Pause levers

Every facet that reads protocol state has a `pause()` /
`unpause()` lever (timelock + multisig). Pausing reverts every
guarded entrypoint immediately; unpausing is owner-only (delibrately
not auto-recoverable from a pauser-multisig). The 46-min pause
precedent in the April 2026 cross-chain incident blocked ~$200M of
follow-up drain.

## Sanctions oracle

### Sanctions oracle address

(Chainalysis-style). Zero leaves the
sanctions check fail-open during the deploy window (intentional);
non-zero enables Tier-1 sanctions screening on protocol entrypoints.
See CLAUDE.md "Retail-deploy policy" — sanctions ON, KYC + country-
pair OFF on the retail deploy.

---

## T-092 auto-lifecycle kill switches

Three admin master flags gating the auto-lend / auto-refinance /
auto-extend surface. All three default `false` on a fresh deploy.
Each is an independent break-glass — flipping one off only stops
the matching keeper-driven path; the per-user consent storage stays
intact and users can still revoke their own opt-ins. Storage lives
on `ProtocolConfig`, setters + getters on `AdminFacet`. Read in the
dapp via the Protocol Console (`/admin`) under the **Auto-Lifecycle
Kill Switches** category.

### `cfgAutoLendEnabled`

Master flag for the auto-lend opt-in.

- **Getter:** `AdminFacet.getAutoLendEnabled() -> bool`
- **Setter:** `AdminFacet.setAutoLendEnabled(bool)`
- **What `false` blocks:** new opt-ins via
  `AutoLifecycleFacet.setAutoLendConsent(true)` revert
  `AutoLendDisabled`. Existing consent is unaffected; users can
  still revoke (`setAutoLendConsent(false)` remains permitted) to
  avoid trapping users in consent when the admin disables the
  feature.
- **When to flip on:** once governance has rehearsed an auto-lend
  end-to-end cycle on a testnet and is satisfied the matcher's
  composition with the auto-lend posting flow doesn't introduce
  unexpected lender-side risk.
- **When to flip off:** if a real-world scenario surfaces where
  auto-lend posts standing offers under terms the lender wouldn't
  have accepted manually (e.g., a mass-vault-deposit script gets
  matched against the worst counterparties available). Flipping
  off freezes new opt-ins; existing standing offers remain on the
  book until cancelled or matched.

### `cfgAutoRefinanceEnabled`

Master flag for the keeper-driven refinance path.

- **Getter:** `AdminFacet.getAutoRefinanceEnabled() -> bool`
- **Setter:** `AdminFacet.setAutoRefinanceEnabled(bool)`
- **What `false` blocks:** `RefinanceFacet.refinanceLoan` reverts
  `AutoRefinanceDisabled` on the keeper-driven path (when
  `msg.sender != currentBorrowerNftOwner`). The borrower-direct
  refinance path (`msg.sender == currentBorrowerNftOwner`)
  remains permitted — a borrower can always refinance their own
  loan even when the kill switch is off. **Also blocks** the
  T-092-H atomic chain (`refinanceLoanFromAccept`) for the same
  reason — that entry shares the same Phase 2a sanctions +
  kill-switch gating as the standalone keeper-driven path.
- **When to flip on:** once governance has confirmed the cap-check
  surface (Phase 2b: `LibAutoRefinanceCheck.validate` at both
  offer-create AND offer-accept) is operationally sound and the
  keeper-bot is enforcing the per-loan
  `autoRefinanceCaps[loanId]` correctly.
- **When to flip off:** if a real-world scenario surfaces where
  a keeper routes a borrower into worse refinance terms despite
  the cap check (the Phase 2b round-3 P1 + P2 surface should
  catch every misuse pattern audited to date; this is the
  break-glass for unforeseen cases).

#### T-092-H atomic accept-and-refinance (PR #553, 2026-06-11)

Accepting a refinance-tagged Borrower offer (`offer.refinanceTargetLoanId != 0`)
now chains into `RefinanceFacet.refinanceLoanFromAccept` inside
the SAME transaction. Both `OfferAcceptFacet._acceptOffer` (direct
accept + `matchOffers` with `partialFillEnabled` off) and
`OfferMatchFacet.matchOffers`' dust-close branch (when
`partialFillEnabled` is on) carry the chain hook.

**Operational implication:** the old multi-tx race window between
accept and refinance is closed. A borrower whose wallet held the
new principal between transactions is no longer exposed to
intermediate spends / MEV front-runs / approval revocations. The
chain reverts the WHOLE tx when the refinance fails — both loans
roll back atomically.

**Kill-switch interaction:** flipping `cfgAutoRefinanceEnabled` off
blocks the atomic chain too (the inner `refinanceLoanFromAccept`
goes through the same sanctions + kill-switch gates as the
external `refinanceLoan`). Borrowers who set a refinance-tagged
offer during the kill-switch-off window will find the accept-side
revert with `AutoRefinanceDisabled` until the flag flips back on.

**Error surface:** the chain bubbles inner revert payloads
verbatim (no synthetic wrapper). The dapp's `autoLifecycleErrors.ts`
decoder already handles every typed inner error
(`RefinanceCapsRequired`, `SanctionedAddress`, etc.). Codex
review on PR #542 caught the wrapper-error misdesign in the first
attempt; PR #553 (the design-doc-first re-attempt under
[`docs/DesignsAndPlans/T092AtomicAcceptAndRefinance.md`](../DesignsAndPlans/T092AtomicAcceptAndRefinance.md))
shipped without further findings.

**Reentrancy:** `refinanceLoanFromAccept` is `onlyDiamondInternal`
(`msg.sender == address(this)`) gated + has NO `nonReentrant`
modifier — the outer `acceptOffer` / `matchOffers` `nonReentrant`
lock covers the whole atomic tx. External EOAs cannot call the
inner entry directly.

### `cfgAutoExtendEnabled`

Master flag for the in-place loan extension.

- **Getter:** `AdminFacet.getAutoExtendEnabled() -> bool`
- **Setter:** `AdminFacet.setAutoExtendEnabled(bool)`
- **What `false` blocks:** BOTH keeper-driven AND borrower-direct
  `AutoLifecycleFacet.extendLoanInPlace` revert `AutoExtendDisabled`.
  Unlike `cfgAutoRefinanceEnabled`, the borrower-direct path is
  ALSO blocked — there is no "manual extension" fallback when the
  flag is off, because the executor is shared.
- **When to flip on:** once governance has rehearsed an extend on
  a testnet loan with both-side consent and validated the
  per-side cap intersection logic (lender minimum, both-side
  maxes, both-side expiry caps) and the
  `LibInteractionRewards` schedule refresh.
- **When to flip off:** if the executor's interest-accrual / fee
  treatment surfaces an unexpected behaviour. Existing loans
  continue with their original terms (no extension fired ⇒ no
  state change); the next extension simply doesn't happen.

### Independence from per-user consent

The three flags are independent. Flipping `cfgAutoLendEnabled` off
does NOT disable `cfgAutoExtendEnabled` — users with both-side
extend caps set continue to benefit from the auto-extend pass even
while auto-lend is paused. Each flag's `Set` event is indexed by
the new value so an indexer can reconstruct the flip history
without a state migration.

### Recommended operational mode

`(false, false, false)` on a fresh deploy. After audit + testnet
rehearsal, flip in sequence:
1. `cfgAutoExtendEnabled` first — the safest path because both
   sides explicitly consent per-loan + the cap intersection logic
   has the smallest attack surface.
2. `cfgAutoRefinanceEnabled` second — the cap-check surface is
   larger (Phase 2b's binding-by-loan-id + assetType + amount-range
   + collateral + prepay matching), but the per-loan opt-in still
   constrains it.
3. `cfgAutoLendEnabled` last — touches the standing-offer book
   directly, so flipping it on is the highest-impact change.

Each flip is reversible at zero cost beyond gas.

---

## #633 — Feature kill switches (aggregators / keepers / swap venues / peer data)

Four admin break-glass levers that pause an individual platform feature
without disabling unrelated machinery. Setters + events live on
`AdminFacet`; storage is on `ProtocolConfig` (the three booleans) plus a
per-adapter mapping. Admin-settable now; moves to the governance timelock
after handover — the same posture as the #399 backstop switches.

> ⚠️ **PAUSE semantics — opposite polarity to the `*Enabled` flags above.**
> These default `false` meaning **active / not paused** (the gated
> features — aggregators, keepers, swap venues, peer reads — are *already
> live*, so a default-off flag would have silently disabled working
> behaviour and broken tests). Flipping one to **`true` PAUSES** the
> feature. Do not pattern-match these onto the `cfgAuto*Enabled` /
> `discountPathEnabled` flags, where `false` = off and `true` = on. Here
> `true` = paused.

### `keepersPaused` — global keeper pause

- **Getter:** `AdminFacet.keepersPaused() -> bool`
- **Setter:** `AdminFacet.setKeepersPaused(bool value)` → emits
  `KeepersPausedSet`.
- **What `true` blocks:** all delegated third-party keeper activity
  protocol-wide — `ConfigFacet.setKeeperTier`, the `LibAuth.requireKeeperFor`
  / `requireKeeperForPrincipal` gates (after the owner/principal
  short-circuit), the backstop buyout (`ClaimFacet._claimViaBackstopImpl`),
  and the aggregator adapter's keeper path
  (`AggregatorAdapterImplementation`). Position owners can **always** still
  act on their own positions directly, and ordinary **permissionless**
  liquidation stays open — only delegated keepers are frozen.
- **When to flip on:** a keeper-key compromise or a misbehaving bot fleet
  (mass mis-priced auto-actions). It is the broad incident lever; the
  per-user keeper revoke is the narrow one.

### `aggregatorAdaptersPaused` — external yield-aggregator pause

- **Getter:** `LibVaipakam.cfgAggregatorAdaptersPaused()` (read on-chain;
  surfaced in the Protocol Console).
- **Setter:** `AdminFacet.setAggregatorAdaptersPaused(bool value)` → emits
  `AggregatorAdaptersPausedSet`.
- **What `true` blocks:** onboarding a new aggregator
  (`AggregatorAdapterFactoryFacet.createAggregatorAdapter`) **and** filling
  an existing aggregator's standing lending intent
  (`OfferMatchFacet.matchIntent` when the lender is a registered aggregator
  adapter). Ordinary user lending intents and the backstop are unaffected.
- **When to flip on:** a Yearn-style external aggregator integration is
  found compromised or mispricing, and the protocol wants to stop routing
  fills to it without unwinding ordinary intents.

### `peerLtvReadsPaused` — peer-protocol data-read pause

- **Getter:** `LibVaipakam.cfgPeerLtvReadsPaused()`.
- **Setter:** `AdminFacet.setPeerLtvReadsPaused(bool value)` → emits
  `PeerLtvReadsPausedSet`. The setter also **invalidates the tier-LTV
  cache** (zeroes `tierLtvCache[t].lastRefreshedAt` for every tier) on
  every toggle, so an unpause can't re-trust a stale (possibly compromised)
  cached reading.
- **What `true` blocks:** the optional reads of peer lending protocols used
  to refine the depth-tiered collateral limits. While paused,
  `effectiveTierMaxInitLtvBps` falls back to the **governance-set cap**
  (`cfgTierMaxInitLtvBps`) — never the library default — so a compromised
  external data source can't influence risk parameters, and unpausing can
  never transiently widen a tier below the governance cap.
- **When to flip on:** a peer protocol's on-chain LTV reads look
  manipulated or unreliable.

### `swapAdapterDisabled[adapter]` — per-venue swap pause

- **Getter:** `AdminFacet.isSwapAdapterDisabled(address adapter) -> bool`
- **Setter:** `AdminFacet.setSwapAdapterDisabled(address adapter, bool disabled)`
  → emits `SwapAdapterDisabledSet`. The setter rejects an unregistered
  adapter (`SwapAdapterNotRegistered`) — you can only pause a venue that
  is actually in the `swapAdapters` registry.
- **What `disabled = true` blocks:** liquidation routing through that one
  venue, on **both** routes — the single-route failover path
  (`LibSwap.swapWithFailover` and `ClaimFacet._attemptRetrySwap`) **skips**
  it and fails over to the remaining venues, and the multi-route split path
  (`LibSwap.swapWithSplit`, called by `RiskSplitLiquidationFacet.triggerLiquidationSplit`)
  **reverts `SwapVenuePaused`** rather than routing a leg through it (split
  legs carry no per-leg slippage floor, so the pause must be enforced
  on-chain, not left to the off-chain keeper). The venue stays registered,
  so re-activating is a single `disabled = false` flip with no reshuffle.
- **When to flip on:** a DEX/aggregator venue is compromised or temporarily
  illiquid and you want it sidelined instantly.

Each flip is reversible at zero cost beyond gas. None of these levers
touches user funds or per-user consent state.

---

## Operational policy summary

- **Default new chain bring-up**: every numeric knob defaults to a
  reasonable library value. Governance does NOT need to write each
  knob at deploy time; the only mandatory writes are the
  chain-specific addresses (treasury, oracles, LZ endpoints, peers,
  per-chain VPFI Buy adapter registry).
- **Governance handover** (DeploymentRunbook §6): post-deploy, every
  tunable transitions from EOA-controllable to multisig-via-timelock
  controllable. Range guards apply equally to both before and after
  handover — they're compiled into the contract, not gated by who
  is calling.
- **Range-guard upgrades**: changing a min/max bound requires a
  contract upgrade through the standard `diamondCut` ceremony. This
  is intentional friction — bounds should be policy decisions
  visible in source, not a runtime knob a single multisig can
  silently widen.
- **Auditor hint**: when reviewing a setter, check three things:
  (1) does it accept the value as-is, or does it run a range check
  via `ParameterOutOfRange`? (2) does the bound's policy rationale
  appear next to the constant declaration in `LibVaipakam.sol`?
  (3) is the bound tight enough that a compromised admin can't push
  to a degenerate setting? The setter range audit document
  (`docs/ReleaseNotes/ReleaseNotes-2026-05-02.md` T-033 section)
  records the most recent pass; future audits should re-run the
  same exercise for any newly-added tunable.

---

## When to revisit this document

- Whenever a new governance-tunable parameter is added.
- Whenever a range bound is widened or tightened (even by
  one BPS).
- Whenever a sentinel value is added to a setter (e.g. the
  interaction-rewards "disable cap" pattern).
- Whenever a flag is converted from off-by-default to on-by-default
  (or vice versa) in the post-init sequence.

For any of those changes, update the relevant section above and
cross-reference the change in the appropriate dated release-notes
file.
