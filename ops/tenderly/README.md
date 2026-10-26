# Tenderly Alert Presets

Alerting scaffolding for the Vaipakam Diamond. Covers three incident classes:

1. **Loan-state drift** — unexpected status transitions (default, liquidation, fallback)
2. **Health-factor breach** — loans within the liquidation-adjacent band before a liquidator fires
3. **Oracle / feed health** — `StalePriceData` reverts, L2 sequencer transitions, Chainlink heartbeat drift

Presets live in [`alerts.yaml`](./alerts.yaml). Scheduled actions are TypeScript modules under [`lib/`](./lib/) and are compiled + deployed via the Tenderly CLI.

## Apply (per chain)

Tenderly alerts are scoped per contract, so every chain the Diamond runs on needs its own copy of each preset with that chain's `${CHAIN}`, `${CHAIN_ID}`, `${DIAMOND_ADDRESS}` and `${TIMELOCK_ADDRESS}`. Generate the copies with the export script, which reads each chain's `contracts/deployments/<slug>/addresses.json`:

```bash
# Install once
npm install -g @tenderly/cli
tenderly login

# From the repo root: every chain, or name the ones you want
bash contracts/script/exportTenderlyAlerts.sh base-sepolia arb-sepolia
cd ops/tenderly
for f in generated/alerts-*.yaml; do tenderly alerts apply --file "$f" --project vaipakam; done
```

The script fills all four placeholders and refuses the whole run, publishing nothing, if the template uses any other one (#2763: `${CHAIN_ID}` and `${TIMELOCK_ADDRESS}` used to reach Tenderly as literal text). A chain with no `timelock` in its artifact is skipped by name rather than given a governance alert that watches nothing. Address placeholders are quoted in the template, so a YAML 1.1 parser reads them as strings, not integers.

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
