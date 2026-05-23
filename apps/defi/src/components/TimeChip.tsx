import { useEffect, useMemo, useState } from 'react';

/**
 * Time-driven badge for the offer surfaces (#241).
 *
 * Renders an auto-ticking countdown / elapsed-time chip in one of three modes:
 *
 *   - `kind="expiry"` + `targetSec` in the future → "expires in 3h 12m".
 *   - `kind="expiry"` + `targetSec` in the past → "expired N min ago".
 *   - `kind="cooldown"` + `targetSec` in the future → "cancellable in 4m 23s".
 *   - `kind="cooldown"` + `targetSec` in the past → renders nothing (the
 *     cooldown has elapsed; the surrounding control surface should drop
 *     the chip).
 *
 * The tick cadence auto-adjusts: 1 s while the remaining window is < 2
 * min (so seconds visibly count down on the cooldown surface), 30 s
 * otherwise (the GTT countdown ticks at minute granularity — no need to
 * burn renders).
 *
 * Decision: dumb / pure. The chip does not gate buttons, does not call
 * contracts, does not own any retry / refresh logic. Surrounding rows
 * decide what to do based on the same `now >= targetSec` predicate,
 * keeping render and gating in lockstep without prop-callback ping-pong.
 *
 * Why two modes share one component: rendering, ticking, and styling
 * are identical; only the label changes. A `<CooldownChip>` +
 * `<ExpiryChip>` split would duplicate the tick loop and the
 * unit-formatter helpers below for no readability gain.
 *
 * #241 — pairs with the `MIN_OFFER_CANCEL_DELAY` cancel-cooldown
 * (Range Orders Phase 1) and the GTT `expiresAt` field (#195).
 */
export interface TimeChipProps {
  /** Discriminator selecting the chip's label set. */
  kind: 'expiry' | 'cooldown';
  /** Absolute unix-seconds wall-clock target. */
  targetSec: number;
  /** Optional explicit className for table-cell layout sites. */
  className?: string;
}

function formatDelta(seconds: number): string {
  // Negative seconds = elapsed since target; absolute value drives the
  // display, caller-side branching picks "in X" vs "X ago".
  const abs = Math.abs(seconds);
  if (abs < 60) return `${Math.floor(abs)}s`;
  if (abs < 60 * 60) {
    const m = Math.floor(abs / 60);
    const s = Math.floor(abs % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (abs < 24 * 60 * 60) {
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function TimeChip({ kind, targetSec, className }: TimeChipProps) {
  // Tick state. We don't store the formatted string — re-derive on every
  // render so timezone / locale / DST changes don't require remounting.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  // Adaptive tick cadence: snap to 1 s when the user is watching the
  // last 2 min of a window (cooldown's exact-second display is the
  // load-bearing case; GTT-expiry doesn't need < 30 s precision after
  // an hour).
  const remaining = targetSec - nowSec;
  const tickMs = Math.abs(remaining) < 120 ? 1000 : 30_000;

  useEffect(() => {
    const id = window.setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      tickMs,
    );
    return () => window.clearInterval(id);
  }, [tickMs]);

  // Render decisions.
  const { label, tone } = useMemo(() => {
    const delta = targetSec - nowSec;
    const elapsed = delta <= 0;

    if (kind === 'cooldown') {
      if (elapsed) {
        // Cooldown done → caller should drop the chip entirely.
        return { label: null, tone: 'neutral' as const };
      }
      return {
        label: `Cancellable in ${formatDelta(delta)}`,
        tone: 'pending' as const,
      };
    }
    // Expiry kind.
    if (elapsed) {
      return {
        label: `Expired ${formatDelta(delta)} ago — anyone can clean up`,
        tone: 'expired' as const,
      };
    }
    return {
      label: `Expires in ${formatDelta(delta)}`,
      tone: 'live' as const,
    };
  }, [kind, targetSec, nowSec]);

  if (label === null) return null;

  // Tone → CSS background/color. Inline so the chip is self-contained
  // and doesn't add CSS file plumbing on first land.
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: '0.72rem',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  };
  const toneStyle: React.CSSProperties = {
    pending: {
      background: 'rgba(245, 158, 11, 0.12)',
      color: 'var(--accent-amber, #f59e0b)',
    },
    live: {
      background: 'rgba(16, 185, 129, 0.12)',
      color: 'var(--accent-green, #10b981)',
    },
    expired: {
      background: 'rgba(239, 68, 68, 0.12)',
      color: 'var(--accent-red, #ef4444)',
    },
    neutral: {
      background: 'var(--surface-2, rgba(255,255,255,0.05))',
      color: 'var(--muted, rgba(255,255,255,0.5))',
    },
  }[tone];

  return (
    <span className={className} style={{ ...baseStyle, ...toneStyle }}>
      {label}
    </span>
  );
}
