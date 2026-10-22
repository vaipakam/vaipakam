# FlashLoanLiquidator — Per-Chain Rollout Runbook

Operational walkthrough for activating Vaipakam's flash-loan-funded
discount-path liquidation on a new chain. Phase 3 of
[`docs/DesignsAndPlans/FlashLoanLiquidationPath.md`](../DesignsAndPlans/FlashLoanLiquidationPath.md).

The contracts + keeper-bot wiring shipped 2026-05-14 (commits
`a63d5ef`, `ee8a773`, `43e5b8f`). What remains is the per-chain
deploy + keeper-config flow this runbook documents. Repeat once per
target chain (testnet → mainnet, lowest-TVL first).

All commands run from `contracts/` unless noted otherwise.

> **Where the keeper runs.** Since #2504 the keeper runs as one long-lived
> process on an always-on machine, not as a Cloudflare Worker, and from #2569
> the Worker's `scheduled` handler declines every invocation. So every keeper
> setting this runbook names is a line in the machine's env file,
> `/etc/vaipakam/keeper.env`, which the keeper reads only when it starts: a
> change takes effect after `sudo systemctl restart vaipakam-keeper`, not on
> the next tick of a process that is already running. Its log is
> `journalctl -u vaipakam-keeper`. How to start, stop and arm the keeper is
> stated in one place, [`KeeperMachine.md`](KeeperMachine.md) §5 ("Start
> disarmed, validate, then arm") and §6 ("Stop, roll back, move hosts"); this
> runbook links there rather than restating it.
>
> Every "on next tick" statement below means the next tick of a keeper that
> is running on the machine and armed. The liquidator pass, including the
> legacy partial / split / atomic branches this runbook falls back to, returns
> at once while `KEEPER_ENABLED` is not `true`, and a disarmed tick can still
> log `liquidator done`. Treat our own liquidation coverage as manual after
> any start, restart, arming or host move until the **five-point** stand-down
> check in [`IncidentRunbook.md`](IncidentRunbook.md) §3.5 passes: the keeper
> running and holding the lease, the expected chain set resolved, a liquidator
> pass with no `skipped:` line, a `scan complete` line for every expected
> chain, and then a LATER tick reporting `atRisk=0` on every one of them.
> `submitted` counts BROADCASTS, not confirmations, so equality on a single
> tick does not mean the liquidations landed; the later zero-risk scan is what
> settles it.

---

## 0. Preconditions

Three things must already be true before you touch a chain:

1. **Audit sign-off** — the auditor has reviewed both the
   autonomous tier-LTV layer AND the discount path
   (`triggerLiquidationDiscounted` + `FlashLoanLiquidator`).
2. **Governance has flipped the on-chain kill-switch** —
   `ConfigFacet.setDiscountPathEnabled(true)` has been executed
   on the target chain's diamond. ADMIN_ROLE pre-handover;
   TimelockController-gated (48h delay) post-handover. Until this
   lands, every `triggerLiquidationDiscounted` reverts
   `DiscountPathDisabled` no matter what the keeper does.
3. **Keeper EOA gas funds** on the chain. Flash-loan txs cost
   ~600k gas (vs ~400k for the atomic path) because the swap
   happens inside the receiver. Top up before flipping the
   keeper-side flag in Step 5.

Skip any of these and you'll either revert every tx (and waste
gas) or expose the discount path before audit clearance.

---

## 1. Set deploy-side env vars

