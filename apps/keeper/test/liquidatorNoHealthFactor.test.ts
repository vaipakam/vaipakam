/**
 * #2579 — the liquidator's health-factor scan and illiquid loans.
 *
 * On Base Sepolia the only active loan was an illiquid one, and every tick
 * logged "aggregate3 rejected … retrying serially" for it: its own
 * `IlliquidLoanNoRiskMath` revert, in a one-entry chunk, matched the
 * "every entry shares one error" rule for a rejected aggregate. Two things
 * are pinned here, both on the SHAPE OF THE TRAFFIC:
 *
 *   - a loan's own revert in a one-entry chunk is that loan's result: no serial
 *     retry, no rejection logged, while a genuine rejection of a one-entry
 *     chunk is still retried;
 *   - a loan the FINALIZED block also says is illiquid is not read again by
 *     the same process, and the completion line still accounts for it; one
 *     only the latest block says so of (a reorg could replace it) is read
 *     again every tick (#2579 r1).
 *
 * The liquidator's memory lives for the module, and every test here shares one
 * import of it (a fresh import per test is slow enough on a cold runner to
 * time out, #2579 r1). They stay independent because each test uses its own
 * loan ids, and the first tick of each, reading a complete book, forgets every
 * id not in it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector } from 'viem';
import { isAggregateRejection } from '../src/batchRead';
import { runLiquidator } from '../src/liquidator';

/** What happened, in order: a liquidation submit, or a finality read. */
const events = vi.hoisted(() => [] as string[]);
vi.mock('../src/keeper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/keeper')>()),
  // A submit is recorded, never sent: these tests are about the reads.
  maybeAutonomousLiquidate: vi.fn(async (_env: unknown, _chain: unknown, id: bigint) => {
    events.push(`submit ${id}`);
    return true;
  }),
}));

const AGGREGATE3 = {
  type: 'function',
  name: 'aggregate3',
  stateMutability: 'payable',
  inputs: [
    {
      name: 'calls',
      type: 'tuple[]',
      components: [
        { name: 'target', type: 'address' },
        { name: 'allowFailure', type: 'bool' },
        { name: 'callData', type: 'bytes' },
      ],
    },
  ],
  outputs: [
    {
      name: 'returnData',
      type: 'tuple[]',
      components: [
        { name: 'success', type: 'bool' },
        { name: 'returnData', type: 'bytes' },
      ],
    },
  ],
} as const;

const fn = (sig: string) => toFunctionSelector(sig).toLowerCase();
const AGGREGATE3_SELECTOR = fn(AGGREGATE3 as never);
const CALC_HF_SELECTOR = fn('function calculateHealthFactor(uint256) view returns (uint256)');
const COUNT_SELECTOR = fn('function getActiveLoansCount() view returns (uint256)');
const PAGE_SELECTOR = fn('function getActiveLoansPaginated(uint256,uint256) view returns (uint256[])');
/** `IlliquidLoanNoRiskMath()` */
const ILLIQUID_REVERT = '0x1fb202b3';
/** `InvalidLoan()`: what the finalized block answers for a loan opened after it. */
const INVALID_LOAN_REVERT = '0x045f33d1';
const LATEST_BLOCK = '0x1312d00';
const FINALIZED_BLOCK = '0x1312c00';

const uint = (name: string, value: bigint) =>
  encodeFunctionResult({
    abi: [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }],
    functionName: name,
    result: value,
  });
const HF_HEALTHY = uint('calculateHealthFactor', 2n * 10n ** 18n);
const HF_UNDERWATER = uint('calculateHealthFactor', 9n * 10n ** 17n);

type Book = {
  loans: bigint[];
  /** Illiquid at the latest block. */
  illiquid: Set<bigint>;
  /** Of `illiquid`, the ones the finalized block holds too; the rest do not
   *  exist there yet (`InvalidLoan`). Defaults to all of `illiquid`. */
  final?: Set<bigint>;
  rejectAggregate?: boolean;
  /** Liquid loans below the liquidation line. */
  underwater?: Set<bigint>;
  /** The RPC cannot serve the finalized block. */
  noFinalizedBlock?: boolean;
};
type Traffic = {
  /** Health-factor batches read at the scan's (latest) block. */
  aggregates: bigint[][];
  /** Health-factor batches read at the finalized block. */
  finalityChecks: bigint[][];
  directHf: bigint[];
};

