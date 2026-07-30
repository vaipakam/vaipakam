# Mechanical docs checks

One check that closes a defect class review kept re-finding in prose, plus
the ratchet it uses.

It exists because of a specific observation: when the same defect shows up in
a new document each review round, that is a class, and a class cannot be
closed by fixing instances. Code classes can be closed with a type. Prose
classes cannot — nothing tells the author of a rename which documents mention
the old name — so the only durable close is a machine that re-checks on every
change.

| Script | Class it closes | Why it recurred |
| --- | --- | --- |
| `check-docs-paths.mjs` | A cited repo path that does not exist, or that names a directory which was removed or renamed | 147 references to the removed `frontend/` directory survived across 39 documents (#1462) — an operator following one looks for a file that is not there |

## Running it

```bash
node .github/scripts/check-docs-paths.mjs
```

It is wired into `.github/workflows/release-notes-drift.yml`, on pushes to
`main` and on **every** pull request. There is deliberately no `paths:`
filter: any tracked file can be the *target* of a citation, so deleting one
makes a document stale without touching that document, and a filter listing
inputs can never enumerate that (#1467 r3).

## Two halves that were built and NOT shipped

Both are recorded with their findings rather than merged, for the same reason.

**Secrets in a command's argv — #1472.** It found 28 real instances where
review had found 3, so the class is worth closing. But answering "does this
value reach a process's `argv`" correctly needs real shell parsing, and
successive review rounds kept finding cases the approximation got wrong —
including flagging the pattern the docs recommend (`printf … | curl -K -`,
which is safe precisely because `printf` is a builtin).

**Non-canonical `/app/…` URLs — #1479.** Four rounds; each closed a real gap
and the next found another citation form the pattern mishandled: a bare
`/app`, a trailing slash, a locale prefix (`/es/app/alerts`), a same-origin
absolute URL. Citation forms are an unbounded set, so a pattern over them is a
heuristic. What shipped is a set-membership test over `REMOVED_DIRS` plus the
tracked tree, which is decidable.

Shipping the decidable half alone is the point, not a compromise: **a check
that is sometimes wrong teaches people to ignore the one that never is.**

The route work did leave two durable results. The five stale `/app` citations
it found are corrected. And it disproved a claim that had been asserted three
times — that `/app/alerts` shows an operator a blank page. It does not:
`App.tsx` nests the page tree under `<Route path=":locale">` and
`LocaleResolver` falls back to English for an unrecognised first segment while
still rendering its outlet, so the old form resolves. Those citations are the
wrong address to publish, not dead links. Any future version of the check must
say so in its finding text, or readers inherit the wrong model from it.

## The ratchet, and why the bar is not zero

The check is red on its first run — 196 findings — because it describes a
real backlog that is already tracked. So it compares against a committed
per-file baseline of finding **identities** and fails when a file gains one
that is not in the baseline.

Identities, not counts (#1467 r1): a count-only bar permits swapping one
stale path for a *different* stale path, since the total is unchanged, and
banks reusable headroom after any unlowered improvement.

A fingerprint is the finding's **subject**, a hash of the **citing line's
normalised text**, and an occurrence ordinal. The line's text rather than its
number, because the point is to survive edits *elsewhere* in the document while
still distinguishing one occurrence from another — the ordinal alone did not
(#1467 r6): removing a frozen `frontend/` citation and adding a different one
later in the same file left the key multiset identical, so a genuinely new
stale instruction passed as "known".

The two guards deliberately use **different** identities, because they ask
different questions. The regression check asks "is this citation new", and
answers it with the full fingerprint. The growth guard asks "did a permanent
exemption get added", and answers it by counting per subject — rewording the
line around an already-frozen citation re-keys its fingerprint while exempting
nothing further, and failing that would make ordinary documentation edits
impossible, which is how a check gets deleted rather than fixed.

*The cost of that split, stated because a green run should not be read as more
than it is:* a change that relocates a frozen citation — one occurrence removed,
a different one of the same subject added — **and** regenerates the baseline in
the same commit passes CI. Without the regeneration it is caught. With one it is
visible as a replaced fingerprint in the baseline diff, which is a review
surface rather than a CI one.

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
  when written; rewriting them falsifies the record. `Stage3WorkerSplitPlan.md`
  is the clearest case — it *documents* the removal of `ops/hf-watcher`, so it
  has to name it. That is exactly why #1462 is a scoped card rather than a
  find-and-replace.

Regenerate a baseline deliberately, never reflexively:

```bash
node .github/scripts/check-docs-paths.mjs --write-baseline
```

A rise is the check working. Only lower a count you have actually fixed —
the check reports improvements loudly, because a baseline sitting above
reality silently re-permits what someone just fixed.

## What it does not do

Stated because a green run is not a proof, and treating it as one is the
failure mode this exists to prevent:

- It closes *staleness*, not *accuracy*: a path that exists but is the wrong
  one reads as fine.
- The does-it-exist rule runs only under `docs/ops/` and
  `docs/FunctionalSpecs/`, because repo-wide it produced far more findings
  than anyone would read — design docs legitimately cite planned files. The
  removed-directory rule runs everywhere and is the zero-false-positive core.
- A markdown destination is resolved against its own document, since that is
  how it actually renders; a backticked path is read from the repository root,
  which is this repo's citation form. Collapsing the two made a genuinely
  broken link read as fine (#1467 r2) — it found 78 in `ProjectDetailsREADME.md`
  alone, all now corrected. Only `./` and `../` make a *backticked* token
  document-relative: treating every dot-prefixed token that way resolved
  `.env` and `.github/…` beneath the citing document and froze 44 false
  findings in the baseline (#1467 r6).
- A markdown destination skips the recognised-root gate entirely, because a
  destination is never prose — it is a promise that clicking it lands
  somewhere. Gating it left two holes: a destination climbing out of the
  repository normalised to `../…` and matched no root, and the root list is
  derived from the current tree, so deleting the last file under a top-level
  directory stopped every stale link into it from being checked in the same
  commit that broke them (#1467 r6).
- Paths inside `<!-- HTML comments -->` are ignored. A finding no reader of the
  rendered document can see is unactionable noise, and this check's whole claim
  is that its signal is worth reading (#1467 r6).
- **A path the repository deliberately ignores is not stale.** A runbook telling
  an operator to create `contracts/.env` is correct, and `.gitignore` is the
  repo's own statement that the file is meant to be untracked — which is what
  makes this decidable rather than a guess (#1467 r9). It removed 7 frozen false
  findings. It does NOT cover an artifact that is neither tracked nor ignored;
  nothing distinguishes one of those from a typo, so that is a case for a
  reasoned allowlist entry at gate-flip time (#1468), not a silent exemption.
  Only a **committed** `.gitignore` counts: `git check-ignore` also consults
  `core.excludesFile` and `.git/info/exclude`, and honouring those would put the
  verdict back under the developer's own configuration — the environment
  dependence that replacing `existsSync` with the tracked tree removed in r1
  (#1467 r10). Candidates that normalise outside the repository are dropped
  before the batch, because one of them makes Git exit non-zero for the WHOLE
  batch and every legitimate exemption would be lost with it.
- **A submodule root is a directory**, even though `git ls-files` reports it as a
  single gitlink entry with no children (#1467 r10).
- **A trailing slash means directory**, so it only resolves as one. Stripping it
  before the lookup let `contracts/README.md/` resolve as the tracked file,
  though a file cannot be traversed as a directory (#1467 r9).
- **The document is scanned whole, not line by line.** CommonMark lets a
  destination sit on the line after its opener, so a line-at-a-time scan never
  saw the opener and the destination together and a link written that way
  bypassed the check entirely (#1467 r9). Separating whitespace is bounded to a
  single newline, because a blank line ends a link — allowing more would match
  text that is not a link.
- Both standard markdown destination forms are parsed — a titled inline
  destination and a reference definition. The earlier inline-only pattern saw
  neither (#1467 r6).

**It is currently non-blocking**, matching this workflow's existing
philosophy. That is a real limitation, not an oversight: a warning does not
stop a new instance merging, so the class is observed rather than closed.

Becoming a gate is the intended end state, tracked with its trigger
conditions on **#1468** — delete the `exit 0` at the end of the *Mechanical
docs checks* step; the script already exits non-zero on a regression.

Two rules for that flip, both there for a reason:

- **Keep the ratchet.** Gating on a zero *total* would demand rewriting
  historical records, which falsifies them.
- **A legitimate exception gets an allowlist entry with a stated reason**,
  the shape `apps/indexer/scripts/check-event-coverage.mjs` uses for
  `DELIBERATELY_NOT_HANDLED` — not a silent baseline raise. A raised
  baseline records that something is permitted without recording why, which
  makes an exception indistinguishable from a regression.

## Maintaining it

`check-docs-paths.mjs` has one manual list — `REMOVED_DIRS`. Add an entry
whenever a directory is deleted or moved. That is the right place for the
manual step: the person doing the rename is the only one who knows it
happened, and everything downstream of that fact is then derived.

**Check `git ls-files <dir>` before adding one.** `ops/lz-watcher/` was listed
there while still fully tracked (#1467 r5), which made two live citations read
as nonexistent and would have turned every future one into a false regression
— the check asserting a fact about the tree that the tree contradicts, which
is the very defect it exists to catch.

## Two guards on the ratchet itself

Both added after review showed the ratchet was bypassable by the exact move
this README forbids.

**The baseline may not GROW.** `--write-baseline` records whatever is
currently found, so without this a contributor could add a finding and commit
a regenerated baseline in the same change — the ordinary check would then see
no regression. Verified in review, and it would have made the eventual gate
(#1468) bypassable. The baseline is now compared against its state at the
**merge base** with the revision the workflow event names (`github.event.before`
on a push, the PR's own base branch otherwise — never a hardcoded `main`,
which on a push to `main` compares the baseline with itself). Any added entry
fails, and an explicitly-named base ref that cannot be resolved also fails,
rather than degrading to a warning that would let the guard be bypassed by
breaking it. Git renames are followed, so renaming a document does not read as
a baseline addition.

*Inherent limitation, stated because a green run should not be read as more
than it is:* this guard cannot protect the commit that **introduces** the
baseline, because there is no earlier version to compare against. It says so
at runtime rather than passing quietly. The initial entries are taken on
human review; everything after them is guarded.

**Obsolete entries must be cleaned up.** A fix that leaves its baseline entry
behind banks headroom — the same fingerprint can be reintroduced later and
match. Fixing a finding now fails the check until the baseline is regenerated,
which is what makes the fix permanent.
