# Mechanical docs checks

One check that closes a defect class review kept re-finding in prose, plus
the ratchet it uses.

A companion **secrets-in-argv** check was built alongside it and **deferred to
#1472**. It found 28 real instances where review had found 3, so the class is
worth closing — but answering "does this value reach a process's argv"
correctly needs real shell parsing, and successive review rounds kept finding
cases the approximation got wrong, including flagging the pattern the docs
recommend. A wrong check is worse than none, so it ships when it is right.

They exist because of a specific observation: when the same defect shows up
in a new document each review round, that is a class, and a class cannot be
closed by fixing instances. Code classes can be closed with a type. Prose
classes cannot — nothing tells the author of a rename which documents
mention the old name — so the only durable close is a machine that re-checks
on every change.

| Script | Class it closes | Why it recurred |
| --- | --- | --- |
| `check-docs-paths.mjs` | A cited repo path or `/app/...` route that does not exist | 147 references to the removed `frontend/` directory across 39 documents (#1462), and `/app/alerts` wrong in three documents at once — including an incident-runbook verification step that would have landed an operator on a blank page. |

## Running them

```bash
node .github/scripts/check-docs-paths.mjs
```

Both are wired into `.github/workflows/release-notes-drift.yml`, on pushes
to `main` and on PRs that touch `docs/`.

## The ratchet, and why the bar is not zero

The check is red on its first run — 266 findings — because it
describes a real backlog that is already tracked. So it compares against a
committed per-file baseline of finding **identities** and fail when a file
gains one that is not in the baseline.

Identities, not counts (#1467 r1): a count-only bar permits swapping one
stale route for a *different* stale route, since the total is unchanged, and
banks reusable headroom after any unlowered improvement. Each fingerprint is
the finding's subject plus an occurrence ordinal — the ordinal so a third
instance of an already-known subject still registers, and no line number so
edits above a finding do not read as regressions.

**Existence is decided from the tracked tree, not the working tree.** Using
`existsSync` made the verdict depend on whichever untracked files happened to
be present: `contracts/.env` exists on a developer's machine and not in CI,
so a locally generated baseline was short of what CI would compute and the
check would have warned from its first run — the exact red-on-arrival failure
the ratchet exists to prevent.

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

- **`check-docs-paths`** closes *staleness*, not *accuracy*: a path that
  exists but is the wrong one reads as fine. The does-it-exist rule runs only
  under `docs/ops/` and `docs/FunctionalSpecs/`, because repo-wide it
  produced far more findings than anyone would read — design docs
  legitimately cite planned files. The removed-directory rule runs everywhere
  and is the zero-false-positive core. Relative link targets are resolved
  against the citing document, and query strings and fragments are stripped
  before matching — both were blind spots that let stale references through
  (#1467 r1).

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

## Two guards on the ratchet itself

Both added after review showed the ratchet was bypassable by the exact move
this README forbids.

**The baseline may not GROW.** `--write-baseline` records whatever is
currently found, so without this a contributor could add a finding and commit
a regenerated baseline in the same change — the ordinary check would then see
no regression. Verified in review, and it would have made the eventual gate
(#1468) bypassable. The baseline is now compared against its state at the
**merge base with `main`**, and any added entry fails.

*Inherent limitation, stated because a green run should not be read as more
than it is:* this guard cannot protect the commit that **introduces** the
baseline, because there is no earlier version to compare against. It says so
at runtime rather than passing quietly. The 266 initial entries are taken on
human review; everything after them is guarded.

**Obsolete entries must be cleaned up.** A fix that leaves its baseline entry
behind banks headroom — the same fingerprint can be reintroduced later and
match. Fixing a finding now fails the check until the baseline is regenerated,
which is what makes the fix permanent.
