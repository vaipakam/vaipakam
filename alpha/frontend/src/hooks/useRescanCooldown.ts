/**
 * Rescan-button cooldown + sync-status state machine, with adaptive
 * back-off for spam-click resistance.
 *
 * Handles the post-click UX for the "Rescan" buttons in the OfferBook,
 * Activity, Vault, and Dashboard pages:
 *
 *   1. User clicks → call `trigger()`. Button enters cooldown for the
 *      next `currentCooldownMs` (starts at `baseCooldownMs`, default
 *      30 s). `disabled` flips true and `secondsRemaining` counts down
 *      once a second so the caller can render a live timer.
 *   2. The underlying scan starts (the caller's `loading` flag flips
 *      true). `status` transitions `idle → syncing`.
 *   3. The scan finishes (caller's `loading` flips back to false).
 *      `status` transitions `syncing → synced` so the button can show
 *      a confirmation tick. Status stays as `synced` until the
 *      cooldown expires; that confirmation window is exactly the
 *      reason the cooldown lasts longer than the scan itself.
 *   4. Cooldown expires → `disabled` flips false, `status` resets to
 *      `idle`, the button is clickable again. Adaptive bookkeeping:
 *      see "Adaptive cooldown" below.
 *
 * Why the cooldown matters: the legacy scan completes in 1–5 s on a
 * healthy RPC, so without a cooldown the button toggles disabled →
 * enabled too fast for a user to confirm the action took effect, AND
 * a frustrated user can spam-click into RPC quota burn. 30 s is the
 * baseline: long enough for the user to see the status flip from
 * 'syncing' → 'synced', short enough that a user actively watching
 * for an event can click again within reasonable time.
 *
 * ## Adaptive cooldown
 *
 * If the user clicks again within `resetAfterIdleMs` of the previous
 * cooldown ending, the next cooldown grows by `growthFactor` (default
 * 2×), capped at `maxCooldownMs`. After a quiet stretch longer than
 * `resetAfterIdleMs` post-cooldown, the next click resets back to
 * `baseCooldownMs`. Spam pattern: 30 s → 60 s → 120 s → 240 s → 300 s
 * (capped). Walk-away-and-come-back-2-min-later: stays at 30 s.
 *
 * The growth fires on the SECOND click (since the first click
 * establishes the cooldown). It's not a "you clicked too fast"
 * scolding — by the time the user can click again the previous
 * cooldown is already over, so the growth only kicks in for users
 * actively churning the button. Legitimate "I just want to recheck"
 * clicks after a few minutes always get the baseline.
 */

import { useEffect, useRef, useState } from 'react';

interface UseRescanCooldownArgs {
  /** True when the underlying scan is in flight. The hook flips its
   *  status from 'idle' → 'syncing' on rising edge and 'syncing' →
   *  'synced' on falling edge — but ONLY while the cooldown window
   *  is active. Outside the window, status stays 'idle' regardless. */
  loading: boolean;
  /** Initial cooldown window in ms. Default 30 s. */
  baseCooldownMs?: number;
  /** Multiplier applied to the cooldown when the user re-triggers
   *  before `resetAfterIdleMs` has elapsed since the last cooldown
   *  ended. Default 2 (each spam click doubles the next cooldown). */
  growthFactor?: number;
  /** Upper bound on the adaptive cooldown — even an indefatigable
   *  spam-clicker can't push it past this. Default 5 minutes. */
  maxCooldownMs?: number;
  /** Quiet-period threshold post-cooldown after which the cooldown
   *  resets to `baseCooldownMs` on the next click. Default 2 minutes. */
  resetAfterIdleMs?: number;
}

