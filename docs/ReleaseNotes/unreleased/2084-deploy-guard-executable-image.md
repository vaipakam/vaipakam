# Deploy guard: the rewrite question is asked of what the file actually runs

The deploy guard refuses to trust a configuration's checked-in contents when
the file deploying it rewrites that configuration first. Deciding whether a
rewrite happens meant reading the file — and inside a container (a Markdown
runbook, a workflow, a Makefile) the guard was reading the wrong thing. It took
the container's raw text, applied the language of the embedded block it had
found the deployment in, and compared positions measured in two different
coordinate systems. Those are three separate mistakes with one cause, and each
produced a failure of its own.

The first was too much text. Prose surrounding a fenced example was read as
shell, so a runbook sentence describing a write — naming the configuration and
the operation in an ordinary English sentence — counted as performing one. The
deployment below it was then reported. That is a false report in a check that
runs inside routine validation, so it blocks correct work; of the three, it is
the one a contributor would have hit.

The second was too little text. A Make recipe is expanded before its commands
are read, so a variable standing for a redirection becomes a real write. The
rewrite scan was handed the unexpanded file, where that write is only a
variable name, and so found nothing. The configuration was rewritten and its
checked-in preservation setting trusted anyway — the exact hazard this guard
exists to prevent, passed silently.

The third was wrong coordinates. A folded workflow scalar has its line breaks
removed before the shell receives it. A deployment's position was measured in
the folded text and then compared against positions measured in the raw file,
so with enough lines above it the deployment appeared to come *before* a write
that physically precedes it, and the write was discarded as irrelevant. Another
silent pass. The same arithmetic could also fail the other way, reporting a
write that genuinely runs after the deployment.

The fix is not a translation table between those coordinate systems. It is to
stop needing one. The rewrite question never reports a position — it only asks
whether a write comes before a deployment — so it needs one coherent space, not
the file's. The guard now builds that space explicitly: the file's executable
text, in file order, as the shell will actually receive it, with expansions
performed and folding applied. Prose and structure are not in it because they
never execute. Positions inside it are directly comparable because they all
come from it.

Two consequences are worth stating because they were the reasons an earlier,
simpler fix was rejected. Ordering survives across steps: a write in a
workflow's first step still counts against a deployment in its third, which
scoping the question to a single block would have lost. And the language now
matches the text — the executable image is shell, and is read as shell, rather
than inheriting whatever the line that led there happened to be written in.
That last point was doing more work than expected: a single-line workflow step
is examined as an ordinary file line, and reading its own language over shell
text was enough to hide a redirection in an earlier step.

Files that are already wholly executable in their own language — a shell
script, a JavaScript wrapper, a Python helper — are unchanged. They were never
the problem: their text is what runs.

A separate gap was found while proving this one and is recorded rather than
folded in: a deployment written as a single-line workflow step, whose selected
configuration cannot be read at all, is not reported. That is independent of
everything above — it reproduces with the configuration simply absent — and
belongs to its own change.

Review of the change found the executable text still incomplete in three ways,
each of which would have let a rewritten configuration pass as trustworthy. A
step written in another language — a Python step that writes the file — was
kept out, because the test that admits a step asks whether reading it as shell
would invent a deployment, which is the right question for finding deployments
and the wrong one for finding writes. A build file that runs each recipe in a
single shell took an earlier path that never consulted the all-recipes mode, so
a prerequisite recipe expanding to a write was absent although it runs first.
And where one step body expands into several variants, all of them keep the
source line they came from, so locating a command by line alone could answer
with the wrong variant. The first was a regression against the previous
behaviour and the second a gap that predates this change; the third is a real
imprecision for which no failing case could be constructed, and the guard
against it says so rather than claiming a fix.

A step that does not run is still excluded. Admitting more executable text must
not admit text that never executes, and a disabled step remains out.

A second review round found one more of the same kind — a step written as a
single inline mapping was the last route by which executable text reached the
file without reaching the image — and the remaining emission points were then
enumerated directly rather than waited for, so the one that had not yet been
reported was closed in the same pass. Two further findings from that round are
recorded as separate work because they are older than this change and reproduce
without it: prerequisites in a build file are ordered as they are written rather
than as they run, and a step naming another interpreter still has its body read
as shell, so inert text in that language can be mistaken for a command.
