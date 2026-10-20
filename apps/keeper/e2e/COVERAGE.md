# apps/keeper Anvil scenario coverage

One row per keeper pass that has, or ought to have, an end-to-end scenario on a
local Anvil chain. The scenarios live under `e2e/scenarios/`. Each one drives
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

- **Global setup builds a fixture once.** It deploys the Diamond from source
  (the app's deploy, `packages/anvil-harness`). It then runs
  `contracts/script/e2e/ConfigureKeeperRewardsFixture.s.sol`, which turns the
  Diamond into a canonical reward chain. Finally it dumps the chain state into
  `e2e/.state/`, which is gitignored.
- **Each scenario starts its own node from that dump**, so no scenario sees
  another's transactions or time travel.
- **To reuse a fixture already built**, set `KEEPER_E2E_REUSE_FIXTURE=1`.
- **The node's port** defaults to 8645 and is set with
  `KEEPER_E2E_ANVIL_PORT`.
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
| Ops alerts | **Captured.** No Telegram token is set, so they are logged as "not delivered" and asserted from that log. |

## Matrix

| Pass (issue) | Status | Scenario | What it proves |
| --- | --- | --- | --- |
| Claim-horizon heartbeat (#2517 item 5) | **Covered** | `scenarios/rewardHorizonHeartbeat.scenario.ts` | **While the horizon is off:** the pass discovers both entries of a repaid loan into its private queue and sends nothing.<br><br>**Once an operator sets a 180-day horizon:** the next heartbeat starts each entry's clock (`RewardEntryHorizonStamped`). Heartbeats every 6 days, inside the 7-day observation gap, then reach `RewardEntryExpiryArmed`. Its notice start is exactly 180 days after the stamp, so no interval was dropped. They go on to `RewardEntryExpiryBegun` at least 90 days later, and then to `RewardEntryExpired`, with the value credited to the recycle bucket.<br><br>**Throughout:** every one of those transactions is sent by the keeper. The settled entries leave the queue, and no ops alert is raised. |
| Sanctions-hold observer (#2515 item 6) | **Covered** | `scenarios/rewardSanctionsHold.scenario.ts` | **Discovery:** a lender has two clean reward days. Then the overlay's owner flags them. The pass finds the lender only through its screen over the loan parties the real indexer recorded, puts them on its watch list, and starts the evidence chain (`RewardSanctionsEvidenceRecorded`, sent by the keeper). The indexer projects that evidence back as an open chain.<br><br>**Observation:** hourly runs keep the chain unbroken, with the same `flaggedAt`. The loan is repaid along the way. The status reaches Confirmed only after the three-day window has been observed whole.<br><br>**Settlement:** in that same run the keeper settles. The two days earned before the flag are set apart (`RewardSanctionsHeldApart`, equal to `getSanctionsHeldReward`). The three days earned while flagged are forfeited to the recycle bucket (`VpfiRecycled`, ForfeitedReward), and `rewardSanctionsDayForfeited` agrees day by day. The borrower forfeits nothing. Exactly one ops notice goes out, naming the settlement's amounts, and no fault alert. |
| Sanctions-hold staging retry, `resolveStagedDayPage` (#2515 item 6, optional part) | **Not covered** | — | A staging record exists only when a claim is delivered to ANOTHER chain's venue. A single canonical chain cannot create one, so a scenario here would have to write the staging rows by hand, which tests the keeper against an invented record. It needs the two-chain harness described in the next row. Until then the keeper's unit tests (`test/rewardSanctionsHold.test.ts`, `test/rewardSanctionsNotices.test.ts`) remain its coverage. |
| Delivery proof (#2516 item 5) | **Blocked: needs a two-chain harness** | — | The pass works only on a MIRROR (`isCanonical` false). It proves or indexes reward-budget deliveries that a Base remit sent through CCIP, and it reads Base to rebuild a rooted day list. Canonical versus mirror is decided by `block.chainid`, so one node cannot host both. A faithful scenario needs everything listed below this table. Faking the delivery by impersonating the router with a hand-built packet would test the pass against invented packet contents, which is what `MeshThreeChainE2ETest`'s header warns against, so it was not done. |

**What a faithful delivery-proof scenario needs:**

- **Two Anvil nodes:** Base Sepolia (84532) and one mirror id.
- **On each node:**
  - `DeployDiamond` plus `DeployCrosschain` (CcipMessenger, the VPFI pools, and on the mirror `VPFIMirrorToken` and `RewardRemittanceReceiver`);
  - a local CCIP router, RMN proxy and token-admin registry (`contracts/lib/chainlink-local`; its simulator delivers within one chain, so it does not bridge two nodes as it stands);
  - `ConfigureCcip` and `ConfigureRewardReporter`, wiring the lane in both directions.
- **A relay in TypeScript.** It watches each router's send event and executes the message on the other node: the payload, plus the pool's lock/release and burn/mint.
- **The full remit cycle driven:** mirror `closeDay` → report relayed to Base → `finalizeDay` → the keeper's own `rewardBudgetRemit` → delivery relayed to the mirror.
- **Indexers for both chains**, then `runDeliveryProof` on the mirror.
- **The same harness would also unblock the staging-retry row.**
