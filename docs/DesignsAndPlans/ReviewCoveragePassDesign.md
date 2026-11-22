# Review coverage: every line of contract code through a converged review

Status: process design, 2026-11-22. Owner's request of the same day. The
owner approved the coverage rule, the pass area by area, the order, the
coverage record and the trial on 2026-11-22, and decided the same day that
the review-only pull requests run in a private review repository and that
every finding is fixed or explicitly closed before mainnet (section 8).
He also confirmed the refactor's structure (a new structure built fresh,
the rules carried across), decided that today's facets are reviewed as
well as the new ones (stage 3 of section 6), and approved a canonical specification that the reader pass checks the code
against (section 3.5) and a cross review that cuts the same code a second
way (section 3.6).
Companion: [`RefactorRulesDesign.md`](RefactorRulesDesign.md).

## 1. The problem

The owner wants every line of the contract code to have passed a converged
Codex review, including code that reached `main` before the review loop
existed and code that arrived inside large pull requests.

Measured on `main` at `b3f6537785`, `contracts/src` (368 files, 181,876
lines):

- 11% of lines are unchanged since before the first Codex review
  (2026-05-17).
- 31% are unchanged since before the loop rule (2026-07-05).
- 50 changes added more than 1,000 contract lines each. Together they hold
  60% of all lines added.
- The first batch added about 18,000 lines over nine review rounds, and no
  round came back clean.
- 39 files are longer than 1,000 lines and hold 80,156 lines. The three
  largest are 13,229, 8,863 and 5,051 lines.

A review of a very large change does not converge, and a line nobody has
reviewed since it was written is not covered by any later loop. Neither is
visible today: nothing records which code has been through a converged
review.

## 2. The coverage rule

**A piece of code is covered when its present text passed two layers,
inside a review no larger than the size limit (about 1,500 contract lines
today), holds every approved statement of the specification that governs
it (section 3.5), and has had its cross review (section 3.6):**

1. **A reader pass:** an adversarial read by a thread that did not write the
   code, against the five lenses of the review policy (fund movement and
   accounting, access and authority, re-entry and outside calls, upgrade and
   storage safety, off-chain trust and secrets), written up with what was
   checked and found sound as well as what was found wrong. The reader
   pass also carries a sixth lens, the specification: whether the code
   holds each approved statement that governs it (section 3.5).
2. **A converged reviewer loop** at `full security-critical`, with the
   cross-cutting rules of section 3.4 put in front of the reviewer.

(The limit is counted as lines added or changed under `contracts/src`,
and moves only by the measured ladder of section 2.3.
**Default** both layers.)

Two layers because the trial showed each catches what the other does not
(section 7). The reviewer reported every planted fault of P1 weight, on the
right line, and followed its effect across facets and libraries, so a clean
round means something for P1 and P2. It reported none of the four
lower-severity design points the reader pass found in the same file, and it
missed a rule the unit simply left out until the rules were listed for it.
So the reviewer loop is relied on for P1 and P2, the reader pass for design
points and for what the reviewer filters out, and the gate check of
section 3.4 for a rule that is missing.

- **Converged** keeps its meaning from the review policy: a round on the
  final text with no P1 and no P2 finding.
- **A wave or batch pull request still runs its loop, and does not count.**
  Its code is covered later, by this pass.
- **A later change counts** when its own pull request meets the rule. A
  change in a larger pull request, or one merged without a converged
  security-critical round, leaves the code it touched uncovered until the
  pass reaches it.

### 2.1 What "a piece of code" is

Coverage is recorded per **declaration**: a function, a modifier, a state
variable, a struct, an enum, an event, an error, a `using` directive, and
each contract's own header. The compiler's syntax tree gives the list, so
nothing is found by reading text.

Each declaration is identified by a hash of **what it means, not only of
what it says**:

- its own code, with comments and spacing removed; and
- the hash of every declaration that one of its **unqualified names**
  resolves to: a modifier, an internal function, a state variable, a
  constant, a type, a `using` binding, `super`. The compiler's syntax tree
  gives each resolution.

The hash is taken as the compiler resolves the declaration **in each
deployed contract that carries it**. An inherited function that reaches a
virtual one therefore has one hash per contract whose override differs,
and each needs its own coverage. Where every resolution is the same, the
hashes are equal and the code is covered once.

A name written with its library or contract in front (`LibX.f`) is not
folded in. It means the same wherever the text sits, the name is already
part of the code, and the declaration it names has a hash and a review of
its own.

So the same text in two contracts is one covered item only when the
modifiers, types, constants and inherited functions behind it are the same
too. An upgrade-authorisation function written identically in two
contracts, each with its own owner check, is two items.

The record is a **ledger** of hashes, each with four marks: the reader
pass it passed in, the reviewer loop it passed in, the specification mark
of section 3.5 and the cross review of section 3.6. Each mark names the
contract the declaration was reviewed in, and the report lists every other
place the same hash appears, so what is being counted once is visible.

Coverage of the tree is the share of declaration code whose hash carries
all four marks. The report shows each mark's share beside it, so code that
has had one and not another is visible as that.

Three things follow, and they are the reason for this choice over counting
lines by their last commit:

1. **Moved code stays covered**, as long as what its names resolve to
   moved with it unchanged. A function moved to another facet in a split,
   or carried into a new directory by the refactor, has the same hash. A
   count by last commit would call every moved line new.
2. **Changed code loses coverage by itself.** Any edit changes the hash,
   and an edit to a modifier or an inherited helper changes the hash of
   everything in that contract family that names it. No one has to
   remember to mark it.
