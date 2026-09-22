# D1 cutover — `vaipakam-archive` → `vaipakam-warm`

**Status: PARTLY EXECUTED 2026-09-21 — schema and a first data copy are done;
the switch itself is NOT.** What follows the execution record is the plan as
written beforehand, kept because its reasoning is still the reasoning — and
because step 3 below is the part of it that had to be re-learned.

## Execution record (2026-09-21)

1. **Schema parity — DONE.** `vaipakam-warm` was four migrations behind —
   `0049`, `0050`, `0052`, `0053` — and missing two tables
   (`loan_reconcile_quarantine`, `prenotify_scan_cursor`). Applied with
   `wrangler d1 migrations apply`, so the `d1_migrations` record is wrangler's
   own rather than hand-written. Both databases report **53 migrations and 46
   tables**, nothing in one absent from the other.
2. **First data copy — DONE, and it must be repeated at switch time.** 1,384
   rows across 17 tables. `d1_migrations` deliberately **not** copied: warm's
   record is its own, and copying the source's would have claimed migrations
   ran there that never did.

   **That first copy was ad hoc, and the repeat is not.** It ran from a
   terminal session — table set, conflict keys, batch sizing and comparison
   all in the operator's head — it reported success, and it had lost a row.
   A data step that cannot be re-run identically cannot be verified, and the
   switch requires re-running it. So the step is now a checked-in tool:

   ```
   node apps/indexer/scripts/d1-carry-rows.mjs digest --db vaipakam-archive
   node apps/indexer/scripts/d1-carry-rows.mjs carry \
     --from vaipakam-archive --to vaipakam-warm \
     --mirror --manifest cutover-mirror.json
   ```

   Both `--mirror` and `--manifest` are required and neither is implied —
   see the properties below. A command here that omitted them would exit
   before copying anything, which is what this block did until #2267 r8.

   Five of its properties are load-bearing. Each was learned by a review
   round finding the previous version of this list insufficient, and each is
   now enforced by the tool rather than left to whoever repeats the step:

   - **One end of a carry is always the SHARED database.** Not "the
     destination is fixed" — that was the first version, and it made the tool
     unable to perform the rollback §"Rolling back" requires, which is the
     same move in the other direction. The property that matters is that
     **BOTH ends are pinned** — the successor and its recorded predecessor,
     by id as well as name, in
     `apps/indexer/scripts/lib/cutover-databases.mjs`. Requiring only that
     the shared database be ONE end is **not** the rule and must not be
     restated as though it were: it would permit an unrelated account
     database to be mirrored over the shared one, and the shared one's rows
     to be copied into an unrelated database, while reading as a
     restriction. `check-d1-name-consistency` keeps the pinned pair
     agreeing with every binding and command, on name AND id.
   - **Parents before children.** Tables are ordered by FOREIGN KEY
     dependency, not alphabetically. D1 enforces foreign keys, so a child
     carried before its parent is *rejected*, aborting the carry — and
     alphabetical order puts `notify_state` before `user_thresholds`.
     Deletes run in the reverse order for the same reason.
   - **Upsert, never `INSERT OR REPLACE`.** `REPLACE` is `DELETE` + `INSERT`,
     and `notify_state` carries `ON DELETE CASCADE` to `user_thresholds`.
     The first copy wrote the child first and rewriting the parent cascaded it
     away. `ON CONFLICT … DO UPDATE` mutates in place and is re-runnable. A
     table with no primary key has no conflict target, so the tool **refuses
     it and names it** rather than duplicating it on the next run.
   - **A source-side DELETION is a difference like any other.** Upsert-only
     can never make two sides equal once a row has been deleted on the
     source — and live writers expire `telegram_links`, prune diagnostics and
     cancel offers between carries. The default `mirror` therefore also
     removes destination rows whose key the source no longer has, which is
     what makes "identical digest" a reachable state rather than an
     aspiration. It is only safe against an **inert** destination, and the
     tool says so on every run.
   - **Nothing is ever written to a LIVE database.** The post-switch step
     is a separate verb, `reconcile`, which reads both sides and REPORTS.
     It has no write path at all — the `--only-missing` insert this bullet
     used to describe was removed rather than guarded, because no preflight
     closes a race against a database something else is writing to (#2267
     r14). It is why the barrier below does not have to be a proof.

     **So `reconcile` finding a row does NOT mean the row has been
     carried** — it means a person has to carry it. An operator reading the
     old wording could watch a late row be reported and walk away leaving
     it stranded on a database nobody reads. Every difference it prints is
     an action item, including the ones that look mechanical.
   - **Compare CONTENT, never row counts.** The count check passed on two
     tables that were not equal (`indexer_cursor`, `recycle_backing_snapshot`).
     The tool canonicalises each table's rows and hashes them, and the
     comparison is part of the carry rather than a step someone may skip.

   It also **refuses rather than guesses** in two cases that would otherwise
   pass quietly: a table the two sides declare different columns or keys for
   (a migration decision, not a copy — both shapes are printed), and a row
   carrying NULL inside its key, which SQL equality cannot match, so such a
   row could be neither reliably matched nor removed.

   **[run] 2026-09-21** — the digest of both sides immediately after the
   first copy, with the Workers still live, showed **three** tables
   differing: `indexer_cursor`, `protocol_config`, `recycle_backing_snapshot`.
   None was a copy fault; all three are tables the running services rewrite,
   and the source had simply moved on. That is the evidence for step 3.

   **[run] 2026-09-21** — a mirror carry with the tool, still against live
   Workers, brought `protocol_config` and `recycle_backing_snapshot` into
   agreement and **failed verification on `indexer_cursor` alone**: 19 rows
   on each side, different digests, because the indexer advanced it during
   the carry. The tool exiting non-zero there is the correct outcome and is
   the barrier's case made twice over — a carry taken against a live source
   cannot converge, however well it is written.

   **[run] 2026-09-21, the full pair, as a rehearsal.** `--mirror
   --manifest` carried 1,384 rows across 43 tables (0 removed) and recorded
   a manifest of 1,384 row hashes stamped `02:30:20Z`; its own verification
   then failed on `indexer_cursor` and `recycle_backing_snapshot`, both
   still being written. The reconciliation that followed —
   `--only-missing --since` that manifest (the verb has since become the
   read-only `reconcile`) — reported **`wrote 0 row(s)`**,
   because nothing was missing, and then **17 conflicts**, each a named
   `indexer_cursor` row archive had changed since the mirror, with its
   current value. Before this round's fix that same run printed `wrote 0`
   and `VERIFIED`. The rehearsal is what shows the difference: the work the
   reconciliation exists to find is invisible to a check that asks only
   whether a key is present.

   **[run] 2026-09-21, the read-only `reconcile`.** Against the same
   manifest, with archive still live:

   ```
   reconcile — READ ONLY. Nothing is written to either database.
   nothing was written, and nothing would have been: reconcile is read-only.
     0 refusal(s), 17 conflict(s), 0 row(s) present on the source and
     absent from the destination.
   STOPPED — 17 problem(s)
   ```

   Not one write verb appears in the output. The seventeen are the same
   `indexer_cursor` rows every run has found — now reported rather than
   partly acted on.

