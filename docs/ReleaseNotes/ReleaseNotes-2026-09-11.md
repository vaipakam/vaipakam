# Release Notes — 2026-09-11

One entry, and it closes nothing. A guard that must decide whether a
deployment's checked-in configuration is the one that will actually load had
three plausible ways to read the file more faithfully; all three were built and
all three were withdrawn, along with two smaller corrections that looked
obviously safe and regressed in opposite directions. What lands is the account
of why none of them can work, the intent stated where it binds, and tests that
assert the wrong answers the guard still gives — so that a later, correct fix
fails them loudly instead of passing unnoticed. The executable code is
unchanged, byte for byte.

The most transferable part is not about deployments at all. Each withdrawn
design failed for the same reason: it asked a question about a file that only
another system's execution model can answer — a continuous-integration
system's, a document format's grammar, a build tool's variable language — while
this check is a scanner. Where such a model is genuinely needed, the answer is
a declaration from the thing being deployed, not a better approximation in the
reader. That conclusion is now recorded as a requirement, and the gap between
it and the current implementation is registered rather than quietly carried.

## Thread — three attempts at the deploy guard's rewrite question, all withdrawn (PR #2105)

The deploy guard refuses to trust a configuration's checked-in contents when the
file deploying it rewrites that configuration first. This work set out to fix
three ways that question reads text which does not correspond to what runs.

**It fixes none of them, and changes no behaviour at all.** Every attempt was
withdrawn under review. What lands is the record of why, and tests that pin the
wrong verdicts that remain — in both directions, silent passes and false
reports — so a later fix announces itself instead of passing unnoticed.

That is worth landing on its own. Two of these designs are the kind a
maintainer would reach for again, and one of them looks obviously correct until
it is built.

### What was tried

Three designs, and two smaller corrections that outlived them. All five were
withdrawn under review.

| | outcome |
| --- | --- |
| Collecting the file's executable text | withdrawn — a *selection* turns what it fails to recognise into silence, and two attempts to enumerate the routes in were both incomplete |
| Blanking a document's prose | withdrawn — the rule cannot exist; a prose sentence naming a write has the same shape as the command this check is meant to act on |
| Expanding a build file's recipe variables | withdrawn — it had to infer what a name denotes, and every round's findings were edges of the previous round's fix |
| Treating the build tool's escaped currency symbol as inert | withdrawn — a **silent pass**, from a rule adopted because it was "purely lexical" |
| Adding the tool's prefixed default filename to the build-file set | withdrawn — a **false report**, the opposite failure, from widening an imperfect model's scope |

**What each cost, why none can be rebuilt, and the admissibility rule the
rounds converged on are recorded once**, in
[`DeployGuardRewriteScanRecord.md`](../DesignsAndPlans/DeployGuardRewriteScanRecord.md).

This section used to carry all of that in full. It was reduced to the table
above because keeping it here meant a second copy of exactly the material whose
drift produced the restructure — and because the paragraph below, claiming the
rationale has one home, was false while it stood. The last two rows are worth
one line here even so: they regressed in **opposite** directions, which is why
neither is a template for judging the next "obviously safe" correction.

### What lands

No behaviour change. The check's logic is what it was.

- The reasoning, recorded ONCE — in the design record, with the call site and
  the functional specification pointing at it rather than repeating it — so the
  next person does not rebuild one of these designs without knowing what
  happened to it, and so the account they find has not drifted from the two
  others that used to exist.
