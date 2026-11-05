import type { ReactNode } from 'react';

/**
 * A stated condition (RB-TIERS): tier A is always visible and announced
 * assertively when it is a danger; tier B is polite. Tone is meaning, never
 * decoration (tokens.css), and a notice is never the only carrier of a
 * consequence a receipt must also show.
 */
export function Notice({ tone, tier, children }: { tone: 'info' | 'ok' | 'warn' | 'danger'; tier: 'A' | 'B'; children: ReactNode }) {
  return (
    <div className={`notice-${tone} ${tier === 'A' ? 'tier-a' : 'tier-b'}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
