import { describe, expect, it } from 'vitest';
import { copyEntry } from '../copy/useCopy';
import { KEY_RISKS, MORE_RISKS, loanRiskKey, rentalRiskKey, settlementOf } from './keyRisks';

describe('key risks (#3661)', () => {
  it('settles by a sale only when both legs are liquid', () => {
    expect(settlementOf('liquid', 'liquid')).toBe('sale');
    expect(settlementOf('illiquid', 'liquid')).toBe('in-kind');
    expect(settlementOf('liquid', 'illiquid')).toBe('in-kind');
    // A distrusted leg never reaches a review; it never reads as a sale.
    expect(settlementOf('distrusted', 'liquid')).toBe('unknown');
  });
  it('gives each side and settlement its own line', () => {
    const keys = (['lender', 'borrower'] as const).flatMap((s) => (['sale', 'in-kind', 'unknown'] as const).map((t) => loanRiskKey(s, t)));
    expect(new Set(keys).size).toBe(6);
    expect(loanRiskKey('lender', 'in-kind')).toBe('keyRisks.lenderInKind');
    expect(loanRiskKey('borrower', 'sale')).toBe('keyRisks.borrowerSale');
    expect(rentalRiskKey('owner')).not.toBe(rentalRiskKey('renter'));
  });
  it('states the owner-approved short list in its order, and the further points', () => {
    expect(KEY_RISKS).toHaveLength(6);
    expect(copyEntry(KEY_RISKS[0]!).text).toMatch(/^You can lose some or all of your funds/);
    expect(copyEntry('keyRisks.lend').text).toContain('If it cannot be sold, you receive the collateral itself');
    // Terms version 4 (owner decision 2026-11-19): the lending line states
    // the lock-up first, and the list stays at six.
    expect(copyEntry('keyRisks.lend').text).toMatch(/^If you lend: your funds stay in the loan until the borrower repays, and you cannot withdraw them before that\./);
    expect(MORE_RISKS.map((k) => copyEntry(k).text).join(' ')).toContain('Tax on what you do here is your own responsibility');
  });
});
