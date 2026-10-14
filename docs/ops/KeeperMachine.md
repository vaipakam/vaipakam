# Keeper on an always-on machine: runbook

How to run `apps/keeper` as one long-running process on an Ubuntu machine
instead of as a Cloudflare cron Worker. The runtime is described in
[`apps/keeper/host/README.md`](../../apps/keeper/host/README.md); the install
kit is [`apps/keeper/host/deploy/`](../../apps/keeper/host/deploy/). In short,
the Workers Free plan's 10 ms CPU limit ended every scheduled tick (#1896,
#2493). The machine runs the same passes through the same tick, with no CPU
limit.

**Status.** The kit exists. The one-keeper-at-a-time lease (#2503) has NOT
landed, so §2 holds by procedure only. Read §2 before starting anything.

## 1. What runs

| Unit | Runs as | Does |
| --- | --- | --- |
| `vaipakam-keeper.service` | a dynamic user, with the env file as a private credential | the keeper itself: one tick every UTC minute |
| `vaipakam-keeper-update.timer` → `.service` | `vaipakam-build` (no access to the env file) | every 5 minutes: fetch `main`, build, check, stage (`update.sh`) |
| `vaipakam-keeper-restart.path` → `.service` | root | restarts a running keeper when a new build is staged |

A merge to `main` is the deploy. `update.sh` builds the single-file bundle,
runs it with `--check` to prove it loads, and compares it with the staged one.
A merge that does not change the keeper produces the same bundle and does
not restart it. Any failure leaves the running keeper untouched, and the next
run retries.

Trust: whoever can merge to `main` controls what the keeper runs, exactly as
with the Worker's auto-deploy. Node comes from nodejs.org, verified against
the release's published SHA-256 over TLS.

Files on the machine:

| Path | What |
| --- | --- |
| `/etc/vaipakam/keeper.env` | settings and secrets. root, `0600`. Never overwritten by the kit |
| `/opt/vaipakam-keeper/current` | the running release (symlink into `releases/<commit>`) |
| `/opt/vaipakam-keeper/releases/` | the last five builds, for rollback |
| `/opt/vaipakam-keeper/deploy-branch` | the branch followed (default `main`) |
| `/opt/vaipakam-keeper/repo` | the build checkout |

## 2. One keeper at a time (read first)

The keeper holds the one on-chain signing key. If a machine and a scheduled
Worker both ran, every fund-moving pass would submit twice: double
liquidations, double `triggerDefault`s, and transaction-number collisions on
the one key. Two machines would do the same. Until the lease lands:

1. **The Worker's schedule stays EMPTY** while any machine runs.
   `apps/keeper/wrangler.jsonc` commits `"crons": []`. Confirm the live account
   agrees with `node .github/scripts/check-cron-slots.mjs --live` (read-only,
   see [`CloudflareCronSlots.md`](CloudflareCronSlots.md)). Never deploy the
   keeper Worker from a branch that carries a schedule while a machine runs.
2. **Exactly one machine.** Stop the old one (§6) and wait until its process
   has exited before starting a new one.

`KEEPER_ENABLED=false` does not make a second copy safe. Disarmed passes still
write to the database and send alerts, so two of them double-notify.

## 3. Install

On the machine, as a user with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/vaipakam/vaipakam/main/apps/keeper/host/deploy/install.sh | sudo bash
```

It installs Node 22, creates `vaipakam-build`, clones the repository, installs
the units, enables the update timer, runs the first build, and creates
`/etc/vaipakam/keeper.env` from the template if there is none. It does NOT
start the keeper. Running it again is safe and brings the units and
`update.sh` up to date (they are not updated by the timer).

## 4. Configure

Fill in `/etc/vaipakam/keeper.env` on the machine (`sudo -e
/etc/vaipakam/keeper.env`). Never paste a value from it into chat, a ticket or
a commit. The template documents each line. In short:

- **Database:** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_D1_API_TOKEN`, a token
  with the account's D1 Edit permission only. Cloudflare cannot limit a token
  to one database, so it can reach every D1 database on the account. Make one
  for this machine; never reuse a deploy token. `D1_DATABASE_ID` is prefilled.
- **Arming:** leave `KEEPER_ENABLED=false` and the three per-pass flags empty.
- **Secrets:** `KEEPER_PRIVATE_KEY`, each served chain's `RPC_*`,
  `TG_BOT_TOKEN` (the user bot, never `TG_OPS_BOT_TOKEN`), `PUSH_CHANNEL_PK`
  and the aggregator keys.
- **Knobs:** copy the live values from the keeper Worker's dashboard.

An empty value is unset, as an unbound setting is on the Worker. A chain or
pass that needs it skips without an error, so check the `chains resolved`
line (§5).

## 5. Start disarmed, validate, then arm

```bash
sudo systemctl start vaipakam-keeper
journalctl -u vaipakam-keeper -f
```

1. **Disarmed** (`KEEPER_ENABLED=false`). Count a tick as good only if all
   three hold:
   - its `[keeper] chains resolved: …` line names exactly the chains served;
   - no pass logged an error, of any kind;
   - no `tick declined` line and no skipped-minute line.

   Cover a full 15-minute cycle (`preGraceWatcher`) and the 00:00–00:09 UTC
   window (`dailyOracleSnapshot`). Neither checks `KEEPER_ENABLED`, so both
   run while the keeper is disarmed.
2. **Arm** only with the owner's OK: set `KEEPER_ENABLED=true`, then
   `sudo systemctl restart vaipakam-keeper`. Cover at least one full 5-minute
   cycle. A pass's `done in Nms` line does not prove it acted: a pass that is
   not armed returns at once, and its log line names the flag that held it.
3. **Per-pass flags** (`GRACE_DEFAULT_ENABLED`, `REWARD_REMIT_ENABLED`,
   `REWARD_COMMIT_ENABLED`) are each the owner's decision. Arm one at a time
   and validate that pass's own cadence.

Rollback at any point: set `KEEPER_ENABLED=false` and restart, or stop the
service (§6). The Worker side needs no change, because its schedule stayed
empty.

## 6. Stop, roll back, move hosts

- **Stop:** `sudo systemctl stop vaipakam-keeper`. The tick in flight
  finishes first (up to 300 s) and the process exits. `try-restart` then
  leaves it stopped when a new build lands.
- **Pause deploys:** `sudo systemctl stop vaipakam-keeper-update.timer`.
- **Roll back:** stop the update timer, point `current` at an earlier
  release (`sudo -u vaipakam-build ln -sfn /opt/vaipakam-keeper/releases/<commit>
  /opt/vaipakam-keeper/current`), then `sudo systemctl restart
  vaipakam-keeper`. Restarting the timer later moves it to `main` again.
- **Move hosts:** stop the old machine and confirm its process has exited,
  then start the new one. Never the other way round (§2).

## 7. Not yet true

- **No lease** (#2503). §2 holds by procedure only.
- **Batch atomicity over the D1 HTTP API is unverified, and nothing relies on
  it.** Both `batch` call sites (`src/hfBandNotifications.ts`) are idempotent
  and already run as two separate batches, so a partial write leaves the same
  state a failed tick does. A new `batch` that needs all-or-nothing must be
  verified on a scratch database first, never on `vaipakam-warm`.
- **One database.** The keeper's private database (#2497) adds a second one,
  and the machine then needs a second database id.