export interface UseRescanCooldownResult {
  /** Call when the user clicks the rescan button. Arms the cooldown
   *  (with adaptive growth applied) and flips status to 'syncing'.
   *  The caller then triggers their own actual scan/refetch separately. */
  trigger: () => void;
  /** True while the cooldown window is open. Wire to `button.disabled`. */
  disabled: boolean;
  /** Whole seconds left in the cooldown (0 when not armed). */
  secondsRemaining: number;
  /** [0, 1] progress through the cooldown window — increases from 0
   *  → 1 as time elapses. Kept for callers that want elapsed-fraction
   *  semantics. */
  progress: number;
  /** [0, 1] remaining fraction of the cooldown — the inverse of
   *  `progress`, decreases from 1 → 0 as time elapses. Used to drive
   *  the rescan-button progress bar so it starts full and visually
   *  drains right-to-left as the countdown runs out. */
  remaining: number;
  /** Lifecycle indicator used to drive the button label / status pill. */
  status: 'idle' | 'syncing' | 'synced';
}

export function useRescanCooldown({
  loading,
  baseCooldownMs = 30_000,
  growthFactor = 2,
  maxCooldownMs = 300_000,
  resetAfterIdleMs = 120_000,
}: UseRescanCooldownArgs): UseRescanCooldownResult {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [status, setStatus] = useState<'idle' | 'syncing' | 'synced'>('idle');
  // Drives the inverse-progress bar; needs to know the cooldown's
  // length at the moment it was armed (NOT the next-cooldown's length,
  // which adapts on each trigger). Stored alongside `endsAt`.
  const [activeCooldownMs, setActiveCooldownMs] = useState<number>(baseCooldownMs);
  // Refs avoid stale closure capture inside the trigger handler.
  const sawLoadingTrue = useRef(false);
  const lastCooldownEndedAt = useRef<number | null>(null);
  const nextCooldownMs = useRef<number>(baseCooldownMs);

  // 1 Hz tick while cooldown is active so the seconds countdown
  // updates. Cleared when the window closes.
  useEffect(() => {
    if (endsAt === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      if (t >= endsAt) {
        // Cooldown finished — record the end time so the adaptive
        // logic on the next trigger knows whether enough quiet has
        // elapsed to reset the growth.
        lastCooldownEndedAt.current = endsAt;
        setEndsAt(null);
        setStatus('idle');
        sawLoadingTrue.current = false;
      } else {
        setNow(t);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  // Watch loading edges to drive the syncing→synced transition.
  // Only acts inside the cooldown window — outside, the rescan button
  // doesn't claim any status of its own (other components may also be
  // toggling `loading` for unrelated reasons).
  useEffect(() => {
    if (endsAt === null) return;
    if (loading) {
      sawLoadingTrue.current = true;
      setStatus('syncing');
    } else if (sawLoadingTrue.current) {
      setStatus('synced');
    }
  }, [loading, endsAt]);

  const trigger = () => {
    const t = Date.now();
    // Pick the cooldown for THIS trigger:
    //   - First-ever click on this mount, OR re-click after a quiet
    //     stretch ≥ `resetAfterIdleMs`: reset to `baseCooldownMs`.
    //   - Re-click within the quiet window: grow by `growthFactor`,
    //     capped at `maxCooldownMs`.
    let chosenCooldown = nextCooldownMs.current;
    const lastEnd = lastCooldownEndedAt.current;
    const idleSinceLastEnd = lastEnd === null ? Infinity : t - lastEnd;
    if (idleSinceLastEnd >= resetAfterIdleMs) {
      chosenCooldown = baseCooldownMs;
    }
    setActiveCooldownMs(chosenCooldown);
    setEndsAt(t + chosenCooldown);
    setNow(t);
    // Pre-compute the next-trigger cooldown so the next click knows
    // its growth even before the cooldown ends. Capped at the ceiling.
    nextCooldownMs.current = Math.min(
      chosenCooldown * growthFactor,
      maxCooldownMs,
    );
    sawLoadingTrue.current = false;
    setStatus('syncing');
  };

  const disabled = endsAt !== null && now < endsAt;
  const secondsRemaining =
    endsAt !== null ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;
  const progress =
    endsAt !== null
      ? Math.min(1, Math.max(0, 1 - (endsAt - now) / activeCooldownMs))
      : 0;
  const remaining = endsAt !== null ? Math.max(0, 1 - progress) : 0;

  return { trigger, disabled, secondsRemaining, progress, remaining, status };
}
