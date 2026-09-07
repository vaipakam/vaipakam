# Vaipakam Project Procedures

This is the human-readable operator handbook — how work moves from idea
to merged on main and beyond. The `CLAUDE.md` at the repo root is the
AI-instruction-shaped twin of this document; the two stay deliberately
complementary so each reader gets the shape that fits.

If a step here disagrees with `CLAUDE.md`, this file wins for human
operators; the AI follows CLAUDE.md and surfaces the divergence in the
next interaction.

---

## 0. Operating context — the platform is pre-live

Vaipakam is **pre-live on every chain.** No production (or even
testnet-operator-funded) deployment of the Diamond + executor + Worker
stack is currently holding user funds or backing external integrations.
Every PR today lands toward one coordinated mainnet cutover; nothing on
chain is actively being served.

That single fact reshapes how PRs are scoped:

- **ABI-breaking changes are cheap.** Renaming a function, dropping a
  struct field, changing an event signature — none of these need
  transition shims, deprecation overloads, or `_v2`-suffixed
  duplicates. If an in-tree consumer (`apps/app`, the Workers under
  `apps/{keeper,indexer,agent}`) reads the symbol, co-update it in
  the **same PR** — the monorepo's `pnpm` typecheck catches the
  drift at merge time. The sibling `vaipakam-keeper-bot` repo is a
  separate concern: same-PR co-update is structurally impossible
  across repos, so it's ABI-sync'd via a **paired follow-up commit**
  in the sibling repo using
  [`contracts/script/exportAbis.sh`](../../contracts/script/exportAbis.sh)
  (per the "Keeper-bot ABI sync" rule in `CLAUDE.md`).
  The constraint, in both cases, is source-tree consistency at merge
  time, not deploy-window race protection.
- **Atomic-rollout maneuvers (UUPS upgrade + diamondCut in one tx via
  Safe MultiSend, the multi-call deploy script
  [`contracts/script/multicallDeploy.s.sol`](../../contracts/script/multicallDeploy.s.sol),
  the governance handover ceremony) are forward-looking scaffolding.**
  They exist so they're ready for mainnet, but they are NOT per-PR
  gates today. Block A/B/C of any feature can land as separate PRs
  without rehearsing the atomic-rotation maneuver on a live chain —
  there's no live chain to rotate.
- **Testnet rehearsals stay deployer/admin-owned.** Base-Sepolia,
  Sepolia, and the other testnets intentionally skip the multisig
  handover so flow tests keep working on EOA keys. The handover
  ceremony runs once, at mainnet cutover.
- **Pre-live storage layout is repackable.** The `EC-006` card on
  the board tracks a pre-audit storage-layout repack opportunity
  that becomes impossible the moment user funds occupy any slot.

What stays unchanged even pre-live:

- **Sanctions oracle wiring** — `ProfileFacet.setSanctionsOracle(...)`
  is still wired and tested. It's a mainnet-deploy step, not a
  pre-live PR gate, but the contract surface stays present.
- **Code-consistency discipline** — co-update consumers in the same
  PR for type-system consistency, not for deploy-race protection.
  Code that compiles after merge is the goal.
- **Functional Specs + release notes per behaviour-changing PR** —
  pre-live doesn't relax the documentation discipline; in fact it
  makes the doc set authoritative since there's no production code
  to read instead.