3. **A comment-only change keeps coverage.**

### 2.2 What the ledger does not say

It says every piece of code was reviewed. It does not say every
**combination** was: a function unchanged since its review may now be called
from a new place. Three things cover that, and none of them is this ledger:
the review of the new caller (which reads what it calls), the refactor's
comparison run against the tagged code, and the outside audit. The coverage
report states this limit on its first line.

### 2.3 The size limit is measured, not chosen

The limit started at the size the owner approved, about 1,000 lines. It
stands at **about 1,500, provisional**: one planted-fault run on a unit of
1,442 lines was caught in full on 2026-11-22, and a step up needs two. It
moves only on evidence:

- **Up one rung** (1,000, then 1,500, then 2,000) on **two** planted-fault
  runs at the next size, each caught in full and each with a fault of the
  missing-rule kind, which between them cover all five lenses and all
  three depths of section 7.1.
- **Provisional** between the first such run and the second. Reviews may
  proceed at a provisional limit, the report says so beside the figure,
  and a miss in the second run is a miss like any other: one rung down,
  and the units converged at the provisional size are reviewed again.
- **Down one rung** when any planted fault at the current size is missed.
  The units that converged since the last run that was caught in full lose
  their reviewer mark and are reviewed again at the smaller size.
- The aim is **one facet per review**. A facet under the current limit is
  one unit with the library functions it reaches. A facet over it is
  sliced.

The current limit and the run that set it are stated at the top of the
coverage report.

## 3. How a review is made: a review-only pull request

Existing code has no pull request to review. The pass makes one that
changes nothing.

- **Head:** the code exactly as it is on `main` at a pinned commit, plus any
  fixes already made for this unit (section 5).
- **Base:** the same tree with the unit's declarations removed.
- The pull request therefore shows the unit as new code, the reviewer reads
  it against the whole real tree, and no line differs from `main`. It is
  never merged, and it is closed when its unit converges.

The base does not need to compile. Nothing is built from it.

### 3.1 Where: a private review repository

Review-only pull requests are opened in a **private** repository that holds
a copy of the code, with the same reviewer enabled (owner decision
2026-11-22). A review comment on this repository is public, and the pass
will find faults in code that is not yet fixed. This repository shows that
an area is waiting, in review or converged, and never what was found.

- **The review repository receives the code by a one-way copy** of pinned
  commits of `main`. Nothing is ever merged there, and nothing flows back
  from it except through the fix route of section 5.
- **Nothing runs there.** The copy leaves out the workflow files and the
  dependency-update configuration, and nothing else. So no build, no
  deployment and no scheduled job can start, and the tool checks that the
  copy differs from the pinned commit by exactly those paths.
- **Two branches per unit:** `claude/review-<unit>-base` (the base) and
  `claude/review-<unit>-head` (the head), the names the trial used. Both
  are made by the tool, and the tool deletes them when it closes the pull
  request. The pull request keeps its diff and its threads after that.
- **A review-only pull request is recognised by its base**, a branch whose
  name starts with `claude/review-`. Nothing depends on a label or a title
  that someone could forget.
- **It is never merged**, and the tool refuses to open one whose base is
  the copy's `main`.

The first trial units were reviewed on this repository before that
decision. They are closed here, and the trial continues in the review
repository.

### 3.2 The unit

One review holds at most the current limit of section 2.3 in declarations:

| Kind | The unit |
| --- | --- |
| A facet | The facet, plus the library functions it reaches that are not yet in the ledger and do not belong to a shared library with reviews of its own |
| A shared library | Its declarations in slices, each of whole declarations, in the file's own order |
| A standalone contract | The contract, sliced the same way when it is longer |

**The unit is derived, never listed by hand.** A tool reads the compiler's
syntax tree and call graph, finds the declarations a facet reaches, drops
those already covered, checks the size, splits when it is over, builds the
base and the head, and writes the pull request's description: every
declaration in the unit with its file and lines, what each calls outside the
unit, what calls it, and the cross-cutting rules checklist of section 3.4
with the unit's entry points listed against it.

A file that fits no unit by itself (the three largest libraries) is
sliced by whole declarations. Its storage structs form their own unit, read
first, because every later slice depends on them.

**A declaration larger than the limit is reviewed in parts.** One exists
today: the main storage struct is several thousand lines by itself. Such a
declaration is cut at its members (a struct at its fields, in order, each
part inside the limit), and the ledger holds it as its parts:

- Each part has its own hash and its own marks, and names the hash of the
  whole declaration it was cut from.
- The declaration is covered when every one of its parts carries every
  mark **and** all were cut from the declaration's present text. An edit
  to one field changes the whole declaration's hash, and with it every
  part's standing, because a storage layout is read as one thing.
- Its cross review is the closing read of the whole (section 3.6), by one
  reader, which looks for what the parts cannot show each other.

Only a declaration with members can be cut this way. A function longer
than the limit is not cut: it is a finding, and it is split in the code.

### 3.3 The loop on one unit

1. The reader pass comes first, by the security thread or by another
   thread that did not write the unit. A P1 or P2 it finds is fixed on the
   unit's fix branch before the pull request is opened. Its write-up is
   posted on the pull request in the review repository, each finding as a
   thread and the list of what was checked and found sound as one comment.
2. The reviewer runs at `full security-critical`, asked to check each
   entry point of the unit against the checklist in the description.
3. Every finding gets one of the three answers the policy allows: accepted
   and fixed, refuted with the code quoted, or deferred to a card that
   carries the label `review-finding` (section 8).
