import { describe, expect, it } from 'vitest';
import { invalidationsFor, parseFrame, pushRailUrl, reconnectDelayMs, type PushFrame } from './pushRail';

const ME = '0x000000000000000000000000000000000000aBcD' as const;

describe('pushRailUrl', () => {
  it('derives the socket URL from the indexer origin', () => {
    expect(pushRailUrl('https://indexer.vaipakam.com', 84532)).toBe('wss://indexer.vaipakam.com/ws/chain/84532');
    expect(pushRailUrl('http://127.0.0.1:8788', 84532)).toBe('ws://127.0.0.1:8788/ws/chain/84532');
    expect(pushRailUrl(null, 84532)).toBeNull();
  });
});

describe('invalidationsFor', () => {
  const invalidate = (over: Partial<Extract<PushFrame, { t: 'invalidate' }>>): PushFrame => ({
    t: 'invalidate',
    chainId: 84532,
    keys: ['loan.updated'],
    scannedTo: '100',
    ...over,
  });
  it('refetches nothing on a frame that is not an invalidation', () => {
    expect(invalidationsFor({ t: 'cursor', chainId: 1, lastBlock: '1', updatedAt: 1, scanCadenceSec: 300 }, ME)).toEqual({ world: false, own: false });
    expect(invalidationsFor(invalidate({ keys: [] }), ME)).toEqual({ world: false, own: false });
  });
  it('treats absent or truncated hints as the coarse key: own reads refetch too', () => {
    expect(invalidationsFor(invalidate({}), ME)).toEqual({ world: true, own: true });
    expect(invalidationsFor(invalidate({ hints: { loanIds: [1], offerIds: [], links: [], truncated: true } }), ME)).toEqual({ world: true, own: true });
  });
  it('narrows own reads to frames whose complete hints name the account, in any party slot', () => {
    const other = { loanIds: [1], offerIds: [], links: [{ loanId: 1, lender: '0x' + '1'.repeat(40) }], truncated: false };
    expect(invalidationsFor(invalidate({ hints: other }), ME)).toEqual({ world: true, own: false });
    const mine = { ...other, links: [{ loanId: 1, newBorrower: ME.toLowerCase() }] };
    expect(invalidationsFor(invalidate({ hints: mine }), ME)).toEqual({ world: true, own: true });
  });
  it('has no own reads to refetch without a connected account', () => {
    expect(invalidationsFor(invalidate({}), null)).toEqual({ world: true, own: false });
  });
});

describe('parseFrame', () => {
  it('accepts the three known frames and ignores anything else', () => {
    expect(parseFrame(JSON.stringify({ t: 'hello', chainId: 1, ingestActive: true, cursor: null, scanCadenceSec: 300 }))?.t).toBe('hello');
    expect(parseFrame(JSON.stringify({ t: 'later-kind' }))).toBeNull();
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame(new ArrayBuffer(2))).toBeNull();
  });
});

describe('reconnectDelayMs', () => {
  it('doubles from a second and caps at a minute', () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(3)).toBe(8_000);
    expect(reconnectDelayMs(20)).toBe(60_000);
  });
});