- Tests that **assert twenty-one current wrong verdicts across twelve defects**, so
  a later fix fails them and comes back to the question rather than passing
  silently.

  **Several defects are pinned more than once. Why, and how many times, is
  recorded at the fixtures and in the table below — not here.**

  That sentence is short on purpose, and the reason is the most transferable
  thing in this document. Review round after review round was spent on the
  paragraph that
  used to sit here, which existed to explain the multiple pins: each round
  found it asserting something the fixtures did not support, each correction
  added prose to state the matter more precisely, and the added prose was
  itself wrong the next round — twice over in the last one, where a sentence
  written specifically to remove a category error reintroduced it with a
  different word, and a paragraph opening "stated once, in the table below"
  hardcoded two of the counts three lines later.

  That is not a paragraph nearly finished. It is an explanation whose edge
  list has no end, because every restatement of a per-defect fact is a new
  place for that fact to drift from the fixture that establishes it. The same
  shape was met twice before in this work — enumerating the spellings of a
  command, and enumerating a document format's grammar — and resolved the same
  way both times: **delete the thing generating the edges rather than answer
  the next one.** The fixtures already carry each defect's scope, mechanism,
  mutation evidence and pin count, established with the code in hand. A prose
  copy adds no information and one more surface to be wrong on.

  What survives is the general point those rounds actually established, which
  needs no per-defect detail to state: **the record kept asserting something
  broader than what had been verified**, and the qualifiers fell off at every
  restatement. One record per fact, named from the others.

  **Some assert a silent pass** — the direction this check must never fail in:
  a build file variable holding a write is not seen when its assignment sits
  below the deployment; a recipe marked by something other than a tab is not
  read as a recipe; a deployment that follows an unrelated line ending in a
  backslash is read as one command with it, so a safety flag belonging to the
  earlier line covers the deployment — across both Windows shells and both
  ingestion surfaces, a standalone helper and a workflow body, because the
  fold is in the shared line splitter; a script declared in
  a package manifest is never split at its newlines, so a flag on one of its
  lines covers a deployment on another; a variable whose name differs only in
  case is not resolved, though the shell in question resolves it, so the
  deployment's directory reads as unknown; a binding closed with that shell's
  ordinary statement terminator is not recognised at all, with the same
  consequence; and a helper whose file name carries an upper-case extension is
  never FOUND by the sweep that discovers files to read — though one explicitly
  named by a file already being read is still opened, so the bypass is in the
  discovery and not in the reading — across EVERY executable family the sweep
  is meant to yield, because the gate that skips them is shared.

  **That last one carries a distinction the others do not, and it is the
  difference between a silent pass and a blind spot.** Where something runs
  the file regardless of what it is called, a deployment written there really
  does run and really is missed. Where nothing does — because the interpreter
  refuses the spelling, or the engine that would pick the file up matches only
  the other one — what is established is that the guard never EXAMINES the
  file, which is a blind spot rather than a deployment slipping past. For one
  format the question is not settled at all, and the record says so instead of
  choosing.

  **Which family falls on which side is declared at the fixtures and
  deliberately not listed here.** It was listed here, and the list went stale
  three times — every family added changed the membership while the sentence
  did not. It is now a required field on each fixture that partitions the
  tests, so a wrong classification moves a family under a different claim
  rather than quietly contradicting a paragraph. Every family is pinned either
  way, because the gate is shared: a fix aimed only at the runnable ones would
  leave the rest unexamined, and a file the sweep never opens is invisible for
  every purpose rather than only for a deployment.

  **The rest fail the other way and assert the report**: a runbook sentence
  naming a write reports the deployment below it; a package manifest whose
  description merely names the command is reported as performing it, as is an
  unrelated data file of the same format, and as is a list of keywords once the
  file is written across several lines; and a command named inside a block the
  shell never executes is reported — for what the casing normalisation costs,
  in a helper and in a continuous-integration step since that rewrite runs on
  both, and for the same inert text reached instead through the
  path-separator normalisation, which is a report the missing quoting model
  produces rather than anything either rewrite does wrong; an ASSIGNMENT
  written in that same unexecuted text is rewritten into a real binding, so a
  later indirect invocation resolves to a deployment the file never performs —
  a separate symptom from the command-name one, reached through a different
  rewrite, which is why both are pinned; and a line that is COMMENTED OUT, in the variant
  of that format permitting comments, is read as a command although it is not a
  property at all; and a command-name normalisation is applied wherever the
  interpreter is a Windows shell, WITHOUT establishing whether the runner
  resolves command names case-insensitively, so where it does not the check
  reports a program that runner does not have.
- Two tests pinning that a bare command line and an inline command span in a
  document **are** read as commands — the two shapes that defeated the withdrawn
  designs, so a future attempt cannot quietly reintroduce the erasure.