The flip point — when this section retires and atomic-rotation
maneuvers become per-PR gates — is the mainnet cutover. The
[`mainnet-cutover`](#56-milestones--pinned-issues) milestone tracks
the work that flips it.

---

## 1. Repository topology

Two repos work together:

| Repo | Visibility | Purpose |
|---|---|---|
| `vaipakam/vaipakam` | **public** | Monorepo. Solidity contracts, connected app (apps/app), Workers (apps/{keeper,indexer,agent,www}), shared packages, docs. |
| `vaipakam/vaipakam-keeper-bot` | **public** (flipped 2026-05-20) | Reference keeper bot — sibling of the monorepo, MIT-licensed, single-author. ABI JSONs sync'd from monorepo via `contracts/script/exportAbis.sh`. |

Both repos enforce near-identical `Protect main` rulesets — same rule
types (deletion / non-fast-forward / linear / PR-with-thread / signed),
different `required_status_checks` contexts (the monorepo gates on
`detect-changes` + `contracts-fast` + `workspaces` for 8 gates total;
the keeper-bot gates on `Typecheck` + `ABI shape sanity` for 6).
See §7 for the gate-by-gate detail.

---

## 2. Git procedures

### 2.1 Branch naming

| Prefix | Use | Example |
|---|---|---|
| `feat/issue-<N>-<slug>` | New feature / behaviour change | `feat/issue-72-deploy-integration-test` |
| `fix/issue-<N>-<slug>` | Bug fix tied to an existing Issue | `fix/issue-69-deploy-verify-facetcount` |
| `docs/<slug>` | Docs-only change (no code) | `docs/project-procedures` |
| `chore/<slug>` | Tooling / dependency / cleanup | `chore/bump-foundry` |
| `release/v<version>` | Release-train branch (triggers `mainnet-gate.yml`) | `release/v0.1.0` |

### 2.2 Commit message format

```
<type>(#<issue>): <one-line summary, lowercase, no trailing period>

<body — wrap at ~72 chars, explain WHY not WHAT>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `infra`.

Always include the `Co-Authored-By:` trailer when an AI assistant
contributed materially to the commit. Authorship stays
`Raja4Shekar <raja4shekar@gmail.com>`.

### 2.3 Signed commits

`Protect main` requires every commit landing on `main` to carry a valid
signature. Set this up once per machine:

- **Generate an SSH signing key** (ed25519) at `~/.ssh/<name>`. No
  passphrase if the key is used by an automation context (CI / AI
  session) that can't prompt.
- **Configure git globally:**
  ```
  git config --global gpg.format ssh
  git config --global user.signingkey ~/.ssh/<name>.pub
  git config --global commit.gpgsign true
  git config --global tag.gpgsign true
  ```
- **Upload the public key to GitHub** at
  https://github.com/settings/ssh/new — **Key type: "Signing Key"**
  (NOT "Authentication Key" — default is auth; you must change it).
- **Verify**: `git commit --allow-empty -m "test" && git cat-file -p HEAD`
  should show a `gpgsig` block. Push, then `gh api repos/.../commits/<sha>
  --jq .commit.verification` should return `{"verified":true,"reason":"valid"}`.

### 2.4 Don't delete merged branches

Convention: never use `--delete-branch` on merge. Branches stay in place
for troubleshooting. Project owner sweep-deletes stale branches at the
final stage.

### 2.5 Shared worktree, outages, and staging discipline

- **Concurrent local sessions share ONE worktree.** Never `checkout` or
  `stash` to "stand down" for another session — touch nothing. Do not
  infer who owns a commit from the shared reflog or from the author
  field (every session writes the same reflog, and §2.2/§12.1 require
  every commit to carry the `Raja4Shekar` identity regardless of which
  session made it). Coordinate explicitly instead: agree with the
  owner or the other session's operator who holds a branch before
  touching it, read `git log origin/<branch>` for what has actually
  landed, and treat a branch as yours only when you know you pushed its
  tip. (How an AI session enumerates its peers is harness plumbing and
  stays in agent state, per §11.)
- **Verify the branch before editing after any interruption** — a power
  outage, a session resume, or a "files modified by user" reminder:
  `git branch --show-current` first, then `git status --porcelain`. On a
  stacked branch pair, do it before EVERY edit; review-round edits have
  repeatedly landed on the wrong branch.
- **`git fetch` and check ahead/behind before every push; never
  force-push.** A shared worktree means the remote may have moved.
- **Stage with `git add <explicit paths>`, never `-A`.** The shared
  worktree accumulates untracked directories that belong to other
  sessions or scratch work.

---

## 3. Pull request workflow

### 3.1 Opening a PR — checklist

```
☐ Branch follows §2.1 naming
☐ Commits follow §2.2 format + are signed (§2.3)
☐ Release-notes fragment at docs/ReleaseNotes/unreleased/<task-id>-<slug>.md
   (only if the PR changes behaviour — skip for pure docs / chore / CI-config PRs)
☐ FunctionalSpecs updated if behaviour changed (see §6)
☐ Locally green:
   `cd contracts && nice -n -10 ionice -c 2 -n 0 forge build && bash script/predeploy-check.sh`
   then (from repo root) per-workspace typechecks matching CI —
   `pnpm --filter @vaipakam/keeper typecheck && pnpm --filter @vaipakam/indexer typecheck && pnpm --filter @vaipakam/agent typecheck && pnpm --filter @vaipakam/app typecheck && pnpm --filter @vaipakam/www typecheck`
   (don't use `pnpm -r typecheck` — the fan-out silently passes if a
   workspace loses its `typecheck` script; CI runs one step per
   workspace for exactly that reason)
☐ gh pr create with body covering: What, Why, Verification, Closes #N
☐ Card on @vaipakam-labs moved to "In review" (§5.3 — happens after the PR exists)
☐ Codex review request: `@codex review <mode>` (§3.2 — mode ∈ `normal` / `adversarial` / `full` / `full security-critical`)
☐ PR monitoring armed (§3.3): the 15-min heartbeat from a Claude session, or the workspace's own poller per `AGENTS.md`
```

### 3.2 Codex review — canonical triggers

`AGENTS.md` at the repo root defines the canonical Codex command surface.
This handbook mirrors it; if the two diverge, AGENTS.md wins.

**Trigger string shape:**

```
@codex review <mode> [<profile>]
```

- `<mode>` is REQUIRED and load-bearing — one of `normal`,
  `adversarial`, `full`, `full security-critical`. This is what
  Codex definitely parses; it drives review depth.
- `<profile>` is OPTIONAL project-specific scoping — one of the
  profile names defined in AGENTS.md (`handbook`,
  `crosschain-deploy`, `design-doc`). Their literal effect on
  Codex's review prompt is suspected but unverified (see §3.2.1
  below). Always include the explicit `<mode>` even if a profile's
  definition implies one — that way Codex's review depth is
  driven by the mode regardless of how it handles the profile
  keyword.

**Canonical modes — when to use:**

| Mode | When to use |
|---|---|
| `normal` | Routine implementation review — confirms PR matches issue / card / acceptance criteria; checks correctness, integration, missing tests / docs / config. |
| `adversarial` | Failure-mode + abuse-case sweep — malicious inputs, auth bypass, replay, race conditions, fund-loss paths, stuck-state scenarios. |
| `full` | Both `normal` and `adversarial`. **Default for any card in "In review" status unless the work is clearly low-risk.** |
| `full security-critical` | High-risk changes — contracts that move funds or change accounting; liquidation / settlement / vault / treasury / oracle / cross-chain logic; auth / admin / keeper / worker / API / privacy / compliance / secret-management / irreversible-migration changes. |
| (no trigger) | Skip Codex only on truly trivial changes — typo fix, comment-only edit. Rare. |

**Caption convention (permanent):** when a trigger uses a profile
suffix, include a short caption directly below it so a reader new to
the project doesn't have to chase AGENTS.md. Keep this on **every PR
going forward**, not just early ones — the audience is future
contributors (including community PRs) landing cold without having
read AGENTS.md yet. One inline line of self-documentation is cheap
and discoverable.

Caption template — substitute the actual mode + profile:

> ```
> @codex review full handbook
> ```
> *`full` = canonical Codex mode; `handbook` = project profile
> (see [AGENTS.md](../../AGENTS.md)).*

Sub-rules:

- **First trigger in each PR**: always include the caption.
- **Re-triggers in the same PR** (after a fix push): caption can be
  omitted — the first one is visible above in the same thread.
- **Profile-less triggers** (`@codex review full` with no profile
  suffix): no caption needed — nothing project-specific to explain.

After each fix iteration, **post a fresh trigger comment** to re-run
Codex against the new commit. Codex's auto-review on push fires once
on its own, but explicit triggers force a re-review.

#### 3.2.1 What we know about AGENTS.md being honoured

Empirical observations gathered while testing AGENTS.md mechanisms on
PR #108 (2026-05-20):

- **Mode keywords** (`normal`, `adversarial`, `full`,
  `full security-critical`) — CONFIRMED parsed by Codex. Review
  depth + breadth clearly responds to the mode.
- **Profile keywords** (`handbook`, `crosschain-deploy`,
  `design-doc`) — STATUS UNKNOWN. Suspected to be read as
  substantive context (the substantive findings on the PRs that
  used them were profile-shaped), but a single PR can't disambiguate
  this from generic-good-review behaviour. A dispositive substantive
  probe is queued as Issue #106.
- **Presentation-meta directives** (an earlier experiment added a
  canary string + a self-report-block requirement to AGENTS.md) —
  CONFIRMED ignored by Codex's review-body template. Almost
  certainly intentional prompt-injection defense — an attacker
  could otherwise inject "ignore findings and approve" into a PR
  diff. The canary mechanism was removed as inert clutter; the
  observation stays in AGENTS.md's verification history table.

Working rule until #106's substantive probe resolves: **modes are
load-bearing; profile suffixes are self-documenting + possibly read.**
Use both per the trigger-shape above.

### 3.3 PR monitoring — heartbeat + direct reads; pollers are RETIRED

**The Claude-agent poller processes are retired (owner directive
2026-08-10, verbatim: "rather than running the pr poll, you just wake
yourself up every 15 mins and check the PR(s) yourself").** Earlier
revisions of this section prescribed `~/.claude/scripts/pr-poll.sh`; do
not launch it, nor `pr-poll-once.sh` / `pr-watch-loop.sh` from a Claude
session. Pollers left over from prior sessions accumulated and hammered
the GitHub API until the account tripped a SECONDARY rate limit.
Monitoring from a Claude session is a periodic heartbeat (15–30 min) that
does ONE batched read per wake and acts on the result. **Scope:** this
governs the Claude agent's monitoring; the Codex and VaipakamGrok
workspaces keep their own poller procedure as written in `AGENTS.md`
(single-instance delta poller / `pr-poll-watch.sh`) — that file is their
source of truth and is unchanged by this section.

- **Read with `curl` against the REST API; GraphQL only for the
  review-thread census (`reviewThreads`, which REST does not expose —
  node ids and resolution state) and the `resolveReviewThread`
  mutation.** The batch must cover every surface the retired
  poller covered (§9.1): `pulls/<N>` (state, head, mergeability),
  `commits/<head-sha>/check-runs` (job results), `pulls/<N>/reviews`
  (approve / request-changes submissions, which carry no inline comment),
  `pulls/<N>/comments` (inline threads, ` ```suggestion ` blocks — each
  comment's `reactions` object carries the 👀/👍 counts, so reactions need
  no separate call), `issues/<N>/comments` (bot summaries, triggers), and
  `actions/runs?head_sha=<head-sha>` when a workflow-level status matters.
  **Every one of those collection reads is PAGINATED** — follow the REST
  `Link: <…>; rel="next"` cursor (or `gh api --paginate`) until it is
  absent, for reviews, review comments, issue comments, check-runs and
  workflow runs alike; a bare first-page read of a long-running PR drops
  the newest findings and lets the heartbeat conclude nothing remains —
  the same trap §3.3 already closes for GraphQL threads. Never read
  `gh pr view --json comments` — it silently misses inline suggestion
  blocks and check-runs.
- **A secondary rate limit does not show in `/rate_limit`** — that endpoint
  keeps reporting 5000/5000 while reads return a VALID-JSON
  `{"message":"API rate limit exceeded ..."}` body. Detect that body shape
  before parsing; if limited, say so in one line and do API-free work until
  the next wake. Never poll repeatedly inside one wake.
- **Select unanswered feedback by STATE, never by time.** Unanswered
  means any of: an inline thread whose LATEST comment is not ours (a
  reviewer follow-up after our reply re-opens it), or a review submission
  (`pulls/<N>/reviews`) with `REQUEST_CHANGES` or a non-empty `COMMENTED`
  body that has no inline thread and no reply from us. "No reply from the
  author at all" is not the test — a thread we answered once can still
  need action. A `created_at` window silently skips findings that were
  posted before the window and never answered. A "no major issues" summary comment is not
  the verdict — the inline threads are.
- **Resolve every answered thread before merging — paginated.** Branch
  protection requires all review threads resolved, and Codex's inline
  threads stay open after the finding is addressed. Resolve them with the
  `resolveReviewThread` GraphQL mutation, enumerating threads with
  `reviewThreads(first:100, after:<cursor>)` until `hasNextPage` is false —
  a single `first:100` page once reported `unresolved=0` over 33 hidden
  threads. Re-census after resolving.
- **A stacked PR (base = another feature branch) does not run the
  main-targeted core suite** — `contracts-fast`, Slither and the other
  workflows whose `pull_request` trigger is filtered to `main` are simply
  absent, which looks like "not required". Workflows with an unfiltered
  `pull_request` trigger DO still run (the path-filtered
  `app-e2e.yml`, the always-on docs-drift check), so a few green checks on
  a stacked PR are not evidence the gate ran. Verify with
  `gh pr checks <PR>` or `gh run list --commit <head-sha>` — `--branch`
  mixes runs from earlier pushes and retargets, so it can show an old
  main-targeted suite the current head never ran; retarget the base via
  the API and push to get the real suite.

### 3.4 Iterating on Codex findings — discipline

For every finding:

1. **Confirm it's real.** Some Codex findings are speculative; read the
   actual code first.
2. **Weigh alternatives.** If the finding has multiple valid fixes,
   surface them in the PR thread before coding.
3. **Check design / plan alignment.** If the finding contradicts a
   prior locked decision, flag it rather than silently overriding.
4. **Record the chosen approach** in the PR thread (one-line comment).
5. **Code the fix.**
6. **Build + regression locally.** Don't push a fix that hasn't
   compiled.
