# Deploy-guard rewrite scan — design record

**Status:** record of work done and withdrawn. No behaviour change landed.

This is the single home for the reasoning behind the deploy guard's
"is the configuration this deployment loads the one checked in?" question —
what was attempted, what was withdrawn and why, and the catalogue of wrong
verdicts the check currently produces.

It exists because that reasoning was previously carried in **three places at
once**: a call-site comment, a release note, and a single 3,692-word bullet in
`docs/FunctionalSpecs/ProjectDetailsREADME.md`. The copies drifted — a scope
correction would land in one and not the others, and eight consecutive review
rounds were spent finding the copy left behind. In the round that finally named
the cause, a correction had reached the release note and the fixtures but not
the specification, leaving the specification prescribing a remedy that would
have introduced a silent pass.

**So the division of labour is now explicit, and it is the point of this
document:**

| Where | Carries | Does not carry |
| --- | --- | --- |
| `ProjectDetailsREADME.md` | the binding invariants — what the platform is MEANT to do | any history, any defect scope, any reasoning about a withdrawn design |
| This document | the record: designs tried, why each failed, and a defect catalogue that POINTS AT each defect's scope and bounds without restating them | anything binding; nothing here is a requirement; and not the bounds themselves — see below |
| The fixtures | each defect's exact scope, mechanism and mutation evidence | — |
| The release note | what landed in the pull request that produced this | — |

The fixtures remain the ground truth **for the check's verdict**, and where this
document and a fixture disagree about a verdict, the fixture is right — it was
written with the code in hand and it runs.

**They are not ground truth for anything else, and the distinction has already
cost a defect.** The harness writes a file and invokes the scanner; it never
executes the recipe, workflow or helper it wrote. So a fixture establishes
*"the check reports / does not report this text"* and nothing more. Whether the
text would really deploy, whether the shell would parse it, whether the module
system admits it — none of that is tested by the fixture passing, and all of it
appears in fixture comments as though it were.

That is not hypothetical: a helper payload sat in this suite calling `require`
from a file the surrounding manifest made an ES module. The verdict was right
and the premise was impossible — the body would have thrown before deploying
anything, so a pin reading "an unsafe deployment passes silently" described a
deployment that could never run. **Any claim a fixture makes about runtime
behaviour needs its own evidence**, gathered outside the harness and recorded
beside the claim.

**This document therefore does not contain the bounds, and that is deliberate
rather than an omission.** It names each defect and points at where its scope
and bounds are established; restating them here would recreate the copy this
document exists to remove, and a restatement that drifts is worse than a
pointer. A reader who needs a defect's exact extent should read its fixtures
and its issue — in that order, since only the fixtures run.

---

## The question the check asks

A deployment must preserve operator-tuned environment values. The check can
read a Worker's checked-in configuration to decide whether it declares
preservation — but only if that configuration is the one the deployment
actually loads. Where the deploying file rewrites the configuration first, the
checked-in copy is not that file, and the command must be judged on its own
terms instead.

Deciding *"does this file rewrite the configuration?"* is the whole difficulty.

---

## Three designs, all withdrawn

Each asked a question about a file that can only be answered by modelling
**another system** — a continuous-integration system's execution model, a
document format's grammar, a build tool's variable language. The check is a
scanner, not an interpreter for any of them.

### Collecting the file's executable text

Gather the parts believed to run, and ask the rewrite question only of those.

Withdrawn. Review found six routes by which executable text reached the file
without reaching the collection, and two separate attempts to enumerate all the
routes were both incomplete. **A selection turns whatever it fails to recognise
into silence** — the one direction this check must never fail in.

The decisive case: a command written inline in a sentence, which this check
already acts on. So the prose/code boundary the design rested on does not
exist.

### Blanking a document's prose

So that a sentence *naming* a write stops reporting the deployment below it.

Withdrawn after six commands were erased across three rounds. The rule cannot
exist, and the reason is worth stating exactly: this check treats a bare,
unindented line in a document as an actionable command — deliberately, and it
is why a runbook's copy command is reported at all — and **a prose sentence
naming a write has that same shape**. Separating them is the judgement whose
answer produced the unwanted report in the first place.

