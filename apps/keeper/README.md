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

Tomorrow (per [`RangeOffersDesign.md`](../../docs/DesignsAndPlans/RangeOffersDesign.md) §7 of the Stage 3 plan): adds the off-chain offer matcher for Range Orders + Lender Partial Fills, submitting `matchOffers(lenderId, borrowerId)` to earn the 1% LIF matcher fee.

**Non-goals:** no user-facing reads (those belong to `apps/indexer`); no notifications setup endpoints (those belong to `apps/agent`); no public Frame / Telegram bot surface (also `apps/agent`).

**Important:** this Worker is **distinct from the public reference keeper bot** at the sibling [`vaipakam-keeper-bot`](https://github.com/vaipakam/vaipakam-keeper-bot) repo. That one is for third-party operators who want to run their own keeper. This one is the project's own and the only privileged Worker.

## How to run

```bash
pnpm --filter @vaipakam/keeper dev      # local wrangler dev (no live txs)
pnpm --filter @vaipakam/keeper run deploy   # wrangler deploy; uses `wrangler login` on the operator's machine
```

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
| `REWARD_REMIT_ENABLED` | Arms the #776 reward-budget remittance pass (in addition to `KEEPER_ENABLED`). Keep off until the keeper EOA is authorized on-chain via `setRewardRemittanceKeeper` (or is ADMIN). |
| `REWARD_REMIT_LOOKBACK_DAYS` | Recent-day window the remit pass re-scans for un-remitted budget each tick (default `45`). |
| `REWARD_REMIT_LANE_CAP` | Per-send VPFI ceiling (wei) — the `perRemittanceCap` + greedy batch bound. Must be ≤ the provisioned reward-budget CCIP lane bucket and ≥ the largest single-day slice (#918). Default `50000e18` (matches the on-chain lane default). `REWARD_REMIT_ENABLED` also arms the #1222 B2-d2 remit-ACK pass (scans Base's delivered-backing reservations, sends the mirror ack for each landed delivery). **Apply D1 migration `0044_keeper_remit_ack.sql` before enabling** (`wrangler d1 migrations apply vaipakam-archive --remote` from `apps/indexer/`). |
| `REWARD_COMMIT_ENABLED` | Arms the #1222 B2-d1 mirror→Base commitment-report pass (in addition to `KEEPER_ENABLED`). Runs on mirrors only; keep off until the keeper EOA holds on-chain `KEEPER_ROLE` (`submitCommitmentBatch` is role-gated). |
| `REWARD_COMMIT_LOOKBACK_DAYS` | Recent-day window the commitment pass re-scans for un-reported armed days each tick (default `14`). |
| `ZEROEX_API_KEY` / `ONEINCH_API_KEY` | Liquidation swap aggregator credentials. |
| `TG_BOT_TOKEN` / `PUSH_CHANNEL_PK` | Alert dispatcher credentials. |

See [`CLAUDE.md` § "Deployments sync"](../../CLAUDE.md) for the full secret list and rotation cadence.

### What the kill-switch does and does not stop (#1548)

`KEEPER_ENABLED=false` disables the six **gated** passes: `matcher`,
`liquidator`, `autoLifecycle`, `rewardBudgetRemit`, `remitAck` and
`commitmentReport`.

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

**Stop the schedule, not the key.** This Worker has no HTTP surface — every
pass runs from `scheduled()`. Removing its cron trigger stops all of them,
snapshot included, with nothing to restore afterwards but the trigger:

Set the trigger list **empty** — not absent. An absent `triggers` object
sends no schedule update at all and silently leaves the existing cron
running, which is the failure this paragraph exists to prevent:

```jsonc
"triggers": { "crons": [] }
```

then remove the trigger **from the dashboard** — *Settings → Trigger Events*.

**Do not reach for `wrangler deploy` to do this.** Without `--keep-vars` it
deletes every var before applying the config's. *With* `--keep-vars` it stops
deleting vars the config omits — but it still **applies the ones the config
declares**, and this config commits `"TG_BOT_USERNAME": ""`. A value filled
in through the dashboard is overwritten either way. An earlier revision of
this section recommended `--keep-vars` as the fix; it is not one.

`wrangler triggers deploy` is not the answer either — experimental, and
scoped to the `wrangler versions upload` flow.

The dashboard change touches the schedule and nothing else, which is what an
emergency stop needs.

**Confirm it, do not assume it** — the readback must be trigger-aware, since
a mistyped or wrongly-nested key leaves the committed cron in place. Check
the Worker's *Settings → Trigger Events* pane or query its schedules
directly; `wrangler tail` showing no tick only tells you none has fired
*yet*. Same hazard and same remedy as `OffChainRestore.md` §1 **step 9**.

**Then wait out the propagation window before calling it stopped.** An empty
schedules response confirms the control plane accepted the change; Cloudflare
documents that Cron Trigger updates can take **up to 15 minutes** to reach
every location. This keeper runs `* * * * *` — every minute — so on the order
of a dozen more ticks can still be dispatched after a successful readback,
each able to sign.

During an incident that gap is the whole question. **The confirmation is the
absence of scheduled ticks after the window has elapsed** — keep
`wrangler tail vaipakam-keeper` open across it, and treat quiet *before* the
window as meaningless.

A stationary keeper nonce is corroboration, not proof, and an earlier
revision of this section called it ground truth. It is wrong in both
directions: the nonce is per-chain, so one chain's stillness says nothing
about another; and outside the 00:00–00:09 UTC snapshot window, with no
eligible liquidation or remittance, a *running* keeper has a stationary nonce
anyway. It confirms a stop only if it was moving beforehand.

**Do not reach for the signing key to achieve this.** `KEEPER_PRIVATE_KEY`
is bound via `secrets_store_secrets`, so `wrangler secret put` /
`secret delete` writes or removes a per-Worker value **this Worker ignores** —
a successful-looking command and a keeper that keeps signing
(`docs/ops/AdminKeysAndPause.md` says exactly this for exactly this key). And
removing the store entry is rotation-grade, and the repository documents
rotation but **no removal procedure** — so it is not a step to improvise
during an incident. (`apps/keeper` is its only binder — `apps/agent`
deliberately does not hold a signing key — so an earlier "affects every
binder" here overstated the blast radius. The reason to avoid it stands; the
scare does not.) Stopping the schedule
achieves the same outcome and is reversible in one command.

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

The six gated passes are `matcher`, `liquidator`, `autoLifecycle`,
`rewardBudgetRemit`, `remitAck` and `commitmentReport`. The others
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

### D1 — shared `vaipakam-archive` (staging)

The `DB` binding in `wrangler.jsonc` points at the **`vaipakam-archive`** D1 database (id `3cffebf5-b652-4da7-953c-9e1d143ad2fe`), the **staging** database the Cloudflare staging deploy uses — see [`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](../../docs/DesignsAndPlans/CloudflareStagingDeployPlan.md) §3 for the staging-vs-primary split. The same db is **shared** with `apps/indexer` and `apps/agent`.

Keeper writes: `user_thresholds`, `notify_state`, `telegram_links`, `liquidity_confidence`, `oracle_snapshot_state`, `hf_band_state` + `notifications` (#1213 PR 2b — the liquidator pass files HF-band inbox rows into the same feed table the indexer's event/calendar producers use; migration 0041).
Keeper reads-only: `loans`, `offers`, `indexer_cursor` (the head-block stamp for HF-band rows).

**There is no `apps/keeper/migrations/` directory by design.** The canonical schema for every table this Worker touches lives in [`apps/indexer/migrations/`](../indexer/migrations/) — the indexer owns the schema, the other two Workers share the database. Schema changes for tables only keeper writes still land as a new `apps/indexer/migrations/NNNN_*.sql` file; applying it via `wrangler d1 migrations apply vaipakam-archive --remote` from inside `apps/indexer/` updates the live staging db for all three consumers.

## Related

- `apps/agent` — the proactive-notifications / Frame / Telegram-bot Worker (no signing key).
- `apps/indexer` — the chain-to-D1 indexer (read-only).
- `vaipakam/vaipakam-keeper-bot` (sibling repo) — public reference keeper bot for third-party operators.
- `packages/contracts` — ABI / deployment source.
