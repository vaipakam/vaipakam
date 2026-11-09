import { describe, expect, it } from 'vitest';
import { escapeState, type EscapeFacts } from './EscapeNotice';

const OPEN = { enabled: false, locked: false, delaySeconds: 0, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
const PROTECTED = { ...OPEN, enabled: true, delaySeconds: 172_800 };
const f = (p: Partial<EscapeFacts>): EscapeFacts => ({ paused: true, escapeOpen: false, opensAt: 1_000, protection: OPEN, chainNow: 500, readAt: 0, ...p });

describe('escapeState', () => {
  it('says nothing when the protocol is not paused, and says so when that is unread', () => {
    expect(escapeState(f({ paused: false }), 500)).toBeNull();
    expect(escapeState(f({ paused: null }), 500)).toBe('unread');
    expect(escapeState(null, null)).toBe('unread');
  });
  it('before the route opens: when it opens, or that none is scheduled, or that it is due now', () => {
    expect(escapeState(f({}), 500)).toBe('opensAt');
    expect(escapeState(f({}), 1_000)).toBe('opening');
    expect(escapeState(f({ opensAt: 0 }), 500)).toBe('noRoute');
    expect(escapeState(f({ opensAt: null }), 500)).toBe('routeUnread');
    expect(escapeState(f({ escapeOpen: null }), 500)).toBe('routeUnread');
  });
  it('once open: straight to the wallet without protected mode, still queued with it', () => {
    expect(escapeState(f({ escapeOpen: true }), 2_000)).toBe('openPlain');
    expect(escapeState(f({ escapeOpen: true, protection: PROTECTED }), 2_000)).toBe('openProtected');
    expect(escapeState(f({ escapeOpen: true, protection: null }), 2_000)).toBe('openModeUnread');
  });
});
