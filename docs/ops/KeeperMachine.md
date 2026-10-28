# Keeper on an always-on machine: runbook

How to run `apps/keeper` as one long-running process on an Ubuntu machine
(22.04 or later: the install needs systemd 247 or newer and refuses older)
instead of as a Cloudflare cron Worker. The runtime is described in
[`apps/keeper/host/README.md`](../../apps/keeper/host/README.md); the install
kit is [`apps/keeper/host/deploy/`](../../apps/keeper/host/deploy/). In short,
the Workers Free plan's 10 ms CPU limit ended every scheduled tick (#1896,
#2493). The machine runs the same passes through the same tick, with no CPU
limit.

**Status.** The kit exists, and every tick claims a one-runner lease (§2)
before it does anything. Read §2 before starting anything.

## 1. What runs

| Unit | Runs as | Does |
| --- | --- | --- |
| `vaipakam-keeper.service` | a dynamic user, with the env file as a private credential | the keeper itself: one tick every UTC minute |
| `vaipakam.slice` | (a slice, not a process) | the keeper's own top-level slice, so the keeper's memory protection takes effect |
| `vaipakam-keeper-update.timer` → `.service` | root, verifying in a throwaway sandbox | every 5 minutes: deploy main's latest keeper build if it is not running (`update.sh`) |

A merge to `main` is the deploy. This machine never builds the keeper: CI
does ([`keeper-host-release.yml`](../../.github/workflows/keeper-host-release.yml)),
and the machine downloads what CI published and checks it. Each run of
`update.sh` does the following:

1. It fetches `main` into root's own checkout.
2. If `current` is already that commit's release, it stops there. It also
   stops if that commit gives the build exactly the source the running
   release has (see "Which commits are deployed" below), and logs once that it
   is staying on the running release.
