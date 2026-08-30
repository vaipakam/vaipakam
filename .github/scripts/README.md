# Prose gates

The blocking gates in this directory are the ones listed below — **the list is
the count**; there is deliberately no number in this sentence to keep in sync
with it. An earlier revision opened "**Two** blocking gates live here", and
adding the third made that wrong in the same commit, in the handbook whose
whole subject is prose nothing re-checks. `check-cron-slots.mjs` exists because
one number was restated in ten places and all ten were wrong together (#1977);
finding its own count stale here, one gate later, is the argument for the gate
rather than a footnote to it.

They exist for the same reason — prose has no compiler, so a rename, a removal,
or a copied number leaves behind text that nothing checks.

1. **No operator runbook may cite a directory that no longer exists** —
   `docs-citations.mjs` + `check-docs-paths.mjs` (below).
2. **The #687-A VPFI buy surface must not be described as live again** —
   `check-excision-residue.mjs`, a count-and-digest RATCHET rather than a ban.
   Scope is the whole tracked tree minus the historical-narrative directories;
   matching is on normalized text, so the prose spelling "VPFI buy adapter" is
   caught alongside the identifier `VpfiBuyAdapter`. Each file's mention count
   AND a digest of the mentions are pinned in the script, so growth, cleanup,
   and equal-count substitutions all fail — each with its own message telling
   you which. Exclusions are directory-level only for genuinely archival trees;
   anywhere the surrounding tree is still active they are per-file. When it
   fires: read the mention; fix the text if it presents the removed surface as
   live, or re-pin if it is a deliberate retraction note. Run it with
   `node .github/scripts/check-excision-residue.mjs`, and regenerate the ledger
   with `--write-pins` (which keeps existing reasons — review the diff, and
   treat any reason still reading `UNTRIAGED` as unread).
3. **No file outside the authority may restate how many of the account's five
   Cloudflare cron triggers are spoken for** — `check-cron-slots.mjs`. The one
   place that states it is [`docs/ops/CloudflareCronSlots.md`](../../docs/ops/CloudflareCronSlots.md),
   which carries the timestamp it was last read from the account. Stating the
   CAP is fine and deliberately permitted; stating the OCCUPANCY is what
   fires. It has three modes:

   ```bash
   node .github/scripts/check-cron-slots.mjs             # offline: the scan + the authority's self-consistency
   node .github/scripts/check-cron-slots.mjs --selftest   # the gate's own fixtures
   node .github/scripts/check-cron-slots.mjs --live       # diff the inventory against the ACCOUNT
   ```

   CI runs the first two. `--live` needs `CLOUDFLARE_API_TOKEN` +
   `CLOUDFLARE_ACCOUNT_ID` (Workers Scripts read; it makes no writes) and is
   the **only** mode that can tell whether the inventory is current — a green
   offline run means "nobody re-copied the count", not "the count is right".

All of these run in `release-notes-drift.yml`.

The path checker is two files, both small:

| File | Role |
| --- | --- |
| `docs-citations.mjs` | scope + extraction — which documents, and which fragments look like path citations |
| `check-docs-paths.mjs` | adjudication — the one rule, and the criterion any future rule must meet |

It exists because of a specific observation: when the same defect shows up in a
new document each review round, that is a class, and a class cannot be closed by
fixing instances. Code classes can be closed with a type. Prose classes cannot —
nothing tells the author of a rename which documents mention the old name — so
the only durable close is a machine that re-checks on every change. The Stage 3
refactor left 147 references to the removed `frontend/` across 39 documents
(#1462).

```bash
node .github/scripts/check-docs-paths.mjs
```

Wired into `.github/workflows/release-notes-drift.yml` on pushes to `main` and
on **every** pull request. No `paths:` filter: any tracked file can be the
*target* of a citation, so deleting one makes a document stale without touching
that document, and a filter listing inputs can never enumerate that.

## The admission criterion

The extractor is **deliberately loose**. It over-matches, and it will hand the
adjudicator fragments that are not citations at all. That is the design, not an
apology — a precise markdown extractor is a real parser or nothing, and eleven
rounds of review on #1467 demonstrated that patching patterns toward precision
does not converge.

The correctness burden therefore sits with the rule:

> **A rule may ship here only if its finding is a real defect of the document
> text even when the fragment it fired on is malformed.**

(Round 12 falsified a stronger earlier wording — "over-extraction cannot make
the rule fire". It can: a malformed non-link such as `[x](frontend/ghost"x")`
extracts a fragment starting with the dead name, and the gate fires. But the
text it fired on genuinely names the removed directory, which is the defect
itself — the finding stays truthful. Immunity holds only for exact equality;
truthfulness under over-extraction is the property that survives.)

Rules come in two shapes, and they react to a loose extractor in opposite ways:

| Shape | Question | With a loose extractor |
| --- | --- | --- |
| **closed-world positive** | does this fragment contain one of these two known-dead names? | a hit means the text really names the dead directory — defects cause **misses**, never a finding about nothing |
| **open-world negative** | is this fragment absent from the tracked tree? | every junk fragment is absent — defects become **false alarms about nothing** |

The shipped rule is the first shape. The review record bears the distinction out
exactly: all six extraction defects found on #1467 became false alarms *only*
through an open-world rule, and five of seven adjudication defects landed on one
too — including 44 frozen false findings from a single dot-directory bug.

A miss is a smaller harm than a false alarm here, because a check that cries
wolf is one people learn to ignore, and then it protects nothing.

**Three open-world rules were built on this branch and deferred**, each needing
a precise extractor:

- does-it-exist against the tracked tree — **#1486**
- non-canonical `/app/…` URL citations — **#1479**
- secrets reaching a command's `argv` — **#1472**

Each was deferred separately, on its own judgement call, before anyone noticed
they fail the same test. That they fall out of one criterion is the evidence the
criterion is real rather than a rationalisation. When one is picked up, the move
is to implement a parser **behind** `docs-citations.mjs`, not to tighten the
patterns in front of it.

## Why it gates at zero, with no baseline

Earlier revisions of this PR carried a ratchet — a committed baseline of finding
identities, a growth guard, rename detection, per-finding fingerprints. All of
it existed for one reason: the check was red on arrival, and the backlog was
assumed unclearable.

**The platform is pre-live, which makes that assumption false where it counts.**
The operator-facing slice was 72 citations across 6 runbooks with knowable
targets, so it was *fixed* rather than frozen. With the gated scope clean, the
baseline, the ratchet, and the follow-up card to flip it into a gate are all
unnecessary. A failure now always means a **new** stale citation.

That is a stronger bar than the ratchet ever was, and about 700 fewer lines.

## Scope

`docs/ops/` — where a stale path costs a person real time, and the slice that
has actually been cleaned.

The wider doc set still holds ~137 stale citations, in design docs and closed
to-do entries. Some of those **must not** be rewritten: `Stage3WorkerSplitPlan.md`
*documents* the removal of `ops/hf-watcher`, so it has to name it. Clearing what
should be cleared is **#1462**, and doing so is what allows this scope to widen.
Widening it before then would just re-create the red-on-arrival problem the
ratchet was invented to paper over.

## Maintaining it

`REMOVED_DIRS` in `check-docs-paths.mjs` is the one manual list. Add an entry
whenever a directory is deleted or moved — the person doing the rename is the
only one who knows it happened, and everything downstream is derived.

**Run `git ls-files <dir>` before adding one.** `ops/lz-watcher/` was listed
there while still fully tracked — 16 files, its decommission recorded as
deferred — which made two live citations read as nonexistent. The check
asserting a fact the tree contradicts is the one failure this rule can still
have, and it is a human one.

## What it does not do

Stated because a green run is not a proof, and treating it as one is the failure
mode this exists to prevent:

- It closes *staleness of removed directories*, not general accuracy. A path
  that exists but is the wrong one reads as fine.
- A stale name in a citation form the loose extractor misses is not caught. That
  is the deliberate trade above: misses over false alarms.
- Nothing outside a code span or a link destination is examined. Prose
  legitimately contains the word "frontend", and a bare-word rule would fire on
  ordinary English.
