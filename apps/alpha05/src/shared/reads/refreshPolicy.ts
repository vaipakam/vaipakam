/**
 * RB-REFRESH, as one rule: own-state reads refresh on signals, and on a
 * bounded safety interval while the tab is visible (60 s by default),
 * paused while hidden. A read that gates an imminent money decision
 * refreshes per block while it is on screen, which the hook does from the
 * chain's block number, not from this interval.
 */
export const OWN_REFRESH_MS = 60_000;

export function ownRefreshIntervalMs(visible: boolean): number | false {
  return visible ? OWN_REFRESH_MS : false;
}
