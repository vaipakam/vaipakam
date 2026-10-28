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

**Verified: 2026-10-28T06:50:17Z.** Re-verify with the command in
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
| `vaipakam-mesh-watcher` | *(would be `*/15 * * * *`)* | `ops/mesh-watcher` | undeployed — code-complete, holds no trigger |

**The table above is the whole inventory.** A Worker not listed holds no
trigger, and `--live` is what enforces that: any Worker armed on the account
and absent from the table is reported as `ACCOUNT ONLY`, which is how #1977
was found in the first place.

**`vaipakam-keeper` is not listed, and holds no reservation.** Its row read
`reserved` until #2570, holding a trigger for a Worker schedule to return.
None will: since #2504 the keeper runs on an always-on machine
([`KeeperMachine.md`](KeeperMachine.md)), and from #2569 its Worker's
`scheduled` handler declines every invocation. A reservation exists only in
this table, so releasing it changed no account state, and the `Verified:`
stamp above still dates the last read of the account. `--live` still guards
the keeper: a schedule restored on it by hand would show up as `ACCOUNT ONLY`.

An earlier revision listed the unscheduled Workers here by name. That was a
second inventory nothing checked — if one of them later gained a trigger, an
operator could add its row, fix the summary, pass `--live`, and leave this
paragraph still asserting it had none.

## What that adds up to

- **Live right now:** 3 of 5
- **Committed, live only:** 3 of 5
- **Genuinely spare:** 2

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

**Why `vaipakam-offchain-data-archive` is named in this file** — history,
not a statement of current state. It was the **pre-rename** predecessor of
`vaipakam-offchain-data-warm`, it had **no source in this repository**, and
it stayed armed on the account long after its replacement ran — invisible to
anyone counting `crons` entries across the tree, which is exactly how ten
separate statements of the count came to omit it. The owner deleted it on
2026-10-28 (#1977), once the replacement had backed up every night from
2026-10-20 into its own bucket.

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
  fits is `Genuinely spare` above: if that is zero, the deploy fails with
  10072.
- **A Worker that already holds a reservation needs no spare trigger to
  re-arm.** Re-arming CONVERTS its reservation into a live trigger, so
  `committed` does not move. Its procedure still begins by confirming a
  trigger is free, because a reservation only helps if nobody has spent it.
  **Whether any Worker is currently such a Worker is the table's answer,
  not this paragraph's**: a row reading `reserved` is one, and a bullet
  naming one would contradict the checked table the moment it changed while
  every gate stayed green. `apps/keeper` was the case this bullet was
  written for, and it no longer holds one (see the note under the inventory).
- **Read the current value off the summary** before any new trigger; an
  earlier revision of this file stated how many fit, along with what
  retirement would change it to, and both would have been wrong the moment
  the retirement landed.
- **Retiring a Worker frees its trigger only when the Worker is deleted.**
  A stopped or disabled Worker keeps its schedule. Retire a predecessor only
  once its replacement is confirmed to be landing and verifying on its own:
  until then the predecessor is what would mask a defect in it. That was the
  order for `vaipakam-offchain-data-archive` (#1977).
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
- **No tab characters, and no run of four or more spaces.** Four columns
  of whitespace opens a code block at top level and continues a list item
  inside one, and this gate does not tell those apart. Both rules count
  the whole line rather than its start, because indentation after a list
  bullet opens a code block just as leading indentation does. Use a
  fenced ```` ``` ```` block for code; ordinary continuation indents by two
  spaces, as it does above.
- **No greater-than character at all.** A block quote can open a fence the
  scanner does not track, and where its marker sits — column zero,
  indented, or after a list bullet — is precisely the context this gate
  declines to parse. The rule is therefore the character rather than the
  marker position: enumerating positions is what kept failing, here and
  in the stamp count before it, because Markdown affords more prefixes
  than an enumeration can hold. The character appears nowhere in this
  file, so the blunt form costs nothing.
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
