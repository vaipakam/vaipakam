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
in both, or the two halves of the check would answer in different models. Every
correction below is exactly such a correction, and that is why the duplication
had to go first. One of them turns out to fix a long-standing false report on
the deployment-finding side as a side effect. Another — deciding which lines are
recipes at all — showed the same split a second time: fixing it on one side only
would have left the two halves disagreeing about what a recipe even is, which is
the same defect wearing different clothes.

Several ways the expansion did not match the build tool, every one confirmed by
running the tool rather than argued from its manual:

- **An escaped currency symbol is not a variable reference.** The build tool
  reduces the doubled form to a literal character and expands nothing, so a
  recipe echoing it is inert text. A matcher looking only for the single form
  found one starting at the second character and substituted, inventing a
  rewrite in a recipe that performs none.
- **A name that has been explicitly removed is no longer defined.** The
  collector recognised only assignments, so a variable removed later in the file
  kept its obsolete value and expanded into a recipe the build tool runs with
  nothing there.
- **The recipe marker is settable, and a recipe can continue onto an unindented
  line.** Deciding recipe membership by testing each physical line for a tab
  missed both, leaving variables unexpanded exactly where the tool expands them.
  The marker is also removed before expansion, replaced by a space so every
  position in the file still means what it meant: left in place, a marker
  character that the shell reads as a redirection concealed the real redirection
  later on the same line.
- **The build tool's canonical GNU-prefixed default filename** was missing from
  the list of files treated as build files at all.
- **An assignment inside a conditional may or may not be in effect.** Whether a
  conditional fires depends on the environment and on command-line overrides,
  which this check cannot evaluate.

The last one is the only one without a clean answer, and review found both of
its horns: taking a dead branch's value invented a rewrite, and then preferring
the always-in-effect value concealed a live branch's rewrite. They are textually
identical apart from the condition, so no rule that picks a value without
evaluating gets both right.

So the value is not picked. A name assigned under any conditional is marked
**uncertain**, and the two consumers apply their own answer to that — which is
possible only because they now share one model instead of holding two copies of
it. The rewrite question declines to substitute an uncertain name, so it invents
nothing and the rewrite it then misses is the one the check missed before this
work anyway. The deployment scanner substitutes regardless, because it already
expanded before this change and declining there would lose deployments it finds
today. One model, two stated policies, each matched to what that side would
otherwise lose. The remaining miss is recorded as its own work.

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
- A **build file's prerequisites** are ordered as they are written rather than
  as they run.
- A **step naming another interpreter** still has its body read as shell, so
  inert text in that language can be mistaken for a command.
- A deployment written as a **single-line workflow step** whose selected
  configuration cannot be read is not reported at all.

All are unchanged from before this work, so nothing is made worse.
