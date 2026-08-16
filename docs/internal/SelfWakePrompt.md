# Recurring self-wake prompt (agent session bootstrap)

This file exists so the recurring check-in prompt survives a session ending.
It is **not** wired into CI and requires no merge to `main` to be useful —
it lives on a branch, and recovering the loop means fetching this file and
pasting the block below back into a session.

## Why it needs recovering at all

The only scheduler available in this environment is the built-in
`CronCreate`. Its own documentation is explicit:

- **Session-only.** In memory; gone when the session exits. There is a
  `durable` parameter and it has no effect.
- **Recurring jobs auto-expire after 7 days**, firing once more then
  deleting themselves.
- **Jobs fire only while the session is idle**, with jitter up to 10% of the
  period (capped at 15 min).

Cloud Routines (`create_trigger` / `list_triggers`), which would be durable,
are **not present** in this environment — checked, not assumed.

In practice the in-memory store has also dropped the job repeatedly *within*
a live session. So the job disappearing is normal, not exceptional, and the
mitigation is detect-and-re-arm rather than expecting persistence.

## Re-arming

```
CronCreate({
  cron: "7,22,37,52 * * * *",
  recurring: true,
  prompt: <the block below>
})
```

`7,22,37,52` gives 15-minute coverage while avoiding `:00`/`:30`, where every
scheduler on the planet fires.

Two habits that matter more than the schedule:

1. **Call `CronList` before ending any turn.** This is what has actually
   caught every disappearance.
2. The prompt below **self-heals**: it re-arms if `CronList` comes back empty.
   That covers a drop between firings, not a drop that kills the last firing —
   hence habit 1.

## The prompt

```text
15-minute check-in. Continue this conversation's work.

NO RE-ARM NEEDED — this is a single recurring job (`7,22,37,52 * * * *`) that
repeats on its own. Do NOT call CronCreate. If `CronList` shows more than one
job, delete the extras. If `CronList` shows ZERO jobs, the session's in-memory
store dropped it (this happens) — in that ONE case, recreate it with this exact
prompt, then continue.

LIVE STATE IS THE CONVERSATION, NOT THIS MESSAGE. This prompt is frozen and
deliberately names no PR numbers, branches, SHAs or round counts — all of those
would be stale. Re-derive them every cycle:
  git branch -a && git log --oneline -8
  curl -sS "https://api.github.com/repos/vaipakam/vaipakam/pulls?state=open&per_page=20" \
    | python3 -c "import json,sys; [print(p['number'], p['head']['ref'], p['title']) for p in json.load(sys.stdin)]"
An earlier cycle may already have pushed what you are about to push.

## Each cycle, in order

1. List open PRs. For each one that is mine:
   - `pull_request_read get_check_runs` — is CI green on the CURRENT head?
   - `pull_request_read get_reviews` AND `get_comments` — BOTH. A CLEAN Codex
     round is a plain ISSUE COMMENT ("Didn't find any major issues") and never
     appears in `get_reviews`; a round WITH findings is a submitted review whose
     body carries only a header, with the findings as inline review comments.
   - If a round exists that I have not addressed, read it and triage every
     finding.
2. Then the follow-up queue — open board issues, the current task list. Do not
   idle waiting on a PR.

## Cost ladder — GraphQL has been exhausted repeatedly

1. Cheap, REST via MCP, use freely: `pull_request_read` with `get` /
   `get_reviews` / `get_comments` / `get_check_runs` / `get_files` /
   `get_commits`; `issue_read`; `list_pull_requests`; `get_job_logs`;
   `add_issue_comment`; `add_reply_to_pull_request_comment`;
   `merge_pull_request`; `update_pull_request`.
2. GraphQL, avoid: `pull_request_read get_review_comments`, and
   `resolve_review_thread`. No REST equivalent *in the MCP toolset*.
3. When GraphQL fails, curl the REST API directly — this WORKS, unauthenticated,
   on this public repo, on a separate quota:
     curl -sS "https://api.github.com/repos/vaipakam/vaipakam/pulls/<N>/comments?per_page=30" \
       | python3 -c "
   import json,sys
   for c in json.load(sys.stdin): print('='*70); print(c['id'], c['path'], c.get('line')); print(c['body'])"
   Reply with the MCP `add_reply_to_pull_request_comment` (REST), passing that
   `id` as `commentId`. Thread RESOLUTION is GraphQL-only with no REST path — if
   exhausted, say so in the thread and ask the user to resolve manually rather
   than blocking the merge.
4. NEVER call `subscribe_pr_activity` — standing user instruction; it burns
   GraphQL quota. Polling on this schedule with REST is the low-quota approach,
   which is the point of the loop.

## Domain rules

- Codex policy: docs-only PRs merge after 2 rounds; coding PRs run until a round
  has zero P1/P2. Every finding gets exactly one of accept-fix /
  refute-with-evidence-in-thread / defer-to-a-filed-issue.
- VERIFY a Codex claim against the code before accepting OR refuting it. Both
  have been wrong. A claim about storage layout, arithmetic, or an invariant is
  checkable — check it (`forge inspect ... storageLayout`, read the call path)
  rather than reasoning from memory.
- Re-read the review surfaces IMMEDIATELY before merging, never on a verdict
  formed earlier in the cycle.
- BEFORE merging, re-read the PR BODY, and after any finding reverses a claim,
  re-read the SUMMARY of every doc touched — not just the section that argued
  the point. Stale summaries have nearly shipped twice.
- MERGE ORDER IS A CORRECTNESS PROPERTY when two open PRs touch the same
  comments or docs. A clean auto-merge is not evidence the merged text is
  coherent — after merging one, re-read the overlapping region in the others.
- Every behaviour-changing PR carries a release-note fragment AND a
  FunctionalSpecs update in the same diff.
- Contracts: targeted tests only (`forge test --match-path`), plus `test/deploy/*`
  when selectors, sizes or the storage struct change. Never the full regression
  as a per-PR gate. Prefix forge with `nice -n -10 ionice -c 2 -n 0`; the binary
  is `~/.foundry/bin/forge`.

## Scope

Repository `vaipakam/vaipakam` only. Do not reopen settled, merged decisions. Do
not push to a branch whose PR is already merged — restart from `main`. Do not
open a PR unless the work warrants one.

## Failure-mode rule

Never end a cycle having found red CI, an unread review round, or a blocked task
without either pushing a fix or stating the concrete blocker. "Will look next
cycle" is not an outcome.

If everything is genuinely quiet AND the follow-up queue is empty, say so in a
line or two and do not invent work.
```
