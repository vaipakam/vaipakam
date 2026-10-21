# apps/keeper Anvil scenario coverage

One row per keeper pass that has, or ought to have, an end-to-end scenario on a
local Anvil chain. The scenarios live under `e2e/scenarios/` (one chain) and
`e2e/mesh/scenarios/` (a canonical chain and a mirror). Each one drives
the keeper's REAL pass, called exactly as the scheduler calls it, against the
repository's CURRENT contracts deployed from source.

**Why this file and not `apps/app/e2e/COVERAGE.md`.** That matrix lists
user-facing features of the connected app, with a Playwright spec or a live
driver for each. A keeper pass is not an app surface, has no browser, and runs
under a different job. Putting its rows there would mix two audiences, and the
app's drift check would watch the wrong tree. So the keeper keeps its own
matrix beside its own scenarios.

## How to run

```bash
export PATH=/opt/node22/bin:$PATH        # Node 22 + pnpm
# forge and anvil on PATH (Foundry)
pnpm --filter @vaipakam/keeper run e2e:anvil
```

`e2e:anvil` runs two suites in turn, each with its own config and its own
fixture: the single-chain scenarios (`e2e:anvil:single`,
`e2e/vitest.config.ts`, under `e2e/scenarios/`) and the two-chain ones
(`e2e:anvil:mesh`, `e2e/vitest.mesh.config.ts`, under `e2e/mesh/scenarios/`).
They are separate because the keeper's deployments import is redirected to
ONE bundle per run, and the two suites' bundles name different Diamonds for
84532.

