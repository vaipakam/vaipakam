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

**If a run is interrupted, run it again** — with one caveat below. The
dated file is built in a temp file and renamed into place at the end, so
it is either the old file or the complete new one, never a partial
append. Each folded
fragment also leaves an invisible HTML-comment marker
(`<!-- assembled-fragment: <name> sha256=<hash> -->`) in the dated file,
which is how a re-run tells a fragment already folded in from one still
pending: it names those, removes them, and does not append them a second
time.

The marker matches on the **hash**, not the name, so editing a pending
fragment after an interrupted run appends the new text rather than
discarding it. Every dated file is searched, so a run resumed after UTC
midnight does not write the same content into two of them.

A fragment is removed without being re-appended only when its marker is
in **the file being assembled** under **the same name** — the signature
of an interrupted run, since resuming one means re-running for the same
day. Any other match stops the run and says what it found: a different
name (a rename, or a fragment that happens to read alike) or a marker in
another dated file (a reused fragment, or a run resumed past UTC
midnight). Delete it by hand if it really is already folded in, or
re-run with `--force-append` if it is genuinely new.

**If the dated file changes while a run is building its replacement, the
run stops.** Assembly copies the existing file, appends to the copy, and
renames the copy into place — so an edit landing in between would be
overwritten while the fragments were consumed and the run reported
success. The lock only keeps two assemblies apart; it does not know
about an editor. The file's identity is re-checked immediately before
the rename, and a change refuses the whole run with nothing consumed.
Re-run once the other change has settled and it is built on top.

**A hard kill can also leave a temp file behind** — a
`.assemble-<date>.XXXXXX` in `docs/ReleaseNotes/`, which is a partly- or
fully-built copy that was never renamed into place. Nothing depends on
it and no dated file is missing anything because of it, but
`git add -A docs/ReleaseNotes/` would stage it, so every later run names
it until it is deleted. Like the lock, it is reported rather than
removed automatically: a temp file belonging to a run that is still
alive looks exactly the same.

**One case needs a manual step first.** Assembly holds a lock
(`unreleased/.assemble.lock`) so two runs cannot overlap, and it is
released when the script exits — including on Ctrl-C. A *hard* kill
(`SIGKILL`, or the machine dying) leaves it behind, and every later run
then stops with "another assembly appears to be running" until it is
cleared. That is deliberate: the lock guards a step that deletes files,
so a stale one is reported rather than broken automatically on a
timer. The error prints the exact command — `rmdir <path>` — and it is
safe to run once you know no other assembly is in progress.

**Leave the markers in place** when editing the assembled notes.
Deleting one makes a re-run duplicate that fragment. If a dated file has
no markers at all (it predates them) and already contains a pending
fragment's heading, the script stops and asks rather than guessing —
`--force-append` overrides it once you have checked (#1788).

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

Worth knowing:

- **`--allow-mixed-dates`** takes every pending fragment regardless of
  day, for when folding them together is deliberate.
- **A fragment with no add-commit is always taken.** That is one written
  and assembled inside the same PR — it has no day of its own yet, so it
  belongs to the run creating it.
- **A shallow clone works, unless it actually truncated the answer.** A
  fragment added *after* the shallow boundary has a genuine add-commit and
  is dated normally; only one whose add-commit resolves to the boundary
  itself is refused, by name, since that date is the boundary's rather
  than the fragment's. Run `git fetch --unshallow` and retry. (CI
  checkouts are routinely shallow, so refusing them wholesale would have
  meant reaching for the override every time — which turns the dating
  off.) A repository whose history cannot be read at all stops the run
  for the same reason.
- **A committed rename is followed back** to where the fragment was
  written, so retitling one to match its PR number does not re-date it —
  **as long as the content did not change much in the same commit.**
  Rename detection is by similarity, so a rename committed *together with*
  a substantial rewrite reads as an unrelated add and delete, and the
  fragment dates to the rewrite. Commit the rename on its own first when
  the original day matters.
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

- **Bash 4 or newer is required**, and the script says so on line one rather
  than failing partway through. Stock macOS ships Bash 3.2, which has neither
  `mapfile` nor associative arrays — both load-bearing here. `brew install bash`
  and run it with that. Two other scripts in the repo already need Bash 4 the
  same way; what was missing was anyone saying so.

[`assemble.test.sh`](../assemble.test.sh) covers all of this against
throwaway repositories with fragments committed at chosen UTC timestamps;
run it after any change to the assembler.

See [`feedback_post_merge_definition_of_done`] in agent memory and the
"Release notes" section of `CLAUDE.md` for the surrounding workflow.
