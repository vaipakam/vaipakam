### The pre-deploy gate was running a form of the test suite that had been outgrown

Before contracts are deployed to mainnet, a preflight check runs the full test
suite and refuses the deploy if anything is red. The same check is what the
release-track workflow runs when a release branch or version tag is pushed. It is
the last thing standing between a broken build and a live deployment.

That check carried its own copy of the command that runs the suite. There is
also a dedicated script for running the full suite, and the two were written to
match — the preflight even carried a comment saying so.

They stopped matching. The test corpus is large enough to sit against a compiler
limit on how much can be compiled in one go, and the dedicated script was
reworked to run the suite in several smaller pieces so no single piece crosses
that limit. Its own notes record why: the single-pass form it used to use had
been fine for a while, then ordinary growth in the codebase pushed past the limit
again. The preflight's copy was never updated, so it kept running the form the
other script documents as no longer viable.

What made this worse than a slow build is how the failure would have presented.
Crossing that limit is a compilation failure, not a test failure — but the
preflight treats both the same way, so it would have reported that the regression
failed and the deploy should not proceed. The message would have been correct
about the conclusion and completely misleading about the cause, at the exact
moment someone is trying to ship. Nothing would have indicated that no test had
actually run.

The preflight now calls the dedicated script instead of duplicating it. There is
one implementation of the chunking, and it brings with it a guard that fails
loudly if any test file is not covered by one of the pieces — so a newly added
suite cannot be silently skipped by the gate either. The scope is unchanged:
the slow invariant suites are still excluded and still run as their own pass.

A side effect worth recording: the memory figure that made this gate a poor fit
for the hosted CI runners described the single-pass form. Running in pieces
bounds memory by the largest piece rather than the whole corpus, which makes the
fit structurally plausible where it previously was not. Plausible is not
measured, and nobody has measured it on a hosted runner — the pre-cutover
checklist that says to confirm this before the first release push still stands,
and now says what to measure.

The suite-running script also no longer assumes it is allowed to raise its own
I/O priority. That was a safe assumption on an operator's own machine, which was
the only place it ran; now that the release-track workflow reaches it, it checks
first and carries on without the boost where it is not permitted.

This does not change what runs per pull request, which stays the narrow
deploy-sanity and happy-path set, and it does not make the full suite a
per-pull-request gate. It only makes the pre-deploy gate do what it already
claimed to do.
