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
