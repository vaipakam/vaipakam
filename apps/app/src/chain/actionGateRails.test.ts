/** #2389 r1 — the take-back-collateral ceiling is an action gate whose
 *  value moves without any own-wallet action (prices, debt, a third
 *  party's repay or liquidation). `tipAware` stretches its interval on a
 *  healthy push rail on the promise that the tip rail refreshes it, so
 *  the root must be on every rail that promise names. */
import { describe, expect, it } from 'vitest';
import { LIVE_KEYS, TIP_KEYS } from './LiveChainSync';
import { RECEIPT_FLOOR_ROOTS } from './receiptSync';

describe('maxWithdrawable freshness rails', () => {
  it('rides the block-driven fallback blanket', () => {
    expect(LIVE_KEYS.has('maxWithdrawable')).toBe(true);
  });
  it('rides the per-block action-gate rail on a healthy push rail', () => {
    expect(TIP_KEYS.has('maxWithdrawable')).toBe(true);
  });
  it('is refreshed in every tab after an own write', () => {
    expect(RECEIPT_FLOOR_ROOTS).toContain('maxWithdrawable');
  });
});
