# Cloudflare cron slots — the one count

**This file is the only place in the repository that states how many cron
triggers the account is using.** Everywhere else says *why* a Worker
registers one schedule rather than two, and links here for the arithmetic.

That split exists because the arithmetic was previously restated in TEN
places, all of them internally consistent, mutually consistent, and wrong
together (#1977). A count copied into a comment is a claim about an
account, and no amount of care while editing source can keep it true —
the account changes without touching the tree, and a Worker that exists
only in the account is invisible to every reader of the tree. So the count
lives once, and it carries the date it was last checked against the
account rather than the date somebody last believed it.

---

## The cap

The Cloudflare Workers **free plan caps an account at 5 cron triggers**.
One Worker with one `crons` entry is one trigger; a Worker with two
entries is two. The API rejects the sixth with **error 10072**, at deploy
time, for the Worker that happens to be deploying — not for whoever
consumed the budget. `apps/indexer/src/cronRouting.ts` exists because that
happened once already.

Workers Paid ($5/mo) **raises** the cap to 250 per account — it does not
remove it. An earlier revision of this line said "removes the cap", which
would have given an operator planning an upgrade an unbounded figure to work
from; the number is small enough today that nothing depended on it, and that
is exactly when a wrong upper bound gets written down. Until then a Worker
that wants two
cadences registers **one** every-minute schedule and decides per tick who
acts — that is what `packages/lib/src/cronCadence.ts` is for.

## The inventory

Read from the account, not from the tree.

**Verified: 2026-08-28T15:38:09Z.** Re-verify with the command in
[Re-verifying](#re-verifying) below; update this table and this stamp in
the same commit.

**The Status cell must BEGIN with one of `live`, `reserved` or `undeployed`**
— the script reads that first word and refuses a row it does not recognise.
Prose goes after it. An earlier revision searched the whole cell for the word
"reserved", which read "no longer reserved" as reserved and "reservation held"
as not; a leading keyword cannot be negated by the sentence that follows it.
A row with a schedule must say `live`; a row without must say `reserved` or
`undeployed`.

Each cron expression is **its own backticked span**. Two schedules are two
spans, not one span with a comma — a comma is cron syntax (`0 1,13 * * *` is
one expression), and splitting on it produced two nonsense fragments.

| Worker | Schedule | Source in this repo | Status |
|---|---|---|---|
| `vaipakam-agent` | `* * * * *` | `apps/agent` | live |
| `vaipakam-indexer` | `* * * * *` | `apps/indexer` | live |
| `vaipakam-offchain-data-warm` | `17 3 * * *` | `ops/offchain-data-warm` | live |
| `vaipakam-offchain-data-archive` | `17 3 * * *` | *none* | live — and should not be (#1977) |
| `vaipakam-keeper` | *(none)* | `apps/keeper` | reserved — unscheduled since #1896, held for its return |
| `vaipakam-mesh-watcher` | *(would be `*/15 * * * *`)* | `ops/mesh-watcher` | undeployed — code-complete, holds no trigger |

**The table above is the whole inventory.** A Worker not listed holds no
trigger, and `--live` is what enforces that: any Worker armed on the account
and absent from the table is reported as `ACCOUNT ONLY`, which is how #1977
was found in the first place.

An earlier revision listed the unscheduled Workers here by name. That was a
second inventory nothing checked — if one of them later gained a trigger, an
operator could add its row, fix the summary, pass `--live`, and leave this
paragraph still asserting it had none.

## What that adds up to

- **Live right now:** 4 of 5
- **Committed, live plus the keeper's reserve:** 5 of 5
- **Genuinely spare:** 0

These three lines are **derived from the inventory above, and checked against
it** — `check-cron-slots.mjs` fails if "Live right now" disagrees with the
number of **backticked schedule spans** in the table, or if "Genuinely spare"
is not `5 − committed`. Spans, not rows: one row carrying two spans is two
triggers and counts twice. (An earlier revision of this sentence said rows,
which would have walked an editor into writing a summary CI then rejected.)

That check is offline and runs in CI, so this summary cannot drift from the
table it summarises even when nobody has account credentials to hand. Their exact wording is load-bearing: the script anchors on it, and
rewording a line without updating the script fails the gate rather than
silently disabling it.

Keeping a summary at all is a deliberate exception to this file's own rule
against second copies. A reader needs the total, counting spans across the
table is what nobody does, and the copy is safe precisely because it is pinned
to its source. It
was **not** pinned in the first revision of this file, which is the defect
Codex found on #1978: retiring the archive Worker and deleting its row would
have left this saying four were live while the table showed three, and
`--live` would still have reported a match.

**The "Genuinely spare" line above is the only statement of how much room
is left.** An earlier revision restated it here in prose, and Codex found
the consequence on #1978: retiring the archive Worker and correctly updating
both the table and the summary would have left this paragraph asserting the
opposite, with nothing to catch it — the summary anchors are the only lines
either half of the script reads, and this file is excluded from the
occupancy scan. A restated count is no safer for being inside the authority.

Any comment or design note claiming room that this file does not is either
older than #1977 or has copied a count from something that is.

**Why `vaipakam-offchain-data-archive` is in this file at all** — background,
not a statement of current state. It is the **pre-rename** predecessor of
`vaipakam-offchain-data-warm` and was supposed to be retired once the
replacement completed a run. It has **no source in this repository**, so it
is invisible to anyone counting `crons` entries across the tree, which is
exactly how ten separate statements of the count came to omit it.

**Whether it is still armed is the table's answer, not this paragraph's.**
An earlier revision said here that it *is* armed and *is* the fourth live
trigger. Both were true when written and both would have survived the #1977
retirement unchanged: the documented refresh deletes its row, updates the
summary and the stamp, and passes offline **and** `--live` — because this
file is excluded from the occupancy scan and its self-check reads only the
inventory and the three summary labels. Nothing would have contradicted a
paragraph asserting a Worker that no longer exists.

That is this file's own thesis turned on itself, and the second time in it:
a count restated in prose is unchecked even when the prose lives inside the
authority. The durable form is the one used throughout — state the rule and
the history, and let the checked table carry the state.

### Consequences for the next deploy

These are rules, not arithmetic. **Read the current numbers off the summary
above and apply them** — an earlier revision of this section stated the
outcomes as fixed facts ("it would be the 5th live trigger"), which is a
restated count wearing operational clothes, and it would have gone stale
during exactly the cleanup the rest of this file anticipates.

- **`ops/mesh-watcher` needs one trigger on its first deploy.** Whether it
  fits is `Genuinely spare` above: if that is zero, deploying it spends
  `apps/keeper`'s reservation, and the keeper's later re-arm is the deploy
  that fails with 10072.
- **A Worker that already holds a reservation needs no spare trigger to
  re-arm.** Re-arming CONVERTS its reservation into a live trigger, so
  `committed` does not move. Its procedure still begins by confirming a
  trigger is free, because a reservation only helps if nobody has spent it.
  **Whether `apps/keeper` is currently such a Worker is the table's answer,
  not this paragraph's** — once its re-arm lands, its row reads `live` and it
  holds no reservation, and a bullet asserting otherwise would contradict the
  checked table while every gate stayed green.
- **Both fit when `Genuinely spare` is at least 1**, not 2 — the keeper's
  half is already committed. Below that, exactly one of the two can proceed
  and whichever goes first takes it. **Read the current value off the
  summary**; an earlier revision of this bullet stated it here, along with
  what retirement would change it to, and both would have been wrong the
  moment the retirement landed.
- Retiring `vaipakam-offchain-data-archive` is what frees a trigger. That is
  the operator action tracked in #1977, and it is not something to do
  casually: until the replacement is confirmed to be landing and verifying
  in the new bucket, the un-retired predecessor is what would mask a defect
  in it.
- **Splitting an existing Worker's one cron into two costs a trigger** and
  has the same effect as a new deploy. This is why
  `ops/offchain-data-warm` folds its Monday healthcheck into the nightly
  backup tick rather than scheduling it separately.

## Re-verifying

Read-only; needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with
Workers Scripts read. The check is also wired into
`.github/scripts/check-cron-slots.mjs --live`:

```bash
node .github/scripts/check-cron-slots.mjs --live
```

It lists every Worker in the account with its schedules and diffs them
against the table above, so a Worker that exists only in the account —
the whole failure mode this file is here for — shows up as a difference
rather than as nothing at all.

Without `--live` the script runs offline and checks the other half: that
no file outside this one has gone back to restating the count, and that
this file agrees with itself. CI runs that half, because it has no account
credentials and because the restating is the part a reviewer cannot see
happening.

### How this file may be written

The gate reads this document rather than parsing Markdown, so four
constructs are ruled out here instead of being implemented there. None of
them appears in this file today, so the rules cost an editor nothing —
they exist so the checker and a reader can never disagree about what the
document says:

- **No HTML comments.** Every check asks what the rendered document
  claims, and this file may not hide any of itself.
- **No indented code blocks.** Four spaces means one thing at top level
  and another inside a list item. Use a fenced ```` ``` ```` block; ordinary
  continuation indents by two spaces, as it does above.
- **No block quotes.** A quote can open a fence the scanner does not
  track, which is where the checker and the reader part company.
- **No backslash before a table pipe.** A single backslash escapes the
  pipe into a literal character; a doubled one escapes the backslash and
  leaves the pipe as a cell separator. Telling those apart means counting
  the escape run. Reword the cell instead.

That last rule caught its own documentation on the first run: an earlier
draft of this section spelled the two escape sequences out, and the gate
correctly rejected the file. The advice the diagnostic gives — reword so
no escape is needed — is the advice it gave its author, which is a fair
sign the constraint is liveable.

The reasoning is recorded in #1990: the gate exists to stop ten notes
disagreeing about how many of five cron triggers are in use, and a
CommonMark implementation is not required to do that. Constraining the
input is decidable in one line each; parsing the language was not
converging.

### What each half can and cannot tell you

The two halves check two links of one chain — the summary is pinned to the
inventory, and the inventory is pinned to the account — so neither alone
means "this file is right". Measured by mutating this document and running
both:

| This document is… | offline | `--live` |
|---|---|---|
| correct | pass | pass |
| **self-consistent, but stale against the account** | **pass** | **fail** |
| account-correct, but contradicting itself | fail | fail |

**Row two is the one to remember.** A document whose table and summary agree
perfectly can still be describing an account that changed underneath it, and
CI will be green — because CI has no credentials and cannot ask. That is not
a gap to be closed; it is the reason the `Verified:` stamp exists and the
reason it carries a timestamp rather than a tick.

So: a green CI run means *nobody re-copied the count*. Only `--live` means
*the count is right*, and only as of the moment it ran.

## Related

- **#1977** — the un-retired backup Worker, and the operator sequence to
  retire it.
- **#1972** — the general class: live infrastructure state asserted in
  many documents, authoritative in none. This file is that issue's shape
  applied to the one fact where the drift turned out to be load-bearing.
- `docs/ops/OffChainRestore.md` §2 — restoring from the backup buckets;
  note the selection rule there is affected by #1977 while both Workers
  are armed.
