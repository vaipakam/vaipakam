/** Action-gating chain reads and the freshness rails their stretched
 *  interval relies on. `tipAware` stretches a root's interval on a
 *  healthy push rail on the promise that the tip rail refreshes it per
 *  block, on a hidden tab's return and on the first interaction after an
 *  idle stretch. Those three rails are built from `TIP_ROOTS`, the only
 *  roots `tipAware` accepts; this pins that they stay built from it
 *  (Codex #3024 r1, #3030 r1). */
import { describe, expect, it } from 'vitest';
import { KEY_MAP, STRETCHED_ROOTS } from './IndexerPushSync';
import { LIVE_KEYS, RESUME_EXTRA_KEYS, TIP_KEYS } from './LiveChainSync';
import { RECEIPT_FLOOR_ROOTS } from './receiptSync';
import { TIP_ROOTS } from './tipRoots';

describe.each(TIP_ROOTS)('%s rides every rail its stretch relies on', (root) => {
  it('is refreshed per block on a healthy push rail', () => {
    expect(TIP_KEYS.has(root)).toBe(true);
  });
  it('is refetched when a hidden tab returns', () => {
    expect(STRETCHED_ROOTS).toContain(root);
  });
  it('is refetched on the first interaction after an idle stretch', () => {
    expect(RESUME_EXTRA_KEYS.has(root) || LIVE_KEYS.has(root)).toBe(true);
  });
});

it('the tip rail carries exactly the declared roots', () => {
  expect([...TIP_KEYS].sort()).toEqual([...TIP_ROOTS].sort());
});

// Beyond what the stretch relies on: these gates also move with no own
// action while the rail is down, and with an own write in another tab.
describe.each(['maxWithdrawable', 'periodicInterest', 'saleExitVerdict'])('%s, beyond the tip rail', (root) => {
  it('rides the block-driven fallback blanket', () => {
    expect(LIVE_KEYS.has(root)).toBe(true);
  });
  it('is refreshed in every tab after an own write', () => {
    expect(RECEIPT_FLOOR_ROOTS).toContain(root);
  });
});

// A past seller's interest claims (#1209) are stretched by `signalAware`,
// and a past seller is no party to the loan, so every rail that stretch
// relies on must name the root itself: the activity frame, a hidden tab's
// return, the fallback blanket and an own write in another tab.
describe('sellerClaims rides every rail its stretch relies on', () => {
  it('is dirtied by the activity frame that carries its rows', () => {
    expect(KEY_MAP['activity.appended']).toContain('sellerClaims');
  });
  it('is refetched when a hidden tab returns', () => {
    expect(STRETCHED_ROOTS).toContain('sellerClaims');
  });
  it('rides the block-driven fallback blanket', () => {
    expect(LIVE_KEYS.has('sellerClaims')).toBe(true);
  });
  it('is refreshed in every tab after an own write', () => {
    expect(RECEIPT_FLOOR_ROOTS).toContain('sellerClaims');
  });
});