/** An RPC answering the scan's reads for `book`, recording the HF reads it is asked for. */
function rpc(book: Book): { traffic: Traffic; restore: () => void } {
  const traffic: Traffic = { aggregates: [], finalityChecks: [], directHf: [] };
  const real = globalThis.fetch;
  const loanIdOf = (callData: string) => BigInt('0x' + callData.slice(10, 74));

  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((req: { method: string; params?: unknown[]; id?: unknown }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
      if (req.method === 'eth_chainId') return ok('0x14a34');
      if (req.method === 'eth_blockNumber') return ok(LATEST_BLOCK);
      if (req.method === 'eth_getBlockByNumber' && req.params?.[0] === 'finalized') {
        events.push('finalized block');
        if (book.noFinalizedBlock) {
          return { jsonrpc: '2.0', id: req.id ?? 1, error: { code: -32000, message: 'finalized not supported' } };
        }
        return ok({ number: FINALIZED_BLOCK, hash: '0x' + '11'.repeat(32), timestamp: '0x1', transactions: [] });
      }
      if (req.method !== 'eth_call') return ok(null);
      const data = (((req.params?.[0] ?? {}) as { data?: string }).data ?? '0x').toLowerCase();
      const selector = data.slice(0, 10);
      const atFinalized = req.params?.[1] === FINALIZED_BLOCK;
      const final = book.final ?? book.illiquid;
      const revertOf = (id: bigint) =>
        !book.illiquid.has(id) ? undefined : !atFinalized || final.has(id) ? ILLIQUID_REVERT : INVALID_LOAN_REVERT;

      if (selector === COUNT_SELECTOR) return ok(uint('getActiveLoansCount', BigInt(book.loans.length)));
      if (selector === PAGE_SELECTOR) {
        const offset = Number(BigInt('0x' + data.slice(10, 74)));
        const limit = Number(BigInt('0x' + data.slice(74, 138)));
        return ok(
          encodeFunctionResult({
            abi: [
              {
                type: 'function',
                name: 'getActiveLoansPaginated',
                stateMutability: 'view',
                inputs: [
                  { name: 'offset', type: 'uint256' },
                  { name: 'limit', type: 'uint256' },
                ],
                outputs: [{ name: 'loanIds', type: 'uint256[]' }],
              },
            ],
            functionName: 'getActiveLoansPaginated',
            result: book.loans.slice(offset, offset + limit),
          }),
        );
      }
      if (selector === AGGREGATE3_SELECTOR) {
        const { args } = decodeFunctionData({ abi: [AGGREGATE3], data: data as `0x${string}` });
        const calls = args[0] as readonly { callData: string }[];
        const ids = calls.map((c) => loanIdOf(c.callData.toLowerCase()));
        (atFinalized ? traffic.finalityChecks : traffic.aggregates).push(ids);
        if (atFinalized) events.push('finality check');
        if (book.rejectAggregate) {
          return { jsonrpc: '2.0', id: req.id ?? 1, error: { code: -32000, message: 'upstream unavailable' } };
        }
        return ok(
          encodeFunctionResult({
            abi: [AGGREGATE3],
            functionName: 'aggregate3',
            result: ids.map((id) => {
              const revert = revertOf(id);
              return revert
                ? { success: false, returnData: revert as `0x${string}` }
                : { success: true, returnData: book.underwater?.has(id) ? HF_UNDERWATER : HF_HEALTHY };
            }),
          }),
        );
      }
      if (selector === CALC_HF_SELECTOR) {
        const id = loanIdOf(data);
        traffic.directHf.push(id);
        const revert = revertOf(id);
        if (revert) {
          return { jsonrpc: '2.0', id: req.id ?? 1, error: { code: 3, message: 'execution reverted', data: revert } };
        }
        return ok(HF_HEALTHY);
      }
      return ok('0x');
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { traffic, restore: () => { globalThis.fetch = real; } };
}

const ENV = {
  DB: undefined as never,
  KEEPER_ENABLED: 'true',
  KEEPER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  RPC_BASE_SEPOLIA: 'https://mock-rpc.invalid/base-sepolia',
} as never;

/** One liquidator tick against `book`. */
async function tick(book: Book): Promise<Traffic & { logs: string[]; errors: string[] }> {
  const { traffic, restore } = rpc(book);
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  try {
    await runLiquidator(ENV, { scheduledTimeMs: undefined, deadlineMs: Date.now() + 60_000 } as never);
  } finally {
    restore();
    log.mockRestore();
    err.mockRestore();
  }
  return { ...traffic, logs, errors };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('liquidator and loans with no health factor (#2579)', () => {
  it("a one-entry chunk's own revert is that loan's result, not a rejected aggregate", async () => {
    const t = await tick({ loans: [11n], illiquid: new Set([11n]) });

    expect(t.aggregates).toEqual([[11n]]);
    // Before #2579: one serial retry per tick, logged as an RPC fault.
    expect(t.directHf).toEqual([]);
    expect(t.errors.join('\n')).not.toMatch(/aggregate3 rejected|multicall failed|unevaluated/);
    expect(t.logs.join('\n')).toMatch(/scan complete: scanned=0 atRisk=0 submitted=0 noHealthFactor=1/);
  });

  it('a genuine rejection of a one-entry chunk is still retried serially', async () => {
    const t = await tick({ loans: [21n], illiquid: new Set(), rejectAggregate: true });

    expect(t.aggregates).toEqual([[21n]]);
    expect(t.directHf).toEqual([21n]);
    expect(t.errors.join('\n')).toMatch(/aggregate3 rejected/);
    expect(t.logs.join('\n')).toMatch(/scan complete: scanned=1 atRisk=0 submitted=0 noHealthFactor=0/);
  });

  it('a loan the finalized block also says is illiquid is not read again', async () => {
    const book: Book = { loans: [31n, 32n, 33n], illiquid: new Set([32n]) };

    const first = await tick(book);
    expect(first.aggregates.flat().sort()).toEqual([31n, 32n, 33n]);
    // Only the loan that reverted illiquid is checked at finality.
    expect(first.finalityChecks).toEqual([[32n]]);
    expect(first.logs.join('\n')).toMatch(/scanned=2 atRisk=0 submitted=0 noHealthFactor=1/);

    const second = await tick(book);
    // Loan 32 is left out of the batch; 31 and 33 are still read every tick.
    expect(second.aggregates.flat().sort()).toEqual([31n, 33n]);
    expect(second.finalityChecks).toEqual([]);
    expect(second.directHf).toEqual([]);
    // And still accounted for on the completion line.
    expect(second.logs.join('\n')).toMatch(/scanned=2 atRisk=0 submitted=0 noHealthFactor=1/);
  });

  it('a book holding only remembered illiquid loans issues no health-factor read', async () => {
    const book: Book = { loans: [41n], illiquid: new Set([41n]) };
    await tick(book);
    const second = await tick(book);

    expect(second.aggregates).toEqual([]);
    expect(second.finalityChecks).toEqual([]);
    expect(second.directHf).toEqual([]);
    expect(second.logs.join('\n')).toMatch(/scan complete: scanned=0 atRisk=0 submitted=0 noHealthFactor=1/);
  });

  it('a loan only the latest block says is illiquid is read again every tick (a reorg could replace it)', async () => {
    // Loan 51 is illiquid at the latest block but does not exist at the
    // finalized one, which is what a recent loan, or one a reorg may yet
    // remove, looks like.
    const book: Book = { loans: [51n], illiquid: new Set([51n]), final: new Set() };

    const first = await tick(book);
    expect(first.finalityChecks).toEqual([[51n]]);

    const second = await tick(book);
    expect(second.aggregates).toEqual([[51n]]);
    expect(second.finalityChecks).toEqual([[51n]]);

    // Once the finalized block holds it too, it is remembered.
    const third = await tick({ ...book, final: new Set([51n]) });
    expect(third.finalityChecks).toEqual([[51n]]);
    const fourth = await tick(book);
    expect(fourth.aggregates).toEqual([]);
  });

  it('without a finalized block nothing is remembered, and the loan stays in the scan', async () => {
    const book: Book = { loans: [61n], illiquid: new Set([61n]), noFinalizedBlock: true };

    const first = await tick(book);
    expect(first.finalityChecks).toEqual([]);
    expect(first.logs.join('\n')).toMatch(/finalized block unavailable; 1 illiquid loan\(s\) stay in the scan/);

    const second = await tick(book);
    expect(second.aggregates).toEqual([[61n]]);
  });

  it('the finality check runs after the liquidations, never before them', async () => {
    // Loan 81 is underwater; loan 82 is newly seen illiquid. The finality read
    // is bookkeeping and must not spend the time reserved for the submit.
    events.length = 0;
    await tick({ loans: [81n, 82n], illiquid: new Set([82n]), underwater: new Set([81n]) });
    expect(events).toEqual(['submit 81', 'finalized block', 'finality check']);
  });

  it('an empty book forgets every remembered loan', async () => {
    await tick({ loans: [71n], illiquid: new Set([71n]) });
    expect((await tick({ loans: [71n], illiquid: new Set([71n]) })).aggregates).toEqual([]);

    await tick({ loans: [], illiquid: new Set() });
    // The same id again, now a liquid loan: it is read.
    const after = await tick({ loans: [71n], illiquid: new Set() });
    expect(after.aggregates).toEqual([[71n]]);
    expect(after.logs.join('\n')).toMatch(/scanned=1 atRisk=0 submitted=0 noHealthFactor=0/);
  });
});

describe('isAggregateRejection (#2579)', () => {
  const failure = (error: unknown) => ({ status: 'failure' as const, error });

  it("one entry: its own revert is not a rejection; the aggregate3 call's error is", () => {
    expect(isAggregateRejection([failure({ functionName: 'calculateHealthFactor' })])).toBe(false);
    expect(isAggregateRejection([failure(new Error('reverted'))])).toBe(false);
    expect(isAggregateRejection([failure({ functionName: 'aggregate3' })])).toBe(true);
  });

  it('several entries: one shared error object is a rejection, separate errors are not', () => {
    const shared = new Error('aggregate rejected');
    expect(isAggregateRejection([failure(shared), failure(shared)])).toBe(true);
    expect(isAggregateRejection([failure(new Error('a')), failure(new Error('b'))])).toBe(false);
    expect(isAggregateRejection([failure(shared), { status: 'success', result: 1n }])).toBe(false);
  });

  it('no entries, or no error, is never a rejection', () => {
    expect(isAggregateRejection([])).toBe(false);
    expect(isAggregateRejection([{ status: 'failure' }])).toBe(false);
  });
});
