import { describe, expect, it } from 'vitest';
import { catalogText } from './catalogText';
import { copy } from '../content/copy';

describe('catalogText', () => {
  it('reads an own string entry', () => {
    expect(catalogText({ repaid: 'repaid' }, 'repaid')).toBe('repaid');
  });

  it('never resolves an inherited member, so the caller falls back', () => {
    const map: Record<string, string> = { repaid: 'repaid' };
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(catalogText(map, key), key).toBeUndefined();
    }
  });

  it('works through the translated copy proxy', () => {
    expect(catalogText(copy.activity.repairStatus, 'repaid')).toBe('repaid');
    expect(catalogText(copy.activity.repairStatus, '__proto__')).toBeUndefined();
    expect(catalogText(copy.activity.labels, 'LoanRepaid')).toBe('Loan repaid');
    expect(catalogText(copy.activity.labels, 'constructor')).toBeUndefined();
  });
});
