<!--
Vaipakam PR template.

Keep the four sections below (What / Why / Verification / Closes).
Skip a section only if it genuinely doesn't apply (e.g. "Closes" for
a chore that has no tracking Issue), and say "n/a — <reason>".

For the Codex trigger:
- The canonical form is `@codex review <mode> [<profile>]`.
- See [AGENTS.md](https://github.com/vaipakam/vaipakam/blob/main/AGENTS.md)
  for `<mode>` and `<profile>` semantics + the per-PR caption
  convention. (Absolute URL because this template's relative link
  `[AGENTS.md](AGENTS.md)` doesn't reliably resolve once the body is
  injected into a PR description — PR bodies render outside any
  file-relative context.)
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

## Statements

<!--
The canonical statements this change implements (docs/CanonicalSpec/),
by id, one per line, e.g. a vault statement's id. If it changes no
behaviour, write "No behaviour change". If it changes behaviour that no
canonical section covers yet, write "No canonical section covers this
change; looked in <code>", naming on the same line the domain you looked
in (a code such as OFR or LON) so a reviewer can check it.
docs/FunctionalSpecs/ still states that intent, and builders do not edit
it: out-of-date lines go on the owner's list.

Ids 900 to 999 are reserved. Never write one here or in any public text,
and never say what such a statement covers.

A design that changes a canonical statement brings the statement change
to the owner with the design. The folder changes only after approval,
and only by the thread that keeps it; a pull request never edits it.
The merge check on main reads this section.
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

A batch PR that carries several finished issues lists one `Closes #N`
line for every issue it completes, never "n/a". An issue the PR only
partly delivers gets "Advances #N" and a comment on the issue naming
what is left and which area owns it (2026-11-19: batch #3743 said
"n/a" and left about 30 finished cards open).
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