Edit `contracts/.env` and add (Base mainnet shown — see the
[multi-chain table](#multi-chain-address-table) for other
chains). The user has already prefilled the Base mainnet trio
in `contracts/.env.example` at lines 312–323; copy to `.env`:

```bash
# The EOA the keeper bot will sign txs from.
# CRITICAL: this MUST be the public address derived from the
# KEEPER_PRIVATE_KEY the keeper signs with (the machine's env file,
# docs/ops/KeeperMachine.md §4).
# If they don't match, the deployed FlashLoanLiquidator will reject
# every liquidateViaAaveV3 call with `NotOwner`.
KEEPER_BOT_OWNER=0x...

# Aave V3 Pool address on this chain. From aave.com/docs/resources/addresses.
BASE_AAVE_V3_POOL=0xA238Dd80C259a72e81d7e4664a9801593F98d1c5

# Balancer V2 Vault. Canonical CREATE2 address — same on every
# chain Balancer V2 is deployed on.
BASE_BALANCER_V2_VAULT=0xBA12222222228d8Ba445958a75a0704d566BF2C8
```

**Sanity check before Step 2** — derive the public address from
the keeper's `KEEPER_PRIVATE_KEY` and confirm it
matches `KEEPER_BOT_OWNER` *exactly*. The mismatch case is the
#1 silent-failure mode of this rollout.

```bash
# One-liner: derive the address from the private key without
# exposing the key (reads from .env, prints just the address).
# Use cast or any keystore tool the operator prefers.
cast wallet address --private-key $(grep ^KEEPER_PRIVATE_KEY \
  ../apps/keeper/.dev.vars 2>/dev/null | cut -d= -f2-)
# Compare against $KEEPER_BOT_OWNER. They MUST be identical.
```

---

## 2. Deploy `FlashLoanLiquidator`

```bash
forge script script/DeployFlashLoanLiquidator.s.sol:DeployFlashLoanLiquidator \
  --rpc-url $VITE_BASE_RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY \
  -vv
```

What it does:

- Reads `KEEPER_BOT_OWNER` + `BASE_AAVE_V3_POOL` +
  `BASE_BALANCER_V2_VAULT` from env.
- Reads the diamond address from
  `contracts/deployments/base/addresses.json` (must already
  exist — this is the live Vaipakam deploy on Base).
- Constructor enforces `owner != 0`, `diamond != 0`,
  at-least-one-provider — the script reverts at deploy-time if
  env is misconfigured.
- Deploys one new `FlashLoanLiquidator` contract.
- Writes the deployed address back into
  `contracts/deployments/base/addresses.json` under the new
  `flashLoanLiquidator` field, via
  `Deployments.writeFlashLoanLiquidator`.

**Verification:**

```bash
# 1. addresses.json carries the new field.
jq '.flashLoanLiquidator' contracts/deployments/base/addresses.json

# 2. The on-chain contract reports the right immutables.
cast call $FLL_ADDRESS "OWNER()(address)"             --rpc-url $VITE_BASE_RPC_URL
cast call $FLL_ADDRESS "DIAMOND()(address)"           --rpc-url $VITE_BASE_RPC_URL
cast call $FLL_ADDRESS "AAVE_V3_POOL()(address)"      --rpc-url $VITE_BASE_RPC_URL
cast call $FLL_ADDRESS "BALANCER_V2_VAULT()(address)" --rpc-url $VITE_BASE_RPC_URL
# Each should match what you put in step 1.

# 3. Etherscan verification picked up — the constructor args show
# all four values plainly on the explorer.
```

---

## 3. Refresh the consolidated deployments JSON

```bash
bash contracts/script/exportFrontendDeployments.sh
```

What it does:

- Merges every `contracts/deployments/<slug>/addresses.json` into
  the single `packages/contracts/src/deployments.json` keyed by
  chainId.
- The new `flashLoanLiquidator` field on Base flows into the
  merged record automatically — the `Deployment` TypeScript
  interface added the slot in the same morning's commit, so
  consumers see it on next bundle.

**Verification:**

```bash
git diff packages/contracts/src/deployments.json
# Should show the new `"flashLoanLiquidator": "0x..."` line under
# the chainId you just deployed to (e.g. "8453" for Base).
```

Run all four downstream typechecks to confirm nothing else
shifts:

```bash
pnpm --filter @vaipakam/app    exec tsc -b --noEmit
pnpm --filter @vaipakam/keeper  exec tsc -p . --noEmit
pnpm --filter @vaipakam/indexer exec tsc -p . --noEmit
pnpm --filter @vaipakam/agent   exec tsc -p . --noEmit
```

All four must exit 0.

---

## 4. Hand-edit `flashLoanProviders.ts`

Open [`apps/keeper/src/flashLoanProviders.ts`](../../apps/keeper/src/flashLoanProviders.ts)
and populate the `liquidator` slot for the chain you just
deployed to:

```typescript
// Base mainnet
8453: {
  aaveV3Pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  balancerV2Vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  liquidator: '0x<paste-from-step-2>',  // ← new
},
```

**Why this is a separate hand-edit and not derived from
`getDeployment(chainId).flashLoanLiquidator`**: the keeper bot
reads a TS-typed config at module-load time. Keeping the
`(aaveV3Pool, balancerV2Vault, liquidator)` triple together in
one file makes the cross-cutting concern reviewable in one
place. It's also a tactical override surface — to disable the
flash-loan path on a chain without redeploying anything, just
delete the `liquidator` line (the chain falls back to legacy
partial/split/atomic on the first tick that runs the new code;
those branches act only while the keeper is armed, see the note at
the top of this runbook).

Commit the change and merge it to `main`. A merge to `main` is the
keeper's deploy: the machine's update timer deploys the branch's
latest commit within about five minutes and restarts the keeper onto
it ([`KeeperMachine.md`](KeeperMachine.md) §1). While deploys are
paused on the machine (§6 there), a merge does not reach it.

```bash
git add apps/keeper/src/flashLoanProviders.ts
git commit -m "apps/keeper: populate Base FlashLoanLiquidator address"
```

Confirm the machine took it: `readlink /opt/vaipakam-keeper/current`
names the merged commit's release. No keeper Worker deploy is
involved. The Worker's `run deploy` still exists, but only as the
private database's migration applier, and its `scheduled` handler
runs nothing.

---

## 5. Flip the runtime env flag in the keeper

Two things must be true at runtime for the flash-loan branch to
fire:

- The on-chain kill-switch `discountPathEnabled` is `true`
  (precondition #2).
- The keeper's `DISCOUNT_PATH_ENABLED_<chainId>` setting is
  literally the string `"true"`.

The second is the bot's belt-and-suspenders: even if governance
flipped the on-chain flag prematurely, the bot still won't try
the discount path until you tell it to. Set it on the machine, in
`/etc/vaipakam/keeper.env` (`sudo -e /etc/vaipakam/keeper.env`),
as the line `DISCOUNT_PATH_ENABLED_8453=true`, then restart the
keeper with `sudo systemctl restart vaipakam-keeper`. The keeper
reads the env file only when it starts, and the restart waits for
the tick in flight to finish ([`KeeperMachine.md`](KeeperMachine.md)
§6). Never paste a value from that file anywhere.

> **⚠ Known gap (#2570): the keeper does not read this setting
> today.** The pass looks the flag up on the keeper's resolved
> settings, and `resolveEnv` in `apps/keeper/src/env.ts` copies a
> fixed list of names into those settings. `DISCOUNT_PATH_ENABLED_<chainId>`
> is not on that list, so the lookup finds nothing on either host and
> the flash-loan branch stays off whatever the env file says. That is
> the safe direction, but it means setting the line above changes
> nothing until the code carries the flag through. Do not read the
> absence of `submitted-flashloan` lines in §6 as an unprofitable
> market until it does.

**Why a separate keeper-side flag rather than reading the
on-chain flag every tick**: cost. An on-chain read every tick ×
every chain × every loan would burn thousands of RPC calls per
day. Turning the keeper-side flag off is a local edit: remove the
line (or leave it empty) and restart the keeper, and the discount
branch skips from the first tick after the restart.

---

## 6. Watch the logs + verify

```bash
journalctl -u vaipakam-keeper -f
```

Log entries to expect (in priority order — happy first, then
each common skip path):

| Log line | Meaning | Action |
|---|---|---|
| `submitted-flashloan tx=0x… via=aave-v3 swap=zeroex expected=…` | Happy path. Tx submitted. | Follow the hash on Basescan; confirm `FlashLoanLiquidationCompleted` event fired with non-zero `netProfit`. |
| `flash-loan-skip no-dex-direct-quotes (failed: zeroex,oneinch)` | Both aggregators failed to quote. | Asset isn't well-supported on this chain. Legacy partial/split/atomic falls through automatically. Nothing to do. |
| `flash-loan-skip unprofitable: proceeds=X < needed=Y …` | Simulation said trade wouldn't clear. | Healthy — bot correctly skipped a loss-making submission. |
| `flash-loan-skip direct-quote-unprofitable: …` | Re-fetched DEX-direct quote (with receiver as taker) came in lower than the initial sim. | Same as above — healthy skip. |
| `flash-loan-submit-failed err=…` | Submission reverted on-chain. | Read the revert reason carefully (see [troubleshooting](#troubleshooting)). |

After 1–2 weeks of healthy `submitted-flashloan` entries on the
chain, promote to the next one (repeat Steps 1–6).

---

## Multi-chain address table

Aave V3 Pool addresses verified against
[Aave's official deployment registry](https://aave.com/docs/resources/addresses).
Balancer V2 Vault is the canonical CREATE2 address
`0xBA12222222228d8Ba445958a75a0704d566BF2C8` on every chain
Balancer V2 is deployed on; BNB Chain has no Balancer V2 per
[docs.balancer.fi](https://docs.balancer.fi).

| Chain | chainId | Aave V3 Pool | Balancer V2 Vault |
|---|---|---|---|
| Ethereum | 1 | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | `0xBA12…F2C8` |
| Base | 8453 | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0xBA12…F2C8` |
| Arbitrum One | 42161 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xBA12…F2C8` |
| Optimism | 10 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xBA12…F2C8` |
| BNB Chain | 56 | `0x6807dc923806fE8Fd134338EABCA509979a7e0cB` | *(none — Balancer V2 not deployed)* |
| Polygon PoS | 137 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xBA12…F2C8` |

Mirror these into `contracts/.env` per the per-chain prefix
convention used by `DeployFlashLoanLiquidator.s.sol`:

| Chain | Env var prefix |
|---|---|
| Ethereum | `ETH_AAVE_V3_POOL`, `ETH_BALANCER_V2_VAULT` |
| Base | `BASE_AAVE_V3_POOL`, `BASE_BALANCER_V2_VAULT` |
| Arbitrum | `ARB_AAVE_V3_POOL`, `ARB_BALANCER_V2_VAULT` |
| Optimism | `OP_AAVE_V3_POOL`, `OP_BALANCER_V2_VAULT` |
| BNB Chain | `BNB_AAVE_V3_POOL` (no Balancer) |
| Polygon | `POLYGON_AAVE_V3_POOL`, `POLYGON_BALANCER_V2_VAULT` |

---

## Recommended rollout order

The 6 steps are per-chain; do them six times for the full
mainnet target set. Sequencing:

1. **Testnet first** — Base Sepolia. Full dry-run including the
   audit-style log review. Catches any env-var typo before
   mainnet exposure. Aave V3 testnet Pool address is different
   per network; check Aave's testnet docs.
2. **One mainnet at a time** — start with the chain that has
   the smallest TVL on Vaipakam (least catastrophic if something
   goes wrong). Probably Optimism or BNB Chain.
3. **Wait 1–2 weeks per chain** between promotions — gives
   organic distressed loans time to surface and exercise the
   flash-loan branch.
4. **Ethereum mainnet last** — highest gas, highest scrutiny.

---

## Troubleshooting

### Every `liquidateViaAaveV3` reverts with `NotOwner`

The `KEEPER_BOT_OWNER` env var you used at deploy-time doesn't
match the address derived from the keeper's `KEEPER_PRIVATE_KEY`.
Step 1's mismatch — no on-chain damage done, just redeploy:

```bash
# Fix .env first, then:
forge script script/DeployFlashLoanLiquidator.s.sol:DeployFlashLoanLiquidator \
  --rpc-url $VITE_BASE_RPC_URL --broadcast --verify
# Re-run Step 3 (export deployments), Step 4 (update
# flashLoanProviders.ts to the NEW address), Step 5 (no change).
```

The old contract becomes orphaned on-chain (no longer
referenced). Etherscan-tag it as "deprecated" if you want; no
on-chain cleanup is needed.

### Every tx reverts with `DiscountPathDisabled`

You flipped the keeper-side flag (Step 5) before governance
flipped the on-chain flag (precondition #2). The keeper happily
submits txs that the diamond rejects.

Snap it off on the machine: remove the `DISCOUNT_PATH_ENABLED_8453`
line from `/etc/vaipakam/keeper.env` (or leave it empty) and run
`sudo systemctl restart vaipakam-keeper`. The restart waits for the
tick in flight, so it takes as long as that tick does, not a fixed
30 seconds.

Wait for governance to land `setDiscountPathEnabled(true)`,
verify with:

```bash
cast call $DIAMOND_BASE "getProtocolConfigBundle()" \
  --rpc-url $VITE_BASE_RPC_URL | grep -i discount
```

…then re-flip the keeper-side flag.

### Aggregator quote OK but tx reverts on-chain (price moved)

Symptom: `flash-loan-submit-failed err=execution reverted`. Log
will show one of:

- `InsufficientPostSwapBalance(needed, got)` — the swap didn't
  return enough principal to repay flash-loan + fee. Healthy
  revert — borrower state preserved, no damage.
- `SwapFailed` — the aggregator's swap call itself reverted
  (price moved past slippage tolerance between quote and
  submit). Also healthy.

No action needed while the keeper is running and armed. The legacy
partial/split/atomic branches in the keeper run on the next tick — the
loan still gets liquidated, just via the atomic path instead. If the
keeper is stopped or disarmed (`KEEPER_ENABLED` not `true`), there is no
fallback from us: the loan depends on external liquidators. See the note
at the top of this runbook.

### Profitable trades available but bot logs nothing

Probably the `liquidator` slot in `flashLoanProviders.ts`
wasn't populated (Step 4 skipped), or the machine has not deployed
the commit that populated it, or the keeper-side flag is not reaching
the pass (see the known gap in Step 5, which on its own produces
exactly this symptom). Verify on the machine:

```bash
# Confirm the flag line is present (prints the name only, not the value).
sudo grep -o '^DISCOUNT_PATH_ENABLED_[0-9]*' /etc/vaipakam/keeper.env

# Confirm the running release carries the address:
readlink /opt/vaipakam-keeper/current
grep -o '0x[0-9a-fA-F]\{40\}' /opt/vaipakam-keeper/current/keeper-host.mjs | sort -u | head
# The FlashLoanLiquidator address should appear in the bundle.
```

### Bot submits flash-loan txs but every one fails with `OracleStaleForDiscount`

Oracle quorum stale for either the principal or collateral
asset at the moment of the call. The diamond's
`LibFallback.collateralEquivalent` returned 0, so the
discount-path settlement reverted before any tokens moved.

Legacy fallback handles it (`triggerLiquidation` has its own
oracle-stale path → claim-time settlement). No keeper-side
action; investigate whether Chainlink / Tellor / API3 are all
healthy on the chain for those assets.

---

## Snap-off ("incident") procedure

To disable the flash-loan branch on a chain INSTANTLY, in
order of preference (least to most disruptive):

1. **Remove the keeper-side env flag** — a local edit on the
   machine, no deploy, no governance: delete the
   `DISCOUNT_PATH_ENABLED_8453` line from `/etc/vaipakam/keeper.env`
   (or leave it empty), then `sudo systemctl restart vaipakam-keeper`.
   From the first tick after the restart the discount branch skips,
   and legacy partial/split/atomic still runs while the keeper is
   armed. The restart waits for the tick in flight
   ([`KeeperMachine.md`](KeeperMachine.md) §6). Until the Step 5 known
   gap is fixed, this changes nothing, because the keeper never reads
   the flag: the branch is already off.

2. **Delete the `liquidator` line in `flashLoanProviders.ts`**
   and merge — slower (needs a merge to `main`, then the machine's
   update timer, up to about five minutes, and deploys must not be
   paused) but needs no shell on the machine.

3. **Flip the on-chain kill-switch** —
   `ConfigFacet.setDiscountPathEnabled(false)`. Disables for
   EVERY caller (us + external liquidators). Use when an
   exploit-class issue surfaces, not for routine disable. Post-
   handover this needs a Timelock-scheduled 48h-delayed
   transaction — slow path.

Order matters: items 1 and 2 affect only our bot. Item 3 affects
the whole open market and should only fire on a real incident.

**To stop external callers of the discounted path now**, the levers
differ before and after the admin handover. **Pre-handover**,
`ConfigFacet.setDiscountPathEnabled(false)` is a direct `ADMIN_ROLE`
call with no delay: it disables the discounted path immediately and
only that path, so reach for it rather than the global pause.
**Post-handover** it carries the Timelock's 48h delay, which makes it
the eventual targeted control; the immediate on-chain stop is then the
global protocol pause in [`IncidentRunbook.md`](IncidentRunbook.md) §3.
`AdminFacet.pauseAsset` is **not** a lever here: it blocks new exposure
only, liquidation is deliberately exempt so existing positions can
always be closed out, and `triggerLiquidationDiscounted` stays fully
callable by external liquidators. Full tier breakdown in
[`IncidentRunbook.md`](IncidentRunbook.md) §3.5.

---

## Related runbooks + sibling rollout

- [`AdminConfigurableKnobsAndSwitches.md`](AdminConfigurableKnobsAndSwitches.md)
  — broader index of every governance lever.
- [`IncidentRunbook.md`](IncidentRunbook.md) — emergency
  response playbook, including pause / unpause sequences.
- [`DeploymentRunbook.md`](DeploymentRunbook.md) — the canonical
  per-chain deploy order this runbook slots into.
- **Depth-tiered-LTV per-chain rollout** (sibling — same shape,
  different kill-switch). The same 6-step pattern this runbook
  documents for `discountPathEnabled` applies in parallel for
  `depthTieredLtvEnabled`; the audit covers both layers together.
  Differences:
  - The depth-tier flip additionally requires running
    [`contracts/script/ConfigureV2Factories.s.sol`](../../contracts/script/ConfigureV2Factories.s.sol)
    per chain to wire the Uni-V2-fork pools into the route search
    (canonical addresses are built into the script; per-chain
    overrides via env). Without this, long-tail / mid-cap assets
    under-tier.
  - No off-chain receiver contract to deploy — the depth-tier
    init gate is internal to the diamond.
  - Decision flow / governance gating documented in
    [`docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md`](../DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md)
    §4.4.
  - Master kill-switch is independent — governance can flip
    `depthTieredLtvEnabled` and `discountPathEnabled` on different
    chains / different timelines.
- [`../internal/PendingTasks-2026-05-14.md`](../internal/PendingTasks-2026-05-14.md)
  — full inventory of operational follow-ups across both rollouts
  + the older `docs/ToDo.md` backlog.
