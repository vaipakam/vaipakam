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

## 4. The cutover

### Step 1 — the binding PR

Change `database_name` + `database_id` in all four configs
(`apps/{indexer,keeper,agent}/wrangler.jsonc`,
`ops/offchain-data-warm/wrangler.jsonc`) and in the docs that describe the
live binding. The guard passes only when all four agree.

### Step 2 — merge, then immediately deploy the two that do not auto-deploy

```bash
pnpm --filter @vaipakam/agent exec wrangler deploy
cd ops/offchain-data-warm && npx wrangler deploy
```

Do this in the same sitting as the merge. Every minute of delay is a minute
of agent writing rows to a database that is about to be abandoned.

### Step 3 — confirm all four moved

```bash
for w in vaipakam-indexer vaipakam-keeper vaipakam-agent vaipakam-offchain-data-warm; do
  npx wrangler deployments list --name "$w" | head -3
done
```

Then confirm from behaviour, not configuration: the indexer should begin
writing rows into the new database's `offers` / `activity_events`.

---

## 5. Reconcile the six rows — the step that actually matters

The copy in `vaipakam-warm` was taken hours before the cutover. It matched at
the time of writing and that is **luck, not safety**: one support ticket
between the copy and the switch breaks it, and agent may have written more
during the §2a window.

After the last writer has moved, re-read all eight born-off-chain tables from
the OLD database and compare:

```bash
cd apps/indexer
for t in diag_errors diag_legal_holds diag_legal_hold_audit user_thresholds \
         notify_state pre_grace_notify_state telegram_links support_tickets; do
  echo -n "$t old="
  npx wrangler d1 execute vaipakam-archive --remote --json \
    --command "SELECT COUNT(*) n FROM $t" | sed -n '/^\[/,$p' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['results'][0]['n'],end=' ')"
  echo -n "new="
  npx wrangler d1 execute vaipakam-warm --remote --json \
    --command "SELECT COUNT(*) n FROM $t" | sed -n '/^\[/,$p' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['results'][0]['n'])"
done
```

Counts are the smoke test, not the proof — a row changed in place keeps the
count identical. For each table with rows, diff the contents and apply
anything missing with an `INSERT … ON CONFLICT DO UPDATE`. At this volume
that is a handful of statements, and it is worth doing by inspection rather
than by script.

**Do not proceed while any count differs and is unexplained.**

---

## 6. Soak before deleting

Deletion is irreversible and the old database is the only copy of anything
missed. Hold until all of:

- [ ] The indexer has caught up — new `offers` / `loans` counts are at least
      the old 59 / 38, and `activity_events` is climbing toward ~1,015.
- [ ] The six born-off-chain rows verified equal (§5), **after** the last
      writer moved.
- [ ] One nightly backup has run against the new database and its alert names
      the new bucket.
- [ ] No Worker error referencing the old database id in `wrangler tail`.

Only then:

```bash
npx wrangler d1 delete vaipakam-archive
```

---

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
