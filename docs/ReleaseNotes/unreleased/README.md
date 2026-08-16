# Unreleased release-note fragments

Every PR that changes behaviour — contracts, apps, scripts, meaningful
docs — **carries its own release-note fragment in its own diff**, dropped
into this directory. The fragment is written by whoever did the work, as
part of the PR, so release notes can never lag behind a merge and two
PRs landing the same day never append-conflict.

## Adding a fragment

1. Copy [`_TEMPLATE.md`](_TEMPLATE.md) to a new file in this directory
   named `<TASK-ID>-<short-slug>.md` — e.g. `T-068-ccip-migration.md`,
   `EC-007-partial-match-claim-fix.md`. (The task id prefix gives a
   stable assembly order.)
2. Write the thread in plain English — what changed and why, for a
   developer/operator reader. **No code snippets.** Match the tone of the
   committed `ReleaseNotes-<date>.md` files.
3. Commit it as part of the PR.

`README.md` and `_TEMPLATE.md` are ignored by the assembler — every
other `*.md` here is a pending fragment.

## Relative links to other docs

Write relative links in fragments **from the assembled file's
perspective** (`docs/ReleaseNotes/<date>.md`), not from the
fragment's own location (`docs/ReleaseNotes/unreleased/<frag>.md`).
Links you write that way are already correct and the assembler
leaves them alone. The assembler only intervenes when a fragment
uses a fragment-perspective path or an unsafe same-dir reference:

| What you write in a fragment | What lands in the assembled file |
|---|---|
| `](../DesignsAndPlans/X.md)` — correct from `docs/ReleaseNotes/<date>.md` (recommended) | **unchanged** |
| `](DesignsAndPlans/X.md)` — would point at non-existent `docs/ReleaseNotes/DesignsAndPlans/` | **unchanged** (author's mistake; assembler doesn't second-guess) |
| `](../../DesignsAndPlans/X.md)` — fragment-perspective deep path | rewritten to `](../DesignsAndPlans/X.md)` |
| `](./X.md)` — meant `unreleased/X.md`, doesn't survive assembly | rewritten to `](../X.md)` |

The rewriter is purely two narrow substitutions: `](../../` →
`](../`, and `](./` → `](../`. It does **not** touch a single-level
`](../X)` (that's already correct after assembly) or a bare
`](X)` (which is the assembler's directory, also already correct).

The original Codex-flagged link on PR #275
(`../../DesignsAndPlans/UxDirectionDexCexHybrid.md`) was correct
for the fragment's location but broke after fold; the assembler
now rewrites it to `../DesignsAndPlans/...` automatically.

## Assembling a day's notes

After the day's PRs have merged, fold the fragments into the dated file:

```bash
bash docs/ReleaseNotes/assemble.sh            # uses today's UTC date
bash docs/ReleaseNotes/assemble.sh 2026-05-20 # or an explicit date
```

The script concatenates the fragments belonging to that day into
`ReleaseNotes-<date>.md` (creating it with a header if absent, appending
if it already exists), then removes the consumed fragments. Review the
result, add an intro paragraph, and commit:

```bash
git add -A docs/ReleaseNotes/
git commit -m "docs: release notes <date>"
```

### The date is the fragment's UTC merge day

A fragment belongs to the day its PR merged **in UTC** — the clock
`assemble.sh` uses when you pass no date. Local time is a trap here: at
`+05:30` every merge between 18:30 and midnight UTC shows a local date
one day ahead, so assembling "today" locally files those fragments a day
late. That misfiling has happened twice.

So a run takes only the fragments whose add-commit lands on the day being
assembled. Anything from another day is named, told which day it belongs
to, and left in place for its own run. A backlog spanning two days is
cleared by running the script once per day:

```bash
bash docs/ReleaseNotes/assemble.sh 2026-08-16
bash docs/ReleaseNotes/assemble.sh 2026-08-17
```

Three things worth knowing:

- **`--allow-mixed-dates`** takes every pending fragment regardless of
  day, for when folding them together is deliberate.
- **A fragment with no add-commit is always taken.** That is one written
  and assembled inside the same PR — it has no day of its own yet, so it
  belongs to the run creating it.
- **A shallow clone is refused.** A fragment older than the shallow
  boundary reports the boundary commit's date rather than its own, which
  looks entirely ordinary and is wrong. Run `git fetch --unshallow` first.
  A repository whose history cannot be read at all stops the run for the
  same reason. **A committed rename is safe** — it is followed back to
  where the fragment was written, so retitling one to match its PR number
  does not re-date it.
- **An uncommitted rename is only recoverable if git can pair the two
  names.** `git mv` (or staging the rename) lets it: a plain `mv` left
  unstaged reads as a brand-new fragment, since pairing needs the index.
  Even staged, pairing is rename *detection* by similarity — `git mv`
  plus a substantial rewrite drops below the threshold and reads as an
  unrelated add and delete. The run announces that state rather than
  guessing; commit the rename first if the original day matters.
- **A reused filename does not inherit the old file's day.** History is
  keyed by path, so an assembled-and-deleted `123-task.md` keeps its
  add-commit forever. A new fragment reusing that name is dated as new.

[`assemble.test.sh`](../assemble.test.sh) covers all of this against
throwaway repositories with fragments committed at chosen UTC timestamps;
run it after any change to the assembler.

See [`feedback_post_merge_definition_of_done`] in agent memory and the
"Release notes" section of `CLAUDE.md` for the surrounding workflow.
