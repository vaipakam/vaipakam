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
 *   - a loan that has said it is illiquid is not read again by the same
 *     process, and the completion line still accounts for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector } from 'viem';
import { isAggregateRejection } from '../src/batchRead';

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

const uint = (name: string, value: bigint) =>
  encodeFunctionResult({
    abi: [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }],
    functionName: name,
    result: value,
  });
const HF_HEALTHY = uint('calculateHealthFactor', 2n * 10n ** 18n);

type Book = { loans: bigint[]; illiquid: Set<bigint>; rejectAggregate?: boolean };
type Traffic = { aggregates: bigint[][]; directHf: bigint[] };

/** An RPC answering the scan's reads for `book`, recording the HF reads it is asked for. */
function rpc(book: Book): { traffic: Traffic; restore: () => void } {
  const traffic: Traffic = { aggregates: [], directHf: [] };
  const real = globalThis.fetch;
  const loanIdOf = (callData: string) => BigInt('0x' + callData.slice(10, 74));

  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((req: { method: string; params?: unknown[]; id?: unknown }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
      if (req.method === 'eth_chainId') return ok('0x14a34');
      if (req.method === 'eth_blockNumber') return ok('0x1312d00');
      if (req.method !== 'eth_call') return ok(null);
      const data = (((req.params?.[0] ?? {}) as { data?: string }).data ?? '0x').toLowerCase();
      const selector = data.slice(0, 10);

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
        traffic.aggregates.push(ids);
        if (book.rejectAggregate) {
          return { jsonrpc: '2.0', id: req.id ?? 1, error: { code: -32000, message: 'upstream unavailable' } };
        }
        return ok(
          encodeFunctionResult({
            abi: [AGGREGATE3],
            functionName: 'aggregate3',
            result: ids.map((id) =>
              book.illiquid.has(id)
                ? { success: false, returnData: ILLIQUID_REVERT as `0x${string}` }
                : { success: true, returnData: HF_HEALTHY },
            ),
          }),
        );
      }
      if (selector === CALC_HF_SELECTOR) {
        const id = loanIdOf(data);
        traffic.directHf.push(id);
        if (book.illiquid.has(id)) {
          return { jsonrpc: '2.0', id: req.id ?? 1, error: { code: 3, message: 'execution reverted', data: ILLIQUID_REVERT } };
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

/** One liquidator tick against `book`, in the module instance `run` belongs to. */
async function tick(
  run: (env: never, t: never) => Promise<void>,
  book: Book,
): Promise<Traffic & { logs: string[]; errors: string[] }> {
  const { traffic, restore } = rpc(book);
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  try {
    await run(ENV, { scheduledTimeMs: undefined, deadlineMs: Date.now() + 60_000 } as never);
  } finally {
    restore();
    log.mockRestore();
    err.mockRestore();
  }
  return { ...traffic, logs, errors };
}

async function freshLiquidator() {
  return (await import('../src/liquidator')).runLiquidator as never as (env: never, t: never) => Promise<void>;
}

beforeEach(() => {
  // The illiquid memory is per process; each test starts from a new one.
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('liquidator and loans with no health factor (#2579)', () => {
  it("a one-entry chunk's own revert is that loan's result, not a rejected aggregate", async () => {
    const run = await freshLiquidator();
    const t = await tick(run, { loans: [1n], illiquid: new Set([1n]) });

    expect(t.aggregates).toEqual([[1n]]);
    // Before #2579: one serial retry per tick, logged as an RPC fault.
    expect(t.directHf).toEqual([]);
    expect(t.errors.join('\n')).not.toMatch(/aggregate3 rejected|multicall failed|unevaluated/);
    expect(t.logs.join('\n')).toMatch(/scan complete: scanned=0 atRisk=0 submitted=0 noHealthFactor=1/);
  });

  it('a genuine rejection of a one-entry chunk is still retried serially', async () => {
    const run = await freshLiquidator();
    const t = await tick(run, { loans: [1n], illiquid: new Set(), rejectAggregate: true });

    expect(t.aggregates).toEqual([[1n]]);
    expect(t.directHf).toEqual([1n]);
    expect(t.errors.join('\n')).toMatch(/aggregate3 rejected/);
    expect(t.logs.join('\n')).toMatch(/scan complete: scanned=1 atRisk=0 submitted=0 noHealthFactor=0/);
  });

  it('a loan that has said it is illiquid is not read again', async () => {
    const run = await freshLiquidator();
    const book: Book = { loans: [1n, 2n, 3n], illiquid: new Set([2n]) };

    const first = await tick(run, book);
    expect(first.aggregates.flat().sort()).toEqual([1n, 2n, 3n]);
    expect(first.logs.join('\n')).toMatch(/scanned=2 atRisk=0 submitted=0 noHealthFactor=1/);

    const second = await tick(run, book);
    // Loan 2 is left out of the batch; 1 and 3 are still read every tick.
    expect(second.aggregates.flat().sort()).toEqual([1n, 3n]);
    expect(second.directHf).toEqual([]);
    // And still accounted for on the completion line.
    expect(second.logs.join('\n')).toMatch(/scanned=2 atRisk=0 submitted=0 noHealthFactor=1/);
  });

  it('a book holding only remembered illiquid loans issues no health-factor read', async () => {
    const run = await freshLiquidator();
    const book: Book = { loans: [1n], illiquid: new Set([1n]) };
    await tick(run, book);
    const second = await tick(run, book);

    expect(second.aggregates).toEqual([]);
    expect(second.directHf).toEqual([]);
    expect(second.logs.join('\n')).toMatch(/scan complete: scanned=0 atRisk=0 submitted=0 noHealthFactor=1/);
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
