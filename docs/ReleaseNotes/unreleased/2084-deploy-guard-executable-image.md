## Thread — three attempts at the deploy guard's rewrite question, all withdrawn (PR #2105)

The deploy guard refuses to trust a configuration's checked-in contents when the
file deploying it rewrites that configuration first. This work set out to fix
three ways that question reads text which does not correspond to what runs.

**It fixes none of them, and changes no behaviour at all.** Every attempt was
withdrawn under review. What lands is the record of why, and tests that pin the
wrong verdicts that remain — two misses and one false report — so a later fix
announces itself instead of passing unnoticed.

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
- Tests that **assert three current wrong verdicts** — two misses and one false
  report — so a later fix fails them and comes back to the question rather than
  passing silently: a build file variable holding a write is not seen when its
  assignment sits below the deployment; a recipe marked by something other than
  a tab is not read as a recipe; and, in the
  other direction, a runbook sentence naming a write **reports** the deployment
  below it. That third one's test asserts the report, not a miss.
- Two tests pinning that a bare command line and an inline command span in a
  document **are** read as commands — the two shapes that defeated the withdrawn
  designs, so a future attempt cannot quietly reintroduce the erasure.

### What is deferred

Every symptom this work set out to fix, plus the limitations found while proving
them — including two false greens surfaced while correcting this record itself —
is recorded as its own issue with a reproduction and what a fix would have
to be true of. All are behaviour the check already had, so nothing is made
worse. Three are additionally pinned by tests that assert the current verdict —
two of them a miss, one a false report:

| | |
| --- | --- |
| **#2084** | a build file variable holding a write is not seen, when the assignment sits below the deployment — *pinned (miss)* |
| **#2112** | a runbook sentence naming a write reports the deployment below it — *pinned (false report)* |
| **#2114** | a recipe marked by something other than a tab is not read as a recipe — *pinned (miss)* |
| **#2110** | a folded workflow scalar's positions are not comparable with the file's |
| **#2113** | a write assigned by a live conditional branch is not seen |
| **#2106** | a build file's prerequisites are ordered as written, not as they run |
| **#2108** | a step naming another interpreter has its body read as shell |
| **#2104** | a deployment written as a single-line workflow step whose configuration cannot be read is not reported |
| **#2115** | a Windows helper spelling the command in upper or mixed case is not seen (lowercase and title case are) |
| **#2117** | the PowerShell assignment rewrite has no string state, so an assignment inside a here-string can invent a deployment |
| **#2116** | a manifest script that invokes a sibling does not see that sibling's config write |
| **#2085** | whether this detection should be a declaration rather than an inference — the three withdrawals are the strongest evidence yet that it should |

This PR closes none of them.

The common thread, and the most useful conclusion: each attempt asked a question
about a file that can only be answered by modelling **another system** — a
continuous-integration system's execution model, a document format's grammar, a
build tool's variable language — and this check is a scanner. Where such a model
is genuinely needed, the answer is a declaration from the deployment itself
rather than a better approximation here.