### Expanding a build file's recipe variables

So that a variable holding a redirection is seen as the write it is.

Withdrawn after fifteen findings over four rounds: conditionals in both
directions, explicit removal, removal inside a dead branch, a settable recipe
marker, that marker moving partway down the file, stored variable bodies,
indented assignments, mismatched delimiters, a default-value assignment after a
computed one. **Every round's findings were edges of the previous round's
fix.** It failed the way the other two did — it had to infer what a name
denotes.

### Two smaller corrections, withdrawn in opposite directions

Both looked obviously safe, and the pair is the useful part: neither is a
template for judging the next one.

- **Treating the build tool's escaped currency symbol as inert.** It is inert
  *to the build tool*, which then hands a single symbol to the shell, which may
  expand it. A deployment written that way really runs, so treating the escape
  as permanently inert hid it — a **silent pass**, introduced by a rule adopted
  precisely because it was "purely lexical".
- **Adding the tool's canonical prefixed default filename** to the set scanned
  as build files. Correct in itself, but it routes those files through a
  variable model already known to be imperfect, extending its **false reports**
  to files that previously escaped them.

**The general lesson: this model's imperfection is load-bearing.** Its one
consumer is calibrated around it, so making it locally more faithful can be a
regression.

---

## The admissibility rule the rounds converged on

A transformation of the text is admissible only where it is a
**semantics-preserving normalisation of a known notation** — a total,
deterministic rewriting of one spelling of a command into another — and never
where it requires inferring **which text is executable** or **what a name
stands for**.

Whether characters are added or removed is *not* the test, and stating it that
way was wrong: the Windows normalisation substitutes separators and folds a
continuation, so it removes and replaces text, yet it stands because it decides
nothing about what runs.

---

## Interpreter is not runner, and runner is not language

Two defects in the catalogue below come from the same wrong instinct —
attributing to the *platform* something that belongs to a narrower thing — and
they pull in **opposite directions**, so a fix for one must not be copied to the
other.

| | depends on | not on |
| --- | --- | --- |
| **Command-name casing** | how the RUNNER resolves command names — case-sensitively or not | the platform family |
| **Variable-name binding** | the SHELL LANGUAGE; PowerShell binds case-insensitively on every platform it runs on | the runner at all |

For casing, the case the fixtures cover is a runner with **case-sensitive**
lookup. **What the fixtures establish is only the check's verdict on that
input** — they name `ubuntu-latest` in their YAML, and the harness scans that
YAML without ever provisioning a runner or resolving an executable. That the
image in question resolves command names case-sensitively is a property of the
runner image rather than anything this suite demonstrates, and it is stated
here as an external fact so it is not mistaken for a tested one. Anyone
depending on it should confirm it against the runner documentation for the
image they actually target.

A host resolving case-insensitively maps both spellings to one program, and
there the *missed* spelling is a genuine unsafe deployment. **Other resolution
modes are open, not decided** — an implementation must establish which applies
rather than infer it from the platform, and a correction keyed on "not Windows"
would convert a false report into a silent pass.

Where the mode cannot be determined — an unresolvable or matrix-selected
runner — the two directions conflict: reporting risks naming a command that
does not exist, and not reporting risks the silent pass.

**That conflict is now RESOLVED, and the specification is where it was
resolved**, so this record no longer describes the choice as open. The answer
is neither of the two bad directions: the check should stop relying on the
normalisation for that deployment and judge the command **on its own terms**,
exactly as it already does for a configuration whose contents cannot be
trusted. The deployment must then be safe whatever it targets. That removes the
dependence on the unknown instead of choosing which way to be wrong, and it is
the same move #2085 argues for generally — a declaration rather than an
inference.

### The path-separator rewrite: what is settled and what is not

Settled: for a path handed to one of that shell's **own** commands, such as the
change of directory, the shell reads either separator the same way on every
platform. Normalising it asserts nothing the shell does not already do, so a
correction aimed *there* would be changing correct behaviour.

