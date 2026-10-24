import { describe, expect, it } from 'vitest';

import {
  earlyRepayChooserExclusion,
  earlyRepayChooserRenders,
  type EarlyRepayChooserFacts,
} from './earlyRepayChooser';

const SHOWN: EarlyRepayChooserFacts = {
  viewerIsBorrower: true,
  active: true,
  rental: false,
  offsetPending: false,
  graceVerifiablyOver: false,
  closedThisSession: false,
};

describe('earlyRepayChooserExclusion (#1557)', () => {
  it('renders for an active ERC-20 loan the viewer borrows, in grace, with no offset', () => {
    expect(earlyRepayChooserExclusion(SHOWN)).toBeNull();
    expect(earlyRepayChooserRenders(SHOWN)).toBe(true);
  });

  // Each clause on its own hides the card and names itself.
  it.each([
    [{ viewerIsBorrower: false }, 'not-borrower'],
    [{ active: false }, 'not-active'],
    [{ closedThisSession: true }, 'closed-this-session'],
    [{ rental: true }, 'rental'],
    [{ offsetPending: true }, 'offset-pending'],
    [{ graceVerifiablyOver: true }, 'grace-over'],
  ] as const)('%o hides it as %s', (over, reason) => {
    const f = { ...SHOWN, ...over };
    expect(earlyRepayChooserExclusion(f)).toBe(reason);
    expect(earlyRepayChooserRenders(f)).toBe(false);
  });
});
