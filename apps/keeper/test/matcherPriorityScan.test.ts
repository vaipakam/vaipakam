/**
 * #2564 — a capacity refusal ends ordinary intents for the rest of the pass,
 * never the pass: the intent pass keeps scanning for intents a priority credit
 * unlocks (#2550), reading the same predicate the fill uses, and fails closed on
 * a Diamond without the getter.
 */
import { describe, expect, it, vi } from 'vitest';
import { intentRefusalScope, priorityState, receiptSpentPriorityCredit, runIntentFillPass } from '../src/matcher';
import { encodeEventTopics, encodeAbiParameters } from 'viem';

const SOLVER = '0x00000000000000000000000000000000000000aa';
const DIAMOND = '0x00000000000000000000000000000000000000d1';
const LEND = '0x00000000000000000000000000000000000000c1';
const COLL = '0x00000000000000000000000000000000000000c2';
const owner = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

const OK = 0;
const CAPACITY = 22;

function intentRow(o: `0x${string}`) {
  return {
    owner: o, lendingAsset: LEND, collateralAsset: COLL, maxExposure: 10n ** 24n, minRateBps: 0n,
    maxInitLtvBps: 8000, maxDurationDays: 365, minFillAmount: 1n, requiresKeeperAuth: false,
    livePrincipal: 0n, availableCapital: 10n ** 24n,
  };
}

function borrower(id: bigint) {
  return {
    id, creator: owner(0xbb00 + Number(id)), offerType: 1, accepted: false, assetType: 0, collateralAssetType: 0,
    lendingAsset: LEND, collateralAsset: COLL, durationDays: 30n, amount: 100n, amountMax: 100n, amountFilled: 0n,
    interestRateBpsMax: 1000n, fillMode: 0, useFullTermInterest: true, allowsPartialRepay: false,
  };
}

/** A fake chain: `preview[owner]` is the intent's preview verdict (0 ok, 22
 *  capacity); `unlocks[owner]` its creditUnlocks; `getter` false = the Diamond
 *  has no priority getter. */
function fakeCtx(opts: {
  intents: `0x${string}`[];
  preview: Record<string, number>;
  unlocks?: Record<string, boolean>;
  /** Owners for which the capacity covers the fill again (it refilled). */
  covers?: Record<string, boolean>;
  /** Owners whose mined fill carries `IntentPriorityFill`. */
  creditLog?: Record<string, boolean>;
  getter?: boolean;
}) {
  const calls = { previews: [] as string[], priority: [] as string[], fills: [] as string[] };
  const client = {
    readContract: vi.fn(async (req: { functionName: string; args: readonly unknown[] }) => {
      switch (req.functionName) {
        case 'keepersPaused':
          return false;
        case 'getActiveLenderIntents':
          return [opts.intents.map(intentRow), BigInt(opts.intents.length)];
        case 'previewIntent': {
          const o = String(req.args[2]).toLowerCase();
          calls.previews.push(o);
          const e = opts.preview[o] ?? OK;
          return {
            ok: e === OK, intentError: e, matchError: 0, riskBlock: 0,
            matchAmount: 100n, matchRateBps: 500n, reqCollateral: 1n, availableCapital: 10n ** 24n,
          };
        }
        case 'getLenderIntentPriority': {
          const o = String(req.args[0]).toLowerCase();
          calls.priority.push(o);
          if (opts.getter === false) throw new Error('reverted: FunctionDoesNotExist()');
          const covers = opts.covers?.[o] ?? false;
          return [true, 1n, covers, !covers && (opts.unlocks?.[o] ?? false)];
        }
        default:
          throw new Error(`unexpected read ${req.functionName}`);
      }
    }),
    waitForTransactionReceipt: vi.fn(async () => {
      const o = calls.fills[calls.fills.length - 1];
      return { status: 'success', logs: opts.creditLog?.[o] ? [priorityFillLog(o)] : [] };
    }),
  };
  const wallet = {
    account: { address: SOLVER, type: 'local' },
    chain: undefined,
    writeContract: vi.fn(async (req: { args: readonly unknown[] }) => {
      calls.fills.push(String(req.args[0]).toLowerCase());
      return `0x${'ab'.repeat(32)}`;
    }),
  };
  return { ctx: { client, wallet, diamond: DIAMOND, chainId: 84532 } as never, calls };
}

