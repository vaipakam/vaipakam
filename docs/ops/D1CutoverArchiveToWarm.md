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

## 0. About the commands in this document

**There are deliberately few, and that is the second attempt at getting this
right.** An earlier structure spelled out every step as copy-paste shell and
accumulated a defect per round for three rounds: a variable used before
assignment, a `cd` leaking into the next block, a bare `npx` from a directory
with no wrangler, and — in the very commit that declared the class closed — a
`curl` using `CF_ACCOUNT_ID` and `CF_API_TOKEN` that nothing ever assigns.

The cause was not carelessness in any one line. It was writing a large
surface of shell that nobody executes. So the surface is now small: this
document states **what to do, in what order, and how to know it worked**, and
defers the exact invocations to procedures that already exist and are already
verified —

- `docs/ops/OffChainRestore.md` §1 for wrangler forms, including the
  `"triggers": { "crons": [] }` shape and the trigger-aware readback;
- `docs/ops/DeploymentRunbook.md` for the per-Worker deploy commands;
- `apps/keeper/README.md` for the kill-switch and its confirmation.

Where a command does appear here it is marked **[run]** if that exact form
was executed against the live account on 2026-08-03, or **[unrun]** if it was
written but not executed. That distinction is the honest one, and it is the
one the defect history above argues for: treat an unrun line as a description
of intent to check against the canonical runbook, not as something to paste
into a terminal during an irreversible operation.

Note also that `ops/offchain-data-warm` is **outside the pnpm workspace** — a
root install does not populate its `node_modules`, so `npx wrangler` there is
an unpinned download. Its canonical form is in `OffChainRestore.md` §7b:

```bash
# [unrun here] — verified form, copied from OffChainRestore.md §7b
( cd ops/offchain-data-warm && npm ci && npm run deploy )
```

An earlier revision of this line pointed at `DeploymentRunbook.md`, which
contains no procedure for this Worker at all. Replacing an invented command
with a dangling reference is not an improvement, so the form is quoted here
with its source named.

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
| `notify_state` | 1 | dedupe state for notifications about old loans |
| `telegram_links` | 0 | already empty |

> **Taken 2026-08-03.** Both a standalone `support_tickets` export and a
> full-database export were pulled to `~/vaipakam-d1-export-2026-08-03/`
> (dir `700`, files `600`, outside the repo) and verified per-table against
> the live database. They are plaintext personal data — encrypt if they
> persist, `shred -u` when done. The full export carries `d1_migrations` and
> `sqlite_sequence`; filter both if it is ever imported into a database that
> already has its own.

**Two exceptions, called out so they are choices rather than oversights.**

`user_thresholds` (1 row) is **not** obsoleted by a redeploy — an earlier
revision of this table said it was. It is per-wallet, per-chain alert
configuration with no loan identifier, and the same row carries the user's
Telegram chat id. A redeploy changes which contracts it watches, not the
user's stated preference. It is one row today; export it with the tickets if
that user's settings are worth keeping.

And the born-off-chain set is larger than this table shows: the classifier
also names `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`,
`pre_grace_notify_state`, `telegram_links` and `recycle_day_backfill`. All
are empty today. **Re-run the counts across all nine on the day** — this
table is a dated observation, not a property, and a legal hold or a
diagnostic recorded between now and execution would not be visible in it.


`support_tickets` holds **4 rows, all `status=open`**. A support ticket is a
person waiting for a reply, and a contract redeploy does not change that. If
those are real, export that one table before starting:

```bash
install -m 700 -d ~/vaipakam-cutover        # [run] private directory FIRST
# [run]
(cd apps/indexer && npx wrangler d1 export "$SOURCE_DB" --remote --no-schema \
  --table support_tickets --output ~/vaipakam-cutover/tickets.sql -y)
chmod 600 ~/vaipakam-cutover/tickets.sql
```

