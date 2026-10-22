## Thread — Retire the keeper "unscheduled" hold banners from the runbooks (PR #2634)

Several operator runbooks still carried the old warning that the keeper was
unscheduled, that "there is no next tick", and that it could be re-enabled only
through the Worker re-enable sequence. None of that has been true since the
keeper moved to its always-on machine and its Worker stopped running passes.
The banners are removed from the flash-loan liquidator rollout, the incident,
governance and deployment runbooks, the cron-slot inventory and the staging
plans. The checks they carried are kept and restated for the machine: the
five-point liquidation stand-down in the incident runbook's discount-path
section, the reward remittance coverage rule (all destinations covered at the
source, which still does not prove the mirrors were funded) together with its
reconcile-every-day rule, and the governance ceremony's handling of the master
and reward flags. Evidence now comes from the machine's journal instead of the
Worker log, a setting change is an edit to the machine's env file applied by one
procedure in the keeper machine runbook, and that runbook is the one place
that says how to start, stop and arm the keeper. That procedure restarts the
keeper only if it is already running, so a keeper someone stopped during an
incident stays stopped. It confirms the change from a tick that began after
the restart, because the lease line the runbooks used to cite is printed only
when the lease changes hands.

The flash-loan rollout no longer tells operators to set the keeper's
discount-path flag while the keeper ignores it. A line set early would switch
the branch on by itself at the restart after the fix lands, with nobody
watching. The staging plan's smoke-test and arming steps no longer stop or
restart the one keeper machine, which also serves the live testnets. The
watcher smoke test now raises a threshold above a loan's health factor, the
direction that sends an alert.

The cron-slot inventory no longer holds a trigger in reserve for the keeper
Worker, because that Worker will not be scheduled again. The inventory itself
(docs/ops/CloudflareCronSlots.md) is the one place that states the account's
occupancy, and its account stamp is unchanged because no live read was taken. The Telegram and Push key rotations now also update the
keeper's machine, which never read those credentials from the shared store.

One gap in the code is now stated in the runbooks rather than hidden: the
keeper's per-chain flag that turns on the flash-loan liquidation branch is not
passed through to the pass that reads it, so that branch cannot fire on either
host whatever the flag says. This fails safe, but it means the flag-based
snap-off is currently a no-op. The fix belongs in the keeper code and is
tracked in #2633. Closes #2570.
