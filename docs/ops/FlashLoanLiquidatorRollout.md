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
> change takes effect after `sudo systemctl try-restart vaipakam-keeper`, not on
> the next tick of a process that is already running. `try-restart` leaves a
> keeper that was stopped on purpose stopped; how to confirm the change took
> is [`KeeperMachine.md`](KeeperMachine.md) §6, "Apply an env-file change". Its log is
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

The key that counts is the one in the machine's env file
(`/etc/vaipakam/keeper.env`, [`KeeperMachine.md`](KeeperMachine.md)
§4), not a developer's local `.dev.vars`, which may hold a different
key or none. The machine carries no tool that turns a key into an
address (it has Node, but no Foundry and no keccak), so do it in two
steps that never move or print the key.

On a workstation with Foundry, from the record you provisioned the
machine from (its password-manager entry):

```bash
# Prompts for the key without echoing it, prints only the address.
cast wallet address --interactive
# Fingerprint of the same key, to compare with the machine's.
read -rs K && printf %s "$K" | sha256sum && unset K
```

On the keeper machine:

```bash
# Fingerprint of the key the keeper signs with; prints only a hash.
sudo sed -n 's/^KEEPER_PRIVATE_KEY=//p' /etc/vaipakam/keeper.env \
  | tr -d '\n' | sha256sum
```

The two fingerprints must match (paste the key in the same form, with
or without `0x`, as the env file holds it). Only then does the address
`cast` printed belong to the keeper, and it MUST equal
`KEEPER_BOT_OWNER` exactly.

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

Confirm the machine took it AND that the keeper is running it. A
switched `current` link alone proves neither: the restart is queued
until the current tick ends. On the machine (widen `--since` if the
merge was longer ago than that):

```bash
# 1. The update deployed the merged commit and queued a restart.
journalctl -u vaipakam-keeper-update --since "-30 min" | grep 'deployed '
#    Expect: "deployed <merged commit>; a running keeper restarts onto it
#    after its current tick". The other wording, "byte-identical ... so no
#    restart", means the bundle did not change, so the address is NOT in it.
# 2. The keeper started after that line, on that release.
journalctl -u vaipakam-keeper --since "-30 min" | grep '\[keeper-host\] started pid='
systemctl show -p ActiveEnterTimestamp --value vaipakam-keeper
cat /opt/vaipakam-keeper/current/SOURCE_COMMIT
```

The `started pid=` line and `ActiveEnterTimestamp` must both be later
than the `deployed` line, and `SOURCE_COMMIT` must be the merged
commit. No keeper Worker deploy is
involved. The Worker's `run deploy` still exists, but only as the
private database's migration applier, and its `scheduled` handler
runs nothing.

---

## 5. Flip the runtime env flag in the keeper

Two things must be true at runtime for the flash-loan branch to
fire:

