/**
 * #3411 — the pending lane is read strictly: anything other than a well-formed
 * lane for the chain asked about is NOT KNOWN (`null`), never an empty list.
 */
import { describe, expect, it } from 'vitest';
import { readPendingActivity } from './indexer';

const CHAIN = 84532;
const event = (over: Record<string, unknown> = {}) => ({
  chainId: CHAIN,
  blockNumber: 120,
  logIndex: 0,
  blockHash: '0xabc',
  txHash: '0xt',
  kind: 'OfferCreated',
  loanId: null,
  offerId: 7,
  actor: '0x1',
  args: {},
  blockAt: null,
  final: false,
  ...over,
});

describe('readPendingActivity', () => {
  it('reads a well-formed lane, every event pending with no stated time', () => {
    const lane = readPendingActivity({ events: [event()], complete: true }, CHAIN);
    expect(lane?.complete).toBe(true);
    expect(lane?.events).toHaveLength(1);
    expect(lane?.events[0]).toMatchObject({ final: false, blockAt: null, offerId: 7 });
  });

  it('keeps an empty lane as empty, and an incomplete one as incomplete', () => {
    expect(readPendingActivity({ events: [], complete: true }, CHAIN)).toEqual({ events: [], complete: true });
    expect(readPendingActivity({ events: [], complete: false }, CHAIN)?.complete).toBe(false);
  });

  it('treats null, absent and malformed as not known', () => {
    expect(readPendingActivity(null, CHAIN)).toBeNull();
    expect(readPendingActivity(undefined, CHAIN)).toBeNull();
    expect(readPendingActivity({ events: 'x', complete: true }, CHAIN)).toBeNull();
    expect(readPendingActivity({ events: [] }, CHAIN)).toBeNull();
  });

  it('refuses a lane carrying another chain\'s event, or an event not marked pending', () => {
    expect(readPendingActivity({ events: [event({ chainId: 1 })], complete: true }, CHAIN)).toBeNull();
    expect(readPendingActivity({ events: [event({ final: true })], complete: true }, CHAIN)).toBeNull();
    expect(readPendingActivity({ events: [event({ final: undefined })], complete: true }, CHAIN)).toBeNull();
  });
});
