import { describe, expect, it, vi } from 'vitest';
import { fetchAllLoansForWallet } from '@vaipakam/defi-client';

describe('fetchAllLoansForWallet', () => {
  it('reads by-current-holder, not the removed by-wallet path', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      const url = String(_input);
      expect(url).toContain('/loans/by-current-holder/0xabc');
      expect(url).not.toContain('/loans/by-wallet/');
      return new Response(
        JSON.stringify({
          chainId: 84532,
          address: '0xabc',
          loans: [{ loanId: 3, status: 'active' }],
          nextBefore: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const loans = await fetchAllLoansForWallet('https://indexer.test', 84532, '0xAbC');
    expect(loans).toHaveLength(1);
    expect(loans[0]?.loanId).toBe(3);
  });
});