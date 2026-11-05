import { describe, expect, it } from 'vitest';
import { HEARTBEAT_GRACE, heartbeatDeadlineMs, invalidationsFor, openPushRail, parseFrame, pushRailUrl, reconnectDelayMs, stateAfterFrame, type PushFrame, type PushState } from './pushRail';

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
  it('narrows own reads to frames whose complete hints link every affected id to parties other than the account', () => {
    const other = { loanIds: [1], offerIds: [7], links: [{ loanId: 1, offerId: 7, lender: '0x' + '1'.repeat(40) }], truncated: false };
    expect(invalidationsFor(invalidate({ hints: other }), ME)).toEqual({ world: true, own: false });
    const mine = { ...other, links: [{ loanId: 1, offerId: 7, newBorrower: ME.toLowerCase() }] };
    expect(invalidationsFor(invalidate({ hints: mine }), ME)).toEqual({ world: true, own: true });
  });
  it('refetches own reads when an affected id carries no link, because its parties are unknown', () => {
    // A repayment or a default names the loan and nobody: it may be mine.
    expect(invalidationsFor(invalidate({ hints: { loanIds: [4], offerIds: [], links: [], truncated: false } }), ME)).toEqual({ world: true, own: true });
    expect(invalidationsFor(invalidate({ hints: { loanIds: [], offerIds: [9], links: [], truncated: false } }), ME)).toEqual({ world: true, own: true });
    // A linked creation beside an unlinked change: the unlinked one decides.
    const half = { loanIds: [1, 2], offerIds: [], links: [{ loanId: 1, lender: '0x' + '1'.repeat(40) }], truncated: false };
    expect(invalidationsFor(invalidate({ hints: half }), ME)).toEqual({ world: true, own: true });
  });
  it('refetches no own read for a complete hint set that names nothing', () => {
    expect(invalidationsFor(invalidate({ keys: ['activity.appended'], hints: { loanIds: [], offerIds: [], links: [], truncated: false } }), ME)).toEqual({ world: true, own: false });
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

describe('stateAfterFrame', () => {
  const hello = (over: Partial<Extract<PushFrame, { t: 'hello' }>>): PushFrame => ({
    t: 'hello',
    chainId: 84532,
    ingestActive: true,
    cursor: null,
    scanCadenceSec: 300,
    ...over,
  });
  const cursor: PushFrame = { t: 'cursor', chainId: 84532, lastBlock: '10', updatedAt: 1_000, scanCadenceSec: 300 };
  it('reads hello: scanned chains are live, others inactive', () => {
    expect(stateAfterFrame(hello({}), 'connecting', 2_000)).toBe('live');
    expect(stateAfterFrame(hello({ ingestActive: false, scanCadenceSec: null }), 'connecting', 2_000)).toBe('inactive');
  });
  it('reads a cursor already past the grace period at connect as a stall', () => {
    const stale = hello({ cursor: { lastBlock: 5, updatedAt: 1_000 } });
    expect(stateAfterFrame(stale, 'connecting', 1_000 + 300 * HEARTBEAT_GRACE)).toBe('live');
    expect(stateAfterFrame(stale, 'connecting', 1_001 + 300 * HEARTBEAT_GRACE)).toBe('stalled');
  });
  it('a heartbeat revives a stalled rail, leaves an inactive one, and an invalidate changes nothing', () => {
    expect(stateAfterFrame(cursor, 'stalled')).toBe('live');
    expect(stateAfterFrame(cursor, 'live')).toBe('live');
    expect(stateAfterFrame(cursor, 'inactive')).toBe('inactive');
    expect(stateAfterFrame({ t: 'invalidate', chainId: 84532, keys: ['loan.updated'], scannedTo: '1' }, 'stalled')).toBe('stalled');
  });
  it('allows two cadences before a stall', () => {
    expect(heartbeatDeadlineMs(300)).toBe(600_000);
    expect(heartbeatDeadlineMs(0)).toBe(HEARTBEAT_GRACE * 1000);
  });
});

describe('openPushRail', () => {
  /** A WebSocket stand-in the test drives by hand. */
  class FakeSocket {
    static last: FakeSocket | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      FakeSocket.last = this;
    }
    close() {
      this.closed = true;
    }
    frame(f: PushFrame) {
      this.onmessage?.({ data: JSON.stringify(f) });
    }
  }
  /** Manual timers: `fire(i)` runs the i-th scheduled callback. */
  const timers = () => {
    const queue: { id: number; fn: () => void; ms: number; cleared: boolean }[] = [];
    let next = 1;
    return {
      queue,
      setT: ((fn: () => void, ms: number) => {
        const id = next++;
        queue.push({ id, fn, ms, cleared: false });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearT: ((id: unknown) => {
        const t = queue.find((q) => q.id === id);
        if (t) t.cleared = true;
      }) as typeof clearTimeout,
      pending: () => queue.filter((q) => !q.cleared),
      /** Run the first pending timer, as the clock would. */
      fire: () => {
        const t = queue.find((q) => !q.cleared)!;
        t.cleared = true;
        t.fn();
      },
    };
  };
  const open = () => {
    const t = timers();
    const states: PushState[] = [];
    const frames: PushFrame[] = [];
    const handle = openPushRail({
      url: 'ws://x/ws/chain/84532',
      onFrame: (f) => frames.push(f),
      onState: (s) => states.push(s),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      setTimeoutImpl: t.setT,
      clearTimeoutImpl: t.clearT,
    });
    const ws = FakeSocket.last!;
    return { t, states, frames, handle, ws };
  };
  it('stays connecting on open until hello says the chain is scanned, then goes live and arms the heartbeat', () => {
    const { t, states, ws } = open();
    ws.onopen?.();
    expect(states).toEqual(['connecting']);
    ws.frame({ t: 'hello', chainId: 84532, ingestActive: true, cursor: null, scanCadenceSec: 300 });
    expect(states).toEqual(['connecting', 'live']);
    expect(t.pending().map((q) => q.ms)).toEqual([heartbeatDeadlineMs(300)]);
  });
  it('reads an inactive hello as inactive, with no heartbeat expected', () => {
    const { t, states, ws } = open();
    ws.onopen?.();
    ws.frame({ t: 'hello', chainId: 84532, ingestActive: false, cursor: null, scanCadenceSec: null });
    expect(states).toEqual(['connecting', 'inactive']);
    expect(t.pending()).toEqual([]);
  });
  it('turns stalled when the heartbeat is overdue and live again on the next cursor frame', () => {
    const { t, states, ws } = open();
    ws.onopen?.();
    ws.frame({ t: 'hello', chainId: 84532, ingestActive: true, cursor: null, scanCadenceSec: 300 });
    t.fire();
    expect(states.at(-1)).toBe('stalled');
    ws.frame({ t: 'cursor', chainId: 84532, lastBlock: '11', updatedAt: 1, scanCadenceSec: 300 });
    expect(states.at(-1)).toBe('live');
    expect(t.pending().map((q) => q.ms)).toEqual([heartbeatDeadlineMs(300)]);
  });
  it('a cursor frame re-arms the deadline instead of adding a second one', () => {
    const { t, ws } = open();
    ws.onopen?.();
    ws.frame({ t: 'hello', chainId: 84532, ingestActive: true, cursor: null, scanCadenceSec: 300 });
    ws.frame({ t: 'cursor', chainId: 84532, lastBlock: '11', updatedAt: 1, scanCadenceSec: 300 });
    expect(t.pending()).toHaveLength(1);
  });
  it('a drop clears the heartbeat, announces unavailable and schedules the reconnect', () => {
    const { t, states, ws } = open();
    ws.onopen?.();
    ws.frame({ t: 'hello', chainId: 84532, ingestActive: true, cursor: null, scanCadenceSec: 300 });
    ws.onclose?.();
    expect(states.at(-1)).toBe('unavailable');
    expect(t.pending().map((q) => q.ms)).toEqual([reconnectDelayMs(0)]);
  });
  it('close() cancels every timer and announces closed once', () => {
    const { t, states, handle, ws } = open();
    ws.onopen?.();
    ws.frame({ t: 'hello', chainId: 84532, ingestActive: true, cursor: null, scanCadenceSec: 300 });
    handle.close();
    handle.close();
    expect(ws.closed).toBe(true);
    expect(t.pending()).toEqual([]);
    expect(states.filter((s) => s === 'closed')).toHaveLength(1);
  });
});