- **Every pinned defect carries at least one control** — a near-identical
  fixture differing only in the thing at issue, so the pin cannot pass for an
  unrelated reason. Three defects were uncontrolled until review found them, in
  successive rounds, each time while this very sentence claimed the gap was
  smaller than it was — which is why it now states a PROPERTY that stays true
  as fixtures are added, rather than a count that does not.

  **What "the thing at issue" is varies, and calling it a character or a
  spelling was wrong.** For the build-file miss the control changes only the
  assignment's POSITION, which is the whole point of that defect — it is not
  that a variable's value is invisible, but that an assignment's position does
  not constrain when its value is used. For the here-string assignment the
  control replaces the string's CONTENTS. Neither is a one-character edit, and
  describing controls that way made a narrower guarantee than the fixtures
  give while sounding like a stronger one. Where no such sibling is possible,
  the coupling rests on a deliberate mutation of the step under test instead,
  and each fixture records which of the two it relies on.

  Controls are per DEFECT, not per pin, and the difference is not cosmetic.
  Where one defect is pinned several times over shared machinery, a single
  control can establish the distinction for the whole family; where the pins
  differ in what they would have to do to pass, each carries its own. So a
  pin without its own sibling is usually a family sharing one, and reading the
  two counts as though they should match will suggest gaps that are not there.

  One pin can have **no** control even in principle, and says so in place of
  claiming one: for the command name reached through the path-separator
  rewrite, the already-normalised spelling is understood without the rewrite
  and so reports too, meaning no single-character sibling distinguishes them.
  Its coupling rests on a deliberate mutation of the rewrite instead, and a
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
own issue with a reproduction and what a fix would have to be true of. That
split counts each defect by its PRIMARY direction, which for one of them is not
the direction its fixture asserts: the casing rule's defect is that a spelling
is not seen, and the report it also produces is the trade its partial coverage
creates rather than a second defect. Reconciling the two numbers without that
said would suggest an error where there is none. All are
behaviour the check already had, so nothing is made worse. The ones additionally
pinned by tests that assert the current verdict are marked *pinned* in the table
below; the totals are stated once, under "What lands".

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
restated them, the restatements went stale as each was corrected, and round
after round was spent finding a correction that had landed in one place and
not its siblings. One record per defect, named from the others.

The same reasoning is why this release note is **no longer where the rationale
lives**. That rationale was carried in three places at once — a call-site
comment, this note, and a single 3,692-word bullet in the functional
specification — and the copies drifted exactly as the table's restatements had:
a scope correction reached two of them and not the third, leaving the
specification prescribing a remedy that would have introduced a silent pass.
The record now has one home,
[`DeployGuardRewriteScanRecord.md`](../DesignsAndPlans/DeployGuardRewriteScanRecord.md);
the specification carries the binding invariants and nothing else; this note
says what landed. That split is itself part of what landed, and it is the same
lesson the three withdrawn designs taught, applied to the documents rather than
to the code.

