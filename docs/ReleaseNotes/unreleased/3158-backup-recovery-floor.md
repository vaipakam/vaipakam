## Backup retention: one recovery floor, derived against the daily watcher (#3158)

The minimum time a superseded backup stays recoverable after it is hidden was
worked out against the old weekly health check, which only fully inspected the
newest month. That left the monthly tier on a stricter floor of 31 days while
the daily tier sat at 8.

The daily backup watcher now lists every stored version of every tier, so an
overwrite of any retained month is caught on its next run. Both tiers now share
one floor of 8 days: up to three days to notice (one missed run plus the
scheduler's delay), four for someone to save the old copy, and one spare. The
bucket's actual retention rules are unchanged; the monthly tier still keeps 31
days, now above the floor instead of at it.
