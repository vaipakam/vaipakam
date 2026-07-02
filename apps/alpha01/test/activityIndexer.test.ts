import { describe, expect, it, vi } from 'vitest';
import { fetchActivity } from '@vaipakam/defi-client';

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