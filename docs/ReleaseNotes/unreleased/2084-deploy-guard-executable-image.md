# Deploy guard: a build file's recipes are read as the shell receives them

The deploy guard refuses to trust a configuration's checked-in contents when the
file deploying it rewrites that configuration first. Deciding whether a rewrite
happens means reading the file — and in a build file it was reading something
that does not correspond to what runs.

In a build file, recipe variables are expanded before the shell ever sees them,
so a variable holding a redirection really is a write. The check read the
unexpanded file, where that write is only a name, and found nothing: the
configuration was rewritten and its checked-in preservation setting trusted
anyway. That is a silent pass on the hazard the check exists for.

The fix is to ask the question of a transformed copy — the recipes expanded in
place, same lines, same order, nothing removed. Adding text is the safe
direction here: expanding something wrongly can only invent a write and cost a
report, while failing to expand costs nothing the check did not already miss.

## One model of the build file's variables, not two

The variable model existed twice — once for finding deployments, once for
finding writes — as two identical copies that were meant to describe the same
thing. Every correction to the build tool's semantics therefore had to be made
in both, or the two halves of the check would answer in different models. That
is why the duplication had to go first — and it turned out to be worth more than
tidiness, because the two halves needing to answer *differently* about an
uncertain name is only expressible once there is a single model to disagree
over.

Two rules survive, and one of them is the whole story.

The first is lexical and small: an **escaped currency symbol is not a variable
reference**. The build tool reduces the doubled form to a literal and expands
nothing, so a recipe echoing it is inert text — but a matcher looking only for
the single form finds one starting at the second character and substitutes,
inventing a rewrite in a recipe that performs none. This one also fixed a
long-standing false report on the deployment-finding side, as soon as both sides
read the same model.

The second replaced a chase. Review found **eleven** ways the expansion did not
match the build tool across three rounds — conditionals in both directions, a
name explicitly removed, that removal itself sitting inside a dead branch, a
settable recipe marker, that marker changing partway down the file, a
certainty that never came back. Each correction was more faithful than the last,
and each introduced a fresh defect; by the third round every finding was an edge
of the previous round's fix, which is the signature of a rule with no end rather
than one nearly finished.

So the question changed. Instead of *what value does the tool give this name* —
which needs an interpreter — the model asks the one thing about a name it can
decide by reading:

> **Does this file give the name exactly one answer?**

A name is **ambiguous** if it is assigned more than once, assigned anywhere
inside a conditional, or named by a removal directive. No evaluation, no
ordering, no branch analysis — only whether the file is unanimous. That single
rule replaces every conditional-related correction from all three rounds, and it
cannot grow an edge list, because it never tries to decide which value wins.

The two consumers then resolve ambiguity differently, which is possible only
because they share one model. Their starting points differ: the deployment scan
already expanded before this work and the rewrite question did not expand at
all. So the rewrite question substitutes only unambiguous names — it cannot
invent a rewrite, since the value it uses is the file's sole answer, and what it
declines to substitute is a miss the check already had. The deployment scan
substitutes regardless, because declining there would lose deployments it finds
today.

Two corrections were withdrawn rather than kept. Following the settable recipe
marker was implemented and then removed: read over the whole file it applied a
late declaration retroactively and dropped an *earlier* recipe entirely, turning
a stated miss into a silent one. Doing it properly means tracking that state per
line, which is the chase this model stopped. That shape is recorded separately,
along with a test that asserts the miss so a future fix announces itself.

## Two approaches withdrawn, and what they cost

### Collecting the executable parts

The first version built the file's executable text by *collecting* the parts it
believed could run — code blocks, workflow steps, build recipes — and asked the
question of that. Review found six separate routes by which executable text
reached the file without reaching that collection, five of them introduced by
this change and the sixth a gap that predated it. A seventh was found without
review and could not be proven reachable at all. Two attempts to enumerate all
such routes were both incomplete, the second failing on the very next review
round.

The decisive one was a command written inline in a sentence. A document's prose
is not simply narrative: a sentence telling an operator to run a command, with
that command written inline, is an instruction the checker already treats as
actionable. So "prose is not executable" was not merely an incomplete rule, it
was the wrong rule — and any approach built on selecting executable parts
inherits the problem that a part it fails to select becomes silence rather than
noise.

### Blanking a document's prose

The replacement transformed instead of selecting, which removes that risk for
the build file — a transformation cannot omit anything, because it removes
nothing. But it also blanked a document's prose, and blanking is not a
transformation of that kind: it removes text, so a construct it fails to
recognise is a write that disappears.

That was claimed to be safe three times, and was not:

- A per-line matcher missed a command whose delimiters sat on different lines.
- A hand-written pass at the format's grammar got three more rules wrong in one
  round: a closing delimiter carrying trailing text does not close the block, an
  unmatched delimiter must not prevent a later valid one from being recognised,
  and an indented block may be indented with a tab.
- Stating the rule as what it would KEEP — rather than what it could identify —
  still erased a **standalone command on an unindented line**, and still closed
  a block early on a closing delimiter of mixed characters.

Six erased commands across three review rounds, every one a silent pass.

The third failure is the one that ended the attempt, because it shows the rule
cannot be repaired by more grammar. This check treats a bare, unindented line in
a document as an actionable command — that is deliberate, and it is why a
runbook's copy command is reported at all. A prose sentence naming a write has
exactly that shape. Separating them means deciding whether a line is a command,
which is the judgement whose answer produced the false report in the first
place. Any subtraction fine enough to fix the report is fine enough to
reintroduce the silence.

So a document keeps its text exactly as written, and the false report it causes
is recorded as its own work rather than half-fixed here. Two tests pin that no
subtraction happens, in the two shapes that defeated the two withdrawn designs,
so a future attempt cannot quietly reintroduce the erasure.

## What is deferred, and why

- The **false report on a runbook sentence** naming a write. Unchanged from
  before this work; the analysis above, the options considered, and the tests
  that constrain any fix are recorded with it.
- A **folded workflow scalar** has its line breaks removed before the shell
  receives it, so a deployment's position measured in the folded text is not
  comparable with a write's position measured in the file. Correcting it means
  carrying a map from folded positions back to original ones, composed with the
  existing map for line continuations — exactly the machinery that produced the
  withdrawn approaches' failures.
- A **write assigned by a conditional branch that is genuinely live** is not
  seen, for the reason above. Unchanged from before this work.
- A **recipe marked by something other than a tab**, or continuing onto an
  unindented line, is not read as a recipe. Also unchanged, and now pinned by a
  test that asserts the miss.
- A **build file's prerequisites** are ordered as they are written rather than
  as they run.
- A **step naming another interpreter** still has its body read as shell, so
  inert text in that language can be mistaken for a command.
- A deployment written as a **single-line workflow step** whose selected
  configuration cannot be read is not reported at all.

All are unchanged from before this work, so nothing is made worse.
