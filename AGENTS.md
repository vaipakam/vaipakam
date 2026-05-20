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
- liquidation, settlement, escrow, treasury, oracle, or cross-chain logic;
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

## Reviewer self-report

So the project can verify that automated reviewers are honoring this
file (rather than running defaults and ignoring the profile guidance),
every review you post on a PR in this repo MUST begin with a short
self-report block of the form:

```
**Review applied:** mode=<normal|adversarial|full|full-security-critical>; profile(s)=<name(s) or "none">.
**Focus areas covered:** <one-line summary of the profile-specific checks you ran>.
```

This block goes at the very top of the review body (before any
findings). It is purely instrumental — its purpose is to confirm that
the AGENTS.md vocabulary in the trigger comment is being parsed and
that profile-specific focus areas are being executed, not silently
dropped to defaults.

If the trigger comment named a mode or profile that isn't recognised,
state that explicitly in the self-report ("`profile(s)=unknown:foo —
treated as no-profile`") rather than silently falling through. Wrong-
mode triggers are project bugs to be surfaced, not absorbed.

## Canary line

The presence of this canary string in your review somewhere — once per
PR review is enough — confirms you've read this file at review time
rather than relying on cached / default behaviour:

> **`VAIPAKAM-AGENTS-MD-CANARY-2026-05-20-A1`**

Quote it verbatim inside a backtick block in your review body (or
embedded in the self-report block above). If you cannot quote it for
any reason, say so in the self-report and explain why — that's also
informative.

Both this canary and the self-report block can be removed from this
file once we have stable empirical evidence that AGENTS.md is being
honored across reviewers. Until then they stay.
