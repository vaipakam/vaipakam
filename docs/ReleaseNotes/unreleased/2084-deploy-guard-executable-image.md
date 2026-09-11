## Thread — three attempts at the deploy guard's rewrite question, all withdrawn (PR #2105)

The deploy guard refuses to trust a configuration's checked-in contents when the
file deploying it rewrites that configuration first. This work set out to fix
three ways that question reads text which does not correspond to what runs.

**It fixes none of them, and changes no behaviour at all.** Every attempt was
withdrawn under review. What lands is the record of why, and tests that pin the
wrong verdicts that remain — twelve silent passes and nine false reports — so a
later fix announces itself instead of passing unnoticed.

That is worth landing on its own. Two of these designs are the kind a
maintainer would reach for again, and one of them looks obviously correct until
it is built.

### What was tried, and what each cost

**Collecting the file's executable text** — the parts believed to run. Review
found six routes by which executable text reached the file without reaching the
collection, each one a silent pass, and two attempts to enumerate all the routes
were both incomplete. A *selection* turns whatever it fails to recognise into
silence. The decisive case was a command written inline in a sentence, which
this check already acts on — so the boundary the design rested on did not exist.

**Blanking a document's prose**, so a sentence naming a write would stop
reporting the deployment below it. Six commands erased across three rounds. The
rule cannot exist, and the reason is worth stating exactly: this check treats a
bare, unindented line in a document as an actionable command — that is
deliberate, and it is why a runbook's copy command is reported at all — and a
prose sentence naming a write has that same shape. Separating them is the
judgement whose answer produced the unwanted report in the first place.

**Expanding a build file's recipe variables**, so a variable holding a
redirection would be seen as the write it is. Fifteen findings over four rounds:
conditionals in both directions, explicit removal, removal inside a dead branch,
a settable recipe marker, that marker moving partway down the file, stored
variable bodies, indented assignments, mismatched delimiters, a default-value
assignment after a computed one. Every round's findings were edges of the
previous round's fix. It failed the way the other two did — it had to infer
what a name denotes — which is the real test, and not whether a transformation
adds or removes characters.

Two smaller corrections outlived all three designs above and were withdrawn in
the last behaviour-changing round. Each looked obviously safe, and — the part
worth keeping — they regressed in OPPOSITE directions, so neither is a template
for judging the next one:

- Treating the build tool's **escaped currency symbol** as inert. It is inert to
  the build tool — and the build tool then hands a single symbol to the shell,
  which may expand it. A deployment written that way, with the surrounding name
  exported, really does run; treating the escape as permanently inert hid it.
  A SILENT PASS, introduced by a rule adopted specifically because it was
  "purely lexical".
- Adding the tool's **canonical GNU-prefixed default filename** to the set of
  files scanned as build files. Correct in itself, but it routes those files
  through a variable model already known to be imperfect, extending its FALSE
  REPORTS to files that previously escaped them — the opposite failure, reached
  by widening the model's scope rather than by sharpening it.

### What lands

No behaviour change. The check's logic is what it was.

- The reasoning above, recorded beside the code that would have to change, in
  the functional specification, and here — so the next person does not rebuild
  one of these designs without knowing what happened to it.
- Tests that **assert twenty-one current wrong verdicts across eleven defects**, so
  a later fix fails them and comes back to the question rather than passing
  silently.

  **Twelve assert a silent pass** — the direction this check must never fail in:
  a build file variable holding a write is not seen when its assignment sits
  below the deployment; a recipe marked by something other than a tab is not
  read as a recipe; a deployment that follows an unrelated line ending in a
  backslash is read as one command with it, so a safety flag belonging to the
  earlier line covers the deployment (pinned four times — two Windows shells,
  each in a standalone helper and in a continuous-integration step, because the
  fold is in the shared line splitter and a fix scoped to any one of them
  leaves the rest live); a script declared in a package manifest is never
  split at its newlines, so a flag on one of its lines covers a deployment on
  another; a variable whose name differs only in case is not resolved, though
  the shell in question resolves it, so the deployment's directory reads as
  unknown; a binding closed with that shell's ordinary statement terminator is
  not recognised at all, with the same consequence; and a helper whose file name
  carries an upper-case extension is never FOUND by the sweep that discovers
  files to read — though one explicitly named by a file already being read is
  still opened, so the bypass is in the discovery and not in the reading —
  pinned three times,
  for two command-shell families and a POSIX one, because the gate that skips
  them is shared and a fix scoped to one family would satisfy a single
  fixture while leaving every other family bypassed.

  **Nine fail the other way and assert the report**: a runbook sentence naming a
  write reports the deployment below it; a package manifest whose description
  merely names the command is reported as performing it, as is an unrelated
  data file of the same format, and as is a list of keywords once the file is
  written across several lines; and a command named inside a block the shell
  never executes is reported — which is what the two Windows normalisations
  cost, and the casing one is pinned in a workflow body as well as a helper,
  since that rewrite runs on both; and a line that is COMMENTED OUT, in the variant
  of that format permitting comments, is read as a command although it is not a
  property at all; and a Windows normalisation is applied wherever the
  interpreter is a Windows shell, INCLUDING on a runner whose platform those
  rules do not describe, so it reports a program that does not exist on that
  platform.
- Two tests pinning that a bare command line and an inline command span in a
  document **are** read as commands — the two shapes that defeated the withdrawn
  designs, so a future attempt cannot quietly reintroduce the erasure.