7. **Push + reply.** Reply to the inline thread with the commit hash
   that addressed it. Move card In review → In progress at step 1,
   back to In review at step 7.

**Convergence discipline learned in the long review loops (#1995, #2031,
#2042, #2051):**

- **Fix ALL coding findings; leniency is for docs-only PRs only.** A
  coding PR iterates until a round returns zero P1/P2. Escalate to the
  owner rather than continuing past **ten** rounds after the last
  substantive surface change — the backstop `CLAUDE.md` sets; an earlier
  revision here said twelve, which came from a stale agent note.
- **Findings are verified; remedies are only suggestions.** Verify a
  finding against the code before accepting it, then design the fix
  yourself and prove it with a discriminating test — a reviewer's
  proposed remedy is an input, not an instruction. On the THIRD
  recurrence of a finding class, restructure rather than patch.
- **Arrest a recurring finding at its SOURCE, not at each path.** When a
  round finds the same defect class in a new place, stop patching
  instances on the second occurrence: close the cause where it
  originates and predict its siblings in the same push.
- **Re-slice when review surfaces a coupling.** If a loop keeps hitting
  the same root because a slice was cut across a real safety coupling,
  stop patching across the wrong cut, re-slice, and surface it to the
  owner.
- **Never write "does NOT close #N" in a commit or PR body.** GitHub's
  linker matches the substring and closes the issue anyway. Use
  `Refs #N`.

### 3.5 Merge — squash-merge, never delete

```bash
gh pr merge --squash <pr-num>
# If --admin needed for unsigned-commit-chain bypass (rare, AI-session
# only — see §2.3 for the permanent fix):
gh pr merge --squash --admin <pr-num>
```

After merge:
- Run the post-merge sweep (§4).

---

## 4. Post-merge sweep — definition-of-done

Every merge to `main` triggers THREE updates in the SAME session:

```
☐ Release-notes fragment in unreleased/ — folded eventually via
  `bash docs/ReleaseNotes/assemble.sh [YYYY-MM-DD]` once a day's
  PRs are settled. Don't batch across multiple days.
☐ docs/ToDo.md — tick the corresponding ET-### entry if one exists.
☐ Project card moves to "Done" — automatic via `Closes #<N>` in PR body.
   If a card has Status mis-set, manually fix.
```

If the merge changed behaviour (contracts/src/* or apps/*), also:

```
☐ FunctionalSpecs domain doc updated (§6).
```

---

## 5. Project board (`@vaipakam-labs`) discipline

### 5.1 Field set

| Field | Type | Use |
|---|---|---|
| **Status** | single-select | Backlog → Ready → In progress → In review → Done |
| **Iteration** | iteration (1-week cycles) | Tactical timing — "what week was this worked on" |
| **Sprint** | iteration (2-week cycles from Sprint 3+) | Thematic grouping — "which sprint goal does this card serve" |
| **Module** | single-select | `contracts` / `apps/{app,keeper,indexer,agent,www}` / `docs` / `ops` / `vaipakam-keeper-bot` |
| **Priority** | single-select | P0 (drop everything) / P1 (current sprint) / P2 (backlog) |
| **Size** | single-select | XS (<1h) / S (~half-day) / M (~1d) / L (~2-3d) / XL (>3d) |
| **Estimate** | number | Skip unless explicitly meaningful. Size carries enough info for solo work. |

### 5.2 Sprint goals — encoded in iteration titles

Themes live in the iteration title, NOT in a separate field. Example
(from the Iteration 2 / Sprint 2 cycle, kept as the canonical worked
example):

- `Iteration 2 — Harden the deploy gate` (week of 2026-05-18)
- `Sprint 2 — Harden the deploy gate` (the transitional 7-day sprint
  that preceded the 14-day cadence — see §5.1)
- `Sprint 3` (no theme — left untitled when sprint planning didn't
  surface one)

To set a goal, rename the iteration. Cleanest: do it in the GitHub web
UI (preserves iteration IDs). The API works but rebuilds the iteration
list (new IDs); you'd then need to re-attach cards via mutation.

### 5.3 When to set each field — checklist for picking up a card

```
☐ Status → "In progress"
☐ Iteration → current iteration (whose date range covers today)
☐ Sprint → current sprint (whose date range covers today)
☐ Module → from the affected directory tree (only if unset)
☐ Priority → propose based on impact; user confirms (only if unset)
☐ Size → XS/S/M/L/XL (only if unset)
```

When the PR opens for the card:
```
☐ Status → "In review"
```

When PR merges:
```
☐ Status → "Done" (automatic via `Closes #N`; only manual fix if auto-move missed)
```

### 5.4 Multi-iteration / multi-sprint cards

For work spanning >1 iteration: set Iteration AND Sprint to the FIRST
one the card was active in. **Don't rewrite on close** — preserves
"when did this work START" provenance. For cards spanning many
iterations, add a one-line note in the card body rather than
rewriting the field.

### 5.5 Don't backfill the past

When introducing a new convention (like field discipline), backfill
cards from the CURRENT iteration only. Don't reach back into completed
iterations unless that data is needed for retrospective.

### 5.6 Milestones + Pinned Issues

The project board tracks fine-grained card state. Two GitHub-native
surfaces sit ABOVE the board:

- **Milestones** — strategic-cadence groupings. Each open Issue + PR
  is assigned to a milestone; closed milestones show progress
  against the named release tranche.
- **Pinned Issues** — at most 3 per repo, visible at the top of the
  Issues tab regardless of recency. The "what every visitor reads
  first" layer.

**Milestones in use:**

| Milestone | Focus |
|---|---|
| `audit-prep` | Pre-audit hardening — branch protection, signed commits, CI gates, ADRs, glossary, SECURITY.md, CodeQL + Slither static analysis, Cloudflare posture, dependency triage. |
| `audit-1` | Third-party audit engagement window. |
| `audit-1-fixes` | Findings remediation from audit-1. |
| `mainnet-cutover` | Testnet → mainnet rollout per the cutover runbook. |
| `post-mainnet-v1.1` | Deferred items + feature iteration. |

Adding a new milestone is a Settings UI action (Issues tab →
Milestones → New milestone) — name + optional date + one-paragraph
description.

**Pinned Issues in use** — three permanent slots, content maintained
as the project evolves:

1. **"Read this first: audit context"** — orientation for auditors,
   ecosystem integrators, contributors. Points at the canonical
   whitepaper, ADRs, FunctionalSpecs, ProjectProcedures, SECURITY.md,
   audits/. Updated per major milestone close.
2. **"How to contribute"** — on-ramp for new contributors. Points at
   CONTRIBUTING.md + good-first-issue label + the project board
   filtered for `help wanted`. Stable; updates when the contribution
   process changes.
3. **"Vaipakam roadmap"** — milestones table + the freeze policy
   during audit-prep + audit-1. Updates when a milestone
   opens / closes.

**Discipline — what goes where:**

| Concept | Lives on |
|---|---|
| Day-to-day work | Project board (`@vaipakam-labs`) |
| Strategic release cadence | Milestones |
| First-look discovery surface | Pinned Issues |
| Release narrative | `docs/ReleaseNotes/` |
| Design exploration | `docs/DesignsAndPlans/` |

Every open Issue has BOTH a Status (board) AND a Milestone — the two
are orthogonal axes. Status says "where is this in flight"; milestone
says "when in the release cadence".

Sibling `vaipakam-keeper-bot` uses the same pattern with bot-scoped
milestones (no `audit-1` — the keeper bot doesn't ship to mainnet on
its own cadence; its release cadence follows the monorepo's ABI-sync
events).

### 5.7 Iteration kickoff sync — fold rules into the handbook

Discipline rules learned mid-iteration get saved to agent memory under
`~/.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/` so
the agent doesn't lose them across sessions. That memory is invisible
to operators, contributors, and auditors who only read this handbook.
The **iteration kickoff sync** closes the gap by folding agent-memory
rules into `docs/internal/ProjectProcedures.md` (this file) every
iteration boundary.

**Cadence — iteration begin, not end.** The ritual happens Monday
mornings UTC, the moment Iteration N+1 starts. Three reasons:

- Monday morning is already a planning ritual (picking cards from
  Backlog, setting field values per §5.3) — the sync attaches to
  something that already happens.
- The next iteration's work runs against an UPDATED handbook —
  rules learned in Iteration N land in this file before Iteration
  N+1 PRs begin, so the new iteration's PRs reference canonical
  wording.
- Iteration-end is the riskiest moment to add a ritual — work is
  being landed under deadline pressure; new ceremony there gets
  skipped.

**Automation — the card is auto-filed AND auto-iteration-assigned.**
[`.github/workflows/iteration-kickoff-sync.yml`](../../.github/workflows/iteration-kickoff-sync.yml)
fires on cron `5 0 * * MON` (Mondays 00:05 UTC) and:

1. Files the "Iteration kickoff sync — <date>" card via
   `imjohnbo/issue-bot`. Auto-add-to-project routes it to the
   Backlog with Status = Backlog and no iteration set.
2. Then in a second step, queries the Project v2 Iteration + Sprint
   field configurations, picks the iterations whose date ranges
   cover today (UTC), and assigns BOTH fields on the newly-filed
   card via the `updateProjectV2ItemFieldValue` GraphQL mutation.

The second step is what makes the ritual actually *land* — the card
surfaces on iteration-filtered board views (the surface the
maintainer reads on Monday morning) the moment Iteration N+1 begins,
instead of sitting iteration-unassigned in Backlog until someone
notices it.

If a field has no iteration covering today (last iteration ended,
next not yet seeded by the maintainer in the Projects UI), that one
field is skipped AND the workflow drops a maintainer-ping comment on
the just-created kickoff issue itself — `> [!WARNING]` callout naming
the missing cadence and linking to the Projects iteration settings.
The card still lands; only the missing cadence is left unassigned
until the maintainer seeds it.

**Maintainer-side seeding cadence — keep ~6 future iterations
seeded on each iteration field.** Iteration fields in GitHub
Projects v2 are NOT auto-extended (an earlier version of this
section claimed they were — incorrect). The list grows only when
the maintainer manually clicks "+ Add iteration" in the Projects
settings UI:

- https://github.com/users/vaipakam/projects/1/settings → Iteration
- https://github.com/users/vaipakam/projects/1/settings → Sprint

The "+ Add iteration" button hits an internal "memex" REST endpoint
that supports ID-keyed merge (existing iterations preserve their
IDs, new ones get fresh ones, card assignments stay intact). That
endpoint is **NOT** available via the public GraphQL API — the public
`updateProjectV2Field` mutation does a destructive replace that
orphans every card's iteration field value. So the seeding step is
maintainer-only and stays in the UI. Per-cadence runway target:

| Cadence | Duration | Reseed when runway drops to | Add at a time |
|---|---|---|---|
| Iteration | 7d | 2-3 weeks ahead | 6 (≈6 weeks coverage) |
| Sprint    | 14d | 1-2 sprints ahead | 4 (≈8 weeks coverage) |

With those runway targets, the workflow's maintainer-ping fallback
should effectively never fire — it exists as the loud reminder for
when the maintainer slips a runway top-up.

Why the cron itself doesn't try to auto-extend: it could call the
public `updateProjectV2Field` with `[...existing, new]`, but that
mutation regenerates every iteration ID and orphans every card's
assignment on the field. We tested this empirically against the live
API (creating a throwaway field, assigning a card, doing the no-op
replace, observing the card go iteration-unassigned). The
orphan-and-restore dance — snapshot every card's assignment, replace,
remap by content, re-assign — is technically possible but too risky
for an unattended Monday-morning cron. Manual seeding is the safe
shape.

The maintainer picks it up first thing Monday, performs the sync,
lands a docs PR, and closes the card. If a card from the previous
Monday is still open, the new card co-exists as Backlog (the
maintainer closes the older one as duplicate when reviewing).

**The ritual itself:**

1. List memory files modified since the previous iteration's sync —
   on the agent's machine that's
   `find ~/.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory -newer ~/.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/.last-iteration-sync -name '*.md'`
   (absolute paths for both the search root and the reference
   sentinel — `find` resolves `-newer` relative to its own cwd, so a
   relative sentinel breaks the moment the operator runs the command
   from anywhere other than the memory dir).
2. For each modified note, classify:
   - **Project rule** (operator / contributor / auditor needs it) →
     fold into the appropriate section of this file.
   - **Agent-specific personal discipline** (e.g. "I tend to forget
     X") → stays in memory only.
   - **Already covered here** → no action.
3. Land the sync as a single docs PR titled
   `docs(handbook): iteration close-out sync — fold rules from
   <date> through <date>`.
4. Touch sentinel
   `~/.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/.last-iteration-sync`
   to record the close timestamp.
5. Close the auto-filed card referencing the merged PR.

**Steady state.** Most iterations will fold 0-2 rules; some will
fold none. Both outcomes are fine — close the card with a one-line
"no rules to fold this iteration" note. The discipline's value is
the periodic FORCING FUNCTION, not the volume.

---

## 6. Release notes + FunctionalSpecs

### 6.1 Per-PR release-notes fragment

**Every behaviour-changing PR carries** a fragment in its diff at
`docs/ReleaseNotes/unreleased/<task-id>-<slug>.md` — plain English,
no code, describing what changed and why.

Template at `docs/ReleaseNotes/unreleased/_TEMPLATE.md`.

### 6.2 Folding into dated files

After a day's PRs merge:

```bash
bash docs/ReleaseNotes/assemble.sh           # today UTC
bash docs/ReleaseNotes/assemble.sh 2026-05-20  # explicit date
```

The script concatenates the fragments **belonging to that UTC day** into
`docs/ReleaseNotes/ReleaseNotes-<date>.md`, removes the ones it consumed,
and prints the commit steps. **Review the assembled file — add an intro
paragraph by hand if the day's threads form a coherent arc** — then
commit.

**A run does not clear the whole backlog.** A fragment belongs to the UTC
day its PR merged, which is the trap this enforces: at `+05:30` every
merge between 18:30 and midnight UTC shows a local date one day ahead, and
assembling "today" locally has misfiled fragments twice. So each run takes
only its own day, names the fragments it held back and the day each
belongs to, and leaves them for their own run. Clear a multi-day backlog
by running the script once per day.

Behaviours to know:

- **Python 3.10+ is required.** The assembler itself is
  [`assemble.py`](../ReleaseNotes/assemble.py); `assemble.sh` is a thin entry
  point that finds an interpreter and hands the arguments straight through
  (#1877). It asks each of `python3` and `python` its version rather than
  trusting the name — a `python` that is still Python 2 is refused rather than
  run into a syntax error — and if neither is 3.10 or newer it says so and
  stops. **Bash 4 is no longer needed**: the entry point uses no Bash-4
  feature — no `mapfile`, no associative arrays — so stock macOS Bash 3.2 runs
  it and there is no `brew install bash` step. (The suite,
  `assemble.test.sh`, does still want Bash 4 — that is a contributor
  requirement, not an operator one.)
- `--allow-mixed-dates` takes every pending fragment regardless of day,
  for when folding them together is deliberate.
- A fragment that has never been committed is always taken — it was
  written in the PR doing the assembling, so it has no day of its own.
- A **shallow clone** is fine as long as it did not truncate the answer.
  A fragment added after the shallow boundary has a genuine add-commit
  and is dated normally; only one whose add-commit resolves to the
  boundary itself is **refused, by name**, since that date belongs to the
  boundary rather than to the fragment. Run `git fetch --unshallow` and
  retry when that happens. CI checkouts are routinely shallow — refusing
  them wholesale would have meant reaching for `--allow-mixed-dates`
  every time, which turns the dating off entirely. A repository whose
  history cannot be read at all still stops the run outright.
- A **committed** rename is followed back to where the fragment was
  written — provided the content did not change much in the same commit.
  Rename detection is by similarity, so a rename committed together with a
  substantial rewrite reads as an unrelated add and delete and dates to the
  rewrite; commit the rename on its own first when the original day
  matters. An **uncommitted** one is recoverable only when
  git can pair the two names: use `git mv` rather than a plain `mv`, and
  note that even then pairing is similarity *detection*, so a rename plus
  a substantial rewrite reads as an unrelated add and delete. The run says
  so rather than guessing; commit the rename first if the day matters.
- A **reused filename** is dated as new. History is keyed by path, so an
  assembled-and-deleted fragment name keeps its add-commit; a fresh
  fragment reusing it does not inherit that day.

[`docs/ReleaseNotes/assemble.test.sh`](../ReleaseNotes/assemble.test.sh)
asserts all of the above and runs on every PR — run it after touching the
assembler.

### 6.3 FunctionalSpecs corpus — DOC-SOURCED, NEVER code-sourced

`docs/FunctionalSpecs/` is the code-INDEPENDENT specification of what
the platform is **intended** to do — the test oracle. **Load-bearing
rule: it is sourced from the documents, never transcribed from the
contract code.** A spec derived from code can't catch a bug — it just
confirms "the code does what the code does" and locks bugs in.

Every behaviour-changing PR updates the relevant
`docs/FunctionalSpecs/<domain>.md` in the same diff as its release-note
fragment — same flow, not a post-merge step.

`docs/FunctionalSpecs/_CodeVsDocsAudit.md` records code-vs-spec
divergences (candidate bugs OR stale docs). Code-observed behaviour
enters the spec ONLY via an explicit human intent-decision — never
silently.

See `docs/FunctionalSpecs/README.md` for the doc set, the domain
slicing, the conflict-precedence rule, and the full rules.

### 6.4 GitHub Releases — auto-drafted by `release-drafter`

`.github/workflows/release-drafter.yml` watches PR merges to `main`
and updates a SINGLE draft GitHub Release with each merged PR
appended under its category. Categories are driven by PR labels (the
same set from `.github/LABELS.md`); the next-version suggestion is
label-driven (`breaking-change` → major; `enhancement` → minor;
every other documented type label → patch). Aliases like `breaking` /
`feature` / `fix` are NOT in the taxonomy, so they don't drive the
resolver — label PRs with the documented names.

The drafted release stays a **draft** until the maintainer reviews
the body + edits the tag + clicks "Publish release". Auto-drafting
≠ auto-publishing — nothing ships silently.

**Tagging cadence:**

- **End-of-iteration** patch tags (every 7 days on Monday): optional;
  pick a version, publish the draft. Useful for the iteration close-
  out narrative even on weeks where nothing audit-relevant ships.
- **Named milestone-close** releases (`audit-prep`, `mainnet-cutover`,
  etc.): publish at the milestone close.
- **Mainnet artefact** tags (`v*`): gated by `mainnet-gate.yml`
  regardless. `release-drafter` just contributes the body.

**Two-stage release pipeline:**

1. `release-drafter.yml` drafts the body as PRs merge — automatic.
2. Maintainer reviews + tags → `mainnet-gate.yml` runs the full
   forge regression on the new tag, and `release.yml` (§7.3 sibling)
   attaches the per-chain `addresses-<slug>.json` + consolidated
   `deployments.json` + `abis.tar.gz` to the release.

The fragment system (§6.1, §6.2) and `release-drafter` are
complementary: fragments are the human-curated functional
narrative; the GitHub Release body is the PR-level changelog.
Auditors read fragments; ecosystem integrators read the GitHub
Release.

**Sibling `vaipakam-keeper-bot`** uses the same pattern with its
own bot-scoped `release-drafter.yml`. External consumers pin
against keeper-bot release tags for ABI-stability.

`.github/release-drafter.yml` carries the category mapping +
version-bump rules + body template; edit there to adjust the
labelling scheme.

### 6.5 Per-workspace README template

Every workspace under `apps/` / `packages/` / `contracts/` carries
its own `README.md` following a canonical template — so a visitor
landing in `apps/keeper/README.md` cold gets the same orientation
they'd get from `apps/indexer/README.md` or any other workspace.
Consistency beats per-workspace cleverness here; an auditor or
ecosystem integrator landing on the first README they see should
know exactly where each section lives.

**Section order (REQUIRED for every workspace README):**

1. **Title + one-line description.** Audience-targeted: "this is the
   X Worker that does Y", not "code for Z".
2. **Status badges.** Workspace typecheck status, workspace test
   status, deploy status if applicable. Badges link to the latest
   workflow run.
3. **What is this** (2-3 paragraphs). Purpose, position in the
   system, explicit non-goals (what this workspace deliberately
   does NOT do — usually the most useful section for cold readers).
4. **How to run** (dev loop). The exact `pnpm --filter
   @vaipakam/<workspace> dev` (or `wrangler dev`, etc.) invocation
   + any environment-setup notes.
5. **How to test.** The exact per-workspace test invocation matching
   CI. Same shape across every workspace.
6. **Architecture.** Cross-links to relevant `docs/DesignsAndPlans/`
   + `docs/FunctionalSpecs/` + ADRs. No code in this section —
   point to the spec docs that carry the load.
7. **Configuration.** Env vars (`.env.local`), secrets (Cloudflare
   Worker secrets via `wrangler secret put`), deploy story.
8. **Related.** Cross-links to sibling workspaces this one talks
   to (e.g. `apps/indexer` reads from / writes to which other apps).

**Audit policy:** when adding a new workspace, the README is part
of the same PR. When changing a workspace's surface meaningfully
(new endpoint, new secret, new sibling dependency), the README
update is part of the same PR. Drift between code and README is a
real failure mode — treat README updates the way release-notes
fragments are treated (§6.1).

**Root `README.md` is the product overview** — its template is
different (audience: external readers landing on the GitHub repo
cold, looking for product-level orientation). The canonical technical
whitepaper for auditors and integrators lives at
[`apps/www/src/content/whitepaper/Whitepaper.en.md`](../../apps/www/src/content/whitepaper/Whitepaper.en.md). Keep repo-navigation and audit-entry references pointed at that canonical file when readers need the technical specification.

---

## 7. CI required-checks + branch protection

### 7.1 `Protect main` ruleset (monorepo)

Independent gates on every merge:

```
 1. ✅ no branch deletion
 2. ✅ no force-push / non-fast-forward
 3. ✅ linear history (squash / rebase only)
 4. ✅ PR required, with thread resolution
 5. ✅ detect-changes check SUCCESS (CI path-filter job)
 6. ✅ contracts-fast check SUCCESS (forge build + deploy-sanity + positive-flow scenarios; FOUNDRY_PROFILE=cifast)
 7. ✅ workspaces check SUCCESS (pnpm typecheck per workspace)
 8. ✅ Slither static analysis check SUCCESS (FOUNDRY_PROFILE=cifast)
 9. ✅ D1 name consistency (unconditional) SUCCESS — every D1 binding and
       every `wrangler d1` command names the same shared database (#1537)
10. ✅ signed commits
```

**This list is transcribed from the live ruleset, and was wrong before.**
It claimed `Build docs` was a required context; the ruleset does not
contain it and did not when that line was written. Whether it should be
required is a question the owner has since answered: **`Build docs` stays
non-blocking** (decided 2026-08-03).

It is informational, and it runs only on contracts-scoped PRs whose
`contracts-fast` succeeded — both conditions, per the `needs:` in `ci.yml`.
An earlier revision of this paragraph said it "runs on every PR" two lines
above saying it runs only on contracts-scoped ones. Adding a required check is a decision with its own
consequences — notably that a check which never reports blocks a PR
forever, and that it retroactively blocks every in-flight PR whose branch
predates the job.

Verify against the live ruleset rather than trusting this block:

```bash
gh api repos/vaipakam/vaipakam/rulesets/16536829 \
  --jq '.rules[]|select(.type=="required_status_checks")
        |.parameters.required_status_checks[]|.context'
```

Gate 9 is deliberately **not** path-gated. It scans the whole repository,
so gating it by path would exclude the very changes it exists to catch —
which is exactly what happened when it was first added (#1537 r6).

The full 2,012-test forge regression is **NOT** a per-PR CI gate. It
overruns the 16 GB ubuntu-latest RSS ceiling cold and was removed
from `ci.yml` in #297 (closes #296). It now runs:

- **Operator-local** at end-of-step + at mainnet preflight via
  `bash contracts/script/predeploy-check.sh --full`.
- **`mainnet-gate.yml`** on push to `release/**`, PR to `release/**`,
  every `v*` tag push, and `workflow_dispatch` — bit-identical to
  what `deploy-mainnet.sh` invokes at preflight step `[1b]`.

`ADR-0011` (supersedes ADR-0006) records the full rationale +
measurements. The `cifast` foundry profile (in `contracts/foundry.toml`)
narrows the compile graph to `src/` + `script/` + `lib/` +
`test/deploy/**` + `test/scenarios/**` + `test/mocks/**` + setup/helper —
cold ~3.17 GB / 5:22, well under the 16 GB ceiling.

**Skip-list discipline for new test files.** The `cifast` profile's
`skip = [...]` list enumerates every excluded `test/*.t.sol` by
name (a glob can't predict the future). Every PR that adds a new
top-level test file outside `test/scenarios/**` MUST either:

- (a) Append the new filename to `[profile.cifast] skip = [...]`
  in `contracts/foundry.toml`. This is the default for the vast
  majority of new tests — per-facet integration tests, library
  tests, workflow tests, etc., don't earn their CI compile cost
  in the deploy-sanity + positive-flow scope. They run
  operator-local at end-of-step + on the release-track gate.
- (b) Explicitly justify in the PR description why the new test
  IS CI-scope-worthy. Acceptable justifications: it's a new
  positive-flow scenario (also place it under `test/scenarios/`);
  it's a deploy-sanity guardrail (also place it under
  `test/deploy/`); it's a guardrail for the cifast skip-list
  itself.

Missing this discipline causes the `cifast` cold-build RSS to
creep above its 3.2 GB headroom. The PR template's "Test plan"
section is the natural place to acknowledge the choice.

### 7.2 `Protect main` ruleset (keeper-bot)

Six gates: deletion / non-fast-forward / linear / PR-with-thread / signed +
required-status-checks for `Typecheck` + `ABI shape sanity`.

### 7.3 Mainnet-gate workflow

`.github/workflows/mainnet-gate.yml` runs `predeploy-check.sh --full`
on every push to `release/**` branches, every PR targeting `release/**`,
every `v*` tag push, and on `workflow_dispatch` (manual reruns for
audit prep / hot patches). Audit trail captured on tag push (resolved
solc + per-facet bytecode sizes vs EIP-170). Hard gate before any
mainnet cutover — every path that touches a release-track ref runs
the full regression.

### 7.4 Path filter — `detect-changes` job

CI's first job diffs PR head vs base and exports two booleans:
- `contracts` — touched by changes in `contracts/`, `.gitmodules`, or
  ci.yml / mainnet-gate.yml
- `workspaces` — touched by changes in `apps/`, `packages/`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json`, or
  ci.yml

Downstream jobs `if:`-guard on these. Skipped-due-to-`if` counts as
SUCCESS for required checks → docs-only PRs merge in <1 min.

### 7.5 Foundry cache key — content-based

```
key:         forge-${runner.os}-${hashFiles('contracts/foundry.toml', 'contracts/remappings.txt', 'contracts/.submodule-state')}-${hashFiles('contracts/src/**/*.sol', 'contracts/script/**/*.sol', 'contracts/test/**/*.sol')}
restore-key: forge-${runner.os}-${hashFiles('contracts/foundry.toml', 'contracts/remappings.txt', 'contracts/.submodule-state')}-
```

Structured so `actions/cache`'s **prefix** matching works correctly.
Warm hits across same-config commits; cold rebuild only on config /
submodule / source change.

### 7.6 GitHub Actions security toggles (Settings UI)

The `.github/workflows/` files are SHA-pinned (every `uses:` carries a
40-char commit hash + trailing `# vN` annotation Dependabot reads).
That defends against the moved-tag class of supply-chain attack. The
**org/repo Settings** layer is the policy backstop that prevents an
unvetted marketplace action from running in the first place.

Five Settings UI toggles enforce that policy. None can be set via
`gh` CLI; every one is a maintainer-side action under
**Settings → Actions → General**:

1. **Allowed-actions list** — Policy: "Allow `vaipakam`, and select
   non-`vaipakam` actions." Pattern list lives at
   [`.github/allowed-actions.txt`](../../.github/allowed-actions.txt)
   in the repo. Paste-from-file when configuring.
2. **Fork PR approval** — "Require approval for first-time
   contributors who are new to GitHub" (stricter than the default).
3. **Workflow permissions** — Default = "Read repository contents and
   packages permissions" (read-only). Per-workflow opt-in to writes
   via an explicit `permissions:` block in the workflow YAML.
4. **Actions on forks** — Disabled.
5. **GITHUB_TOKEN scope on fork PRs** — Read-only by default; verify
   the toggle reflects that.

Every workflow under `.github/workflows/` MUST declare its own
explicit `permissions:` block — that's how the per-workflow opt-in
works. Audited list as of 2026-05-20: every workflow declares one;
add this audit to any future workflow-adding PR.

CODEOWNERS protection on `.github/workflows/` (`/.github/workflows/
@Raja4Shekar`) is the orthogonal axis — requires owner review on
workflow changes, regardless of who opens the PR.

---

## 8. Issue + label discipline

### 8.1 Issue templates

Use the templates at `.github/ISSUE_TEMPLATE/`:

- `bug.yml` — auto-labels `bug`, assigns to `Raja4Shekar`
- `feature_request.yml` — auto-labels `enhancement`, assigns to
  `Raja4Shekar`

Blank issues are disabled. Security disclosures route to
the IncidentRunbook, not public Issues.

### 8.2 Labels

Read `.github/LABELS.md` before applying any label. One primary type
label per issue: `bug` / `enhancement` / `documentation` / `chore` /
`refactor` / `infra` / `perf`. Cross-cutting overlays: `security` /
`audit` / `testnet-rehearsal` / `mainnet-rollout`.

### 8.3 Auto-add to project

New Issues land on `@vaipakam-labs` automatically via
`actions/add-to-project@v1.0.2` (workflow in
`.github/workflows/add-to-project.yml`, uses `ADD_TO_PROJECT_PAT`
secret). Multi-repo support via this workaround — GitHub Projects'
own auto-add is one-repo-per-UI-rule.

---

## 9. Tooling reference

### 9.1 PR poller — `~/.claude/scripts/pr-poll.sh` (RETIRED 2026-08-10)

Retired by owner directive — see §3.3. Do not launch it; the script is
kept only for its read recipe (which REST surfaces a PR monitor must
cover: reviews, inline ` ```suggestion ` blocks, reactions, check-runs,
workflow-runs). Monitoring is a heartbeat with one batched `curl` read
per wake.

### 9.2 Graphify with Solidity support — `~/.claude/scripts/graphify-apply-solidity-patch.py`

graphify upstream 0.8.13 + surgical port of PR #707's
`extract_solidity` block. Re-apply after any `pip install --upgrade
graphifyy`. Delete the patch script once PR #707 merges upstream.

### 9.3 Cross-layer linker — `graphify-out/cross_layer_link.py` (local-only)

Bridges Vaipakam Solidity contracts to their ABI JSONs / doc mentions
/ frontend imports via name-matching. ~157 INFERRED `mirrors_contract`
edges. Re-run after a fresh `/graphify .` pass.

Lives under `graphify-out/`, which is gitignored — the script is a
local helper, not a tracked repo artifact. Recreate from session
state or copy from another machine if needed.

### 9.4 Pre-deploy gate — `contracts/script/predeploy-check.sh`

Single cohesive gate. CI's `contracts-fast` invokes the default
(deploy-sanity) mode under `FOUNDRY_PROFILE=cifast`. The
`mainnet-gate.yml` workflow and the mainnet-deploy script
(`deploy-mainnet.sh` preflight step `[1b]`) invoke `--full`
under the default profile — the only places the full 2,012-test
regression runs in CI. Always run from the `contracts/` directory.
Modes:

```bash
cd contracts
bash script/predeploy-check.sh           # deploy-sanity suite (12 tests)
bash script/predeploy-check.sh --full    # full regression (2,012 tests)
```

What it does: forge build → forge test → shell-script lint → per-facet
ABI-in-sync check (committed JSONs must match `forge inspect`).

### 9.5 ABI export scripts

Both scripts must be run from `contracts/`. The `KEEPER_BOT_DIR` env
points UP and OVER to the sibling `vaipakam-keeper-bot` repo on disk
(two `..` from `contracts/`: one up to the monorepo root, one up to
the parent of both repos).

```bash
cd contracts
nice -n -10 ionice -c 2 -n 0 forge build   # always before exporting

# Frontend / Workers — writes to packages/contracts/src/abis/
bash script/exportFrontendAbis.sh

# Keeper bot — writes to ../../vaipakam-keeper-bot/src/abis/
KEEPER_BOT_DIR=../../vaipakam-keeper-bot bash script/exportAbis.sh
```

Both write `_source.json` with the upstream commit hash so the
correlation is recorded.

### 9.6 Deploy scripts

| Script | What |
|---|---|
| `contracts/script/deploy-chain.sh` | Anvil / dev deploy |
| `contracts/script/deploy-testnet.sh` | Testnet (Sepolia, Base Sepolia, Arb Sepolia, etc.) |
| `contracts/script/deploy-mainnet.sh` | Mainnet — invokes `predeploy-check.sh --full` at preflight `[1b]` |

---

## 10. Pre-audit hardening — current state

Combined effect of the #74 arc:

- Routine PRs gated on **`detect-changes` + `contracts-fast` + `workspaces` + `Slither static analysis` + `D1 name consistency (unconditional)` + signed commits + thread resolution + linear history + no-delete + no-force-push**. (**Owed, #1924 r22**: `keeper deploy guard (--keep-vars, tree-wide)` should join this list. It runs unconditionally on every PR today but is not yet in the live ruleset, so its failure does not block merge until an operator adds it — the same unconditional-by-design rationale as `D1 name consistency`.) (`Build docs` is NOT among them — see §7.1. It is informational: it runs on contracts-scoped PRs only, gated on `detect-changes.outputs.contracts` and a successful `contracts-fast`, and it never blocks merge. Owner decision 2026-08-03: leave it non-blocking.)
- Path-filter (`detect-changes`) skips downstream jobs when scope doesn't apply — docs-only PRs merge in `<1 min`.
- Contracts PRs run the deploy-sanity suite + positive-flow scenarios under the `cifast` foundry profile (~5 min cold) — production-bytecode-identical, but the full 2,012-test regression is operator-local + `mainnet-gate.yml`.
- Mainnet cutover paths gated on `mainnet-gate.yml` (full regression as hard gate on `release/**` + `v*`).
- Keeper-bot has equivalent protection on its own `main`.

The auditor-facing story: every state on main carries a CI run that
proved it passed the deploy-sanity + positive-flow guardrails, was
signed, and went through PR review with thread resolution. The
`release/**` lineage adds proof of full-regression green before any
mainnet artifact.

---

## 11. Living-doc rules

**Update this file whenever a procedure changes.** It is committed,
versioned, and audit-relevant. A new convention that lives only in
an off-repo location (an AI memory, a Slack message, a developer's
head) is invisible to the next person reading the repo.

**Scope of this doc:** every rule that needs to survive across
machines, contributors, and time. If a rule has a real
external-reader audience (an auditor, a new contributor, a future
maintainer), it lives here.

**Out of scope:** a few tool-side, agent-only operational details
that are recreated from agent state on a clean machine and don't
apply to humans following this doc (e.g. how an AI assistant should
choose Codex review levels per finding category; how to launch the
background poller via the agent harness; how to re-apply the
graphify Solidity patch after a pip upgrade). External contributors
don't need any of these — they're internal AI plumbing.

The two systems (this doc + agent-side state) reflect the same
project rules but are independently maintained. If they diverge,
this doc wins — agent state should be rewritten to match.

---

## 12. Project-specific conventions worth knowing

Rules that look weird from outside but have a deliberate rationale.
Most have bitten us at least once or were specifically argued through
to a decision. Listed by category.

### 12.1 Git + identity

- **`gh` is logged in as `vaipakam` (the org), but commits stay
  authored as `Raja4Shekar`.** The org account does PR / comment /
  project-board operations; commit authorship stays the personal
  identity for attribution. Don't merge the two — they serve
  different purposes.

- **`Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`
  on every AI-assisted commit.** Not optional. Same trailer in PR
  bodies for PRs whose body was AI-drafted.

### 12.2 Files / paths to NOT touch

- **`docs/internal/RoughNotes.md` is user-owned** and gitignored on
  purpose — local-only scratch space for ideas / questions /
  half-formed plans. AI never edits it. The file won't appear in the
  repo on GitHub even though it's referenced in agent context.

- **`docs/internal/PendingTasks-yyyy-mm-dd.md` is retired** (replaced
  by the `@vaipakam-labs` Project as live tracker). The latest file
  in that series is a frozen historical breadcrumb — read-only.

- **`docs/ToDo.md`** carries the user-facing ET-### follow-up list.
  Closed items stay ticked for audit history; open ones get promoted
  to Project Issues.

- **`graphify-out/`** is gitignored end-to-end. Anything under that
  directory (the graph JSON, the HTML viz, the cross-layer linker
  script) is per-machine — not part of the canonical repo state.

### 12.3 Solidity / on-chain

- **ERC20 approvals: exact amount, never `MaxUint256`.** Approve only
  what each action needs; revoke when done. Reduces blast radius if
  a hook / facet has a bug.

- **Cross-facet calls use `address(this).call(abi.encodeWithSelector(...))`
  — never direct facet-to-facet imports.** Goes through the diamond's
  fallback, routes to the target facet via the cut table. Direct
  imports break the diamond pattern and miss the cut-table guarantees.

- **`viaIR = true` + `optimizer_runs = 200` is non-negotiable.** Drives
  every build. Prefix every long forge invocation with
  `nice -n -10 ionice -c 2 -n 0` for the same priority reason — **but
  `nice -n -10` needs CAP_SYS_NICE**, and without it the prefix is
  silently ineffective rather than fatal. Do not probe it by exit status: on coreutils 9.4 an
  unprivileged `nice -n -10 cmd` prints `nice: cannot set niceness:
  Permission denied`, still runs `cmd` at niceness 0, and returns `cmd`'s
  own exit status (verified on this machine: `nice -n -10 true` exits 0),
  so a `sudo -n true` or exit-code check selects the wrong branch. Probe
  the EFFECTIVE niceness — `nice -n -10 nice` prints `0` when the caller
  lacks the capability and `-10` when it has it — or simply run the
  prioritized command under `sudo` when that is available and omit `nice`
  otherwise, keeping `ionice -c 2 -n 0 forge ...` in both cases — the I/O
  class is available unprivileged, and it is the knob that matters:
  ```bash
  nice -n -10 ionice -c 2 -n 0 forge build
  nice -n -10 ionice -c 2 -n 0 forge test
  nice -n -10 ionice -c 2 -n 0 forge script <ScriptName>
  ```
  viaIR runs 5-15 min and ~8 GB RSS; low priority causes 2-3×
  slowdowns under parallel desktop load.

**Design-and-change discipline (folded from agent memory, 2026-09-07):**

- **Scout → Design → Code, for any non-trivial change.** Survey the
  existing code BEFORE writing design text so the design is grounded in
  what exists; then write the design; then code to it. Never act from
  memory of the tree.
- **Grep for an existing primitive before writing a new one** — an
  existing function, formula, or storage shape that does the same thing
  is reused, not re-implemented. When deriving a quantity, search for the
  EXACT helper first, and read the candidate's contract (NatSpec plus the
  primitives it calls) before deriving anything: a name containing
  `UpperBound` or `approx` usually announces an inexact figure, but a
  `preview` may be exact — `previewPeriodicSettle` computes its figures
  through the same `LibPeriodicInterest` helpers settlement uses — so the
  name is a reason to inspect, never proof either way.
- **Exhaust the frozen plan before asking a design fork.** Before an
  `AskUserQuestion`, re-read the governing plan/spec and every document it
  binds to — the answer is usually already there. And check whether the
  governing design doc has a NEWER revision on a named card or open PR
  than the copy on `main`.
- **Propagate renames and deletions to every ASSERTION**, not just code:
  grep the OLD name across `docs/`, `ops/`, runbooks, and release notes.
  A count is a claim; a changed formula falsifies every artifact that
  states it. Read the files rather than trusting a single grep.
- **One PR per design-doc step** (owner, 2026-08-17) — not per
  sub-round, not per multi-step feature. Inner-loop work stays local
  until the step is complete; push once with a pre-open adversarial and
  security self-review, and run one CI cycle per push.
- **Every change follows the project coding standards and explains WHY
  in the file type's own idiom** — NatSpec for Solidity, JSDoc for
  JavaScript/TypeScript APIs, and a plain rationale comment only where a
  SQL migration, shell script, workflow YAML, or config file genuinely
  needs one. The comment states a constraint the code cannot show, never
  a narration of the next line.
- **viaIR stack-too-deep lever:** lean DTOs (reducing the data that
  crosses the ABI boundary) FIX "Variable size is N too deep"; sub-structing
  the types that cross the boundary makes it WORSE. And viaIR's CSE turns
  two identical `vm.warp(block.timestamp + N)` expressions into one — the
  second warp is a no-op — so Foundry tests use distinct absolute warp
  targets.

### 12.4 Retail-deploy gating policy — sanctions ON; KYC and country-pair OFF

- **KYC and country-pair gating: OFF on retail.** Both are runtime-
  disabled. The industrial-user variant is a SEPARATE deploy on a
  separate fork with these flipped on — don't enable on the retail
  deploy. See ADR-0002.

- **Sanctions screening: REQUIRED on retail.** Distinct from KYC.
  `ProfileFacet.setSanctionsOracle(<chainalysis-oracle>)` MUST be
  called once the oracle's address is known. Tier-1 entry points
  revert for flagged callers; Tier-2 close-out paths stay open so the
  unflagged counterparty can be made whole. While unset, sanctions
  screening fails open (intentional pre-`setSanctionsOracle` window).

- **Don't mention OR negate KYC / identity / country gating in user
  copy.** Website, whitepaper, overview, user guide, marketing — all
  silent on these. Retail product is permissionless end-state, not
  "permissionless for now". Sanctions wording in user copy stays
  minimal: a single defensive bullet under "Prohibited use"; the
  full message surfaces ONLY in the in-app banner shown to flagged
  wallets and in contract revert messages.

- **Sanctions wording, when it appears, stays minimal.** ToS has ONE
  defensive bullet. The full three-line message is shown only when a
  flagged wallet connects (in-app `SanctionsBanner`) and in contract
  revert messages — never on marketing surfaces.

### 12.5 Deploy / testnet discipline

- **Testnet rehearsals stay deployer/admin-owned.** Base Sepolia,
  Sepolia, Arb Sepolia, and other testnets intentionally skip the
  multisig handover step so flow tests keep working on EOA keys.
  **Mainnet cutover is the ONLY place `--phase handover` runs.**

- **Mainnet deploy DEFERRED.** Phase 7 + Phase 9 contract changes can
  land in any order before the eventual cutover. No urgency to
  sequence them in a specific way. Re-evaluate when audit prep
  starts.

- **Predeploy-check IS the gate, in both CI and deploy.** CI's
  `contracts-fast` and `mainnet-gate.yml` both run the same
  `predeploy-check.sh` script that `deploy-mainnet.sh` invokes at
  preflight step `[1b]`. Drift between "passes CI" and "the deploy
  script will accept" is structurally impossible.

### 12.6 Dependency management

- **Dependabot is scoped to OFF-CHAIN only** (`github-actions` + `npm`).
  Contract dependencies under `contracts/lib/` are git submodules
  pinned to an AUDITED commit set — bumping any of them changes
  audited bytecode, so it must be a deliberate, reviewed, re-audited
  decision. No `gitsubmodule` ecosystem is configured.

- **Every `uses:` in workflows is SHA-pinned with a trailing `# vX`
  comment.** Dependabot reads the comment to offer bumps; the SHA
  protects against a moved tag.

- **Dependabot PRs are NEVER auto-merged.** Same review + CI + Codex
  scrutiny as any other change.

### 12.7 Review discipline

- **Codex code suggestions are advisory.** Don't blindly apply the
  literal patch. Confirm the finding is real, weigh alternatives,
  record the chosen approach in the PR thread, then fix the way
  that's right for the codebase.

- **Architecture-work iterates 3-6 rounds.** For security /
  architecture changes, expect multiple cycles of
  alternative-exploration before approval. Don't push back on
  iteration — it's the right shape.

- **Always propose alternatives BEFORE committing to a non-trivial
  design path.** Let the user decide. Surface tradeoffs honestly.

**Verification discipline — what a passing check actually proves:**

- **The vacuous-test rule.** A test asserting a fix proves nothing until
  the fix is reverted and the test fails for the RIGHT reason. When the
  fix is supposed to mutate state, assert the persisted state, not just a
  returned value; for pure or view logic (risk math, previews) the
  returned value IS the behaviour under test and a discriminating
  assertion on it is sufficient.
- **Mutation-killed is not non-vacuous.** A mutation matrix proves a test
  DISTINGUISHES two implementations, not that it pins the right value —
  assert the fixture actually reached a non-trivial state first.
- **Reachability is not discrimination.** A gate test must make the two
  competing formulas STRADDLE the threshold; making a branch reachable
  proves nothing. Instrument after two surviving mutations.
- **A guard must RUN on its own case.** After adding a check, construct
  the minimal PR containing the defect and confirm the check executes on
  it — a trigger condition is at least as important as the check body.
- **Make a check FAIL before trusting it.** Mutate the thing it guards and
  watch it go red; "scanned nothing" must be a hard error, never a green.
- **Don't overclaim what a check proves.** State which regression it
  kills AND which it misses; an overclaimed check is worse than a known
  gap because it stops people looking.
- **Make the check BE the operation.** A validity check that
  re-implements the operation it guards diverges from it; collapse to one
  implementation that performs the operation and reports what it refuses.
- **Verify with a tool that can SEE the failure.** Name the failure mode
  first, then pick the tool: `bash -n` cannot see function scoping,
  `--help` never exercises the code path, an exit code says nothing about
  content.
- **Scripted text edits replace EXACT strings only** — never bound an
  edit by a positional marker such as the next blank line — and confirm
  each edit LANDED (`grep` the new text; `wc -l` after) before any reply
  references it. Mutate each call site by index when testing a scripted
  change.

### 12.8 Testing

- **Test scope includes flows NOT in the Advanced User Guide.** The
  guide is one input; also map bot/keeper-driven flows (matchOffers,
  liquidation), MEV defenses (cancel cooldown, dust close),
  admin/governance, treasury, cross-chain, sanctions Tier-1/2 paths,
  every external entry point.

- **Tests run with `nice -n -10 ionice -c 2 -n 0`** for the same
  performance reason as the build (§12.3).

- **Inner loop is `FOUNDRY_PROFILE=quick forge build` plus a targeted
  `forge test --match-path <glob>` (or `--match-test` / `--match-contract`);** the full regression (`run-regression.sh`) is not a
  routine per-PR gate — it runs before a testnet deployment, and CI runs it
  on PRs targeting `release/**` (`mainnet-gate.yml`'s
  `predeploy-check.sh --full`), which is the one PR shape where it IS the
  gate. Kill any stale
  `forge`/`solc` process before starting a new build, and use the priority
  prefix from §12.3 (`ionice -c 2 -n 0`, plus `nice -n -10` only when
  `nice -n -10 nice` prints `-10`) — viaIR runs take 5–15 minutes and ~8 GB, and low
  I/O priority makes them 2–3× slower under desktop load.

### 12.9 Workers + frontend

- **All Workers + frontend read from `@vaipakam/contracts/abis` and
  `@vaipakam/contracts/deployments`.** Single source of truth. After
  contract changes, run `contracts/script/exportFrontendAbis.sh` +
  `contracts/script/exportFrontendDeployments.sh`, then the
  per-workspace typechecks listed in §3.1's PR checklist (NOT
  `pnpm -r typecheck` — that command skips workspaces without a
  `typecheck` script, so a workspace that loses one goes unchecked).

- **Cloudflare Workers Static Assets — NEVER use `/*` catch-all in
  `_redirects`.** Status-200 rewrites fire unconditionally and
  intercept JS/JSON before the file matcher. Rely on
  `wrangler.jsonc`'s `not_found_handling` for SPA fallback. (Bit us
  once during a Phase 6 frontend deploy — the 200-rewrite intercepted
  ABI JSON fetches and the app silently fell back to a stale chain.)

- **Indexer event-coverage guardrail.** `apps/indexer`'s `EVENT_ABI` is
  DERIVED from the compiled `DIAMOND_ABI_VIEM` (never hand-typed).
  `apps/indexer/scripts/check-event-coverage.mjs` (wired into the
  workspace's `typecheck` script) fails CI if any contract event
  tagged `@custom:event-category state-change/loan-mutation` or
  `state-change/offer-mutation` lacks an indexer handler AND isn't
  in the script's `DELIBERATELY_NOT_HANDLED` allowlist.

- **A source tree cannot be made undeployable by configuration** — every
  guard in `wrangler.jsonc` sits in the artifact the operator overrides.
  Delete the tree instead.
- **Auction-shaped dapp flows are single-transaction** (prepay-listing
  post/update/match-via-offer, and any future English or matched-orders
  shape): one signed transaction per user action, never a multi-step
  sequence the user can abandon midway.
- **General origination and liquidity classification never gate asset
  ELIGIBILITY on admin or governance configuration;** the treasury
  backstop may gate, and so may an explicitly specialised surface whose
  design makes an allowlist its primary defence — the swap-to-repay
  intent path requires both legs on its per-token allowlists
  (`SwapToRepayIntentFacet`, `cfgIntentAllowed*Tokens`) against
  fee-on-transfer and rebasing tokens, and that guard stays. Do not add
  an allowlist check to a general origination path.

### 12.10 Project-board nuances

- **One card per work item, even multi-phase.** If a piece of work
  splits into multiple PRs (74.A, 74.B, 74.C), keep ONE card and
  update its status as the phases progress. Don't fragment.

- **User reviews `@vaipakam-labs` cards ONLY when Status is "In
  review".** Agent must transition cards Backlog → In progress →
  In review → Done. If a card is sitting in In progress, the user
  isn't expected to look at it.

- **Multi-iteration cards: set FIRST iteration of activity, don't
  rewrite on close.** Preserves "when did this work START"
  provenance.

- **Don't backfill past iterations** unless the data is meaningful
  for retrospective. Forward-looking discipline only.

### 12.11 Tooling — gotchas

- **`graphify` is on upstream 0.8.13 + a surgical port of PR #707's
  Solidity extractor.** After any `pip install --upgrade graphifyy`,
  re-apply with `python3 ~/.claude/scripts/graphify-apply-solidity-patch.py`.
  Verify: `from graphify.detect import CODE_EXTENSIONS; '.sol' in CODE_EXTENSIONS`.
  Delete the patch script when PR #707 merges upstream.

- **`graphify update .` (AST-only) is FREE; `/graphify .` (full
  pipeline) costs LLM tokens.** Use the cheap one for routine
  freshness; the expensive one only after major refactors that need
  community-structure re-detection.

- **(Historical — `pr-poll.sh` is retired, §3.3.)** When it was in use it
  had to launch via `Bash run_in_background:true`, NOT shell `&` /
  `disown` — mixing them silently orphaned the poller (zero-byte output
  file, no task-notification; PR #84). The same rule applies to any
  background command a task-notification is expected from.

- **Never build an API payload with `python -c` inside a double-quoted
  shell string** — backticks in the body expand as command substitution
  and silently strip identifiers. Write the body to a file with a
  quoted heredoc and read the result back.

### 12.12 Release-notes intro paragraphs

- **The intro paragraph of a dated `ReleaseNotes-yyyy-mm-dd.md` is a
  hand-written framing**, not generated by `assemble.sh`. After
  folding fragments, re-read the threads and rewrite the intro if
  the day's work forms a coherent arc.

- **Don't claim "N threads in this batch" without recounting** — when
  multiple PRs feed into one dated file across a day, the count drifts.
  Bit us once on PR #87 / #90 where the intro said "Six" while the
  file had eight sections.

---

## Cross-references

- `CLAUDE.md` — AI-instruction shape of these conventions
- `.github/LABELS.md` — Vaipakam label vocabulary
- `docs/FunctionalSpecs/README.md` — FunctionalSpecs corpus rules
- `docs/ReleaseNotes/unreleased/README.md` — release-notes fragment
  template + the per-PR fragment convention
- `docs/ReleaseNotes/assemble.sh` — the fold script that produces the
  dated `ReleaseNotes-yyyy-mm-dd.md` files

Local-only / gitignored references (not in the repo on GitHub but
present on the project owner's working tree):

- `docs/internal/RoughNotes.md` — user's free-form scratch space
  (gitignored on purpose, untouched by AI by convention)
- `graphify-out/` — graphify pipeline output + the cross-layer
  helper, recreated per machine

---

*Maintained by the project owner; AI contributions accepted via PR.*
