## Thread — The notification service does deploy itself on merge, and two places said it did not (PR #2238)

Operational documentation and a comment in the service's own source both stated
that the notification service is **not** deployed automatically when a change
merges, and that an operator therefore has to deploy it by hand in the same
sitting. Both are now corrected: it is deployed automatically, along with the
two services already described that way.

The claim was true when it was written, and it stated its own test — *does a
build check appear on a recent merge?* — which is what makes it checkable now.
It does: the build runs on the merge commits that touch this service, and the
live deployment's timestamp sits seconds after the check that produced it. The
test is kept and the answer refreshed, rather than the test being removed.

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
in that window would land in a database about to be deleted. That gap does not
open any more. The reasoning is kept, struck through rather than deleted,
because the same choice returns the moment any service that writes on a user's
behalf is deployed out of step with the database it reads.

Closes #2237.