**The directory is created private before wrangler writes.** Wrangler creates
the output with default permissions, so a `chmod` afterwards leaves a window
in which the plaintext is world-readable on a shared machine. Restricting the
containing directory first closes it; the file `chmod` is belt-and-braces.

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

**Chosen 2026-08-03: the first** — redeploy contracts, update
`deployments.json`, then cut over.

**With one gap that must be closed deliberately.** Publishing the new
artifacts is itself a merge, so it auto-deploys the indexer — which is still
bound to the source. From that moment until the binding PR lands, the
indexer indexes the NEW contracts into the OLD database, and
`POST /signed-offers` accepts user orders into a database about to be
deleted.

Two ways to close it, and both are acceptable:

- **Land the artifact update and the binding change in the SAME PR.** There
  is no window at all, and the guard still enforces that all four bindings
  move together. Preferred.
- **Keep them separate and accept a short window**, using the same
  shortest-window discipline as the agent deploy: have the binding PR ready
  to merge the moment the artifact PR lands.

What is not acceptable is publishing artifacts and getting to the binding
change later — that is the state where user-submitted orders accumulate
somewhere they will not survive. If circumstances force the cutover first,
plan to clear the new database again afterwards and say so at the time,
rather than discovering a mixed dataset later.

## 3. The cutover

### Step 0 — clear the target

It is **not** empty. `vaipakam-warm` still holds the six rows hand-copied
during #1537's preparation — `user_thresholds` 1, `notify_state` 1,
`support_tickets` 4 (verified 2026-08-03). An earlier revision of this plan
had a clearing step; the no-migration rewrite removed it, which would have
left those stale rows to be adopted as live state.

```bash
# [unrun] — verify against OffChainRestore.md §1 before pasting
(cd apps/indexer && npx wrangler d1 execute "$TARGET_DB" --remote --command \
  "DELETE FROM user_thresholds; DELETE FROM notify_state; DELETE FROM support_tickets;")
```

**Then confirm the domain tables are empty.** Not *every* table: `d1_migrations`
necessarily holds 49 rows — that is what "prepared through `0048`" means — and
`sqlite_sequence` may hold rows too. An earlier revision asked for a state the
target cannot be in, which leaves an operator either blocked or deleting
bookkeeping they need.

### Step 0b — re-apply migrations if any landed since

The target was prepared through `0048`. **Neither changing a binding nor
`wrangler deploy` applies D1 migrations** — that is a separate command, and
on the deploy path it runs as its own phase. If any migration merged between
preparation and execution, the Workers will come up against a database
missing its schema.

```bash
# [run] — this exact form was used on the source today
(cd apps/indexer && npx wrangler d1 migrations apply "$TARGET_DB" --remote)
(cd apps/indexer && npx wrangler d1 migrations list "$TARGET_DB" --remote)   # expect none pending
```

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

### Step 2 — deploy the one that does not auto-deploy

`apps/indexer`, `apps/keeper` **and `apps/agent`** deploy automatically on
merge, via Cloudflare Workers Builds. **`ops/offchain-data-warm` does not.**

