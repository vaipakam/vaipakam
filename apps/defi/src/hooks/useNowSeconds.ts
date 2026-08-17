import { useEffect, useState } from 'react';

/**
 * Unix seconds that re-tick while the component stays mounted.
 *
 * Reading `Date.now()` straight from a render body freezes the value for the
 * life of that render. For a *display* that is merely cosmetic; for a
 * *deadline gate* — "has the grace period closed", "is this loan overdue" — it
 * means the gate never flips while the user sits on the page, so an expired
 * action surface keeps offering itself.
 *
 * That is not a theoretical risk in this app. `LoanDetails.tsx` already
 * carried a hand-rolled version of this hook, added because "a page opened
 * pre-grace would keep showing the action surface forever even after
 * `now >= endTime + gracePeriod`" (PR #308) — while a second deadline in the
 * same file went on reading the clock directly and stayed frozen.
 * `ChainDiagnosticsPanel.tsx` had grown its own copy too. One hook replaces
 * both, so the next deadline gets a ticking clock by default rather than by
 * remembering.
 *
 * `useState` takes a LAZY initializer: passing `Date.now()` directly would
 * call it on every render, which is the impurity this exists to remove.
 *
 * @param intervalMs how often to re-tick. Default 60s, which suits
 *   day/hour-scale deadlines; pass something shorter only where a
 *   second-scale boundary is actually visible, since each tick re-renders.
 */
export function useNowSeconds(intervalMs = 60_000): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      intervalMs,
    );
    return () => clearInterval(id);
  }, [intervalMs]);

  return nowSec;
}
