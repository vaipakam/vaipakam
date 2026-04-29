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

## 3. Emergency pause

### Trigger criteria (pause **immediately**, decide later)
- External exploit evidence (funds leaving user escrows, unexpected `LoanInitiated` events).
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
- `EscrowFactoryFacet.upgradeEscrowImplementation`
- Every `whenNotPaused`-less getter

See `PauseGatingTest` for the canonical list.

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
- Search wrangler logs for unexpected `[push] send` lines outside the
  cron schedule.
- Cross-reference the channel's recent broadcast history at
  <https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b>
  against our own send log.

### Execute — Telegram bot rotation
1. From `@BotFather`: `/revoke` → confirms token revocation. Old
   token stops working within seconds.
2. `/token` to issue a fresh token.
3. `cd ops/hf-watcher && npx wrangler secret put TG_BOT_TOKEN`
   → paste the new token.
4. Re-register the webhook:
   ```bash
   curl "https://api.telegram.org/bot<NEW_TG_BOT_TOKEN>/setWebhook" \
        --data-urlencode "url=https://alerts.vaipakam.com/tg/webhook"
   ```
5. `npm run deploy` to flush any in-memory clients tied to the old
   token.

No subscriber action required — the bot's @-handle stays
`@VaipakamBot`, only the API token rotates.

### Execute — Push channel signer rotation
1. From the **current** channel-owner wallet, log in to
   <https://app.push.org/> and open the channel admin page.
2. **Transfer channel ownership** to a fresh EOA you control. Push
   surfaces this as a transfer tx that hands the channel + remaining
   stake to the new owner. Wait for confirmation.
3. The new EOA's privkey replaces the old `PUSH_CHANNEL_PK`:
   ```bash
   cd ops/hf-watcher && npx wrangler secret put PUSH_CHANNEL_PK
   ```
4. `npm run deploy` to invalidate the cached PushAPI client (the
   worker module-scope cache rebuilds on next cron tick).
5. The channel **address** stays the same iff the channel itself is
   transferred (Push lets you change the signer, not the channel id).
   No frontend redeploy needed — `VITE_PUSH_CHANNEL_ADDRESS` is
   unchanged.
6. If transfer is impossible (compromised wallet refuses to sign),
   create a fresh Push channel from a clean EOA, update both
   `PUSH_CHANNEL_PK` (worker) **and** `VITE_PUSH_CHANNEL_ADDRESS`
   (frontend), redeploy both. Subscribers must re-subscribe to the
   new channel; communicate clearly.

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

## 5. LayerZero security alerts (lz-watcher)

The `ops/lz-watcher` Cloudflare Worker (separate from
`ops/hf-watcher` — see DeploymentRunbook.md §9 for setup) fires
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

---

## Deployment log

Append here on every mainnet deploy / upgrade. Format: `YYYY-MM-DD  chain  tag  diamond-address  summary`.

| Date | Chain | Tag | Diamond | Notes |
|------|-------|-----|---------|-------|
|      |       |     |         |       |
