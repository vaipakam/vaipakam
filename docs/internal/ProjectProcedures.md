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

Both repos enforce identical `Protect main` rulesets (see §7).

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
final stage. (See `feedback-keep-merged-branches` memory.)

---

## 3. Pull request workflow

### 3.1 Opening a PR — checklist

```
☐ Branch follows §2.1 naming
☐ Commits follow §2.2 format + are signed (§2.3)
☐ Release-notes fragment in docs/ReleaseNotes/unreleased/<task-id>-<slug>.md
☐ FunctionalSpecs updated if behaviour changed (see §6)
☐ Locally green: forge build, predeploy-check.sh, pnpm typecheck
☐ Card on @vaipakam-labs moved to "In review" (§5.3)
☐ gh pr create with body covering: What, Why, Verification, Closes #N
☐ Codex review request: `@codex P<levels> review` (§3.2)
☐ Background-poller running for the PR (§3.3)
```

### 3.2 Codex review — priority levels

`@codex P<levels> review` triggers Codex's GitHub review. Pick levels by
risk:

| Levels | When to use |
|---|---|
| `P1` only | Lowest-risk PRs: docs-only, tooling tweaks, comment fixes |
| `P1 P2` | Most routine code changes — refactors, additions to existing tested patterns |
| `P1 P2 P3` | Higher-risk changes: deploy script edits, ruleset changes, security-sensitive code |
| (none) | Skip Codex on truly trivial changes (typo, single-line comment). Rare. |

After each fix iteration, **post a new `@codex <levels> review`
comment.** Codex's auto-review on push fires once, but explicit triggers
re-run the review on the new commit.

### 3.3 Background-poller — never `gh pr view --json comments`

Use `~/.claude/scripts/pr-poll.sh <pr-num>` instead. The poller covers
review submissions + inline ` ```suggestion ` blocks + 👀 reactions +
check-runs + workflow-runs — surfaces that `gh pr view --json comments`
silently misses.

Launch with the harness's background mechanism (NOT shell `&`/`disown`):
```bash
~/.claude/scripts/pr-poll.sh 84 --interval 60
```

Exits on first delta; harness re-invokes the agent. See
`feedback-pr-poll-tool` memory.

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

See `feedback-blocking-review-process` memory.

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

See `feedback-post-merge-definition-of-done` memory.

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

See `feedback-iteration-sprint-discipline` memory.

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

`contracts-full` runs in parallel as **informational only** — surfaces
the full 2,012-test regression on every PR but doesn't gate the merge.

### 7.2 `Protect main` ruleset (keeper-bot)

Six gates: deletion / non-fast-forward / linear / PR-with-thread / signed +
required-status-checks for `Typecheck` + `ABI shape sanity`.

### 7.3 Mainnet-gate workflow

`.github/workflows/mainnet-gate.yml` runs `predeploy-check.sh --full`
on every push to `release/**` branches and every `v*` tag push. Audit
trail captured on tag push (resolved solc + per-facet bytecode sizes
vs EIP-170). Hard gate before any mainnet cutover.

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
key:         forge-${runner.os}-${hashFiles(foundry.toml, remappings.txt, .submodule-state)}-${hashFiles(**.sol)}
restore-key: forge-${runner.os}-${hashFiles(foundry.toml, remappings.txt, .submodule-state)}-
```

Structured so `actions/cache`'s **prefix** matching works correctly.
Warm hits across same-config commits; cold rebuild only on config /
submodule / source change.

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
blocks + reactions + check-runs + workflow-runs. See
`feedback-pr-poll-tool` memory for details + the `--watch-all` mode.

### 9.2 Graphify with Solidity support — `~/.claude/scripts/graphify-apply-solidity-patch.py`

graphify upstream 0.8.13 + surgical port of PR #707's
`extract_solidity` block. Re-apply after any `pip install --upgrade
graphifyy`. See `feedback-graphify-solidity-setup` memory.

### 9.3 Cross-layer linker — `graphify-out/cross_layer_link.py`

Bridges Vaipakam Solidity contracts to their ABI JSONs / doc mentions
/ frontend imports via name-matching. ~157 INFERRED `mirrors_contract`
edges. Re-run after a fresh `/graphify .` pass.

### 9.4 Pre-deploy gate — `contracts/script/predeploy-check.sh`

Single cohesive gate that CI's `contracts-fast` and `contracts-full`
both invoke, and that the mainnet-deploy script also runs at preflight
step `[1b]`. Modes:

- `bash predeploy-check.sh` — deploy-sanity suite (12 tests)
- `bash predeploy-check.sh --full` — full regression (2,012 tests)

What it does: forge build → forge test → shell-script lint → per-facet
ABI-in-sync check (committed JSONs must match `forge inspect`).

### 9.5 ABI export scripts

```bash
forge build   # always before exporting
bash contracts/script/exportFrontendAbis.sh    # → packages/contracts/src/abis/
KEEPER_BOT_DIR=../../vaipakam-keeper-bot bash contracts/script/exportAbis.sh  # → keeper-bot/src/abis/
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
versioned, and audit-relevant. A new convention that lives only in an
AI memory or a Slack message is invisible to the next person reading
the repo.

Conventions that DO live only in agent memory (per-machine
`~/.claude/projects/...`):

- Codex review level guidance per finding category
- The polling tool's launch hygiene
- The graphify Solidity patch re-application

These are TOOL-side conventions — they don't survive a clean machine
or a new contributor; they're recreated from the memories. Procedures
that need to survive across machines / contributors / time live here.

---

## Cross-references

- `CLAUDE.md` — AI-instruction shape of these conventions
- `.github/LABELS.md` — Vaipakam label vocabulary
- `docs/FunctionalSpecs/README.md` — FunctionalSpecs corpus rules
- `docs/ReleaseNotes/README.md` — release-notes fragment / fold flow
- `docs/internal/RoughNotes.md` — user's free-form scratch (untouched
  by AI by convention)

---

*Maintained by the project owner; AI contributions accepted via PR.*
