import { LOAN_INITIATION_FEE_BPS, netBorrowProceedsWei } from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

describe('netBorrowProceedsWei', () => {
  it('deducts the default 0.1% LIF from principal', () => {
    expect(LOAN_INITIATION_FEE_BPS).toBe(10n);
    expect(netBorrowProceedsWei(1_000_000n)).toBe(999_000n);
  });
});