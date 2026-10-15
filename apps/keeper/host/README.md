# Keeper on an always-on machine

The keeper can run as one long-lived Node process instead of a Cloudflare
Worker. The process runs **the same tick** the Worker runs (`src/tick.ts`), so
both hosts share every pass, cadence, arming flag and safety gate. Only three
things are swapped out:

| Worker | Machine (`host/`) |
| --- | --- |
| `* * * * *` cron trigger | a minute clock that fires on each UTC minute boundary and passes that boundary as the scheduled time, as the cron does (`scheduler.ts`) |
| D1 binding `DB` | the same D1 database, reached over Cloudflare's D1 HTTP API (`d1Http.ts`) |
| Secrets Store bindings and Worker vars | environment variables (`hostEnv.ts`) |

The database stays the shared `vaipakam-warm` database. Moving it is not part
of this change: the indexer owns its schema and the agent writes the alert
thresholds the keeper reads, so a local database would split that state.

## Run it

From a checkout of the monorepo on the machine:

```bash
pnpm install
pnpm --filter @vaipakam/keeper start:host
```

The script runs `host/main.ts` with `tsx`, which is a dev dependency of the
keeper, so install without `--prod`.

**Run exactly one copy per keeper key.** Every pass signs with the same key.
The per-network send ordering (#2486) holds within one process only, so a
second copy, or a Worker still scheduled alongside the machine, can take the
same transaction number and replace a keeper send on the network. Before
starting the machine, confirm the Worker's `crons` is `[]`. It is `[]` on
`main` today.

## Configuration

Everything is an environment variable. The template is
[`deploy/keeper.env.example`](deploy/keeper.env.example), and a test keeps it
in step with what the keeper reads. An empty value means unset.

**Database (machine only):**

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that owns the database |
| `D1_DATABASE_ID` | `e5e927cf-56c3-42c7-9820-179a235cc84f` (`vaipakam-warm`, as in `wrangler.jsonc`) |
| `CLOUDFLARE_D1_API_TOKEN` | an API token with the account's **D1 Edit** permission |

Cloudflare API tokens cannot be limited to one D1 database. This token can
read and write **every D1 database in the account**, which is broader than
the Worker's binding to one database. Treat it like the signing key: one
machine, a file only the service user can read, and rotation if the machine
is ever suspected. The adapter never prints the token in an error or log
line.

If any of the three is missing, the process still starts. It says which
settings are unset, and every tick then declines as a maintenance build
without reading or writing anything.

**Everything the Worker reads,** under the same names:

- Arming flags: `KEEPER_ENABLED`, `GRACE_DEFAULT_ENABLED`,
  `REWARD_REMIT_ENABLED`, `REWARD_COMMIT_ENABLED`. Each needs its own owner
  decision before it is set to `true`, exactly as on the Worker.
- Secrets: `KEEPER_PRIVATE_KEY`, `RPC_BASE_SEPOLIA`, `RPC_ARB_SEPOLIA` and
  any other `RPC_*`, `ZEROEX_API_KEY`, `ONEINCH_API_KEY`, `TG_BOT_TOKEN`,
  `PUSH_CHANNEL_PK`. The full list is `SECRET_BINDING_KEYS` in `src/env.ts`.
- Tuning: `HF_SCALE`, `LIQ_*`, `SPLIT_*`, `PARTIAL_LIQ_*` and the other
  plain vars, as the Worker's dashboard holds them today.

A chain with no RPC set is skipped, and the line
`[keeper] chains resolved: …` printed every tick names the chains that did
resolve.

## Installing it on a machine

[`deploy/`](deploy/) is the install kit for an Ubuntu machine: an
`install.sh`, the systemd units, an updater that deploys every merge to
`main`, and the env template. The procedure, including the
one-copy-per-key rule and the disarmed-then-armed checks, is the runbook
[`docs/ops/KeeperMachine.md`](../../../docs/ops/KeeperMachine.md).

Logs go to stdout and stderr, so `journalctl -u vaipakam-keeper -f` takes
the place of `wrangler tail`.

## Behaviour that differs from the Worker

- **Ticks never overlap.** If a minute arrives while any pass from the
  previous tick is still running, that minute is skipped and the skip is
  logged with the passes still running. On a Worker, overlapping invocations
  are separate isolates. In one process they would share in-memory per-tick
  state, such as the liquidator's attempted-loan set, and could attempt one
  loan twice.
- **Each tick checks the database schema first.** On Cloudflare the keeper's
  deploy refuses to publish until the shared database records every migration
  the build carries. A machine has no deploy step, because pulling new code
  and restarting is the release. So every tick first asks the database the
  same question, using the indexer's own gate and migration list, and declines
  by name while any migration is missing. Ticks resume on their own once the
  indexer's deploy has applied the migrations. Pull new keeper code only after
  the indexer that carries its migrations is deployed, or the keeper waits
  until it is.
- **Stopping is graceful.** SIGTERM or SIGINT stops the clock and waits for
  the tick in flight, so a restart does not cut a send off between signing
  and broadcast.
- **Cloudflare's per-invocation limits no longer apply.** There is no 10 ms or
  30 s CPU limit and no 50-subrequest cap. The passes still carry their own
  request budgets (`subrequestBudget.ts`), sized for the Worker. They are
  deliberately left as they are, so the keeper does the same work per tick on
  either host. Raising them is a separate decision (#2490).
- **One D1 call is one HTTPS request** to the Cloudflare API, where the
  binding was an internal call. That costs latency, not correctness. A
  request whose answer is lost is reported as having no answer and is not
  retried, because only the pass knows whether repeating a write is safe.
