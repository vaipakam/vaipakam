# AGENTS.md

This file provides shared agent guidance for working in this repository.

## GitHub Review Commands

Use these command conventions when a PR, issue, or project card asks for an
agent review. The commands are intentionally general so they can be used in
GitHub comments, project-card notes, or chat.

### `@codex review normal`

Perform a standard implementation review:

- confirm the PR matches its issue, card, and acceptance criteria;
- inspect the changed files and relevant surrounding code;
- check correctness, integration with existing patterns, missing tests, docs,
  config, and mergeability;
- run the relevant focused tests or typechecks when practical; and
- post an approval or requested-changes review when the result is clear.

### `@codex review adversarial`

Perform a failure-mode and abuse-case review:

- look for malicious inputs, auth bypass, replay, spoofing, stale config, bad
  defaults, privacy drift, data loss, race conditions, partial failures, stuck
  state, fund-loss paths, and incorrect assumptions;
- stress the PR against edge cases and cross-module interactions; and
- post blockers as requested changes when the issue can affect safety,
  security, privacy, correctness, or recoverability.

### `@codex review full`

Perform both `normal` and `adversarial` review. This is the default command for
cards in `In review` unless the work is clearly low-risk.

Expected flow:

1. Read the issue or project card, especially any Implementation section.
2. Identify linked PRs and any stated merge order.
3. Review the PR changes and relevant surrounding code.
4. Run focused tests/typechecks when practical.
5. Post a formal GitHub review: approve if clean, request changes if blockers
   remain, or comment if the result is informational only.
6. If the PR is approved, checks are green, and merge order allows it, merge it
   and move the associated project card to `Done`.

### `@codex review full security-critical`

Use this for high-risk changes where the extra review cost is justified:

- contracts that move funds or change accounting;
- liquidation, settlement, vault, treasury, oracle, or cross-chain logic;
- auth, admin, keeper, worker, API, privacy, compliance, secret-management, or
  irreversible migration changes.

This means `review full` plus deeper threat modeling, invariant checking,
failure-path inspection, and stricter test expectations.

## Review Depth Defaults

- Docs-only or copy-only changes: `normal` plus light adversarial review for
  legal, privacy, or user-facing misstatements.
- Frontend UX changes: `normal` plus adversarial checks for bad wallet/network
  state, stale data, and unsafe user flows.
- Worker/API/privacy changes: `review full`.
- Contracts/funds/admin/security changes: `review full security-critical`.
- Stacked PRs: review the linked stack and stated merge order, not only the
  currently visible PR.

## Project-specific review profiles

These are project-specific orientations layered on top of the four canonical
modes. When the trigger comment names a profile (e.g.
`@codex review handbook`), Codex should pick up the mode it implies AND the
extra focus areas listed under that profile.

### `@codex review handbook`

Equivalent to `review normal` plus:

- check every cross-reference path in the changed doc resolves — the file
  exists, line / anchor citations are correct, code snippets quoted from
  workflows match the workflow YAML;
- flag stale CI / workflow snippets against `.github/workflows/*.yml`
  (especially cache key shapes + the `detect-changes`-then-guard pattern);
