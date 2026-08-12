/**
 * The current time, in whole seconds, as a value a render may read (#1520).
 *
 * `Date.now()` called during render is impure: the value a component shows
 * then depends on WHEN React happened to render it, so it freezes until
 * something unrelated causes a re-render. That is not a hypothetical — an
 * age readout built that way sits at "2m ago" indefinitely, and a
 * validation that compares a user's input against "now" keeps answering
 * against the moment the field was first painted.
 *
 * Reading the clock through state fixes both halves: the value is stable
 * within a render pass (so the component is idempotent) and it advances on
 * a schedule (so what it derives stays true).
 *
 * The period is deliberately coarse. Every consumer here is comparing
 * against a threshold measured in tens of seconds or more — indexer
 * freshness, offer expiry, a tier unlock — so a 30s tick is precise enough
 * for all of them while keeping the re-render cost to one pass per period.
 * Pass a shorter period only for something a user watches count down.
 */
import { useEffect, useState } from 'react';

/** Coarse enough for freshness banners and expiry comparisons. */
export const DEFAULT_NOW_PERIOD_MS = 30_000;

export function useNowSec(periodMs: number = DEFAULT_NOW_PERIOD_MS): number {
  // Seeded from the clock so the FIRST paint is already correct — starting
  // at 0 and correcting in the effect would flash a wrong age.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const tick = () => setNowSec(Math.floor(Date.now() / 1000));
    // Re-read on mount as well as on the interval: a tab restored from the
    // background can be many periods stale, and the interval alone would
    // leave the first paint after resume showing the pre-suspend value.
    tick();
    const id = setInterval(tick, periodMs);
    return () => clearInterval(id);
  }, [periodMs]);

  return nowSec;
}
