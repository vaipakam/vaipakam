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
2. **Both databases are now at migration `0048`**, so their schemas are
   *equal* and every column the export names exists in the target with the
   same shape.

   > An earlier revision of this section claimed migrations `0043`–`0048`
   > were "purely additive, `CREATE TABLE IF NOT EXISTS` only", making the
   > target a strict superset. **That is false**: `0046` and `0047` both
   > carry `ALTER TABLE … ADD COLUMN`. The grep I verified with matched
   > `DROP`, `RENAME` and `CREATE TABLE` — it could not have found an
   > `ADD COLUMN`, so I searched for what I expected and read the absence as
   > proof.
   >
   > The conclusion survives, for a different reason: §3 applies those
   > migrations to the SOURCE first, so the two schemas converge rather than
   > one containing the other. That makes §3 a **hard prerequisite of the
   > copy**, not merely a healthy-rollback measure — if the source were left
   > at `0042` the export would still import, but the plan's stated
   > justification would be describing a property it does not have.

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

**Emptying the crons does not stop HTTP writes, and TWO Workers accept them.**

- `apps/agent` — thresholds, Telegram link/unlink, support tickets.
- `apps/indexer` — `POST /signed-offers` (`src/index.ts:403`) inserts
  user-submitted signed orders. An earlier revision missed this one entirely
  and quiesced only the agent, which would have lost any offer posted after
  the export: `signed_offers` is user-submitted and no replay reconstructs it.

Take the mutating routes of **both** out of service for the window — unbind
the route, or deploy a build returning `503` on the mutating endpoints. Reads
may stay up.

**Then probe it, do not assume it.** Send one request to each mutating
endpoint and confirm it is rejected. A maintenance step that silently failed
to apply is indistinguishable from one that worked, right up until the data
is gone.

**Record the route state you changed**, because §7 has to put it back — see
the note there. An externally managed custom-domain route is not recreated by
restoring crons or by deploying a new binding.

**And do not rely on row counts to detect a leak.** An UPDATE to an existing
threshold, or any same-cardinality mutation, leaves every count identical
while changing the value the export captured. Counts catch inserts and
deletes only.

The check that actually holds is a **second export compared against the
first**:

```bash
npx wrangler d1 export "$SOURCE_DB" --remote --no-schema \
  --output /tmp/d1-verify.sql -y
diff <(sort /tmp/d1-cutover.raw.sql) <(sort /tmp/d1-verify.sql) \
  && echo "source unchanged during the window" \
  || echo "A WRITE LANDED — discard both and restart from the quiesce"
```

Sorted, because export ordering is not guaranteed stable. Any difference
means the window leaked: fix the maintenance mode and start again.

**Step 2 — clear the target.**

Set the target once and use the variables throughout:

```bash
cd apps/indexer
SOURCE_DB=vaipakam-archive   # being retired
TARGET_DB=vaipakam-warm      # being cut over to
```

> Deliberately variables. `check-d1-name-consistency` — the required check
> that makes a partial cutover unmergeable — flags any `wrangler d1` command
> naming a database no binding uses, which during a cutover is *every*
> command touching the target. It failed this document, correctly.
> Parameterising keeps the guard at full strength rather than carving an
> exemption for the one file most likely to be followed literally, and makes
> the procedure reusable for the next cutover.


```bash
cd apps/indexer
npx wrangler d1 execute "$TARGET_DB" --remote --command \
  "DELETE FROM user_thresholds; DELETE FROM notify_state; DELETE FROM support_tickets;"
```

Confirm every table in `$TARGET_DB` is empty before importing.

**Step 3 — export everything, data-only, minus the migration ledger.**

```bash
npx wrangler d1 export "$SOURCE_DB" --remote --no-schema \
  --output /tmp/d1-cutover.raw.sql -y
grep -vE 'INSERT INTO "(d1_migrations|sqlite_sequence)"' \
  /tmp/d1-cutover.raw.sql > /tmp/d1-cutover.sql
```

**The filter is not optional, and it covers two tables.** Despite its name,
`--no-schema` still exports both bookkeeping tables:

- `d1_migrations` — the target already holds its own 49 rows with identical
  primary keys, so the import aborts on collision.
- `sqlite_sequence` — `notifications` is `AUTOINCREMENT`, so importing its
  rows makes SQLite create the sequence row itself; the exported insert then
  duplicates it. Verified against the pinned Wrangler: an unscoped export
  emits two `sqlite_sequence` inserts. Filtering rather than enumerating `--table`
