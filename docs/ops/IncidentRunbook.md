# Incident Runbook

Covers the three classes of incident that require a human decision:

1. **Delayed / missing cross-chain reward messages** (interaction-reward finalization stalls)
2. **Partial finalization** (one chain got zeroed — users on that chain have no reward for a day)
3. **Emergency pause** (contract bug, oracle anomaly, suspected exploit)

Every section follows the same shape: **Symptom → Detect → Diagnose → Decide → Execute → Communicate → Post-mortem**.

---

## 0. Reward mesh risk summary (why this runbook exists)

Before the interaction-reward mesh, every chain's daily accounting was self-contained: a bug or outage on chain X affected only chain X. The mesh changes that — Base's reward finalization has a **daily liveness dependency** on every reporter chain, and each mirror's user-facing claim math depends on a **cross-chain consistency invariant**. That is a categorically different risk profile from the rest of the protocol and is the reason §1 and §2 exist as first-class procedures rather than footnotes.

### New failure modes introduced by the mesh

| Risk | What it looks like | Where it's handled |
|---|---|---|
| **Daily liveness** | Any reporter chain misses its `closeDay` / LZ message within grace → Base can't finalize with full coverage. Recurs every 24h, not per-deploy. | §1 (delayed messages), §2 (zeroed chain reconciliation) |
| **Consistency divergence** | A mirror's `knownGlobalInterestUSD18[day]` ≠ Base's `getDailyGlobalInterest(day)`. Users on that mirror compute claims from the wrong denominator. Idempotent-on-match catches replays, but not a bad first-message. | ChainByChainChecks.md §6 — *critical page* rule |
| **Ingress trust compromise** | `rewardOApp` misconfigured or its key compromised → attacker can forge any chain's contribution. Single pin, whole-reward-curve blast radius. | AdminKeysAndPause.md — timelocked behind `ADMIN_ROLE` |
| **LZ at-least-once replay** | Same message delivered twice. Safe only if `ChainDayAlreadyReported` and "idempotent-on-match" in `onRewardBroadcastReceived` hold. Any bug = silent double-count. | Covered by `CrossChainRewardPlumbingTest.t.sol` + daily consistency check |
| **Pause asymmetry** | Outbound (`closeDay`, `broadcastGlobal`) is pause-gated; ingress (`onChainReportReceived`, `onRewardBroadcastReceived`) is **not**, by design, so in-flight messages don't trap-and-retry during incidents. | §3 — pause response must expect messages to keep landing |
| **Selector-list drift** | Reward facet selectors live in both `DeployDiamond.s.sol` and `HelperTest.sol`. Drift breaks either prod deploys or test harness silently. | UpgradeSafety.md — "both lists MUST stay in sync" |
| **Parameter identicality** | `graceSeconds`, `launchTimestamp`, `expectedSourceEids` must agree across chains. A silent mismatch shifts the reward curve. | ChainByChainChecks.md §5 — identicality check |

### What this means in practice

- Treat §1 as a **recurring pager category**, not a rare incident. Zeroed chains are a normal outcome of a stuck mesh, not an exploit.
- The critical page from ChainByChainChecks.md §6 (mirror `knownGlobal` ≠ Base's global) is **higher severity than a missed finalization** — missed finalization pays users from insurance; divergence corrupts every claim on that mirror until fixed.
- Emergency pause (§3) stops *new* reward-path writes but cannot stop inbound LZ messages. Post-pause triage must account for ingress continuing to land.

---

## 1. Delayed or missing cross-chain reward messages

### Symptom
- Users see the "Waiting for finalization" banner on the Rewards page past the normal 4h grace window.
- Subgraph alert fires: *"dayId N elapsed + `dailyGlobalFinalized[N] == false` at 8h"*.
- `isDayReadyToFinalize(dayId)` returns `reason == 3` (waiting) long after the grace window should have expired.

### Detect
Query `RewardAggregatorFacet` on Base:
```solidity
getDailyFirstReportAt(dayId)          // first report arrival
getExpectedSourceEids()               // list of expected chains
getChainDailyReportCount(dayId)       // how many have landed
isDayReadyToFinalize(dayId)           // (ready, reason) — reason: 1=finalized, 2=no reports, 3=waiting
```

### Diagnose
For each `expectedEid`:
- `isChainReported(dayId, eid)` → which chain hasn't sent?
- Check LZ scan (<layerzeroscan.com>) for the missing chain's reward OApp: is the outbound message in-flight, failed, or never sent?

**Root-cause buckets:**
- **A. Local `closeDay` was never called on the missing chain.**
  Anyone can call it; keeper may be down. Call it manually with gas for the LZ fee.
- **B. Local `closeDay` succeeded but LZ message stuck.**
  Use LZ scanner to retry / bump gas. On some LZ versions, `lzReceive` can be retried from the destination.
- **C. RewardOApp misconfigured** (`RewardOAppNotSet`, `BaseEidNotSet`, or `IsCanonical` flipped wrong way).
  Must be fixed via timelock — see `AdminKeysAndPause.md`.

### Decide
| Time past `dailyFirstReportAt + graceSeconds` | Action |
|---|---|
| `< 0` (still inside grace) | Do **nothing** yet — grace exists to absorb this. |
| 0 – 4h past grace | Anyone can call `finalizeDay(dayId)` — the missing chain contributes 0 for today. Prefer this before escalating. |
| 4 – 24h past grace + missing chain was expected to have material volume | Escalate to admin multisig + Insurance pool owner. Use `forceFinalizeDay(dayId)` only if `finalizeDay` itself is blocked (e.g., grace not elapsed because no reports arrived at all — see reason == 2). |
| `> 24h` past grace, still blocked | Pause the InteractionRewardsFacet claim path by protocol-wide `pause()`; file an incident; investigate before resuming. |

### Execute
**Normal path (zero-out the missing chain):**
```
RewardAggregatorFacet.finalizeDay(dayId)
   → emits ChainContributionZeroed(dayId, eid) per missing chain
   → emits DailyGlobalInterestFinalized(dayId, lenderUSD18, borrowerUSD18)
RewardAggregatorFacet.broadcastGlobal{value: lzFee}(dayId)
   → landing on every reporter via onRewardBroadcastReceived
```

**Force-finalize path (no reports arrived at all):**
```
forceFinalizeDay(dayId, 0, 0)       # emits DayForceFinalized
broadcastGlobal(dayId)
```

### Communicate
- Status page post: "Day N interaction rewards finalized with chain X zeroed. Users on chain X will be credited via Insurance pool reconciliation — see `PartialFinalizationSOP`."
- Discord + Twitter: link to the status post. Do **not** quote on-chain numbers until the broadcast has landed on every reporter chain.

### Post-mortem
Required within 72h. Template:
- Which chain was zeroed, and why (keeper down / LZ stuck / config).
- LayerZero message hash(es) if applicable.
- Total interest on the zeroed chain for that day (from on-chain `getChainReport` if it landed late, or from subgraph snapshot).
- Insurance-pool payout amount and recipients.
- Preventive action committed to (e.g., add a second redundant keeper, monitor LZ fee estimation).

---

## 2. Partial finalization — reconciling users on a zeroed chain

### Context
Once `finalizeDay` has been called for `dayId`, **late reports are rejected on-chain** (`ReportAfterFinalization`). Users on the zeroed chain have no way to claim that day's share from the contract. Reconciliation happens off-chain via the Insurance pool.

### SOP
1. **Collect the chain's actual interest for `dayId`** from the subgraph (`ChainInterestReported` event for the zeroed chain — it may have been *attempted* but rejected; the reporter facet's local `dailyLenderInterestUSD18[dayId]` is still the truth).
   ```solidity
   RewardReporterFacet.getLocalChainInterestUSD18(dayId)   // on the zeroed chain
   ```
