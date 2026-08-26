/**
 * Idle-aware polling cadence (RPC diet).
 *
 * TanStack Query already pauses interval refetches while the tab is
 * hidden (`refetchIntervalInBackground` defaults to false), but a tab
 * that stays visible while the user walks away keeps every poller at
 * full cadence indefinitely. This module tracks the last user
 * interaction and lets data hooks stretch their refetch interval once
 * the session has gone quiet — first input snaps everything back to
 * the active cadence on its next tick, and TanStack's focus refetch
 * catches the user up immediately when they return to the tab.
 *
 * Deliberately interaction-based, not focus-based: a visible tab the
 * user is actively READING (scrolling counts — `wheel`/`touchmove`)
 * stays live; only a genuinely abandoned session backs off.
 */

/** Quiet time after which a session counts as idle. */
const IDLE_AFTER_MS = 2 * 60_000;

/** Idle cadence multiplier: 30s pollers drop to 2min, 60s to 4min. */
const IDLE_FACTOR = 4;

let lastActivityAt = Date.now();

/** Fired when the FIRST interaction after an idle stretch lands.
 *  TanStack only re-evaluates a function `refetchInterval` after a
 *  fetch, so a stretched timer already in flight would otherwise run
 *  to completion (up to 4× the base interval) before the cadence
 *  snaps back — the resume listener lets the app refresh the
 *  freshness-critical caches immediately instead (Codex round-1 P2). */
const resumeListeners = new Set<() => void>();

export function onActivityResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => {
    resumeListeners.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  const mark = () => {
    const wasIdle = isIdle();
    lastActivityAt = Date.now();
    if (wasIdle) for (const l of resumeListeners) l();
  };
  // Passive + capture: never affects scrolling performance, and sees
  // events consumed inside components.
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchmove'] as const) {
    window.addEventListener(ev, mark, { passive: true, capture: true });
  }
  // Returning to the tab is activity even without an input event.
  // (TanStack's focus refetch also fires on this path; concurrent
  // refetches of the same query dedupe, so no double fetch.)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) mark();
  });
}

/** True when the session has had no interaction for IDLE_AFTER_MS. */
export function isIdle(): boolean {
  return Date.now() - lastActivityAt > IDLE_AFTER_MS;
}

/** Drop-in for a constant `refetchInterval`: full cadence while the
 *  user is active, `IDLE_FACTOR`× slower once the session goes quiet.
 *  TanStack re-evaluates the function after every fetch, so the next
 *  interaction restores the active cadence within one (stretched)
 *  tick — and the focus-refetch covers the tab-switch return case
 *  instantly. */
export function idleAware(baseMs: number): () => number {
  return () => (isIdle() ? baseMs * IDLE_FACTOR : baseMs);
}
