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

Two further corrections came out of stating the rule plainly enough to be
tested against. **Closing the routes has to be done in a way the deployment
cannot undo** — the two obvious mechanisms are both erased by the very deploy
they are meant to bracket, because one service declares its own route in the
file that gets deployed, and a deploy replaces a rejecting build with the
normal one. And **the checks that prove a binding moved cannot all run while
the routes are closed**, since two of them work by writing through those very
routes. Confirmation is now in two passes: read each service's binding
directly while the gate holds — that is what authorises lifting it — then run
the write checks afterwards as the final confirmation.

One service is currently outside the gate because its schedule is empty and it
therefore writes nothing at all. That is recorded as a fact about today rather
than a property of the service: restore the schedule and it writes
user-visible alerts that a later re-check cannot reconstruct, because the
condition they describe may have passed.

Closes #2237.
