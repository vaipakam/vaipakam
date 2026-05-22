# Vaipakam Project Procedures

This is the human-readable operator handbook — how work moves from idea
to merged on main and beyond. The `CLAUDE.md` at the repo root is the
AI-instruction-shaped twin of this document; the two stay deliberately
complementary so each reader gets the shape that fits.

If a step here disagrees with `CLAUDE.md`, this file wins for human
operators; the AI follows CLAUDE.md and surfaces the divergence in the
next interaction.

---

## 1. Repository topology

Two repos work together:

| Repo | Visibility | Purpose |
|---|---|---|
| `vaipakam/vaipakam` | **public** | Monorepo. Solidity contracts, frontend (apps/defi), Workers (apps/{keeper,indexer,agent,www}), shared packages, docs. |
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
   `pnpm --filter @vaipakam/keeper typecheck && pnpm --filter @vaipakam/indexer typecheck && pnpm --filter @vaipakam/agent typecheck && pnpm --filter @vaipakam/defi exec tsc -b --noEmit && pnpm --filter @vaipakam/www typecheck`
   (don't use `pnpm -r typecheck` — it silently skips workspaces
   without a `typecheck` script, e.g. `apps/defi`)
☐ gh pr create with body covering: What, Why, Verification, Closes #N
☐ Card on @vaipakam-labs moved to "In review" (§5.3 — happens after the PR exists)
☐ Codex review request: `@codex review <mode>` (§3.2 — mode ∈ `normal` / `adversarial` / `full` / `full security-critical`)
☐ Background-poller running for the PR (§3.3)
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

### 3.3 Background-poller — never `gh pr view --json comments`

Use `~/.claude/scripts/pr-poll.sh <pr-num>` instead. The poller covers
review submissions + inline ` ```suggestion ` blocks + 👀 reactions +
check-runs + workflow-runs — surfaces that `gh pr view --json comments`
silently misses.

Launch with the harness's background mechanism (NOT shell `&`/`disown`):
```bash
~/.claude/scripts/pr-poll.sh 84 --interval 60
```

Exits on first delta; harness re-invokes the agent.

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
| **Module** | single-select | `contracts` / `apps/{defi,keeper,indexer,agent,www}` / `docs` / `ops` / `vaipakam-keeper-bot` |
| **Priority** | single-select | P0 (drop everything) / P1 (current sprint) / P2 (backlog) |
| **Size** | single-select | XS (<1h) / S (~half-day) / M (~1d) / L (~2-3d) / XL (>3d) |
| **Estimate** | number | Skip unless explicitly meaningful. Size carries enough info for solo work. |

### 5.2 Sprint goals — encoded in iteration titles

Themes live in the iteration title, NOT in a separate field. Example:

- `Iteration 2 — Harden the deploy gate` (current week)
- `Sprint 2 — Harden the deploy gate` (current sprint, transitional 7-day)
- `Sprint 3` (no theme yet — to be set at sprint planning)

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
| `audit-prep` | Pre-audit hardening — branch protection, signed commits, CI gates, ADRs, glossary, SECURITY.md, CodeQL + Slither + gas-snapshot tracking, Cloudflare posture, dependency triage. |
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

**Automation — the card is auto-filed.**
[`.github/workflows/iteration-kickoff-sync.yml`](../../.github/workflows/iteration-kickoff-sync.yml)
fires on cron `5 0 * * MON` (Mondays 00:05 UTC) and files the
"Iteration kickoff sync — <date>" card via `imjohnbo/issue-bot`.
Auto-add-to-project routes it to the Backlog. The maintainer picks
it up first thing Monday, performs the sync, lands a docs PR, and
closes the card. If a card from the previous Monday is still open,
the new card co-exists as Backlog (the maintainer closes the older
one as duplicate when reviewing).

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

The script concatenates pending fragments into
`docs/ReleaseNotes/ReleaseNotes-<date>.md`, removes the fragments, and
prints the commit steps. **Review the assembled file — add an intro
paragraph by hand if the day's threads form a coherent arc** — then
commit.

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

**Root `README.md` is the technical whitepaper** — its template is
different (audience: external readers landing on the GitHub repo
cold, looking for protocol-level intro). It carries the "For
auditors and integrators" quick-links table that points at every
load-bearing doc (added in PR #93). The canonical whitepaper text
lives at
[`apps/www/src/content/whitepaper/Whitepaper.en.md`](../../apps/www/src/content/whitepaper/Whitepaper.en.md).

---

## 7. CI required-checks + branch protection

### 7.1 `Protect main` ruleset (monorepo)

Eight independent gates on every merge:

```
1. ✅ no branch deletion
2. ✅ no force-push / non-fast-forward
3. ✅ linear history (squash / rebase only)
4. ✅ PR required, with thread resolution
5. ✅ detect-changes check SUCCESS (CI path-filter job)
6. ✅ contracts-fast check SUCCESS (forge build + deploy-sanity)
7. ✅ workspaces check SUCCESS (pnpm typecheck per workspace)
8. ✅ signed commits
```

`contracts-full` runs **serialized after** `contracts-fast` (via
`needs:`), as **informational only** — surfaces the full 2,012-test
regression on every PR but doesn't gate the merge. The serial
ordering's actual benefit:

- **Eliminates the parallel-save race** on the shared cache key
  (parallel jobs writing the same key risk one job's save being
  discarded).
- **Avoids attributing TWO cold-cache forge builds to a single run**
  in observability — the run sequences `build → test → full-test`
  cleanly rather than building twice.
- **Fail-fast** — if `contracts-fast` is red, `contracts-full` skips
  entirely (the `if:` guard depends on `contracts-fast.result == 'success'`).

Same-run cache transfer is the whole point: `actions/cache` saves at
job END (post step); a downstream job in the SAME workflow run, gated
by `needs:`, then restores that just-saved cache by key. That's why
`contracts-fast` → `contracts-full` is serialized — `contracts-full`
restores the cache `contracts-fast` saved seconds earlier in the same
run, so the full regression rides on a warm foundry artifact tree
instead of paying a second cold rebuild. The inline comments in
`.github/workflows/ci.yml` (`contracts-full` cache section, lines
~200-210) walk through the save→restore-in-same-run mechanics.

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

### 9.1 PR poller — `~/.claude/scripts/pr-poll.sh`

Persistent across sessions. Covers reviews + inline ` ```suggestion `
blocks + reactions + check-runs + workflow-runs. Has a `--watch-all`
mode for cross-PR polling via the GitHub `/notifications` endpoint.

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

