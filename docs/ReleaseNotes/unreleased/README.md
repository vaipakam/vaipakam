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

The script concatenates every pending fragment into
`ReleaseNotes-<date>.md` (creating it with a header if absent, appending
if it already exists), then removes the consumed fragments. Review the
result, add an intro paragraph, and commit:

```bash
git add -A docs/ReleaseNotes/
git commit -m "docs: release notes <date>"
```

See [`feedback_post_merge_definition_of_done`] in agent memory and the
"Release notes" section of `CLAUDE.md` for the surrounding workflow.
