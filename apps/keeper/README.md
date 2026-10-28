# @vaipakam/keeper

**Vaipakam's first-party autonomous keeper — Cloudflare Worker. Cron-driven, no HTTP surface, holds `KEEPER_PRIVATE_KEY`.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **signing Worker** of the Vaipakam off-chain stack. Stage 3 PR2 + architectural-rebalance commit (see [Stage3WorkerSplitPlan.md](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md)) split the original monolith and concentrated all on-chain-writing responsibility here. The signing key lives on exactly one Worker — this one. (Staging plan §2 least-privilege contract.)

Today this Worker does:

- **HF watcher loop** — periodic Health Factor scan across active loans on every chain it covers.
- **Autonomous on-chain liquidation submission** — when HF < 1.0, submits `triggerLiquidation` via the configured swap aggregator.
- **HF band-downgrade alerts** — fires Telegram + Push notifications when borrower HF crosses watcher-defined thresholds.
- **Daily oracle snapshot signer** — submits `OracleFacet.captureDailyPriceSnapshot` (moved here from agent in the rebalance).

Also LIVE (per [`RangeOffersDesign.md`](../../docs/DesignsAndPlans/RangeOffersDesign.md) §7 of the Stage 3 plan; this said "Tomorrow"): the off-chain offer matcher, scheduled every cron tick, for Range Orders + Lender Partial Fills, submitting `matchOffers(lenderId, borrowerId)` to earn the 1% LIF matcher fee.

**Non-goals:** no user-facing reads (those belong to `apps/indexer`); no notifications setup endpoints (those belong to `apps/agent`); no public Frame / Telegram bot surface (also `apps/agent`).

