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

The fixtures remain the ground truth for any per-defect fact. Where this
document and a fixture disagree, **the fixture is right** — it was written with
the code in hand and it runs.

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

For casing, the verified case is a runner with **case-sensitive** lookup, which
is what the fixtures' `ubuntu-latest` provides. A host resolving
case-insensitively maps both spellings to one program, and there the *missed*
spelling is a genuine unsafe deployment. **Other resolution modes are open, not
decided** — an implementation must establish which applies rather than infer it
from the platform, and a correction keyed on "not Windows" would convert a
false report into a silent pass.

Where the mode cannot be determined — an unresolvable or matrix-selected
runner — the two directions genuinely conflict: reporting risks naming a
command that does not exist, and not reporting risks the silent pass. **That
choice is deliberately not made here.** It needs evidence about how often each
shape occurs, which nobody has gathered.

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
| **#2123** | a helper whose file name carries an upper-case extension is never found by the sweep — *pinned (silent pass)* table-driven across every affected helper family |
| **#2124** | a binding closed with that shell's ordinary statement terminator is not recognised — *pinned (silent pass)* |
| **#2126** | the command-name normalisation is applied on the interpreter alone, without establishing the runner's lookup mode — *pinned (false report)* |
| **#2085** | whether this detection should be a **declaration** rather than an inference — the three withdrawals are the strongest evidence yet that it should |

---

## The conclusion

Each withdrawn design asked a question that only another system's model can
answer, and this check is a scanner. **Where such a model is genuinely needed,
the answer is a declaration from the deployment itself rather than a better
approximation here** — which is #2085, and which the three withdrawals argue
for more strongly than any of them argued for itself.
