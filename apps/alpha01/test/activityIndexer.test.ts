import { describe, expect, it, vi } from 'vitest';
import {
  fetchActivity,
  fetchWalletActivity,
  mergeWalletActivityEvents,
  type IndexedActivityEvent,
} from '@vaipakam/defi-client';

function event(
  kind: string,
  blockNumber: number,
  logIndex: number,
  overrides: Partial<IndexedActivityEvent> = {},
): IndexedActivityEvent {
  return {
    chainId: 84532,
    blockNumber,
    logIndex,
    txHash: `0x${String(blockNumber).padStart(64, '0')}`,
    kind,
    loanId: null,
    offerId: null,
    actor: '0xabc',
    args: {},
    blockAt: blockNumber,
    ...overrides,
  };
}

describe('mergeWalletActivityEvents', () => {
  it('keeps every actor row even when participant events are newer', () => {
    const actorEvents = [event('OfferCreated', 1, 0), event('OfferCanceled', 2, 0)];
    const participantEvents = [
      event('LoanInitiated', 99, 1, { actor: '0xdef' }),
      event('OfferAccepted', 98, 1, { actor: '0xdef' }),
    ];
    const tight = mergeWalletActivityEvents(actorEvents, participantEvents, 2);
    expect(tight.map((e) => e.kind)).toEqual(['LoanInitiated', 'OfferCreated']);
    const roomy = mergeWalletActivityEvents(actorEvents, participantEvents, 4);
    expect(roomy.map((e) => e.kind)).toEqual([
      'LoanInitiated',
      'OfferAccepted',
      'OfferCanceled',
      'OfferCreated',
    ]);
  });
});

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
      if (url.includes('/loans/by-borrower/') || url.includes('/loans/by-current-holder/')) {
        return new Response(
          JSON.stringify({ chainId: 84532, side: 'borrower', address: '0xabc', loans: [], nextBefore: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/offers/by-creator/') || url.includes('/offers/by-current-holder/')) {
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