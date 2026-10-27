/**
 * #2760 — the remit pass names a finalized day that is still owed and says
 * why, from the send's own verdict, and stays quiet about a day that owed the
 * mirror nothing.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REMIT_DAY_STATUSES,
  owedButBlocked,
  remitDayStatusName,
  remitStatusReadFailure,
} from '../src/remitDayStatus';
import { remitToMirror, resolvePartCap } from '../src/rewardBudgetRemit';

// #918 moved the enum to the day ledger library, beside the plan it reports.
const FACET_SRC = new URL('../../../contracts/src/libraries/LibRemitDayLedger.sol', import.meta.url);

describe('#2760 remit day statuses', () => {
  it('names the statuses in the contract enum order', () => {
    const src = readFileSync(FACET_SRC, 'utf8');
    const body = /enum RemitDayStatus \{([^}]*)\}/.exec(src)?.[1];
    expect(body, 'the enum is declared in the day ledger library').toBeDefined();
    const members = body!
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    expect(members).toEqual([...REMIT_DAY_STATUSES]);
  });

  it('decodes a uint8 and refuses a value it cannot name', () => {
    expect(remitDayStatusName(0)).toBe('NotFinalized');
    expect(remitDayStatusName(8n)).toBe('Closeable');
    expect(remitDayStatusName(9)).toBe('Partial');
    expect(remitDayStatusName(10)).toBeUndefined();
    expect(remitDayStatusName('x')).toBeUndefined();
  });

  it('reports only the days still owed, each with its reason', () => {
    const days = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];
    const blocked = owedButBlocked(days, [
      'Remitted',
      'Closed',
      'NothingOwed',
      'Closeable',
      'AwaitingCommitment',
      'Unbacked',
      'Ineligible',
      'Repeated',
    ]);
    expect(blocked.map((b) => [b.day, b.status])).toEqual([
      [5n, 'AwaitingCommitment'],
      [6n, 'Unbacked'],
      [7n, 'Ineligible'],
    ]);
    expect(blocked.every((b) => b.reason.length > 0)).toBe(true);
  });

  it('a Partial day is acted on, not blocked (#918)', () => {
    expect(owedButBlocked([1n], ['Partial'])).toEqual([]);
  });

  it('a day that owed this mirror nothing is never reported', () => {
    expect(owedButBlocked([1n, 2n], ['NothingOwed', 'NothingOwed'])).toEqual([]);
  });

  it('only the Diamond saying it routes no such view counts as an older build', () => {
    expect(remitStatusReadFailure({ revert: { name: 'FunctionDoesNotExist' } }).kind).toBe('unrouted');
    expect(remitStatusReadFailure({ data: '0xa9ad62f8' }).kind).toBe('unrouted');
    expect(remitStatusReadFailure(new Error('fetch failed')).kind).toBe('unread');
  });
});

describe('#2760 the plan and the statuses are one block (Codex #2826 r3)', () => {
  /** A chain whose commitment report lands right after block 100: at 100 the
   *  day is awaiting it (plan: zero, not closeable); at any later head its
   *  status reads closeable. An unpinned plan read comes first and sees the
   *  old state, so only a read pinned to block 100 keeps the two agreeing. */
  function fakeChain() {
    const blocks: (bigint | undefined)[] = [];
    const client = {
      getBlockNumber: async () => 100n,
      readContract: async (req: { functionName: string; blockNumber?: bigint }) => {
        blocks.push(req.blockNumber);
        const pinned = req.blockNumber === 100n;
        if (req.functionName === 'getRemitLaneBucket') return [true, false, 0n, 0n];
        if (req.functionName === 'quoteRemitDayPlans') return [[0n], [false]];
        if (req.functionName === 'quoteRemitDayStatuses') return [pinned ? 6 : 8]; // AwaitingCommitment : Closeable
        throw new Error(`unexpected read ${req.functionName}`);
      },
    };
    return { client, blocks };
  }

  it('a day closeable only at a later head is still owed, not settled', async () => {
    const { client, blocks } = fakeChain();
    const settled = await remitToMirror(
      client as never,
      {} as never,
      '0x0000000000000000000000000000000000000001',
      421614,
      5n,
      1,
      10n ** 24n,
      0n,
    );
    expect(settled).toBe(false);
    expect(blocks).toEqual([100n, 100n, 100n]);
  });
});

