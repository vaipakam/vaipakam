## Thread — The notification service does deploy itself on merge, and two places said it did not (PR #2238)

Operational documentation and a comment in the service's own source both stated
that the notification service is **not** deployed automatically when a change
merges, and that an operator therefore has to deploy it by hand in the same
sitting. Both are now corrected: it is deployed automatically, along with the
two services already described that way.

The claim was true when it was written, and it stated its own test — *does a
build check appear on a recent merge?* — which is what makes it checkable now.
It does: the build runs on the merge commits that touch this service, and the
live deployment was created seconds before that build check finished — the
deployment happens during the build, which is what produces it. The test is
kept and the answer refreshed, rather than the test being removed.

**Believing the old wording was worse than the problem it warned about.** It
told a reader that a merged change to that service is not live when it is, and
nobody goes looking for the effects of a change they think never shipped. The
source comment carried the same claim into the file it most affects — the
sweep that clears expired account-linking codes, which had been moved to this
service precisely so it would keep running when another service stopped.

Two things the correction does **not** sweep away:

- **The nightly backup worker still is not deployed automatically**, and the
  step still says so, with the same evidence checked the same way.
- **The configuration hazard the old comment described is real and matters
  more now, not less.** Two operator-tuned settings live only in the
  deployment dashboard, and a deploy that does not know about them removes
  them. An automatic deploy passes no flags at all, so the protection cannot
  be something a person remembers to type — it is declared in the service's
  own configuration file, which every deploy route reads. The comment now says
  that, instead of naming a command an automatic deploy never runs.

The step in the runbook also warned that, during the gap before a hand-run
deploy, this service would read and write the *old* database while its
neighbours used the new one — so a setting changed or a support request filed
in that window would land in a database about to be deleted.

**A first version of this change said that gap no longer opens; a second said
it is now a short, measured one. Both were wrong, and review caught each in
turn.** What is true is smaller and more useful: each service reaches a new
database binding through its own independent build, so from the merge until
every binding has been *checked*, the set is in a mixed state — with no
guarantee about which services have switched, in what order, or for how long,
and no guarantee that a given one switched at all, because a build can fail
and leave that service on the old binding until a person repairs it.

The second version's "short window" came from comparing two build-completion
timestamps. That comparison does not measure what it was used for: a
deployment is created *during* its build, not at the end, and the other
service's activation time was never collected. The document now says the
duration is not derivable rather than printing a number that was not measured
where it matters.

So the guidance is one rule covering both directions, rather than a caveat per
path: **before any binding change is merged — the cutover or its undo — close
the routes through which users write, and reopen them only once every
service's binding has been confirmed on the database it is meant to be on.**
That also corrects two narrower errors the old framing produced: it named only
one of the two services that accept user writes, and it pointed an undo at the
same checks as the rollout, which would have passed a service still stuck on
the database being abandoned.

What the automatic deployment genuinely changes is *who* closes the window — it
no longer waits on somebody remembering a command. It does not make the window
zero, bounded, or safe to leave unguarded.

Trying to state that protection precisely enough to be tested against is where
this change stopped. Each review round found another way a service reaches the
database that the previous wording had not covered — a second service's public
routes, then diagnostic routes, then work scheduled on a timer, then a
self-rearming background alarm, then work already in flight when the closure
went up, then addresses that bypass it, then the fifteen minutes a schedule
change takes to take effect.

**Listing the ways code can reach a database is not a finishable task**, and a
list that reads authoritative while being incomplete is worse than none: an
operator follows it, believes the writers are stopped, and loses exactly the
records the step exists to protect. So the document now states the hazard and
says plainly that the procedure is unspecified, with the requirements and the
decisions it needs recorded separately. One of those decisions is whether the
closure should work by removing the database from the service entirely rather
than by naming its entry points — the only formulation that does not depend on
having listed them all correctly.

What did get settled: the checks that prove a binding moved cannot all run
while writes are closed, since two of them work by writing. Confirmation is in
two passes — read each service's binding directly, which is what authorises
restoring traffic, then run the write checks afterwards.

None of these mechanics has been exercised on the live account; they are
reasoned from how the deployments work, and the document says so.

One service writes nothing at all today because its schedule is empty. That is
recorded as a fact about today rather than a property of the service: restore
the schedule and it writes user-visible alerts that a later re-check cannot
reconstruct, because the condition they describe may have passed.

Closes #2237.
