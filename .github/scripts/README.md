# Mechanical docs checks

Two checks that close defect classes review kept re-finding in prose, plus
the ratchet they share.

They exist because of a specific observation: when the same defect shows up
in a new document each review round, that is a class, and a class cannot be
closed by fixing instances. Code classes can be closed with a type. Prose
classes cannot — nothing tells the author of a rename which documents
mention the old name — so the only durable close is a machine that re-checks
on every change.

| Script | Class it closes | Why it recurred |
| --- | --- | --- |
| `check-docs-secret-argv.mjs` | A credential reaching an external command's `argv`, where any other user reads it from `ps` / `/proc/<pid>/cmdline` | Found in three separate runbook steps across three review rounds on #1450. In each case the prose around it was careful about secrets; the command was not. |
| `check-docs-paths.mjs` | A cited repo path or `/app/...` route that does not exist | 147 references to the removed `frontend/` directory across 39 documents (#1462), and `/app/alerts` wrong in three documents at once — including an incident-runbook verification step that would have landed an operator on a blank page. |

## Running them

```bash
node .github/scripts/check-docs-secret-argv.mjs
node .github/scripts/check-docs-paths.mjs
```

Both are wired into `.github/workflows/release-notes-drift.yml`, on pushes
to `main` and on PRs that touch `docs/`.

## The ratchet, and why the bar is not zero

Both checks are red on their first run — 10 and 203 findings — because they
describe a real backlog that is already tracked. So they compare against a
committed per-file baseline and fail only when a file **gains** findings.

Two reasons the bar is a ratchet rather than zero:

- A check that is red on the day it lands gets muted, and a muted check is
  worse than no check because it looks like coverage.
- Part of the backlog **must not** be cleared. `docs/ToDo.md`'s closed
  entries and the design docs' historical references describe what was true
  when written; rewriting them falsifies the record. That is exactly why
  #1462 is a scoped card rather than a find-and-replace.

Regenerate a baseline deliberately, never reflexively:

```bash
node .github/scripts/check-docs-paths.mjs --write-baseline
```

A rise is the check working. Only lower a count you have actually fixed —
the checks report improvements loudly, because a baseline sitting above
reality silently re-permits what someone just fixed.

## What they do not do

Stated because a green run is not a proof, and treating it as one is the
failure mode these are meant to prevent:

- **`check-docs-secret-argv`** cannot see a secret passed through a variable
  it cannot tell is a secret (`$X`, `$1`), an external command absent from
  its list, or anything outside `docs/`. It deliberately does not flag shell
  **builtins** — `printf 'fmt' "$TOKEN" | curl -K -` is the *recommended*
  pattern precisely because `printf` is a builtin, so no separate process
  exists and nothing enters any `argv`.
- **`check-docs-paths`** closes *staleness*, not *accuracy*: a path that
  exists but is the wrong one reads as fine. The does-it-exist rule runs
  only under `docs/ops/` and `docs/FunctionalSpecs/`, because repo-wide it
  produced 296 findings — design docs legitimately cite planned files. The
  removed-directory rule runs everywhere and is the zero-false-positive
  core.

**They are currently non-blocking**, matching this workflow's existing
philosophy. That is a real limitation, not an oversight: a warning does not
stop a new instance merging, so the class is observed rather than closed.

Becoming a gate is the intended end state, tracked with its trigger
conditions on **#1468** — delete the `exit 0` at the end of the *Mechanical
docs checks* step; the scripts already exit non-zero on a regression.

Two rules for that flip, both there for a reason:

- **Keep the ratchet.** Gating on a zero *total* would demand rewriting
  historical records, which falsifies them.
- **A legitimate exception gets an allowlist entry with a stated reason**,
  the shape `apps/indexer/scripts/check-event-coverage.mjs` uses for
  `DELIBERATELY_NOT_HANDLED` — not a silent baseline raise. A raised
  baseline records that something is permitted without recording why.

## Maintaining them

`check-docs-paths.mjs` has one manual list — `REMOVED_DIRS`. Add an entry
whenever a directory is deleted or moved. That is the right place for the
manual step: the person doing the rename is the only one who knows it
happened, and everything downstream of that fact is then derived.

The route list is **derived** from `apps/defi/src/App.tsx` and must stay
that way. A hand-kept copy would be a second thing to drift, which is the
defect this check exists to catch.