const PRIORITY_FILL_EVENT = {
  type: 'event', name: 'IntentPriorityFill', anonymous: false,
  inputs: [
    { name: 'owner', type: 'address', indexed: true }, { name: 'lendingAsset', type: 'address', indexed: true },
    { name: 'collateralAsset', type: 'address', indexed: true }, { name: 'loanId', type: 'uint256', indexed: false },
    { name: 'solver', type: 'address', indexed: false }, { name: 'creditsLeft', type: 'uint256', indexed: false },
  ],
} as const;
function priorityFillLog(o: string) {
  return {
    address: DIAMOND,
    topics: encodeEventTopics({ abi: [PRIORITY_FILL_EVENT], eventName: 'IntentPriorityFill', args: { owner: o as `0x${string}`, lendingAsset: LEND, collateralAsset: COLL } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [1n, SOLVER, 0n]),
  };
}

async function run(c: ReturnType<typeof fakeCtx>, borrowers: number, capacitySpentAtStart = false, minute = 0) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const now = vi.spyOn(Date, 'now').mockReturnValue(minute * 60_000);
  try {
    const book = Array.from({ length: borrowers }, (_, i) => borrower(BigInt(i + 1)));
    return await runIntentFillPass(c.ctx, book as never, () => false, 0, 0, new Set(), capacitySpentAtStart);
  } finally {
    now.mockRestore();
    log.mockRestore();
  }
}

describe('intentRefusalScope — one rule for how far a refusal reaches', () => {
  it('a capacity refusal is its own scope, never pass-terminal; the kill switches still are', () => {
    expect(intentRefusalScope(CAPACITY)).toBe('capacity');
    for (const e of [1, 3, 4]) expect(intentRefusalScope(e)).toBe('pass');
  });
});

describe('runIntentFillPass — a capacity refusal does not end the pass (#2564)', () => {
  it('reaches a later credit-backed intent after an ordinary one is refused for capacity, and skips the rest unpreviewed', async () => {
    const [a, b, c] = [owner(1), owner(2), owner(3)];
    const f = fakeCtx({
      intents: [a, b, c],
      preview: { [a]: CAPACITY },
      unlocks: { [b]: false, [c]: true },
    });
    const submits = await run(f, 2);
    expect(f.calls.fills, 'only the credit-backed intent fills').toEqual([c]);
    expect(submits).toBe(1);
    expect(f.calls.previews.filter((o) => o === b), 'an intent no credit unlocks is never previewed').toEqual([]);
    expect(f.calls.priority).toEqual([b, c]);
  });

  it('before any refusal, no priority read is spent: ordinary intents fill as before', async () => {
    const f = fakeCtx({ intents: [owner(1), owner(2)], preview: {} });
    expect(await run(f, 2)).toBe(2);
    expect(f.calls.priority).toEqual([]);
  });

  it('starts in the spent state when the offer-match pass already found the capacity spent', async () => {
    const [a, b] = [owner(1), owner(2)];
    const f = fakeCtx({ intents: [a, b], preview: {}, unlocks: { [b]: true } });
    expect(await run(f, 2, true)).toBe(1);
    expect(f.calls.fills).toEqual([b]);
    expect(f.calls.previews.includes(a)).toBe(false);
  });

  it('a credit-backed intent that runs out of credits mid-pass ends only that intent', async () => {
    const [a, b, c] = [owner(1), owner(2), owner(3)];
    const f = fakeCtx({
      intents: [a, b, c],
      preview: { [a]: CAPACITY, [b]: CAPACITY },
      unlocks: { [b]: true, [c]: true },
    });
    expect(await run(f, 1)).toBe(1);
    expect(f.calls.fills).toEqual([c]);
  });

  it('fails closed on a Diamond without the priority getter: nothing more is previewed or filled', async () => {
    const [a, b] = [owner(1), owner(2)];
    const f = fakeCtx({ intents: [a, b], preview: { [a]: CAPACITY }, getter: false });
    expect(await run(f, 2)).toBe(0);
    expect(f.calls.fills).toEqual([]);
    expect(f.calls.previews).toEqual([a]);
  });
});