- A control beside every pinned defect but one, differing from it by the single
  character or spelling at issue, so it cannot pass for an unrelated reason.
  A second report was uncontrolled until review found it, and the record had
  claimed there was only one; that one now has a companion differing by a
  single verb. The remaining one has NO such control and says so in place of
  claiming one:
  for it, the already-normalised spelling is understood without the rewrite
  and so reports too, meaning no single-character sibling distinguishes them;
  its coupling rests on a deliberate mutation of the rewrite instead, and a
  fixture that passed either way would have been worse than that admission.
  And, where a defect turned out narrower than first written, there is a test
  pinning the BOUND as well. Every one of those bounds was discovered by disproving a
  sentence in this record: the folding applies only where a body is split into
  lines at all, and only where the line ends immediately at the offending
  character — the latter being a fact about the bytes in the file rather than
  about anyone's platform, since this repository normalises tracked text to one
  line convention everywhere; the value-by-value reading passes over a list only when the file
  is written compactly. Bounds are pinned because a fix aimed at the overstated
  version would change cases that behave correctly today.

### What is deferred

Every symptom this work set out to fix, plus the limitations found while proving
them — including **ten defects surfaced while correcting this record
itself**, seven of them silent passes and three false reports — is recorded as its
own issue with a reproduction and what a fix would have to be true of. All are
behaviour the check already had, so nothing is made worse. Ten are
additionally pinned by tests that assert the current verdict — twenty-one such
tests in all, twelve asserting a silent pass and nine a false report.

That the correcting itself surfaced more defects than the original work is the
most useful thing here, and it is not an accident of effort: each correction
had to be REPRODUCED before it could be written down, and reproducing a claim
is what finds the case the claim gets wrong. Two of the ten came directly from
disproving a sentence in this document — the second of them from a case
DISCARDED while correcting the first, which is the strongest form of the point
— and two further corrections to the scope of issues already filed came the
same way — which is the argument for
writing the reason down at all, rather than only the fix.

**Each row is a one-line symptom and a pointer.** The precise scope and bounds
of every defect live on its issue, and deliberately not here: this table
restated them, the restatements went stale as each was corrected, and eight
review rounds were spent finding a correction that had landed in one place and
not its siblings. One record per defect, named from the others.

| | |
| --- | --- |
| **#2084** | a build file variable holding a write is not seen, when the assignment sits below the deployment — *pinned (miss)* |
| **#2112** | a runbook sentence naming a write reports the deployment below it — *pinned (false report)* |
| **#2114** | a recipe marked by something other than a tab is not read as a recipe — *pinned (miss)* |
| **#2118** | a deployment is lent a safety flag by the unrelated line above it, when that line ends in a character the shell does not treat as a continuation — *pinned (silent pass) four times, and its bounds pinned too* |
| **#2119** | text in any file of the manifest's format is read as a command, so a description naming the deployment is reported as performing it — *pinned (false report) four times, because the scope was wrong in four separate ways*. The issue carries them; three of the four move together under one fix |
| **#2110** | a folded workflow scalar's positions are not comparable with the file's |
| **#2113** | a write assigned by a live conditional branch is not seen |
| **#2106** | a build file's prerequisites are ordered as written, not as they run |
| **#2108** | a step naming another interpreter has its body read as shell |
| **#2104** | a deployment written as a single-line workflow step whose configuration cannot be read is not reported |
| **#2115** | a Windows-shell body spelling the command in upper case, or in a mixed case OTHER than title case, is not seen (lowercase and title case are) — and the spelling that IS covered is matched inside a block the shell never executes, *pinned (false report)* in both a standalone helper and a continuous-integration step, as the trade any widening of that rule grows |
| **#2117** | the PowerShell assignment rewrite has no string state, so an assignment inside a here-string can invent a deployment |
| **#2116** | a manifest script that invokes a sibling does not see that sibling's config write |
| **#2121** | a script declared in a package manifest is never split at its newlines, so a safety flag on one line covers a deployment on another — *pinned (silent pass)*; the mirror of #2118 |
| **#2122** | a variable whose name differs only in case is not resolved, though that shell resolves it, so the deployment's directory reads as unknown — *pinned (silent pass)* |
| **#2123** | a helper whose file name carries an upper-case extension is never found by the sweep that discovers files to read — *pinned (silent pass)*, and the broadest of the three, since a file the sweep never yields is never examined at all — though one named explicitly by a file already being read IS opened, so the gap is in the discovery and not in the reading |
| **#2124** | a binding closed with that shell's ordinary statement terminator is not recognised, so the deployment's directory reads as unknown — *pinned (silent pass)* |
| **#2126** | the command-name normalisation for one platform's shells is chosen by the interpreter rather than the platform, so it also applies where that platform's rules do not hold and reports a program that does not exist there — *pinned (false report)*. The check's own comment states this must not happen. A companion claim about the path-separator normalisation was withdrawn: that rewrite matches how the shell itself reads paths on every platform, so the report it produces is correct |
| **#2085** | whether this detection should be a declaration rather than an inference — the three withdrawals are the strongest evidence yet that it should |

This PR closes none of them.

The common thread, and the most useful conclusion: each attempt asked a question
about a file that can only be answered by modelling **another system** — a
continuous-integration system's execution model, a document format's grammar, a
build tool's variable language — and this check is a scanner. Where such a model
is genuinely needed, the answer is a declaration from the deployment itself
rather than a better approximation here.