4. Fixes are made on the unit's fix branch (section 5). The review-only pull
   request is cut again with the fixes in its head, and the reviewer runs
   again.
5. The unit converges on **one** round with no P1 and no P2, on a head
   that holds every accepted fix, **and with every earlier thread on the
   pull request answered.** A thread is answered when it carries a closing
   line of section 8, or, for a P3 only, the line `Deferred to #N` naming
   an open card that carries `review-finding`. The trial showed the
   reviewer does not repeat a finding it has already posted, so a quiet
   round over an unanswered thread is not a clean round, and a second run
   on an unchanged head is not a second read.
6. The round cap and the root-fix rule of the review policy apply
   unchanged: the same seam three rounds running means one fix at the root,
   and round 15 is the stop.

A deferred finding does not block convergence only when it is P3. A P1 or P2
is fixed, or refuted with evidence. Convergence and the launch are two
different gates: a deferred P3 lets its unit converge, and its card still
refuses a mainnet until it is closed (section 8).

### 3.4 The cross-cutting rules, and the gate check

Some rules belong to no one facet: every entry point of a certain kind must
carry a certain check. The trial's known-answer unit was a real gap of that
kind, and the reviewer missed it on a plain run, because nothing in the
unit contradicted itself. It reported the gap once the rules were listed in
the description. A reviewer, and a reader, catch what a unit says wrongly
far more readily than what it leaves out.

So the rules are written down once, and used twice.

**The rules file.** One file lists each cross-cutting rule: its statement
in plain words, the kind of entry point it applies to, the check that
satisfies it, and every exemption with its reason. Examples of the kind:
which entries refuse a flagged wallet and which stay open for a close-out,
which refuse under a pause of the platform or of an asset, which refuse a
held position, which ask the Terms rule, which hold the re-entry guard,
which may be called only by the Diamond itself.

**Use 1: the checklist.** The tool writes the rules into every review-only
pull request's description, with the unit's entry points listed against
each. The reader pass works from the same list.

**Use 2: the gate check.** A mechanical check reads the compiler's syntax
tree, lists the checks each entry point carries (its modifiers and the
gate calls its body reaches before it changes state), and compares them
with the rules file. An entry a rule applies to, with neither the check nor
an exemption, is reported. It extends the check that already reads caller
gates for the ledger of open steps.

**Where they live, and when the check blocks.** What the gate check
reports on its first runs are findings, so the rules file and the check's
output stay in the review repository until it reports nothing. From then on
the rules file and the check live on this repository and the check blocks:
a new entry point is refused until it carries each check its kind requires
or is listed as exempt with a reason.

### 3.5 The specification lens

The five lenses ask whether the code is safe. None of them asks whether it
does what the platform is meant to do, and a review that reads only the
code can only confirm the code. The owner approved a canonical
specification on 2026-11-22: one file for each domain, written from his
decisions and the approved designs and never from the code, each rule a
numbered statement with a permanent id. Its form, its folder and the tests
generated from it are a design of their own, which follows this one. This
section says only what the review does with it.

**The statements are in front of both layers.** The description of a
review-only pull request carries, beside the rules checklist, every
approved statement that governs the unit, by id and text, and the rows of
the lifecycle model the unit's entry points take part in. The reader works
through them. The reviewer is asked to check each entry point against them
as it is against the checklist.

**The reader fills a trace table,** one row for each statement:

| Column | Holds |
| --- | --- |
| Statement | Its id |
| Where the code holds it | The declaration, and the line of the check or the movement |
| Refusal | For a refusal statement, the error the code raises |
| Tests | The tests that name the statement |
| Verdict | **Holds**, **differs**, or **not found** |
| Review | The review number |

**The table is read in both directions.** From the specification to the
code: every statement that governs the unit gets a row and a verdict. From
the code to the specification: every behaviour of the unit that an outside
caller can reach is matched to a statement, and one that matches none is
listed as **the specification is silent**.

**What each verdict becomes.**

- **Holds** needs nothing more.
- **Differs** and **not found** are findings like any other (section 8),
  and the code is the candidate fault. The finding closes when the code is
  fixed, or when the owner decides the statement was wrong and it is
  changed with his decision recorded. The reader never settles one by
  editing the statement.
- **The specification is silent** goes to the owner as a question with a
  recommendation. His answer becomes a statement, or the behaviour is
  removed. A behaviour never enters the specification because the code was
  found doing it.

**The specification mark.** The ledger gains a mark beside the reader's
and the reviewer's: the specification mark, written when every statement
that governs the declaration has a verdict of holds, and nothing the
declaration does is still on the silent list. So the two
safety layers and the specification check can be reported one by one, and a
unit read before its statements were approved shows exactly what it still
owes.

**The mark is bound to the statements it was given for.** A declaration's
code hash does not change when a statement does, so the mark records what
it was judged against: the id and the hash of the approved text of every
statement that governs the declaration, and the hash of the list of
statements in each section it drew from. The mark is void when any of
those changes: a statement reworded by a new approval, or a statement
added to, dropped from or moved out of the section. The reader then traces
the changed statements again, and only those. So a rule the owner changes
uncovers the code it governs, exactly as an edit to the code does, and the
report cannot read complete against a rule nobody has checked.

**Order.** A domain's statements are approved one step ahead of the review
of its code, so a unit of stages 1 to 3 is opened with its statements in
the description. The units of the trial were read before any statement
existed. They keep their two marks, and the reader returns to each with the
trace table when its domain is approved. The reviewer runs again only if a
verdict changes the code, which changes the hash and reopens the unit as
any change does.