3. Otherwise it downloads the bundle CI published for that commit's build
   source, `keeper-host-<digest>.mjs`, and its attestation,
   `keeper-host-<digest>.sigstore.json`, from the repository's
   [`keeper-host` release](https://github.com/vaipakam/vaipakam/releases/tag/keeper-host).
   CI builds a commit after it lands on `main`, so for a few minutes after a
   merge the bundle is not there yet. The run then logs once `waiting for CI
   to publish the keeper build of <commit>` and stops; a later run deploys it.
4. It verifies the attestation with `gh attestation verify`. The attestation
   must be signed for this repository's `keeper-host-release` workflow, run on
   `main`, on a GitHub-hosted runner, over exactly the downloaded bytes. The
   commit the signing certificate names as the build's source must be on
   `main` and must give the build the same source as the commit being
   deployed. Usually it is that commit.
5. It runs the bundle with `--check`, with no settings and no network, to
   prove it loads on this machine's Node.
6. It installs that same commit's systemd units and `update.sh`, each only if
   it changed. So the keeper never runs under the units of another commit: a
   change that needs a new setting in its unit arrives with the code that
   needs it.
7. It installs the bundle as `releases/<commit>` and switches `current` to it.
   `releases/<commit>/BUILT_FROM` names the commit CI built it from.
8. It restarts a running keeper, unless neither the bundle nor the keeper's
   unit changed (a merge that did not touch the keeper).

Any failure leaves the running keeper untouched, and the next run retries. A
bundle that fails verification is never installed, and every run says so in
`journalctl -u vaipakam-keeper-update` until a newer commit replaces it.

**Why the machine does not build (#2651).** This machine is small (about 1 GB
of memory, two shared CPUs on a burstable shape). It used to build every
keeper change itself. While a build ran, the keeper's tick started late and
the late remittance check missed its read deadline in about a third of ticks,
against 0.3% outside a build. Lower CPU priority and memory protection for the
keeper did not change that. A measurement during a build on 2026-10-23 showed
why: the build's own CPU use was small (about 16%), but the hypervisor took
48% of the machine's CPU time on average (68% at worst), and the machine
swapped hard enough that all disk IO stalled 33% of the time. Priorities
inside the machine cannot win back time the host does not give it. So the
build moved to CI, and the machine now only downloads a bundle of about
12 MB, verifies it and runs `--check`.

**What CI does.** On every push to `main`, the workflow takes the same digest
of the commit's build source (below) with the same script. If the release
already holds a bundle for that digest, it stops there. Otherwise it builds
exactly that export with `build.sh`, under `env -i` with no credential in
reach. The build job holds a read-only token, no OIDC token and no persisted
git credential, and starts from the lockfile with no cache. The build runs
the bundle with `--check`. A separate job then signs a SLSA build provenance
attestation over the bundle (`actions/attest`, through Sigstore's public-good
instance, also kept in the repository's attestation store) and uploads both
files to the `keeper-host` release. That release is a prerelease and never
the latest release; it holds the newest ten bundles. Any bundle can be checked
by hand:

```bash
gh attestation verify keeper-host-<digest>.mjs \
  --bundle keeper-host-<digest>.sigstore.json \
  --repo vaipakam/vaipakam \
  --signer-workflow vaipakam/vaipakam/.github/workflows/keeper-host-release.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

**Which commits are deployed.** A build is given only the paths listed in
`apps/keeper/host/deploy/build-paths`:
- the root manifests and the lockfile;
- the keeper;
- the workspace packages its install reaches;
- the indexer modules it imports.

`build-source.sh` exports those paths with `git archive` for the build, and
the same script takes a digest of that export: every path, executable bit and byte,
after git's own conversions. CI names each bundle by that digest. The updater
compares the running release's digest with the branch tip's. If they are
equal, a build would be given the same files and would make the same bundle,
so the machine stays on the release it has. Nothing is predicted: what is
compared is what the build reads. A path the build needs but the list leaves
out makes the build fail; it can never pass on stale input, and a test checks
the list against the bundle's real inputs.

As a result, the release the keeper reports can be older than the tip of
`main`. That is expected: it is the newest commit whose build source differs.

**A deploy never competes with the keeper.**
- **CPU.** The updater, the verification and the load check run at the lowest
  CPU priority (`Nice=19`, `CPUWeight=1`).
- **Memory.** The keeper runs in a top-level slice of its own,
  `vaipakam.slice`, with `MemoryLow=320M` on both the slice and the keeper.
  The kernel reclaims the keeper's memory, up to that figure, only once
  nothing unprotected is left to reclaim. So an updater run or anything else
  on the machine is swapped out before the keeper is. The protection reserves
  nothing, so memory the keeper is not using stays free for the rest. The
  slice is needed because, under cgroup v2, a unit's protection holds only as
  far as its parent grants it, and `system.slice` grants none. The figure is
  the keeper's measured footprint (about 140 MiB resident plus 110 MiB
  swapped, 2026-10-23) with room to grow. If memory runs out anyway, the OOM
  killer picks a deploy step (`OOMScoreAdjust=500`) before the keeper
  (`-500`), and the next deploy run retries.
- **Disk.** The units also ask for the lowest disk priority (`IOWeight=1`,
  `IOSchedulingClass=idle`). That has no effect on this machine, because its
  disk scheduler is `none`, which ignores both. The settings are kept so that
  they take effect on a host whose scheduler honours them.

The units and the release are bound by one file, `kit-commit`, naming the
commit whose units are installed and loaded. A deploy removes it before it
touches the units and writes it again only once `current` is that commit's
release, and the keeper unit refuses to start unless it matches `current`.
So however a deploy is interrupted, the keeper never starts one commit's code
under another commit's units: a start in between fails (`cmp` reports the two
files differ, in `journalctl -u vaipakam-keeper`) and retries every 30
seconds. Every deploy run first puts back the units of whatever `current` is,
which makes the keeper startable again. It does the same when any installed
kit file differs from that release's kit, so a file an older updater did not
know to install (such as `vaipakam.slice`) goes in at the next run. With
deploys paused, `sudo
/opt/vaipakam-keeper/update.sh --kit-only` does that one step by hand. A
reinstall and a deploy share one lock, so they never interleave.

Verification and the load check each run as a fresh dynamic user that
systemd deletes afterwards. That user can read neither the env file nor
write the releases, sees only the two downloaded files, and keeps nothing:
its home is its private `/tmp`, which systemd deletes with it. The load
check also has no network. Of the service accounts, only the keeper's
dynamic user sees the env file.

Trust, stated plainly. **Root on this machine is fully trusted**: it can read
`/etc/vaipakam/keeper.env`, and with it the signing key and the D1 token, and
it runs the updater. The sandboxing above keeps the deploy steps away from the
secrets; it does nothing to limit root, so anyone with root or `sudo` here
holds the keeper key. **Whoever can merge to `main` holds root on this
machine**: each deploy installs that commit's units and `update.sh`, and the
updater runs as root, so a merged change to either runs as root at the next
deploy, with the signing key, the D1 token and anything else here in reach.
The same people control the bundle, because CI builds `main` and only `main`.
Branch protection on `main` is therefore part of this machine's security.

**What the machine trusts to accept a bundle.** Release assets can be uploaded
by more accounts than can merge to `main`, so the download proves nothing by
itself. The attestation is the check. Its certificate is issued by Sigstore's
Fulcio from GitHub's OIDC token for the run that signed it, so the workflow
path, the ref and the commit it names cannot be set by that workflow or by
whoever uploaded the asset. Accepting a bundle therefore relies on:
- GitHub Actions' hosted runners and OIDC tokens;
- Sigstore's public-good instance and its trust root, which `gh` fetches and
  checks through TUF;
- the GitHub CLI, from GitHub's apt repository, whose keyring `install.sh`
  checks against a pinned SHA-256.

Anyone who can tamper with a dependency the CI build fetches controls what
the keeper runs, as before. The Workers' auto-deploy carries the same trust
for the keeper's code; root on the machine is the part it adds. Node comes
from nodejs.org, verified against the release's published SHA-256 over TLS.

Files on the machine, all root's:

| Path | What |
| --- | --- |
| `/etc/vaipakam/keeper.env` | settings and secrets, `0600`. Never overwritten by the kit |
| `/opt/vaipakam-keeper/current` | the running release (a symlink into `releases/<commit>`) |
| `/opt/vaipakam-keeper/releases/` | the last five deployed bundles, for rollback; each holds `SOURCE_COMMIT` and `BUILT_FROM` |
| `/opt/vaipakam-keeper/checked` | the last running/newer commit pair found to give the build the same source, so it is not compared or logged again |
| `/opt/vaipakam-keeper/awaiting` | the build-source digest whose CI bundle the machine last waited for, so the wait is logged once |
| `/opt/vaipakam-keeper/repo` | the checkout the code comes from |

## 2. One keeper at a time (read first)

The keeper holds the one on-chain signing key. If a machine and a scheduled
Worker both ran, every fund-moving pass would submit twice: double
liquidations, double `triggerDefault`s, and transaction-number collisions on
the one key. Two machines would do the same.

**The lease.** Every tick, on the Worker or a machine, first claims one row in
the shared database (`keeper_runner_lease`) under its `KEEPER_RUNNER_ID`. The
Worker's is `cloudflare-worker` (set in `apps/keeper/wrangler.jsonc`); a
machine's is `host:<host name>` unless its env file sets another. Which runner
holds the lease, and until when, is decided by the database's clock, never a
runner's own, so a machine whose clock drifts cannot take a live lease or
hold one past its time. While another
runner holds an unexpired lease, the tick runs nothing and logs `tick
declined: runner "<name>" holds the one-runner lease until <time>`. A tick
that cannot claim it at all (no runner id, the database unreachable) declines
too. A holder renews every minute, and a lease it stops renewing expires after
10 minutes, so a dead machine hands over by itself.

**The schema.** A machine has no deploy step: the update timer's pull and
restart is the release. So before the lease, each tick checks that every
migration of the shared database in
`packages/lib/src/sharedD1Migrations.json` is recorded (the same gate and list
the indexer and agent use, #2410), and that the keeper's private database is
current. Until then it logs `[keeper-host] tick declined: D1 migration(s) …
not applied` (or the private database's own line) and runs nothing; the next
tick after the indexer's deploy applies them runs normally.

The lease is a guard, not the plan. It cannot tell two runners apart if they
share a name, and a pass stuck for longer than 10 minutes could overlap a
successor. So the procedure still holds:

1. **The Worker's schedule stays EMPTY** while any machine runs. Since
   #2497 the Worker's `scheduled` handler also declines every invocation by name
   (`the keeper runs on the always-on machine, not as a scheduled Worker`), so a
   schedule restored by hand runs nothing. The Worker stays deployed only as the
   private database's migration applier.
   `apps/keeper/wrangler.jsonc` commits `"crons": []`. Confirm the live account
   agrees with `node .github/scripts/check-cron-slots.mjs --live` (read-only,
   see [`CloudflareCronSlots.md`](CloudflareCronSlots.md)). Never deploy the
   keeper Worker from a branch that carries a schedule while a machine runs.
2. **Exactly one machine, with its own `KEEPER_RUNNER_ID`.** Stop the old one
   (§6) and wait until its process has exited before starting a new one. The
   new one declines until the old lease expires, up to 10 minutes.

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

- installs Node 22, and the GitHub CLI from GitHub's apt repository (its
  keyring checked against a pinned SHA-256), which verifies every bundle;
- clones the repository as root;
- installs the units and enables the update timer;
- deploys the latest bundle CI has published;
- creates `/etc/vaipakam/keeper.env` from the template, if there is none.

It never enables or starts the keeper. That is the cutover in §5, so a
machine that is installed but not cut over cannot start a second keeper at
its next boot. Running it again is safe. It installs the units and
`update.sh` of the commit that is running, never a newer one (each deploy
installs its own commit's, step 6 of §1), so a re-run while deploys are
paused leaves the machine on one commit's code and units. It also moves Node to
the latest 22.x release. When Node or the keeper's unit changed, it restarts
a running keeper onto them, after its current tick. So re-run it to take Node
security releases; it moves the GitHub CLI to its latest release too. Node lives in `/usr/local/lib/vaipakam-node`, which the
script owns outright: it keeps the version in use and the one before it, and
removes older ones. Nothing in it is run, not even to read its version, unless all of it is root's and writable only by root; otherwise it is deleted and Node is installed again. The machine always
follows `main`, the one branch CI builds the keeper from; the script refuses a
`KEEPER_DEPLOY_BRANCH` naming any other. A re-run leaves paused deploys paused (§6):
only the first install to complete turns the update timer on. One rule
decides whether `/opt/vaipakam-keeper` is trusted: unless a completed install
made it and everything in it is root's and writable only by root, the whole
tree is deleted and made again, never repaired piece by piece. The env file
is replaced by a fresh root-owned copy with the same contents, so nothing
that held the old file open keeps access. And whether a running keeper needs a restart is read from the
machine, not remembered: it restarts when Node or its unit changed after it
started, so a re-run after an interrupted one still does it.

## 4. Configure

Fill in `/etc/vaipakam/keeper.env` on the machine (`sudo -e
/etc/vaipakam/keeper.env`). Never paste a value from it into chat, a ticket or
a commit. The template documents each line. In short:

- **Database:** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_D1_API_TOKEN`, a token
  with the account's D1 Edit permission only. Cloudflare cannot limit a token
  to one database, so it can reach every D1 database on the account. Make one
  for this machine; never reuse a deploy token. `D1_DATABASE_ID` is prefilled.
  The keeper's private database needs no setting: its id is pinned in the code,
  as the Worker's binding is (§4a).
- **Runner id:** leave `KEEPER_RUNNER_ID` empty and the machine uses
  `host:<host name>`. Set it only if two machines could share a host name;
  never give two machines the same one.
- **Arming:** leave `KEEPER_ENABLED=false` and every per-pass flag empty.
- **Secrets:** `KEEPER_PRIVATE_KEY`, each served chain's `RPC_*`,
  `TG_BOT_TOKEN` (the USER bot, for HF-band alerts — never `TG_OPS_BOT_TOKEN`,
  CLAUDE.md "Two Telegram bots"), `PUSH_CHANNEL_PK` and the aggregator keys.
- **Operator alerts:** `TG_OPS_BOT_TOKEN` and `TG_OPS_CHAT_ID`, the OPS bot
  and its single operator chat. This is a separate bot from `TG_BOT_TOKEN`,
  and the two tokens are never shared (CLAUDE.md, "Two Telegram bots"). The
  sanctions-hold pass sends its deadline, overdue, capacity and backlog alerts
  here as one digest post per chain per run, however many wallets they name
  (#2565), plus one post per run of one-off notices when its settlement moves
  reward value or a lapsed held chain restarts (#2515); the horizon heartbeat its revert,
  overdue-entry and paused-clock alerts; and the delivery-proof pass its
  not-yet-whole and refused-proof alerts (#2516). With either value unset,
  every such alert goes only to the journal,
  as `ops alert NOT delivered`. So set both, and confirm that line is absent,
  before arming any pass that alerts here: `REWARD_SANCTIONS_KEEPER_ENABLED`,
  `REWARD_HORIZON_HEARTBEAT_ENABLED`, `REWARD_DELIVERY_PROOF_ENABLED` or
  `REWARD_DAY_CLOSE_ENABLED`.
- **Knobs:** copy the live values from the keeper Worker's dashboard.

An empty value is unset, as an unbound setting is on the Worker. A chain or
pass that needs it skips without an error, so check the `chains resolved`
line (§5).

## 4a. The keeper's private database (#2450): migrations

From #2496 the keeper keeps its own operational state (scan cursors,
completion markers, the remit-ack log, HF-band edge state, its redeploy epoch) in a
private database, `vaipakam-keeper-db`, instead of the shared one.

The machine never applies the private migrations itself: the keeper's deploy
is the one applier of that database (`pnpm --filter @vaipakam/keeper run
migrate`). Instead, every tick checks that the private database, at its pinned
id, records every keeper migration this build carries, and declines naming the
missing ones until it does. It resumes by itself once they are applied.

The one-time copy of the five tables that began in the shared database ran on
2026-10-18 and is retired (#2560). Indexer migration `0064` drops the old shared
copies, so the tick no longer reads them (DeploymentRunbook, "Keeper private D1
— one-time cutover").

After a Diamond redeploy the indexer resets that chain's rows, and the keeper
applies the same reset to its own private records, logging
`Diamond changed … reset private …` once. It does that only once the indexer has adopted
the same Diamond, and a chain runs at all only while the indexer's adopted
Diamond equals the one the keeper is configured with — checked on every tick,
not only when the keeper's own record is due to change. Otherwise the tick
declines with `is not the indexer's … waiting for it to adopt the same
deployment`, for every chain, because the passes must not read one
deployment's ids against the other's shared rows: the keeper's deploy landed
before the indexer's, or the indexer is still mid-reset, or it has moved to a
Diamond this build does not name yet. That window lasts until the indexer's
next run after its own deploy (or, in the last case, until the keeper's next
update). A decline that persists means one of the two has not picked up the
redeploy. A pass still running from an earlier tick is held to the same rule
at every effect (`src/epochFence.ts`): a send, a subscriber alert and a
chain-scoped operator alert re-read the indexer's adoption first and are refused with `epoch fence: … moved since
this tick launched` once it has moved, and a write to a shared table the
indexer resets carries that condition INSIDE its own statement, so the check
and the write are one statement (one HTTP request here) that no adoption can
land between — a refused write changes nothing and is reported as `refused by
its statement's guard`. So the minute between the indexer's move and the next
declined tick is not a window in which an old pass can act.

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
   - no `tick declined` line, no skipped-minute line, and no `not launched …
     its previous run is still in flight` line. A pass whose previous run is
     still going is not started again, but every other due pass still runs
     that minute, so a slow pass cannot hold back the liquidator. A tick
     that takes the lease logs `runner "host:…" acquired the one-runner
     lease`. A restart within the lease's 10 minutes renews it without that
     line, so its `chains resolved` line is the evidence (§6, "Apply an
     env-file change"). A `holds the one-runner lease` decline means another
     runner is live, so stop and find it.

   Cover a full 15-minute cycle (`preGraceWatcher`) and the 00:00–00:09 UTC
   window (`dailyOracleSnapshot`). Neither checks `KEEPER_ENABLED`, so both
   run while the keeper is disarmed.
2. **Arm** only with the owner's OK: set `KEEPER_ENABLED=true` and apply
   it (§6, "Apply an env-file change"). Cover at least one full 5-minute
   cycle. A pass's `done in Nms` line does not prove it acted: a pass that is
   not armed returns at once, and its log line names the flag that held it.
3. **Per-pass flags** are each the owner's decision: `GRACE_DEFAULT_ENABLED`
   (`graceDefault`), `PERIODIC_SETTLE_ENABLED` (`periodicSettle`, every 15
   minutes from :05), `REWARD_REMIT_ENABLED` (`rewardBudgetRemit` and
   `remitAck`), `REWARD_COMMIT_ENABLED` (`commitmentReport`),
   `REWARD_DELIVERY_PROOF_ENABLED` (`deliveryProof`),
   `REWARD_SANCTIONS_KEEPER_ENABLED` (`rewardSanctionsHold`, hourly) and
   `REWARD_HORIZON_HEARTBEAT_ENABLED` (`rewardHorizonHeartbeat`, hourly at :44; its
   entry close-out step also needs `REWARD_ENTRY_SETTLE_ENABLED`) and
   `REWARD_DAY_CLOSE_ENABLED` (`rewardDayClose`, every 15 minutes from :10),
   `REWARD_CLOSE_OUT_ENABLED` (`rewardCloseOut`, every 15 minutes from :00),
   `REWARD_ZEROED_DAY_ENABLED` (`rewardZeroedDay`, every 15 minutes from :09),
   `REWARD_RETURN_TRANSPORT_ENABLED` (`rewardReturnTransport`, hourly at :29),
   `PROTOCOL_UPKEEP_ENABLED` (`protocolUpkeep`, hourly at :59; its
   prepay-sale sanctions sync step also needs
   `PREPAY_SALE_SANCTIONS_SYNC_ENABLED`, and its tier-push retry step
   `TIER_PUSH_RETRY_ENABLED`),
   `PREPAY_AUTO_LIST_ENABLED` (`prepayAutoList`, every minute), and
   `DISCOUNT_PATH_CHAIN_IDS` (a list of chain ids, not `true`: the flash-loan
   branch of the liquidator, armed per chain by
   [`FlashLoanLiquidatorRollout.md`](FlashLoanLiquidatorRollout.md) only; the
   keeper states how it read it in a `discount path:` line at every start). Arm one at a time and
   validate that pass's own cadence: its `<pass> done in …` line on the
   minutes `src/passSchedule.ts` gives it, with no error line. A pass left
   unarmed logs that it skipped, so it is never silently off. Leaving the
   delivery-proof pass unarmed leaves mirror-funded days gated. Leaving the
   sanctions pass unarmed lets held owners' evidence chains lapse. Leaving the
   horizon heartbeat unarmed means no reward's claim-horizon clock is ever
   observed, so an armed horizon expires nothing. Leaving the day-close pass
   unarmed means no reward day is reported, finalized or broadcast unless
   someone makes those calls by hand. It pays each mirror's CCIP report fee
   and Base's broadcast fees from the keeper key, so check that key's gas on
   every reward chain before arming it.

Rollback at any point: set `KEEPER_ENABLED=false` and apply it (§6), or stop
the service (§6). The Worker side needs no change, because its schedule stayed
empty.

## 6. Stop, roll back, move hosts

- **Apply an env-file change.** The keeper reads `/etc/vaipakam/keeper.env`
  only when it starts. Every runbook that changes a setting there uses these
  two steps:
  1. Edit the file (`sudo -e /etc/vaipakam/keeper.env`). Never paste a
     value from it anywhere.
  2. Run `sudo systemctl try-restart vaipakam-keeper`. `try-restart`
     restarts the keeper only if it is running. A keeper someone stopped on
     purpose stays stopped, and reads the new file when it is next started.
     Plain `restart` would start it again. The restart waits for the tick
     in flight to finish.

  To confirm the change took, look for a tick that began after the restart:
  `journalctl -u vaipakam-keeper --since "$(systemctl show -p
  ActiveEnterTimestamp --value vaipakam-keeper)"` must show a `[keeper]
  chains resolved: …` line, and no `tick declined` line. A tick prints that
  line only once it holds the one-runner lease. Do not wait for the
  `acquired the one-runner lease` line. It appears only when the lease
  changes hands, and a restart within the lease's 10 minutes renews it under
  the same runner without printing it.
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
  command stops a deploy already running (and its verification), so it cannot
  switch `current` after you have paused. Stopping only the timer would let
  that deploy finish and switch anyway. A deploy stopped just after switching
  leaves `restart-pending`, and the next run, once deploys resume, restarts
  the keeper onto that release. `disable`
  keeps the timer off across a reboot. Resume with `sudo systemctl enable
  --now vaipakam-keeper-update.timer`.
- **Roll back:** pause deploys (above) first. Then point `current` at an
  earlier release (`sudo ln -sfn /opt/vaipakam-keeper/releases/<commit>
  /opt/vaipakam-keeper/current`), run `sudo /opt/vaipakam-keeper/update.sh
  --kit-only` so the units are that release's own again (until then the
  keeper refuses to start, §1), and run `sudo systemctl restart
  vaipakam-keeper`. A rollback uses the bundles kept on the machine; it
  needs neither CI nor the network. **To return to `main`**, resume deploys:
  the next run sees that `current` is not the branch tip's release and
  deploys it. The one exception is a branch tip whose build source is
  identical to the rolled-back release's. That tip's bundle is the same one,
  so the keeper stays on it.
- **Move hosts:** on the old machine run `sudo systemctl disable --now
  vaipakam-keeper vaipakam-keeper-update.timer`. Then enable the new machine
  with the §5 cutover. `disable` matters: a unit
  that is only stopped starts again at the next boot, which would put a
  second keeper on the same key. Confirm the process has exited (`systemctl
  is-active vaipakam-keeper` prints `inactive`), then start the new machine.
  Never the other way round (§2).

## 7. Not yet true

- **The lease is not a fencing token** (§2). It stops a second runner from
  starting ticks, not a pass that outlives the lease from finishing.
- **Batch atomicity over the D1 HTTP API is unverified, and nothing relies on
  it.** Both `batch` call sites ([`apps/keeper/src/hfBandNotifications.ts`](../../apps/keeper/src/hfBandNotifications.ts)) are idempotent
  and already run as two separate batches, so a partial write leaves the same
  state a failed tick does. A new `batch` that needs all-or-nothing must be
  verified on a scratch database first, never on `vaipakam-warm`.
- **The lease stays in the shared database** for now, while every other
  keeper-only table moves to the private one (§4a). Moving it later is its own
  change, because two runners must agree on one lease while they cut over.