- The on-chain kill-switch `discountPathEnabled` is `true`
  (precondition #2).
- The keeper's `DISCOUNT_PATH_CHAIN_IDS` setting names the chain:
  a comma list of decimal chain ids, such as `8453`.

The second is the bot's belt-and-suspenders: even if governance
flipped the on-chain flag prematurely, the bot still won't try
the discount path until you tell it to.

> **How the keeper sizes a run (#2697).** Every figure is measured.
> The Diamond's preview (`ForcedSaleFacet.previewDiscountedLiquidation`)
> gives the debt and the collateral the liquidation delivers, by the
> rule the liquidation itself uses. The keeper quotes the swap for
> exactly that seizure, and the FlashLoanLiquidator reads the preview
> again inside the liquidating transaction and flash-borrows exactly its
> debt. The run's least profit (`minProfit`) is the transaction's whole
> fee, converted by the Diamond into the principal token's own units, so
> a 6-decimal and an 18-decimal principal are each priced correctly. The
> liquidator reverts a run that would keep less, and the keeper
> simulates the run with that floor before sending, so an unprofitable
> run is skipped with its reason and never sent. Before
> #2697 the debt was the collateral amount and the gas a fixed `1e18`
> units of the principal; a keeper build older than #2697 must not be
> armed. On a chain whose gas the keeper cannot value (its wrapped native
> token or fee model is unknown, as on BNB Testnet), the path skips every
> loan and says so.

The setting replaced a per-chain `DISCOUNT_PATH_ENABLED_<chainId>`
flag that the keeper never read (#2633). A leftover line of that
name does nothing; remove it.

Set it in `/etc/vaipakam/keeper.env` as the line
`DISCOUNT_PATH_CHAIN_IDS=8453` (add other chains comma-separated) and
apply it by [`KeeperMachine.md`](KeeperMachine.md) §6, "Apply an
env-file change" (`sudo systemctl try-restart vaipakam-keeper`, then a
tick that began after the restart). Then do §6 below at once.

A value that cannot be read (an entry that is not a chain id, or a
chain named twice) arms no chain. Confirm it from two lines, because
they answer different questions:

- the `discount path:` line, logged once at every start: how the keeper
  read the setting, and for each armed chain the running build's route
  (`routes it via aave-v3` / `via balancer-v2`) or what is missing (no
  FlashLoanLiquidator, or no flash-loan provider in
  `flashLoanProviders.ts`);
- the `chains resolved:` line, logged every tick: whether the keeper
  serves that chain at all. A chain whose RPC or deployment is missing
  is not on it, and the branch never runs there.

```bash
journalctl -u vaipakam-keeper --grep 'discount path:' -n 1 --no-pager
journalctl -u vaipakam-keeper --grep 'chains resolved:' -n 1 --no-pager
```

Neither line reads the Diamond's own discount-path switch (Step 3);
that is read per loan.

On a chain with a route, each loan skipped because the chain is not
armed also logs `flash-loan-skip not-armed:` with the reason. A chain
with no route logs nothing per loan; the start-up line is where that
shows. No line echoes the setting's value.

**Why a separate keeper-side flag as well as the on-chain one**: the
on-chain switch is read per loan, as the preview's first check, and only
for loans that reach the branch; the keeper-side flag is the operator's
own affirmative step on top of it, and turning it off is a local edit:
remove the line (or leave it empty) and restart the keeper, and the
discount branch skips from the first tick after the restart.

---

## 6. Watch the logs + verify

```bash
journalctl -u vaipakam-keeper -f
```

Log entries to expect (in priority order — happy first, then
each common skip path):

| Log line | Meaning | Action |
|---|---|---|
| `submitted-flashloan tx=0x… via=aave-v3 swap=zeroex debt=… sell=… expected=… minProfit=…` | Happy path. Tx submitted: the previewed debt, the collateral the swap sells, the quoted proceeds and the least profit the run must keep. | Follow the hash on Basescan; confirm `FlashLoanLiquidationCompleted` fired with `netProfit` at least `minProfit`. |
| `flash-loan-skip not liquidatable: …` | The Diamond's preview rules the loan out, and names why: the protocol is paused, its discount-path switch is off, the loan is healthy or not Active, the sequencer breaker is tripped, the collateral has no liquidity tier, or a price is unavailable. | Healthy skip. The switch-off reason on an armed chain means governance has not flipped it (precondition #2). |
| `flash-loan-skip gas cannot be valued: …` | The keeper cannot price this chain's gas, or the Diamond cannot express it in the principal token. | The path cannot run on this chain; legacy branches handle the loan. |
| `flash-loan dex-direct quotes failed: zeroex,oneinch` then `flash-loan-skip no DEX-direct quote for the seizure` | Both aggregators failed to quote. | Asset isn't well-supported on this chain. Legacy partial/split/atomic falls through automatically. Nothing to do. |
| `flash-loan-skip unprofitable: quoted proceeds … do not exceed the debt …` | The quote does not even repay the debt. | Healthy skip. |
| `flash-loan-skip simulation reverted: …` | The exact call's gas estimate reverted before any profit floor, usually `InsufficientPostSwapBalance` (proceeds do not repay the flash loan and its fee) or `SeizureBelowQuote`. | Healthy skip — nothing was sent. |
| `flash-loan-skip does not net its fee of …: …` | The run repays the flash loan but would keep less than its own transaction fee, so the floored simulation reverted. | Healthy skip — nothing was sent. |
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

### Every loan skips with "the Diamond's discount-path switch is off"

You flipped the keeper-side flag (Step 5) before governance
flipped the on-chain flag (precondition #2). Since #2697 the keeper
reads the switch per loan, through the preview, and sends nothing
while it is off, so this costs no gas.

Wait for governance to land `setDiscountPathEnabled(true)`; the next
tick after it lands takes the path. There is no need to change the
keeper-side flag.

### Aggregator quote OK but tx reverts on-chain (price moved)

Symptom: `flash-loan-submit-failed err=execution reverted`. Log
will show one of:

- `InsufficientPostSwapBalance(needed, got)` — the swap didn't
  return enough principal to repay flash-loan + fee + the run's
  `minProfit`. Healthy revert — borrower state preserved, no damage.
- `SeizureBelowQuote(seized, sellAmount)` — the liquidation would
  deliver less collateral than the swap was quoted for (the
  collateral's price rose between the quote and the block). Healthy;
  the next tick re-quotes. If it repeats on every tick for one
  collateral, the token delivers less than it sends: the preview's
  seizure is then an upper bound on what arrives, so this path cannot
  size that loan, and the keeper's simulation skips it each tick
  without sending.
- `NotLiquidatable(loanId, status)` — the preview ruled the loan out
  by the time the transaction ran (another liquidator closed it, or
  the price recovered).
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
wasn't populated (Step 4 skipped), or the chain's entry has no
`aaveV3Pool` or `balancerV2Vault` (the testnet entries ship empty), or
the machine has not deployed the commit that populated them, or the
chain is not armed. A missing liquidator or provider is named only by
the start-up line: the branch checks its route first and returns
without a per-loan line, so as not to log for every loan on every
chain that has none. Once the route exists, each loan skipped because
the chain is not armed logs `flash-loan-skip not-armed:` with the
reason. Verify on the machine:

```bash
# How the keeper read the setting, from the parser the passes use, and
# each armed chain's route in the running build (or what is missing). A
# value it cannot read arms no chain and says so here, so this line, not a
# read of the env file, is the answer. Then whether it serves the chain
# at all (RPC and deployment present), from the latest tick. See Step 5.
journalctl -u vaipakam-keeper --grep 'discount path:' -n 1 --no-pager
journalctl -u vaipakam-keeper --grep 'chains resolved:' -n 1 --no-pager
# Per-loan not-armed skips, on a chain whose route exists, once a
# distressed loan has reached the branch:
journalctl -u vaipakam-keeper --since -10min | grep -m3 'flash-loan-skip not-armed'

# Confirm the running release carries the address. Search for the
# deployed FlashLoanLiquidator address itself, case-insensitively; a
# list of every address in the bundle is too long to read reliably.
cat /opt/vaipakam-keeper/current/SOURCE_COMMIT
grep -qi '<FlashLoanLiquidator address>' \
  /opt/vaipakam-keeper/current/keeper-host.mjs && echo present || echo absent
# Then confirm the keeper restarted onto that release (Step 4's checks).
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
   machine, no deploy, no governance: remove the chain from the
   `DISCOUNT_PATH_CHAIN_IDS` line in `/etc/vaipakam/keeper.env` (or
   leave the line empty), then `sudo systemctl try-restart vaipakam-keeper`.
   From the first tick after the restart the discount branch skips,
   and legacy partial/split/atomic still runs while the keeper is
   armed. The restart waits for the tick in flight
   ([`KeeperMachine.md`](KeeperMachine.md) §6).

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