**Where the table lives.** In the review repository, with the findings. A
verdict of differs on code that moves funds is a finding, and is no more
public than any other. This repository shows the counts for each domain:
statements, held, differing, not found, and behaviours with no statement.

**The gate check's rules come from the same place.** A platform-level
statement (every entry point of a kind screens its caller, say) is a row of
the rules file of section 3.4 once it is approved, so the checklist and the
specification cannot state two versions of one rule.

### 3.6 The cross review: a second cut

A unit is close to a file: one facet with the library code it reaches, or a
slice of a large library. Section 2.2 states the limit of that: every piece
of text is reviewed, and not every combination. A second pass in the same
grouping would cost as much again and look from the same angle. The owner
asked on 2026-11-22 for a review that cuts across the first, and approved
this form the same day.

**Every line is reviewed in two groupings, by two readers: once with its
file, and once with the user action that runs through it.**

| Code | First review | Cross review |
| --- | --- | --- |
| Standalone contracts, rule libraries and today's facets (stages 1, 2 and 3a) | By file or slice | By user action: each action that runs through them, followed from its entry to the last change of a balance |
| The refactor's new facets (stage 3b) | By user action, since the refactor is built one action at a time | By file: each finished facet read whole |
| A file reviewed in slices | By slice | A closing read of the whole file by one reader, for what fell between slices and for slices that disagree |

**A review by action** follows one user action through every facet and
library it touches, and reads it against that action's statements and its
step in the lifecycle model. The unit tool builds it from the call graph it
already reads, as a review-only pull request cut the other way. The size
limit applies. An action too long for one review is cut where it calls back
into the platform's own entry points.

**What form it takes.** For an action that moves funds: a reader pass and a
converged reviewer loop, as for a first review. For a read-only view: the
reader pass alone.

**The reader of a cross review is never the reader of the first review of
the same code.** The tool that writes the mark refuses when the two are the
same thread.

**The fourth mark.** The ledger carries the cross review as its own mark,
beside the reader's, the reviewer's and the specification's. Covered means
all four.

**A declaration on no action's path is listed.** It is dead code, or
behaviour nobody specified, and each one becomes a question.

**A third cut, by machine: by stored value.** For every stored figure that
holds funds or a position's status, a generated table lists every place
that writes it and every place that reads it. Each writer is matched to the
statement that permits it. Four checks of this kind exist today, each for
one figure (the loan's terms, its collateral, its start and term, and raw
payouts). The table makes the set complete, and a new writer with no
statement is refused. It is read from the compiler's syntax tree, costs no
reading, and runs on every change.

**Order.** Actions that move funds are cross-reviewed first.

## 4. The records

| Record | Where | Holds |
| --- | --- | --- |
| The ledger | This repository, beside the contracts | Each hash with its four marks: the reader pass, the reviewer loop, the specification and the cross review, each as an opaque review number. No finding, no description |
| The coverage report | Generated, printed by one command and by CI | Per area and per file: the share that carries each mark and the share that carries all four, each uncovered declaration by name, and the trace counts for each domain |
| The stored-value table | Generated, in this repository | Each stored figure that holds funds or status, every writer and reader of it, and the statement that permits each writer (section 3.6) |
| The trace tables | The review repository, one for each unit | Each statement that governs the unit, where the code holds it, its tests and its verdict (section 3.5) |
| The order list | This repository, beside the ledger | The areas, their order and their state: waiting, in review, converged |
| The findings | The review-only pull requests, in the review repository | Every finding is a review thread: its round, its severity, how it was answered and how it was closed (section 8) |
| The findings report | Generated by one command from those threads, kept in the review repository | Every finding of the pass in one table. Fixed at the audit freeze and handed to the auditors privately |
| The review index | The review repository | Each review number: its pull request, its unit, its reading thread, its mode and rounds |

**What this repository shows is areas and status, never findings.** The
ledger says code was reviewed and nothing about what was found. The report
shows what is not yet covered, which is true of a platform that has not
launched and reaches zero before it does.

The findings have one home, the threads. The findings report is read from
them and is never edited by hand, so the two cannot disagree.

**A ledger entry is checked, not trusted.** The tool that writes an entry
recomputes the hashes from the reviewed head, and a check in CI refuses an
entry whose hash matches no declaration in the tree at the commit it names.

## 5. Where fixes go

A fix is contract code, so it follows the standing rule: it joins the batch
or the second wave, on this repository. It is never applied in the review
repository, whose copy only follows `main`.

- Each unit has a fix branch, handed to the batch assembler like any other
  ready branch, described in neutral words.
- The unit's review is cut against that branch, so convergence is judged on
  the fixed code before the fix lands.
- When the fix reaches `main`, the hashes recorded at convergence match the
  tree and the unit is covered. If the fix was changed on the way in, the
  hashes do not match and the unit shows as uncovered. That is the wanted
  result.

## 6. Order, and the fit with the refactor

The refactor design (section 3.1 there, confirmed by the owner on
2026-11-22) builds a new structure in a new directory and carries the rules
across. The ledger makes the fit simple: **carried code keeps its hash and
stays covered, and rewritten code arrives in small reviewed pull requests
that count by themselves.**

