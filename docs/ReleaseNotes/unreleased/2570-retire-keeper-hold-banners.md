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
Worker log, a setting change is an edit to the machine's env file followed by
a service restart, and the keeper machine runbook is the one place that says
how to start, stop and arm the keeper.

The cron-slot inventory no longer holds a trigger in reserve for the keeper
Worker, because that Worker will not be scheduled again; the summary there now
reads four live and one spare, with the account stamp unchanged because no
live read was taken. The Telegram and Push key rotations now also update the
keeper's machine, which never read those credentials from the shared store.

One gap in the code is now stated in the runbooks rather than hidden: the
keeper's per-chain flag that turns on the flash-loan liquidation branch is not
passed through to the pass that reads it, so that branch cannot fire on either
host whatever the flag says. This fails safe, but it means the flag-based
snap-off is currently a no-op. The fix belongs in the keeper code and is
tracked in #2633. Closes #2570.
