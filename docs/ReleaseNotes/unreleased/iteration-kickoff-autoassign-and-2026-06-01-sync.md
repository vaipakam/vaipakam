## Thread — Iteration kickoff sync (auto-iteration assignment + 2026-06-01 fold) (PR #<n>)

Closes #320 — the Iteration 4 kickoff-sync card auto-filed on Monday
2026-06-01 by `.github/workflows/iteration-kickoff-sync.yml`.

**What changed in the kickoff-sync automation.** The weekly Monday
00:05 UTC workflow used to file the kickoff-sync card and stop — the
card landed in Backlog with no Iteration or Sprint set, so it didn't
surface on the iteration-filtered board views the maintainer actually
reads on Monday morning. The ritual could then quietly miss a week.
A second step is now appended after the issue-bot step. It resolves
the current Iteration and Sprint by date (the iterations whose
`[startDate, startDate + duration)` window covers today's UTC date)
and assigns both fields on the newly-filed card via the
`updateProjectV2ItemFieldValue` GraphQL mutation. The Project ID and
the two iteration-field IDs are hard-coded as workflow env vars
because they're stable across reorganisations; if a field-set rotation
ever rotates them, the design comment in the workflow points at the
regeneration GraphQL query. Soft-fail when no iteration covers today
(a `::warning::` line surfaces the gap; the card still lands and the
maintainer can fix it manually in the Projects UI) — preferred over
hard-fail because the workflow's load-bearing job is filing the card,
not the iteration UX.

**Rules folded into the handbook for Iteration 4.** The first proper
kickoff sync since the discipline was set up. One memory note made
the cut: the pre-live project status (no production deployment of
the Diamond + executor + Worker stack on any chain) becomes a new
top-level §0 "Operating context" in
[`docs/internal/ProjectProcedures.md`](../../internal/ProjectProcedures.md).
That section explains why ABI-breaking changes don't need transition
shims, why atomic-rollout maneuvers (Safe MultiSend / multicall
deploy / governance handover) are forward-looking scaffolding rather
than per-PR gates today, and which disciplines stay unchanged
regardless (sanctions wiring, code-consistency co-update, per-PR
release notes and FunctionalSpecs updates). The second memory note
reviewed — auto-merging clean PRs without pausing for explicit user
approval — is agent-specific personal discipline and stays in memory
only; folding it into the handbook would be over-prescriptive for
contributors who aren't operating the agent. The §5.2 worked example
was also reframed from "current" to "historical" since the Iteration 2
cycle it referenced has long since ended.

**Sentinel + memory housekeeping.** The
`.last-iteration-sync` sentinel file in the agent-memory directory
is touched as part of this thread to record the close timestamp, per
§5.7. The stale "Sprint = 7d Mon-aligned" note in agent memory is
corrected to the current 14d cadence (the board's Sprint field has
been on 14-day cycles since Sprint 3 — the §5.1 field table already
reflected this, but the cross-reference memory note hadn't been
freshened).

**Effect on next Monday's run.** The next scheduled fire is
2026-06-08 00:05 UTC — the Iteration 5 kickoff. With this PR landed,
the auto-filed card will arrive in Backlog already tagged
`Iteration 5` + the prevailing Sprint, so it appears on the
iteration-filtered views the moment the maintainer opens the board.
The manual `gh api graphql` fix-up applied to #320 mid-week is the
one-time backfill — it doesn't need to be repeated.

**Investigation finding — iterations are NOT auto-extended by
GitHub.** A natural question while building this — "what if no
iteration covers today, can the workflow just create one?" — was
investigated against three angles: (1) public GraphQL schema
introspection (the `ProjectV2Iteration` input has no `id` field and
the only mutation is the destructive `updateProjectV2Field`); (2)
empirical test against the live API (created a throwaway iteration
field, assigned a card, did a no-op replace passing back identical
iterations — card was orphaned because IDs were regenerated); (3)
browser DevTools capture of the UI's "+ Add iteration" Save click
(the call bypasses GraphQL entirely and hits an internal "memex"
REST endpoint with ID-keyed merge semantics that the public API
genuinely doesn't expose). Community discussion
[#157957](https://github.com/orgs/community/discussions/157957)
documents the same gap and reports the reporter resorted to
Puppeteer to drive the UI.

The conclusion: programmatic iteration creation is left out of the
workflow. The maintainer keeps ~6 future iterations seeded on each
iteration field via the Projects UI (`+ Add iteration` button); the
workflow's maintainer-ping fallback (a `> [!WARNING]` callout on the
just-filed card) is the loud reminder when the maintainer slips a
runway top-up. The seeding-cadence rule is documented in
`docs/internal/ProjectProcedures.md` §5.7.

No code paths in `contracts/`, `apps/`, or `packages/` are touched
by this thread.