| Stage | What is reviewed | When | Counts after the refactor |
| --- | --- | --- | --- |
| 0 | The trial (section 7) | Now | It is a real unit |
| 1 | Standalone contracts: the vault and backstop implementations, the token and cross-chain contracts, the price guard, the sanctions lists, the governance contracts, the listing executor | Now, where the batch does not touch them | Yes: the refactor does not recut them |
| 2 | The rule libraries: the interest ledger, the loan clock, the numeraire rule, the vault outflow policy, the encumbrance and custody writers, the fee host's rules, the reward and recycling rules | Each after the wave that touches it has landed | Yes, declaration by declaration. A declaration the refactor edits is reviewed again in the pull request that edits it, and only that one |
| 3a | Today's facets | Each after the wave that touches it has landed, beside the refactor | Declaration by declaration, where the refactor carries the text unchanged. See below |
| 3b | The refactor's new facets | With the refactor pass, as each is written | Yes: they are the launched code |
| 4 | Read-only facets and metrics, today's and the new | Last | As stage 3 |

Inside every stage, code that moves funds goes first, and code the batch
touches waits for its wave.

**Stage 3, the facets: today's code and the new code are both reviewed.**
The first form of this design left today's facets out, because the
refactor writes a new structure and a review of code about to be rewritten
looked like a review done twice. The owner decided on 2026-11-22 that
today's code is reviewed too. The reasons are sound ones:

- **Today's facets are what runs.** They are live on the testnets until
  the switch, and they are the reference the refactor is compared against.
- **The comparison run proves the new code behaves like the old. It does
  not prove the old was right.** A fault carried faithfully passes the
  comparison. A finding in today's facet is fixed in the rule before it is
  carried, and becomes a test the new code must pass.
- **The reading is not thrown away.** A declaration carried unchanged
  keeps its hash and its marks. For one that is rewritten, the reader of
  the new facet starts from the old unit's findings and trace table.

**3a, today's facets.** Each is a unit like any other: by file, inside the
size limit, with the rules checklist and the statements in the
description, a reader pass by a thread that did not write it and a
converged `full security-critical` loop. Its cross review is by user
action (section 3.6). A facet the batch touches waits for its wave.

**3b, the new facets.** Each is written in pull requests that meet the
coverage rule themselves: inside the size limit, with the checklist and
the statements in the description, a reader pass by a thread that did not
write it, and a converged loop. Every line of the new tree is covered as
it is written. Their cross review is by file.

Three things keep 3b honest:

- **A new facet's pull request counts only if it is small.** A refactor
  step that arrives as one large change is cut into units by the pass like
  any other uncovered code.
- **A finding of 3a on a rule is carried as a test.** The new facet's
  review confirms the test is present and passes, so a fixed finding
  cannot reopen in the move.
- **The gate check of section 3.4 runs on both trees**, since it is
  mechanical and costs nothing.

**Which tree the report is read on.** The audit tag and a mainnet are
gated on the tree that is launched. Today's tree has its own report, read
beside it, and its findings are closed by the same rule (section 8)
wherever they were found.

Stages 0 to 2 hold about half the lines and most of the rules that move
funds, and run beside the batch. Stage 3a adds the other half once, at
about the cost of the first half.

**What is not in the pass**, each listed in the order list with its reason:

- `vendor/`: code taken from upstream at a pinned commit. It is checked by
  comparing it with upstream, not by review.
- The storage-layout probes: never deployed.
- Interfaces: an interface's declarations are covered with the code that
  implements them.
- Deploy and configure scripts under `contracts/script`: outside
  `contracts/src`. The deploy rehearsal is their check. A review pass over
  the deploy and configure scripts is a separate card, recommended after
  this one.

## 7. The trial

One real unit first: `ProfileFacet` (847 lines), run by the security
thread. It answers what cannot be known from here:

1. Does the reviewer run on a pull request whose base is not `main`, and on
   which trigger?
2. Does it read the whole unit, or stop part-way? Checked with a
   **known-answer unit**: one past fault, already fixed, is reviewed as its
   text stood before the fix. The pass must report it.
3. How noisy is a second run on an unchanged head? This sets the number of
   clean rounds section 3.3 asks for.
4. Is 1,000 lines the right size? Answered by the ladder of section 2.3.
   The trial also runs one slice of a large library.
5. Does any workflow, site preview or Worker build run in the review
   repository, on a pull request, a push or a schedule? None should.
6. How long does one unit take from opening to convergence? This sizes the
   pass.

7. Does the reviewer's mode change what it does on a review-only pull
   request? (First result below: it did not.)

**First result (2026-11-22).** The review-only pull request for
`ProfileFacet` came back clean after one round, in about ninety seconds for
847 lines. A plain review and a `full security-critical` review gave the
same output, and the reviewer's separate security pass did not start. The
security thread's own read of the same file had found four low-severity
points, and the reviewer added none.

**Second result (2026-11-22).** A copy of the same file with three faults
planted in it was reviewed at `full security-critical`. The reviewer
reported all three as P1, each on the right line, within about two minutes,
and followed each one's effect across facets and libraries. A whole-file
review-only pull request therefore works, and a clean round is evidence for
P1 and P2.

**Third result.** A unit of 1,442 lines with three planted faults: all three
reported as P1, on the right lines, in about three minutes. The size limit
moved to about 1,500 (section 2.3).

**Fourth result.** A second run on the same head, with the first run's
threads still open, reported nothing: the reviewer does not repeat what it
has posted. So one clean round is the rule, and it counts only with every
earlier thread closed (section 3.3).

**Fifth result.** The known-answer unit, 380 lines, as its text stood
before a real gap was fixed: a rule that every sibling entry elsewhere
carries and this one left out. A plain run came back clean and **missed
it**. With the cross-cutting rules listed in the description, the next run
reported it as P1. That is the reason for section 3.4.

**Sixth result.** No workflow ran in the review repository.

Questions 1, 2, 3, 4, 5 and 7 are answered. Question 6 (the time for a unit
with fixes) and one slice of a large library remain.

