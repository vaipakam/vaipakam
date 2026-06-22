# Tenderly Alert Presets

Alerting scaffolding for the Vaipakam Diamond. Covers three incident classes:

1. **Loan-state drift** — unexpected status transitions (default, liquidation, fallback)
2. **Health-factor breach** — loans within the liquidation-adjacent band before a liquidator fires
3. **Oracle / feed health** — `StalePriceData` reverts, L2 sequencer transitions, Chainlink heartbeat drift

Presets live in [`alerts.yaml`](./alerts.yaml). Scheduled actions are TypeScript modules under [`lib/`](./lib/) and are compiled + deployed via the Tenderly CLI.

## Files

| File | Scope |
|---|---|
| [`alerts.yaml`](./alerts.yaml) | Protocol-side events on the Diamond + Timelock (loan-state drift, oracle health, diamond-paused, timelock activity). |
| [`alerts-crosschain-shared.yaml`](./alerts-crosschain-shared.yaml) | Cross-chain CCIP presets that apply on EVERY chain — CcipMessenger, VpfiPoolRateGovernor, VaipakamRewardMessenger + their ownership-drift catch-alls. |
| [`alerts-crosschain-mirror.yaml`](./alerts-crosschain-mirror.yaml) | Cross-chain presets that apply ONLY on mirror chains — VPFIMirrorToken + VpfiBuyAdapter. |
| [`alerts-crosschain-canonical.yaml`](./alerts-crosschain-canonical.yaml) | Cross-chain presets that apply ONLY on canonical Base — VpfiBuyReceiver. |

The three `alerts-crosschain-*` files together replace the legacy `ops/lz-watcher` Worker (decommissioned LayerZero V2 surface). See issue #250. They are split by chain role so each chain applies only the files that match its contract set — partial / wrong-role addresses would otherwise leave empty `contract:` lines that the Tenderly CLI rejects.

## Apply (per chain)

Tenderly alerts are scoped per contract, so every chain the Diamond runs on needs its own copy of each preset with the chain-specific addresses.

```bash
# Install once
npm install -g @tenderly/cli
tenderly login

# ── alerts.yaml (Diamond + Timelock — every chain) ───────────────────
export CHAIN=base-sepolia
export CHAIN_ID=84532
export DIAMOND_ADDRESS=0x...
export TIMELOCK_ADDRESS=0x...
envsubst < alerts.yaml > alerts.${CHAIN}.yaml
tenderly alerts apply --file alerts.${CHAIN}.yaml --project vaipakam

# ── alerts-crosschain-shared.yaml — apply on EVERY chain ─────────────
export CCIP_MESSENGER_ADDRESS=0x...
export VPFI_POOL_RATE_GOVERNOR_ADDRESS=0x...
export VAIPAKAM_REWARD_MESSENGER_ADDRESS=0x...
envsubst < alerts-crosschain-shared.yaml > alerts-crosschain-shared.${CHAIN}.yaml
tenderly alerts apply --file alerts-crosschain-shared.${CHAIN}.yaml --project vaipakam

# ── THEN apply the matching role-specific file: ──────────────────────
#
# On canonical Base:
export VPFI_BUY_RECEIVER_ADDRESS=0x...
envsubst < alerts-crosschain-canonical.yaml > alerts-crosschain-canonical.${CHAIN}.yaml
tenderly alerts apply --file alerts-crosschain-canonical.${CHAIN}.yaml --project vaipakam

# On every mirror chain (Ethereum, Arbitrum, Optimism, Polygon zkEVM, BNB):
export VPFI_MIRROR_TOKEN_ADDRESS=0x...
export VPFI_BUY_ADAPTER_ADDRESS=0x...
envsubst < alerts-crosschain-mirror.yaml > alerts-crosschain-mirror.${CHAIN}.yaml
tenderly alerts apply --file alerts-crosschain-mirror.${CHAIN}.yaml --project vaipakam
```

The deployment artifacts at `contracts/deployments/<chain-slug>/addresses.json` are the source of truth for each chain's set of cross-chain contract addresses. Apply EXACTLY the shared file + ONE role-specific file per chain — never both role files on the same chain.

## Secrets

Web3 Actions read per-chain values from Tenderly Action Secrets (not from env files) — set these once per project:

| Key                          | Value                                                        |
|------------------------------|--------------------------------------------------------------|
| `DIAMOND_ADDRESS`            | Diamond proxy address for the chain                          |
| `RPC_URL`                    | Public or Alchemy RPC for read calls                         |
| `SEQUENCER_UPTIME_FEED`      | Chainlink L2 uptime feed (L2 chains only)                    |
| `VPFI_BUY_RECEIVER_ADDRESS`  | Base-only — used by `count-stuck-vpfi.ts`                    |

## Severity → routing

| Tier | Meaning                                                     | Destination                 |
|------|-------------------------------------------------------------|-----------------------------|
| P0   | User funds at risk, or pause already tripped                | PagerDuty + #incidents      |
| P1   | Degraded service, no loss yet — page during business hours  | PagerDuty + #onchain        |
| P2   | Trend / anomaly to investigate next business day            | Slack-only (#onchain)       |

Cross-chain alerts (per the three `alerts-crosschain-*.yaml` files) route to an additional `slack-crosschain` channel for security-critical events (config drift on the messenger trust root, pool reassignments, ownership changes). **Wire `slack-crosschain` in the Tenderly project BEFORE applying these presets** — there is no automatic fallback. Several presets route ONLY to `slack-crosschain` (e.g. `ccip-messenger-channel-registered`, `vpfi-pool-rate-governor-rate-limits-changed`, `vpfi-buy-receiver-stuck-vpfi`), so a missing channel means those alerts have no destination at all. The Tenderly CLI rejects the apply with a clear error if the destination doesn't exist; that's the intended failure mode.

## Why these alerts and not others

- We do **not** alert on `LoanRepaid` — it's the happy path and firing for every repayment would drown the channel.
- We do **not** alert on every `LoanInitiated` — only on notional > rolling p99 (via `flag-large-loan.ts`), because small-notional loans are the steady-state volume.
- We do alert on `LiquidationFallback` at P0 — fallback means the 0x leg failed, which has a concrete economic cost (lower recovery than happy-path swap), and usually points to a config drift (0x proxy address stale, allowance target wrong) rather than user behaviour.