| | |
| --- | --- |
| **#2084** | a build file variable holding a write is not seen, when the assignment sits below the deployment — *pinned (miss)* |
| **#2112** | a runbook sentence naming a write reports the deployment below it — *pinned (false report)* |
| **#2114** | a recipe marked by something other than a tab is not read as a recipe — *pinned (miss)* |
| **#2118** | a deployment is lent a safety flag by the unrelated line above it, when that line ends in a character the shell does not treat as a continuation — *pinned (silent pass) four times, and its bounds pinned too* |
| **#2119** | an ordinary single-value property, in any file of the manifest's format, is read as a command — so a description naming the deployment is reported as performing it — *pinned (false report) four times, because the scope was wrong in four separate ways*. The issue carries them; three of the four move together under one fix. **Not "any text in such a file"**: that wording was the value-kind overstatement the fixtures had already removed, and it is wrong in a way a fix would inherit — whether a list's entries are read depends on the file's LAYOUT, so the same words are passed over when the file is written compactly and read when it is written one entry to a line. The bound is pinned too, precisely so a fix aimed at the categorical version does not change the compact case, which behaves correctly today |
| **#2110** | a folded workflow scalar's positions are not comparable with the file's |
| **#2113** | a write assigned by a live conditional branch is not seen |
| **#2106** | a build file's prerequisites are ordered as written, not as they run |
| **#2108** | a step naming another interpreter has its body read as shell |
| **#2104** | a deployment written as a single-line workflow step whose configuration cannot be read is not reported |
| **#2115** | a body spelling the command in upper case, or in a mixed case OTHER than title case, is not seen (lowercase and title case are) — and the spelling that IS covered is matched inside a block the shell never executes, *pinned (false report)* in both a standalone helper and a continuous-integration step, as the trade any widening of that rule grows. **The miss is scoped by how the RUNNER RESOLVES COMMAND NAMES, not by the shell**, and this row has now been wrong about that scope twice, each time by naming something broader than the evidence. It first said "a Windows-shell body", which is the interpreter-vs-platform confusion #2126 exists to record — that shell also runs elsewhere. The correction then said "POSIX runners", which was still too broad, so it was narrowed again: what is actually demonstrated is a **runner with case-SENSITIVE lookup**, which is what the fixture's `ubuntu-latest` provides and where the two spellings are different files. A host resolving case-insensitively maps both to one executable, and there the miss is real again — so the discriminator is the LOOKUP, and naming any platform family in its place has now been wrong three times running. So the verified claim is the narrow one, and every other resolution mode is explicitly OPEN rather than assumed either way. Where the mode is undeterminable — an unresolvable or matrix-selected runner — the two directions conflict: reporting risks naming a command that does not exist, and not reporting risks the silent pass this check must never produce. **That conflict has since been resolved in the specification, and by neither of those directions**: the check should stop relying on the normalisation for such a deployment and judge the command on its own terms, as it already does for a configuration it cannot trust, so the verdict stops depending on the unknown at all |
| **#2117** | the PowerShell path has no string state, so text inside a here-string is read as commands — *pinned (false report) twice, once per symptom, because they go through different preprocessing and a fix for one can leave the other*: a command named there is reported, and an assignment there is rewritten into a binding that makes a later indirect invocation resolve to a deployment the file never performs |
| **#2116** | a manifest script that invokes a sibling does not see that sibling's config write |
| **#2121** | a script declared in a package manifest is never split at its newlines, so a safety flag on one line covers a deployment on another — *pinned (silent pass)*; the mirror of #2118 |
| **#2122** | a variable whose name differs only in case is not resolved, though that shell resolves it, so the deployment's directory reads as unknown — *pinned (silent pass)* |
| **#2123** | a file whose name carries an upper-case extension is never found by the sweep that discovers files to read — *pinned*, table-driven across every family the sweep accepts, with a parity guard against the production list so the table cannot quietly become a subset again. **Mixed consequence**: a silent pass where the file would run regardless of its name, a discovery blind spot where it would not — which family is which is declared and partitioned at the fixtures, deliberately not restated here. Broad either way, since a file the sweep never yields is never examined at all — though one named explicitly by a file already being read IS opened, so the gap is in the discovery and not in the reading |
| **#2124** | a binding closed with that shell's ordinary statement terminator is not recognised, so the deployment's directory reads as unknown — *pinned (silent pass)* |
| **#2126** | the command-name normalisation is applied on the strength of the INTERPRETER alone, without establishing how the runner resolves command names — so where that lookup is case-SENSITIVE the normalised spelling names a program the runner does not have, and the check reports it — *pinned (false report)*. Stating this as interpreter-versus-platform, as this row did, does not describe the pinned report: a host on another platform may resolve case-insensitively, and there the normalisation is harmless and the #2115 miss is the real defect. What is missing is not a platform test but an established lookup mode. The check's own comment states this must not happen. A companion claim about the path-separator normalisation was withdrawn, and the withdrawal is narrower than "that rewrite is fine": what was checked is a path given to the SHELL'S OWN commands, which reads the same either way on every platform, so the report there is correct. The same documentation warns the alternate separator "may not work when used with native applications that only expect the native directory separator" — and a deployment command is a native application. Nothing pins that case, because nothing demonstrates it; it is an open question, not an approval |
| **#2085** | **no longer an open question — an open implementation gap.** The specification now REQUIRES a declaration from the deployment wherever answering would need another system's execution model, and the check still infers, so this is required work rather than design exploration. The three withdrawals are the evidence that settled it; the divergence is registered in [`_CodeVsDocsAudit.md`](../FunctionalSpecs/_CodeVsDocsAudit.md) as the principal one of this set |

This PR closes none of them.

The common thread, and the most useful conclusion: each attempt asked a question
about a file that can only be answered by modelling **another system** — a
continuous-integration system's execution model, a document format's grammar, a
build tool's variable language — and this check is a scanner. Where such a model
is genuinely needed, the answer is a declaration from the deployment itself
rather than a better approximation here.
<!-- assembled-fragment: 2084-deploy-guard-executable-image.md sha256=5c2157adb2526eed3aba3e332b8d0c6b88402931484b79969034d7b3a8188f1f -->
