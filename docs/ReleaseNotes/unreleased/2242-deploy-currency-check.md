## Thread — How to tell whether a service is actually running the code that was merged (PR #2243)

A cutover step told an operator which services deploy themselves when a change
merges, and which need deploying by hand. It was corrected earlier the same day
because it named one service as manual when it is automatic. Measuring every
service afterwards showed the corrected list was **also** wrong, in the other
direction: another service deploys itself and was left out.

Two errors in one list on one day is a sign the list is the wrong thing to
maintain, so the step now leads with the test rather than the answer — and the
test it used to name turns out not to work.

**Looking for a build to have run misleads in both directions.** A change to a
single file at the top of the repository starts a build for *every* service; a
change confined to the documentation folder starts none. So "a build ran" can
be true of a service the change never touched, and "no build ran" can be true
of one that does deploy itself. The same kind of change behaves differently
again on a branch than on the main line, which removes the last way a reader
might have salvaged the signal. Worse, a **successful build does not mean
anything was deployed**: one service's build reported success four days after
its last deployment, and that deployment is still the one serving.

**The deployment timestamp is the thing worth reading — in one direction
only.** If a service's last deployment is older than the newest change
affecting it, that change is definitely not live, and nothing can make that
reading wrong. The reverse does not hold: a recent-looking deployment proves
nothing, because the comparison can be made against a stale local copy of the
project's history, because a service can be affected by changes outside its own
folder, and because undoing a deployment creates a *new, recent* record that
points at *old* code.

An intermediate version of this change also used staleness to infer that a
service must be hand-deployed. That is wrong in a way worth naming: a service
whose automatic deployment **failed** is also behind, and reading that as "this
one is manual" sends someone to deploy around a broken build instead of fixing
it. Being behind says the code is not live and says nothing about why.

Running that comparison found two services behind: the connected app by four
days, and the nightly backup worker by twenty-eight. Both are hand-deployed by
design, and both had simply not been deployed. Their figures are now recorded
in the step, as the reason to check rather than assume — "somebody will have
deployed it" is not a safe default for either.

One service appears in no deployment list at all, and that is correct: it is
deployed as part of an arming ceremony that has not happened. The step says so,
so it is not mistaken for drift.

Part of #2242.