keeps the property that matters: no list to maintain means no table can be
forgotten. The target's ledger is already correct for its own schema and
must not be overwritten.

**Step 4 — import.**

```bash
npx wrangler d1 execute "$TARGET_DB" --remote --file /tmp/d1-cutover.sql
```

> ⚠️ **This file is plaintext personal data.** It contains Telegram chat IDs
> and link codes, support-ticket message bodies with any email addresses
> they carry, user alert thresholds, and diagnostic captures — everything
> the nightly backup protects with AES-256-GCM, in the clear.
>
> An earlier revision of this plan told the operator to archive it durably.
> That would have created an indefinite, unencrypted second store of user
> data outside every control the project has built for exactly this content.
>
> So: keep it only for the duration of the cutover, and when the checklist in
> §6 is satisfied, destroy it —
>
> ```bash
> shred -u /tmp/d1-cutover.raw.sql /tmp/d1-cutover.sql
> ```
>
> If a copy must outlive the window, encrypt it first (`age` or `gpg`) with a
> key held offline, and store it where the legal-vault content lives — not on
> a laptop and not in cloud sync. The nightly backup remains the durable
> copy; this file is a working artefact, not an archive.

**Step 5 — verify by counting, per table, both sides.** Every table must
match exactly. A mismatch here is the signal to stop, not to patch.

**Step 6 — switch the bindings** (one PR, all four configs; the guard blocks a
partial switch) and **deploy the two that do not auto-deploy** —
`apps/agent` and `ops/offchain-data-warm` — in the same sitting as the merge.

**Step 7 — restore the crons AND the routes**, then confirm from behaviour.

Restoring crons does not undo the maintenance mode: an unbound
custom-domain route stays unbound, and a `503` build stays deployed. Put back
exactly what §1 recorded, then **probe each mutating endpoint again** — this
time expecting success. The cutover is not complete while thresholds,
Telegram linking or support submission are unreachable, and nothing else in
this procedure would reveal that.

Then confirm each Worker is reading the new database from behaviour, not
configuration — a deploy that silently failed still lists an older
successful one.

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
- [ ] All four Workers confirmed reading the new database from behaviour.
- [ ] Crons restored and one full cycle observed on each Worker.
- [ ] **Maintenance mode reversed** — routes rebound / the `503` build
      replaced, and each mutating endpoint probed and now *accepting*.
- [ ] One nightly backup completed **after** the import, its alert naming the
      new bucket. A backup taken before the import is not evidence.
- [ ] **The export destroyed** — `shred -u /tmp/d1-cutover.raw.sql
      /tmp/d1-cutover.sql /tmp/d1-verify.sql` — or, if a copy must persist,
      encrypted offline and stored where legal-vault content lives, with the
      `/tmp` copies then shredded.

      > An earlier revision of this checklist said to archive it durably,
      > contradicting the destruction instruction in §4. An operator
      > satisfying the old gate would have kept Telegram IDs, link codes,
      > support messages and diagnostics indefinitely, in the clear. The
      > durable copy is the encrypted nightly backup; this file is a working
      > artefact.

Then:

```bash
npx wrangler d1 delete "$SOURCE_DB"     # irreversible
```

## 7. Rollback

**Free until step 7 restarts the writers.** Up to that point nothing has
written to the target, the source is byte-current, and rollback is a straight
revert of the binding PR — plus the same manual deploys for `apps/agent` and
`ops/offchain-data-warm`, which do not auto-deploy.

**After the crons restart, it stops being free.** Thresholds, notification
state, cursors and keeper bookkeeping now exist only in the target, so
reverting the bindings would point every Worker back at state that is stale
by however long the new database has been live. An earlier revision of this
plan offered rollback "at any point before deletion", which was wrong for
exactly the same reason the original delta-reconciliation was wrong.

So past that line, rolling back is itself a cutover: quiesce, export the
target, import into the source, then revert. Plan it that way or do not plan
to roll back.

After deletion there is no rollback at all. That is the line.

## 8. What this buys, stated honestly

A database name that matches the service that owns it. The name is internal
and never user-visible. On a live platform this would not be worth moving
data for; the decision to proceed rests on the platform being pre-live, where
the replay-derived rows are genuinely disposable and six rows are the whole
of the irreplaceable state.

If that premise stops holding before this is executed, revisit the decision
rather than the plan.
