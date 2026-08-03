# D1 cutover — `vaipakam-archive` → `vaipakam-warm`

**Status:** planned, not executed.

**Owner decisions (2026-08-03):**
1. Proceed with the cutover — the platform is pre-live.
2. **Do not migrate the data.** Fresh contract deployments are expected, so
   the new database starts empty and captures new data only.

That second decision is what makes this document short. Earlier revisions
carried a quiesce, a whole-database export/import, a reconciliation and a
secure-destruction step for a file full of personal data. None of that is
needed to move to an empty database, and every one of those steps was a
place to get it wrong.

---

## 1. What is being discarded, deliberately

A contract redeploy obsoletes almost all of it by definition — the rows
describe contracts that will no longer exist:

| table | rows | why it does not survive a redeploy |
|---|---|---|
| `activity_events` | 1,015 | events from the old contracts |
| `loan_participants` | 77 | old loans |
| `offers` / `loans` | 59 / 38 | old contracts |
| `webhook_deliveries` | 52 | dedupe state for old events |
| `notifications` | 22 | about old loans |
| `indexer_cursor` | 12 | block positions for the old deployment |
| `signed_offers` | 5 | address-bound to the old contracts; all cancelled |
| `liquidity_confidence` | 6 | streak state, rebuilt by observation |
| `market_summary` / `protocol_config` / `reward_loop_totals` | 5 / 3 / 3 | derived; recomputed |
| `user_thresholds` / `notify_state` | 1 / 1 | thresholds on loans that will not exist |
| `telegram_links` | 0 | already empty |

> **Taken 2026-08-03.** Both a standalone `support_tickets` export and a
> full-database export were pulled to `~/vaipakam-d1-export-2026-08-03/`
> (dir `700`, files `600`, outside the repo) and verified per-table against
> the live database. They are plaintext personal data — encrypt if they
> persist, `shred -u` when done. The full export carries `d1_migrations` and
> `sqlite_sequence`; filter both if it is ever imported into a database that
> already has its own.

**One exception, called out so it is a choice rather than an oversight:**
`support_tickets` holds **4 rows, all `status=open`**. A support ticket is a
person waiting for a reply, and a contract redeploy does not change that. If
those are real, export that one table before starting:

```bash
cd apps/indexer
npx wrangler d1 export vaipakam-archive --remote --no-schema \
  --table support_tickets --output ~/vaipakam-tickets.sql -y
chmod 600 ~/vaipakam-tickets.sql
```

**Outside the repository, deliberately.** An earlier revision wrote it to
`./tickets.sql` from `apps/indexer/` — a path no `.gitignore` rule covers, at
whatever permissions the process happened to use. A `git add -A` would have
committed support-ticket message bodies and email addresses. It contains
personal data: `chmod 600`, keep it only as long as needed, `shred -u` after.

## 2. Sequencing against the contract redeploy

**"Starts empty and captures new data only" is only true if the redeploy and
the artifact update land FIRST.**

`chainIndexer.ts:673-684` resolves a missing cursor to `deployBlock - 1` and
begins scanning from there. So if the bindings move while the artifacts still
name the current contracts, the freshly-deployed indexer replays **the
existing deployment** into the new database — exactly the data the owner
decided not to migrate, arriving by the back door and mixed with nothing to
distinguish it.

Two orders work, and one does not:

| order | result |
|---|---|
| redeploy contracts → update `deployments.json` → cutover | new database holds only new-contract data ✅ |
| cutover → redeploy → update artifacts | old-contract replay, then a second replay; the first is junk that must be cleared ✅ but wasteful |
| cutover while artifacts still point at the old contracts, and leave it | old-contract data accumulates indefinitely ❌ |

**Prefer the first.** If the cutover must happen before the redeploy, plan to
clear the new database again afterwards, and say so at the time rather than
discovering a mixed dataset later.

## 3. The cutover

### Step 0 — clear the target

It is **not** empty. `vaipakam-warm` still holds the six rows hand-copied
during #1537's preparation — `user_thresholds` 1, `notify_state` 1,
`support_tickets` 4 (verified 2026-08-03). An earlier revision of this plan
had a clearing step; the no-migration rewrite removed it, which would have
left those stale rows to be adopted as live state.

```bash
cd apps/indexer
npx wrangler d1 execute "$TARGET_DB" --remote --command \
  "DELETE FROM user_thresholds; DELETE FROM notify_state; DELETE FROM support_tickets;"
```

Then confirm every table is empty — not just those three.

### Step 1 — one PR, all four bindings

`apps/{indexer,keeper,agent}/wrangler.jsonc` and
`ops/offchain-data-warm/wrangler.jsonc`: set both `database_name` and
`database_id` to the replacement.

```
vaipakam-warm   e5e927cf-56c3-42c7-9820-179a235cc84f
```

`check-d1-name-consistency` is a required status check and fails unless all
four agree on both fields, so a partial switch cannot merge. That is the
protection worth having here: half-switched is the only genuinely bad state,
because migrations and reads would target different databases.

Update the docs that describe the live binding in the same PR — the same
check scans `wrangler d1` commands in scripts and runbooks.

### Step 2 — deploy the two that do not auto-deploy

