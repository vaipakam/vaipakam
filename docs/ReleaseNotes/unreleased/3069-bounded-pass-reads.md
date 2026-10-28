## Keeper — the default and periodic-settlement passes stop reading in time (PR #<n>)

The keeper's rule is that every read a pass makes stops at the run's read
cutoff, which leaves the sends their time. The grace-default pass, the
periodic-interest settler and the liquidator's in-kind close-out did not
follow it. A slow node or a slow quote API could hold one of them past its
deadline, so later chains in the same run, and the sends already planned,
lost their time.

Each attempt now reads first and sends second. Its checks, from the loan and
the forced-sale plan to the route quotes and the final preview, have to
finish by the read cutoff. If they do not, the attempt sends nothing, is
reported as skipped because the reads ran past the cutoff, and is tried again
on a later run. An attempt given up at the cutoff also starts no further
request of any kind, RPC or quote, even if a late answer lets its checks go
on. The send itself keeps its own deadline rule and is never cut off once it
starts.

The active-loan window that four passes scan now has its own cutoff ahead of
the reads that follow it. That covers grace default, periodic settlement,
prepay auto-listing and the prepay-sale sanctions sync. The default and
settlement scans now keep every chunk of eligibility answers that came back
in time and report only the rest as unread. Before, a hung chunk lost the
whole window.

One latent fault is fixed along the way. A cutoff meaning "no deadline" was
handed to a timer that cannot count that far, so it would have fired at
once. Such a cutoff now never cuts.

Closes #3069. Advances #2984.