describe('runIntentFillPass — Codex #2577 r1', () => {
  it('resumes ordinary scanning when the capacity has refilled since it was seen spent', async () => {
    const [a, b, c] = [owner(1), owner(2), owner(3)];
    const f = fakeCtx({ intents: [a, b, c], preview: { [a]: CAPACITY }, covers: { [b]: true } });
    expect(await run(f, 2)).toBe(2);
    expect(f.calls.fills).toEqual([b, c]);
    expect(f.calls.priority, 'no read once ordinary scanning resumed').toEqual([b]);
  });

  it('spends no priority read on an intent no borrower could fill', async () => {
    const [a, b] = [owner(1), owner(2)];
    const f = fakeCtx({ intents: [a, b], preview: {}, unlocks: { [b]: true } });
    const book = [borrower(1n)];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      // `a`'s only compatible borrower is quarantined, so it fits nobody.
      const uncertain = new Set<string>();
      await runIntentFillPass(f.ctx, book as never, () => false, 0, 0, uncertain, true);
      expect(f.calls.priority).toEqual([a, b]);
      f.calls.priority.length = 0;
      uncertain.add('1');
      await runIntentFillPass(f.ctx, book as never, () => false, 0, 0, uncertain, true);
      expect(f.calls.priority, 'no compatible borrower, no read').toEqual([]);
    } finally {
      now.mockRestore();
      log.mockRestore();
    }
  });

  it('rotates the intent order with the tick, so a later intent is reached first in turn', async () => {
    const [a, b, c] = [owner(1), owner(2), owner(3)];
    const f0 = fakeCtx({ intents: [a, b, c], preview: {} });
    await run(f0, 3, false, 0);
    const f1 = fakeCtx({ intents: [a, b, c], preview: {} });
    await run(f1, 3, false, 1);
    expect(f0.calls.fills[0]).toBe(a);
    expect(f1.calls.fills[0]).toBe(b);
  });

  it('counts a credit fill from the mined IntentPriorityFill, never from the capacity state', () => {
    expect(receiptSpentPriorityCredit([priorityFillLog(owner(9))], DIAMOND)).toBe(true);
    expect(receiptSpentPriorityCredit([], DIAMOND)).toBe(false);
    expect(receiptSpentPriorityCredit([{ ...priorityFillLog(owner(9)), address: owner(0xdead) }], DIAMOND), 'another contract').toBe(false);
  });
});

describe('priorityState', () => {
  it('reads the fill predicate for this solver as both solver and initiator, and is blocked on any read failure', async () => {
    const f = fakeCtx({ intents: [], preview: {}, unlocks: { [owner(5)]: true } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const intent = { owner: owner(5), lendingAsset: LEND, collateralAsset: COLL } as const;
      expect(await priorityState(f.ctx, intent, SOLVER)).toBe('credit');
      const req = (f.ctx as { client: { readContract: { mock: { calls: { args: unknown[] }[][] } } } }).client.readContract.mock.calls[0][0];
      expect(req.args).toEqual([owner(5), LEND, COLL, SOLVER, SOLVER]);
      const broken = fakeCtx({ intents: [], preview: {}, getter: false });
      expect(await priorityState(broken.ctx, intent, SOLVER)).toBe('blocked');
    } finally {
      log.mockRestore();
    }
  });
});