describe('#918 a day is sent in parts', () => {
  const DIAMOND = '0x0000000000000000000000000000000000000001';
  const ONE = 10n ** 18n;

  /** One owed day of 30 VPFI against a lane bucket holding `tokens`. The chain
   *  plans every part under the cap it is asked about, as the facet does. */
  function partsChain(tokens: bigint, opts: { statuses?: boolean } = {}) {
    const owed = 30n * ONE;
    const calls: { fn: string; args: unknown[] }[] = [];
    const client = {
      getBlockNumber: async () => 100n,
      readContract: async (req: { functionName: string; args: unknown[] }) => {
        calls.push({ fn: req.functionName, args: req.args });
        const cap = req.args[2] as bigint;
        if (req.functionName === 'getRemitLaneBucket') return [true, true, tokens, 50n * ONE];
        if (req.functionName === 'quoteRemitDayPlans') return [[owed < cap ? owed : cap], [true]];
        if (req.functionName === 'quoteRemitDayStatuses') {
          if (opts.statuses === false) throw { revert: { name: 'FunctionDoesNotExist' } };
          return [owed <= cap ? 8 : 9];
        }
        if (req.functionName === 'quoteRemittanceFee') return [7n, owed < cap ? owed : cap];
        if (req.functionName === 'getDayClosedByRemitId') return 0n;
        throw new Error(`unexpected read ${req.functionName}`);
      },
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    };
    const writes: unknown[][] = [];
    const ctx = {
      wallet: {
        account: { address: DIAMOND },
        writeContract: async (req: { args: unknown[] }) => {
          writes.push(req.args);
          return '0xabc';
        },
      },
    };
    return { client, ctx, calls, writes };
  }

  it('sizes the part to the live bucket and reports the day still owed', async () => {
    const { client, ctx, calls, writes } = partsChain(12n * ONE);
    const settled = await remitToMirror(client as never, ctx as never, DIAMOND, 421614, 6n, 1, 50n * ONE, 0n);
    expect(settled).toBe(false); // a part went; the day still owes the rest
    expect(writes).toEqual([[421614, [5n], 12n * ONE]]);
    // The plan, the statuses and the fee quote are all asked about the SAME cap.
    for (const fn of ['quoteRemitDayPlans', 'quoteRemitDayStatuses', 'quoteRemittanceFee']) {
      expect(calls.find((c) => c.fn === fn)?.args[2]).toBe(12n * ONE);
    }
  });

  it('settles when the last part completes the day', async () => {
    const { client, ctx, writes } = partsChain(40n * ONE);
    const settled = await remitToMirror(client as never, ctx as never, DIAMOND, 421614, 6n, 1, 50n * ONE, 0n);
    expect(settled).toBe(true);
    expect(writes).toEqual([[421614, [5n], 40n * ONE]]);
  });

  it('sends nothing when the bucket is empty', async () => {
    const { client, ctx, writes } = partsChain(0n);
    const settled = await remitToMirror(client as never, ctx as never, DIAMOND, 421614, 6n, 1, 50n * ONE, 0n);
    expect(settled).toBe(false);
    expect(writes).toEqual([]);
  });

  it('without statuses, a part that fills the cap is not taken as settling the day', async () => {
    const { client, ctx, writes } = partsChain(30n * ONE, { statuses: false });
    const settled = await remitToMirror(client as never, ctx as never, DIAMOND, 421614, 6n, 1, 50n * ONE, 0n);
    expect(writes).toEqual([[421614, [5n], 30n * ONE]]);
    expect(settled).toBe(false); // unknown whether it completed: reported unsettled
  });
});

describe('#918 resolvePartCap', () => {
  const CAP = 50n;
  it('uses the smaller of the ceiling and the live tokens on a limited lane', () => {
    expect(resolvePartCap(CAP, { readable: true, limited: true, tokens: 20n, capacity: 50n }).partCap).toBe(20n);
    expect(resolvePartCap(CAP, { readable: true, limited: true, tokens: 90n, capacity: 100n }).partCap).toBe(50n);
  });
  it('uses the ceiling on an unlimited lane, silently', () => {
    expect(resolvePartCap(CAP, { readable: true, limited: false, tokens: 0n, capacity: 0n })).toEqual({ partCap: 50n });
  });
  it('states what it could not read', () => {
    expect(resolvePartCap(CAP, undefined).note).toMatch(/unreadable/);
    expect(resolvePartCap(CAP, { readable: false, limited: false, tokens: 0n, capacity: 0n }).note).toMatch(/not resolvable/);
  });
});
