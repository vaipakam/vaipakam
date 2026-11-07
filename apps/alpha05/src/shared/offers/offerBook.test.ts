import { describe, expect, it } from 'vitest';
import { belowFloor, capStanding } from './offerBook';

describe('offer-book bounds (#3242)', () => {
  it('blocks only an amount measured below a binding floor', () => {
    expect(belowFloor(9n, 10n)).toBe(true);
    expect(belowFloor(10n, 10n)).toBe(false);
    expect(belowFloor(9n, null)).toBe(false);
    expect(belowFloor(null, 10n)).toBe(false);
  });
  it('stops at the cap, names the count near it, and says nothing unknown', () => {
    expect(capStanding({ open: 25n, cap: 25n })).toBe('full');
    expect(capStanding({ open: 20n, cap: 25n })).toBe('near');
    expect(capStanding({ open: 19n, cap: 25n })).toBe('room');
    expect(capStanding(null)).toBe('room');
  });
});