### 7.1 The planted-fault run

A clean round means only as much as the reviewer is known to catch. So
units with faults planted in them are reviewed, on branches made for that
and never merged:

- The base of a planted-fault pull request is named
  `claude/planted-<n>-base`, so it is never read as review-only and the
  launch check of section 8 does not count its threads. It is closed when
  read.
- **Branch clean-up is the tool's job, not a person's.** It deletes the
  branches of every pull request it closes, and its weekly report lists any
  `claude/review-` or `claude/planted-` branch that has no open pull
  request. The review repository's access is set up to allow that.
- The faults cover each of the five lenses, at more than one depth: one
  visible in a single function, one that needs two functions read
  together, one that needs a library the unit calls.
- **Every run includes a missing-rule fault:** a check removed from an
  entry point that no sibling in the unit carries, so nothing in the unit
  contradicts it. It is the kind the reviewer missed on a plain run.
- The result is a table: each planted fault, and whether the reviewer
  reported it, whether the reader pass reported it (run by a thread that
  did not plant it), and in which round.
- **It repeats by itself.** After every ten units (**Default**), and
  before any step up the size ladder, the tool opens a planted-fault pull
  request at the current size with faults drawn from a kept set and new
  ones added by the security thread. No unit's reviewer mark is written to
  the ledger while the latest run has a miss.
- A fault the reviewer missed is kept in the set for every later run.

The **Default** values after the trial: one clean round, about 1,500 lines
a unit, a planted-fault run every ten units.

## 8. Every finding closed before mainnet

A private review must not become a place where an open finding is
forgotten. So the launch refuses until every finding has an explicit end.

**A finding** is a review thread on a review-only pull request, or a card
carrying the label `review-finding`. A finding deferred from the pass gets
its card in the review repository. A finding deferred from an ordinary
pull request on this repository, where the thread is already public, gets
its card here, and the weekly sweep labels the cards earlier deferrals
already opened.

**A finding is closed in exactly one of three ways**, written as the first
line of the thread's last reply, and the thread resolved:

| First line | Means | Who may write it |
| --- | --- | --- |
| `Closed: fixed in <commit>` | The fix is that commit | The thread that fixed it |
| `Closed: refuted` | The reply quotes the code that disproves it | The triaging thread |
| `Closed: accepted by the owner` | Left as it is, with a link to the owner's own words | Only on the owner's decision |

**A deferral is not an end.** `Deferred to #N` keeps the finding open until
card N is closed, and card N carries `review-finding`.

**A commit on this repository that fixes a finding of the pass is described
in neutral words.** The link between the two is the closing line in the
review repository, never the commit message here.

**The launch check `review findings closed`** refuses a mainnet while any
of these is true:

1. A review-only pull request is still open.
2. A thread on one is unresolved, or resolved with no closing line.
3. A closing line names a commit that is not in the code being launched.
4. A `review-finding` card is open, in either repository.
5. The coverage report is below 100% and an uncovered declaration is not
   listed with the owner's acceptance.

Point 5 is what ties a fix to the launch: a fix that never reached `main`,
or changed on the way, leaves its declarations uncovered (section 5).

It reads both repositories, the review repository with a read-only token
held as a secret. **No answer is a refusal, never a pass**: a missing or
expired token stops a launch. It runs in three places: the release gate
workflow, the mainnet deploy's preflight, and the weekly sweep, which only
reports. On this repository its output is a verdict and counts (how many
open, in which area), never a finding's text. One command produces the
verdict and the findings report, so the report the auditors read is the
one the launch was judged on.

## 9. After the pass: keeping coverage

- A contract pull request that meets the rule adds its own hashes. A weekly
  sweep reads every merged contract change, records the ones that count, and
  lists the declarations the others left uncovered. Those join the order
  list.
- The coverage report runs in CI as a warning now.
- **At the freeze before the audit it blocks:** the tag is cut only when the
  report reads 100%, or every uncovered declaration is listed with its
  reason and the owner's acceptance.
- The auditors are given the ledger and the report.

## 10. Tests (acceptance)

1. A function moved to another file keeps its coverage. The same function
   with one changed operator loses it. A comment-only change keeps it. Two
   functions of identical text behind modifiers of different bodies have
   different hashes, and so does one inherited function in two contracts
   that override a virtual function it calls differently. An edit to a
   modifier uncovers every function that names it and no function that
   does not.
2. The unit tool, given a facet, lists exactly the declarations the
   compiler's call graph reaches, drops covered ones, and splits a unit over
   the limit into slices of whole declarations.
3. A review-only pull request's head differs from the pinned commit only by
   the unit's fix branch, and its base differs from its head only by the
   unit's declarations. The tool refuses to open one otherwise.
4. A ledger entry whose hash matches no declaration at its commit is
   refused in CI.
5. The sweep records a contract change of 400 lines with a converged
   security-critical round, and lists the declarations of a change of 3,000
   lines as uncovered.
6. The report's total equals covered declaration code over all declaration
   code, and every exclusion appears with its reason.
7. The trial's known-answer unit is reported by the pass, and the
   planted-fault table states, per fault, which layer reported it.
8. The launch check refuses with one open review-only pull request; with
   one unresolved thread; with a resolved thread that has no closing line;
   with a closing line whose commit is not an ancestor of the launched
   commit; with one open `review-finding` card; and with no answer from the
   repository. It passes when none of those holds and the report reads 100%.
9. A pull request against `main` is never read as review-only, and the tool
   refuses to open a review-only pull request whose base is `main`.
