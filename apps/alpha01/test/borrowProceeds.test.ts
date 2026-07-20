import { LOAN_INITIATION_FEE_BPS, netBorrowProceedsWei } from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

describe('netBorrowProceedsWei', () => {
  it('deducts the default 0.2% LIF from principal', () => {
    expect(LOAN_INITIATION_FEE_BPS).toBe(20n);
    expect(netBorrowProceedsWei(1_000_000n)).toBe(998_000n);
  });

  it('accepts a live governance fee override', () => {
    expect(netBorrowProceedsWei(1_000_000n, 25n)).toBe(997_500n);
  });
});