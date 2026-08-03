# D1 cutover — `vaipakam-archive` → `vaipakam-warm`, and the deletion of the old database

**Status:** planned, not executed. Owner decision 2026-08-03: proceed
(Path B), on the grounds that the platform is pre-live.

**Why this exists at all.** The off-chain backup service was renamed
`archive` → `warm` (#1537). A D1 database cannot be renamed, so adopting the
new name means moving to a different database. #1537 deliberately excluded
that move: merging it would have performed the switch automatically, and the
row copy taken at the time was already stale. This document is that deferred
step, planned rather than improvised.

---

## 1. What is actually true right now

Measured 2026-08-03, not assumed:

| | `vaipakam-archive` (live) | `vaipakam-warm` (prepared) |
|---|---|---|
| id | `3cffebf5-b652-4da7-953c-9e1d143ad2fe` | `e5e927cf-56c3-42c7-9820-179a235cc84f` |
| migrations applied | **43** (`0001`–`0042`) | **49** (`0001`–`0048`) |
| born-off-chain rows | 6 | 6 (copied early) |
| replay-derived rows | ~1,134 | 0 |

**The live database is six migrations behind**, and that is not a consequence
of the rename — it predates it. `0043`–`0048` merged but were never applied.
Applying migrations is a deploy-time step (`deploy-chain.sh` phase 8b.2), so
without a full deploy they lag silently and nothing warns.

The visible consequence: `recycle_backing_snapshot` (migration `0048`) does
not exist on the live database, so the M5 backing block shipped in #1532
cannot render. It is withheld rather than wrong — the designed behaviour —
but it is withheld.

### The data, by kind

**Born off-chain — irrecoverable, 6 rows total.** `user_thresholds` (1),
`notify_state` (1), `support_tickets` (4). The other five tables in this
class are empty. These exist nowhere else and cannot be reconstructed.

**Replay-derived — reconstructible.** `offers` (59), `loans` (38),
`activity_events` (1,015), `notifications` (22). Re-indexing from block zero
rebuilds all of it. It is kept only so a restore is fast.

That ratio is what makes this cutover tractable: **six rows must survive; the
rest can be thrown away and rebuilt.**

---

## 2. Two things that will bite if not planned around

### 2a. Merging the binding change IS the cutover, for two of four Workers

`apps/indexer` and `apps/keeper` are wired to Workers Builds and deploy
automatically on push to `main`. `apps/agent` is **not** — no
`Workers Builds: vaipakam-agent` check appears on any recent main commit.
Neither is the new `ops/offchain-data-warm`.

So the moment the binding PR merges:

- indexer and keeper switch to the new database, automatically, within
  minutes;
- **agent keeps writing to the old one** until somebody deploys it by hand.

That is a split-brain window, and agent is precisely the Worker that writes
the irrecoverable tables (Telegram links, notification state, support
tickets). The window is minutes, not hours, and §4 catches anything written
during it — but it must be closed deliberately, not noticed later.

### 2b. A partial switch cannot merge, by design

`check-d1-name-consistency` (a required status check since #1537) fails
unless all four bindings agree on both name and id. A half-applied cutover —
the failure mode this whole exercise exists to avoid — is not mergeable.

---

## 3. Make the rollback target healthy first

**Before touching any binding**, apply the missing migrations to the LIVE
database:

```bash
cd apps/indexer
npx wrangler d1 migrations apply vaipakam-archive --remote
```

Two reasons, and the second is the important one:

1. It fixes the M5 backing block on the deployment that is serving traffic
   today, independently of whether the cutover ever happens.
2. **It makes rollback safe.** If the cutover is reverted, traffic returns to
   `vaipakam-archive` — and a rollback target six migrations behind is a
   second incident on top of the first.

Verify:

```bash
npx wrangler d1 execute vaipakam-archive --remote \
  --command "SELECT COUNT(*) FROM d1_migrations"          # expect 49
npx wrangler d1 execute vaipakam-archive --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='recycle_backing_snapshot'"
```

---

## 4. The method: quiesce, replicate whole, switch

An earlier revision of this plan hand-copied the six irrecoverable rows and
argued about the rest. That was unnecessary, and it forced a decision
(#1481's five undecided tables) that this exercise has no business forcing.

Two facts make a **complete replica** possible instead:

1. `wrangler d1 export --remote --no-schema --table …` emits plain
   `INSERT INTO "t" (cols) VALUES(…)` for whatever tables you name.
2. Migrations `0043`–`0048` are **purely additive** — `CREATE TABLE IF NOT
   EXISTS` only, no `ALTER` or `DROP` on an existing table. So the target's
   schema is a strict superset of the source's, and every column the export
   names still exists with the same shape. The six new tables simply receive
   no rows, which is correct.

So: copy everything, decide nothing, lose nothing.

Two properties of the export that dictate the sequence:

- It is **plain `INSERT`**, not `INSERT OR REPLACE`. The target tables must be
  EMPTY or the import fails on primary-key conflict. `vaipakam-warm` currently
  holds six rows from an early hand-copy; those must go first. They are the
  only reason a conflict would arise.
- It is a **point-in-time snapshot**. Anything written between the export and
  the switch exists only in the old database. Rather than reconcile a delta
  afterwards — which is where the previous revision went wrong, because a
  consumed Telegram link or an updated threshold cannot be distinguished from
  a missing row by an upsert — **stop the writers first**. The platform is
  pre-live; a few minutes without ingestion costs nothing, and it removes the
  entire class of reconciliation error.

### The sequence

**Step 1 — quiesce.** Empty the cron list on all three writers:

```jsonc
"triggers": { "crons": [] }
```

for `apps/{indexer,keeper,agent}`, deploy each, then **confirm trigger-aware**
(Trigger Events pane or the schedules API) — an absent `triggers` object sends
no update and silently leaves the schedule running. Wait out Cloudflare's
propagation window (**up to 15 minutes**) before treating the writers as
stopped; the keeper runs every minute, so a readback alone is not the
confirmation. Its EOA nonce going quiet is.

`apps/agent` also serves HTTP, so it can still write from a user action. On a
pre-live platform, note the time and move quickly rather than engineering
around it.

**Step 2 — clear the target.**

```bash
cd apps/indexer
npx wrangler d1 execute vaipakam-warm --remote --command \
  "DELETE FROM user_thresholds; DELETE FROM notify_state; DELETE FROM support_tickets;"
```

Confirm every table in `vaipakam-warm` is empty before importing.

**Step 3 — export everything, data-only.**

```bash
npx wrangler d1 export vaipakam-archive --remote --no-schema \
  --output /tmp/d1-cutover.sql -y
```

Omitting `--table` takes every table. Keep this file — until the old database
is deleted it is a second copy, and after deletion it is the only one.

**Step 4 — import.**

```bash
npx wrangler d1 execute vaipakam-warm --remote --file /tmp/d1-cutover.sql
```

**Step 5 — verify by counting, per table, both sides.** Every table must
match exactly. A mismatch here is the signal to stop, not to patch.

**Step 6 — switch the bindings** (one PR, all four configs; the guard blocks a
partial switch) and **deploy the two that do not auto-deploy** —
`apps/agent` and `ops/offchain-data-warm` — in the same sitting as the merge.

**Step 7 — restore the crons** and confirm each Worker is reading the new
database from behaviour, not configuration.

Because the replica is complete, the indexer resumes from the copied
`indexer_cursor` rather than re-indexing from block zero, and `notifications`
history survives intact — the partial-regeneration problem the previous
revision accepted does not arise.

## 5. What this no longer requires

Stated because the previous revision required all of it, wrongly:

- **No decision on #1481.** All five decision-needed tables come across
  verbatim. The classification question stays open on its own merits.
- **No delta reconciliation**, and therefore no risk of resurrecting a
  consumed Telegram link or overwriting a newer threshold with an older one.
- **No accepted notification loss.**
- **No re-index**, so no soak waiting for a cursor to reach head.

## 6. Before deleting the old database

- [ ] Per-table counts equal on both sides, verified after the switch.
- [ ] All four Workers confirmed reading `vaipakam-warm` from behaviour.
- [ ] Crons restored and one full cycle observed on each Worker.
- [ ] One nightly backup completed **after** the import, its alert naming the
      new bucket. A backup taken before the import is not evidence.
- [ ] The `/tmp/d1-cutover.sql` export archived somewhere durable.

Then:

```bash
npx wrangler d1 delete vaipakam-archive
```

## 7. Rollback

Available at any point before §6's deletion, and cheap: revert the binding
PR. Indexer and keeper auto-deploy back; agent and the backup Worker need the
same manual deploy as in §4 step 2. The old database still holds every row,
which is exactly why §3 comes first — the thing you roll back to should be
healthy before you need it.

After deletion there is no rollback. That is the line.

---

## 8. What this buys, stated honestly

A database name that matches the service that owns it. The name is internal
and never user-visible. On a live platform this would not be worth moving
data for; the decision to proceed rests on the platform being pre-live, where
the replay-derived rows are genuinely disposable and six rows are the whole
of the irreplaceable state.

If that premise stops holding before this is executed, revisit the decision
rather than the plan.
