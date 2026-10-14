# Keeper on an always-on machine: runbook

How to run `apps/keeper` as a long-lived process on a machine instead of as a
Cloudflare cron Worker. The design and its reasons are in
[`docs/DesignsAndPlans/KeeperHostPortability.md`](../DesignsAndPlans/KeeperHostPortability.md).
In short, the Workers free plan's 10 ms CPU ceiling killed every scheduled
tick (#1896, #2493). The machine runs the same passes through the same tick
function, with no ceiling.

**Status:** the runner, packaging and this runbook exist. The single-runner
**lease** (design step 4) has NOT landed, so §2's rule is enforced by procedure
only. Read §2 before starting anything.

## 1. What runs, and what it needs

- One Node process (`dist/keeper-machine.mjs`, a single bundled file). Every
  UTC minute it resolves the env, then runs every due pass with the Worker's
  own cadence rules. A tick still running at the next minute makes that minute
  SKIP, and the skip is logged. Two ticks never overlap.
- **Node 22 or later.** Outbound HTTPS to the chains' RPC endpoints, to
  `api.cloudflare.com` (D1), Telegram, Push, 0x and 1inch. No inbound ports.
- **A D1 API token** scoped to *D1 Edit* on the Vaipakam account and nothing
  else. It is the machine's own credential, separate from any deploy token.
  The keeper reads and writes the shared `vaipakam-warm` database through
  Cloudflare's D1 HTTP API.
- The keeper's secrets and knobs as environment variables, under the same
  names as the Worker's bindings. The template is
  [`apps/keeper/machine/.env.machine.example`](../../apps/keeper/machine/.env.machine.example).
  A test keeps that template in step with the variables the runner reads.

## 2. One runner at a time (read first)

The keeper holds the one on-chain transaction key. If a machine and a
scheduled Worker both ran, every fund-moving pass would submit twice: double
liquidations, double `triggerDefault`s, and nonce collisions on the one key.
Two machines would do the same.

Until the lease lands, this holds by procedure:

1. **The Worker's schedule stays EMPTY** while any machine runs.
   `apps/keeper/wrangler.jsonc` commits `"crons": []` (#1896). Confirm the live
   account agrees before starting a machine:
   `node .github/scripts/check-cron-slots.mjs --live` (read-only; see
   [`CloudflareCronSlots.md`](CloudflareCronSlots.md) § Re-verifying for the
   credentials it needs) must list the keeper Worker with no schedule. Do not deploy the keeper Worker from a branch that carries
   a schedule while a machine is running.
2. **Exactly one machine.** Stop the old host (§6) before starting a new one.
   The stop is complete only when the old process has EXITED, which means its
   in-flight tick has finished.

Leaving `KEEPER_ENABLED=false` does not make a second runner safe. Unarmed
passes still write to D1 and send alerts, so two of them double-notify.

## 3. Build

From a checkout of `main`:

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm --filter @vaipakam/keeper run build:machine
```

This writes `apps/keeper/dist/keeper-machine.mjs` (gitignored). The file is
self-contained: copy just it to the machine, with no `node_modules`. Record the
commit you built from, because the bundle carries no version stamp of its own.

## 4. Configure

Copy the template to `.env.machine` (gitignored) and fill it in. Make it
readable by its owner only (`chmod 600`). Notes per section:

- **Database:** `CLOUDFLARE_ACCOUNT_ID` and `KEEPER_D1_API_TOKEN`.
  `KEEPER_D1_DATABASE_ID` defaults to `vaipakam-warm`.
- **Arming:** start with `KEEPER_ENABLED=false` and the three per-pass flags
  empty.
- **Secrets:** `KEEPER_PRIVATE_KEY`, each served chain's `RPC_*`,
  `TG_BOT_TOKEN` (the USER bot, never `TG_OPS_BOT_TOKEN`), `PUSH_CHANNEL_PK`,
  and the aggregator keys.
- **Knobs:** copy the live values from the keeper Worker's dashboard. An empty
  knob means the code default.

An empty variable is ABSENT, exactly as an unbound secret is on the Worker:
the chain or pass that needs it skips **silently**. §5 says how to catch that.

Install it with ONE of:

- **systemd:** follow the header of
  [`apps/keeper/machine/deploy/vaipakam-keeper.service`](../../apps/keeper/machine/deploy/vaipakam-keeper.service).
  The env file stays root-only and reaches the service as a systemd
  credential. Logs: `journalctl -u vaipakam-keeper -f`.
- **Docker:** follow the header of
  [`apps/keeper/machine/deploy/Dockerfile`](../../apps/keeper/machine/deploy/Dockerfile).
  Pass `--stop-timeout 300`. Logs: `docker logs -f vaipakam-keeper`.

At start the runner checks its configuration and the database (`SELECT 1`).
It logs `database reachable`, or exits non-zero naming the missing variable
or the API error. The service manager then retries every 30 s.

## 5. Validate disarmed, then arm

This is the same discipline as the Worker's re-enable procedure (steps 8–10 in
`apps/keeper/wrangler.jsonc`). Two things differ on a machine: there is no CPU
ceiling, so the failure to watch for is an **overrun** rather than
`exceededCpu`, and logs come from journald or docker instead of
`wrangler tail`.

1. **Disarmed (`KEEPER_ENABLED=false`).** Watch the logs and accept a tick as
   evidence only if all three hold:
   - its `chains resolved: N — …` line names exactly the chains this deployment
     serves;
   - no due pass logged an error (`console.error` output of any kind, not one
     particular marker);
   - it logged no `overran: skipped N minute(s)` line.

   Cover a full 15-minute cycle (`preGraceWatcher`) and the 00:00–00:09 UTC
   window (`dailyOracleSnapshot`). Neither of those passes consults
   `KEEPER_ENABLED`, so both run while the keeper is disarmed.
2. **Arm:** set `KEEPER_ENABLED=true` in the env file and restart the service.
   Cover at least one full 5-minute cycle. A pass's `done in Nms` line does NOT
   prove it ran. A gated pass returns immediately when unarmed, and its
   `passIsArmed` line names the flag that blocked it.
3. **Per-pass flags** (`GRACE_DEFAULT_ENABLED`, `REWARD_REMIT_ENABLED`,
   `REWARD_COMMIT_ENABLED`): each is the owner's decision. Arm one at a time,
   then validate that pass's own cadence (`graceDefault`: one full 5-minute
   cycle, reading its per-loan `submitted` / `skipped` lines).

**Rollback** at any point: set `KEEPER_ENABLED=false` and restart, or stop the
service outright (§6). Nothing on the Worker side needs to change, because its
schedule stayed empty throughout.

## 6. Stop, upgrade, move hosts

- **Stop:** `systemctl stop vaipakam-keeper` or `docker stop vaipakam-keeper`.
  SIGTERM stops new ticks, the in-flight tick finishes, and the process exits
  0. The 300 s stop timeout exists so this is never cut short. A SIGKILL could
  interrupt a pass between submitting a transaction and recording it.
- **Upgrade:** build the new bundle (§3), stop, replace the file, start.
  Validate one tick, as in §5 step 1, before walking away.
- **Move hosts:** stop the old host and confirm it has exited. Then start the
  new one. Never the other way round (§2).

## 7. Things that are not yet true

- **No lease** (design step 4). It lives in the keeper's private database,
  so it follows #2497. §2 is enforced by procedure only until it lands.
- **D1 `batch` atomicity over HTTP is unverified, and nothing relies on it**
  (the design doc says why). Before adding a `batch` call that needs
  all-or-nothing behaviour, verify on a SCRATCH database, never on
  `vaipakam-warm`:
  1. `wrangler d1 create keeper-batch-probe`.
  2. Create a one-column table with a UNIQUE constraint.
  3. Send one `{batch:[…]}` request whose first statement inserts a row and
     whose second violates the constraint.
  4. Read the table. A row there means the batch was NOT atomic.
  5. `wrangler d1 delete keeper-batch-probe`.
- **One database.** The keeper's private D1 (#2497) adds a second database.
  The runner then gains a second `D1HttpDatabase` and a variable for its id.
