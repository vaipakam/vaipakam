## Thread — Off-chain backups: declare the first monthly archive (PR #3058)

The backup watcher and the Worker's weekly healthcheck now both know that
September 2026 is the first monthly archive this deployment wrote. Until now
neither had that fact, so each judged the monthly tier only from the archives
it could still see. Judged that way, a deleted oldest monthly simply moves the
baseline forward and is never reported. With the first month declared, every
month from September 2026 onward is required, and a missing one raises an
alert.

The value comes from the bucket's history, not just from what survives in it.
The current bucket was created empty when the backup service was renamed from
"archive" to "warm" in early August 2026. A monthly is cut on the first of the
month, so September was the first month the bucket could hold. It is also the
earliest monthly the watcher's first run found.

The workflow and the Worker each carry the value and must stay equal. The
Worker's copy takes effect the next time it is deployed. The yearly tier stays
unset until the first January cut exists.

Advances #3048.

> Caveat: the Worker is deployed by hand, so its weekly healthcheck keeps reporting the monthly tier as "coverage degraded" until the next deploy.
