<!--
Vaipakam PR template.

Keep the four sections below (What / Why / Verification / Closes).
Skip a section only if it genuinely doesn't apply (e.g. "Closes" for
a chore that has no tracking Issue), and say "n/a — <reason>".

For the Codex trigger:
- The canonical form is `@codex review <mode> [<profile>]`.
- See [AGENTS.md](AGENTS.md) for `<mode>` and `<profile>` semantics +
  the per-PR caption convention.
-->

## What

<!--
One paragraph (or a table for multi-artefact PRs) summarising the
change at a level a reviewer can grasp without reading the diff.
Mention every NEW file and every TOUCHED subsystem.
-->

## Why

<!--
The motivation. What problem does this solve? Why now? If this is
a follow-up to a prior PR / issue / Codex finding, link it.
-->

## What's deferred (intentional)

<!--
Optional — fill in if you consciously scoped something OUT of this
PR. Helps reviewers calibrate "should this be here?" expectations
and gives the maintainer a queue for follow-up cards.
-->

## Verification

<!--
How did you confirm the change works? Examples:
- `forge build` + `forge test` clean
- `pnpm --filter @vaipakam/<workspace> typecheck` clean
- Local manual test of the affected flow
- New tests added (cite the test file)
- Cross-references in the new docs resolve to existing paths
-->

## Closes

Closes #<N>

<!--
If this PR addresses a project Issue, use `Closes #N` so the
@vaipakam-labs project card auto-moves to Done on merge. For
multi-issue PRs use multiple `Closes` lines.
-->

---

## Codex review trigger

<!--
Pick the canonical mode + (optional) project profile per AGENTS.md:
- mode: normal | adversarial | full | full security-critical
- profile (optional): handbook | crosschain-deploy | design-doc | …

The default for any "In review" card is `full`. Add a profile suffix
only when the PR-class is well-known (handbook PR, cross-chain
deploy PR, design-doc PR). See AGENTS.md for definitions.

Always include the caption directly below the trigger — it
documents the project-specific vocabulary for community contributors
landing cold.
-->

@codex review full

> *`full` = canonical Codex mode (no project profile applied here).*
