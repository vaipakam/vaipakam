import { describe, expect, it, vi } from 'vitest';
import { fetchActivity, fetchWalletActivity } from '@vaipakam/defi-client';

describe('fetchActivity', () => {
  it('queries the indexer activity endpoint with actor filter', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      const url = String(_input);
      expect(url).toContain('/activity?');
      expect(url).toContain('actor=0xabc');
      return new Response(
        JSON.stringify({
          chainId: 84532,
          events: [{ kind: 'OfferCreated', txHash: '0x' + 'a'.repeat(64), blockNumber: 1, logIndex: 0 }],
          nextBefore: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchActivity('https://indexer.test', 84532, { actor: '0xAbC', limit: 10 });
    expect(page?.events).toHaveLength(1);
    expect(page?.events[0]?.kind).toBe('OfferCreated');
  });
});

describe('fetchWalletActivity', () => {
  it('merges participant loan timelines into the first actor page', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/loans/by-lender/')) {
        return new Response(
          JSON.stringify({ chainId: 84532, side: 'lender', address: '0xabc', loans: [{ loanId: 7 }], nextBefore: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/loans/by-borrower/')) {
        return new Response(
          JSON.stringify({ chainId: 84532, side: 'borrower', address: '0xabc', loans: [], nextBefore: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/offers/by-creator/')) {
        return new Response(
          JSON.stringify({ chainId: 84532, creator: '0xabc', offers: [], nextBefore: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('loanId=7')) {
        return new Response(
          JSON.stringify({
            chainId: 84532,
            events: [
              {
                kind: 'LoanInitiated',
                txHash: '0x' + 'b'.repeat(64),
                blockNumber: 99,
                logIndex: 1,
                loanId: 7,
                offerId: null,
                actor: '0xdef',
                blockAt: 1,
                args: {},
              },
            ],
            nextBefore: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('actor=0xabc')) {
        return new Response(
          JSON.stringify({
            chainId: 84532,
            events: [
              {
                kind: 'OfferCreated',
                txHash: '0x' + 'a'.repeat(64),
                blockNumber: 1,
                logIndex: 0,
                loanId: null,
                offerId: 1,
                actor: '0xabc',
                blockAt: 1,
                args: {},
              },
            ],
            nextBefore: '1:0',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchWalletActivity('https://indexer.test', 84532, '0xAbC', { limit: 10 });
    expect(page?.events.map((e) => e.kind)).toEqual(['LoanInitiated', 'OfferCreated']);
  });
});