`apps/indexer` and `apps/keeper` deploy automatically on merge.
**`apps/agent` and `ops/offchain-data-warm` do not** — no
`Workers Builds: vaipakam-agent` check appears on any recent main commit, and
its last deploy predates several merges.

```bash
pnpm --filter @vaipakam/agent exec wrangler deploy
cd ops/offchain-data-warm && npx wrangler deploy
```

Do this in the same sitting as the merge. Until it is done, **agent reads and
writes the old database while the other two use the new one** — and that
split is user-visible, independently of the no-migration decision.

A threshold set, a Telegram link made, or a support ticket filed in that
window lands in the database about to be deleted. The user sees it succeed;
it then vanishes. "We are not migrating data" covers rows that a redeploy
obsoletes — it does not cover a write the user watched succeed minutes ago.

Two ways to close it, and the choice is the operator's:

- **Shortest window.** Have the `wrangler deploy` for agent ready to run
  before merging, and run it the moment the merge lands. The exposure is the
  couple of minutes it takes.
- **No window.** Put agent's mutating routes behind a `503` for the interval
  (unbind the route, or deploy a rejecting build), then restore them after
  the redeploy. A user who is told "try again shortly" has lost nothing; one
  whose ticket silently disappeared has.

Pre-live, the first is defensible. Say which was chosen rather than leaving
it to whoever executes.

### Step 3 — confirm from behaviour, not configuration

`wrangler deployments list` prints deployment metadata, not bindings, and
happily shows an older successful deploy after a failed one. Confirm each
Worker is actually on the new database:

**The probe must distinguish the databases.** An earlier revision listed
checks that all pass against the OLD binding too — a keeper tick logs cleanly
either way, an agent request reads a schema-valid database either way, and
the backup Worker completes into whichever `B2_BUCKET` it holds. Those prove
the Worker is alive, not where it is pointed.

Use checks that can only be true of the new database. Since the target starts
empty, its emptiness is the discriminator:

```bash
cd apps/indexer
# Before restoring traffic: the new database has zero rows in these.
npx wrangler d1 execute "$TARGET_DB" --remote --command \
  "SELECT (SELECT COUNT(*) FROM offers) o, (SELECT COUNT(*) FROM activity_events) a"
```

- **indexer** — after its first tick, `indexer_cursor` gains a row in
  `$TARGET_DB` and `offers`/`activity_events` begin filling *there*. Confirm
  the row count in the TARGET rose, not that the indexer merely ran.
- **keeper** — a write it owns (`liquidity_confidence`, `hf_band_state`)
  appears in `$TARGET_DB`.
- **agent** — perform one threshold write through the API, then read it back
  from `$TARGET_DB` directly. If it landed in the source instead, its manual
  deploy did not take.
- **backup Worker** — its next nightly must be verified by content, not
  completion: the manifest's table list should reflect the new database's
  (near-empty) state, not the old one's ~1,100 rows.

## 4. Rollback

**Free until the Workers start writing to the target.** Until then the source
is untouched and current: revert the binding PR, redeploy `apps/agent` and
`ops/offchain-data-warm` by hand, done.

**After that it is not free, and this plan does not offer a clean one.**
New support tickets, thresholds, signed offers, notification state and
cursors exist only in the target. Reverting points every Worker back at a
source that is missing them, and the exports are plain `INSERT`s that collide
with the source's surviving rows — so a reverse import is not a one-liner
either.

If rollback is needed after that point, treat it as its own cutover with the
same care as the forward one. The honest planning assumption is: **once the
Workers write to the new database, forward is the only direction.**

## 5. Deleting the source

Order matters here, and this plan does not own all of it:

- [ ] **The old backup Worker is retired first (#1551).** It binds the source
      as `DB_ARCHIVE`. Deleting the database while that Worker is still
      scheduled leaves a live cron pointed at a database that no longer
      exists — a nightly failure with a confusing cause.
- [ ] All four Workers confirmed on the target by a **discriminating** probe.
- [ ] One nightly backup completed against the target, verified by content.
- [ ] `support_tickets` exported (§1) or consciously abandoned.
- [ ] **The discard list re-validated on the day.** The row counts in §1 are
      from 2026-08-03 and the database is live. `diag_legal_holds` and its
      audit trail are classified born-off-chain and irrecoverable — they are
      empty today, and a legal hold recorded between now and execution would
      not be. Re-run the count before deleting; do not trust this table.

```bash
SOURCE_DB=vaipakam-archive
npx wrangler d1 delete "$SOURCE_DB"     # irreversible
```

> **Why a variable.** Once the bindings move, `check-d1-name-consistency` — a
> required check — treats `vaipakam-archive` as a database no binding uses,
> and it scans `wrangler d1 delete`. A literal name here fails CI on the very
> PR that retires it. The guard is right: a `d1` command naming an unbound
> database is the partial-cutover signature, so the plan parameterises rather
> than being exempted from its own check.

## 6. Note for whoever executes this

Migrations `0043`–`0048` were applied to `vaipakam-archive` on 2026-08-03
(43 → 49), which fixed the M5 backing block that had been dark in production.
That work is **not** wasted if the database is later deleted: it kept the
rollback target healthy, and it is why the M5 surface has been correct since.
