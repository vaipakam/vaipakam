import { describe, expect, it } from 'vitest';
import { activityActor, actorAttributedKinds } from './activityActor';

const A = '0xAbCdEf0000000000000000000000000000000001';

describe('activityActor', () => {
  it('files an attributed event under its actor, lower-cased', () => {
    expect(activityActor('LoanRepaid', { repayer: A })).toBe(A.toLowerCase());
    expect(activityActor('Transfer', { from: '0x1', to: A })).toBe(A.toLowerCase());
  });

  it('files an event with no entry under no wallet', () => {
    expect(activityActor('LoanStatusChanged', { loanId: 1n })).toBeNull();
  });

  it('never reads an Object.prototype member as an entry', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(activityActor(name, { to: A })).toBeNull();
      expect(actorAttributedKinds().has(name)).toBe(false);
    }
  });

  it('a cleared tier exclusion names no wallet', () => {
    expect(
      activityActor('TierExclusionUpdated', { vaultOwner: '0x0000000000000000000000000000000000000000' }),
    ).toBeNull();
    expect(activityActor('TierExclusionUpdated', { vaultOwner: A })).toBe(A.toLowerCase());
  });

  it('a sold offer is filed under its creator, never under the executor contract', () => {
    expect(activityActor('OfferConsumedBySale', { creator: A, executor: '0x2' })).toBe(A.toLowerCase());
    expect(activityActor('OfferConsumedBySale', { executor: A })).toBeNull();
    expect(activityActor('PrepayCollateralSaleSettled', { executor: A })).toBeNull();
  });

  it('lists every attributed kind', () => {
    const kinds = actorAttributedKinds();
    expect(kinds.has('OfferCreated')).toBe(true);
    expect(kinds.has('TierExclusionUpdated')).toBe(true);
    expect(kinds.has('LoanStatusChanged')).toBe(false);
  });
});
