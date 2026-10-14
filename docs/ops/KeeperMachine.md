# Keeper on an always-on machine: runbook

How to run `apps/keeper` as one long-running process on an Ubuntu machine
(22.04 or later: the install needs systemd 247 or newer and refuses older)
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
| `vaipakam-keeper-update.timer` → `.service` | root, building in a throwaway sandbox | every 5 minutes: deploy the branch's latest commit if it is not running (`update.sh`) |

A merge to `main` is the deploy. Each run of `update.sh` does the following:

1. It fetches `main` into root's own checkout.
2. If `current` is already that commit's release, it stops there.
3. Otherwise it exports exactly that commit and builds it in a sandbox, as a
   fresh dynamic user that systemd deletes afterwards (`build.sh`). The build
   runs the new bundle with `--check`, to prove it loads.
4. It installs the bundle as `releases/<commit>` and switches `current` to it.
5. It restarts a running keeper, unless the new bundle is byte-identical to
   the running one (a merge that did not touch the keeper).

Any failure leaves the running keeper untouched, and the next run retries.
The only state is `current`.

The build user is new for every build. It can read neither the env file nor
write the releases, and nothing it writes survives the build: its source
tree, Corepack's copy of pnpm and pnpm's package store all live in its private
`/tmp`, which systemd deletes with it. So a build cannot leave tooling behind
for a later one to run. Each build downloads its packages afresh, checked
against the lockfile's integrity hashes, and Corepack checks pnpm against
npm's signing keys. Builds run one at a time under one fixed unit name. Root
chose the commit and built that commit's own export, so a release is always
bound to its commit. Of the service accounts, only the keeper's dynamic user
sees the env file.

Trust, stated plainly. **Root on this machine is fully trusted**: it can read
`/etc/vaipakam/keeper.env`, and with it the signing key and the D1 token, and
it runs the updater. The sandboxing above keeps the build away from the
secrets; it does nothing to limit root, so anyone with root or `sudo` here
holds the keeper key. Whoever can merge to `main`, or tamper with a dependency
the build fetches, controls what the keeper runs. This is the same trust the
Workers' auto-deploy carries. Node comes from nodejs.org, verified against
the release's published SHA-256 over TLS.

Files on the machine, all root's:

| Path | What |
| --- | --- |
| `/etc/vaipakam/keeper.env` | settings and secrets, `0600`. Never overwritten by the kit |
| `/opt/vaipakam-keeper/current` | the running release (a symlink into `releases/<commit>`) |
| `/opt/vaipakam-keeper/releases/` | the last five deployed builds, for rollback |
| `/opt/vaipakam-keeper/deploy-branch` | the branch followed (default `main`) |
| `/opt/vaipakam-keeper/repo` | the checkout the code comes from |

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

On the machine, as a user with sudo. Download first, then run, so a transfer
cut short can never run part of the script:

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/vaipakam/vaipakam/main/apps/keeper/host/deploy/install.sh
sudo bash install.sh
```

The script does the following:

- installs Node 22 and clones the repository as root;
- installs the units and enables the update timer;
- deploys the first build;
- creates `/etc/vaipakam/keeper.env` from the template, if there is none.

It never enables or starts the keeper. That is the cutover in §5, so a
machine that is installed but not cut over cannot start a second keeper at
its next boot. Running it again is safe. Each run brings the units and
scripts up to date (the timer does not update them). It also moves Node to
the latest 22.x release. When Node or the keeper's unit changed, it restarts
a running keeper onto them, after its current tick. So re-run it to take Node
security releases. It keeps the branch the machine follows unless
`KEEPER_DEPLOY_BRANCH` is set again.

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

The cutover. Confirm §2 first, because enabling the unit also starts it at
every boot:

```bash
sudo systemctl enable --now vaipakam-keeper
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

- **Stop:** `sudo systemctl stop vaipakam-keeper`. The tick in flight finishes
  first and the process exits. There is deliberately no stop timeout: systemd
  never kills a keeper that is mid-pass, because a kill can cut a pass off
  between sending a transaction and recording it. A deploy leaves a stopped
  keeper stopped. Stopping does NOT survive a reboot; see "Move hosts".
- **A stop that hangs** means a pass is waiting on a network call that is not
  returning. Find out which one from the log before deciding. Killing it
  (`sudo systemctl kill -s KILL vaipakam-keeper`) is an operator decision,
  and afterwards check the keeper address on each chain for a transaction
  the database does not record.
- **Pause deploys:** `sudo systemctl disable --now vaipakam-keeper-update.timer`,
  then `sudo systemctl stop vaipakam-keeper-update.service`. The second
  command stops a deploy already running (and its build), so it cannot
  switch `current` after you have paused. Stopping only the timer would let
  that deploy finish and switch anyway. A deploy stopped just after switching
  leaves `restart-pending`, and the next run, once deploys resume, restarts
  the keeper onto that release. `disable`
  keeps the timer off across a reboot. Resume with `sudo systemctl enable
  --now vaipakam-keeper-update.timer`.
- **Roll back:** pause deploys (above) first. Then point `current` at an
  earlier release (`sudo ln -sfn /opt/vaipakam-keeper/releases/<commit>
  /opt/vaipakam-keeper/current`) and run `sudo systemctl restart
  vaipakam-keeper`. **To return to `main`**, resume deploys. The next run
  sees that `current` is not `main`'s release and deploys it.
- **Move hosts:** on the old machine run `sudo systemctl disable --now
  vaipakam-keeper vaipakam-keeper-update.timer`. Then enable the new machine
  with the §5 cutover. `disable` matters: a unit
  that is only stopped starts again at the next boot, which would put a
  second keeper on the same key. Confirm the process has exited (`systemctl
  is-active vaipakam-keeper` prints `inactive`), then start the new machine.
  Never the other way round (§2).

## 7. Not yet true

- **No lease** (#2503). §2 holds by procedure only.
- **Batch atomicity over the D1 HTTP API is unverified, and nothing relies on
  it.** Both `batch` call sites ([`apps/keeper/src/hfBandNotifications.ts`](../../apps/keeper/src/hfBandNotifications.ts)) are idempotent
  and already run as two separate batches, so a partial write leaves the same
  state a failed tick does. A new `batch` that needs all-or-nothing must be
  verified on a scratch database first, never on `vaipakam-warm`.
- **One database.** The keeper's private database (#2497) adds a second one,
  and the machine then needs a second database id.
