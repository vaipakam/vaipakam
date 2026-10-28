/** Action gates whose value moves without any own-wallet action.
 *  `tipAware` stretches their interval on a healthy push rail on the
 *  promise that the tip rail refreshes them, so each root must be on
 *  every rail that promise names: the take-back-collateral ceiling
 *  (#2389 r1) and the lender exit chooser's sale verdict (#1841). */
import { describe, expect, it } from 'vitest';
import { STRETCHED_ROOTS } from './IndexerPushSync';
import { LIVE_KEYS, TIP_KEYS } from './LiveChainSync';
import { RECEIPT_FLOOR_ROOTS } from './receiptSync';

describe.each(['maxWithdrawable', 'saleExitVerdict'])('%s freshness rails', (root) => {
  it('rides the block-driven fallback blanket', () => {
    expect(LIVE_KEYS.has(root)).toBe(true);
  });
  it('rides the per-block action-gate rail on a healthy push rail', () => {
    expect(TIP_KEYS.has(root)).toBe(true);
  });
  it('is refetched when a hidden tab returns', () => {
    expect(STRETCHED_ROOTS).toContain(root);
  });
  it('is refreshed in every tab after an own write', () => {
    expect(RECEIPT_FLOOR_ROOTS).toContain(root);
  });
});