**Corrected 2026-09-17 (#2237): this step used to name `apps/agent` as not
auto-deploying**, on the evidence that no `Workers Builds: vaipakam-agent`
check appeared on any recent main commit. That was true when written and is
not now. The check appears on the merge commits that touch it, and the live
Worker matches — `vaipakam-agent`'s deployment at `2026-09-17T08:55:34Z` sits
five seconds before its build check on `819623903` completed.

The test the old wording named is the right one; keep it and re-run it rather
than trusting either answer:

```bash
# [unrun] — the EQUIVALENT REST call produced the evidence on 2026-09-17, but
# this exact `gh api` form was not the one executed, and the convention above
# means exactly what it says. Does a build check appear on a main commit that
# touched the Worker?
gh api repos/vaipakam/vaipakam/commits/<sha>/check-runs --paginate \
  --jq '.check_runs[] | select(.name | test("Workers Builds")) | .name'
```

On the four most recent main commits touching `ops/offchain-data-warm`, no
`vaipakam-offchain-data-warm` build appears, so it still needs a hand:

```bash
# [unrun here] — verified form, from OffChainRestore.md §7b.
# NOT `npx wrangler` from the repo root: this package is outside the
# pnpm workspace, so that would be an unpinned download.
( cd ops/offchain-data-warm && npm ci && npm run deploy )
```

Do this in the same sitting as the merge.

### A binding change puts the deployment set in a MIXED STATE — this is the rule everything else follows from

Two revisions of this step got this wrong in two different ways, and both
errors came from the same place: they reasoned about **agent** as the odd one
out whose lag is the risk. That frame was right while agent was hand-deployed
and is wrong now, so it kept producing wrong conclusions — one per path — and
review kept finding them one at a time (#2238 r1 P1, r2 × 5). Replacing the
frame is the fix; another caveat per path is not.

**The frame.** A binding change reaches each Worker through its own,
independent Workers Builds job. So from the moment the merge lands until every
Worker's binding has been *confirmed*, the deployment set is in a mixed state
with these properties, none of which the platform gives you any control over:

| | |
| --- | --- |
| **Which** Workers have switched | unknown without checking each one |
| **In what order** | not guaranteed; agent-last was one observation, not the shape |
| **For how long** | not derivable — see below |
| **Whether at all** | a build can FAIL, and that Worker then stays on the old binding until a person repairs it |

That last row is the one that kills any "the window is bounded now" claim. On
the failure path it is unbounded exactly as before, and the operator is
investigating a build while writes keep landing in the wrong database.

**Why the duration is not derivable, including from this PR's own evidence.**
An earlier revision said "43 seconds, measured", from the build-check
completion times on `819623903` (indexer `08:54:56Z`, agent `08:55:39Z`). That
number does not mean what it was used for (#2238 r2 P2). A deployment is
created DURING its build — agent's live deployment is stamped `08:55:34Z`,
five seconds before its own check reported — so check-completion spread is not
activation spread, and the indexer's activation timestamp was never collected.
The real interval could be shorter or longer. **Do not put a number here that
has not been measured at the bindings themselves.**

**The rule, and it is one rule for both directions.**

> Before merging any change to a D1 binding — the cutover or its revert —
> **quiesce every user-facing writer.** Restore traffic only once **every**
> Worker's binding has been confirmed on the intended database.

"Every user-facing writer" is not agent alone, which is the second thing the
old frame got wrong (#2238 r2 P1). Both public Workers accept user writes:

- **`apps/agent`** — thresholds, Telegram links, support tickets.
- **`apps/indexer`** — `POST /signed-offers`, `POST
  /loans/:loanId/prepay-listing/match-source`.

Gating only agent leaves a user able to submit a signed order into the
database about to be deleted, while the operator believes they chose the "no
window" procedure.

**`apps/keeper` is outside the gate ONLY while its schedule is empty**, and
that is a fact about today rather than a property of the Worker (#2238 r3 P2).
It has no `fetch()` — cron only — and `wrangler.jsonc` commits `"crons": []`
under #1896, so it currently writes nothing at any time. Restore that schedule
and it is a writer like the others, and not a reconstructible one:
`hfBandNotifications` inserts user-visible inbox rows for observed HF-band
crossings, and a crossing that recovers before the keeper reaches the intended
database cannot be regenerated from current chain state — it simply disappears
with the abandoned database.

So: **check the committed schedule before excluding it.** If `crons` is
non-empty, disable the schedule across both binding changes and restore it
after confirmation, exactly as the public Workers are gated.

### Quiescence is a STATE to establish, not a route to close

Rounds 2, 3 and 4 of #2238 each found a different hole in this rule, and all
three were the same hole: it was written as an instruction about *routes*,
so each round found another way for a writer to reach D1 that a route did not
cover. Stated as a state instead, it is checkable and the holes close
together:

> **No writer can reach either database, by any entry point, from before the
> first binding changes until every binding has been confirmed.**

Three things follow that "close the mutating routes" did not give you.

**1. Enumerate writers × ENTRY POINTS, not writers.** Every Worker here has
two ways in, and a `fetch`-level `503` or a WAF rule stops exactly one of them
(#2238 r4 P2). A cron event does not traverse a route at all.

| Worker | `fetch()` writes | `scheduled()` writes | Committed cron |
| --- | --- | --- | --- |
| `apps/agent` | thresholds, Telegram links, support tickets, listings | pre-notify reminders + their checkpoint stamps, diag/ticket prunes, expired-link sweep | `* * * * *` |
| `apps/indexer` | `POST /signed-offers`, `POST /loans/:id/prepay-listing/match-source`, `/hooks/chain-event` | the ingest scan and everything it materialises | `* * * * *` |
| `apps/keeper` | none — no `fetch()` handler | HF-band inbox rows, remit/ack state | `[]` today (#1896) |

The agent's pre-notify tick is the sharp one: it can deliver a reminder while
stamping only the database about to be abandoned, so the tick after the
cutover delivers it **again**. A reminder is not retractable, which is the
whole reason that lane is built the way it is.

So the gate must close `scheduled()` as well — empty the schedule across the
change, or have the maintenance build short-circuit `scheduled()` — for every
Worker whose committed cron is non-empty. `apps/keeper`'s is empty today; that
is a fact to re-check, not a property (see above).

**2. The gate must be in place BEFORE the first binding moves** (#2238 r4 P1).
Shipping the maintenance behaviour *in* the binding-change deployment does not
work, and it was wrong when this document said it: the gate reaches each
Worker in the same independent build that changes that Worker's binding, so
the moment agent switches, an indexer still building — or whose build failed —
is both ungated and on the old database, which is precisely the loss this
option claimed to close. **Three merges, in order:**

| | Merge | Confirm before proceeding |
| --- | --- | --- |
| 1 | Maintenance behaviour on every writer, bindings untouched | every writer is gated, on both entry points |
| 2 | The binding change | every binding, by control-plane read (Step 3 pass 1) |
| 3 | Lift the maintenance behaviour | the write probes (Step 3 pass 2) |

Merge 1's own mixed state is harmless — a Worker that has not yet taken the
gate is still on the source, with everything else, and nothing has moved.
Merge 3's is harmless for the mirror reason: every binding is already
confirmed.

**3. A gate the operation erases is not a gate** (#2238 r3 P1). "Unbind the
route" and "deploy a rejecting build" were both wrong for this reason:
`apps/indexer/wrangler.jsonc` DECLARES its route, so the automatic deployment
re-creates a route that was manually unbound, and that same deployment
replaces a rejecting build with the normal handlers. Under the three-merge
order above, the in-Worker maintenance behaviour is no longer erased — merge 2
does not remove it, because it is in the tree merge 2 builds from. A
control-plane gate (a WAF rule on the mutating paths, or unbinding at the
zone) also survives, and additionally survives a *failed* build; it does not
touch cron, so it is a complement to emptying the schedule rather than a
substitute.

**None of these mechanics has been exercised on this account.** They are
reasoned from the deployment model, and are marked `[unrun]` in the same sense
the commands are.
### The alternative, and when it is defensible

**Watch it through (the 2026-08-03 choice, defensible only pre-live).** Skip
the quiescence entirely: merge when someone is watching and run Step 3
immediately, accepting that anything written in between may be lost. This was
chosen when there were no real users. It is not a decision to inherit once
there are — and note it is the whole of the alternative, not a lighter version
of the gate. Half a gate (routes closed, cron running; or gate and binding in
one merge) is this option with extra steps and a false sense of cover.

What the auto-deploy correction genuinely changes is **who** closes the
window: it no longer waits on a person remembering a command. It does not make
the window zero, bounded, or safe to ignore.

`ops/offchain-data-warm` writes no user-facing rows — it is the nightly
backup Worker — so its lag is an operator concern rather than a user-visible
split.

### Step 3 — confirm from behaviour, not configuration

`wrangler deployments list` prints deployment metadata, not bindings, and
happily shows an older successful deploy after a failed one. Confirm each
Worker is actually on the database it is supposed to be on.

**"Supposed to be on" is a direction, and this step is used in BOTH** (#2238
r2 P2). On the cutover the intended database is `$TARGET_DB`; during a
rollback it is the SOURCE. The probes below are written for the cutover
direction and **must be inverted for a rollback** — reading them literally
there makes a correctly rolled-back Worker fail its check, and, far worse,
makes a Worker still stuck on the target appear to pass. The discriminator
also inverts: on the way out the target's EMPTINESS is what proves the
switch; on the way back it is the source's accumulated rows.

Wherever this step says "the target", read "the intended database", and pick
the discriminator that can only be true of it.

**The probe must distinguish the databases.** An earlier revision listed
checks that all pass against the OLD binding too — a keeper tick logs cleanly
either way, an agent request reads a schema-valid database either way, and
the backup Worker completes into whichever `B2_BUCKET` it holds. Those prove
the Worker is alive, not where it is pointed.

Use checks that can only be true of the new database. Since the target starts
empty, its emptiness is the discriminator:

```bash
# [unrun] — same shape as the [run] commands above; confirm before pasting.
# Before restoring traffic: the new database has zero rows in these.
(cd apps/indexer && npx wrangler d1 execute "$TARGET_DB" --remote --command \
  "SELECT (SELECT COUNT(*) FROM offers) o, (SELECT COUNT(*) FROM activity_events) a")
```

- **indexer** — after its first tick, `indexer_cursor` gains a row in
  `$TARGET_DB` and `offers`/`activity_events` begin filling *there*. Confirm
  the row count in the TARGET rose, not that the indexer merely ran.
- **keeper** — a write it owns appears in `$TARGET_DB`. Choose the table by
  what is actually true at the time: immediately after a fresh contract
  deployment `liquidity_confidence` may legitimately stay empty
  (`runLiquidityConfidence` returns before its upsert when there are no
  active collateral assets) and `hf_band_state` needs a loan to band. If
  neither can be provoked, **do not fall back to the tick's log line** — an
  earlier revision suggested that, and it is wrong: `passIsArmed` builds
  those lines purely from arming flags and logs `start` before the pass
  touches D1 at all. It tells you the pass ran, not where it wrote.

  The honest fallback is the control plane, labelled as such — a
  configuration check, not a behaviour one: read the Worker's D1 binding in
  the Cloudflare dashboard (*Settings → Bindings*), or via the API if you
  already have credentials to hand. It shows the bound database id, so it
  cannot be satisfied by the wrong database.

  Use it when no observable write is available, and prefer the write when one
  is.
- **agent** — perform one threshold write through the API, then read it back
  from the INTENDED database directly. If it landed in the other one, **its
  Workers Builds deployment has not completed, or it failed** — agent is not
  hand-deployed on this path (#2237). Check the `Workers Builds:
  vaipakam-agent` check on the merge commit: still running means wait and
  re-test, `failure` means the build is the thing to fix and the mixed state
  persists until it is.

  Do the same for **indexer's** write surface, not only its ingest: it accepts
  `POST /signed-offers` from users, so "the indexer's cursor advanced in the
  target" proves the scan switched and says nothing about where a user's
  signed order would land.

**THE ORDER MATTERS, because the write probes need the gate OPEN and the rule
says it stays closed** (#2238 r3 P1). Both probes above go through the same
public routes the quiesce closes, so running them while the gate holds is
impossible, and reopening to run them defeats the gate. Confirmation therefore
happens in two passes:

1. **While quiesced — control plane only.** Read each Worker's D1 binding
   (*Settings → Bindings*, or the API) and confirm every one names the
   intended database. That is a configuration check, labelled as such, and it
   is exactly what the keeper entry above already falls back to. It is also
   the only check that can distinguish "build still running" and "build
   failed" from "switched", since it reflects what is actually deployed.
   **This pass is what authorises lifting the gate** — not the write probes.
2. **After lifting — behaviour.** Run the write probes as the final
   confirmation. They can still find something the binding read could not, so
   they are not redundant; they are simply not available earlier. If one of
   them fails here, close the gate again rather than leaving it open while
   investigating.

An earlier revision made the agent write probe "the test that closes the
deployment window", which cannot be true under a rule that keeps that route
shut until the window is closed. The binding read closes it; the write
confirms it.
- **backup Worker** — verified by **row counts**, not by the table list. It
  exports a fixed set of tables from whichever database it is bound to, so
  both manifests name the same tables and an earlier revision's "check the
  table list" would have passed either way. The manifest carries a
  `rowCount` per table: against the target those are ~0, against the source
  they are the old ~1,100. That is the discriminator.

## 4. Rollback

**Free until the Workers start writing to the target — and staying free is
something you have to DO, not something you observe** (#2238 r2 P1).

A revert is a binding change, so the quiescence rule applies to it unchanged:
**establish the state before the revert merges** — every writer, both entry
points, gated first in its own merge — and lift only once every binding is
confirmed back on the source. The same three-merge order applies, with the
binding change in the middle being the revert.
Confirming afterwards cannot make the window safe — during the revert's own
independent builds, a Worker still serving the target can accept the first
threshold, signed order or support ticket written there, and that row is lost
the moment the source becomes canonical again. A rollback that began inside
the free period can leave it while it runs, and nothing after the fact undoes
that.

Mechanically: revert the binding PR, which re-deploys `apps/indexer`,
`apps/keeper` and `apps/agent` automatically through Workers Builds — the
revert is a merge like any other (#2237). Then redeploy
`ops/offchain-data-warm` by hand, since that one is not built on merge.

Then confirm with the Step 3 probes **inverted**: the intended database is the
SOURCE, so a write must land there, and the discriminator is the source's
accumulated rows rather than the target's emptiness. Running them as written
would pass a Worker still bound to the target, which is the failure this
rollback is trying to escape.

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

- [ ] **The old backup Worker is retired (#1551) — and #1551 has its own
      gate that comes first.** Its order is: the NEW Worker completes a
      nightly whose alert names the new bucket, *then* the old Worker is
      deleted. Only after that is the source database safe to delete, since
      the old Worker binds it as `DB_ARCHIVE` and would otherwise be left
      with a live cron pointed at nothing.

      An earlier revision of this checklist said "retired first" while
      listing the target's nightly verification two entries below, which
      inverted #1551's own sequence.
- [ ] All four Workers confirmed on the target by a **discriminating** probe.
- [ ] One nightly backup completed against the target, verified by content.
- [ ] **Both §1 exceptions decided** — `support_tickets` (4 open) and
      `user_thresholds` (1 row, per-wallet alert config carrying a Telegram
      chat id). Neither is obsoleted by a contract redeploy, and the discard
      check below does not cover them precisely because §1 excludes them.
- [ ] **The discard list re-validated on the day.** The row counts in §1 are
      from 2026-08-03 and the database is live. `diag_legal_holds` and its
      audit trail are classified born-off-chain and irrecoverable — they are
      empty today, and a legal hold recorded between now and execution would
      not be. Re-run the count before deleting; do not trust this table.

```bash
# [unrun] — irreversible; confirm the form before running
(cd apps/indexer && npx wrangler d1 delete "$SOURCE_DB")
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
