# Admin-Configurable Knobs and Switches

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
returns the *effective* value (default OR stored, whichever applies).

---

## Numeric knobs (with min/max ranges)

### Fees and protocol economics

**Treasury fee on lender interest.** Default 1% of accrued lender
interest goes to treasury. Range: 0% – `MAX_FEE_BPS` (the cap is
defined alongside the setter; conventionally 10% to leave headroom
for protocol-fee experiments without ever crossing into "majority of
interest goes to treasury" territory). Zero is a valid setting — it
turns the cut off entirely.

**Loan-initiation fee.** Default 0.1% of principal, paid by the
borrower in VPFI at loan start. Range matches the treasury fee cap.
Time-weighted VPFI tier discounts can take the borrower's effective
fee to zero — the setter cap is on the gross rate.

**LIF matcher kickback.** Out of the loan-initiation fee VPFI, the
matcher (the bot or wallet that called `matchOffers`) takes 1% of
the treasury slice as a kickback. Range: 0% – `MAX_FEE_BPS`. Zero
disables the kickback entirely; useful if matcher economics need to
shift.

**VPFI tier discount thresholds + tier discount BPS** (4 values
each). Configures the time-weighted VPFI staking tier system that
discounts the loan-initiation fee. Thresholds must be strictly
monotonic; discount BPS each ≤ `MAX_DISCOUNT_BPS` and
non-decreasing across tiers. Setter rejects non-monotone or
above-cap writes.

**Liquidation handling fee + max slippage + max liquidator
incentive** (3 values, set together via `setLiquidationConfig`). Each
bounded by its own `MAX_*_BPS` cap. The `liqBonusBps` per asset (set
via `updateRiskParams`) cannot exceed the chain-level
`maxLiquidatorIncentiveBps` — the latter is the hard ceiling.

**Risk config — volatility-LTV threshold + rental buffer.**
`volatilityLtvThresholdBps` must be > `BASIS_POINTS` (i.e. > 100%) —
it's a "collapse the position when LTV exceeds this" guard, must be
above the normal liquidation threshold to be meaningful. `rentalBufferBps`
≤ `MAX_FEE_BPS`.

**Per-asset risk parameters** (`updateRiskParams`):
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

**Staking APR.** Range **[0%, 20%]**. APRs above 20% on VPFI staking
are unrealistic and a higher cap is a governance-error vector rather
than a feature. Zero permitted (disables rewards while preserving
staked principal accounting).

**Notification fee in USD** (paid in VPFI at first PaidPush
notification). Range: floor and ceiling stored in the library
(currently $0.50 to $50). Zero means "use library default"; non-zero
must fall within the bounded window. Governance-tunable so a market
shift in Push Protocol fees can be passed through without redeploy.

**Notification-fee USD oracle.** Address-only; no range. Zero
disables the oracle and forces the library default at read time.

### Order matching and durations

**Max offer duration days.** Range: `[MIN_OFFER_DURATION_DAYS_FLOOR,
MAX_OFFER_DURATION_DAYS_CEIL]` (currently 1 to 365). Zero means use
library default.

**Auto-pause duration seconds.** Range: `[MIN_AUTO_PAUSE_SECONDS,
MAX_AUTO_PAUSE_SECONDS]` (currently bounded so a misfire can't
disable the safety net or set an indefinite freeze ceiling). Zero
means use library default.

### Oracle stack

**Secondary-oracle max deviation BPS** (Tellor / API3 / DIA quorum
agreement window vs Chainlink primary). Range **[1%, 20%]**. Tighter
than 1% would fail-close on legitimate cross-oracle drift in fast
markets and DoS the protocol; looser than 20% effectively disables
the divergence check (a 20%+ drift between independent oracles is
already "one of them is compromised" no matter how charitable the
variance assumption). Default is 5%.

**Secondary-oracle max staleness seconds.** Range **[1 min, 29 h]**.
The 29h ceiling sits 5 hours above the 24h heartbeat that some
stablecoin price feeds (USDC, USDT) publish on — tightening below
24h would soft-skip those legitimate-but-slow feeds on every update.
Default is 1 hour.

**Pyth oracle address** (T-033 numeraire-redundancy oracle, single
feed per chain — ETH/USD on ETH-native chains; bridged-WETH/USD on
non-ETH-native chains like BNB / Polygon mainnet). Address-only; no
numeric range. Zero disables the numeraire-redundancy gate globally
— the protocol falls back to Chainlink-only on the WETH/USD leg.

**Pyth numeraire feed id.** Single 32-byte Pyth price feed
identifier. Zero disables at the feed-id layer (same soft-skip
semantics as a zero `pythOracle`).

**Pyth max staleness seconds.** Range **[1 min, 1 h]**. Tighter and a
transient mempool jam soft-skips Pyth too often; looser and a
stale-but-manipulated reading could drive the divergence outcome.
Default is 5 minutes.

**Pyth numeraire max deviation BPS.** Range **[1%, 20%]**. Tolerated
divergence between Chainlink ETH/USD and Pyth ETH/USD before the
price view fails-closed with `OracleNumeraireDivergence`. Same
1%-20% window as the secondary-oracle deviation. Default is 5%.

**Pyth confidence max BPS** (`conf / price` ceiling). Range **[0.5%,
5%]**. Tighter and Pyth gets soft-skipped too often during fast
markets; looser and the "Pyth said X" claim becomes too uncertain to
be a useful cross-check. Default is 1%.

**Per-asset Chainlink feed override** (staleness + minimum valid
answer). Per-feed override of the chain's default feed-staleness
budget. Useful for a feed that the operator knows publishes at a
different cadence than the chain default. The override pair is set
together; either field non-zero replaces the chain default for that
feed.

**Stable-token feed override.** Per-symbol override that pins a
specific Chainlink feed to a token's symbol; used when the Feed
Registry doesn't have an entry. Address-only.

**Sequencer uptime feed.** Address of the chain's L2 sequencer
uptime feed (Arbitrum, Optimism). Zero means "no sequencer-down
guard" — appropriate on L1s but a misconfig on L2s. Address-only.

**Chainlink Feed Registry / USD denominator / ETH denominator / WETH
contract / ETH-USD feed / Uniswap V3 factory.** All address-only
configs that wire the chain-specific oracle stack. No numeric range;
zero disables the corresponding flow.

### Reward subsystem (cross-chain interest aggregation)

**Reward grace seconds** (T-031 Layer 4a-adjacent — different lane,
same governance pattern). After day `D` closes, this is how long
`finalizeDay(D)` may be called even if not every expected mirror has
reported. Range **[5 min, 30 days]**. The 5min floor prevents a
transient outage from being confused with real grace; the 30-day
ceiling prevents the window from being set to "indefinite" (defeats
the purpose). Default is 4 hours.

**Reward OApp / local eid / base eid / canonical reward chain
flag.** Address + integer + bool fields configuring the cross-chain
reward reporter. Eid values are LayerZero V2 endpoint ids (40000s
testnet, 30000s mainnet); no numeric range beyond "a known eid".
Setter accepts and emits.

**Interaction-rewards launch timestamp.** One-time-set; further
writes revert. Range: must be > 0 (cannot un-set). Effectively a
deploy-day knob.

**Interaction-rewards cap (VPFI per ETH).** Range **[1, 1,000,000]**
whole-VPFI-per-whole-ETH (NOT 1e18-scaled). Two intentional
sentinels: `0` resets to library default at read time;
`type(uint256).max` is the emergency "disable cap" knob. The bounded
window applies only to non-sentinel values. The sentinels are
preserved as documented escape paths but are themselves a
governance-trust point — a compromised admin flipping to the
disable-cap sentinel is something the policy explicitly tolerates as
an emergency lever.

### KYC (industrial-fork only — OFF on retail)

**KYC tier 0 / tier 1 thresholds (USD).** Range each: **[$100,
$1,000,000]** in 1e18-denominated USD. Tier 0 must be < tier 1.

> KYC is **OFF on the retail deploy** per CLAUDE.md — the
> `kycEnforcementEnabled` flag stays `false` post-deploy; the
> threshold values aren't read. These bounds are
> belt-and-suspenders for the retail deploy and load-bearing for
> the industrial fork.

### Range Orders Phase 1 (master kill switches — bool flags)

**`rangeAmountEnabled`, `rangeRateEnabled`, `partialFillEnabled`.**
All three default `false` post-deploy. Governance flips each on once
the corresponding mechanic is ready to ship. No range bound (bool).
Each flip emits a config event so off-chain monitoring can correlate
behavior changes to the governance action.

### Cross-chain VPFI buy (T-031 Layer 4a)

**`reconciliationWatchdogEnabled`.** Master switch for the
off-chain buy-flow reconciliation watchdog. Default `true`
post-init. The watchdog Worker reads this flag before each pass —
when `false`, it skips reconciliation and emits no alerts. Same
governance auth as every other lever. Lets governance silence the
watchdog during a planned bridge ceremony or known reconciliation
gap without redeploying the Worker. Boolean — no range.

### Range Orders match constraints

**Range-orders cancel cooldown.** Compile-time constant
(`MIN_OFFER_CANCEL_DELAY = 5 min`); not governance-tunable at
runtime. Documented here for completeness — would require a
contract upgrade to change.

---

## Non-numeric admin knobs (address / boolean)

### Treasury and adapters

**Treasury address.** Zero rejected at the setter level. The
treasury is the destination for all yield-fee and loan-initiation-fee
flows that don't go to the matcher kickback or VPFI tier rebates.
Misconfig surfaces as fees disappearing into the wrong wallet —
no on-chain bound stops this beyond the "non-zero" check. Operators
must sanity-check the address against the published treasury
multisig.

**0x proxy / Pancakeswap V3 factory / Sushiswap V3 factory.** Address-
only configs. Zero disables that adapter; non-zero enables it.

### Reward + cross-chain pairs

**Reward OApp address / Buy receiver address / Buy adapter
mapping.** Address-only; non-zero enforced; zero disables that
specific cross-chain lane.

**LayerZero peers** (set per-eid, per-OApp). Standard LZ V2 peer
mesh. Mismatch surfaces as undelivered packets; not a runtime
exploit vector under the DVN policy.

### Pause levers

Every facet that reads protocol state has a `pause()` /
`unpause()` lever (timelock + multisig). Pausing reverts every
guarded entrypoint immediately; unpausing is owner-only (delibrately
not auto-recoverable from a pauser-multisig). The 46-min pause
precedent in the April 2026 cross-chain incident blocked ~$200M of
follow-up drain.

### Sanctions oracle

**Sanctions oracle address** (Chainalysis-style). Zero leaves the
sanctions check fail-open during the deploy window (intentional);
non-zero enables Tier-1 sanctions screening on protocol entrypoints.
See CLAUDE.md "Retail-deploy policy" — sanctions ON, KYC + country-
pair OFF on the retail deploy.

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
  via `ParameterOutOfRange`?  (2) does the bound's policy rationale
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
