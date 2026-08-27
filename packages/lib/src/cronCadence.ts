/**
 * "Is this cron tick due?" — the one answer, for every Worker.
 *
 * ── Why this is a shared primitive ───────────────────────────────────
 *
 * Cloudflare's free plan caps cron triggers at FIVE per ACCOUNT, and
 * this account has no headroom to spend on a second one. A Worker that
 * wants two cadences therefore cannot register two schedules; it
 * registers ONE every-minute schedule and decides per tick who acts.
 * (How many triggers are actually spoken for is stated once, with the
 * date it was last checked against the account, in
 * `docs/ops/CloudflareCronSlots.md` — not here. #1977.)
 * `apps/indexer/src/cronRouting.ts` learned that from a failed
 * production deploy, and `apps/keeper` needs the same discriminator to
 * stagger its ten passes (#1896).
 *
 * That made two copies of one question. This is the question, once.
 *
 * ── The scheduled time, not the current time ─────────────────────────
 *
 * The input is `controller.scheduledTime` — the epoch the tick was
 * SCHEDULED for, not when it actually ran. The runtime can fire a few
 * seconds late, and `Date.now()` would then read the following minute
 * on a tick scheduled for `:04:59.8`, so a `% 5` cadence would skip
 * `:05` and run `:06`. Reading the scheduled epoch makes the modulo
 * exact regardless of delivery jitter.
 *
 * ── Fail-open ────────────────────────────────────────────────────────
 *
 * An absent or unparseable scheduled time RUNS the tick. The reasoning
 * is the indexer's and transfers unchanged: a doubled tick is
 * idempotent and merely wasteful, while a never-running tick is an
 * outage. A cadence gate exists to save CPU, and saving CPU is never
 * worth a silent stall.
 */

/** Cadence values the callers use, in minutes. `1` means every tick. */
export const EVERY_TICK_MINUTES = 1;

/**
 * Should a pass with this cadence act on this tick?
 *
 * @param scheduledTimeMs `controller.scheduledTime`, or `undefined`.
 * @param cadenceMinutes  Act when the scheduled UTC minute is divisible
 *   by this. `1` acts on every tick. Values that do not divide 60 are
 *   accepted but drift across the hour boundary — prefer a divisor.
 * @param offsetMinutes   Which minute WITHIN each cadence window to act
 *   on. Defaults to 0.
 *
 * The offset is not a nicety, it is the reason a stagger works at all.
 * A Worker's CPU limit is **per invocation**, so what has to come down
 * is the PEAK tick, not the daily total — and plain modulo cadences all
 * coincide at minute 0. Giving ten passes cadences of 1/5/15/30 without
 * offsets leaves minute 0 firing nine of them, exactly as before, while
 * the daily total falls by 63% and the graph looks like progress.
 * Distinct offsets interleave the windows so no two staggered passes
 * share a minute.
 */
export function isTickDue(
  scheduledTimeMs: number | undefined,
  cadenceMinutes: number,
  offsetMinutes = 0,
): boolean {
  // A cadence of 1 acts always, and short-circuits before the time is
  // even consulted — so the commonest case cannot be affected by a
  // clock problem at all.
  if (!Number.isFinite(cadenceMinutes) || cadenceMinutes <= 1) return true;
  if (typeof scheduledTimeMs !== 'number' || !Number.isFinite(scheduledTimeMs)) {
    return true; // fail-open — see header
  }
  const cadence = Math.floor(cadenceMinutes);
  const offset = Number.isFinite(offsetMinutes) ? Math.floor(offsetMinutes) : 0;
  // `+ cadence` before the modulo so a negative offset cannot produce a
  // negative residue, which would never equal 0 and would silence the
  // pass permanently.
  return (
    (new Date(scheduledTimeMs).getUTCMinutes() - offset + cadence * 2) % cadence === 0
  );
}

/**
 * Should a pass act, given it only does anything inside a daily window?
 *
 * Separate from `isTickDue` because the shape of the question differs:
 * a cadence asks "how often", this asks "when". `dailyOracleSnapshot`
 * acts once per UTC day and self-checks internally, so ~99% of its
 * every-minute invocations are pure overhead reaching their own guard.
 *
 * Fail-open for the same reason as above: without a readable scheduled
 * time this cannot tell whether the window is open, and a missed daily
 * snapshot is worse than a wasted invocation.
 */
export function isWithinUtcMinuteWindow(
  scheduledTimeMs: number | undefined,
  startHourUtc: number,
  windowMinutes: number,
): boolean {
  if (typeof scheduledTimeMs !== 'number' || !Number.isFinite(scheduledTimeMs)) {
    return true; // fail-open — see header
  }
  const d = new Date(scheduledTimeMs);
  const minutesIntoDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const windowStart = startHourUtc * 60;
  return (
    minutesIntoDay >= windowStart && minutesIntoDay < windowStart + windowMinutes
  );
}
