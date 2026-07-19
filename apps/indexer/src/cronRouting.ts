// Dual-cron tick routing (Codex #1357 r1) — free-plan DO rows_written
// diet, WITHOUT degrading the legacy rollback path.
//
// The Worker registers TWO cron schedules (wrangler.jsonc):
//
//   - "* * * * *"  (every minute)   — drives the LEGACY inline ingest,
//     which round-robins ONE chain per invocation (the 50-subrequest
//     budget forbids all-chains-inline). If the DO path is disabled for
//     an incident rollback (`CHAIN_INGEST_VIA_DO` off / binding gone),
//     per-chain freshness must stay `N × 1min`, not `N × 5min`.
//   - "*/5 * * * *" (every 5 min)   — drives the DO ingest path, where
//     the cron is only the time-driven backstop (webhooks trigger
//     immediate scans) and each ping costs DO storage rows.
//
// `scheduled()` routes each tick by the fired cron expression: exactly
// one schedule acts per mode, the other returns before doing any work
// (a skipped minute-tick invocation costs one Worker request and zero
// DO writes). An UNRECOGNISED cron string — a renamed schedule, or the
// empty string `wrangler dev --test-scheduled` sends — runs in both
// modes (fail-open: a doubled tick is idempotent and merely wasteful;
// a never-running tick is an outage).
//
// (Line comments on purpose: the 5-minute cron pattern contains the
// star-slash sequence that terminates a block comment.)

/** The schedule that drives the DO ingest path (must match wrangler.jsonc). */
export const DO_PATH_CRON = '*/5 * * * *';
/** The schedule that drives the legacy inline fallback. */
export const LEGACY_CRON = '* * * * *';

/** Should this cron invocation do the tick's work? */
export function shouldRunCronTick(
  cron: string | undefined,
  doPathEnabled: boolean,
): boolean {
  if (doPathEnabled) return cron !== LEGACY_CRON;
  return cron !== DO_PATH_CRON;
}