10. The findings report lists exactly the threads of the review-only pull
    requests, and a thread added after the report was generated makes the
    committed report stale and the check say so.
11. A hash with the reviewer's mark and no reader mark is reported as not
    covered, and so is the reverse. The ledger's entry check refuses a
    reader mark whose reading thread is the thread that wrote the fix
    under review.
12. A planted-fault pull request is not counted by the launch check and
    its branches cannot be opened against `main`.
13. With a miss in the latest planted-fault run, the ledger's entry check
    refuses a new reviewer mark, the limit steps down one rung, and the
    units converged since the last full catch are listed as needing review
    again. A step up is refused without a full catch at the next size.
14. The tool deletes the branches of a review-only pull request it closes,
    leaves those of an open one, and reports a `claude/review-` branch with
    no open pull request.
15. On this repository the launch check prints a verdict and counts, and
    no text from a review thread. With no token for the review repository
    it refuses.
16. The one-way copy differs from the pinned commit by exactly the
    workflow files and the dependency-update configuration, and nothing
    runs in the review repository.
17. A round with no new finding does not converge a unit while an earlier
    thread on its pull request has no closing line.
18. The gate check, on a tree where one entry point lacks a check its kind
    requires, reports that entry and that rule. It passes when the entry is
    given the check, or an exemption with a reason, and refuses an
    exemption with no reason.
19. Every review-only pull request's description carries the checklist
    generated from the rules file, with the unit's entry points listed
    against each rule. A description that differs from what the file
    generates is refused.
20. A planted-fault run with no missing-rule fault does not count toward a
    step up the size ladder.
21. A declaration with a reader mark and a reviewer mark and no
    specification mark is reported as not covered, and names the statements
    it still owes a verdict on.
22. A trace table with a blank verdict, or a row whose statement id is not
    in the approved specification, is refused.
23. A specification mark is not written while a row of the unit's table
    reads differs or not found, or while the unit has an entry on the
    silent list.
24. A review-only pull request's description lists the approved statements
    that govern its unit, generated from the specification. A description
    that differs from what the specification generates is refused.
25. A planted fault that breaks a stated rule and no safety lens (a fee
    taken at a rate other than the stated one) is reported by the trace
    table as differs.
26. A declaration with every mark but the cross review is reported as not
    covered.
27. A cross-review mark whose reader is the reader of the same
    declaration's first review is refused.
28. The unit tool, given a user action, builds a review whose declarations
    are exactly those the action reaches, and cuts it at the platform's own
    entry points when it is over the size limit.
29. A declaration no action reaches appears on the list of section 3.6.
30. The stored-value table lists a writer added in a test tree, and the
    check refuses it until a statement permits it.
31. A file reviewed in slices does not carry its cross-review mark until
    its closing read is recorded.
32. A statement reworded by a new approval, with no change to the code,
    voids the specification mark of every declaration it governs and of no
    other. A statement added to a section voids the marks drawn from that
    section until each is traced against it.
33. A unit with one P3 thread that reads `Deferred to #N`, where card N is
    open and labelled, converges. The same thread with no card, or a P2
    deferred the same way, does not. The launch check still refuses while
    card N is open.
34. A declaration larger than the limit is cut into parts inside the
    limit. It is reported as not covered while any part lacks a mark, and
    again after an edit to any one of its members.

## 11. Residuals

- **Text, not combinations** (section 2.2).
- **Two layers, both ours.** The pass is a reader pass and a Codex loop.
  It does not replace the outside audit and is not presented as one.
- **Either layer can miss.** The planted-fault run measures the reviewer
  throughout the pass, and the report states the catch rate beside the
  coverage figure. A coverage figure is never shown without it. Nothing
  measures the reader pass the same way: a planted fault is known to the
  team that reads. Its check is the reviewer and the outside audit.
- **Planted faults are ours.** The reviewer is measured on the kinds of
  fault we thought to plant.
- **A rule nobody wrote down is checked by no one.** The checklist and the
  gate check cover the rules in the rules file. A rule missing from the
  file is found only by a reader who knows it, or by the outside audit. The
  file is reviewed like code, and a finding of the missing-rule kind adds
  its rule to the file before it is closed.
- **Findings are private until fixed.** This repository shows that a unit
  converged, never what was found. A fix's commit is public when it lands,
  as every fix is.
- **The launch check depends on a token that reads the review repository.**
  Without it the check refuses, which is the safe direction and a step the
  owner must keep alive.
- **Two repositories can drift.** The copy is one-way and by pinned commit,
  and the tool refuses a head that differs from the pinned commit by
  anything but the unit's fix branch.
- **A closing line is written by a person or an agent.** The check verifies
  the commit and the coverage, not the judgement in a refutation. The
  auditors receive every refutation in the findings report.

## 12. Alternatives considered

1. **Count a line by its last commit.** Rejected: every facet split and the
   whole refactor would read as new, and carried code would be reviewed
   twice.
2. **Review-only pull requests on this public repository.** Considered,
   and chosen for an hour on 2026-11-22 before the owner replaced it:
   findings on unfixed code would be public. The launch check that came
   with it is kept.
3. **A pull request that edits every file trivially so the loop runs.**
   Rejected: it changes history for no change in code, and the size problem
   stays.
4. **Ask for a review of whole files outside a pull request.** Rejected:
   no rounds, no threads, no record of convergence.
5. **Leave today's facets out, since the refactor rewrites them.** This
   design's first form. Overruled by the owner on 2026-11-22: today's
   facets are what runs and what the new code is compared against, and a
   fault carried faithfully passes a comparison (section 6, stage 3a).