**Not settled, and not endorsed:** the same documentation warns the alternate
separator "may not work when used with native applications that only expect the
native directory separator" — and this rewrite also touches path-shaped
arguments handed to the deployment tool itself, which is such an application.
Nothing demonstrates that case in either direction. An implementation should
treat it as an **open question to settle**, never as behaviour that has been
cleared.

---

## Defect catalogue

Each row is a one-line symptom and a pointer. **The precise scope and bounds of
every defect live on its issue and in its fixtures, deliberately not here** —
this table restated them once, the restatements went stale as each was
corrected, and round after round was spent finding a correction that had landed
in one place and not its siblings.

Where a defect is pinned more than once, why and how many times is recorded at
the fixtures. Some carry several pins because the faulty step is shared and a
scoped fix would leave the other pins wrong; others because they are separately
fixable routes into one defect.

| | |
| --- | --- |
| **#2084** | a build file variable holding a write is not seen, when the assignment sits below the deployment — *pinned (miss)* |
| **#2104** | a deployment written as a single-line workflow step whose configuration cannot be read is not reported |
| **#2106** | a build file's prerequisites are ordered as written, not as they run |
| **#2108** | a step naming another interpreter has its body read as shell |
| **#2110** | a folded workflow scalar's positions are not comparable with the file's |
| **#2112** | a runbook sentence naming a write reports the deployment below it — *pinned (false report)* |
| **#2113** | a write assigned by a live conditional branch is not seen |
| **#2114** | a recipe marked by something other than a tab is not read as a recipe — *pinned (miss)* |
| **#2115** | upper-case and most mixed-case spellings of the command are not seen — *pinned (false report)* for the trade the covered spelling makes. Scoped by the runner's LOOKUP mode; see above |
| **#2116** | a manifest script that invokes a sibling does not see that sibling's config write |
| **#2117** | no string state on the PowerShell path, so here-string text is read as commands — *pinned (false report) twice*, once per symptom, since they go through different rewrites |
| **#2118** | a deployment is lent a safety flag by the unrelated line above it — *pinned (silent pass)* across two dialects and two ingestion surfaces, with its bounds pinned too |
| **#2119** | an ordinary single-value property, in any file of the manifest's format, is read as a command — *pinned (false report)*. Whether a list's entries are read depends on the file's LAYOUT, and that bound is pinned |
| **#2121** | a script declared in a package manifest is never split at its newlines — *pinned (silent pass)*; the mirror of #2118 |
| **#2122** | a variable whose name differs only in case is not resolved, though that shell resolves it — *pinned (silent pass)*, with the POSIX side pinned too so a global fix cannot cross the language boundary |
| **#2123** | a file whose name spells its extension in anything but lower case is never found by the sweep that discovers files to read — *pinned*, table-driven across every family the sweep accepts and under two spellings of each, with a parity guard against the production list and a guard against the pair collapsing to one spelling. **Mixed consequence.** For all but one format it is a SILENT PASS: something runs the file whatever it is called — a shell will execute the command lines of almost any text handed to it, which is how two families first classified as harmless turned out not to be. For one format the consequence is NOT ESTABLISHED, because the report that would demonstrate it is itself #2119. A third state, for a family shown to have no consumer at all, is defined and currently **empty** — it is much harder to establish than it looks. Which family is where, and why, is declared at the fixtures |
| **#2124** | a binding closed with that shell's ordinary statement terminator is not recognised — *pinned (silent pass)* |
| **#2126** | the command-name normalisation is applied on the interpreter alone, without establishing the runner's lookup mode — *pinned (false report)* |
| **#2085** | **no longer a "whether".** The specification now REQUIRES a declaration from the deployment wherever answering correctly would need another system's execution model, and the check still infers — so this is an open implementation gap, not an open question. Registered as a divergence in [`_CodeVsDocsAudit.md`](../FunctionalSpecs/_CodeVsDocsAudit.md); the three withdrawals are the evidence that settled it |

---

## The conclusion

Each withdrawn design asked a question that only another system's model can
answer, and this check is a scanner. **Where such a model is genuinely needed,
the answer is a declaration from the deployment itself rather than a better
approximation here** — which is #2085, and which the three withdrawals argue
for more strongly than any of them argued for itself.
