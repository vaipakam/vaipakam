# The failed transaction pass

Finds every failed transaction sent to a contract in a network's deployment
record, decodes it while the node still holds the state, and stores it through
the indexer (#3919, TroubleshootingPictureDesign.md §4.3). The stored half is
#3918: `apps/indexer/src/failedTx.ts`, its tables (migrations 0123 and 0124) and
`GET /health/failed-tx`.

## Where it runs, and what it can reach

A oneshot on the keeper machine, started every five minutes by a systemd timer.
It is not a Worker: on Workers Free one run gets 10 ms of CPU, and the
explainer's first decode against the combined Diamond ABI takes about 75 ms.

- Its own dynamic user, env file (`/etc/vaipakam/failed-tx.env`, root-only,
  handed over by `LoadCredential`) and memory cap (384 MB).
- **No signing key and no database binding.** Its only write is
  `POST /internal/failed-tx` on the indexer, under its own token
  (`FAILED_TX_WRITER_TOKEN`, also a secret on the indexer Worker). That route
  accepts records, the pass's cursor and checkpoints, and a replaced range,
  and nothing else. The pass reads its own state back from
  `GET /internal/failed-tx/state` under the same token.
- **The keeper's files are out of reach.** The unit makes `/etc/vaipakam` (every
  service's env file, including the keeper's) and the keeper's and the
  sanctions services' release and state trees inaccessible. Its own env file
  still arrives, because systemd reads it for `LoadCredential` before the
  sandbox applies.
- No endpoint, key or token is ever printed. A node or explorer failure is
  described by its error code and a bounded message with any URL removed.

## What a run does

For each network in `FAILED_TX_CHAINS`, independently:

1. Reads back its cursor, its checkpoints and the day's audit plan. Every read
   and write names the Diamond the pass's deployment record names, and the
   indexer refuses (409) when its own record names another: the pass then holds
   that network with a `deployment-mismatch` alert and writes nothing, until
   the two run the same record. A cursor written under a retired Diamond is
   not resumed from; after a fresh deploy the pass starts the new Diamond from
   its deploy block.
2. Reads the settled head (`safe`, the block the indexer reads). With no
   answer, it holds and records nothing.
3. Reads the newest checkpoint's block twice. A replacement is called only
   when both reads agree with each other and differ from the checkpoint. The
   pass then walks back to the newest checkpoint the chain still agrees with,
   marks every record above it as replaced (nothing is deleted), and scans the
   range again. A disagreeing read holds the run.
4. Finds failed transactions after its cursor, by the network's mode. The
   mode comes from the node capability check's committed result
   (`ops/node-capability/results/<slug>.json`, #3913):
   - **trace-filter**: one `trace_filter` request per range over every
     watched contract. This covers direct calls and calls made through another
     contract.
   - **list-and-audit**: the explorer's list of transactions sent to each
     contract (Etherscan v2, one key), keeping the failed ones. The contracts
     users call directly (the Diamond, the position token, the VPFI token) are
     read every run, and the rest once an hour of blocks has passed.
   - **sends-and-audit**: no explorer key. The keeper's own sends are this
     mode's continuous source, and they arrive with the keeper decision record
     (§4.4), which is not built yet. Until then the daily audit is the only
     source, and the health route states the share of the day that is watched.
5. Decodes each one, taking the best source the node offers: its trace
   (`debug_traceTransaction`, the explainer's whole output), else a replay at
   the parent block (the error and its values only, with what it cannot hold
   listed), else "state no longer reachable" (the receipt's facts only). A
   node that does not answer is never treated as a missing state: the run
   holds at that transaction's block and tries again next time.
6. In the two audit modes, it reads a slice of the day's audit window. The
   window is a random 30 minutes of the previous UTC day. Every block in the
   slice is read in full and compared with what was recorded there. A failure
   the list missed is recorded with `found_by = audit` and alerted. The miss
   rate so far is on the health route.
7. Writes its cursor, a checkpoint at its top block, any gaps and the audit
   slice.

A range the node or the explorer refuses outright is recorded as a gap, with
its reason, and is alerted. Alerts (a cursor more than 30 minutes behind, a
gap, an audit miss, a state no longer reachable, a replacement deeper than
the checkpoints held) go to the operator chat when `TG_OPS_*` is set. The
same condition is alerted again after six hours if it is still present.

The **block-scan** mode is not built. No network's measured cost puts it
inside the bound, and a capability result that selects it is refused by name.
A **local rebuild** (the explainer's second source) is not run here, because
it needs a local copy of the chain. An operator adds one with `explain-tx`
through the same route.

## Install (operator)

```bash
C=<full commit sha on main>
curl -fsSL -o install.sh "https://raw.githubusercontent.com/vaipakam/vaipakam/$C/apps/failed-tx-pass/deploy/install.sh"
sudo bash install.sh "$C"
sudoedit /etc/vaipakam/failed-tx.env      # fill it in (template: deploy/failed-tx.env.example)
sudo systemctl start vaipakam-failed-tx   # one run now; read journalctl -u vaipakam-failed-tx
sudo systemctl enable --now vaipakam-failed-tx.timer
```

Set the same `FAILED_TX_WRITER_TOKEN` on the indexer Worker first
(`wrangler secret put FAILED_TX_WRITER_TOKEN` in `apps/indexer`). Until it is
set there, the route refuses every write.

## Develop

```bash
pnpm --filter @vaipakam/failed-tx-pass typecheck
pnpm --filter @vaipakam/failed-tx-pass test    # a model chain against the indexer's real route
pnpm --filter @vaipakam/failed-tx-pass build   # dist/failed-tx-pass.mjs
```
