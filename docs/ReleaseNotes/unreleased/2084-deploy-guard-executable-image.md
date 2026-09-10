# Deploy guard: the rewrite question reads a transformed file, not a selected one

The deploy guard refuses to trust a configuration's checked-in contents when
the file deploying it rewrites that configuration first. Deciding whether a
rewrite happens means reading the file — and in two cases it was reading
something that does not correspond to what runs.

In a build file, recipe variables are expanded before the shell ever sees them,
so a variable holding a redirection really is a write. The check read the
unexpanded file, where that write is only a name, and found nothing: the
configuration was rewritten and its checked-in preservation setting trusted
anyway. In a document, the opposite: prose was read as though it were commands,
so a runbook sentence *describing* a write counted as performing one and the
deployment below it was reported. That is a false report in a check that runs
inside routine validation, so it blocks correct work.

Both are now fixed by transforming the text the question is asked of, and
leaving everything else exactly where it was. A build file's recipes are
expanded in place. A document's prose is blanked to spaces of the same length,
so every position in the file is unchanged and no translation between
coordinate systems is needed.

## What was tried first, and why it was withdrawn

The first version of this change did something more ambitious and worse: it
built the file's executable text by *collecting* the parts it believed could
run — code blocks, workflow steps, build recipes — and asked the question of
that. Review found five separate routes by which executable text reached the
file without reaching that collection, each one a case where a rewritten
configuration would be trusted. Two attempts to enumerate all such routes were
both incomplete, the second failing on the very next review round.

The decisive one was inline command spans. A document's prose is not simply
narrative: a sentence telling an operator to run a command, with that command
written inline, is an instruction the checker already treats as actionable. So
"prose is not executable" was not merely an incomplete rule, it was the wrong
rule — and any approach built on selecting executable parts inherits the
problem that a part it fails to select becomes silence rather than noise.

Transforming instead of selecting removes most of that risk: a transformation
cannot omit anything, because it removes nothing. Expansion is such a
transformation.

Blanking is not, and an earlier version of this note claimed otherwise — that a
construct the blanking fails to recognise is simply left in place, costing at
most a report. That is wrong, and review found the case that proves it: a
command written inline whose delimiters sit on different lines was not
recognised as one, so it was blanked and the write inside it disappeared. An
unrecognised code construct is a silent pass, not a noisy one. The claim is
corrected here rather than removed, because it was the stated reason for
choosing this design and a reader deserves to know it was too strong.

That correction was not the end of it. The next claim — that a document's code
constructs are a closed set small enough to state completely, so recognising
them was safe — was also too strong. Recognising them means implementing the
format's grammar, and the next review round found three more rules got wrong in
one pass: a closing delimiter carrying trailing text does not close the block,
an unmatched delimiter must not prevent a later valid one from being
recognised, and an indented block may be indented with a tab. Each correction
was right and each revealed the next.

So recognition was abandoned. The rule is now stated as what it will KEEP, not
as what it can identify: a line is blanked only if no block is open, it
contains no inline delimiter anywhere, and it does not begin with whitespace.
Every test errs toward keeping the line. Getting one wrong now leaves text in
that the previous checker also read — costing at most the report it already
made — where getting one wrong before removed a real command.

The cost is honest and worth stating: prose that happens to contain an inline
delimiter, or that is indented, is no longer blanked, so the false report this
fixes is fixed for the plain case and not for those. That is the right
direction for a subtraction in a checker whose whole purpose is to notice
writes, and it needs no parser.

## What is deferred, and why

A third case is recorded as separate work rather than fixed here: a folded
workflow scalar has its line breaks removed before the shell receives it, so a
deployment's position measured in the folded text is not comparable with a
write's position measured in the file. Correcting it means carrying a map from
folded positions back to original ones, composed with the existing map for line
continuations. That machinery is exactly the kind that produced the withdrawn
approach's failures, and it deserves its own change and its own review rather
than riding along here. The behaviour is unchanged from before this work, so
nothing is made worse.

Two further limitations found while proving this one are likewise unchanged and
recorded separately: a build file's prerequisites are ordered as they are
written rather than as they run, and a step naming another interpreter still
has its body read as shell, so inert text in that language can be mistaken for
a command. A deployment written as a single-line workflow step whose selected
configuration cannot be read is also still not reported.
