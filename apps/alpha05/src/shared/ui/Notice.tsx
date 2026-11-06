import type { ReactNode } from 'react';
import { Icon, type Meaning } from './Icon';

/** RB-ICONS: a notice's tone carries its meaning icon; plain information
 *  has nothing to act on and carries none. */
const TONE_ICON: Readonly<Record<'info' | 'ok' | 'warn' | 'danger', Meaning | null>> = { info: null, ok: 'done', warn: 'act', danger: 'blocked' };

/**
 * A stated condition (RB-TIERS): tier A is always visible and announced
 * assertively when it is a danger; tier B is polite. Tone is meaning, never
 * decoration (tokens.css), and a notice is never the only carrier of a
 * consequence a receipt must also show.
 */
export function Notice({ tone, tier, children }: { tone: 'info' | 'ok' | 'warn' | 'danger'; tier: 'A' | 'B'; children: ReactNode }) {
  return (
    <div className={`notice-${tone} ${tier === 'A' ? 'tier-a' : 'tier-b'}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {TONE_ICON[tone] !== null ? (
        <span className="notice-with-icon">
          <Icon meaning={TONE_ICON[tone]!} />
          <span>{children}</span>
        </span>
      ) : (
        children
      )}
    </div>
  );
}