**Important:** this Worker is **distinct from the public reference keeper bot** at the sibling [`vaipakam-keeper-bot`](https://github.com/vaipakam/vaipakam-keeper-bot) repo. That one is for third-party operators who want to run their own keeper. This one is the project's own and the only privileged Worker.

## How to run

```bash
pnpm --filter @vaipakam/keeper dev      # local wrangler dev (no live txs)
pnpm --filter @vaipakam/keeper run deploy   # verifies the shared D1 schema, then wrangler deploy; uses `wrangler login` on the operator's machine
pnpm --filter @vaipakam/keeper run migrate  # applies apps/keeper/migrations/ to the keeper's PRIVATE D1 (vaipakam-keeper-db); `run deploy` also does it first
```

**The deploy verifies the shared D1 schema first** (#2409). This Worker binds the shared `vaipakam-warm` database, whose schema `apps/indexer` owns, so `run deploy` runs `apps/indexer/scripts/deploy-shared-d1.mjs verify` before publishing: a read-only check that every migration the build carries is recorded. It waits up to ten minutes for the indexer's deploy to apply pending ones, then refuses to publish onto an older schema. It never applies migrations itself. Toward the SHARED schema the deploy is read-only. It also APPLIES the keeper's private schema (below), so the token needs **D1 Edit** (an Edit grant also covers the shared verify) as well as Worker publish rights, and on a release that carries a shared migration, **deploy the indexer first**. `run deploy` takes no arguments; a dry run is `run deploy:dry`, which never touches the database.

**It APPLIES the keeper's PRIVATE schema itself** (`vaipakam-keeper-db`, #2450 — see "D1" below): the keeper is that database's only writer, so `run deploy` applies `apps/keeper/migrations/`, verifies every file is recorded in the database, and only then verifies the shared schema and publishes. The one-time row copy that preceded the first such deploy ran on 2026-10-18 and is retired (#2560): indexer migration `0064` drops the old shared copies, and the deploy no longer checks for them ([`docs/ops/DeploymentRunbook.md`](../../docs/ops/DeploymentRunbook.md), "Keeper private D1 — one-time cutover").


**On an always-on machine instead of Cloudflare:** `pnpm --filter @vaipakam/keeper start:host` runs the same tick in one long-lived Node process, reaching the same D1 database over Cloudflare's HTTP API. Setup, configuration, the one-copy rule and the differences from the Worker are in [`host/README.md`](host/README.md).

## How to test

```bash
pnpm --filter @vaipakam/keeper typecheck
pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit
```

## Architecture

- Worker split design: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Matcher roadmap: [`docs/DesignsAndPlans/RangeOffersDesign.md`](../../docs/DesignsAndPlans/RangeOffersDesign.md).
- ADR-0006 (Three-tier CI split): [`docs/adr/0006-three-tier-ci-split.md`](../../docs/adr/0006-three-tier-ci-split.md) — how this Worker's deploys gate.

## Configuration

Cloudflare Worker secrets (set via `wrangler secret put`):

| Secret | Purpose |
|---|---|
| `KEEPER_PRIVATE_KEY` | The signing key. Holds funds; rotate per the AdminKeysAndPause runbook. |
| `RPC_*` | Per-chain RPC URLs (carry API keys). |
| `KEEPER_ENABLED` | Kill-switch for the **gated** passes; set to `false` to disable them. **It does not cover every on-chain write** — see the note below. |
| `REWARD_REMIT_ENABLED` | Arms the #776 reward-budget remittance pass (in addition to `KEEPER_ENABLED`). Keep off until the keeper EOA is authorized on-chain via `setRewardRemittanceKeeper` (or is ADMIN). Also arms the #1222 B2-d2 remit-ACK pass (scans Base's delivered-backing reservations, sends the mirror ack for each landed delivery — and, since #1461, for a RELEASED reservation whose delivery landed after all and carries no classification stamp yet, so Base resolves the share it counted as stranded when the mirror credited it). **Apply the keeper's own D1 migration `0001_keeper_state.sql` to `vaipakam-keeper-db` before enabling** (`run migrate`; the remit-ack tables moved there from shared migration 0044 in #2450). |
| `REWARD_DELIVERY_PROOF_ENABLED` | Arms the #1944 / transport-epoch delivery pass (in addition to `KEEPER_ENABLED`). On every mirror it INDEXES each delivery's epoch days chunk by chunk (`materializeTransportBatchChunk`) and PROVES the days of each delivery that holds no epoch (`proveDeliveryDayChunk`), rebuilding the rooted list from the packet's own remitter and checking it against both roots before sending. Every budget delivery is rooted (d6): the mirror receiver refuses any older wire, so there is no flat-list route. Permissionless calls; no value moves. Without it an epoch's days are never indexed, so its value funds nothing a claim can find, and an armed delivery gate holds every funded day. Arm it on every mirror before reward transport is live. It sends OPS-bot alerts per mirror (#2516): a delivery still not whole one scan interval after the first scan that could reach it, that is, the scan that found it in the indexer's settled ledger, whenever it arrived (#2775) (named, with when it arrived and when it was found; a delivery it just worked on is read again before it counts as whole; cleared only by a run that looked at every open delivery, and a run that could not says "at least"), and a proof or index call the contract refused for anything but the work already being done, a mined revert included (named, with the days the call covered and the reason, every refusal of a run in one message; a provider timeout is not a refusal; cleared once that delivery is whole, its calls go through, or it is no longer open work). |
| `REWARD_SANCTIONS_KEEPER_ENABLED` | Arms the #2450 sanctions-hold observer (in addition to `KEEPER_ENABLED`). It keeps every held reward claimant observed at least every six hours, so a hold confirms or clears within its window instead of restarting, and once a verdict is final it runs the owner settlement (the days earned while flagged are forfeited, the rest set apart for the wallet) and resolves the claimant's held staging records — which is what lifts the staging encumbrance that blocks custody activation and reward-role changes. Every call it makes is permissionless and moves value only into protocol custody or to the claimant. Its ops-alert table lives in the keeper's private `vaipakam-keeper-db`, not in the shared database; the keeper's `run deploy` applies that schema (or `run migrate` alone). It also sends one-off ops notices (#2515), as one post per chain per run after its standing alerts: each of its own settlements or staging resolutions that moved reward value (set apart, paid, a staged payout forfeited, and the transaction's whole forfeited-reward credit to the recycle bucket, each read from that transaction's own events and labelled as the owner's or the transaction's), and each held claimant whose chain had lapsed and restarted. A lapse is judged exactly from the contract's own reads in one block; the lapsed chain's last observation is not readable once it lapses, so the notice bounds the gap rather than stating it. Every notice is also written to the journal. Best-effort, and covering only claimants this run touched. Arm it on every reward chain before reward staging is live there. |
| `REWARD_HORIZON_HEARTBEAT_ENABLED` | Arms the #2517 reward claim-horizon heartbeat (in addition to `KEEPER_ENABLED`). A reward's claim-horizon clock advances only when something touches it (`sweepExpiredInteractionRewards`, permissionless), so this pass queues every live reward entry from the global entry sequence and touches each about every 12 hours, far inside the contract's 7-day observation gap. While the horizon knob is dark it only discovers, and touches just the entries whose removal has begun (their settlement still has to finish). An expired reward moves only into the protocol's recycle bucket, never to the keeper. Its operator alerts: a touch that reverts (named, with the reason), entries not reached for two heartbeats (touches not landing, or more live entries than its 300-an-hour capacity reaches — the alert states which figures it has), and clocks that did not advance across two landed touches (an estimate moving by exactly the time between readings; a horizon retune is not one). It reads the protocol's pause state first: while paused it sends nothing and raises or clears none of the queue-wide reports. Entries that keep failing rotate to the back of the slice. Each run logs `discovery=caught-up` or `discovery=behind (next id N)`. Its queue and cursor live in the keeper's private `vaipakam-keeper-db` (migration `0005_keeper_horizon.sql`). **Arm it on a chain before `setRewardClaimHorizonDays` is armed there** (GovernanceRunbook, M7.2). |
| `REWARD_DAY_CLOSE_ENABLED` | Arms the #2612 reward day-close pass (in addition to `KEEPER_ENABLED`), every 15 minutes from :10. On every reward chain it closes each elapsed reward day not yet reported there (`closeDay`), every elapsed day being held as owed until it is worked through (the `day_owed` ledger), the last 14 every run and older owed days 14 per run in turn: on a mirror that sends the day's interest report to Base over CCIP, paying the messenger's quoted fee from the keeper key (the messenger refunds any unused part); on Base it records Base's own report. A mirror closes a day even after Base has finalized it: Base drops that report's day figures but still applies its chain-wide ones (custody era, recycled and commitment cumulatives). Every chain has one report shape (#2621): the fee is quoted along the route `closeDay` names (the Diamond's Base), and a messenger routed elsewhere is reported as refusing the quote. Whether a messenger carries that report is read from its code, on this chain and on Base, and the report channel holds every close (with the channel alert) unless both do; either unread holds too. (The B4 report path for the pre-#2790 deploys was removed at the all-waves fresh deploy, #2866.) It closes no day on a mirror whose reward clock (`getInteractionLaunchTimestamp`) differs from Base's, and Base finalizes no day while a listed mirror it serves runs another clock; each raises an alert until the clocks match (Base itself counts no day figures from a report on another clock, #2620; the keeper's hold saves the lane fee and says why). On Base it then finalizes a day (`finalizeDay`) once every chain on Base's expected-source list has reported, judged chain by chain rather than by report count, or once the grace window since the day's first report has elapsed, and only when the contract agrees; and it broadcasts each finalized day (`broadcastGlobal`, the quoted fee), confirming delivery by reading each destination this keeper serves and re-sending after 6 hours to the destinations still lacking it (`broadcastGlobalTo`; every destination when the day or the messenger cannot take a single-destination send). Each destination is judged against the last send that covered it, so one added to the list after the day went out is sent it on its own. A destination taken off the messenger's list after a send that never reached it, or an expected mirror never on it, is still checked and sent to on its own; if the Diamond refuses that, the refusal says the mirror cannot be reached and the day stays in view (a mirror off the list with no standing in the day is owed nothing). A Base day finalized before Base's own close counts as worked through once broadcast, and the window is read in bounded slices however long a stuck day holds it open. A destination list that cannot be read skips only the broadcast (finalizing goes on) and raises an alert until it reads. A destination this keeper does not serve is sent to once per day and reported unconfirmed. Every write is simulated first, at most 8 per chain per run. OPS-bot alerts: a refused call (by step and day, with the reason); an expected chain still missing within an hour of grace ending, or in the last quarter of a grace shorter than four hours (with whether that chain has sent its report); an expected-source list that is empty or leaves Base out (no day is finalized against either), an expected-source list and broadcast destinations that disagree either way, or Base itself or a repeated mirror among the destinations (read every run, cleared only on a read showing the fix); a broadcast not received, or not readable on the mirror, 2 hours after it was last sent there, raised in the run that re-sends it too (cleared only when the mirror is read holding it); on a mirror, a day Base finalized without its report, sent or not; and, on a mirror, the chain missing from Base's expected-source list, since Base then refuses its reports and the chain-wide figures they carry (#2618). A day finalized with chains missing, by this keeper or anyone else, is posted once as a notice naming them, read from Base's record of who reported the day at a block where it is finalized; it is journaled and recorded (kind `day_zeroed`) and re-posted until delivered. A broadcast's send time is recorded before it goes out, so a send whose receipt was not seen is not repeated before the re-send interval; a send the node refused outright is not counted as made. A call the RPC gives no answer about is logged and stops that run's sends; it is never reported as a refusal. Its only state is in the keeper's private work tables: per chain, the first day not yet entered into its ledger (`keeper_work_cursor`, kind `day_close`, which only moves forward), and in the open-work queue (`keeper_work_open`) the ledger of owed days (kind `day_owed`), every destination each broadcast's day has had, with the last send that covered it (kind `day_broadcast`), each finalized day's zeroed chains with whether that notice was delivered (kind `day_zeroed`), those two kept while the day is owed or in the last 14 days, and each peer chain's reward clock as last read (kind `day_clock`), so a mismatch once seen stands while that chain cannot be read; no new migration. |
| `TG_OPS_BOT_TOKEN` / `TG_OPS_CHAT_ID` | The OPS bot and its single operator chat, for operator alerts from the reward passes (the sanctions-hold observer and the horizon heartbeat). Never the user-facing `TG_BOT_TOKEN`: the two bots are split by who reads the alert. Unset = the alert is written to the Worker log only, and every attempt says so. |
| `REWARD_COMMIT_ENABLED` | Arms the #1222 B2-d1 mirror→Base commitment-report pass (in addition to `KEEPER_ENABLED`). Runs on mirrors only; keep off until the keeper EOA holds on-chain `KEEPER_ROLE` (`submitCommitmentBatch` is role-gated). |
| `GRACE_DEFAULT_ENABLED` | Arms the #2483 time-based default pass (in addition to `KEEPER_ENABLED`): it submits `triggerDefault` for loans past their grace period, which sells or transfers the borrower's collateral. Needs no on-chain role (`triggerDefault` is permissionless). It skips, with a logged reason, any loan whose route would fall into the full-collateral fallback, whose lender position has an accepted sale, or whose collateral changed after quoting. |
| `PERIODIC_SETTLE_ENABLED` | Arms the periodic-interest settler (in addition to `KEEPER_ENABLED`), every 15 minutes from :05. For a loan on a periodic-interest cadence whose period's grace is over (`previewPeriodicSettle`), it submits the permissionless `settlePeriodicInterest`. When the borrower paid the period, the call only moves the checkpoint forward and pays the keeper nothing. When interest is short, the call sells part of the borrower's collateral: `previewForcedSale(loanId, 0)` sizes the range the contract accepts (from the least collateral whose worst-case proceeds cover the shortfall and the largest charges, #2795, up to its `maxSell`, #2796), and the keeper quotes and sends the middle of that range, never the whole collateral. It leaves an under-water loan to the liquidator and a loan past its maturity grace to the grace-default pass, re-reads both and the plan at one fresh block, and sends only a call that simulates there. A quote that left the range between the quote and that block, a period that turned from stamp to sale, no route, or a failing simulation is skipped with the reason logged. Needs no on-chain role. Ships unset. |
| `ZEROEX_API_KEY` / `ONEINCH_API_KEY` | Liquidation, time-based-default and periodic-settlement swap aggregator credentials. |
| `TG_BOT_TOKEN` / `PUSH_CHANNEL_PK` | Alert dispatcher credentials. |

The arming flags above (`KEEPER_ENABLED`, `REWARD_REMIT_ENABLED`,
`REWARD_COMMIT_ENABLED`, `REWARD_DELIVERY_PROOF_ENABLED`, `REWARD_SANCTIONS_KEEPER_ENABLED`, `REWARD_HORIZON_HEARTBEAT_ENABLED`, `REWARD_DAY_CLOSE_ENABLED`, `GRACE_DEFAULT_ENABLED`, `PERIODIC_SETTLE_ENABLED`) are `secret_text` bindings, not entries in
`wrangler.jsonc`'s `vars` block — see that file's `vars` comment for why they
must not be moved there. Their values cannot be read back from the API or
dashboard, which is why each gated pass reports at runtime how it resolved
them (#1475).

Plain vars — dashboard-managed, **not** secrets, and preserved across deploys
by `keep_vars: true` because this config declares no value for any of them:

| Var | Purpose |
|---|---|
| `REWARD_REMIT_LOOKBACK_DAYS` | Recent-day window the remit pass re-scans for un-remitted budget each tick (default `45`). |
| `REWARD_REMIT_LANE_CAP` | Ceiling (wei) on each remitted **part** (#918). Each tick the pass sends a part no larger than the smaller of this and the Base lane bucket's live tokens, so a day above it goes in several parts over several ticks and the mirror opens it once every part has landed. It no longer needs to cover the largest day slice. Default `50000e18` (matches the on-chain lane default). |
| `REWARD_COMMIT_LOOKBACK_DAYS` | Recent-day window the commitment pass re-scans for un-reported armed days each tick (default `14`). |
| `REWARD_DAY_CLOSE_MAX_FEE_WEI` | The most one day-close send pays as its CCIP fee (#2627): comma-separated `<chainId>=<wei>` entries, plus an optional `*=<wei>` for every chain not named. Unset, `2000000000000000` wei (0.002 of the native token) on every chain. A quote above the ceiling is not paid: the call is reported refused, naming the quote and the ceiling, and the day stays owed until the quote falls or the ceiling is raised. A malformed value pays nothing on any chain and is said by the held-steps alert. Calls that pay no fee (`finalizeDay`, `advanceInterestFrontiers`, Base's own `closeDay`) are not affected. |
| `DISCOUNT_PATH_CHAIN_IDS` | The chains the flash-loan discount branch of the liquidator may run on (#2633): comma-separated chain ids. Unset arms none; a value that cannot be read (an entry that is not a chain id, a chain named twice) arms none and says so. A chain also needs a FlashLoanLiquidator and a flash-loan provider in `src/flashLoanProviders.ts`; no chain has a liquidator today. The machine logs how it read the setting at every start (`discount path:`). Arm only per `docs/ops/FlashLoanLiquidatorRollout.md`. The branch sizes each run from the Diamond's preview of the liquidation and keeps at least the transaction's own fee (#2697), and skips every loan on a chain whose gas it cannot value. |
| `LIQ_*` / `SPLIT_*` / `PARTIAL_LIQ_*` | Liquidation tuning (see `src/env.ts`) — all optional, sensible defaults. |
| `FRONTEND_ORIGIN` | Connected-app origin for notification deep links. **Optional but without a usable default** — unset, the consumers fall back to the empty string and a "View this loan" link renders as the relative `/loans/{id}`, which is not clickable from Telegram or Push. Set it (e.g. `https://app.vaipakam.com`) on any deploy whose notifications are meant to be followed. |

The first four tune the passes the arming flags gate, but are not themselves
secrets — they sat in the secrets table above until #2223, where the
`wrangler secret put` instruction would have provisioned them as unreadable
values for no benefit.

Config-owned var — its value is committed in `wrangler.jsonc`'s `vars`, so every deploy writes it. It is **not** a secret and not dashboard-managed: never set it with `wrangler secret put` or in the dashboard, where the next deploy would overwrite it.

| Var | Purpose |
|---|---|
| `KEEPER_RUNNER_ID` | This copy's name for the one-runner lease (#2503). Every tick claims the lease first and declines while another copy holds it; unset declines every tick. The Worker's is `cloudflare-worker` in `wrangler.jsonc`; a machine's defaults to `host:<host name>`. See `docs/ops/KeeperMachine.md` §2. |

`TG_BOT_USERNAME` is a plain var too, and the exception to the preservation
note above: this config **declares** it, so every deploy uploads the declared
value and a dashboard edit is overwritten rather than preserved. Note though
that setting it here changes nothing observable — as §"What the kill-switch
does and does not stop" records below, no keeper code reads it; the Telegram
deep link that uses the handle is built by `apps/agent` from its own binding.
It is a legacy config-owned value, kept because the declaration is what makes
the overwrite behaviour visible, not because the keeper needs it.

See [`CLAUDE.md` § "Deployments sync"](../../CLAUDE.md) for the full secret list and rotation cadence.

### What the kill-switch does and does not stop (#1548)

`KEEPER_ENABLED=false` disables the seven **gated** passes: `matcher`,
`liquidator`, `autoLifecycle`, `graceDefault`, `rewardBudgetRemit`, `remitAck`
and `commitmentReport`.

**`dailyOracleSnapshot` is not among them and still signs.** It is gated only
on `KEEPER_PRIVATE_KEY` being present, so with the kill-switch off it
continues submitting `captureDailyPriceSnapshot` every day, and continues
spending gas.

That is deliberate, decided 2026-08-03: the snapshot is a public good rather
than an autonomous risk-taking action — anyone can call
`captureDailyPriceSnapshot` permissionlessly — and gating it would leave holes
in the oracle series whenever the keeper is disabled for an unrelated reason.

The practical consequence, which is the reason this section exists: **flipping
the kill-switch is not a way to stop the keeper spending gas entirely.**

**Stop the runner, not the key.** The keeper runs only on the always-on
machine (`docs/ops/KeeperMachine.md`); this Worker's `scheduled` handler
declines every invocation, so nothing on the Cloudflare side stops or starts
the keeper. The whole emergency stop is on the machine:

```bash
sudo systemctl disable --now vaipakam-keeper-update.timer
sudo systemctl stop vaipakam-keeper-update.service
sudo systemctl stop vaipakam-keeper
systemctl is-active vaipakam-keeper   # must print `inactive`
```

Pausing the update timer first matters: otherwise the next update run could
restart the keeper. Stopping waits for the tick in flight to finish, because a
kill can cut a pass off between sending a transaction and recording it
(`KeeperMachine.md` §6, including what to do about a stop that hangs). To
resume, `sudo systemctl enable --now vaipakam-keeper-update.timer` and
`sudo systemctl start vaipakam-keeper`.

The Worker's committed `"crons": []` stays as it is (empty, not absent, so a
deploy never leaves an old schedule in place); with the handler declining, a
schedule restored by hand would run nothing anyway.

**Do not pull the key instead.** Removing `KEEPER_PRIVATE_KEY` from the
machine's env file is no faster than stopping the service, and it leaves a
process running that you then have to reason about. The service stop is
complete and reversible.

**The var hazard is handled by the deploy script, not by this config being
small** (Codex #1924 r7). An earlier revision said the hazard was "resolved"
because `TG_BOT_USERNAME` is the only var declared here and `apps/keeper`
never reads it. That reasoning was backwards: a bare `wrangler deploy`
deletes every var **not** in the config before applying the ones that are, and
what is not in the config is exactly the dashboard-managed tuning the keeper
*does* read — `HF_SCALE`, the `LIQ_CONFIDENCE_*` and `LIQ_TIER3_*`
thresholds, `SPLIT_MIN_IMPROVEMENT_BPS`, `PARTIAL_LIQ_MIN_HF_BPS` (see
`env.ts`). A small config makes the hazard **worse**, not better.

So `apps/keeper`'s `deploy` script runs `wrangler deploy --keep-vars`,
which makes the canonical `pnpm --filter @vaipakam/keeper run deploy`
safe by construction rather than depending on whoever is typing it.

**Superseded as the primary defence (#1995): the hazard is now removed in
configuration.** `wrangler.jsonc` declares `"keep_vars": true`, which wrangler
reads on both the `deploy` and `versions upload` paths — so **every** spelling
of a deploy preserves dashboard-managed vars, including a bare
`wrangler deploy` and including spellings nobody has written yet. Requiring the
flag per call site was an unbounded predicate: #1995 answered 242 review
findings enumerating ways to spell a deploy (package scripts, manifest aliases,
Makefile variables, sourced helpers, shell functions and aliases, matrix
expressions, reusable-workflow inputs, Windows shims, `eval`, marketplace
actions) without reaching the end.

The flag stays on the package script — it is still correct, and harmless.
`scripts/check-keep-vars.mjs` asserts the declaration itself, unconditionally
in CI, on **every** wrangler config in the tree — any depth, any directory,
whatever Worker it names — and is now the whole implemented defence. The rule
is unconditional because deciding which config a deploy loads, and which
Worker it targets, are command-line questions (`--config`, `--name`, `--env`,
`--compatibility-date`) that no file scan can answer; six review findings in
one round came from trying. `apps/app` and `apps/www` declare the key too,
though they carry no vars today.

**The trade, stated deliberately:** a deploy can no longer *remove* a var.
Deleting one is now an explicit dashboard action — see the rollback note in
`apps/indexer/wrangler.jsonc` for a case where that matters.

**The tree-wide command scanner that used to sit alongside it is retired.**
`scripts/check-deploy-invocations.mjs` searched every file in the repository
for a keeper-scoped `wrangler deploy` lacking `--keep-vars`. It was written
because fixing the package script did not fix the problem — four review rounds
each found another caller reaching wrangler directly — but asking whether a
piece of text will run a command means modelling the execution model of every
interpreter it might be, and it never got there: seventeen open issues, each a
different parsing edge, five of them false reports that redden a correct tree,
and none naming a real file here. The declaration answers the same question
without parsing anything, so the scanner and its fixtures (about 23,800 lines)
are gone. What that gives up is listed by name in the header of
`scripts/check-keep-vars.mjs`.

Keeping vars costs nothing here: the only var this config declares is
`TG_BOT_USERNAME`, which appears solely in `env.ts`'s passthrough and is read
nowhere in the Worker.


**Three other passes also run ungated** — `watcher`, `preGraceWatcher` and
`liquidityConfidence` — so the snapshot is not the only thing the switch
leaves alive. The health-factor watcher matters most: it keeps evaluating
positions and **keeps sending Telegram and Push alerts to users**. If the
reason for flipping the switch is that users should stop hearing from the
system, the switch alone does not do it.

`liquidityConfidence` in particular has a gate narrower than it looks: it decides whether to **submit on-chain**. The pass still reads, and
still writes its D1 counter — `upsertLiquidityConfidence` runs before the
`canSubmit` check, deliberately ("always persist the updated counter, even
when not submitting"). So `KEEPER_ENABLED=false` stops its transactions, not
its storage writes.

### Confirming a flag actually took (#1475)

Secrets cannot be read back — the API and dashboard return names only. So
every **gated** pass emits exactly one line per tick, whichever way its gate
goes, and one `wrangler tail` cycle resolves all of them:

```
[keeper] rewardBudgetRemit start
[keeper] commitmentReport skipped: REWARD_COMMIT_ENABLED wrong case — these flags require lowercase `true`
[keeper] remitAck skipped: KEEPER_ENABLED unset; KEEPER_PRIVATE_KEY unset
```

The gated passes are every pass in `KEEPER_PASSES` (`src/passSchedule.ts`)
whose run calls `passIsArmed`: today `matcher`, `liquidator`, `autoLifecycle`,
`graceDefault`, `rewardBudgetRemit`, `remitAck`, `commitmentReport`,
`deliveryProof`, `rewardSanctionsHold` and `rewardHorizonHeartbeat`. The others
(`watcher`, `dailyOracleSnapshot`, `preGraceWatcher`) have no on/off binding
of their own and so have nothing to report; `liquidityConfidence` always runs
and consults the keeper gate only to decide whether to submit. **Absent lines
from those four are normal** — do not read them as a failed tick.

Properties worth knowing:

**Every applicable blocker appears on the one line**, as in the third example.
Reporting only the first would mean fixing one binding, waiting a tick, and
discovering the next.

**The value itself is never printed** — only the form of the state
(`unset`, `empty`, `off (explicitly disabled)`, `wrong case`,
`has surrounding whitespace`, `unrecognised (N chars)`). Note the third:
setting a flag to `false` is the documented way to disable a pass, so it
reads as a deliberate state rather than as a fault — during an intentional
shutdown you should not be shown a line implying you mistyped something.
These are `secret_text` bindings, and the case this
diagnostic exists for is the value being wrong, which is exactly how a pasted
credential arrives; echoing it would write that credential into the logs and
defeat the no-readback protection precisely when it matters. The character
count still distinguishes a four-letter typo from a pasted key.

`KEEPER_PRIVATE_KEY` is reported as present, absent, or **malformed** — never
echoed. Malformed matters: a key that is present but unusable (wrong length,
not hexadecimal, or not a valid scalar on the curve) used to satisfy the gate, so every pass logged `start` and
then produced nothing when the key was rejected per chain. Reporting the
healthy state for a broken key is the worst direction to be wrong in, and it
would let the restore procedure sign off while nothing could sign.

The check IS the account construction, not a re-implementation of it — so
anything the signer would reject is reported by the gate, and the two cannot
drift. A syntax-only check let 32 valid-looking hex bytes through that are
not scalars on the curve (zero, or at/above the group order).

That is also why **every** key construction in this Worker goes through the
one resolver, and a test fails if a second call site appears. It is not
tidiness: `dailyOracleSnapshot` used to build the account itself, outside a
`try`, so an invalid scalar threw and the scheduled handler logged the
error — and viem's message for that case contains the rejected scalar, from
which the key is recoverable. The "never echoed" guarantee above is only
true while that remains the single construction site.

Note the second example: `KEEPER_ENABLED` accepts `True`, the two reward flags
do not. Use lowercase `true` everywhere and the asymmetry never arises; if it
already has, the log now says so instead of the pass simply staying dark.

### D1 — two bindings: shared `DB` and private `KEEPER_DB` (#2450)

This Worker binds **two** D1 databases, split by who may read the data.

**`DB` → `vaipakam-warm`** (id `e5e927cf-56c3-42c7-9820-179a235cc84f`), the **staging** database the Cloudflare staging deploy uses — see [`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](../../docs/DesignsAndPlans/CloudflareStagingDeployPlan.md) §3 for the staging-vs-primary split. It is **shared** with `apps/indexer` and `apps/agent`, and holds every table another Worker, the app or the nightly backup also reads. Its schema is [`apps/indexer/migrations/`](../indexer/migrations/) — the indexer owns it, and a schema change to a shared table lands there even when only the keeper writes it.

- Keeper writes: `user_thresholds`, `notify_state`, `telegram_links`, `liquidity_confidence`, `oracle_snapshot_state`, `notifications` (#1213 PR 2b — the liquidator pass files HF-band inbox rows into the same feed table the indexer's event/calendar producers use), `keeper_commitment_reconciled` (marks a rediscovered day consumed; the indexer writes the rows), `push_rail_status` (#2667 — its Push rail readiness, one row replaced on every watcher run, for the agent's `GET /push/status`).
- Keeper reads-only: `loans`, `offers`, `indexer_cursor` (the head-block stamp for HF-band rows), `activity_events`.

**`KEEPER_DB` → `vaipakam-keeper-db`** (id `f809ca7a-bc4a-4b17-b5bd-f36c3a3e9095`) is the keeper's **private** operational state, which nothing outside this Worker reads: `hf_band_state`, `keeper_commitment_scan`, `keeper_commitment_day`, `keeper_remit_ack_frontier`, `keeper_remit_ack`, `keeper_ops_alert` (operator-alert de-dup, scoped to its chain by a column so a redeploy clears it), `keeper_sanctions_screen` (where the sanctions-hold pass's daily screen of every loan party resumes), `keeper_sanctions_watch` (the owners that screen found held or confirmed, kept as candidates until a fresh read shows nothing left to do; empty, they are re-found on the next screen cycle), `keeper_work_open` + `keeper_work_cursor` (the delivery-proof and late-ack passes' open-work queue: a cursor discovers the event log a page at a time, never past the block the indexer has completely recorded, and an item leaves the queue only when the chain shows it finished — so an item that never finishes pins nothing; reset the two only together), `keeper_horizon_entry` + `keeper_horizon_cursor` (the claim-horizon heartbeat's queue of live reward entries, with when each was last touched and how its removal estimate moved, and where its discovery by entry id resumes; reset the two only together, and both empty, it re-discovers from entry id 1 and forgets only the stuck-clock and overdue history), `keeper_deployment` (the Diamond each chain's private state belongs to: on a redeploy the keeper clears that chain's rows from every private table keyed by chain and not by Diamond, once the indexer has adopted the same Diamond; the one-time copy seeds it with the Diamond its rows belong to, and a chain with no row adopts its configured Diamond and resets nothing), `keeper_cutover` (the retired one-time copy's completion record) and `keeper_cutover_row` (one digest per row that copy took), kept as history and read by nothing (#2560). Its schema is [`migrations/`](migrations/) in this directory, applied by the keeper's own `run deploy` ([`scripts/deploy-keeper.mjs`](scripts/deploy-keeper.mjs): apply, verify in the database, then the shared schema's `verify` and the publish) — or alone with `run migrate`. Why a separate database:

- **Trust boundary.** CLAUDE.md keeps internal keeper state out of the shared, user-facing database — the rule `ops/mesh-watcher` already follows.
- **Only the keeper can write its completion records.** A D1 binding is database-scoped, not table-scoped (#1722), so on the shared database the indexer and agent could write any keeper table. A row in `keeper_commitment_day` makes the commitment-report pass skip a day with zero RPC reads; here, nothing else has a binding through which to write one.

The rule for what goes where: **a table anything else reads stays shared.** In code, every helper over a private table takes a `KeeperD1` (the branded `env.KEEPER_DB`), so handing it the shared `env.DB` does not compile, and no statement touches both kinds of table — D1 cannot join across databases.

A maintenance build (#2239) drops **both** entries, and the tick declines while **either** binding is absent. The shared entry names its `migrations_dir` (`../indexer/migrations`) on purpose: wrangler defaults every entry to `./migrations`, so without it a `wrangler d1 migrations apply vaipakam-warm` typed here would apply this Worker's private schema to the shared database.

## Related

- `apps/agent` — the proactive-notifications / Frame / Telegram-bot Worker (no **on-chain transaction** key; it does hold `PUSH_CHANNEL_PK`, an Ethereum key loaded as an ethers `Wallet` to sign Push notifications).
- `apps/indexer` — chain→D1 indexer + read-API; NOT read-only (writes D1 via POST routes, publishes borrower-authorised, on-chain-bound listings to OpenSea)).
- `vaipakam/vaipakam-keeper-bot` (sibling repo) — public reference keeper bot for third-party operators.
- `packages/contracts` — ABI / deployment source.
