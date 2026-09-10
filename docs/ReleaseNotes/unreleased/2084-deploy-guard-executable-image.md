# Deploy guard: two fixes to how build files are scanned, and three withdrawals

The deploy guard refuses to trust a configuration's checked-in contents when the
file deploying it rewrites that configuration first. This work set out to fix
three ways that question was reading text which does not correspond to what
runs. **None of those three is fixed here.** All three attempts were withdrawn
under review, and the reasons are worth more than the attempts were.

What does ship is smaller and unrelated to that question: two corrections to how
build files are scanned **for deployments**.

## What ships

- **An escaped currency symbol is not a variable reference.** The build tool
  reduces the doubled form to a literal and expands nothing, so a recipe echoing
  it runs nothing — but a matcher looking only for the single form found one
  starting at the second character, substituted, and reported a deployment the
  file never runs. A false report the check has had all along.
- **The tool's canonical GNU-prefixed default filename** was missing from the
  list of files treated as build files, so a deployment written through a
  variable in such a file was not found at all.

The variable model behind both existed in two copies — one for finding
deployments, one for finding writes — so a correction had to be made twice or
the halves would disagree. There is now one.

## What was withdrawn, and why

Three transformations of the text were tried. Each asked a question about the
file that needs a parser for something else, and this check is a scanner.

**A collected "executable image"** — the parts of the file believed to run.
Review found six routes by which executable text reached the file without
reaching the collection, each a silent pass, and two attempts to enumerate all
the routes were both incomplete. A selection turns whatever it fails to
recognise into silence. The decisive case was a command written inline in a
sentence, which the check already treats as an instruction — so the boundary the
design rested on did not exist.

**Blanking a document's prose**, so a sentence naming a write would stop
reporting the deployment below it. Six commands erased across three rounds. The
rule cannot exist: this check treats a bare, unindented line in a document as an
actionable command — which is why a runbook's copy command is reported at all —
and a prose sentence naming a write has exactly that shape. Separating them is
the judgement whose answer produced the unwanted report in the first place.

**Expanding a build file's recipe variables**, so a variable holding a
redirection would be seen as the write it is. This one is not unsafe in
principle: expansion only *adds* text, so being wrong costs a report rather than
silence. But being *right* about it means implementing the build tool's
variable semantics, and four review rounds produced fifteen findings —
conditionals in both directions, explicit removal, removal inside a dead branch,
a settable recipe marker, that marker moving partway down the file, stored
variable bodies, indented assignments, mismatched delimiters, a default-value
assignment after a computed one. Every round's findings were edges of the
previous round's fix.

Two intermediate positions were tried and are also recorded rather than buried:
preferring the always-in-effect value (which conceals a live branch's write),
and then treating any name the file does not answer unanimously as unknown
(which survived a round, then met the syntax layer instead of the semantic one).

## What is deferred

All three original symptoms remain open, each with its reproduction, the
attempts, and what a fix would have to be true of:

- A **build file variable holding a write** is not seen as a write.
- A **runbook sentence naming a write** reports the deployment below it.
- A **folded workflow scalar** has its line breaks removed before the shell
  receives it, so positions measured in the folded text are not comparable with
  positions measured in the file.

Alongside them: a build file's prerequisites are ordered as written rather than
as they run; a step naming another interpreter has its body read as shell; a
deployment written as a single-line workflow step whose configuration cannot be
read is not reported; and a recipe marked by something other than a tab is not
read as a recipe.

Every one of these is behaviour the check already had before this work, so
nothing is made worse. Three are pinned by tests that **assert the miss**, so
that a later fix announces itself rather than passing unnoticed.

The common thread is recorded at the call site: where the check would need to
model another system's execution to answer correctly, the answer is a
declaration from the deployment itself rather than a better approximation.
