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
  --table support_tickets --output ./tickets.sql -y
```

That file contains message bodies and any email addresses in them — treat it
as personal data, keep it only as long as needed, and `shred -u` it after.

## 2. The cutover

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

Do this in the same sitting as the merge. Until it is done, agent is reading
and writing the old database while the other two use the new one.

### Step 3 — confirm from behaviour, not configuration

`wrangler deployments list` prints deployment metadata, not bindings, and
happily shows an older successful deploy after a failed one. Confirm each
Worker is actually on the new database:

- indexer — new rows appearing in `activity_events` / `offers`;
- keeper — a tick logged, no D1 errors in `wrangler tail`;
- agent — a request served that reads or writes D1;
- backup Worker — a nightly run completing.

## 3. Delete the old database

- [ ] All four Workers confirmed on the new database, from behaviour.
- [ ] One nightly backup completed against the new database, its alert naming
      the new bucket.
- [ ] `support_tickets` exported if wanted (§1), or consciously abandoned.

```bash
npx wrangler d1 delete vaipakam-archive     # irreversible
```

## 4. Rollback

Revert the binding PR; indexer and keeper auto-deploy back, agent and the
backup Worker need the same manual deploys as step 2. The old database is
untouched throughout — nothing writes to it after the switch and nothing
deletes from it until §3 — so rollback is clean right up to that command.

After deletion there is no rollback. That is the line.

## 5. Note for whoever executes this

Migrations `0043`–`0048` were applied to `vaipakam-archive` on 2026-08-03
(43 → 49), which fixed the M5 backing block that had been dark in production.
That work is **not** wasted if the database is later deleted: it kept the
rollback target healthy, and it is why the M5 surface has been correct since.
