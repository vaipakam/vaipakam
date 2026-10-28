# Tenderly Alert Presets

Alerting scaffolding for the Vaipakam Diamond. Covers three incident classes:

1. **Loan-state drift** — defaults, full HF liquidations, fallback entries
2. **Oracle health** — `StalePriceData` reverts
3. **Governance and pause** — timelock calls scheduled, the Diamond paused

Presets live in [`alerts.yaml`](./alerts.yaml). They are event and error filters only.

**There are no Tenderly Web3 Actions** (#2869). Four scheduled / per-transaction actions (a pre-liquidation health-factor watch, a feed-heartbeat warning, an L2 sequencer watch and a large-loan flag) and their `tenderly.yaml` manifest were retired on 2026-10-27: they could not be built, called functions and event shapes the Diamond no longer has, and could serve only one chain. Those four signals currently have no confirmed home; #2968 tracks each one, together with the liquidation shapes no preset covers.

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

Before generating anything, the script checks that every preset names an event or error its contract's ABI actually carries (the Diamond's combined ABI, `packages/contracts/src/diamondAbi.json`, or the governance timelock's, `packages/contracts/src/abis/VaipakamTimelock.json`), and refuses the run on any that does not: a drifted signature is accepted by Tenderly and then never fires. The check (`packages/contracts/scripts/tenderly-presets.mjs`, so the export needs the workspace's `node_modules`) parses the template as YAML, refuses a template with no presets or a preset missing its id, contract or signature, and compares signatures in canonical form, with struct parameters written as component tuples (`DiamondCut((address,uint8,bytes4[])[],address,bytes)`, not `tuple[]`). The check proves the signature exists, not that some code path emits it. A preset on a contract with no committed ABI would be printed as unchecked; today every preset is checked. The script fills all four placeholders and refuses the whole run, publishing nothing, if the template uses any other one (#2763: `${CHAIN_ID}` and `${TIMELOCK_ADDRESS}` used to reach Tenderly as literal text). A chain with no `timelock` in its artifact is skipped by name rather than given a governance alert that watches nothing. Address placeholders are quoted in the template, so a YAML 1.1 parser reads them as strings, not integers.

## ABIs for the Tenderly UI

To decode calls and events in Tenderly, paste the generated ABIs rather than a hand-kept copy: `packages/contracts/src/diamondAbi.json` for the Diamond and `packages/contracts/src/abis/VaipakamTimelock.json` for the timelock. `exportFrontendAbis.sh` writes both from the build. The pre-deploy gate (`predeploy-check.sh`) refuses a deploy while any committed per-contract ABI, the timelock's included, differs from the compiled contracts, and the package test fails when the Diamond's combined ABI differs from the facet ABIs it is built from. A hand-captured copy used to live under `docs/ops/tenderly-paste/`; it had drifted by thousands of entries and was removed (#2650).

## Severity → routing

| Tier | Meaning                                                     | Destination                 |
|------|-------------------------------------------------------------|-----------------------------|
| P0   | User funds at risk, or pause already tripped                | PagerDuty + #incidents      |
| P1   | Degraded service, no loss yet — page during business hours  | PagerDuty + #onchain        |
| P2   | Trend / anomaly to investigate next business day            | Slack-only (#onchain)       |

## Why these alerts and not others

- We do **not** alert on `LoanRepaid` — it's the happy path and firing for every repayment would drown the channel.
- We do **not** alert on `LoanInitiated` — new loans are the steady-state volume. (A large-loan flag is one of the open items in #2968.)
- We do alert on `LiquidationFallback` at P0 — fallback means every swap route failed, which delays the lender's recovery, and usually points to config drift (a stale adapter or router setting) rather than user behaviour.