- verify command examples use canonical syntax (Codex triggers from this
  file's §`GitHub Review Commands`; labels from `.github/LABELS.md`;
  forge / pnpm invocations matching `CLAUDE.md`'s "Build & Test Commands");
- treat conflict between the handbook and the source file as a handbook
  bug — flag it for the doc author, not the source author.

Use this for PRs to `docs/internal/ProjectProcedures.md`, `CONTRIBUTING.md`,
`AGENTS.md` itself, `.github/LABELS.md`, and any other operator-handbook-
class document.

### `@codex review crosschain-deploy`

Equivalent to `review full security-critical` plus:

- cross-check rate-limit values + chain set against
  `docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md` §10
  (capacity 50,000 VPFI, refill ≈5.8 VPFI/s as starting values);
- verify owner = admin multisig → governance timelock on every cross-chain
  contract introduced or modified by the PR;
- confirm `GuardianPausable` is wired on BOTH the send and receive paths
  for any cross-chain message-handling change;
- check that `_assertPaymentTokenSane` (or its equivalent guards) covers
  the chain set the PR touches, per the `VPFIBuyAdapter` payment-token-
  mode policy in `CLAUDE.md`.

Use this for PRs touching `contracts/src/crosschain/`,
`contracts/script/DeployCrosschain.s.sol`,
`contracts/script/ConfigureCcip.s.sol`, or any token-pool / messenger /
adapter contract.

### `@codex review design-doc`

Equivalent to `review adversarial` plus:

- treat the doc as the spec under review, not as a description of code;
- stress-test the doc against attack scenarios, edge cases, race
  conditions, and operational failure modes BEFORE implementation;
- challenge the trade-offs section — surface trade-offs the doc author
  may have under-weighted or missed entirely;
- check the doc is internally consistent — definitions used uniformly,
  invariants not silently relaxed in later sections;
- propose at least one alternative approach the doc didn't consider.

Use this on doc-only PRs to `docs/DesignsAndPlans/` — the pattern is to
open a design proposal as its own PR, get a clean adversarial pass on the
DOC, then implement against the ratified spec in a follow-up PR.

---

Profiles are intentionally extensible — when a recurring review pattern
emerges (e.g. "every Stage-N source-tree refactor PR needs the same
focus areas"), add a profile here in the same PR that introduces the
pattern. Profiles compose: a trigger like
`@codex review handbook crosschain-deploy` is a valid request to apply
both focus sets on the same PR.

## Trigger string shape (for human contributors)

Triggers use the form:

```
@codex review <mode> [<profile>]
```

Where:

- **`<mode>`** is REQUIRED and load-bearing — one of `normal`,
  `adversarial`, `full`, `full security-critical`. This is the part
  Codex definitely parses; it drives review depth.
- **`<profile>`** is OPTIONAL and project-specific — one of the
  profile names defined above (`handbook`, `crosschain-deploy`,
  `design-doc`, future additions). Profile keywords are project-
  internal scoping that *may* shape Codex's focus areas; their
  literal effect on Codex's review prompt is not externally
  guaranteed — empirically suspected to be read as context but not
  verified. Always include the explicit `<mode>` even if a profile's
  definition implies one — that way the mode-driven review depth
  applies regardless of how Codex handles the profile keyword.

When a trigger uses a profile suffix, include a short caption directly
underneath it so a reader new to the project doesn't have to look up
project-specific terminology. **Permanent convention** — keep it on
every PR going forward, not just the early ones. The audience is
future contributors (including community PRs) who land cold without
having read this file yet; one inline line of self-documentation is
cheap and discoverable.

Caption template — substitute the actual mode + profile:

> *`<mode>` = canonical Codex mode; `<profile>` = project profile
> (see [AGENTS.md](AGENTS.md)).*

Sub-rules:

- **First trigger in each PR**: always include the caption.
- **Re-triggers later in the same PR** (after a fix push): caption
  can be omitted — the first one is visible above in the same
  thread.
- **Profile-less triggers** (e.g. `@codex review full` with no
  profile suffix): no caption needed — nothing project-specific to
  explain.

## PR Push and Review Trigger Account Procedure

When updating PRs in this repository, keep Git writes and trigger comments
separate so branch protection and attribution stay clean:

- Push code, docs, config, and workflow diffs with the local `Raja4Shekar`
  GitHub account when that account is available. Commits from this path are
  expected to be signed and satisfy the repository's verified-signature rule.
- Use the GitHub connector `vaipakam` account only for posting review trigger
  comments such as `@claude adversarial-review`. Do not use the connector
  to create or update files unless the user explicitly approves that trade-off.
- After every push to an active PR, post the requested trigger comment from the
  connector account. The standing trigger for Claude-only review rounds is:
  `@claude adversarial-review`.
- Do not post Codex trigger comments unless the user explicitly asks for one.
- If a workflow-file change is needed and the local token lacks `workflow`
  scope, stop and ask the user to refresh local auth/scope. Do not fall back to
  connector-created workflow commits when verified signatures are required.
- For monitoring review feedback, poll PR comments/checks on a short cadence
  during active work, typically every five minutes, to get new PR comments
  without requiring a notification workflow. Do not add a notification workflow
  unless the user explicitly asks to revisit that approach.

## Verification history — what we know about AGENTS.md being read

| Date | Evidence | Conclusion |
|---|---|---|
| 2026-05-20 (PR #108) | Canary string + self-report directive added to AGENTS.md (PR #105), then a PR opened after #105 merged. Codex's review body did NOT echo the canary nor include a self-report block, even though both were in `main`'s AGENTS.md at review time. | AGENTS.md **presentation-meta directives** (canary, self-report block) are NOT honoured — almost certainly intentional prompt-injection defense in Codex's review-body template. The canary mechanism was removed in that same PR as inert clutter. |
| (open) | Substantive probe — add a profile-specific rule violation to a future PR, observe whether Codex catches it specifically because of AGENTS.md guidance. | Pending. Tracked as Issue #106. The probe disambiguates "profile keywords read as substantive context" from "profile keywords ignored entirely". |

Until the substantive probe runs, the project's working assumption is
that **mode keywords are definitely parsed; profile keywords are
suspected-read but unverified**. The trigger convention above is
robust to either case.

## AI Agent Comment Attribution

This project follows a simple, consistent convention for comments generated by AI agents.

### Signature Format

AI-generated comments should end with:

```
🤖 Generated with <Agent Model>
```

**Examples:**
- `🤖 Generated with Grok 4.3`
- `🤖 Generated with Grok 4.3 (review)`
- `🤖 Generated with Grok 4.3 (analysis)`
- `🤖 Generated with Codex (review)`

### When the signature is required

- **Required** when an AI agent is posting from a human account (for example, Grok posting via the `@Raja4Shekar` account). In this case the signature provides necessary transparency because the GitHub author field alone would make the comment appear human-written.
- **Not required** when an AI agent is posting from its own dedicated bot account (for example, Codex posting from its official account). In such cases the author identity already clearly signals that the comment is AI-generated.

The guiding principle is simple: readers should never be left unsure whether a comment was written by a human or generated by an AI.

## Reviewing Pull Requests – Workspace & Branch Guidelines

**Scope of this guideline**:  
This section applies **only** when you are performing reviews from inside the dedicated **Review clone** (`/home/pranav/Codes/VaipakamReview/vaipakam/`). 

It does **not** apply to:
- Reviews done directly on the GitHub website
- Reviews performed from the main development clone (`/home/pranav/Codes/Vaipakam/vaipakam/`)
- Any other environment or workflow

### Rule for Code Reviews (Review Clone Only)

When reviewing a pull request from the Review clone, you **must** fetch the PR branch locally before conducting any meaningful review.

**Critical requirement**: Do **not** begin a deep review of a PR (especially anything beyond trivial changes) without first fetching the PR's branch into the Review clone.

**Recommended workflow** (always run from the Review clone):

**Important**: Always refresh the PR's actual base branch from the remote **together with** the PR branch before reviewing. Most PRs target `main`, but stacked PRs and release-branch PRs target other bases — diffing a stacked PR against `main` would silently fold in the parent stack's changes and mislead the review.

1. Find the PR's base branch, refresh it from the remote, and check out the PR branch:
   ```bash
   BASE=$(gh pr view <PR-number> --json baseRefName -q .baseRefName)
   git fetch origin "$BASE"
   gh pr checkout <PR-number> --force
   ```

   Or as a combined one-liner:
   ```bash
   BASE=$(gh pr view <PR-number> --json baseRefName -q .baseRefName) && git fetch origin "$BASE" && gh pr checkout <PR-number> --force
   ```

   The `--force` flag matters on re-reviews. If the local PR branch already exists from a prior round and the author force-pushed since, plain `gh pr checkout <PR-number>` does NOT reset to the latest tip — it leaves you reviewing stale history. `--force` resets the existing local branch to the PR's current head (per the `gh` CLI docs), so the cleanup-after-review rule below is belt-and-braces against the same-day exception window when you intentionally kept the branch around.

2. Review the PR by diffing against the **remote** base ref, not the local branch — `origin/$BASE` is what step 1 just refreshed; the local `$BASE` branch may still be stale, and `git fetch` does NOT move it. The PR branch's ancestry is NOT rebased onto the new base by these commands; you are *comparing* the PR against the latest base, not running on top of it.
   ```bash
   git diff "origin/$BASE...HEAD"   # three-dot: only the PR's own commits
   git log  "origin/$BASE..HEAD"    # two-dot: PR-only commits
   ```
   This lets you use local tools (`grep`, focused tests, file exploration) on the exact PR code with an accurate base for context.

3. After finishing your review, switch back to `main` (the default working branch in the Review clone — even when the PR targeted a different base):
   ```bash
   git checkout main
   ```

### Cleanup After Review (Review Clone Only)

**Cleanup is mandatory** in the Review clone.

After you have completed your review (or review round), you **must** delete the local PR branch. This ensures that any future re-review of the same PR will always start from a fresh fetch of the latest push, rather than reviewing from a potentially stale local branch.

**This cleanup must be performed only in the Review clone.**

Mandatory cleanup steps (while in the Review clone):

```bash
# Switch away from the PR branch
git checkout main

# Delete the local PR branch (force delete if needed)
git branch -D <pr-branch-name>
```

**Temporary exception during active review:**
During an active, same-day review session on a PR (for example, while you are still discussing and iterating with the author), you may keep the branch temporarily. However, once that review round is complete or at the end of the day, you must clean it up.

**Do not** run these cleanup commands in the main development clone (`/home/pranav/Codes/Vaipakam/vaipakam/`) unless you have your own established personal workflow there.

**Relationship to the "keep merged branches" rule** (auto-memory `feedback_keep_merged_branches.md`): that rule says don't pass `--delete-branch` to `gh pr merge` and don't push-delete merged branches; it scopes to **remote** branches on `vaipakam/vaipakam` (kept for post-merge troubleshooting until the project's final-stage sweep). This guideline scopes to **local** working-tree branches in the **Review** clone — a different lifecycle. Both can hold simultaneously: remote merged branches stay on GitHub; local PR-review branches in the Review clone are deleted after each review round.

### Rationale

- Prevents accidental pollution of the active development environment.
- Enables high-quality, thorough reviews by giving full access to local tooling on the exact PR code.
- Maintains clear separation between "building" and "reviewing".
- Keeps the Review clone lightweight through disciplined branch management.

### Failure to follow this guideline

**Failure to follow this guideline** when working inside the Review clone (i.e., reviewing PRs directly against `main` without fetching the branch) is considered insufficient for anything beyond trivial or low-risk changes.

### Graphify Knowledge Graph

When deeper architectural context is needed during reviews, use the graphify knowledge graph located in the main workspace:
`/home/pranav/Codes/Vaipakam/vaipakam/graphify-out/`

