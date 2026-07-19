// Cron tick routing (Codex #1357 r1, reworked post-merge) — free-plan
// DO rows_written diet, WITHOUT degrading the legacy rollback path and
// WITHOUT a second cron trigger.
//
// The first cut registered TWO schedules (every-minute for the legacy
// fallback, every-5-minutes for the DO path) and routed by which one
// fired. That deploy failed in production: the free plan caps cron
// triggers at FIVE per ACCOUNT, and this account's five Workers already
// use all five slots — a sixth schedule cannot exist. Same routing,
// different discriminator: ONE every-minute schedule, and the tick's
// SCHEDULED TIME decides who acts.
//
//   - Legacy inline ingest (DO path disabled — incident rollback): acts
//     on EVERY tick. It round-robins one chain per invocation (the
//     50-subrequest budget forbids all-chains-inline), so rollback
//     freshness stays `N × 1min`.
//   - DO ingest path: acts only when the scheduled minute is divisible
//     by 5 (:00, :05, …) — behaviourally identical to an every-5-minutes
//     schedule. A skipped minute-tick returns before any work: one
//     Worker request (a separate, ~60x larger free budget), zero DO
//     writes, zero RPC.
//
// Fail-open: an unparseable/absent scheduled time runs the tick in both
// modes — a doubled tick is idempotent and merely wasteful; a
// never-running tick is an outage. EXPECTED_SCAN_CADENCE_SEC
// (chainIngestDO.ts) MUST match the DO path's effective 5-minute
// cadence — clients size rail-health windows from the reported value.

/** Effective DO-path cadence in minutes — the modulo the router applies
 *  and the source of EXPECTED_SCAN_CADENCE_SEC's 300s. */
export const DO_PATH_CADENCE_MINUTES = 5;

/** Should this cron invocation do the tick's work?
 *  `scheduledTimeMs` is `controller.scheduledTime` — the tick's
 *  SCHEDULED epoch (not the actual run time), so the modulo is exact
 *  even when the runtime fires a few seconds late. */
export function shouldRunCronTick(
  scheduledTimeMs: number | undefined,
  doPathEnabled: boolean,
): boolean {
  if (!doPathEnabled) return true; // legacy: every minute
  if (typeof scheduledTimeMs !== 'number' || !Number.isFinite(scheduledTimeMs)) {
    return true; // fail-open — see header
  }
  return (
    new Date(scheduledTimeMs).getUTCMinutes() % DO_PATH_CADENCE_MINUTES === 0
  );
}
