/**
 * Rescan-button cooldown + sync-status state machine.
 *
 * Handles the post-click UX for the "Rescan chain" buttons in the
 * OfferBook and Activity pages:
 *
 *   1. User clicks → call `trigger()`. Button enters cooldown for the
 *      next `cooldownMs` (default 30 s). `disabled` flips true and
 *      `secondsRemaining` counts down once a second so the caller
 *      can render a live timer.
 *   2. The underlying scan starts (the caller's `loading` flag flips
 *      true). `status` transitions `idle → syncing`.
 *   3. The scan finishes (caller's `loading` flips back to false).
 *      `status` transitions `syncing → synced` so the button can show
 *      a confirmation tick. Status stays as `synced` until the
 *      cooldown expires; that confirmation window is exactly the
 *      reason the cooldown lasts longer than the scan itself.
 *   4. Cooldown expires → `disabled` flips false, `status` resets to
 *      `idle`, the button is clickable again.
 *
 * Why the cooldown matters: the legacy scan completes in 1–5 s on a
 * healthy RPC, so without the cooldown the button toggles disabled →
 * enabled too fast for a user to confirm the action took effect, AND
 * a frustrated user can spam-click into RPC quota burn (the same
 * abuse vector that drove the IndexerStatusBadge's rescan-button
 * removal). 30 s is a balance: long enough for the user to see the
 * status flip from 'syncing' → 'synced', short enough that a user
 * actively watching for an event can click again within reasonable
 * time. The next indexer cron (1-minute minimum) generally fires
 * before the cooldown expires, so unblocking the button always
 * exposes genuinely new data.
 */

import { useEffect, useRef, useState } from 'react';

interface UseRescanCooldownArgs {
  /** True when the underlying scan is in flight. The hook flips its
   *  status from 'idle' → 'syncing' on rising edge and 'syncing' →
   *  'synced' on falling edge — but ONLY while the cooldown window
   *  is active. Outside the window, status stays 'idle' regardless. */
  loading: boolean;
  /** Cooldown window in ms. Default 30 s. */
  cooldownMs?: number;
}

export interface UseRescanCooldownResult {
  /** Call when the user clicks the rescan button. Arms the cooldown
   *  and flips status to 'syncing'. The caller then triggers their
   *  own actual scan/refetch separately. */
  trigger: () => void;
  /** True while the cooldown window is open. Wire to `button.disabled`. */
  disabled: boolean;
  /** Whole seconds left in the cooldown (0 when not armed). */
  secondsRemaining: number;
  /** [0, 1] progress through the cooldown window. Useful for a
   *  CSS-driven progress bar via `style={{ '--rescan-progress':
   *  `${progress * 100}%` }}`. */
  progress: number;
  /** Lifecycle indicator used to drive the button label / status pill. */
  status: 'idle' | 'syncing' | 'synced';
}

export function useRescanCooldown({
  loading,
  cooldownMs = 30_000,
}: UseRescanCooldownArgs): UseRescanCooldownResult {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [status, setStatus] = useState<'idle' | 'syncing' | 'synced'>('idle');
  // Tracks whether we've ever seen `loading=true` during the current
  // cooldown window — so the falling edge ('synced') only fires once
  // we've actually observed a sync running. Without this, a button
  // click on a page that's already mid-load would jump straight to
  // 'synced' on the next loading flip without ever showing 'syncing'.
  const sawLoadingTrue = useRef(false);

  // 1 Hz tick while cooldown is active so the seconds countdown
  // updates. Cleared when the window closes.
  useEffect(() => {
    if (endsAt === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      if (t >= endsAt) {
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
    setEndsAt(Date.now() + cooldownMs);
    setNow(Date.now());
    sawLoadingTrue.current = false;
    setStatus('syncing');
  };

  const disabled = endsAt !== null && now < endsAt;
  const secondsRemaining =
    endsAt !== null ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;
  const progress =
    endsAt !== null
      ? Math.min(1, Math.max(0, 1 - (endsAt - now) / cooldownMs))
      : 0;

  return { trigger, disabled, secondsRemaining, progress, status };
}