3. **The switch — NOT DONE, and it requires the writers stopped first.**

   The bindings change is staged in the PR but must not land while anything is
   writing. Merging auto-deploys the three Workers (#2237), they do not deploy
   simultaneously, and a failed build stretches the gap without bound. Anything
   written to the source after the final copy but before that Worker picks up
   the new binding exists only in the database being left behind, and no
   amount of copying *before* the merge closes a gap that opens *after* it.

   This is not hypothetical. Between the first copy and the content check —
   about twelve minutes — the source advanced **sixteen** `indexer_cursor`
   rows. The writers are demonstrably live.

   So the order is: **stop the writers (the maintenance build the mechanism
   provides), wait for the source to be OBSERVED still, take the final copy,
   merge, let the Workers come back on the target, then verify by binding
   id.** The refusal callers see during that window states plainly that
   nothing they sent was recorded, which is the whole reason that mechanism
   exists.

   **"Observed still" NARROWS the window. It does not prove the drain, and
   this document will not say that it does.** Removing the D1 binding stops
   any NEW invocation from obtaining a handle, but an invocation already
   running — including `waitUntil` work admitted before the gate — still
   holds the handle it was given. Such work can be suspended on something
   external for longer than any interval chosen here, sit out every
   observation, and commit afterwards. How long that takes has never been
   measured, and §"Stopping the writers" refuses to invent a number for it;
   observing stillness does not measure it either.

   So the sequence has two distinct parts, and conflating them is the error
   this revision exists to correct. Steps 1–5 make the window small.
   **Step 6 is what keeps LOOKING — it does not close it either.** Nothing
   in this procedure closes that window, because nothing here can revoke a
   handle already granted (§4's banner). Step 6 is the only thing that
   finds a late write, which is why it runs weekly for as long as the
   predecessor is retained rather than ending at two clean passes.

   1. Deploy the maintenance build (no `d1_databases`) to all three
      Workers, then **confirm it took** —
      `check-live-d1-bindings.mjs --writers-held`, which asserts that every
      serving version of all three carries no D1 binding at all. A deploy
      that silently did not land leaves the barrier open while every step
      below behaves as though it were closed.

      > **THE MAINTENANCE BUILD IS DEPLOYED BY MERGING IT, not by
      > `wrangler deploy` from an operator's shell.** All three writers
      > are on the automatic path (§3 Step 2). So step 1 is: merge a
      > commit that removes `d1_databases` from the three writers, and
      > confirm with `--writers-held`.
      >
      > **The merge is how you ASK; `--writers-held` is what establishes
      > it.** §3 Step 2 measured both ways this misleads: `apps/app`'s
      > build reported success on `06d657b9f` while that Worker's
      > deployment stayed weeks older, and which commits trigger which
      > builds is not recoverable from the diff — a root-level file
      > change built all five Workers, a `docs/`-only change built none.
      > So neither "a check appeared" nor "the diff touched that Worker"
      > is evidence the barrier closed. Only reading back what the
      > Workers are SERVING is.
      >
      > **Cut that commit from `main` BEFORE the cutover PR, not after.**
      > In the barrier state the three writers declare nothing, so the
      > shared database is named only by `ops/offchain-data-warm` and by
      > the `wrangler d1` commands — and those must agree. Before the
      > cutover PR they all say `vaipakam-archive` and they do. After it
      > they all say `vaipakam-warm` and they would too, but by then the
      > switch has already happened and the barrier is pointless.
      >
      > **THE BARRIER COMMIT CARRIES THE GUARD THAT PERMITS IT.** This is
      > the part that is easy to get wrong, because it is circular and the
      > failure lands in the window. The two-shape
      > `check-d1-name-consistency` described below ships in the cutover
      > PR — which merges LAST — so a barrier commit cut from the `main`
      > that exists before it meets the OLD, anchored guard and is
      > rejected: *"apps/indexer/wrangler.jsonc has no complete `DB` d1
      > binding … there is nothing to check against."* Verified against
      > `6c0c0125a`. So the barrier commit contains the config strip, the
      > guard rewrite, **and the two modules the rewritten guard imports**
      > — `apps/indexer/scripts/lib/d1-workers.mjs` and
      > `apps/indexer/scripts/lib/cutover-databases.mjs`, neither of which
      > exists on `main` — minus the `SUCCESSOR` entry in
      > `COMMAND_GENERATORS`.
      >
      > **Three files, not two, and the third is not optional** (#2267
      > r41). An earlier version of this recipe said "the config strip and
      > the guard rewrite, minus the `SUCCESSOR` generator entry, which
      > names a file that branch does not have". That was right when the
      > guard's only use of the pinned pair was through that entry; it
      > stopped being right at r39, when the ops-separation check began
      > importing `SUCCESSOR` and `PREDECESSOR` directly. Dropping the
      > entry no longer drops the dependency — following the two-file
      > recipe gets `ERR_MODULE_NOT_FOUND` from a guard that cannot even
      > start, inside the window, with the writers already held.
      >
      > The entry itself still comes out, for its original reason and not
      > that one: it would compare `SUCCESSOR.name` — `vaipakam-warm` —
      > against the name the barrier tree actually agrees on, which is
      > still `vaipakam-archive`. Hence one generator constant below
      > rather than two.
      >
      > Re-verified in a worktree cut from `origin/main` with exactly
      > those three files applied and the three writers' `d1_databases`
      > removed:
      >
      > ```
      > CUTOVER BARRIER — all 3 writers declare no D1 binding
      > OK — vaipakam-archive agreed by 1 of 4 bindings (writers held),
      >      43 `wrangler d1` command(s), 1 generator constant(s),
      >      1 Worker verified separate                            exit 0
      > check-keep-vars / migration-prefixes / table-classification /
      > event-coverage                                             OK
      > ```
      >
      > The cutover PR then carries the same guard rewrite, so expect to
      > resolve that file when bringing it up to date after the barrier
      > merges. That is a textual conflict in one file, not a rethink.
      >
      > **The carry tool does NOT need to be on `main` for any of this.**
      > It runs from the cutover PR's checkout throughout, and since both
      > its endpoints are pinned constants it reads nothing from the tree
      > it runs in — which is exactly why that dependency was removed
      > (#2267 r22). No worktree to pin, no checkout to keep unsynced.
      >
      > **`check-d1-name-consistency` permits exactly this shape and only
      > this shape** (#2267 r21). It used to anchor on the indexer's
      > binding as the single declaration, which made the barrier
      > unrepresentable: strip the writers and the anchor is gone, and the
      > check reported there was nothing to compare against — so the
      > barrier commit could not be merged, and merging is its only deploy
      > route. The anchor is gone; the rule is that every consumer which
      > binds the shared database binds the same one, and the three
      > writers are ALL bound or ALL unbound.
      >
      > **[run] 2026-09-21** — the three shapes, against the live tree:
      >
      > ```
      > normal          OK — vaipakam-warm agreed by 4 of 4 bindings          exit 0
      > barrier         CUTOVER BARRIER — all 3 writers declare no D1 binding
      >                 OK — agreed by 1 of 4 bindings (writers held)         exit 0
      > half-applied    2 problem(s): … this is not the cutover barrier —
      >                 that shape needs ALL of them unbound                  exit 1
      > ```
      >
      > The half-applied case is the one worth having: a writer left bound
      > while the others are held keeps writing through a window every
      > later step believes is closed.
      >
      > **[evidence] 2026-09-21** — `cab26d24a` (#2252) carries
      > `Workers Builds: vaipakam-{indexer,keeper,agent}`, all `success`,
      > completing at `11:30:59Z` / `11:32:02Z` / `11:33:01Z`; the three
      > live Workers' latest deployments are `11:30:55Z` / `11:31:57Z` /
      > `11:32:56Z` — within seconds, all three. That establishes these
      > three DID deploy from that merge. It does not establish that a
      > green build is sufficient, which is the trap stated above.
      >
      > **[evidence] 2026-09-21, and this is the one to remember** —
      > `ff92150df` merged at `09:34:08Z` touching
      > `packages/contracts/src/**`, a workspace package **all three
      > writers import**. Exactly ONE built: `Workers Builds:
      > vaipakam-keeper`, `success` at `09:35:26Z`, deployed `09:35:22Z`.
      > The indexer and agent did not build and did not deploy — their
      > live versions were still yesterday's `11:30:55Z` / `11:32:56Z`
      > when this was measured at `10:52Z`.
      >
      > One merge, three Workers that all depend on what changed, one
      > deployment. **So a barrier commit touching all three configs can
      > land with only some of them held**, which is the half-applied
      > barrier — the state where the procedure believes the writers are
      > stopped and one of them is still writing. `--writers-held` is what
      > catches that. Nothing about the merge does.
      >
      > Note the division of labour, because the two checks sound alike
      > and are not: `check-d1-name-consistency` refuses a half-applied
      > barrier in the TREE (some writers stripped, some not);
      > `--writers-held` catches a half-applied barrier in PRODUCTION (all
      > stripped in the tree, not all deployed). Neither substitutes for
      > the other, and this merge is why the second one exists.
      >
      > **A direct `wrangler deploy` needs a credential the session token
      > does not have, and it fails after the decision to begin.** All
      > three writers bind **Secrets Store** secrets (`apps/indexer` 15,
      > `apps/keeper` 15, `apps/agent` 18), so creating a Worker version
      > for any of them needs a token that can bind those, not merely
      > `Workers Scripts: Edit`. A token without it gets:
      >
      > ```
      > ✘ [ERROR] A request to the Cloudflare API
      >   (/accounts/…/workers/scripts/vaipakam-indexer/versions) failed.
      >   Secrets store binding authorization failed. Check your
      >   permissions and secret scopes. [code: 10021]
      > ```
      >
      > **[run] 2026-09-21** — this is exactly what the session token did.
      > No version was created (the call fails at version-create), the
      > stripped configs were restored, and all four Workers stayed on
      > archive. Nothing was half-done, which is the one good property of
      > failing at this step rather than a later one. The same token reads
      > the store fine — it lists `vaipakam-credentials` and sees every
      > secret `active` and `workers`-scoped — so this is the token's
      > permission set, not the secrets' configuration, and re-scoping the
      > secrets would not fix it.
      >
      > **Do NOT work around it by also stripping the Secrets Store
      > bindings.** That removes secrets from a production Worker using a
      > token that cannot put them back: if the post-merge build then
      > failed, the Worker could not be restored from the same session. An
      > action that cannot be reversed with the credentials in hand is not
      > a workaround, it is a second outage waiting on someone else's
      > permissions.
      >
      > `ops/offchain-data-warm` is the exception in both directions: it
      > binds no Secrets Store secrets and it does not auto-deploy, so it
      > is the one Worker here that a `Workers Scripts: Edit` token
      > deploys by hand — which is what step 7 asks for.
   2. `digest --db vaipakam-archive`. Wait **10 minutes**. Digest again.

      **A table bigger than one page is read twice and compared, and the
      tool refuses if the two passes disagree** (#2267 r19). Paged reads
      are separate statements: a row inserted between pages whose sort
      position falls into a page already read is returned by none of them,
      so it is skipped with no sign. `activity_events` holds 1,125 rows
      against a page of 500, so it really does page. Against a source that
      has stopped, the second pass agrees first time. Against one that has
      not, the run fails and names this step — which is the right answer,
      because a reconciliation reporting "clean" from a read that may have
      skipped a row is the false pass this procedure keeps removing.
      **If anything changed, do not proceed — wait and repeat.** Two
      consecutive identical digests, ten minutes apart, allow the next step.
   3. `carry --from vaipakam-archive --to vaipakam-warm --mirror --manifest
      cutover-mirror.json` — the mirror carry, against a warm that nothing is
      writing to yet. **Keep that manifest**: step 6 cannot do its job
      without it, and the tool refuses to run step 6 without one rather than
      reporting a reconciliation it did not perform.

      **Keep it until the ROLLBACK window closes, not until the cutover
      finishes** (#2267). §4's step 2b reconciles against this same
      manifest before its reverse mirror, and `reconcile` will not run
      without `--since`. Deleting it when the cutover completes therefore
      removes the only baseline the documented rollback needs — while
      archive is still being retained for precisely that rollback. The
      window closes when the predecessor is deleted (§5, which does not
      authorise that on its own); the manifest goes then, with it.

      **[run] 2026-09-21 — the schemas agree today, so step 3 will not
      refuse on shape.** The carry refuses any table whose declaration
      differs between the two sides, which would stop the cutover dead
      inside the window. Compared directly, using the tool's own
      normalisation over `sqlite_master` on both databases:

      ```
      46 tables compared — 0 DDL difference(s), 0 archive-only, 0 warm-only
      ```

      That is 46 tables plus their indexes agreeing exactly, which also
      exercises the r25 change that stopped whitespace being collapsed
      inside quoted literals: applied to real declarations on both sides
      it produces identical strings, so it is neither over- nor
      under-normalising in practice. Re-run this on the day — a migration
      applied to one side between now and then is exactly what it would
      catch.

      **A failed mirror leaves the previous manifest alone**, and that is
      deliberate (#2267 r18). The manifest is written only by a run that
      succeeded. An earlier revision wrote it as soon as the carry
      returned — including when the carry had refused and written nothing —
      which replaced the baseline with archive's CURRENT, uncarried values.
      A later reconciliation comparing archive against that baseline would
      find them equal and classify warm's differing row as
      `destination-moved`: the late source update vanishes, silently, in
      the step built to find it. So if a mirror stops, the last good
      manifest is still on disk and still true; re-run the mirror for a
      fresh one.

      **[run] 2026-09-21** — proven end to end against the live pair. A
      mirror carried all 1,384 rows, then failed verification because
      archive had moved under it:

      ```
      wrote 1384 row(s)
      STOPPED — 2 problem(s):
        - indexer_cursor: source d08701b9… (19 rows) != destination 284bbe4a… (19 rows)
        - recycle_backing_snapshot: source 066e5e1b… (2 rows) != destination e50b5fa4… (2 rows)
      ```

      The manifest path was **never created**. Under the previous code it
      would have been written immediately after `wrote 1384 row(s)` — before
      the digests ran, before anything was known to be wrong — and those
      two moving tables would have become the new baseline.
   4. `digest --db vaipakam-archive` once more. If it differs from step 3's
      source digest, something committed during the carry: return to step 2.
   5. Merge. The three Workers redeploy onto warm (#2237). **Then deploy
      `ops/offchain-data-warm` by hand** — it is not in the auto-deploy set,
      so nothing the merge does moves it — and only then verify with
      `check-live-d1-bindings.mjs`, which asks what each Worker is SERVING
      rather than what its latest upload says (§3 explains why that
      distinction cost a false pass). The gate covers all four Workers, so
      running it before that manual deploy fails on the backup Worker even
      when every writer switched correctly. That is the probe being right
      and the sequence being wrong, and the sequence is what moved.

      **[run] 2026-09-21 — this deploy is pre-flighted, because it is the
      one step in the window that needs a credential rather than a merge.**
      `npx wrangler deploy --dry-run` in `ops/offchain-data-warm` builds
      clean at 46.26 KiB and resolves its bindings to
      `env.DB_ARCHIVE (vaipakam-warm)` and
      `env.R2_LEGAL_VAULT (vaipakam-legal-vault)` — so the config is
      already pointed at the successor and the build is not what will
      fail. It declares **no Secrets Store secrets**, which is why this
      one is deployable with a `Workers Scripts: Edit` token while the
      three writers are not (see step 1's box).

      The command is `( cd ops/offchain-data-warm && npm ci && npm run
      deploy )`, which is `wrangler deploy` — the same form used at lines
      621 and 979 of this document, so there is one spelling of it.
   6. **Reconcile, and keep reconciling.**
      `reconcile --from vaipakam-archive --to vaipakam-warm --since
      cutover-mirror.json` — or `--since "$MANIFEST"` if the baseline was
      recovered under the step-6 recovery box's name — which **reads both
      sides and reports. It writes nothing, to either database, ever.** Repeat until **TWO CONSECUTIVE**
      runs report nothing at all — with one documented exception: three of
      the situations below have a resolution that changes no data and so
      report on every subsequent pass. See the #2279 box under the
      situation table before concluding that a repeating line means
      something is unresolved.

      > **IF THE MANIFEST IS LOST, TAKE ANOTHER — DO NOT RE-RUN THE
      > MIRROR** (#2281). `reconcile` refuses to run without `--since`,
      > and the rollback consumes the same file, so for a while the
      > baseline was an irreplaceable artifact in the middle of a recovery
      > procedure: the only thing that produced one was `carry --mirror`,
      > which writes to a destination that is now LIVE. Re-running the
      > mirror to recover a baseline would roll warm's newer rows back to
      > archive's stale ones — worse than the problem.
      >
      > ```
      > node apps/indexer/scripts/d1-carry-rows.mjs manifest \
      >   --db vaipakam-archive --out cutover-mirror-reconstructed.json \
      >   --stands-for "<which moment, and what establishes it>"
      > ```
      >
      > **A NEW PATH, not the one the mirror used.** The verb refuses an
      > existing `--out`. Replacing a manifest the mirror wrote with a
      > reconstruction destroys the only baseline that was ever a direct
      > observation, and no error is needed to do it (#2281 r2).
      >
      > **IT IS ALWAYS WRITTEN UNCOVERED, and it cannot be otherwise**
      > (#2281 r3). An earlier revision took the coverage verdict as a
      > flag here — which recorded the claim BEFORE printing the digests
      > meant to substantiate it, so no operator could have compared
      > anything at the moment the artifact said "covered". Promotion is
      > a separate step that actually checks:
      >
      > ```
      > node apps/indexer/scripts/d1-carry-rows.mjs cover \
      >   --manifest cutover-mirror-reconstructed.json \
      >   --expect mirror-time-digests.txt
      > ```
      >
      > `--expect` holds what step 2 recorded AT the mirror. The `digest`
      > command’s own output pastes in as-is: per-table digests, the
      > `seq <table> <n>` high-water marks, and the `seq-listing complete`
      > line that says the sequence listing is whole.
      >
      > **PASTE THE WHOLE `digest` RUN — BOTH CLOSING LINES ARE
      > MANDATORY** (#2281 r8, r10). The rule-and-count line
      > `————…  1384  (43 tables)` closes the digest block, and
      > `seq-listing complete` closes the sequence block. They look like
      > formatting and are not: each is how a reading says it covered
      > the whole of its side, which is what lets `cover` treat a table
      > present in one recorded run and absent from another as proof the
      > database gained or lost a table in between.
      >
      > **`cover` REFUSES without one of each, before comparing
      > anything.** An earlier revision of this box said instead that
      > stripping a line merely switched the matching check off — which
      > described a silent downgrade as though it were a choice, on the
      > command that licenses the reverse mirror. It is now an error you
      > will see, and the remedy is to paste the block again.
      >
      > It also refuses if the count and the number of digest lines
      > disagree, rather than reading a part-pasted block as a complete
      > reading.
      >
      > **Rows alone cannot cover an interval.** A straggler that inserts
      > an AUTOINCREMENT row after the mirror and deletes it again leaves
      > every row digest and count identical while the high-water mark
      > moves. A reconstruction absorbs the moved value, and promoting on
      > row evidence alone would make the sequence comparison treat that
      > late allocation as original — switching off the one check written
      > for exactly that case. So `cover` requires BOTH, per table, and
      > refuses the whole promotion if any table is short of either.
      >
      > A refusal leaves the artifact untouched and uncovered. That is
      > still usable for finding NEW differences; what it must not do is
      > license the rollback’s reverse mirror.
      >
      > **CARRY THE RECOVERED PATH FORWARD — every `--since` in this
      > document names `cutover-mirror.json`** (#2281 r10). That file is
      > the one you just established is missing, so following this box
      > and then resuming the procedure as written fails on the very next
      > command. The recovered manifest is a REPLACEMENT for it, under a
      > different name because the original must never be written over.
      >
      > From here to the end of the rollback window, read every
      > `--since cutover-mirror.json` in this document as
      > `--since cutover-mirror-reconstructed.json`. Setting it once in
      > the shell keeps the two from drifting apart mid-procedure:
      >
      > ```
      > MANIFEST=cutover-mirror-reconstructed.json   # or cutover-mirror.json
      > ```
      >
      > and pass `--since "$MANIFEST"` thereafter. **Do not rename the
      > reconstruction to `cutover-mirror.json`** to make the commands
      > match: the name is what tells the next reader which of the two
      > kinds of baseline they have, and the artifact says so of itself
      > for the same reason.
      >
      >
      > Read-only; it writes no database.
      >
      > **PRESENT STILLNESS DOES NOT ESTABLISH PAST EQUALITY, and an
      > earlier draft of this box implied it did** (#2281 r1). What the
      > verb records is archive **as it is now**. Take the exact case this
      > step exists to find — a suspended invocation commits to archive
      > after the mirror, and archive then goes inert. Every present-tense
      > test passes: the digests are stable, nothing binds it. And a
      > baseline taken now **contains that late write**, so every later
      > run treats it as original and can never report it. The check is
      > not weakened; it is turned against itself.
      >
      > What substantiates the claim is evidence recorded **at** the
      > mirror — the digests step 2 took, and the post-carry reading in
      > step 4 — compared with what this reading finds.
      >
      > **Two verbs, and only one of them can decide this** (#2281 r4, an
      > earlier draft said flatly that "the tool cannot make that
      > comparison", which contradicted the `cover` command printed
      > above it). `manifest` cannot: it reads the database as it is now
      > and has no access to anything recorded earlier, so it writes the
      > baseline UNCOVERED and takes `--stands-for` only as a statement
      > for a human reader, carried **in the artifact** rather than in a
      > log that can be separated from it. `cover` can, and does: it is
      > handed the mirror-time evidence and machine-checks it against the
      > readings the artifact recorded, table by table, on both the
      > digest and the sequence.
      >
      > So `--stands-for` is not the coverage decision and never was —
      > it says which moment a reader should understand this baseline to
      > be about. `reconcile` prints it, along with `RECONSTRUCTED
      > baseline` and the coverage verdict, rather than calling any of it
      > "the mirror".
      >
      > **[run] 2026-09-21** — taken from archive after the cutover and
      > compared against the manifest the mirror wrote at 19:56: 43
      > tables, **zero differing entries**, and a reconciliation against
      > it returned VERIFIED with 0 conflicts. Here the evidence does
      > exist — step 2's digests at 19:40 and 19:51 and step 4's reading
      > at 19:57 are identical — so the interval is covered and the
      > reproduced baseline is the same baseline.

      > **TWO CLEAN RUNS PAUSE THIS STEP. THEY DO NOT END IT** (#2267
      > r34/r35). There is no fence on archive — see the banner at the
      > head of §4 — so a suspended invocation can commit after both
      > clean runs and leave a support ticket, a threshold or a signed
      > offer sitting in archive and absent from warm indefinitely.
      > Retaining archive makes that record **recoverable**; it does not
      > make it **found**.
      >
      > So while archive is retained, **re-run this reconciliation
      > weekly** — by whoever holds this runbook, from the switch until
      > the predecessor is deleted. It is a read against both databases
      > that writes to neither, so it costs minutes. Record every run in
      > the run log, clean ones included: the value of the record is that
      > a gap in it is visible.
      >
      > Nothing else in this procedure discovers a late write, and until
      > the predecessor is deleted there is no point at which one becomes
      > impossible. §5's checklist agrees — its box reads "is CURRENT",
      > not "completed", for exactly this reason.

      **It used to insert, and that capability was removed rather than
      guarded** (#2267 r14). Inserting into warm meant inserting into a
      LIVE database, and review found that unsafe from a new direction
      every round — most recently that a secondary unique index can be
      filled between the preflight read and the statement, which no
      preflight can close, because a check against a live database is a
      statement about the moment it read and not a lock. So the write is
      gone. Anything reconcile finds — including a row archive gained that
      warm lacks, which is the one case that used to be automatic — is
      **named for a person to apply deliberately**. With the expected
      straggler count at zero, that is a better trade than a race nobody
      can close, and it puts a human decision on every row that moves after
      the switch. Archive is retained regardless, so a row found a week
      later is still recoverable.

      **Two, not one**, and the difference is the whole reason this step
      exists: a single clean run says only that nothing had arrived by the
      moment it read. Work suspended across the barrier can commit
      immediately afterwards, which is precisely the case step 6 is here to
      catch — so one clean pass is the same unearned confidence the barrier
      was corrected for. `ProjectDetailsREADME.md` §13 and this change's
      release note both said two while this step said one; the step was
      wrong.

      **A late INSERT and a late UPDATE need different answers, which is why
      `--since` is mandatory.** A straggler that inserts a new row leaves a
      key warm lacks, which the reconciliation can see and name for the
      operator to apply — it carries nothing itself. A straggler
      that *updates* an existing row — an `offers` status, a cursor, a
      threshold — leaves a key warm already has, so a carry keyed on
      presence alone does nothing, reports zero rows, and calls itself
      finished while warm is stale. That is counting instead of comparing,
      one level up.

      Comparing the two databases directly does not help either: after the
      switch warm legitimately moves on, so almost every live row differs.
      What identifies a straggler is that the row changed **on archive,
      after the mirror** — a question about archive and its own past, which
      is what the manifest is.

      **With the manifest there are THREE facts per row, not two**, and
      reading it as two is how several defects got in. Was the row in the
      manifest; is it on archive now; is it on warm now. Those three
      answers are what let each situation be NAMED correctly. `reconcile`
      applies none of them — it writes to neither database — so every row
      below is reported for a person to apply:

      | situation | manifest | archive | warm | what it means |
      | --- | --- | --- | --- | --- |
      | `new-on-source` | no | yes | absent | a straggler inserted it → **reported for manual application**. The simplest case, and still not an automatic one |
      | `key-collision` | no | yes | a DIFFERENT row | both sides allocated the same key after the mirror — `notifications` and `diag_legal_hold_audit` are `AUTOINCREMENT`, so this is two different records wearing one id, and an insert would drop archive's |
      | `agreed` | either | yes | the SAME row | nothing to do, whatever the manifest says: an operator applied it after an earlier pass reported it, or resolved it some other way |
      | `destination-moved` | yes, = archive | yes | a different row | **only warm changed** — after the switch that is the live database doing its job, `indexer_cursor` advancing every minute. Not a conflict |
      | `source-changed` | yes, ≠ archive | yes | a different row | a straggler's write; which value wins is a decision |
      | `destination-deleted` | yes, = archive | yes | absent | **warm DELETED it.** Retention crons delete support tickets, diagnostics, telegram links, cancelled offers — and a deletion can be a privacy obligation. Re-inserting would silently undo it |
      | `destination-deleted-source-changed` | yes, ≠ archive | yes | absent | **warm deleted it AND archive changed it since.** Both facts belong in the decision: restoring undoes a deliberate deletion, leaving it discards a late value that no reading of warm will show. Reported as one conflict naming both (#2267 r27) |
      | (source-side) | yes, = warm's row | **no** | yes | archive deleted it after the mirror and warm still holds the row the mirror carried, so it is stale there. It is in none of archive's rows, so a loop over archive never sees it — this is a separate pass over the manifest |
      | (source-side) | yes, ≠ warm's row | **no** | yes | archive deleted it AND warm has changed it since, so warm has its own newer value. Not a stale row: deleting it would discard a setting a user may have just changed, which `user_thresholds` makes concrete since it is keyed by the setting rather than an allocated id (#2267 r26) |

      **`agreed` and `destination-moved` are why "repeat until clean" can
      ever come clean**, and each was missing once. Without `agreed`, a row
      a pass carried — or a conflict the operator resolved — reports
      forever. Without `destination-moved`, every row the live warm
      advances reports forever. Both are the same defect: a branch that
      stopped asking one of the three questions. The three are now asked in
      one place, the answer is a name, and the code that acts on it handles
      every name or throws — so a dropped question cannot be written.

      > **THREE OF THOSE SITUATIONS CAN NEVER COME CLEAN, AND THAT IS A
      > GAP IN THIS PROCEDURE RATHER THAN A MISTAKE BY THE OPERATOR WHO
      > HITS IT** (#2279, found scouting the same seam for the fourth
      > round running). The tool compares data. Three of the situations
      > above have a legitimate resolution that **changes no data** — it is
      > a decision to leave things as they are — and a decision is not
      > something either database holds, so the next pass compares the same
      > two rows and reports the same difference. Forever.
      >
      > Driving the shipped classifier against each resolution shows which:
      >
      > | situation | legitimate resolution | what the next pass reports |
      > | --- | --- | --- |
      > | `key-collision` | insert archive's record into warm under a NEW id, leaving warm's own record on the old one | `key-collision` again — the id is still allocated on both sides to different records |
      > | `destination-deleted` | decide the deletion stands (a retention cron did its job, or it was a privacy obligation) | `destination-deleted` again — the row is still absent from warm |
      > | the source-side *stale row* case | decide warm's row stays as it is | the same again — archive still deleted it after the mirror |
      > | `source-changed` | apply archive's value to warm | **clean** — this one converges, because applying it is a data change |
      >
      > **A fourth line behaves the same way, and it is not a row at all**
      > (#2267 r39): a reported **sequence advance** on archive. If a
      > straggler allocated an id and then deleted the row, nothing can be
      > applied — the identifier is simply spent on one side. The run used
      > to fall silent once warm's own sequence reached the same number,
      > which is not evidence of anything: warm allocates identifiers for
      > its own records every minute, and by number that is
      > indistinguishable from having applied archive's. The report now
      > shows warm's figure as context and keeps reporting. Record and
      > carry on, exactly as above.
      >
      > So a run is as resolved as it is going to get once every line it
      > reports is one **already recorded, by table and key, with the
      > decision taken**. That is the test, and it is deliberately by key
      > rather than by situation name: a second `destination-deleted` on a
      > DIFFERENT key is a new difference that has been decided by nobody,
      > and reading the name alone would wave it through. **Record each
      > decision, treat a run carrying only already-recorded keys as the
      > clean run for the two-run rule, and keep the weekly re-runs
      > going** — their job is to surface anything NEW, and a fixed set of
      > known-and-decided lines does not stop them doing it. What it does cost is the property that made
      > "repeat until clean" self-checking, which is why this is written
      > down rather than left for an operator to work out at 2am.
      >
      > **The fix is not in this change.** #2279 proposes recording
      > decisions — an `accepted` set in the manifest and a `ratify` verb
      > that puts them there — so a decided line stops reporting while an
      > undecided one still does. Building that at this point in the review
      > loop would add an unreviewed write path to the one tool whose whole
      > safety property is that it cannot write; stating the limitation
      > where the rule is asserted is the honest half, and it is the half
      > that helps the operator.

      Two more cases sit underneath that table, because *absent by primary
      key* is not the same as *insertable*, and *present under a key the
      manifest never saw* is not always a clash:

      - A row the **previous pass already carried** looks exactly like the
        two-records-one-id case — not in the manifest, present on both
        sides. **Content** is what tells them apart, and comparing it is
        what lets "repeat until clean" ever come clean: without it, pass
        two flags pass one's own work and the procedure never converges.
      - A row absent by primary key can still be **present under a
        secondary unique index** — `notifications.dedup_key` is one — where
        the same logical row reached both sides and was numbered
        differently. `ON CONFLICT (primary key)` does not cover that, so
        the insert would fail with a raw constraint error and abort the
        run. The tool checks every uniqueness the table declares and
        reports the clash instead. (A tuple containing NULL cannot collide,
        because SQLite treats those as distinct.)

      **Once the destination has taken a migration the retained source
      never will, three things follow, and all three are handled rather
      than assumed away** (#2267 r39). A column the destination has
      DROPPED is compared as absent, never as NULL — otherwise a
      straggler writing NULL to that column reads as the two sides
      agreeing and vanishes inside the only check still looking for it.
      The unique indexes consulted are the DESTINATION's, since that is
      the database that would reject the insert this run's report leads
      an operator to make; one naming a column the source lacks cannot be
      evaluated at all and is named in the output rather than dropped
      quietly. **Warm is read as the live database it is** (#2267 r42):
      paged by primary key, with no requirement that it hold still. The
      stability check that makes the *mirror* trustworthy is a demand
      that the database being read has stopped — right for archive inside
      the barrier, impossible for warm on a Tuesday afternoon, and a busy
      table like `activity_events` would have aborted the weekly run
      telling the operator to close a barrier that is not supposed to
      exist. Paging by key is what makes dropping that demand safe rather
      than merely convenient: every row present for the whole read is
      returned exactly once, where the offset paging it replaces loses a
      row whenever an earlier one is deleted mid-read. A row created or
      deleted *during* the read may or may not appear, which is a fact
      about the question rather than an error. A table that exists
      **only on warm** — what a migration creating one looks like from
      archive's side — is printed as drift rather than failing the run: it cannot hold a late write from
      archive, which is the only thing the run is looking for, and
      failing on it would end the weekly check at the first schema
      change. And a reconciliation **no longer stops at the conflict
      list**: its two remaining late-write checks — the sequence
      comparison and the re-read that notices the source moved — come
      afterwards, and with #2279 making a conflict permanent, stopping
      there would have switched both off for good. The carry still stops,
      because it wrote nothing and has minutes of digests ahead of it
      inside the cutover window.

      **The tool resolves no conflict, and a conflicted run writes
      nothing at all.** It classifies every table first and only then
      acts, so a run that finds both a safe row and a conflict applies
      neither — a failed command must not leave a live database partly
      mutated, which is the state hardest to reason about afterwards.

      **A conflict names the table and the key, and stops there.** It does
      not print the row: `support_tickets` puts the user's message and
      email immediately after the key, `diag_errors` carries whatever a
      stack trace held, and cutover output gets pasted into run logs and
      issues. An operator who needs a value queries for it deliberately.

   Step 6 is not a belt-and-braces precaution; it is the only part of this
   that covers work suspended across the whole barrier. It is possible
   because the carry tool has a mode that **cannot write at all** —
   reconciling with a mirror carry would roll warm's newer rows back to
   archive's stale ones, which is a worse outcome than the problem. Read
   "safe against a live destination" as the absence of a write path and
   not as a careful one: a guarded write against a live database is what
   review removed, round after round, and the phrasing should not invite
   putting it back.

   What steps 2 and 4 do rest on is "a write changes the digest", true by
   construction — unlike "every writer is on this list", the unbounded
   predicate §"Stopping the writers" refuses. Their residual is stated
   rather than absorbed: a write storing a value **identical** to the one
   already there moves no digest. Harmless for the carry, and not a claim
   that nothing is running.

   The ten minutes is not a derived bound and is not presented as one; it is
   an observation interval long enough that ordinary movement shows up in it.
   The **evidence** it is sized against is in step 2 of the execution record:
   three tables drifted within minutes with the writers live.

   > **SUPERSEDED (#2267 r22).** This paragraph used to say the binding
   > removal was an uncommitted, operator-side edit that the operator
   > restored afterwards, with tooling to avoid hand-editing production
   > config tracked as #2250. An uncommitted edit produces no merge, and
   > these Workers have no deploy route other than a merge — so following
   > it would have left every writer attached while the operator went on
   > to the copy believing they were held. The barrier is a COMMIT, cut
   > from `main` before this change and merged; step 1 above is the
   > executable version. #2250 is unaffected: it is about not hand-editing
   > the config, which is still worth having.

   An earlier revision of this record listed the switch as done and described
   a "sync just before merging" as sufficient. It is not, and saying so was
   the same class of error this document keeps warning about: a procedure
   claiming a guarantee its mechanism does not provide.

### Decision 2 below was SUPERSEDED, and that is worth stating plainly

The 2026-08-03 decision was *do not migrate the data*, on the reasoning that
fresh contract deployments were expected and would make the indexed data stale
anyway. The owner delegated this decision again on 2026-09-21 ("proceed as
required, I will go with your recommendations"), and the data **was** copied.

The reason for reversing it: **the fresh contract deployment has not happened.**
The Diamond addresses in `packages/contracts/src/deployments.json` are
unchanged, so the 38 loans, 49 offers and 1,125 activity rows describe the
deployment that is live right now. Starting warm empty today would not discard
stale data — it would discard current data, and with it the 19 `indexer_cursor`
rows that tell the indexer where it had scanned to. An empty cursor table means
re-scanning from the configured start block or silently beginning from now.

If a fresh contract deployment does land later, the **chain-derived** data
becomes stale exactly as the original decision anticipated, and clearing that
is a `DELETE FROM` per table — cheap, and a decision that can be taken with
the redeploy in hand rather than in advance of it.

**Not every table is chain-derived, and a blanket clear would take user data
with it.** §5 records the two that a contract redeploy does not obsolete:
`support_tickets` (4 open) and `user_thresholds` (per-wallet alert
configuration carrying a Telegram chat id). Loans, offers, activity and
cursors describe a deployment; a support request and a user's alert settings
describe a person, and a new Diamond address makes neither of them stale. So
"clear it then" means the chain-derived tables, named individually at the
time — never `DELETE FROM` across the schema.

This is the same shape as the retired Step 0 above, which is why it is
spelled out here rather than left to judgment: a clearing instruction that
does not say what it excludes gets carried out in full.

**This is recorded as a superseded decision rather than an edited one.** The
original reasoning was sound for the world it was written in; what changed is
that the world did not arrive.

**Owner decisions (2026-08-03):**
1. Proceed with the cutover — the platform is pre-live.
2. ~~**Do not migrate the data.** Fresh contract deployments are expected, so
   the new database starts empty and captures new data only.~~ **Superseded
   2026-09-21 — see above.**

That second decision is what made this document short. Earlier revisions
carried a quiesce, a whole-database export/import, a reconciliation and a
secure-destruction step for a file full of personal data. The copy that was
actually performed is none of those: 1,384 rows through an idempotent upsert,
verified by a per-table content digest. **The quiesce came back** — execution-
record step 3 — because this decision removed the export/import, not the need
to stop the writers before the last copy.

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

Where a command does appear here it is marked **[run] `<date>`** if that exact
form was executed against the live account on that date, or **[unrun]** if it
was written but not executed. Every `[run]` block carries its date — there are
no undated ones and no relative words like "today", which say nothing to
someone reading on another day.

The date moved into the blocks when a later one was added on 2026-09-17
(#2243 r5): a single date in this paragraph made the marker ambiguous the
moment a second sitting contributed to the file, which is the opposite of what
it is for. The existing blocks were dated in the same change (#2243 r6) —
changing the convention without migrating its instances would have left the
marker exactly as ambiguous, by a different route. That distinction is the honest one, and it is the
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
install -m 700 -d ~/vaipakam-cutover        # [run] 2026-08-03 — private dir FIRST
# [run] 2026-08-03
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

### ~~Step 0 — clear the target~~ — RETIRED, DO NOT RUN (#2267 r28)

> **This step deleted user data, and following it today would discard the
> records this move exists to preserve.** It belonged to the *do not
> migrate the data* decision, which was reversed on 2026-09-21 (see
> §"Decision 2 below was SUPERSEDED"). Under that decision warm was to
> start empty, so six rows hand-copied during #1537's preparation —
> `user_thresholds` 1, `notify_state` 1, `support_tickets` 4 — were stale
> fixtures to be cleared.
>
> They are not fixtures any more. The reversal carries archive's rows
> across, `user_thresholds` and `support_tickets` among them, and no later
> step restores anything this would delete. An operator working down §3's
> numbered steps rather than the execution record would therefore delete
> four open support tickets and a user's alert configuration, and the
> cutover would carry on looking correct.
>
> The command is deliberately left unrunnable rather than deleted, because
> this step was the documented first action for seven weeks and someone
> may come looking for it:
>
> ```
> RETIRED — do not paste. It read:
>   DELETE FROM user_thresholds; DELETE FROM notify_state;
>   DELETE FROM support_tickets;
> ```
>
> **Nothing replaces it.** The mirror carries archive over warm's contents,
> row by row, and removes what archive does not have — which is what
> clearing was for, done by comparison rather than by deletion. Step 0b
> below is unaffected and still applies.

### Step 0b — re-apply migrations if any landed since

The target was prepared through `0048`. **Neither changing a binding nor
`wrangler deploy` applies D1 migrations** — that is a separate command, and
on the deploy path it runs as its own phase. If any migration merged between
preparation and execution, the Workers will come up against a database
missing its schema.

```bash
# [run] 2026-08-03 — this exact form was used on the source that day
# ("today" until #2243 r6: a relative word in a file read on other days says
# nothing about when the command was verified, which is the whole job of the
# marker)
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
four agree on both fields, so a partial switch cannot **merge**.

**That is a claim about the repository, not about production** (#2238 r7 P1).
The check reads committed configuration: it guarantees the four files change
together in one commit. It says nothing about the four *live* Workers, which
take that commit through four independent builds — so a partially switched
deployment is not merely possible, it is what every merge produces for as long
as those builds take, and a failed build can leave it that way indefinitely.

An earlier revision called this "the protection worth having here", which
would let an operator read a green check as cover for the live hazard and
leave the writers running. It is worth having, and what it protects against is
a half-switched *tree* — where migrations and reads would target different
databases on the next clean checkout. **Live safety comes only from stopping
the writers and confirming each Worker's binding individually**, which the
sections below are about.

Update the docs that describe the live binding in the same PR — the same
check scans `wrangler d1` commands in scripts and runbooks.

### Step 2 — deploy the ones that do not auto-deploy

`apps/indexer`, `apps/keeper`, `apps/agent` **and `apps/www`** deploy
automatically on merge, via Cloudflare Workers Builds. **`ops/offchain-data-warm`
does not, and `apps/app` is operator-deployed by design.**

**Corrected twice on 2026-09-17, in opposite directions**, which is why the
test below matters more than the list:

- **#2237** — this step named `apps/agent` as not auto-deploying. It does.
- **#2242** — the corrected list then omitted `apps/www`, which also does.

**Do not test this by looking for a build check.** That is what #2237's
correction used, and measuring every Worker afterwards showed it misleads in
both directions:

On **`main`** commits:

| Commit | Touched | Build checks that ran |
| --- | --- | --- |
| `9623117ac` | `CLAUDE.md` only | **all five** |
| `7a3545b58` | `docs/` only | **none** |
| `51c21a4b6` | `apps/indexer`, `docs/` | indexer only |

A root-level file change triggers every Worker's build; a `docs/`-only change
triggers none. So "a check appeared" can be true of a Worker the commit never
touched, and "no check appeared" can be true of one that is on the automatic
path.

**And PR heads behave differently again**, so do not read the table above as
the rule for a branch. Three `docs/`-only PR heads — `c4e0582b3`, `37aba6d4b`,
`7d3f02d90` — each got exactly one build check, `vaipakam-app`, where the same
shape of commit on `main` got none at all. Whatever governs these triggers,
"which Worker deploys itself" is not recoverable from it. Worse, a **green check does not imply a deployment** — `apps/app`'s build
reported success on `06d657b9f` (2026-09-13) and that Worker's latest
deployment is still `2026-09-10T00:38:56Z` (#2241).

### The deployment timestamp can prove a Worker is BEHIND. It cannot prove one is CURRENT.

That asymmetry is the whole of what this step can offer, and stating it as a
symmetric test is the mistake this section has now made twice — first with
build checks, then with timestamps (#2243 r1, six findings, four of them this).

First, the concrete pair that was executed, with its **verbatim** output —
`apps/indexer`, on 2026-09-17:

```bash
# [run] 2026-09-17 — exactly these two commands, run in this order from the
# repo root, exactly this STDOUT. wrangler also writes a banner and config
# warnings to stderr; they are not reproduced here and `grep` does not
# suppress them.
#
# The SUBSHELL is load-bearing (#2243 r5): without it the first command leaves
# the shell in apps/indexer, and the second's `-- apps/indexer` pathspec then
# resolves to apps/indexer/apps/indexer and matches nothing.
$ ( cd apps/indexer && npx wrangler deployments list | grep -E '^Created:' | tail -1 )
Created:     2026-09-17T16:09:37.144Z

$ TZ=UTC git log -1 --date=iso-strict-local --format='%h %cd' origin/main -- apps/indexer
838c25cf3 2026-09-17T16:08:34+00:00
```

**What that example does and does not show**, since it is the wrong way round
from the heading and it would be easy to misread. The deployment is 63 seconds
NEWER than the commit, so the test returns nothing: it is consistent with the
Worker being current and does not establish it, for the four reasons below. It
is quoted because it is what a healthy reading looks like — not as a pass.

And the generic form, which is a **template and was not executed as written**
— `<worker-dir>` is a placeholder, not a path:

```bash
# [unrun] — parameterised. The concrete instance above is the executed one.
git fetch origin main                      # the left side goes stale silently

# In-workspace Workers (apps/*): pnpm has already installed wrangler.
( cd <worker-dir> && npx wrangler deployments list | grep -E '^Created:' | tail -1 )

# ops/* packages are OUTSIDE the pnpm workspace and may have no local
# wrangler, in which case `npx` silently downloads an UNPINNED one from the
# registry (#2243 r3). Install first and call the installed binary:
( cd ops/offchain-data-warm && npm ci \
    && ./node_modules/.bin/wrangler deployments list | grep -E '^Created:' | tail -1 )

# TZ=UTC with %cd, NOT %cI: `%cI` ignores `--date` and prints the commit's
# ORIGINAL offset (+05:30 on this repo), while wrangler prints UTC `Z`.
# Comparing those two literally makes a healthy deployment look older.
TZ=UTC git log -1 --date=iso-strict-local --format='%h %cd' origin/main -- <worker-dir>
```

**The split is the point** (#2243 r4). An earlier revision marked the whole
block `[run]` and pasted a hand-aligned summary underneath — text neither
wrangler nor git emits — which presents a template and a reconstruction as
execution evidence. In a runbook whose only validation is that its commands
were tested, that is the marker meaning less than it says, one round after
this PR corrected the same slip elsewhere.

**`%cd` under `TZ=UTC`, not `%ad` and not `%cI`** (#2243 r2, r3). An author date
is user-controlled and survives rebase, so a commit can carry one LATER than
the moment it reached `main` — reporting a deployment that already includes it
as behind. `%cI` fixes that and introduces a zone mismatch instead, because it
ignores `--date`. `%cd` with `--date=iso-strict-local` under `TZ=UTC` is the
form that is both committer-dated and directly comparable to wrangler's `Z`.
On the five most recent `main` commits the author and committer dates are
identical, so the figures quoted below are unaffected by the field change.

**A deployment older than the newest commit means that code is not live** —
and this is the direction to rely on. It is not absolutely proof: a commit
bearing a timestamp later than when it actually landed would read as behind
while already deployed. But that is the **safe direction to be wrong in**. A
false "behind" costs a redundant deploy or a second look; a false "current"
costs exactly what this whole step exists to prevent.

**A deployment NEWER than the newest commit establishes nothing**, for four
separate reasons, all of which produce a false "current":

- **The left side is not the build input set.** Every workspace Worker depends
  on `@vaipakam/contracts`, and this cutover explicitly allows
  `packages/contracts/src/deployments.json` to change without touching a Worker's
  own directory. `apps/www` can then pass while serving old addresses.
- **`origin/main` is a cached ref.** A clone last fetched before the merge
  compares against a commit that predates it. Hence the `git fetch` above, and
  the reason it is the first line rather than assumed.
- **A rollback creates a fresh deployment pointing at OLD code.** `wrangler
  rollback` makes a new deployment record for a previously built version, so
  `Created:` is recent and the running code is not. `grep '^Created:'` reads
  exactly the field that lies here; the per-version timestamps underneath it
  are what to read during any rollback or recovery.
- **A failed automatic build looks exactly like a Worker that is behind** —
  because it is one.

**Do NOT infer the deployment MECHANISM from staleness.** An earlier revision
said "a Worker more than a few minutes behind is not on the automatic path".
That is wrong and it is actively harmful: a Worker whose automatic build
FAILED is also behind, and this document says elsewhere that the mixed state
then persists until someone repairs the build. Reading staleness as "this one
is manual" sends an operator to hand-deploy around a broken build instead of
fixing it. Staleness says *the code is not live*, and nothing about why.

For reference, when every automatic Worker was healthy on 2026-09-17 each had
deployed **63–151 seconds** after the commit touching it. That is a sense of
the normal gap, not a classifier.

As of that measurement, `ops/offchain-data-warm` was **28 days behind** (newest
commit `d5d3b3083` 2026-08-31, last deployment 2026-08-03) and `apps/app`
**4 days behind** (#2242) — both in the direction the test can prove.
`ops/mesh-watcher` does not exist on the account at all, which is the expected
pre-arm state — GovernanceRunbook Step 3f deploys it as part of the arming
ceremony — and is not a drift to act on here.

Both hand-deployed Workers need a hand in the same sitting as the merge.

```bash
# [unrun here] — verified form, from OffChainRestore.md §7b.
# NOT `npx wrangler` from the repo root: this package is outside the
# pnpm workspace, so that would be an unpinned download.
( cd ops/offchain-data-warm && npm ci && npm run deploy )
```

```bash
# [unrun] — apps/app is operator-deployed because its build env lives in a
# gitignored `apps/app/.env.local`, which a build from a git clone cannot see.
pnpm --filter @vaipakam/app run deploy
```

**That command is NOT sufficient on its own, and the guard does not make it
so** (#2243 r1). `run deploy` carries `REQUIRE_INDEXER_ORIGIN=1`, which checks
exactly one variable. `docs/ops/DeploymentRunbook.md` lists a deployable
`.env.local` as **nineteen** operator variables — keyed RPC endpoints, the
WalletConnect project id, the agent origin, feature flags and the rest. A file
carrying only the indexer origin passes the guard and deploys **successfully**,
replacing the live app with a preview-grade configuration.

So follow DeploymentRunbook's full procedure for this one. An earlier revision
of this step implied the guard was the safety net; it is a single assertion
about a single variable, and reading it as coverage is how a four-day-stale app
gets replaced by something worse.

**Neither is optional here**, and the staleness figures above are the reason
to check rather than assume: both were behind on the day this step was
written, so "somebody will have deployed it" is not a safe default for either.

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

**"Every user-facing writer" is more than agent**, which is the second thing
the old frame got wrong (#2238 r2 P1) — and establishing HOW MANY more turned
out to be the hard part. Known writers include both public Workers' user
routes, the agent's diagnostic routes (including a legal hold and its audit
record), both Workers' cron ticks, and the indexer's Durable Object alarm;
`apps/keeper` joins them the moment its schedule is restored, and its HF-band
inbox rows cannot be regenerated once the crossing has recovered.

**That list is known to be incomplete**, which is why the next section refuses
to present one as a procedure.

### The writers must be quiesced across the change — and the procedure for that is NOT specified here

**What is established**, and it is the part this step needs:

- A binding change reaches each Worker through its own independent build, so
  the deployment set is in a mixed state until every binding is confirmed:
  unknown which have switched, no guaranteed order, a duration not derivable
  from the data gathered in #2237, and no guarantee a given one switched at
  all — a build can fail and leave that Worker on the old binding until a
  person repairs it.
- Writes reaching the abandoned database in that window are lost, and some of
  them are things a user watched succeed: a threshold, a signed offer, a
  support ticket, a legal hold **and its audit record**.
- So the writers must be stopped across the change, and restarted only once
  every binding is confirmed.

**How to stop them was an open question. The MECHANISM is now settled (#2239,
shipped in #2252); the PROCEDURE is not (#2255)** — see the update below, and
read the rest of this section as the record of why an inventory was refused.
Four
review rounds of #2238 tried to write that procedure as an inventory of
writers to close, and each round found another way one reaches D1 that the
previous wording missed — a second Worker's routes, a cron event that
traverses no route, the diagnostic routes, a Durable Object alarm that
re-arms itself, `waitUntil` work admitted before the gate, `workers.dev`
aliases that bypass a zone rule, and a schedule change that takes up to
fifteen minutes to propagate.

**UPDATE 2026-09-20: the MECHANISM now exists; the PROCEDURE still does not**
(#2239, shipped in #2252). The Workers can be held off the database by
capability removal — a deployment whose `d1_databases` entry is absent, so
nothing in the isolate can obtain a handle whatever entry point it arrives
through — and they now cooperate with that state rather than crashing into it.
`docs/FunctionalSpecs/ProjectDetailsREADME.md` §13 states the intent under
"Off-Chain Data Services".

**That is the mechanism, not the runbook.** Writing the step-by-step procedure
around it needed four things this document did not have: tooling to produce
a maintenance build without hand-editing production config (#2250), an owner
decision on whether retained rows are archived or restored, a drain criterion
that survives its own premise, and the contract-redeploy sequencing in §2.
**#2255 carries that work and the open findings against the draft.**

**Two of the four are now settled, for THIS cutover** (2026-09-21, #2214).
The owner decision was taken — the rows are carried across, recorded above as
a superseded decision — and the drain criterion exists: the **observed-still**
barrier in execution-record step 3. It survives its own premise because its
premise is "a write changes the digest", true by construction, rather than
"every writer is on this list", which is the unbounded predicate this section
refuses. Its residual — an in-flight write storing a value identical to the
one already stored — is named there, not absorbed.

The other two remain open, and §2's sequencing is untouched. So the general
procedure is still #2255's to write; what is settled is the procedure for
this one move. #2250 remains open too, but it is no longer what makes the
maintenance build an operator-side edit — **it is not one**. The barrier is
a commit, merged, because a merge is the only route these Workers have to
production; #2250 is about generating that commit rather than hand-editing
the config to produce it.

**Enumerating the ways code can reach a database is an unbounded predicate.**
Writing a list here that reads authoritative and is incomplete is worse than
saying so: an operator follows it, believes the writers are stopped, and loses
exactly the rows this section exists to protect. #2239 carried the
requirements and the evidence for each, and **its central question is now
answered**: a maintenance build carries **no D1 binding at all**, which is the
one formulation that does not depend on having enumerated the entry points
correctly. That is shipped. What remains open is the procedure built on it —
#2255.

**This paragraph described the state before 2026-09-21** and said the cutover
required an operator willing to accept that exposure, because the mechanism to
avoid it existed and the procedure did not. That is no longer the choice being
made here: execution-record step 3 is the procedure, and the next section's
watch-it-through alternative is **not** the route this cutover takes. It is
retained because the reasoning for when it would be defensible is still the
reasoning, and because reading it explains what step 3 is avoiding.

### The alternative, and when it is defensible

**Watch it through (the 2026-08-03 choice, defensible only pre-live).** Merge
when someone is watching and run Step 3 immediately, accepting that anything
written in between may be lost. This was chosen when there were no real users.
It is not a decision to inherit once there are.

~~**Until #2255 lands, this is effectively the only procedure this document
can honestly offer.**~~ **NO LONGER TRUE, and it must not be read as an
instruction (2026-09-21, #2267 r10).** Execution-record step 3 is a
procedure, it is the route this cutover takes, and this sentence sat a few
lines below a statement saying so — two mutually exclusive instructions for a
live data move, the later of which explicitly accepts lost writes. It is
struck through rather than deleted because the reasoning in the next
paragraph is still correct and still worth reading.

That reasoning: **a partial gate is this option wearing a disguise.** Closing
the public routes while cron still ticks, or while a Durable Object alarm
re-arms itself, accepts the same exposure and hides it behind a step that
looks like protection. That is exactly why step 3 removes the binding rather
than closing routes.

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
makes a Worker still stuck on the target appear to pass.

**The discriminator does NOT invert, because it is not a property of the
data.** An earlier version of this paragraph said the target's emptiness
proves the switch on the way out and the source's accumulated rows prove it
on the way back — which contradicted the box fifteen lines below, where the
emptiness tell is retired outright. Both databases hold the same rows after
the copy, so neither emptiness nor accumulation distinguishes them in either
direction. The binding id does, and it does so identically both ways: read
it from the control plane and compare it against the database you intend.
That is the whole of the inversion — `--expect` names the other end, and
nothing else about the check changes.

Wherever this step says "the target", read "the intended database", and pick
the discriminator that can only be true of it.

**The probe must distinguish the databases.** An earlier revision listed
checks that all pass against the OLD binding too — a keeper tick logs cleanly
either way, an agent request reads a schema-valid database either way, and
the backup Worker completes into whichever `B2_BUCKET` it holds. Those prove
the Worker is alive, not where it is pointed.

Use checks that can only be true of the new database.

> **The emptiness discriminator is GONE, and this is the correction** (#2267
> r1). Every revision of this section up to 2026-09-21 used the target's
> emptiness as the tell: zero `offers`, zero `activity_events`, a first
> `indexer_cursor` row appearing. **The data was copied, so both databases now
> hold the same 1,384 rows**, and an emptiness test against the target now
> fails on a correctly switched Worker while telling you nothing about one that
> never switched. It inverted from a discriminator into a false alarm.
>
> Do not replace it with "roughly equal row counts" either. Two databases
> carrying the same rows are indistinguishable by counting them — that is the
> whole problem, and it is the same mistake as verifying the copy by row count
> (which missed two genuinely divergent tables until a content comparison
> found them).

**The binding read is the discriminator.** It is authoritative, it is the only
check available while the writers are stopped, and it reflects what is actually
deployed rather than what the code intends — which is why it already leads the
list below. Read each Worker's D1 binding from the control plane and compare the
**database id**, not the name: an id cannot be ambiguous the way a name in a
config file that may not have deployed yet can.

Where a data-level tell is still wanted after traffic resumes, write a **unique
sentinel** through the Worker's own surface and look for it in the target by
that exact value. A sentinel discriminates because you chose it; emptiness
discriminated only while the target happened to be empty, which was a property
of the world rather than of the check.

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

  A threshold row is operator-owned configuration on a wallet you control, and
  can be deleted afterwards — pick the probe accordingly.

  **NEVER probe the indexer with `POST /signed-offers`** (#2238 r6 P1). An
  earlier revision said to, on the reasoning that the ingest cursor proves
  only that the scan switched. The reasoning was wrong and the instruction was
  dangerous: that route is not a diagnostic. It validates a real EIP-712
  order, inserts it `status = 'active'`, and `GET /signed-offers` then serves
  it to takers to fill on-chain. Confirming a database binding is not worth
  leaving a fillable order behind.

  It is also unnecessary, because **a Worker has ONE D1 binding**. `env.DB` is
  the same object for every route, every tick and every alarm in that Worker,
  so a write observed from ANY of them proves where ALL of them write. For the
  indexer, its own ingest write — the cursor advancing in the intended
  database — is therefore sufficient, and it costs nothing and risks nothing.

**THE ORDER MATTERS, and it survives whether or not the writers were stopped**
(#2238 r3 P1, adjusted r6 P2). Confirmation is two passes, and the first is
the one that authorises restoring normal operation:

1. **Binding read — control plane.** Run

   ```
   node apps/indexer/scripts/check-live-d1-bindings.mjs
   ```

   A configuration check, labelled as such. **After the merge, run it with
   no flags.** A serving version with no D1 binding at all is a FAILURE
   there — that is a Worker still on the maintenance build, which is what a
   failed or unfinished deploy looks like, and passing it would authorise
   traffic to a Worker that cannot reach any database.

   > **Inside the barrier, the question is different and so is the
   > command: `--writers-held`.** It replaces a `--allow-maintenance` flag
   > that could not answer it (#2267 r13). That flag merely *permitted* a
   > version with no binding, so it would have passed a writer still
   > happily serving the old database — proving nothing about the writers
   > being stopped — and it still checked the hand-deployed backup Worker,
   > which inside the barrier is *deliberately* still on archive, so the
   > one command offered for confirming the barrier reported a mismatch
   > even when the barrier was perfect.
   >
   > `--writers-held` asks the positive question of the three Workers the
   > barrier is about: **does each serving version carry no D1 binding at
   > all.** The backup Worker is out of scope there by construction, and
   > the command says so rather than quietly skipping it.

   The post-merge form is the gate that authorises restoring normal
   operation. It is the only check that
   distinguishes "build still running" and "build failed" from "switched",
   since it reflects what is actually deployed — and the only one available at
   all if the writers have been stopped, because the write probes below go
   through the very surfaces a stoppage closes.

   > **Do NOT read this from *Settings → Bindings* or from
   > `/workers/scripts/<name>/settings`. That probe returns the wrong answer,
   > and it returns it in the PASSING direction.** Those report the bindings
   > of the most recently UPLOADED version, which on a repository with branch
   > builds is a version nobody is served. Measured 2026-09-21, mid-cutover:
   > `settings` reported `DB=e5e927cf…` (**warm**) for `vaipakam-indexer`,
   > while the deployment actually serving traffic — version `964d9628…`,
   > uploaded the previous day — was bound to `3cffebf5…` (**archive**). A
   > cutover "verified" that way is declared complete while every write still
   > lands in the database being abandoned.
   >
   > The script asks the DEPLOYMENT instead: the active deployment, then
   > **every version inside it** — a gradual deployment splits traffic, so
   > checking only the first would let a 90/10 split pass with a tenth of
   > requests still writing to the old database — then that version's own
   > bindings. The expected id is one of the two databases this move is
   > between, pinned by id in `apps/indexer/scripts/lib/cutover-databases.mjs`
   > — `--expect` selects which, and a name that is neither is refused
   > rather than resolved against the account (#2267 r23).
   >
   > **A version with no D1 binding at all FAILS this check**, and that is
   > not the same command as the barrier confirmation. Normal mode asks
   > "is every serving version on the expected database", and a Worker
   > attached to nothing is not; `--writers-held` asks the opposite
   > question of the three writers and is the only mode that treats a
   > bindingless version as correct. An earlier version of this block said
   > normal mode reports it as the maintenance build, which would have had
   > an operator confirm the barrier with the command that cannot confirm
   > it (#2267 r24).
   >
   > This replaces the wording added in #2267 r1, which said to read the
   > binding id "from the control plane" without saying which reading — and
   > the obvious reading is the one that lies.

   **[run] 2026-09-21, before the switch** — all four Workers reported
   `MISMATCH` on `3cffebf5…` (archive) at 100%, which is the correct
   pre-cutover answer and is what a probe that works looks like when the
   thing it checks has not happened yet.

   **[run] 2026-09-21 10:52Z — the ROLLBACK direction, green for the
   first time.** `--expect vaipakam-archive` against the same live state
   returns `OK` for all four, with the loud header naming it as the
   rollback direction. Both verdicts are the same reading of the same
   four Workers, so the pair confirms the probe distinguishes the two
   databases rather than merely reporting whatever it was asked for:

   ```
   expecting vaipakam-archive (3cffebf5…) — NOT the successor (vaipakam-warm).
   This is the rollback direction; say so in the run log

     vaipakam-indexer             964d9628 @ 100%  DB=3cffebf5… OK
     vaipakam-keeper              cf230d1e @ 100%  DB=3cffebf5… OK
     vaipakam-agent               54293476 @ 100%  DB=3cffebf5… OK
     vaipakam-offchain-data-warm  31cfc0b2 @ 100%  DB_ARCHIVE=3cffebf5… OK
   ```

   That branch had never been run green before — it is the one the
   rollback depends on and the one whose expectation was being resolved
   from an account name lookup until #2267 r23. It is also the first run
   since the Worker roster moved into `lib/d1-workers.mjs`, so it
   exercises that rewiring against the live control plane rather than
   against the repository alone.

   **And the behaviour agreed, which is how the false pass was caught.**
   `indexer_cursor` was sampled on BOTH databases three minutes apart:
   archive's `97/diamond` moved 132243152 → 132243829 while warm's stayed at
   132242539. The indexer writes to archive; warm is inert. Note which way
   round this went — §"THE ORDER MATTERS" says the write probe "can still
   find something the binding read could not", and here the write
   observation is what **disproved** a binding read that said the move was
   already done. Two probes that can contradict each other are worth more
   than one that cannot, and neither is a formality.
2. **Write probes — behaviour.** Run them once traffic is flowing again. They
   can still find something the binding read could not, so they are not
   redundant; they are simply not available while anything is closed. If one
   fails here, stop the writers again rather than leaving them running while
   investigating — by deploying the maintenance build the mechanism provides,
   though the surrounding procedure for doing so safely is still #2255.

An earlier revision made the agent write probe "the test that closes the
deployment window". It cannot be: it is unavailable exactly when the window is
open. The binding read closes the window; the write confirms it afterwards.
- **backup Worker** — verified by **row counts**, not by the table list. It
  exports a fixed set of tables from whichever database it is bound to, so
  both manifests name the same tables and an earlier revision's "check the
  table list" would have passed either way. ~~The manifest carries a
  `rowCount` per table: against the target those are ~0, against the source
  they are the old ~1,100. That is the discriminator.~~ **Retired 2026-09-21
  (#2267 r1): the data was copied, so both databases report the same counts
  and this can no longer tell them apart.** Use
  `check-live-d1-bindings.mjs` instead — it covers this Worker too, reading
  its `DB_ARCHIVE` binding from the version actually serving. Note that the
  binding read is the *only* discriminator here, because the backup Worker
  exports a fixed table set from wherever it is pointed and has no surface of
  its own to write a sentinel through. Note also that this Worker is deployed
  **by hand**, so the merge does not move it — its line in the probe's output
  stays `MISMATCH` until someone deploys it, which is the probe doing its job
  rather than a fault.

## 4. Rollback

> ## THERE IS NO FENCE ON ARCHIVE, AND THREE STEPS BELOW ASSUMED ONE
>
> **Nothing in this procedure can revoke a handle an invocation already
> holds on `vaipakam-archive`.** Removing a binding stops the next
> invocation from obtaining one; it does nothing to one already granted,
> and §3 states plainly that no bound on how long such work can run has
> ever been measured. Stopping the *warm* writers later cannot revoke an
> *archive* handle taken before the cutover.
>
> It follows that **no point-in-time read of archive is a fence**, and any
> step that DESTROYS archive content on the strength of one is unsound.
> Round 34 found three places that did, and they are one defect:
>
> 1. the pre-migration export at step 0a — a write can land after the
>    export and before the destructive migration;
> 2. the migration itself at step 0b — applied in place, so it destroys
>    what it deletes;
> 3. the reverse mirror at step 3 — step 2b's clean report describes the
>    moment it read, and the mirror overwrites archive afterwards.
>
> **THE SOUND VERSION DOES NOT MUTATE ARCHIVE AT ALL.** A rollback would
> build a FRESH database, seed it from warm, apply the archive-only rows
> a reconciliation names, and point the bindings there — leaving archive
> immutable, forever, as everything else already treats it. That is a
> design change rather than a step reordering: it needs a third pinned
> endpoint, its own binding configuration and its own guard entries.
> **Tracked as #2278; not built here.**
>
> Until it exists, an operator rolling back must know that **steps 0b and
> 3 destroy archive content and cannot be made safe by any check in this
> document.** Take the export at 0a, understand it may be a moment short,
> and record in the run log that the rollback proceeded without a fence.
> That is the honest position, and it is worse than the one this section
> implied before.

**Free until the Workers start writing to the target — and staying free is
something you have to DO, not something you observe** (#2238 r2 P1).

A revert is a binding change, so everything above applies to it unchanged —
including that the procedure for stopping the writers is unspecified (#2255;
the mechanism it will use is shipped).
The revert has the same mixed state, in the same shape, and the same
consequence for a write that lands on the wrong side of it.
Confirming afterwards cannot make the window safe — during the revert's own
independent builds, a Worker still serving the target can accept the first
threshold, signed order or support ticket written there, and that row is lost
the moment the source becomes canonical again. A rollback that began inside
the free period can leave it while it runs, and nothing after the fact undoes
that.

**Mechanically — and the ORDER is the whole of it.** An earlier revision of
this paragraph started with "revert the binding PR", which made archive
canonical *before* the rows that exist only on warm had been carried back —
stranding precisely what §"Rolling back" adds the reverse carry to preserve.
Two orders for one operation, in one section, the earlier one lossy. The
sequence is:

0a. **INVENTORY the rollback target before you migrate it** (#2267 r32).

   This step exists because step 0b is destructive in the general case, and
   it runs BEFORE step 2b has looked at anything.

   A migration applied here can delete rows, drop a table, or remove a
   column. Archive is the retained copy of everything written before the
   switch, plus anything a straggler wrote after it — and step 2b, the
   gate that finds exactly those late writes, has not run yet. So a
   data-deleting migration destroys them with no conflict reported,
   because there is nothing left to report. The column-projection refusal
   added earlier does NOT cover this: it catches a schema that no longer
   matches the manifest, and a migration that quietly removes rows leaves
   the schema matching.

   **Reconcile BEFORE applying them — that pass is available, and this
   paragraph used to say it was not** (#2267 r40). It said the tool
   refuses a table whose declaration differs between the two sides, which
   stopped being true at r36: a report-only run now reports a DDL
   difference as drift and compares the rows anyway, and r39–r40 extended
   that to a dropped column and a dropped table. So the ordinary weekly
   pass runs perfectly well here, and it is the one thing that can name
   what a destructive migration is about to erase:

   ```
   node apps/indexer/scripts/d1-carry-rows.mjs reconcile \
     --from vaipakam-archive --to vaipakam-warm --since "${MANIFEST:-cutover-mirror.json}"
   ```

   (`MANIFEST` is unset in the ordinary case and the default applies; the
   step-6 recovery box sets it when the baseline had to be reconstructed
   under another name.)

   Run it, and keep the output with the digest. It reads both databases
   and writes to neither, so it costs minutes and risks nothing.

   **The order matters in one direction only.** Before the migration,
   every archive-only insert and every late change is still there to be
   named. Afterwards some of them are gone, and a column-removing
   migration additionally puts the manifest's own projection out of
   reach — the tool then refuses those tables rather than comparing them,
   so the pass that could have named the loss is degraded by the very
   change it would have reported on.

   The digest is still taken, because the two answer different questions:
   the reconciliation names what arrived late, the digest records what
   the whole database held.

   ```
   ROLLBACK_TARGET=vaipakam-archive     # the database being returned to
   node apps/indexer/scripts/d1-carry-rows.mjs digest --db "$ROLLBACK_TARGET"
   ```

   Keep that output. **Then read the pending migrations before applying
   them.** If any deletes rows, drops a table or removes a column:

   - export the affected tables from archive first — the nightly B2
     archive from `ops/offchain-data-warm` is the other copy, and
     `OffChainRestore.md` is how it is read; and
   - **say in the run log that the automated rollback is unavailable for
     those tables.** What step 2b would have found is now recoverable
     only from that export, by hand. This is a limitation NAMED, not
     closed: replaying rows a migration deliberately removed is a
     migration decision, and this tool does not make those.

   The reconciliation run above is what turns that from a warning into a
   list: anything it named that the migration then deletes is a known
   loss with a known identity, rather than something nobody will ever
   know was there.

0b. **Bring the rollback target's schema back to parity:**

   ```
   (cd apps/indexer && npx wrangler d1 migrations apply "$ROLLBACK_TARGET" --remote)
   (cd apps/indexer && npx wrangler d1 migrations list  "$ROLLBACK_TARGET" --remote)  # expect none pending
   ```

   The name goes in a variable here for the same reason as everywhere else
   in this document: `check-d1-name-consistency` scans `wrangler d1`
   commands, and a literal retired-database name in one is the split-brain
   shape it exists to catch. It caught this block when it was first written
   with the name inline — which is the guard working, not an obstacle to
   route around, and the reason the exemption removed in r2 stays removed.

   **This step is not optional and it is easy to forget, because archive
   looks untouched.** It is: no Worker binds it after the switch, so no
   migration reaches it, and from the first post-cutover indexer migration
   onward it is on an older schema than warm. The carry tool refuses a
   destination whose tables or constraints differ from the source — which
   is correct, and means an urgent rollback would stop dead at step 3 with
   the bindings still on warm. "The old database still exists" is not the
   same as "the old database is a usable rollback target", and the
   difference is one migration.

   If the pending migrations cannot be applied for any reason, **stop and
   say so** rather than working around the refusal: a reverse carry across
   a schema difference is a migration decision, not a copy.

1. **Stop the writers** — the maintenance build, as in execution-record
   step 3. Nothing below is safe while warm is being written to.
2. **Observe warm still** — `digest --db vaipakam-warm` twice, ten minutes
   apart, identical. Same barrier, same reason, same stated residual.
2b. **Account for anything archive holds that warm does not — BEFORE the
   reverse mirror, because the mirror destroys it** (#2267 r15).

   `reconcile --from vaipakam-archive --to vaipakam-warm --since
   cutover-mirror.json` — or `--since "$MANIFEST"` for a baseline
   recovered under the step-6 recovery box's name — read-only, and
   **resolve everything it reports**.

   > **A RECONSTRUCTED BASELINE MARKED `uncovered` DOES NOT LICENSE THIS
   > ROLLBACK, and an earlier draft called such a baseline "usable with
   > care"** (#2281 r2). It is usable for spotting NEW differences. It is
   > not usable HERE, and the difference is destructive.
   >
   > Follow it through. A straggler updates a row on archive after the
   > forward mirror. The baseline is later reconstructed and absorbs that
   > value, so archive now MATCHES its own baseline. Warm has since
   > changed the same row on its own. The comparison reads source =
   > baseline, destination ≠ baseline — `destination-moved`, which is not
   > a conflict and is not reported. Step 3 then mirrors warm over
   > archive and destroys the only copy of the straggler's write, with
   > every check having said clean.
   >
   > So: if the manifest in hand carries `provenance.interval:
   > "uncovered"` — `reconcile` prints it at the top of every run —
   > **the automated rollback is unavailable.** Say so in the run log,
   > and recover through the export path §4 step 0a describes, by hand.
   > That is a limitation NAMED, in the same way as the migration case
   > below it.
   >
   > A manifest the mirror wrote carries no `interval` and needs none: it
   > observed the moment it describes, so there is no gap to cover.

   The trap here is exact and worth spelling out: `--mirror` makes archive
   the DESTINATION, and a mirror deletes destination-only keys and
   overwrites rows that differ. A straggler that reached archive after the
   forward mirror — the precise row the whole retention argument exists to
   protect — is a destination-only or differing row at this moment. Running
   step 3 first erases it, and erases it before any later read-only pass
   could have observed it. A rollback begun before the forward
   reconciliation finished is the likeliest way to be in that state.

   **If this reports nothing, step 3 is not safe — it is merely not known
   to be unsafe** (#2267 r35). A clean result here describes the instant
   it read, and the banner at the head of this section says why that is
   not a fence: an invocation holding an archive handle from before the
   cutover can commit after this read and before the mirror, and step 3
   overwrites or deletes what it wrote. This step narrows the window; it
   does not close it, and it never will, because closing it is #2278.

   So a clean result is the signal to PROCEED KNOWING THAT, and to record
   in the run log that the reverse mirror ran without a fence. If it
   reports anything, deal with it first; do not reach for the mirror to
   "sort it out", because the mirror is what loses it.

3. **Carry the rows back** —
   `carry --from vaipakam-warm --to vaipakam-archive --mirror --manifest
   rollback-mirror.json`. This is the step the earlier wording skipped.
4. **Revert the binding PR**, which re-deploys `apps/indexer`,
   `apps/keeper` and `apps/agent` automatically through Workers Builds —
   the revert is a merge like any other (#2237).
5. **Redeploy `ops/offchain-data-warm` by hand**, since it is not built on
   merge, and only then run the gate:
   `check-live-d1-bindings.mjs --expect vaipakam-archive`.
6. **Reconcile, and keep reconciling** —
   `reconcile --from vaipakam-warm --to vaipakam-archive --since
   rollback-mirror.json` until **two consecutive** runs report nothing. It
   reads and reports; it writes nothing, so anything it finds is applied by
   a deliberate human step. The #2279 exception applies here too, in the
   same three situations and for the same reason — the direction of the
   move does not change which resolutions alter data.

   **Then weekly, for as long as warm is retained** (#2267 r36). The
   direction inverts but the reasoning does not: an invocation holding the
   former live `vaipakam-warm` binding can resume after both clean runs and
   commit a record that is then absent from the now-live archive
   indefinitely. Nothing revokes that handle either. Same owner, same log,
   same rule — two clean runs pause the search, they do not end it, and
   warm is now the retained database that has to keep being looked at.

Steps 1–3 before step 4 is not a preference. Reverting first is the same
defect as switching forward without a final carry, in the other direction,
and the data it loses is the data users created while warm was canonical.

**`apps/app` is conditional. `apps/www` is not a rollback step at all**
(#2243 r4, corrected r5).

- **`apps/app`** must be hand-deployed **only if** the reverted PR also moved
  `packages/contracts/src/deployments.json`. It imports
  `@vaipakam/contracts/deployments` in its own source, so those addresses are
  baked into its bundle. On the separate-PR flow it has no changed input, and
  a manual deploy is then an unnecessary production change carrying the
  nineteen-variable environment hazard below for nothing.
- **`apps/www` does NOT need waiting for, in either flow.** An earlier
  revision said it did. `apps/www/src` contains **no import from
  `@vaipakam/contracts`** — the package is a `package.json` dependency and
  nothing more — so its bundle cannot carry contract addresses and cannot be
  serving reverted ones. Cloudflare may still start a www build off the
  workspace dependency; blocking an urgent rollback on a build whose output
  is irrelevant is a cost with no corresponding risk.

**Both additions matter here specifically** (#2243 r1). This step named only
the three Workers and the backup, which is the pre-#2242 deployment set, and
the omissions bite harder on the way back than on the way out:

- **`apps/app` is the public surface an operator is least likely to remember**,
  because nothing on the automatic path reminds them. If the reverted PR also
  changed `packages/contracts/src/deployments.json` — which this plan explicitly
  permits in one PR — then leaving the app unredeployed leaves it serving the
  NEW contract addresses against a rolled-back database and rolled-back
  Workers. The rollback then looks complete and the public surface is the one
  thing still on the other side of it.
- **`apps/www` is never re-checked by anything downstream**, because Step 3's
  probes are D1-binding probes and `apps/www` has no D1 binding. That is worth
  knowing in general — but it is not a reason to gate a rollback on it, since
  its bundle carries nothing the rollback changes (see above).

Then confirm with the Step 3 probes **inverted**: the intended database is the
SOURCE, so `check-live-d1-bindings.mjs --expect vaipakam-archive` is the check,
comparing the pinned binding id. Running the forward probe as written would
pass a Worker still bound to the target, which is the failure this rollback is
trying to escape.

**The discriminator is the binding id, not accumulated rows**, and this
paragraph said otherwise until #2267 r29 while §3 said the opposite fifteen
hundred lines earlier. After the copy both databases hold the same rows, so
neither emptiness nor accumulation tells them apart in either direction. Where
a data-level tell is wanted once traffic resumes, write a **unique sentinel**
through a Worker's own surface and look for it by that exact value — a
sentinel discriminates because you chose it.

**After that it is not free.** New support tickets, thresholds, signed
offers, notification state and cursors exist only in the target. Reverting
the bindings alone points every Worker back at a source that is missing
them — which strands those rows exactly as going forward without a carry
would have stranded the originals.

**There IS now a repeatable path for it, and it is the forward sequence
run backwards.** `d1-carry-rows.mjs` carries in either direction between
the two pinned endpoints — that is what makes the reverse possible at all,
and it is a pinned PAIR rather than "the shared database at one end" — so
the reverse is:

```
node apps/indexer/scripts/d1-carry-rows.mjs carry \
  --from vaipakam-warm --to vaipakam-archive \
  --mirror --manifest rollback-mirror.json
```

with the same barrier around it. **The ordered sequence is the numbered one
in §4 above** — bring the rollback target's schema to parity, stop the
writers, observe still, **reconcile archive-only changes and resolve them**,
carry back, revert, hand-deploy the backup Worker, gate, reconcile — and
that list is the one to follow.

The reconcile BEFORE the reverse carry is step 2b, and it was missing from
this summary while the numbered list had it (#2267 r25). Skipping it is not
a slower path to the same place: the reverse mirror makes archive identical
to warm, so anything archive holds that warm does not is **deleted by the
carry**, unexamined. That is the one step in the rollback whose omission
destroys data rather than delaying it. This
passage exists to explain *why the tool can go this way at all*; it is not a
second procedure, and where the two ever appear to differ, §4's numbered
steps are the instruction.

**The binding check inverts too, and it needs telling.** During a rollback
the Workers are meant to be back on archive, so the gate is
`check-live-d1-bindings.mjs --expect vaipakam-archive` — without it the probe
expects whatever `apps/indexer/wrangler.jsonc` declares and would reject
every correctly rolled-back Worker. **And both tools live in this change**:
if the rollback is performed by reverting the commit that switched the
bindings, keep a checkout that still has `apps/indexer/scripts/` from it, or
the reverse switch has no serving-version check at all. An earlier
revision of this section said a reverse import "is not a one-liner either",
which was true of the export/import approach it described and is no longer
the only option.

What has NOT changed is that this is **a cutover, not an undo**, and it
costs what the forward one costs. The honest planning assumption stays:
once the Workers write to the new database, treat forward as the direction
and reach for this only with the same care.

## 5. Deleting the source

> **THIS CHECKLIST DOES NOT AUTHORISE THE DELETION, and saying that it did
> was this document contradicting itself on its one irreversible step**
> (#2267 r28).
>
> §3 states plainly that work suspended on something external can sit out
> every observation, that **how long that takes has never been measured**,
> and that this document will not invent a number for it. Two clean
> reconciliations are two readings — they say nothing arrived by the moment
> each one read. A straggler can commit after both. And because an UPDATE
> preserves the row count, the count re-validation below need not notice it
> either.
>
> Every box here is necessary. **None of them, and not all of them
> together, makes deleting the only remaining copy safe** — because what
> would make it safe is a bound on how long a suspended invocation can
> hold a handle, and no such bound has been measured or enforced.
>
> So the source is **RETAINED** at the end of this procedure. Deleting it
> is a separate decision, taken later, by a person who accepts a residual
> this document can describe but cannot close:
>
> - a **substantiated drain bound** — a measured or enforced limit on how
>   long an invocation admitted before the barrier can still write — would
>   close it, and does not exist today; or
> - a **durable write fence** on the source, after which no write can land
>   at all, which D1 does not offer; or
> - an explicit acceptance that a record written by a straggler after the
>   last read is lost, weighed against what those tables hold. They are
>   support tickets, alert configuration carrying Telegram chat ids,
>   signed offers and notification state — not data whose loss is
>   invisible.
>
> The cost of retaining it is one unused D1 database. The cost of the
> alternative is a record nobody can produce afterwards. **The boxes below
> are what make deletion possible to CONSIDER; they are not what make it
> correct.**

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
- [ ] **Step 6's reconciliation is CURRENT** — the two consecutive clean
      runs happened, every difference an earlier run reported was actually
      resolved, AND the periodic re-run has been kept up since (#2267
      r35). "Clean" here means the §4 step-6 sense: nothing reported, or
      nothing beyond the lines #2279 says can never stop reporting,
      each logged with the decision taken.

      **It is never "completed" while archive is retained**, and this box
      said so until now. Two clean runs describe two moments; a suspended
      invocation can commit after both. The re-run is what would find
      that, so a checklist item that treats the pair as final is a
      checklist that stops looking at the only place a late record can be.

      **Cadence and owner, since "periodically" is not a schedule:**
      weekly, by whoever holds the cutover runbook, from the switch until
      the predecessor is deleted. It is a read against both databases that
      writes to neither, so it costs minutes. Record each run's result in
      the run log — including the clean ones, because the value of the
      record is that a gap in it is visible.

      **This is the prerequisite that makes the rest of the list safe, and
      it was missing** (#2267 r15). The whole reconciliation procedure
      rests on archive being retained so a late write stays recoverable;
      satisfying every other box while a straggler is still pending — or
      while one arrives after the last read — and then deleting archive
      destroys the only copy of that record. A checklist that can be
      completed with rows outstanding is not a gate on anything.
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
# [unrun] — IRREVERSIBLE, and not authorised by this procedure. See the
# banner at the top of §5: the boxes above are necessary and not
# sufficient, and the residual they cannot close is named there.
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
