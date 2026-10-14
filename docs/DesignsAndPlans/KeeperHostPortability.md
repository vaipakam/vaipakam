# Keeper host portability — running the keeper off Cloudflare Workers

Status: steps 1–3 landed; step 4 (lease) next (owner request 2026-10-14). Tracking issue: #2503.

## Why

The keeper cannot run every minute inside a Workers free-plan invocation. On
2026-10-14 the restored schedule was validated with `KEEPER_ENABLED=false`, and
6 of 6 ticks ended `exceededCpu`, pinned at the 10 ms ceiling (#1896, #2493).
The owner's decision is to run the keeper on a separate, always-on machine, with
the machine itself chosen later. This document covers the engineering that makes
that move a configuration step rather than a rewrite.

On a long-lived host the CPU ceiling disappears. It also frees the keeper's cron
reservation on the Cloudflare account (`docs/ops/CloudflareCronSlots.md`).

## What does NOT change

- **The passes.** All of `src/*.ts` (liquidator, matcher, watcher, pre-grace,
  grace default, oracle snapshot, remits, …) takes a plain resolved `Env` and
  uses only `fetch`, `crypto` and D1. None of it touches a Workers-only API
  (checked: no `caches`, `HTMLRewriter`, `cloudflare:` imports or
  `WebSocketPair` in the keeper or `packages/lib`). One implementation runs in
  both hosts; nothing forks.
- **Arming.** `KEEPER_ENABLED` and the per-pass flags gate exactly as they do
  today.
- **The database.** The keeper reads tables the indexer and agent own (`loans`,
  `offers`, `user_thresholds`, `telegram_links`, `notifications`,
  `indexer_cursor`), so it stays on the shared D1 database. A machine reaches
  it through Cloudflare's D1 HTTP API.

## Shape: one tick, two entry points

```
              ┌────────────────────────────┐
  Worker ───► │ scheduled(): resolveEnv →  │
  (cron)      │   runKeeperTick(env, defer │──► KEEPER_PASSES (unchanged)
              │   = ctx.waitUntil)         │
              └────────────────────────────┘
              ┌────────────────────────────┐
  Machine ──► │ node runner: env from      │
  (process)   │   process.env + D1 over    │
              │   HTTP → runKeeperTick(env,│──► KEEPER_PASSES (unchanged)
              │   defer = collect+await)   │
              └────────────────────────────┘
```

| Seam | Worker | Machine |
| --- | --- | --- |
| Tick | `runKeeperTick` (`src/tick.ts`) | same function |
| Scheduling | cron `* * * * *`, `controller.scheduledTime` | a loop aligned to the UTC minute, passing the minute it is for as `scheduledTimeMs`, so `cadenceSkipReason` behaves identically |
| Concurrency | each pass a `ctx.waitUntil` | each pass a promise, awaited before the next tick; a tick still running at the next minute makes that minute SKIP (logged), never overlap |
| Secrets | Secrets Store bindings, resolved by `resolveEnv` | process environment variables, presented to the same `resolveEnv` as `{ get() }` bindings (`machine/envFromProcess.ts`) |
| D1 | `env.DB` binding | `D1HttpDatabase` (`machine/d1Http.ts`): `prepare` / `bind` / `first` / `all` / `run` / `batch` over `POST /accounts/{a}/d1/database/{db}/query` |
| Logs | Workers logs / `wrangler tail` | stdout (journald / docker logs) |
| Shutdown | n/a | SIGTERM/SIGINT: no new tick starts, the in-flight tick finishes, then exit |

## The D1 HTTP adapter

Verified against the live API (2026-10-14, read-only): `{sql, params}` runs one
statement with positional parameters, `{batch: [{sql, params}, …]}` runs several
and returns one result set each. The adapter implements only the surface the
keeper calls (`prepare`, `bind`, `first`, `all`, `run`, `batch`), and returns
`{ results, meta: { changes, last_row_id } }` as the binding does.

**Batch atomicity is not relied on.** Whether a REST `batch` is atomic, as the
binding's is, has not been verified, and the keeper does not need it to be.
Both `batch` call sites are in `src/hfBandNotifications.ts`, and each statement
in them is idempotent: notifications are `INSERT OR IGNORE` on a dedup key, and
band state is an upsert or a delete keyed on the loan. They are also two
SEPARATE batches, so even on the Worker a failure between them leaves a partial
write. A partial batch therefore leaves the same state a failed tick does, and
the next tick re-derives it. A NEW `batch` call site that needs all-or-nothing
must not assume it on the machine. Verify on a scratch database first (the
runbook has the procedure).

## One runner at a time — a lease

If the Worker's cron and a machine both ran, every fund-moving pass would submit
twice: double liquidations, double `triggerDefault`s, and nonce collisions on
the one key. "Unschedule the Worker first" is a procedure, and a procedure can
be missed. So the tick takes a **lease** before any pass runs: a single D1 row
`keeper_lease(holder, expires_at)`, claimed with a compare-and-set
(`UPDATE … WHERE holder = ?self OR expires_at < now`) and renewed every tick. A
host that does not hold the lease skips the tick and says which holder does.
This needs a migration (owned by `apps/indexer/migrations/`, per the D1 schema
rule). It lands in its own step, before any machine is armed.

## Steps

1. **Lift the tick** out of `index.ts` into `src/tick.ts`. The Worker entry
   calls it with `ctx.waitUntil`. No behaviour change.
2. **Machine runner**: `machine/run.ts` (entry `machine/main.ts`),
   `machine/envFromProcess.ts`, `machine/d1Http.ts`, with tests
   (`test/machineHost.test.ts`). `machine/` is its own `tsc` program, so a Node
   global cannot leak into the Worker's `src/`.
3. **Package**: a bundled `dist/keeper-machine.mjs` (esbuild), a `systemd` unit
   and a `Dockerfile` (`machine/deploy/`), and `machine/.env.machine.example`
   listing every variable.
   Plus a runbook: `docs/ops/KeeperMachine.md`.
4. **Lease** (migration + tick guard), then the batch-atomicity check.
5. **Cutover** when the machine exists: deploy the runner disarmed, validate
   ticks (the same step-8 discipline as `apps/keeper/wrangler.jsonc`), arm, and
   retire the Worker's schedule reservation.

#2497 (the keeper's private D1 and the parked passes) adds a second database.
The adapter takes a database id, so the runner gains a second `D1HttpDatabase`
when that lands.
