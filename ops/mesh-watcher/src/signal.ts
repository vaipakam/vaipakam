/**
 * ROOT-CAUSE FIX #3 — one windowed-signal abstraction.
 *
 * Six findings across four rounds were all the same mistake made in a
 * different signal (#1443 r3, r4, r5 twice, r7 twice): a window sized
 * against the wrong cadence; a marker mixing two ledgers; a run carried
 * across a source change; one marker covering three independent fields; a
 * manual observation counted toward a scheduled window; a run CLEARED by
 * an observation that was merely unknown.
 *
 * They recurred because every signal re-derived the rules at its own call
 * site. Here they are stated once, and a new signal gets them by
 * construction:
 *
 * - An observation is `holds`, `clear`, or **`unknown`** — and `unknown`
 *   is NOT `clear`. A missing or untrustworthy read must never erase
 *   accumulated evidence; it pauses the run.
 * - The marker names WHAT MUST STAY STILL. Whatever varies for another
 *   reason belongs outside it, and whatever identifies the observation's
 *   SOURCE belongs inside it — so a cadence change restarts the run
 *   rather than inheriting a count measured on different footing.
 * - A window is denominated in observations of ONE cadence. A signal
 *   whose inputs move only on a slower cycle must be judged on that
 *   cycle's window.
 * - An observation that will not be persisted must not be counted.
 */

export interface StreakState {
  marker: string;
  streak: number;
}

/** What one tick learned about a signal. */
export type Observation =
  | { state: 'holds'; marker: string }
  | { state: 'clear' }
  /** Could not be determined — pauses the run, never clears it. */
  | { state: 'unknown' };

export type StreakTransition =
  /** Persist this state. */
  | { action: 'save'; state: StreakState }
  /** Delete any stored run. */
  | { action: 'clear' }
  /** Leave storage exactly as it is. */
  | { action: 'keep' };

export interface SignalOutcome {
  transition: StreakTransition;
  fire: boolean;
}

/**
 * Advance (or evaluate) one run.
 *
 * @param prev    Stored run, or `null`.
 * @param obs     This tick's observation.
 * @param window  Observations required before firing, in the cadence the
 *                caller has chosen for this signal.
 * @param counts  Whether this observation may advance the run. `false`
 *                for manual invocations, which read the state but do not
 *                own the cadence it is denominated in.
 */
export function stepSignal(
  prev: StreakState | null,
  obs: Observation,
  window: number,
  counts: boolean,
): SignalOutcome {
  if (obs.state === 'unknown') {
    // Neither advance nor erase. Both sides of these comparisons are
    // monotonic, so the next real observation can decide correctly; an
    // intermittent gap must not cost the run its accumulated evidence.
    return { transition: { action: 'keep' }, fire: false };
  }

  if (obs.state === 'clear') {
    return { transition: counts ? { action: 'clear' } : { action: 'keep' }, fire: false };
  }

  const continuing = prev && prev.marker === obs.marker ? prev : null;

  if (!counts) {
    // Evaluate what is stored; contribute nothing to it.
    return {
      transition: { action: 'keep' },
      fire: (continuing?.streak ?? 0) >= window,
    };
  }

  const streak = (continuing?.streak ?? 0) + 1;
  return {
    transition: { action: 'save', state: { marker: obs.marker, streak } },
    fire: streak >= window,
  };
}