- **The single-chain global setup builds a fixture once.** It deploys the
  Diamond from source (the app's deploy, `packages/anvil-harness`). It then
  runs `contracts/script/e2e/ConfigureKeeperRewardsFixture.s.sol`, which turns
  the Diamond into a canonical reward chain. Finally it dumps the chain state
  into `e2e/.state/`, which is gitignored.
- **The two-chain global setup** (`e2e/mesh/fixture.ts`) builds two nodes the
  same way, one presenting Base Sepolia (84532) and one Sepolia (11155111),
  and wires them by running the operator scripts themselves — see "The
  two-chain harness" below. Its dumps go to `e2e/.state/mesh/`.
- **Each scenario starts its own node from that dump**, so no scenario sees
  another's transactions or time travel.
- **To reuse a fixture already built**, set `KEEPER_E2E_REUSE_FIXTURE=1`
  (either suite).
- **The node's port** defaults to 8645 and is set with
  `KEEPER_E2E_ANVIL_PORT`; the two-chain suite's start at 8745
  (`KEEPER_E2E_MESH_ANVIL_PORT`).
- **This suite is NOT part of the keeper's default `vitest run`.** That run's
  config does not include `e2e/`.
- **CI runs it in `.github/workflows/keeper-e2e.yml`** (job `keeper anvil
  scenarios`), when the keeper, the indexer, the shared packages or the
  contracts change. The job is not a required check.

**What is real and what is supplied:**

| Part of the run | What the scenario uses |
| --- | --- |
| Contracts, keeper pass, keeper's key and send path | **Real.** The key is an Anvil well-known development key. |
| Keeper's private database and the shared database | **Real migrations**, built in memory. |
| Indexer | **The real per-chain indexer pass** (`runChainIndexerForChain`), wherever a pass takes its candidates from indexer rows. Its network access is narrowed to the scenario node. |
| Clock | Only the process's `Date` is faked, and it is pinned to the chain head after every warp. |
| Ops alerts | **Captured.** No Telegram token is set, so they are logged as "not delivered" and asserted from that log. The one scenario that must see an alert RECORDED and then CLEARED (`mesh/scenarios/deliveryAwaiting.scenario.ts`) configures a placeholder bot token instead, and answers the keeper's one request to the Telegram API in-process (`opsBotSink`); no request leaves the machine. |
| Cross-chain lane (two-chain suite) | **Real CCIP contracts** on each node — `Router`, `RMNRemote` behind `RMNProxy`, `TokenAdminRegistry` with `RegistryModuleOwnerCustom`, the VPFI lock/release and burn/mint pools — wired by the operator scripts. **Supplied:** the two ramps where Chainlink's DONs sit (`contracts/script/e2e/E2ELocalCcip.sol`) and the relay that moves a message between nodes (`packages/anvil-harness/src/ccipLane.ts`). The relay delivers only a message a source on-ramp EMITTED, unchanged; it decides when a message lands, never what it says. |

## Matrix

| Pass (issue) | Status | Scenario | What it proves |
| --- | --- | --- | --- |
| Claim-horizon heartbeat (#2517 item 5) | **Covered** | `scenarios/rewardHorizonHeartbeat.scenario.ts` | **While the horizon is off:** the pass discovers both entries of a repaid loan into its private queue and sends nothing.<br><br>**Once an operator sets a 180-day horizon:** the next heartbeat starts each entry's clock (`RewardEntryHorizonStamped`). Heartbeats every 6 days, inside the 7-day observation gap, then reach `RewardEntryExpiryArmed`. Its notice start is exactly 180 days after the stamp, so no interval was dropped. They go on to `RewardEntryExpiryBegun` at least 90 days later, and then to `RewardEntryExpired`. Over the sweep the recycle bucket moves by exactly the ExpiredReward credits recorded in the accounting events (`VpfiRecycled`). No other credit class appears and nothing is consumed from the bucket.<br><br>**Throughout:** every one of those transactions is sent by the keeper. The settled entries leave the queue, and no ops alert is raised. |
| Sanctions-hold observer (#2515 item 6) | **Covered** | `scenarios/rewardSanctionsHold.scenario.ts` | **Discovery:** a lender has two clean reward days. Then the overlay's owner flags them. The pass finds the lender only through its screen over the loan parties the real indexer recorded, puts them on its watch list, and starts the evidence chain (`RewardSanctionsEvidenceRecorded`, sent by the keeper). The indexer projects that evidence back as an open chain.<br><br>**Observation:** hourly runs keep the chain unbroken, with the same `flaggedAt`. The loan is repaid along the way. The status reaches Confirmed only after the three-day window has been observed whole.<br><br>**Settlement:** in that same run the keeper settles. The two days earned before the flag are set apart (`RewardSanctionsHeldApart`, equal to `getSanctionsHeldReward`). The three days earned while flagged are forfeited to the recycle bucket (`VpfiRecycled`, ForfeitedReward), and `rewardSanctionsDayForfeited` agrees day by day. Over the settling pass the bucket moves by exactly that forfeited amount: the settlement is the pass's only credit, all of it ForfeitedReward, and nothing is consumed. The borrower forfeits nothing. Exactly one ops notice goes out, naming the settlement's amounts, and no fault alert. |
| Sanctions-hold staging retry, `resolveStagedDayPage` (#2515 item 6, optional part) | **Not covered** | — | A staging record exists only when a claim is delivered to ANOTHER chain's venue, so a single canonical chain cannot create one, and writing the staging rows by hand would test the keeper against an invented record. The two-chain harness below now exists and can carry such a claim; the scenario itself has not been written yet. Until it is, the keeper's unit tests (`test/rewardSanctionsHold.test.ts`, `test/rewardSanctionsNotices.test.ts`) remain its coverage. |
| Reward day close (#2612) | **Covered** | `mesh/scenarios/deliveryProof.scenario.ts` (through `mesh/rewardCycle.ts`, which every two-chain scenario runs) | **First run:** the real `runRewardDayClose` closes days 0 and 1 on both chains. On the mirror that is two `closeDay` sends paying the messenger's quoted lane fee; on Base, Base's own two reports. Base finalizes nothing, because the mirror's reports have not landed. **Second run, after the relay lands both reports:** Base finalizes both days on full coverage and broadcasts each. The relay lands both broadcasts on the mirror, which then knows both days' global pair. **Third run:** confirms them there and sends nothing. Every one of those transactions is the keeper's, to a Diamond: 2 on the mirror, 6 on Base. No ops alert is raised. The timing rules (grace, a late or re-sent broadcast, a mirror skipping a day Base already finalized, a refused call) are pinned by `test/rewardDayClose.test.ts` against fake chains. |
| Delivery proof (#2516 item 5) | **Covered** | `mesh/scenarios/deliveryProof.scenario.ts` | **The real cycle, two chains:** a loan on the mirror; the keeper's day-close pass closes days 0 and 1 on both chains and the relay lands both mirror reports on Base; the pass finalizes both on full coverage and broadcasts them; the keeper's own remit pass sends `remitRewardBudget` (its only transaction, signed by the keeper). Base's pool locks exactly the remitted VPFI, the lane carries it as one token leg, and the mirror pool mints exactly that — the mirror token's whole supply, resting in the mirror's reward-custody holder. The mirror's ingress records the packet, from Base, in a transport epoch not yet indexed.<br><br>**The pass:** the real indexer runs on both chains into the one shared database, then `runDeliveryProof`. It discovers the delivery from the indexer's rows, rebuilds the rooted day list from Base's reservation, and indexes it; the chain then shows the delivery WHOLE (every chunk landed, the epoch's index complete). Every transaction is the keeper's, to the mirror Diamond, and no ops alert is raised.<br><br>**Idempotence:** the next run sends nothing, and the delivery has left the open-work queue. |
| Delivery proof — the awaiting alert (#2516) | **Covered** | `mesh/scenarios/deliveryAwaiting.scenario.ts` | The same cycle, with the keeper run WITHOUT an RPC binding for Base, so it cannot rebuild the rooted list (it logs "cannot rebuild its list" for the packet) — a real misconfiguration, not a doctored chain. **Within ten minutes** of arrival nothing is raised. **Past ten minutes** (`AWAITING_ALERT_SEC`) `delivery-awaiting:11155111:all` is posted once, naming the packet, and recorded in the keeper's database; the keeper sent nothing. **With Base's binding restored** the next run indexes the delivery (whole on chain, every transaction the keeper's) and the alert's record is cleared without a new post. |

## The two-chain harness

`e2e/mesh/fixture.ts` builds it once per run:

1. Two nodes, each deployed from source (`deployFromSource`), presenting
   84532 and 11155111. Each chain's artifact lives under the gitignored
   `contracts/deployments/.forge-test/e2e-keeper-mesh/<slug>/`.
2. A local CCIP lane on each (`DeployE2ELocalCcip.s.sol`).
3. The operator scripts, unchanged (`E2EOperatorScripts.s.sol` only
   redirects where each writes its artifact): `DeployVPFIToken` on Base;
   `DeployCrosschain` and `ConfigureVPFIToken` on both; `ConfigureCcip` on
   both, each naming the other as its one lane; `ConfigureRewardReporter` on
   both (Base expecting reports from both chains, the mirror reporting to
   Base); `SetInteractionLaunch` on both with one shared day 0.
4. The admin steps no script performs (`ConfigureKeeperMeshFixture.s.sol`):
   reward custody activated on both; on Base, the reward pool funded and the
   keeper authorized to remit.

Each scenario then starts both nodes from the dumps (`e2e/mesh/mesh.ts`),
moves both clocks to one shared timestamp on every warp, and pins the
keeper's `Date` to it.

What it does NOT model: CCIP's commit and execution latency and its fee
market (the lane's fee is fixed, and a message lands when the scenario
relays it), RMN cursing, and a failed message's manual re-execution. A
relayed message that reverts on the destination fails the scenario rather
than sitting as a failed message.
