import { describe, expect, it } from 'vitest';
import { createShownScope, scopeKey } from './shownScope';

describe('shownScope (#3836)', () => {
  it('applies an answer only to the wallet and network that asked', () => {
    const asked = scopeKey(84532, '0xAbC');
    const shown = createShownScope(asked);
    const writes: string[] = [];
    expect(shown.ifShowing(asked, () => writes.push('first'))).toBe(true);
    // The person switches network while the wallet is still being asked.
    shown.show(scopeKey(421614, '0xAbC'));
    expect(shown.ifShowing(asked, () => writes.push('late'))).toBe(false);
    // Back on the network that asked: its answer may show again.
    shown.show(scopeKey(84532, '0xabc'));
    expect(shown.ifShowing(asked, () => writes.push('back'))).toBe(true);
    expect(writes).toEqual(['first', 'back']);
  });

  it('treats a different wallet on the same network as another scope', () => {
    expect(scopeKey(84532, '0x1')).not.toBe(scopeKey(84532, '0x2'));
    expect(scopeKey(84532, undefined)).toBe('84532:');
  });
});
