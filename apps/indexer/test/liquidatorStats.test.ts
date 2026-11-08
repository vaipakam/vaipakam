/**
 * #3366 — the pure counting rules behind `/loans/stats`'s `liquidators`.
 */
import { describe, expect, it } from 'vitest';
import { summariseLiquidators } from '../src/liquidatorStats';

const NOW = 2_000_000_000;

describe('summariseLiquidators', () => {
  it('states that the keeper cannot be told apart when none is published', () => {
    const s = summariseLiquidators(
      [{ kind: 'HFLiquidationTriggered', who: '0xaa', n7: 1, n30: 1 }],
      undefined,
      NOW,
    );
    expect(s.keeperAddress).toBeNull();
    expect(s.windows['30d'].primary.keeper).toBeNull();
    expect(s.windows['30d'].primary.thirdParty).toBe(1);
    expect(s.caveats.some((c) => /publishes no keeper address/.test(c))).toBe(true);
  });

  it('ignores a route outside both lists', () => {
    const s = summariseLiquidators([{ kind: 'LoanRepaid', who: '0xaa', n7: 3, n30: 3 }], '0xKK', NOW);
    expect(s.windows['30d'].primary.events).toBe(0);
    expect(s.windows['30d'].otherRoutes.events).toBe(0);
  });

  it('matches the keeper case-insensitively', () => {
    const s = summariseLiquidators(
      [{ kind: 'LiquidationDiscounted', who: '0xabcd', n7: 0, n30: 2 }],
      '0xABCD',
      NOW,
    );
    expect(s.windows['30d'].primary).toMatchObject({ thirdParty: 0, keeper: 1, events: 2 });
    expect(s.windows['7d'].primary).toMatchObject({ thirdParty: 0, keeper: 0, events: 0 });
  });
});