2. **Compute each affected user's share** using the same formula as the on-chain split:
   `reward_user = half_pool * (user_interest_usd18 / chain_total_interest_usd18)`
   …where `half_pool` is `InteractionRewardsFacet.getInteractionHalfPoolForDay(dayId)` on Base, **multiplied by** `chain_total_usd18 / global_total_usd18` — because `finalizeDay` zeroed this chain out of the global denominator, the chain's "fair share" of the pool was never counted. Recompute as if the chain had been included.
3. **Publish the reconciliation table** (user → VPFI amount) in the incident post-mortem. CSV attached, hash pinned on-chain via `AdminFacet` event (see `MiscEvents`).
4. **Multisig executes** Insurance-pool payouts: ERC20 transfer from the Insurance safe. Batch via Gnosis Safe; one tx per chain per incident.
5. **Users self-claim** from the Insurance contract (future work: one-click claim UI on the rewards page). Until shipped, payouts are direct transfers.

### Guard rails
- **Never** try to "un-zero" via a contract upgrade. The storage is append-only by spec and audit scope; late reports go through Insurance only.
- Insurance-pool payout must never exceed `chain_total_interest_usd18 * pool_reward_rate / global_total_usd18` (sanity check to catch arithmetic errors).

---

## 2b. Funding a mirror — reward-budget remittance (#776)

### Context
Finalizing a day and broadcasting its denominator opens the claim gate on every
mirror, but the VPFI that pays those claims is bridged **separately and
on-demand** from Base via `RewardRemittanceFacet.remitRewardBudget`. A mirror
whose gate is open but whose reward-budget has not yet been remitted will have
claims **revert at the token transfer** (funded balance empty). This is normal,
recoverable back-pressure — not a fund-loss event.

### Symptom
- Mirror users report interaction-reward claims failing/reverting while the
  rewards page shows a claimable amount.
- The mirror Diamond's VPFI balance is at or near zero for the days in question.

### Detect
- `quoteRewardBudget(mirrorChainId, dayIds)` on Base returns a non-zero total
  for finalized days that have not been remitted.
- `getRewardBudgetRemitted(mirrorChainId, dayId) == 0` for the affected days.
- On the mirror, `getRewardBudgetReceivedTotal()` lags the claimable demand.

### Execute (fund the mirror)
1. On **Base**, an ADMIN (or the configured `rewardRemittanceKeeper`) calls
   `remitRewardBudget(mirrorChainId, dayIds, perRemittanceCap)` with `msg.value`
   covering the CCIP fee (overpay is refunded). Size `perRemittanceCap` **and**
   the `dayIds` batch so the total stays under the live reward-budget CCIP lane
   bucket — early-schedule days are large; use `quoteRewardBudget` to confirm.
2. Sends are **idempotent at the source**: if the Base tx itself reverts
   (e.g. it never reached `sendMessage`), the `(chain, day)` marks roll back with
   it, so re-running the batch remits fresh. If some days in the batch were
   already remitted on a **prior successful** Base tx, they are skipped (or the
   whole call reverts `NothingToRemit` if none are left) — retry is always safe.
3. CCIP delivers the VPFI to the mirror's `RewardRemittanceReceiver`, which
   forwards it into the mirror Diamond; claims then succeed from balance. Watch
   the mirror's `RewardBudgetReceived(dayIds…)` event for confirmation.

