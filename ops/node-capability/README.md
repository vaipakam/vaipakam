# Node capability check (#3913)

What the node behind each network's `RPC_*` can answer, written down per
network so that two parts of the troubleshooting picture
(`docs/DesignsAndPlans/TroubleshootingPictureDesign.md`, section 4.3) read
it instead of assuming it:

- the **failed transaction record** picks its mode per network from
  `failedTransactionMode`: `trace-filter` when the node answers a trace
  filter over at least 100 blocks, `block-scan` otherwise;
- the **transaction explainer** reads `explainer.traceSource` (the node's own
  trace, or a replay at the block) and `explainer.replayReachDays`.

## What it checks

| Capability | Requests | Recorded |
| --- | --- | --- |
| Trace of one transaction | `debug_traceTransaction` (call tracer), `trace_transaction` | answered, and how far back |
| Trace of a call never sent | `debug_traceCall`, `trace_call` | answered, and how far back |
| Trace filter over the watched contracts | `trace_filter` at 10, 100, 1,000, 10,000 blocks | the largest range answered, and how far back |
| Call at a past block | `eth_call` of `facetAddresses()` | how far back |
| Every receipt of a block at once | `eth_getBlockReceipts` | answered |
| Cost of a block scan | 30 recent full blocks | blocks per day, requests per day, megabytes per day |

"How far back" is probed at 64 blocks, then about 1 hour, 1, 7, 30, 90 and
365 days. Each probe block is found by its timestamp, and the result records
the block's real age. `reachDays` is the oldest age that answered.
`refusedAtDays` is the first age that did not. The watched contracts are
every contract address in the network's `contracts/deployments/<slug>/addresses.json`.
People and the treasury are not watched.

The check is read-only. It sends no transaction and holds no key. No
endpoint, host or key is printed or written, and a node's error text is
shortened and scrubbed before it is kept. A full run uses about 50 to 150
requests per network.

## Running it

Run it on the always-on machine, against the nodes the services use. It
needs only Node from a checkout, and nothing to build:

```bash
cd "$(mktemp -d)"
git -C /opt/vaipakam-keeper/repo fetch --quiet origin main
git -C /opt/vaipakam-keeper/repo archive origin/main ops/node-capability contracts/deployments | tar -x
sudo /usr/local/bin/node --env-file=/etc/vaipakam/keeper.env \
  ops/node-capability/check.mjs --out results
```

`--only base-sepolia,arb-sepolia` limits the run. Without `--out`, the
results go to stdout as one JSON array. A network whose variable is unset is
written as `no node configured`.

To record the node plan's limits, set `NODE_PLAN_<suffix>` beside the
network's `RPC_<suffix>`, for example `NODE_PLAN_BASE_SEPOLIA="25 requests
per second; 300M units per month"`. Write numbers only, never the
provider's name. Without it, the result says `not stated`.

Review the files (they hold no secret by construction, but read them before
committing), then commit them under `ops/node-capability/results/`, one
`<slug>.json` per network. Run the check again whenever a network's node
or plan changes. The record reads the committed file, never a live probe.

Tests: `node --test ops/node-capability/check.test.mjs`.
