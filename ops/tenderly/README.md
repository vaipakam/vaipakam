# Tenderly Alert Presets

Alerting scaffolding for the Vaipakam Diamond. Covers three incident classes:

1. **Loan-state drift** — unexpected status transitions (default, liquidation, fallback)
2. **Health-factor breach** — loans within the liquidation-adjacent band before a liquidator fires
3. **Oracle / feed health** — `StalePriceData` reverts, L2 sequencer transitions, Chainlink heartbeat drift

Presets live in [`alerts.yaml`](./alerts.yaml). Scheduled actions are TypeScript modules under [`lib/`](./lib/) and are compiled + deployed via the Tenderly CLI.

## Apply (per chain)

Tenderly alerts are scoped per contract, so every chain the Diamond runs on needs its own copy of each preset with the chain-specific `${DIAMOND_ADDRESS}` and `${TIMELOCK_ADDRESS}`.

```bash
# Install once
npm install -g @tenderly/cli
tenderly login

# For each chain:
export CHAIN=base-sepolia
export CHAIN_ID=84532
export DIAMOND_ADDRESS=0x...
export TIMELOCK_ADDRESS=0x...
envsubst < alerts.yaml > alerts.${CHAIN}.yaml
tenderly alerts apply --file alerts.${CHAIN}.yaml --project vaipakam
```

## Secrets

Web3 Actions read per-chain values from Tenderly Action Secrets (not from env files) — set these once per project:

| Key                        | Value                                                        |
|----------------------------|--------------------------------------------------------------|
| `DIAMOND_ADDRESS`          | Diamond proxy address for the chain                          |
| `RPC_URL`                  | Public or Alchemy RPC for read calls                         |
| `SEQUENCER_UPTIME_FEED`    | Chainlink L2 uptime feed (L2 chains only)                    |

## Severity → routing

| Tier | Meaning                                                     | Destination                 |
|------|-------------------------------------------------------------|-----------------------------|
| P0   | User funds at risk, or pause already tripped                | PagerDuty + #incidents      |
| P1   | Degraded service, no loss yet — page during business hours  | PagerDuty + #onchain        |
| P2   | Trend / anomaly to investigate next business day            | Slack-only (#onchain)       |

## Why these alerts and not others

- We do **not** alert on `LoanRepaid` — it's the happy path and firing for every repayment would drown the channel.
- We do **not** alert on every `LoanInitiated` — only on notional > rolling p99 (via `flag-large-loan.ts`), because small-notional loans are the steady-state volume.
- We do alert on `LiquidationFallback` at P0 — fallback means the 0x leg failed, which has a concrete economic cost (lower recovery than happy-path swap), and usually points to a config drift (0x proxy address stale, allowance target wrong) rather than user behaviour.