### Guard rails / recovery
- **Ordering:** remit a day **before** its broadcast opens the claim gate on the
  mirror, so users never hit the empty-balance revert. Note this is **not
  automatically synchronized**: `broadcastGlobal(dayId)` is a separate
  permissionless call that can fire immediately after `finalizeDay`, whereas the
  keeper (#925) remits on its own cron cadence — so a gap can still open the gate
  before the budget lands. That gap is the recoverable back-pressure this section
  handles; the keeper narrows it on a best-effort basis but does not guarantee
  remit-before-broadcast. If you are manually broadcasting a day, remit it first.
- **Delivery accepted on Base but reverted on the mirror** (e.g. paused
  receiver): the days are **already marked remitted** on Base and the VPFI is in
  the CCIP pipeline — so **do NOT re-run `remitRewardBudget`** (it would skip
  those days / return `NothingToRemit` and send nothing). Recovery is a **CCIP
  manual re-execution** of the parked message (same as the buyback path) once
  the receiver is unpaused; nothing is lost. A fresh `remitRewardBudget` is only
  the right move for days that were never accepted at the source.
- **Over-fund:** if the §4 per-user cap makes a mirror's users claim less than
  the remitted slice, the surplus is a shared, fungible balance that pre-funds
  later days' claims. Any true terminal-wind-down residual is a governance
  action (there is no permissionless Diamond-balance sweep — the mirror VPFI is
  commingled with LIF custody + treasury). Tracked: #917.
- **Lane capacity:** a single day is remitted atomically, so the reward-budget
  lane capacity must exceed the largest single-day slice. Tracked: #918.

### Automated remittance (keeper, #925)
The steps above are the **manual** fallback. In normal operation the `apps/keeper`
Worker drives remittance itself (`runRewardBudgetRemit`): each cron tick, running
against Base, it re-scans a bounded recent-day window per mirror, batches the
finalized-but-un-remitted days under the lane cap, quotes the exact fee, and
remits — keeping mirrors funded on a best-effort cron cadence (it does **not**
synchronize with broadcasts; see the Ordering caveat above). It is **dark by
default** and requires all of:
1. `KEEPER_ENABLED=true` (master switch) **and** `REWARD_REMIT_ENABLED=true`
   (dedicated flag) in the keeper Worker's vars.
2. `KEEPER_PRIVATE_KEY` set (the pass shares the keeper's signing key — without it
   the whole keeper stays disabled) **and** that EOA funded with native Base for
   gas plus each remit's quoted CCIP `msg.value`. An unfunded key arms the pass
   but every remit reverts / fails to submit.
3. That signing EOA authorized on-chain — either ADMIN, or granted the
   reward-remittance keeper role via `RewardRemittanceFacet.setRewardRemittanceKeeper(<keeperEOA>)`.
4. The `RewardRemittanceReceiver` deployed + registered on every mirror and the
   `vpfi-reward-budget` CCIP lane provisioned. This wiring is performed by the
   deploy scripts — `DeployCrosschain.s.sol` deploys the receiver (and writes it
   to the deployments artifact), and `ConfigureCcip.s.sol` registers the
   `vpfi-reward-budget` channel + calls the Diamond's `setRewardRemittanceReceiver`
   for each mirror; the lane's rate limits are set per the mainnet-deploy gates in
   CLAUDE.md § "Cross-Chain Security Policy".

Optional tuning vars: `REWARD_REMIT_LOOKBACK_DAYS` (default 45) and
`REWARD_REMIT_LANE_CAP` (wei, default `50000e18` — must stay ≤ the provisioned
lane bucket; a day whose slice exceeds it is skipped with a loud log until the
lane + cap are raised together, #918). **Caveat:** the keeper only re-scans the
last `REWARD_REMIT_LOOKBACK_DAYS`, so a skipped over-cap day is auto-retried only
while it is still inside that window. If the lane + cap are raised *after* the day
has aged past the lookback, widen `REWARD_REMIT_LOOKBACK_DAYS` to re-include it or
remit it with the manual §2b procedure — it will not be picked up otherwise.

**To disable in an incident** (e.g. a misconfigured lane, or to hand back to
manual control): set `REWARD_REMIT_ENABLED=false` (leaves the rest of the keeper
running) or `KEEPER_ENABLED=false` (stops all keeper actions), then redeploy the
Worker. The pass is idempotent and bounds its receipt waits, so stopping it never
strands funds — any in-flight day simply re-evaluates on the next armed tick or
via the manual procedure above.

---

## 3. Emergency pause

### Trigger criteria (pause **immediately**, decide later)
- External exploit evidence (funds leaving user vaults, unexpected `LoanInitiated` events).
- Oracle anomaly: price deviation > 20% vs. centralized reference, or a feed reports `answer == 0` / stale.
- Critical bug report from audit channel / bounty.
- Any `DayForceFinalized` that was **not** pre-authorized in ops chat.

### What does **not** require an emergency pause

- **L2 sequencer outage (single chain).** `OracleFacet.sequencerHealthy()` returning false is self-healing: `getAssetPrice` reverts `SequencerDown` / `SequencerGracePeriod`, `checkLiquidity` fail-closes to Illiquid, and both `RiskFacet.triggerLiquidation` and `DefaultedFacet.triggerDefault` revert `SequencerUnhealthy`. New loans with liquid collateral become unmintable until the feed recovers past the 1h grace window; existing loans are frozen in-place. Page the on-call for visibility but **do not pause** — paused state blocks repayment, which is exactly what borrowers need to do while their collateral prices are untrusted. If the outage lasts >4h, follow the §1 escalation path for the reward mesh (chain contribution will zero out naturally).

### Detect
- Tenderly alerts on unexpected transfers from Diamond.
- Subgraph alert on the three reward events (`ChainContributionZeroed`, `DayForceFinalized`, "stalled day").
- PagerDuty on-call page.

### Execute
Pauser multisig signs:
```
AdminFacet.pause()
```
This halts every `whenNotPaused` facet entry. What remains callable while paused (**by design**):
- `AccessControlFacet.grantRole / revokeRole / renounceRole`
- `DiamondCutFacet.diamondCut`
- `OracleAdminFacet.*` (so a bad feed can be swapped without unpause)
- `VaultFactoryFacet.upgradeVaultImplementation`
- Every `whenNotPaused`-less getter

See `PauseGatingTest` for the canonical list.

**Cross-chain contracts pause separately.** `AdminFacet.pause()` only freezes
the Diamond's own facets. The stand-alone `GuardianPausable` cross-chain
contracts — `CcipMessenger`, the buyback receiver, the mirror
`RewardRemittanceReceiver` (#776), the mirror VPFI token — are frozen with
`contracts/script/pause-all-chains.sh` (guardian-signed), which enumerates all of them.
Run it alongside the Diamond pause to freeze the Base→mirror reward-budget
ingress too; the receiver can be kept paused while other CCIP channels resume.

### Decide (post-pause triage)
1. Is the issue a bad config (oracle/0x proxy/rewardOApp)? → Admin fix, unpause.
2. Is the issue a bug in a facet? → Prepare a diamond-cut replacing the facet (see `UpgradeSafety.md`). Unpause **only after** cut lands and tests pass on a fork.
3. Is funds movement required (rescue)? → **Do not** unpause. Use `whenNotPaused`-exempt paths only; rescue logic must go through a diamond-cut.

### Unpause checklist
Before `AdminFacet.unpause()`:
- Root cause identified and fix deployed.
- Fork test reproduces the incident and shows the fix mitigates it.
- Communication drafted and ready to go out simultaneously with unpause.
- At least one board-of-directors-equivalent signoff logged in ops channel.

### Communicate
- Within 15 min of pause: "Protocol paused — investigating. No action required from users."
- Within 4h: first diagnosis post.
- Within 48h: full post-mortem.

---

## 3.5 Targeted snap-off — flash-loan / discount-path

When a problem is scoped to the liquidator-buys-at-discount path
(`RiskFacet.triggerLiquidationDiscounted` +
`FlashLoanLiquidator`), use a targeted snap-off instead of a full
protocol pause. The atomic-swap path (`triggerLiquidation`,
`triggerLiquidationSplit`, `triggerPartialLiquidation`) keeps
running.

Three escalation tiers, least to most disruptive:

**Tier 1 — keeper-side snap-off (30-second op, our bot only)**

Delete the per-chain env flag in the Cloudflare keeper Worker:

```bash
pnpm --filter @vaipakam/keeper exec wrangler secret delete \
  DISCOUNT_PATH_ENABLED_<chainId>
```

The Worker reads `undefined` on next tick → flash-loan branch
skips → legacy partial/split/atomic still runs. Affects ONLY our
bot; external liquidators are unaffected (use Tier 3 for that).

**Tier 2 — pull our receiver from the per-chain config**

Edit [`apps/keeper/src/flashLoanProviders.ts`](../../apps/keeper/src/flashLoanProviders.ts),
delete the `liquidator:` line for the affected chain, commit +
redeploy the Worker. Slower than Tier 1 (needs a deploy) but
doesn't depend on the Cloudflare API. Same blast radius as
Tier 1.

**Tier 3 — flip the on-chain kill-switch (affects EVERYONE)**

```solidity
ConfigFacet.setDiscountPathEnabled(false)
```

Reverts every `triggerLiquidationDiscounted` call regardless of
caller — our bot AND external liquidators AND any keeper that
wrote their own receiver. Use this when the issue is in the
diamond's discount-path code itself (settlement math, sanctions
gate, oracle-fallback) and external liquidators must be stopped
too.

Post-handover this needs a Timelock-scheduled tx with the
48h delay — **not an emergency lever once handover lands**.
Tier 1 (keeper-side snap-off) and the asset-level
`AdminFacet.pauseAsset` are the immediate-effect levers
post-handover; Tier 3 is the "we have time to schedule a
permanent fix" path.

Full per-chain rollout sequence + troubleshooting in
[`FlashLoanLiquidatorRollout.md`](FlashLoanLiquidatorRollout.md).

## 3.6 Targeted snap-off — internal-match path (added 2026-05-15)

When a problem is scoped to the internal-liquidation match path
(`RiskFacet.triggerInternalMatchLiquidation` + the priority-window
gate inside `triggerLiquidation`), use a targeted snap-off instead
of a full pause. The atomic-swap path remains the protocol's
default fallback — disabling internal-match returns the system to
exactly today's behaviour (external liquidation across the full
LTV range), so the snap-off is non-disruptive to recovery.

Two escalation tiers, least to most disruptive:

**Tier 1 — bot-side snap-off (keeper-bot operator only)**

Stop the `internalMatcher` detector in
[`vaipakam-keeper-bot/src/detectors/internalMatcher.ts`](https://github.com/vaipakam/vaipakam-keeper-bot/blob/main/src/detectors/internalMatcher.ts)
on this chain. Either:
- Comment out the per-tick invocation, redeploy the bot, **or**
- Add an early-return on `chainId === <affected>` at the top of
  `runInternalMatcherTick`.

Affects ONLY our bot; external operators running their own
matcher detectors are unaffected (use Tier 2 for that). The
on-chain entry point stays callable; only OUR bot stops calling
it.

**Tier 2 — flip the on-chain kill-switch (affects EVERYONE)**

```solidity
ConfigFacet.setInternalMatchEnabled(false)
```

Reverts every `triggerInternalMatchLiquidation` call regardless
of caller AND short-circuits the priority-window gate inside
`triggerLiquidation` (external opens back up across the full
LTV range, exactly as today). Use this when the issue is in the
diamond's internal-match code itself (the cross-vault transfer
logic, the lifecycle transition, the per-leg incentive math)
and every operator's matcher must be stopped.

Post-handover this needs a Timelock-scheduled tx with the
48h delay — **not an emergency lever once handover lands.** The
asset-level `AdminFacet.pauseAsset` is the immediate-effect lever
for the affected asset's loans; Tier 2 is for "we want to
permanently disable the match path while we triage."

### What does NOT require flipping the internal-match
kill-switch

- **A single match transaction reverts.** The bot's revert is
  visible in `internalMatcher.submit.failed` log lines but
  doesn't risk protocol funds — the tx rolled back atomically.
  Common causes: lost a race to another matcher, kill-switch
  flipped between simulate + execute, vault balance drifted.
  Investigation only; no action.
- **Spurious bot revenue.** The 1% per-leg incentive is bounded
  by the per-leg matched notional. A spike in `InternalMatchExecuted`
  emissions means the path is working as designed. Validate via
  `getInternalMatchConfigBundle()` returning the expected `(true,
  200, 100)` tuple and the per-tier liquidation thresholds via
  `getTierLiquidationLtvBps()`.
- **LTV oscillation around the priority window.** A loan
  crossing the floor → above-window → back below as oracle
  prices move is normal market dynamics; external opens AND
  closes its callability window per block. No incident.

### Symptoms that DO warrant a snap-off

- Loans transitioning to `LoanStatus.InternalMatched` while
  having non-zero `principal` — bug in the lifecycle transition.
- Borrower's vault balance + collateralAmount drifting after a
  match — bug in the cross-vault transfer.
- Matcher receiving > the cap'd `internalMatchIncentivePerLegBps`
  in a single match — bug in the incentive math.
- External `triggerLiquidation` succeeding inside the priority
  window when the kill-switch is on — bug in the gate.

---

## 3.7 Targeted snap-off — feature kill switches (#633, added 2026-06-18)

Four on-chain levers that pause one feature each without a full
protocol pause. **PAUSE semantics: default `false` = active; set `true`
to pause** (opposite polarity to the `cfgAuto*Enabled` / `discountPathEnabled`
flags). Setters on `AdminFacet`; full catalogue in
[`AdminConfigurableKnobsAndSwitches.md`](AdminConfigurableKnobsAndSwitches.md)
§"#633 — Feature kill switches". Reach for the narrowest lever that
contains the incident before considering the full `AdminFacet.pause()` (§3).

| Incident scope | Lever | Effect |
| --- | --- | --- |
| A single DEX/aggregator swap venue compromised or illiquid | `AdminFacet.setSwapAdapterDisabled(adapter, true)` | Failover path **skips** the venue; split path **reverts `SwapVenuePaused`**. Other venues + the rest of the protocol keep running. Re-enable with `false` — no reshuffle. |
| Keeper-key compromise / misbehaving bot fleet | `AdminFacet.setKeepersPaused(true)` | Freezes ALL delegated third-party keepers (liquidation follow-ups, auto-roll, backstop buyout, aggregator keeper path). Owners still act on their own positions; permissionless liquidation stays open. |
| A Yearn-style external yield aggregator compromised / mispricing | `AdminFacet.setAggregatorAdaptersPaused(true)` | Blocks onboarding a new aggregator AND filling an existing aggregator's standing intent. Ordinary user intents + backstop unaffected. |
| Peer-protocol on-chain LTV reads look manipulated | `AdminFacet.setPeerLtvReadsPaused(true)` | Depth-tiered limits fall back to the governance-set cap (never the library default). The setter also invalidates the tier-LTV cache, so an unpause can't re-trust a stale reading. |

Each is reversible at zero cost beyond gas and touches no user funds or
per-user consent. Post-handover these move behind the Timelock — confirm
whether the incident needs an immediate-effect lever (pre-handover, or the
asset-level `AdminFacet.pauseAsset`) before relying on one of these.

### Confirm afterwards

- The targeted feature is actually stopped (e.g. a `triggerLiquidationSplit`
  through a paused venue reverts `SwapVenuePaused`; a paused keeper path
  reverts `KeeperAccessRequired` / `KeepersGloballyPaused`).
- Unrelated paths still run (ordinary liquidation, repayment, claims) —
  these are surgical levers, not a global pause.

### Diagnostic — auto-lend delegated rolls / keeper-gated fills not happening

Symptoms when the **published `keeperAddress` doesn't match the keeper's
actual signing key** (so lenders delegated to the wrong address, #625 WI-1)
— with `keepersPaused` **false** (not a deliberate freeze):

- **Auto-roll** broadcasts and **reverts `KeeperAccessRequired`** (the roll
  is a direct on-chain submit), visible in the keeper logs.
- **Keeper-gated (signed-fill) `matchIntent`** does **not** surface as a
  revert log — the keeper calls `previewIntent` first, gets the
  `KeeperUnauthorized` intent code, and **abandons the intent before
  broadcasting**. So this side shows up as fills silently never happening,
  not as an error. Check both.

This is a config issue, not an on-chain incident:

1. Compare the **live published** address — the `getDeployment(chainId).keeperAddress`
   value actually shipped in the dapp (`packages/contracts/src/deployments.json`
   / the deployed frontend bundle), **not just** the source
   `contracts/deployments/<slug>/addresses.json` (a fixed source that wasn't
   re-exported or redeployed still serves the stale address) — against
   `cast wallet address --private-key "$KEEPER_PRIVATE_KEY"` for the
   `apps/keeper` Worker on that chain.
2. If they differ: correct `keeperAddress` in `addresses.json`, re-run
   `bash contracts/script/exportFrontendDeployments.sh`, and **redeploy the
   dapp** (confirm the live bundle now serves the right address). Lenders
   re-run the (idempotent) delegation step in the Auto-lend card against the
   corrected address.
3. **Revoke the mispublished keeper before closing the incident.** Re-delegating
   to the correct address only *adds* the new grant — the old (wrong) EOA keeps
   its `SIGNED_FILL` / `AUTO_ROLL` authority on every lender who already
   approved it, and the on-chain auth accepts *any* approved address with the
   bit. If that address is attacker-controlled or later compromised it can
   still act, so affected lenders must `revokeKeeper(oldAddr)` (the dapp's
   Keeper Settings page) — or keep delegated keepers paused
   (`AdminFacet.setKeepersPaused(true)` — the keeper-pause lever in the table
   above) until they have — before treating it as resolved. (Auto-FILL of
   *permissionless* intents is unaffected — it needs no delegation.)

See the Deployment Runbook "Auto-lend keeper address" section.

---

## 4. Off-chain alert-rail key compromise

The watcher holds two long-lived secrets — `TG_BOT_TOKEN` (Telegram
bot) and `PUSH_CHANNEL_PK` (Vaipakam Push channel signer). Neither
controls on-chain authority, so neither requires an emergency
on-chain pause. Both **do** allow brand-impersonation (sending
arbitrary notifications to our subscriber base under the Vaipakam
identity), so rotation is time-sensitive.

### Vaipakam Push channel reference

- **Channel address:** `0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b`
- **Public URL:** <https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b>
- **Signer secret:** `PUSH_CHANNEL_PK` (Cloudflare Worker, encrypted)
- **Frontend env:** `VITE_PUSH_CHANNEL_ADDRESS`

### Symptom
- Subscribers report Vaipakam notifications they did not opt into,
  containing phishing copy, off-protocol links, or messages that
  contradict known protocol state.
- Wrangler tail shows successful `Push API` send calls our cron
  didn't initiate.
- Telegram inbound webhook traffic looks scripted (high-frequency
  `/start <code>` posts from new chat IDs).

### Detect
- Search wrangler logs for unexpected **`[push] sent`** lines outside the
  cron schedule — that is the success line, and it is the one that matters
  here. `[push] send` does NOT match it: the only line containing that exact
  string is `[push] send failed`, so the documented term used to return every
  failure and not one unexpected send, which is precisely inverted for this
  investigation. Failures are still worth a look, so search both:
  `[push] sent` for deliveries and `[push] send failed` for attempts that
  did not land.
- Cross-reference the channel's recent broadcast history at
  <https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b>
  against our own send log.

### Execute — Telegram bot rotation

**There is no overlap window to engineer.** A Telegram bot has exactly
one token, and `@BotFather`'s `/revoke` invalidates the old one and
issues the replacement in the same reply — you cannot hold a working
new token before the old one dies. (`/token` only *displays* the
current token; it does not mint one.) So the outage is unavoidable and
the only thing under your control is its LENGTH. Every step that does
not need the new token is therefore pre-staged, and exactly one command
runs after revocation.

1. **Pre-stage, while the old token still works.** Resolve the store id
   and the existing secret's id. `TG_BOT_TOKEN` ALREADY EXISTS in the
   account-level Secrets Store, so the rotation is an UPDATE and needs
   that id — `secret create` fails on a duplicate name, and discovering
   that *after* `/revoke` is what leaves both sides with no working
   credential.

   ```bash
   STORE=<the vaipakam-credentials store id>
   # --per-page: the default is 10 and the store holds ~22 secrets, so
   # the flag is required or TG_BOT_TOKEN may simply not be on the page.
   wrangler secrets-store secret list "$STORE" --remote --per-page 100
   SECRET_ID=<TG_BOT_TOKEN's id from that listing>
   ```

   Rotation is in the **account-level Secrets Store**, NOT per Worker.
   `ops/hf-watcher` was removed by the Stage 3 split; the live consumers
   are `apps/agent` and `apps/keeper`, and both resolve `TG_BOT_TOKEN`
   from the shared store — so one write covers both, and a per-Worker
   `wrangler secret put` would rotate neither.
2. From `@BotFather`: `/revoke`. The old token dies within seconds and
   BotFather's reply contains the NEW token. The outage starts here.
3. Write the new token with the id resolved in step 1 — a single
   command, no lookups:

   ```bash
   # No --value and no pipe: wrangler prompts for the secret and it never
   # enters the command line, so it cannot be recovered from shell history
   # afterwards. Wrangler's own help calls --value "Only for testing. Not
   # secure as this will leave secret value in plain-text in terminal
   # history". A credential minted to evict an attacker is the last one that
   # should be left lying on the workstation.
   wrangler secrets-store secret update "$STORE" \
     --secret-id "$SECRET_ID" --remote
   ```
4. Re-register the webhook. The token goes in the URL path, so it must not
   be typed into the command — that would undo step 3's prompted upload by
   writing the freshly minted credential straight into shell history, and
   into the process list where any other user on the box can read it from
   `ps`. Prompt for it and hand curl its options on **stdin**, so the token
   appears in neither:

   ```bash
   read -rsp 'New bot token: ' TG_TOKEN; echo

   printf 'url = "https://api.telegram.org/bot%s/setWebhook"\ndata-urlencode = "url=https://agent.vaipakam.com/tg/webhook"\n' \
     "$TG_TOKEN" | curl -K -

   # Confirm it took — same pattern, same reason:
   printf 'url = "https://api.telegram.org/bot%s/getWebhookInfo"\n' \
     "$TG_TOKEN" | curl -K -

   unset TG_TOKEN
   ```

   `curl -K -` reads its options from standard input, so the assembled URL
   never becomes a command-line argument. `read -rs` keeps the typed value
   off the screen and out of history. `unset` drops it from the shell's
   environment when you are done — a rotation performed to evict an
   attacker should not leave the replacement credential lying around the
   workstation.

   `agent.vaipakam.com`, NOT `api.vaipakam.com` — the latter belonged to
   the removed hf-watcher and no current Worker binds it; `/tg/webhook`
   exists only in `apps/agent`. Telegram accepts `setWebhook` against a
   dead host without complaint, so getting this wrong fails SILENTLY: the
   bot simply stops receiving updates.
5. Redeploy the live consumers to flush in-memory clients tied to the
   old token:

   ```bash
   pnpm --filter @vaipakam/agent exec wrangler deploy
   # --keep-vars is harmless and correct for TG_BOT_USERNAME, but it is NOT
   # what keeps the keeper armed — see "How the keeper's arming flags are
   # actually held" below. A plain deploy does not disarm it.
   pnpm --filter @vaipakam/keeper exec wrangler deploy --keep-vars
   ```

No subscriber action required — the bot's @-handle stays
`@VaipakamBot`, only the API token rotates.

### Execute — Push channel signer rotation

**Read this first: there is no signer rotation, and there is no ownership
transfer.** Both Workers derive the channel identity from the signing key
(`channelCaip = eip155:1:<wallet(PUSH_CHANNEL_PK).address>`), so changing the
key changes *which channel the platform posts as*. And Push does not
implement channel-ownership transfer at all — `PushCoreV2` declares a
`ChannelOwnershipTransfer` event that is never emitted, and the primitive
with that shape is `PushCommV2.addDelegate`, which grants delegated SENDING
rights while the channel stays with its creator. Earlier versions of this
runbook told the operator to transfer ownership; do not go looking for it.

So rotating this key is a **channel migration**, and subscribers do not come
with it. Budget for that before you start.

**Failure mode to know before you act:** a send to a channel Push does not
know does not throw anything user-visible. `sendPush` catches and logs
`[push] send failed subscriber=… err=…` and moves on — fail-soft and
UNALERTED. Nothing pages, nothing appears in the app. The only place it shows
is `wrangler tail`, so verify there rather than assuming success.

1. From a clean EOA you control, **create a new Push channel** —
   `createChannelWithPUSH`, which requires a **50 PUSH stake**. This is not
   optional and not avoidable: the new key must be a channel Push recognises
   or every send is rejected. Acquiring PUSH mid-incident is not a fast path,
   so treat the stake as a standing prerequisite for being able to rotate.
2. Write that EOA's private key over `PUSH_CHANNEL_PK` in the **account-level
   Secrets Store** — `apps/agent` and `apps/keeper` both bind it from there,
   so one write covers both and a per-Worker `wrangler secret put` would
   rotate neither:

   ```bash
   STORE=<the vaipakam-credentials store id>
   # --per-page 100: the default page size is 10 against ~22 secrets, so the
   # flag is required or PUSH_CHANNEL_PK may simply be absent from the page.
   wrangler secrets-store secret list "$STORE" --remote --per-page 100
   # No --value and no pipe — wrangler prompts, so the key never enters
   # shell history (see the Telegram step above for why that matters).
   wrangler secrets-store secret update "$STORE" \
     --secret-id <PUSH_CHANNEL_PK's id> --remote
   ```
3. Redeploy **both** consumers to drop their cached PushAPI clients:

   ```bash
   pnpm --filter @vaipakam/agent exec wrangler deploy
   # --keep-vars: same reason as the Telegram rotation — see "How the
   # keeper's arming flags are actually held" below. It preserves
   # TG_BOT_USERNAME; it is not what keeps the keeper armed.
   pnpm --filter @vaipakam/keeper exec wrangler deploy --keep-vars
   ```
4. **Point the app at the new channel.** Set `VITE_PUSH_CHANNEL_ADDRESS` to
   the new EOA and redeploy `apps/defi`. Leaving it on the old address sends
   every user who opens the Alerts page to subscribe to a channel the
   platform no longer posts to — and that subscribe succeeds, so nothing
   signals the mistake.

   This is a BUILD-time value, so it has to be present when the bundle is
   built — a shell comment does nothing, and `apps/defi/.env.production`
   does not currently carry the key at all (only `.env.example` and
   `.env.local` do, and Vite loads neither for a production build). Set it
   in the production env file, then deploy:

   ```bash
   # Add (or update) in apps/defi/.env.production:
   #   VITE_PUSH_CHANNEL_ADDRESS=<new EOA address>
   pnpm --filter @vaipakam/defi run deploy
   ```

   (`run` is required: bare `pnpm --filter <pkg> deploy` is pnpm's
   builtin portable-package command, not the package's script — #1478.)

   `deploy` builds as part of its own pipeline, so a separate `build` is
   redundant. Confirm afterwards that `/alerts` renders the subscribe
   link — the page treats an unset value as "no channel" and hides the link
   entirely, which looks like a deliberate design rather than a broken
   deploy.
5. Update the **Vaipakam Push channel reference** block at the top of this
   section, so the next incident does not cross-reference a dead channel.
6. Verify with `wrangler tail` on both Workers that a send actually
   SUCCEEDS — look for `[push] sent channel=…` carrying the new channel
   address. (The line deliberately does not name the subscriber: it fires on
   every notification, so carrying the wallet would leave a routine
   wallet-to-event trail in observability. The channel is the field a
   rotation changes, and it is all this check needs.) Two quiet tails are NOT
   confirmation: sends only happen
   when an eligible subscriber event occurs, so silence means "nothing has
   been attempted yet" and "every attempt is failing" equally. Wait for a
   real send, or trigger one, before calling the migration done.
7. Tell subscribers to re-subscribe (see **Communicate**). They are subscribed
   to the OLD channel and nothing migrates them.

**The old channel stays with the compromised key.** There is no way to take
it back, so assume the attacker can keep posting to the original subscriber
set until Push acts on an abuse report. That is the strongest argument for
announcing the migration loudly and quickly, and for the guard rail below
about never reusing this wallet.

**What #1456 changes.** It makes the channel id a configured value rather
than something derived from the key. Once it lands, the compromised key can
be replaced by `addDelegate`-ing a fresh sending EOA from the channel owner
and pointing `PUSH_CHANNEL_PK` at it — the channel id, the stake and every
subscriber stay put, and this whole section collapses to a two-line secret
swap. Until then, plan for migration. If a rotation is foreseeable rather
than an emergency, landing #1456 first is strictly better.

### How the keeper's arming flags are actually held

**An earlier version of this section had this backwards, and its advice
would have created the very hazard it warned about.** It is corrected here
rather than quietly deleted, because the reasoning is the useful part.

The claim was: a bare `wrangler deploy` of `apps/keeper` deletes
`KEEPER_ENABLED` and silently disarms the keeper, so always pass
`--keep-vars` — and better still, commit the flags into `wrangler.jsonc`'s
`vars`.

The `--help` text quoted in support of it is real and says what it was said
to say: *"When not used (or set to false), Wrangler will delete all vars
before setting those found in the Wrangler configuration."* The error was
in the premise, not the citation. **That sentence governs plain `vars`, and
`KEEPER_ENABLED` is not one.** Verified against the live deployment
(2026-07-30): on `vaipakam-keeper` it is a **`secret_text`** binding,
`KEEPER_PRIVATE_KEY` is a `secrets_store_secret`, and `TG_BOT_USERNAME` is
the only genuine `plain_text` var. Secrets are not rebuilt from the
committed config and a bare deploy does not touch them.

So: a bare keeper deploy does **not** disarm the keeper, `--keep-vars` is
not what protects it, and the recommendation to move the flags into `vars`
would have converted a binding that is currently safe into one that a later
bare deploy really would delete. It was the one change that could have made
the documented failure possible.

What the source of the confusion is, and it is worth knowing:
`apps/keeper/wrangler.jsonc` describes all three flags as
"operator-managed vars (non-secret config — plain `vars`)". The deployment
does not match that comment. **The comment is wrong, not the deployment** —
correcting it is #1465, which is now a comment fix rather than a config
change.

`--keep-vars` is left on the rotation steps above. It is harmless, it is
correct for `TG_BOT_USERNAME`, and a deploy flag that preserves state is
not worth removing under incident pressure — but do not treat it as the
thing keeping the keeper armed.

The readback below still matters, for a different reason than originally
given: not because a deploy may have deleted a flag, but because a rotation
may have set one wrong.

After **any** keeper redeploy, confirm the flags survived by reading the
deployed variables back — see `OffChainRestore.md` §7a step 4 for the
command and for the case-sensitivity trap between the two guards.


### Communicate
- Within 30 min of detection: post on official channels (X, Discord)
  that any unsolicited notifications since `<timestamp>` are not
  from Vaipakam, point at the genuine channel URL above, and
  describe the rotation in progress.
- Within 24h: post-mortem with root cause (worker secret leak vs.
  Push.org account takeover vs. transit interception) and
  preventive controls.

### Guard rails
- Never reuse the channel-owner wallet for any treasury or
  governance role.
- Audit `PUSH_CHANNEL_PK` access annually — Cloudflare lists every
  member of the account who can read secrets.
- Keep the channel-owner wallet's native-gas balance bounded
  (~$50 on each supported chain). An attacker who steals the privkey
  cannot drain serious value, only spam the brand.

---

## 5. LayerZero security alerts (lz-watcher) — RETIRED (#1440)

> **DO NOT FOLLOW THIS SECTION DURING AN INCIDENT.** The
> `vaipakam-lz-watcher` Worker was deleted on 2026-07-28 and its source
> tree removed; it emits no alerts, so nothing below can fire. The
> LayerZero transport it watched was retired by the T-068 CCIP migration
> and the contracts these SOPs tell you to pause are decommissioned —
> following them would send a responder down an obsolete path while the
> real incident continues.
>
> **Cross-chain ops alerting for CCIP does not exist yet** — that gap is
> tracked on #250 Phase 1 (Tenderly presets). For a suspected cross-chain
> problem today, the authoritative enumeration of the live pausable
> cross-chain set is **`contracts/script/pause-all-chains.sh`** — it names
> `ccipMessenger`, `buybackRemittanceReceiver` and
> `rewardRemittanceReceiver` alongside the mirror token.
>
> `contracts/RUNBOOK.md` §10 describes the pause MECHANICS, but its list is
> itself stale: it names the removed `VpfiBuyAdapter` / `VpfiBuyReceiver`
> and omits both remittance receivers, which are live and expose
> `whenNotPaused` CCIP ingress. Take the *how* from §10 and the *what* from
> the script, or a forged buyback or reward message stays executable.
>
> Deliberately NOT `AdminKeysAndPause.md`: that document describes the
> Diamond's `AdminFacet.pause()` and states explicitly that **CCIP ingress
> is not blocked by it** — so during a suspected message forge or
> unexpected mint it is the wrong lever, and reaching for it would leave
> the ingress path open (#1450 r4).
>
> Retained below as historical record of what was monitored and why.

<details>
<summary>Historical SOPs (retired — reference only)</summary>

The `ops/lz-watcher` Cloudflare Worker (separate from
`ops/hf-watcher`) fired
three alert kinds into the internal ops Telegram channel. Each
has its own SOP. All three are **detection-only** — there is no
automated response wired up. The watcher pages humans; humans
decide.

Alerts are deduped in the `lz_alert_state` D1 table: first fire
on transition to bad state, re-fire only when the offending
value changes or 1 hour has elapsed with the same value,
recovery clears the row + sends a one-time recovery ping. So a
persistent bad state at most pages once per hour, not once per
5-minute tick.

### 5.1 — `dvn_count` drift

#### Symptom
Telegram: `[lz-watcher] NEW dvn_count drift` (or `ESCALATED` /
`PERSISTENT` / `RECOVERED`) with chain name, OApp role + address,
peer eid, and `send` or `receive` side.

Body shows `Found: req=N opt=M th=K` vs. `Expected: req=3 opt=2
th=1`.

#### Detect
The watcher already detected it. Don't wait for the next tick —
treat the alert as authoritative and start verifying.

#### Diagnose
Pull the on-chain config directly:

```bash
cast call $LZ_ENDPOINT \
  "getConfig(address,address,uint32,uint32)(bytes)" \
  $OAPP $LIB $PEER_EID 2 \
  --rpc-url $RPC
```

Decode the returned bytes with `cast --abi-decode '(uint64,uint8,uint8,uint8,address[],address[])'`.
Compare to the policy in `contracts/script/ConfigureLZConfig.s.sol`'s
`_policyForChain`.

**Root-cause buckets:**
- **A. Accidental misconfiguration.** Someone ran `setConfig`
  manually (e.g. via a gov tx) without going through
  `ConfigureLZConfig.s.sol`. The DVN set is wrong but probably
  benign. Verify by checking who holds the OApp's delegate key
  on this chain — should be the timelock / multisig only.
- **B. Stale post-deploy state.** A new (OApp, eid) pair was
  added but `ConfigureLZConfig.s.sol` wasn't re-run for the new
  peer. Should never reach mainnet (the deploy runbook gates on
  it) but possible during testnet bring-up.
- **C. Delegate-key compromise.** The OApp delegate key signed a
  weakened config. **Treat as critical.** Pause every LZ-facing
  contract immediately (§3 emergency pause), then investigate.

#### Decide
| Bucket | Action |
|---|---|
| A or B (no compromise evidence) | Re-run `ConfigureLZConfig.s.sol` for the affected (OApp, eid) pair. Confirm watcher fires `RECOVERED` on next tick. |
| C (compromise evidence) | Pause the affected OApp via its `pause()` lever (callable by guardian or owner). Rotate the delegate key. Re-run `ConfigureLZConfig.s.sol` from a fresh delegate. Only unpause after `LZConfig.t.sol`-equivalent on-chain readback confirms policy + watcher fires `RECOVERED`. |

#### Execute
For bucket A/B:
```bash
export PRIVATE_KEY=...   # OApp delegate (timelock / multisig)
export OAPP=...          # affected OApp
export SEND_LIB=...
export RECV_LIB=...
export REMOTE_EIDS=$PEER_EID
export DVN_REQUIRED_1=...
# ... (full DVN env per the script docstring)
forge script script/ConfigureLZConfig.s.sol:ConfigureLZConfig \
  --rpc-url $RPC --broadcast
```

For bucket C, the pause lever sequence — from the guardian or
owner key on **each** affected LZ-facing contract:
```bash
cast send $OAPP "pause()" --rpc-url $RPC --private-key $PAUSER_KEY
```

#### Communicate
- Bucket A/B: post in the ops channel with the diagnosis +
  remediation tx hash. No public statement needed.
- Bucket C: status page within 30 min; full incident-response
  protocol kicks in (treat as a §3 emergency pause scenario).

#### Post-mortem
Within 72 h. Required even for bucket A/B — the watcher firing
means our `ConfigureLZConfig.s.sol`-as-single-source-of-truth
discipline has slipped. Document who ran the manual `setConfig`
and why the script wasn't used.

---

### 5.2 — `oft_imbalance` (CRITICAL)

This is the highest-severity alert in the whole system.
`VPFI.balanceOf(VPFIOFTAdapter)` on Base equalling
`sum(VPFIMirror.totalSupply())` across every mirror chain is an
exact invariant by construction — every legitimate cross-chain
transfer locks-and-mints or burns-and-unlocks an exactly equal
amount. **Any non-zero drift, even 1 wei, means cross-chain
messaging integrity has failed.**

#### Symptom
Telegram: `[lz-watcher] NEW oft_imbalance — CRITICAL`. Body
contains the Base-locked amount, sum of mirror supplies, signed
drift, and the per-chain mirror supply breakdown.

#### Detect
Already detected. Treat the alert as authoritative.

#### Decide (immediately)
**Pause every LZ-facing contract on every chain.** Do not pause
the user-facing Diamond — repayments and claims still need to
work. Pause:
- `VPFIOFTAdapter` on Base
- Every `VPFIMirror`
- `VPFIBuyAdapter` on every non-Base chain
- `VPFIBuyReceiver` on Base
- `VaipakamRewardOApp` on every chain

Each contract's `pause()` is callable by guardian or owner.

#### Execute
```bash
# In parallel, from the ops hot-key multisig — one tx per
# (chain, contract). Pre-batched in the ops Gnosis Safe template.
for chain in base eth arb op zkevm bnb; do
  cast send $CONTRACT "pause()" --rpc-url $RPC_$chain --private-key $PAUSER
done
```

#### Diagnose (after pause has landed)
Decide which side has the wrong number:
- Pull every `OFTSent` and `OFTReceived` event from every OFT
  contract for the past 24 h via subgraph or `eth_getLogs`.
- Reconcile sum-locked-on-Base against the mirror events. The
  side that doesn't match is the side that took the unauthorized
  mint or unlock.
- The watcher's own `oft_balance_history` D1 table holds 30 days
  of snapshots — useful to identify when drift first appeared.

Most likely root cause: a forged inbound LZ message that landed
on a mirror's `VPFIMirror._credit` (mint without a corresponding
Base lock) or on the canonical `VPFIOFTAdapter._credit` (unlock
without a corresponding mirror burn). Both paths are gated by
DVN verification + peer auth, so a successful forge implies
either DVN compromise or a peer-table compromise.

#### Communicate
- Status page within 30 min: "Cross-chain VPFI integrity check
  failed. All cross-chain transfers paused. User funds on Base
  are unaffected. Investigation in progress."
- Discord + Twitter links to the status post.
- Do **not** publish drift amount or affected chains until
  forensics is complete.

#### Post-mortem
Required within 72 h. Must include: forensics timeline (when
drift first observed, when the responsible event landed),
exact reconciliation amount, attacker addresses if applicable,
funding source for any user remediation, the DVN / peer / signer
hardening change committed to before unpause.

---

### 5.3 — `oversized_flow`

A single ERC20 `Transfer` event on a VPFI / VPFIMirror contract
moved more than the configured threshold (default 100,000 VPFI).
This is a **noisy** detector by design — legitimate large
transfers do happen, especially at protocol launch / when
governance moves treasury slugs. The right response is fast
verification, not automatic pause.

#### Symptom
Telegram: `[lz-watcher] NEW oversized_flow` with chain, contract,
tx hash, block number, from / to, value, threshold.

#### Detect
Already detected.

#### Diagnose
Pull the tx and its event log:
```bash
cast tx $TX_HASH --rpc-url $RPC
cast receipt $TX_HASH --rpc-url $RPC
```

Cross-reference:
- Does the same tx contain an `OFTSent` (mirror chain) or
  `OFTReceived` (Base) event from our adapter / mirror? If yes,
  this is a legitimate cross-chain transfer.
- Does the `from` address correspond to our treasury / governance
  multisig / a known operator wallet? If yes, treasury movement.
- Is the tx initiated by an unknown EOA, with no matching OFT
  event, moving to another unknown EOA? **Suspicious — escalate.**

#### Decide
| Pattern | Action |
|---|---|
| Legitimate cross-chain transfer (matching OFT event) | No action. Optionally raise the `FLOW_THRESHOLD_VPFI` env var if Phase 2 traffic produces frequent benign large transfers. |
| Treasury / governance movement | No action. Verify the tx sender is the documented multisig. |
| Suspicious — no matching OFT event, unknown counterparty | Escalate to the on-call security lead. Consider pausing the affected mirror / adapter while investigating. Cross-check with the `oft_imbalance` watcher's last reading — a true forge would also trip that detector within 5 minutes. |

#### Execute
No standard execute step. If escalating to pause, follow §5.2's
pause sequence for the affected chain only.

#### Communicate
Internal only unless §5.2 has also fired. The threshold is set
low enough that we expect periodic benign hits — do not
publicly comment on each one.

</details>

---

## 6. Aggregator adapter rotation lag (added 2026-05-08)

### Context

The Phase 7a swap-adapter chain has 0x in slot 0 because it usually
delivers the best fill on liquid pairs. The `ZeroExAggregatorAdapter`
holds an internal allowlist of permitted Settler call destinations,
because 0x's v2 architecture rotates Settler addresses with each
release while the AllowanceHolder stays canonical. This is by
design (per 0x's contracts documentation, "you should NEVER set an
allowance on the Settler contract") and the adapter splits the two
roles into immutable allowanceTarget + owner-managed allowlist.

When 0x ships a new Settler and the operator hasn't yet rotated the
allowlist, the on-chain liquidation path through 0x reverts with
`SwapTargetNotAllowed(<newSettler>)`. `LibSwap.swapWithFailover`
catches that revert and falls through to the next adapter in the
chain (1inch, then UniV3, then Balancer V2). The protocol stays
live; the symptom is a quiet decline in 0x-attributed liquidation
volume, not a user-facing outage.

### Trigger criteria (rotate allowlist; no pause needed)

This is NOT an emergency-pause class incident. It's a routine
governance task that becomes due every time 0x publishes a new
Settler.

### Symptom

- HF watcher / keeper-bot logs show repeated `SwapTargetNotAllowed`
  reverts on attempted 0x liquidations — the next adapter in the
  chain succeeds, so loans still close, but the slot-0 success rate
  trends to zero on fresh quotes.
- Cloudflare quote-proxy access logs show `transaction.to` values
  that don't match any address ever passed to
  `ZeroExAggregatorAdapter.addSwapTarget`.
- 0x's release feed (or `0x-settler` repo's deployment table)
  publishes a new Settler revision.

### Detect

On the affected chain's diamond:

```
adapterAt0 = AdminFacet(diamond).getSwapAdapters()[0]
ZeroExAggregatorAdapter(adapterAt0).swapTargetAllowed(<newSettler>)
  → false (the symptom)
ZeroExAggregatorAdapter(adapterAt0).swapTargetCount()
  → still equal to the prior count (no rotation has landed)
```

### Diagnose

Cross-reference:

- The `transaction.to` from a fresh
  `https://api.0x.org/swap/allowance-holder/quote` call against any
  active asset pair on the chain.
- The `0x-settler` repo's `deployer.ownerOf(...)` results for the
  Settler feature IDs the protocol consumes (currently:
  taker-submitted; metatransaction / intents / bridge are NOT in
  the keeper-bot's flow today and need not be in the seed).
- The chain's keeper-bot logs to confirm fresh quotes are still
  being fetched (rules out an upstream API outage masquerading as a
  rotation lag).

### Decide

If the new Settler matches what 0x officially published AND the
keeper-bot log shows `transaction.to` consistently pointing at it,
proceed with the rotation. If only some quotes use the new Settler
and others use the old one (parallel rollout), it is safe to add
the new one without removing the old.

### Execute

Per the Governance Runbook §6.2:

1. Schedule `ZeroExAggregatorAdapter.addSwapTarget(<newSettler>)`
   via the chain's Timelock (proposed by `GOVERNANCE_SAFE`).
2. Wait the 48h delay, then execute.
3. Verify `swapTargetAllowed(<newSettler>) == true` and
   `swapTargetCount` incremented by exactly 1.
4. (Later, after 0x deprecates the old Settler and the keeper-bot
   log shows zero stale-quote tail) schedule
   `removeSwapTarget(<oldSettler>)`. The adapter refuses to remove
   the last allowlisted entry, so a deprecation always requires
   `addSwapTarget` to land first.

### Communicate

Internal-only. This is not a user-affecting incident — fallback
adapters absorb the disruption transparently. Note in the rotation
log so the next on-call rotation knows when the most recent
Settler addition landed.

### Post-mortem

Routine action; no post-mortem required unless the rotation lag
actually caused a fallback-failure cascade (all 4 adapters reverted,
loan went `FallbackPending`). In that case follow §3 emergency-pause
triage instead.

### Guard rails

- The 48h Timelock delay applies to every rotation. If a Settler
  rotation is hitting the protocol so fast that the delay is a
  problem, the response is NOT to bypass the Timelock; it's to
  ensure the seed allowlist at deploy time is broad enough to
  cover the next rotation cycle.
- Never schedule `removeSwapTarget` on an adapter where
  `swapTargetCount == 1` — the call reverts with
  `LastSwapTargetCannotBeRemoved`, but a misfired schedule wastes
  the Timelock cycle. Always pair removals with a prior add.
- The same shape exists on `OneInchAggregatorAdapter`. 1inch v6
  doesn't currently rotate (single AggregationRouterV6 across all
  chains and the v6 lifecycle), so this section's playbook is
  primarily about 0x; 1inch rotation only applies if a v7 ships.

---

## 7. Sanctioned loan party — close-out behaviour (added 2026-06-29; #821-resolved 2026-06-30)

### Status — RESOLVED for repay / default / liquidation (#821)

The wind-down close-outs (`repayLoan` full, `triggerDefault`, HF-based and split
liquidation, the internal-match settlement) **no longer brick** when a loan party
is sanctions-flagged. They now complete via a vault-lock: the flagged party's
share is parked in their **own** per-user vault (frozen behind the live-claimant
screen), so the unflagged counterparty is made whole and a
`SanctionedProceedsLocked` event records each park. A flagged wallet's **position
NFT is frozen in place** — `VaipakamNFTFacet.transferFrom`/`safeTransferFrom`
reject a flagged `from`/`to` — so it can't be laundered to a clean wallet, while a
position transferred *before* a later flag (a legitimate buyer) is unaffected.

### Still expected to revert (by design)

- **`cancelOffer` for a flagged creator** — the refund returns the creator's OWN
  escrowed funds, so with no counterparty to make whole the revert IS the freeze.
  Recovery waits on the flag clearing. Not an incident.
- **A flagged wallet that holds its own live position** trying to `claim*` or
  `transfer` the NFT — frozen by design until delisted. Not an incident.

### Residual open work

The **completion** paths where a buyer is already committed
(`EarlyWithdrawalFacet.completeLoanSale` / `PrecloseFacet.completeOffset`) are the
one remaining deferred case — tracked as a `_CodeVsDocsAudit.md` finding (#831),
not a live operator concern. The full per-action matrix is in
[`docs/DesignsAndPlans/SanctionsAndTermsGateMatrix.md`](../DesignsAndPlans/SanctionsAndTermsGateMatrix.md).

### Diagnose / Decide

If a close-out unexpectedly reverts `SanctionedAddress(who)` post-#821, confirm
with `ProfileFacet.isSanctionedAddress(<party>)` for each party. A genuine stuck
case is now limited to `cancelOffer` (intentional) or the completion paths above —
recovery waits on the flag clearing, **not** an operator lever. This is a
**liveness** matter (funds parked, not lost/mis-routed); it does **not** warrant
an emergency pause. Do **not** route around the screen.

---

## Deployment log

Append here on every mainnet deploy / upgrade. Format: `YYYY-MM-DD  chain  tag  diamond-address  summary`.

| Date | Chain | Tag | Diamond | Notes |
|------|-------|-----|---------|-------|
|      |       |     |         |       |
