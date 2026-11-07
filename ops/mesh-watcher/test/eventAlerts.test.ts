/**
 * The event-alert pass (#3239 item 3, #3237): what it reads, what it says,
 * and — the part that decides whether an event can be lost — where its
 * position moves after delivery.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { deliverFindings } from '../src/deliver';
import { eventCursorWrites, scanEvents, type EventClient, type EventScanInput } from '../src/eventAlerts';
import type { Finding } from '../src/finding';
import type { AlertStore, StoreOp } from '../src/store';

const LIST: Address = '0x75b29Eaa25dfdaB6477892e59985d4771f5B2FC5';
const TIMELOCK: Address = '0x0961D007449Eab9a37f5020742e5f1EE4791D6b1';
const DIAMOND: Address = '0x63816B149266C9dBFB7683dfd02D851915238049';
const TX = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

interface FakeLog {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

function fakeClient(opts: {
  finalized?: bigint | Error;
  logs?: FakeLog[];
  failLogsFor?: Address;
  ready?: bigint[] | Error;
}) {
  const calls: { address: Address; fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    async getBlock() {
      if (opts.finalized instanceof Error) throw opts.finalized;
      return { number: opts.finalized ?? 1_000_000n };
    },
    async getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }) {
      calls.push({ address: args.address, fromBlock: args.fromBlock, toBlock: args.toBlock });
      if (opts.failLogsFor === args.address) throw new Error('HTTP 429 https://rpc.example/KEY too many requests');
      return (opts.logs ?? []).filter(
        (l) => l.address === args.address && l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock,
      );
    },
    async multicall() {
      if (opts.ready instanceof Error) throw opts.ready;
      return (opts.ready ?? []).map((r) => ({ status: 'success', result: r }));
    },
  };
  return { client: client as unknown as EventClient, calls };
}

function input(over: Partial<EventScanInput> & { client: EventClient }): EventScanInput {
  return {
    chainId: 84532,
    addresses: { sanctionsList: LIST, timelock: TIMELOCK },
    deployBlock: 900_000n,
    cursors: new Map(),
    logRange: 5_000n,
    initialLookback: 20_000n,
    labels: new Map([[DIAMOND.toLowerCase(), 'diamond']]),
    ...over,
  };
}

const listUpdated = (block: bigint, logIndex = 0): FakeLog => ({
  address: LIST,
  eventName: 'ListUpdated',
  args: {
    version: 4n,
    sourceHash: `0x${'ab'.repeat(32)}`,
    sourcePublicationDate: 20261106,
    added: 3n,
    removed: 0n,
    listedCount: 41n,
    updater: '0x1111111111111111111111111111111111111111',
  },
  blockNumber: block,
  transactionHash: TX(Number(block)),
  logIndex,
});

describe('scanEvents', () => {
  it('starts a first scan at the look-back, says so, and pages a listing with its count and hash', async () => {
    const { client, calls } = fakeClient({ logs: [listUpdated(995_000n)] });
    const scan = await scanEvents(input({ client }));

    // 1_000_000 - 20_000 is after the deploy block, so the look-back wins.
    expect(calls.find((c) => c.address === LIST)).toMatchObject({ fromBlock: 980_000n, toBlock: 984_999n });
    expect(scan.backlogBlocks).toBe(30_002n);
    expect(scan.gap).toBeNull();

    const notices = scan.findings.filter((f) => f.code === 'event-alert-start');
    expect(notices).toHaveLength(2);
    expect(notices[0]!.detail).toContain('Events BEFORE block 980000 are NOT reported');
    // The listing at 995_000 is past this tick's range; it is read later.
    expect(scan.findings.filter((f) => f.code === 'event-alert')).toHaveLength(0);
  });

  it('reads from the stored position, caps the range, and renders the listing', async () => {
    const { client } = fakeClient({ logs: [listUpdated(995_000n)] });
    const scan = await scanEvents(
      input({ client, cursors: new Map([['sanctionsList', 994_000n], ['timelock', 999_000n]]) }),
    );
    const alert = scan.findings.find((f) => f.code === 'event-alert')!;
    expect(alert.severity).toBe('critical');
    expect(alert.title).toBe('Sanctions list updated');
    expect(alert.detail).toContain('added = 3');
    expect(alert.detail).toContain(`sourceHash = 0x${'ab'.repeat(32)}`);
    expect(alert.detail).toContain('listedCount = 41');
    expect(scan.findings.some((f) => f.code === 'event-alert-start')).toBe(false);
    expect(scan.scans.map((s) => [s.contract, s.from, s.to])).toEqual([
      ['sanctionsList', 994_000n, 998_999n],
      ['timelock', 999_000n, 1_000_000n],
    ]);
  });

  it('starts at the deploy block when that is inside the look-back', async () => {
    const { client, calls } = fakeClient({});
    const scan = await scanEvents(input({ client, deployBlock: 990_000n }));
    expect(calls[0]!.fromBlock).toBe(990_000n);
    expect(scan.findings[0]!.detail).toContain('the deploy block, so every event since deployment is covered');
  });

  it('shows what a queued timelock call targets and when it can execute', async () => {
    const id = `0x${'cd'.repeat(32)}` as Hex;
    const { client } = fakeClient({
      logs: [
        {
          address: TIMELOCK,
          eventName: 'CallScheduled',
          args: {
            id,
            index: 0n,
            target: DIAMOND,
            value: 0n,
            data: '0x12345678deadbeef',
            predecessor: `0x${'0'.repeat(64)}`,
            delay: 172_800n,
          },
          blockNumber: 999_500n,
          transactionHash: TX(1),
          logIndex: 2,
        },
      ],
      ready: [1_800_000_000n],
    });
    const scan = await scanEvents(input({ client, cursors: new Map([['timelock', 999_000n]]) }));
    const alert = scan.findings.find((f) => f.code === 'event-alert')!;
    expect(alert.severity).toBe('critical');
    expect(alert.detail).toContain(`target = ${DIAMOND} (diamond)`);
    expect(alert.detail).toContain('function selector 0x12345678, 8 bytes of calldata');
    expect(alert.detail).toContain('delay = 172800 s (48.0 h)');
    expect(alert.detail).toContain(`executable from: ${new Date(1_800_000_000_000).toISOString()}`);
  });

  it('says the ready time is unknown when the timelock read fails, rather than leaving it out', async () => {
    const { client } = fakeClient({
      logs: [
        {
          address: TIMELOCK,
          eventName: 'CallScheduled',
          args: { id: `0x${'cd'.repeat(32)}`, index: 0n, target: DIAMOND, value: 0n, data: '0x', predecessor: '0x', delay: 1n },
          blockNumber: 999_500n,
          transactionHash: TX(1),
          logIndex: 0,
        },
      ],
      ready: new Error('multicall failed'),
    });
    const scan = await scanEvents(input({ client, cursors: new Map([['timelock', 999_000n]]) }));
    expect(scan.findings.find((f) => f.code === 'event-alert')!.detail).toContain('executable from: UNKNOWN');
  });

  it('reports a failed log read as a gap, without the provider URL, and leaves that contract unscanned', async () => {
    const { client } = fakeClient({ failLogsFor: LIST });
    const scan = await scanEvents(input({ client, cursors: new Map([['sanctionsList', 1n], ['timelock', 1n]]) }));
    expect(scan.gap?.source).toBe('event-logs');
    expect(scan.gap?.detail).toContain('Sanctions list');
    expect(scan.gap?.detail).not.toContain('rpc.example');
    expect(scan.gap?.detail).not.toContain('KEY');
    expect(scan.scans.map((s) => s.contract)).toEqual(['timelock']);
  });

  it('reports an unreadable finalized block as a gap and reads nothing', async () => {
    const { client, calls } = fakeClient({ finalized: new Error('finalized tag not supported') });
    const scan = await scanEvents(input({ client }));
    expect(scan.gap?.source).toBe('event-logs');
    expect(calls).toHaveLength(0);
    expect(scan.findings).toEqual([]);
  });

  it('reads nothing on a chain that carries none of the watched contracts', async () => {
    const { client, calls } = fakeClient({});
    const scan = await scanEvents(input({ client, addresses: {} }));
    expect(calls).toHaveLength(0);
    expect(scan).toMatchObject({ findings: [], scans: [], gap: null });
  });
});

describe('eventCursorWrites — nothing is skipped', () => {
  async function scanned() {
    const { client } = fakeClient({ logs: [listUpdated(995_100n, 0), listUpdated(995_300n, 1)] });
    return scanEvents(input({ client, cursors: new Map([['sanctionsList', 995_000n]]), addresses: { sanctionsList: LIST } }));
  }
  const nextOf = (ops: StoreOp[]) => ops.map((o) => (o.kind === 'setEventCursor' ? o.nextBlock : null));

  it('moves past the range when every event was delivered', async () => {
    const scan = await scanned();
    const all = new Set(scan.findings.map((f) => f.key));
    expect(nextOf(eventCursorWrites(84532, scan, all, 0))).toEqual([999_999n + 1n]);
  });

  it('stops at the earliest undelivered event, so it is read and sent again', async () => {
    const scan = await scanned();
    const keys = scan.findings.map((f) => f.key);
    expect(nextOf(eventCursorWrites(84532, scan, new Set([keys[1]!]), 0))).toEqual([995_100n]);
    expect(nextOf(eventCursorWrites(84532, scan, new Set(), 0))).toEqual([995_100n]);
  });

  it('writes no position for a first scan whose start notice did not arrive', async () => {
    const { client } = fakeClient({});
    const scan = await scanEvents(input({ client, addresses: { sanctionsList: LIST } }));
    expect(eventCursorWrites(84532, scan, new Set(), 0)).toEqual([]);
    expect(eventCursorWrites(84532, scan, new Set([scan.scans[0]!.startNoticeKey!]), 0)).toHaveLength(1);
  });
});

describe('deliverFindings — which alerts count as delivered', () => {
  afterEach(() => vi.unstubAllGlobals());

  const f = (key: string): Finding => ({
    key,
    fingerprint: key,
    code: 'event-alert',
    variant: key,
    severity: 'critical',
    chainId: 84532,
    title: key,
    detail: key,
  });

  function store(alreadySent: string[]): AlertStore {
    return {
      selectDue: async (c: { key: string }[]) => ({ ok: true, value: c.filter((x) => !alreadySent.includes(x.key)) }),
      commit: async () => ({ ok: true, value: undefined }),
    } as unknown as AlertStore;
  }

  const request = (s: AlertStore, telegram: { token: string; chatId: string } | null) => ({
    store: s,
    telegram,
    findings: [f('a'), f('b')],
    repeatSeconds: 3600,
    now: 0,
    dedupAvailable: true,
    writes: [],
    probeText: null,
    // Far apart so each lands in its own message.
    format: (x: Finding) => x.key.repeat(3000),
  });

  it('counts sent and already-sent alerts, never refused ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) =>
        new Response('{}', { status: init.body.includes('bbb') ? 500 : 200 }),
      ),
    );
    const report = await deliverFindings(request(store([]), { token: 't', chatId: '1' }));
    expect([...report.delivered]).toEqual(['a']);
  });

  it('counts an alert suppressed as already sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const report = await deliverFindings(request(store(['b']), { token: 't', chatId: '1' }));
    expect([...report.delivered].sort()).toEqual(['a', 'b']);
  });

  it('counts nothing when no destination is configured', async () => {
    const report = await deliverFindings(request(store([]), null));
    expect(report.delivered.size).toBe(0);
  });
});