Single cohesive gate that CI's `contracts-fast` and `contracts-full`
both invoke, and that the mainnet-deploy script also runs at preflight
step `[1b]`. Always run from the `contracts/` directory. Modes:

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

- Routine PRs gated on **`detect-changes` + `contracts-fast` + `workspaces` + signed commits + thread resolution + linear history + no-delete + no-force-push** (eight gates).
- Routine PRs skip the slow regression when no contracts changed — `<1 min` merge cycle.
- Contracts PRs run the full regression as informational + fast deploy-sanity as blocking.
- Mainnet cutover paths gated on `mainnet-gate.yml` (full regression as hard gate on `release/**` + `v*`).
- Keeper-bot has equivalent protection on its own `main`.

The auditor-facing story: every state on main carries a CI run that
proved it passed the deploy-sanity guardrails, was signed, and went
through PR review with thread resolution. The `release/**` lineage
adds proof of full-regression green before any mainnet artifact.

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
  `nice -n -10 ionice -c 2 -n 0` for the same priority reason:
  ```bash
  nice -n -10 ionice -c 2 -n 0 forge build
  nice -n -10 ionice -c 2 -n 0 forge test
  nice -n -10 ionice -c 2 -n 0 forge script <ScriptName>
  ```
  viaIR runs 5-15 min and ~8 GB RSS; low priority causes 2-3×
  slowdowns under parallel desktop load.

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

### 12.8 Testing

- **Test scope includes flows NOT in the Advanced User Guide.** The
  guide is one input; also map bot/keeper-driven flows (matchOffers,
  liquidation), MEV defenses (cancel cooldown, dust close),
  admin/governance, treasury, cross-chain, sanctions Tier-1/2 paths,
  every external entry point.

- **Tests run with `nice -n -10 ionice -c 2 -n 0`** for the same
  performance reason as the build (§12.3).

### 12.9 Workers + frontend

- **All Workers + frontend read from `@vaipakam/contracts/abis` and
  `@vaipakam/contracts/deployments`.** Single source of truth. After
  contract changes, run `contracts/script/exportFrontendAbis.sh` +
  `contracts/script/exportFrontendDeployments.sh`, then the
  per-workspace typechecks listed in §3.1's PR checklist (NOT
  `pnpm -r typecheck` — that command skips workspaces without a
  `typecheck` script, missing the apps/defi tsc invocation).

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

- **`pr-poll.sh` must launch via `Bash run_in_background:true`, NOT
  shell `&` / `disown`.** Mixing them silently orphans the poller
  (zero-byte output file, no task-notification). Hit this once during
  the PR #84 iteration cycle.

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