6. **Skip the pass and rely on the refactor.** Rejected: the rule libraries
   are carried, not rewritten, and they hold the rules that move funds.
7. **One facet with all its libraries per review.** Rejected: one facet
   reaches the 13,229-line shared library, and the size limit is the point.
8. **Make wave pull requests count.** Rejected on the measurement: nine
   rounds, none clean.
9. **A register file of findings committed to `main`.** Rejected: it would
   publish the findings, and it would be a second copy of the threads that
   could disagree with them.
10. **Recognise review-only pull requests by a label.** Rejected: a
    forgotten label hides a pull request from the launch check. The base
    branch's name cannot be forgotten.
11. **The reviewer loop alone.** Rejected on the trial: it reported every
    planted P1 and none of the reader's four design points.
12. **The reader pass alone.** Rejected: one reader shares one blind spot,
    and the loop costs minutes per unit.
13. **Choose the size by judgement.** Rejected: a planted-fault run takes
    three minutes and measures it.
14. **A second clean round for units that move funds.** Dropped on the
    trial: a second run on an unchanged head is not a second read.
15. **The checklist alone, with no gate check.** Rejected: the checklist
    relies on the reviewer reading it every time. The same rules checked
    mechanically cannot be skimmed, and the check stays after the pass.
16. **The gate check alone, with no checklist.** Rejected: the check sees
    that a gate is present, not that it is the right gate in the right
    place.
17. **Move the limit on one run.** Rejected: one run of three faults cannot
    cover five lenses at three depths. Two runs that do are asked for, and
    the limit is provisional in between.
18. **Hash a declaration's own text only.** Rejected: identical text behind
    different modifiers or overrides would be covered once.
19. **Fold in everything a declaration reaches, to any depth.** Rejected:
    one edit low in a shared library would uncover most of the tree, for a
    change whose own review already lists what calls it. Unqualified names
    are folded in because their meaning depends on where the text sits.
    Qualified names are not, because theirs does not.
20. **Check the code against the specification in a pass of its own, after
    the review.** Rejected: the same code would be read twice by two
    readers, and the second would start from the first's conclusions. The
    reader who has the code open is the one placed to say where a rule is
    held.
21. **Fold the specification check into the reader mark.** Rejected: the
    units of the trial would lose a mark they earned, and the report could
    not say which of the two a declaration still owes.
22. **Wait for the whole specification before any review.** Rejected: it
    puts every review behind the slowest domain. One domain ahead of its
    review is enough, and the order of the pass sets the order of the
    drafting.
23. **Let a behaviour the specification is silent on pass when the reader
    judges it sound.** Rejected: it is how a specification comes to
    describe the code. The owner answers, and the answer is recorded.
24. **A second review in the same grouping.** Rejected: the same cost
    again, from the same angle. A fault that lives in the sequence of two
    correct functions is seen only by following the sequence.
25. **The cross review by the same reader.** Rejected: the second read
    would start from the first's conclusions.
26. **A reviewer loop on every cross review, views included.** Rejected: a
    view moves nothing, and the first review already put it through the
    loop. The reader pass alone is kept for it.
27. **Leave the stored-value cut to the four checks that exist.** Rejected:
    four figures are guarded and the rest are not, and nothing says which.

## 13. Recommendation

Adopt the coverage rule and the ledger, with the specification as the
reader's sixth lens and the cross review as a second cut, each with its own
mark. Run the pass in the private review repository.
Start stages 1 and 2 beside the batch. Review today's facets as their
waves land, and the new facets inside the refactor pass, facet by facet. Block the audit tag on the report, and a mainnet on the launch
check of section 8.

## 14. Build split

| Part | Owner area | When |
| --- | --- | --- |
| The private review repository: created, the reviewer enabled, workflows switched off, the project's threads given access, a read-only token for the launch check | Owner step | First |
| The trial on `ProfileFacet`, with a known-answer unit and the planted-fault run | Security | Started on this repository, continues in the review repository |
| The unit tool: declarations, call graph, base and head, description | Test tooling | Now |
| The rules file and the gate check (section 3.4) | Test tooling builds the check. Security writes the rules. Design rules on a disputed rule | Now |
| The planted-fault run that repeats by itself, the size ladder, the branch clean-up | Test tooling, with the security thread's fault set | With the unit tool |
| The ledger, the report, the CI warning, the entry check | Test tooling | Now |
| The order list, with the batch's changed files | Security, with the batch assembler's file list | Now |
| The pass, stages 1 and 2: the reader pass and the reviewer loop on each unit | Security leads. A unit is not read or triaged by the thread that wrote it | After the trial |
| The weekly sweep | Issue hygiene | When the ledger exists |
| The launch check `review findings closed`, the findings report, the `review-finding` label | Governance, with test tooling | Before the pass starts |
| The policy text: the rule, the size limit, the closing lines, the freeze gate | Governance | With the ledger |
| Stage 3a, today's facets | Security leads, with readers from threads that did not write each facet | After each facet's wave has landed |
| Stage 3b, the new facets | The threads that write the new facets, each read by another | With the refactor pass (#3926) |
| The cross review: the unit tool's cut by action, the fourth mark, the list of declarations on no path | Test tooling builds. Security leads the reading, with a second reader for each unit | After the first reviews of stage 1 |
| The stored-value table and its check | Test tooling. Design rules on a disputed writer | With the gate check (#3944) |
| The specification lens: statements in the description, the trace table, the specification mark, the counts in the report | Security reads. Test tooling builds the table's check and the description | With the first approved domain |
