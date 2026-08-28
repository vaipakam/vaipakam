/**
 * The liquidator's Multicall3 batching must ACTUALLY BATCH (#1946).
 *
 * WHY THIS TEST EXISTS, AND WHY IT ASSERTS WHAT IT DOES.
 *
 * `liquidator.ts` builds a chainless client — `createPublicClient({ transport:
 * http(chain.rpc) })`, with no `chain`, which is how every client in this
 * Worker is built. viem resolves Multicall3 from `chain.contracts.multicall3`,
 * so without an explicit `multicallAddress` the call throws
 * `client chain not configured. multicallAddress is required.` LOCALLY, before
 * issuing any request.
 *
 * The pass catches that and falls back to serial per-loan reads. So the failure
 * is invisible in every way an ordinary test would look for it: the pass
 * completes, returns normally, emits its `scan complete` marker with the right
 * loan count, and the only trace is a `console.error` that reads like a
 * transient RPC blip. In production it meant EVERY active loan cost its own
 * subrequest, against a 50-per-invocation ceiling — a prime suspect for #1896 —
 * and nothing in the logs said so.
 *
 * A test that merely ran the pass and checked it succeeded would therefore
 * pass just as happily against the broken version. That is the whole point:
 * this asserts on the SHAPE OF THE TRAFFIC, not on the pass's outcome.
 *   - an `aggregate3` call reached the canonical Multicall3 address, and
 *   - no per-loan `calculateHealthFactor` call was made outside it.
 *
 * The second assertion is load-bearing: without it, a fix that batched SOME
 * chunks and silently fell back on others would still pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionResult, toFunctionSelector } from 'viem';
import { MULTICALL3_ADDRESS } from '../src/multicall3';

/** Multicall3.aggregate3 — what viem emits for `client.multicall`. */
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

const AGGREGATE3_SELECTOR = toFunctionSelector(AGGREGATE3).toLowerCase();
const USER_LOANS_SELECTOR = toFunctionSelector(
  'function getUserActiveLoans(address) view returns (uint256[])',
).toLowerCase();

/** `calculateHealthFactor(uint256)` — the per-loan read the fallback makes. */
const CALC_HF_SELECTOR = toFunctionSelector(
  'function calculateHealthFactor(uint256) view returns (uint256)',
).toLowerCase();

/**
 * The discovery reads the pass makes BEFORE it can batch anything. Answering
 * these with `0x` — as the first cut of this test did — makes the pass find no
 * loans and return before reaching the multicall, so the batch assertion fails
 * for a reason that has nothing to do with batching.
 */
const COUNT_SELECTOR = toFunctionSelector(
  'function getActiveLoansCount() view returns (uint256)',
).toLowerCase();
const PAGE_SELECTOR = toFunctionSelector(
  'function getActiveLoansPaginated(uint256,uint256) view returns (uint256[])',
).toLowerCase();

/** How many active loans the fixture reports. One chunk's worth is enough. */
const LOAN_COUNT = 5;

type Seen = { to: string; selector: string; innerSelectors: string[] };

/**
 * Install a fetch stub that records the shape of every `eth_call`, answering
 * `aggregate3` with a well-formed batch result so the pass proceeds normally.
 */
function recordCalls(opts: { rejectAggregate?: boolean } = {}): { seen: Seen[]; restore: () => void } {
  const seen: Seen[] = [];
  const real = globalThis.fetch;

  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((req: { method: string; params?: unknown[]; id?: unknown }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
      if (req.method === 'eth_chainId') return ok('0x14a34');
      if (req.method === 'eth_blockNumber') return ok('0x1312d00');

      if (req.method !== 'eth_call') return ok(null);
      const call = (req.params?.[0] ?? {}) as { to?: string; data?: string };
      const data = (call.data ?? '0x').toLowerCase();
      const selector = data.slice(0, 10);

      // Unwrap the batch so the test can see WHAT was batched, not just that
      // something was.
      const innerSelectors: string[] = [];
      if (selector === COUNT_SELECTOR) {
        return ok(
          encodeFunctionResult({
            abi: [
              {
                type: 'function',
                name: 'getActiveLoansCount',
                stateMutability: 'view',
                inputs: [],
                outputs: [{ name: '', type: 'uint256' }],
              },
            ],
            functionName: 'getActiveLoansCount',
            result: BigInt(LOAN_COUNT),
          }),
        );
      }
      if (selector === PAGE_SELECTOR) {
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
            // DISTINCT ids — a repeated id would collapse the batch and hide a
            // per-loan fallback behind an apparently-correct call count.
            result: Array.from({ length: LOAN_COUNT }, (_, i) => BigInt(i + 1)),
          }),
        );
      }

      if (selector === USER_LOANS_SELECTOR) {
        seen.push({ to: (call.to ?? '').toLowerCase(), selector, innerSelectors: [] });
        return ok(
          encodeFunctionResult({
            abi: [
              {
                type: 'function',
                name: 'getUserActiveLoans',
                stateMutability: 'view',
                inputs: [{ name: 'user', type: 'address' }],
                outputs: [{ name: 'loanIds', type: 'uint256[]' }],
              },
            ],
            functionName: 'getUserActiveLoans',
            result: [1n, 2n],
          }),
        );
      }

      if (selector === AGGREGATE3_SELECTOR) {
        // Each inner callData is ABI-encoded at a dynamic offset; the
        // selectors are enough for this assertion, so scan for them rather
        // than fully decoding the tuple array. BOTH shapes are scanned and
        // kept in CALL ORDER, because the watcher batches two different reads
        // and the response has to answer each in kind.
        const hits: { at: number; sel: string }[] = [];
        for (const sel of [CALC_HF_SELECTOR, USER_LOANS_SELECTOR]) {
          for (const m of data.matchAll(new RegExp(sel.slice(2), 'g'))) {
            hits.push({ at: m.index ?? 0, sel });
          }
        }
        hits.sort((a, b) => a.at - b.at);
        innerSelectors.push(...hits.map((h) => h.sel));
      }
      seen.push({ to: (call.to ?? '').toLowerCase(), selector, innerSelectors });

      if (selector === AGGREGATE3_SELECTOR && opts.rejectAggregate) {
        // A chain WITHOUT this Multicall3 deployment, or an RPC that refuses
        // the aggregate call. This is the case the serial fallback exists for.
        return {
          jsonrpc: '2.0',
          id: req.id ?? 1,
          error: { code: -32000, message: 'execution reverted: no multicall3 here' },
        };
      }
      if (selector === AGGREGATE3_SELECTOR) {
        const loanList = encodeFunctionResult({
          abi: [
            {
              type: 'function',
              name: 'getUserActiveLoans',
              stateMutability: 'view',
              inputs: [{ name: 'user', type: 'address' }],
              outputs: [{ name: 'loanIds', type: 'uint256[]' }],
            },
          ],
          functionName: 'getUserActiveLoans',
          result: [1n, 2n],
        });
        const hf = encodeFunctionResult({
          abi: [
            {
              type: 'function',
              name: 'calculateHealthFactor',
              stateMutability: 'view',
              inputs: [{ name: 'loanId', type: 'uint256' }],
              outputs: [{ name: 'hf', type: 'uint256' }],
            },
          ],
          functionName: 'calculateHealthFactor',
          result: 2n * 10n ** 18n,
        });
        return ok(
          encodeFunctionResult({
            abi: [AGGREGATE3],
            functionName: 'aggregate3',
            result: innerSelectors.map((sel) => ({
              success: true,
              returnData: (sel === USER_LOANS_SELECTOR ? loanList : hf) as `0x${string}`,
            })),
          }),
        );
      }
      return ok('0x');
    });

    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { seen, restore: () => { globalThis.fetch = real; } };
}

/**
 * A D1 stub carrying subscriber rows, so `watchChain` gets past its
 * `listThresholdsForChain` early return and actually reads on-chain.
 */
function watcherDb(): unknown {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    wallet: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    chain_id: 84532,
    warn_hf: 2.0,
    alert_hf: 1.5,
    critical_hf: 1.1,
    tg_chat_id: null,
    push_channel: null,
    locale: 'en',
    notify_maturity_approaching: 0,
  }));
  const stmt: Record<string, unknown> = {};
  stmt.bind = () => stmt;
  stmt.all = async () => ({ results: rows, success: true, meta: {} });
  stmt.first = async () => null;
  stmt.run = async () => ({ results: [], success: true, meta: {} });
  return { prepare: () => stmt, batch: async () => [], exec: async () => ({}) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Multicall3 batching (#1946)', () => {
  it('the canonical address is the deterministic Multicall3 deployment', () => {
    // Pinned deliberately: a typo here reintroduces the exact silent fallback
    // this module exists to prevent, and every other assertion in this file
    // would still pass because the fallback succeeds.
    expect(MULTICALL3_ADDRESS).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
  });

  it('batches health-factor reads through aggregate3, with no serial fallback', async () => {
    const { seen, restore } = recordCalls();
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });

    try {
      const { liquidatePassForChain } = (await import('../src/liquidator')) as unknown as {
        liquidatePassForChain?: unknown;
      };
      // The chunk helper is not exported; drive the public entry instead.
      void liquidatePassForChain;

      const { runLiquidator } = await import('../src/liquidator');
      await runLiquidator({
        DB: undefined as never,
        KEEPER_ENABLED: 'true',
        KEEPER_PRIVATE_KEY:
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        RPC_BASE_SEPOLIA: 'https://mock-rpc.invalid/base-sepolia',
      } as never);
    } finally {
      restore();
      spy.mockRestore();
    }

    const batched = seen.filter((s) => s.selector === AGGREGATE3_SELECTOR);
    const serialHf = seen.filter((s) => s.selector === CALC_HF_SELECTOR);

    // 1. The batch path ran at all.
    expect(batched.length).toBeGreaterThan(0);

    // 2. It went to Multicall3, not the Diamond.
    for (const b of batched) {
      expect(b.to).toBe(MULTICALL3_ADDRESS.toLowerCase());
    }

    // 3. It actually carried the HF reads.
    expect(batched.some((b) => b.innerSelectors.length > 0)).toBe(true);

    // 4. NOTHING fell back to a serial per-loan read. Without this a fix that
    //    batches some chunks and silently falls back on others still passes.
    expect(serialHf).toHaveLength(0);

    // 5. The specific local rejection that caused #1946 never occurred.
    expect(errors.join('\n')).not.toMatch(/chain not configured|multicallAddress is required/i);
  });

  /**
   * #1965 r2 — the serial fallback was UNREACHABLE for the case it was written
   * for.
   *
   * With `allowFailure: true`, viem converts a REJECTED `aggregate3` into one
   * failure result per contract rather than throwing. Its own source says so:
   * "If an error occurred in a `readContract` invocation (ie. network error),
   * then append the failure reason to each contract result"
   * (`multicall.js:160-172`). So the `try/catch` around the batch never fires
   * on an aggregate-level failure, and every loan in the chunk is marked
   * unevaluated — no liquidation attempted, on a chain that simply lacks
   * Multicall3.
   */
  it('falls back to serial reads when the aggregate call is REJECTED', async () => {
    const { seen, restore } = recordCalls({ rejectAggregate: true });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    try {
      const { runLiquidator } = await import('../src/liquidator');
      await runLiquidator({
        DB: undefined as never,
        KEEPER_ENABLED: 'true',
        KEEPER_PRIVATE_KEY:
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        RPC_BASE_SEPOLIA: 'https://mock-rpc.invalid/base-sepolia',
      } as never);
    } finally {
      restore();
      spy.mockRestore();
    }

    const batched = seen.filter((s) => s.selector === AGGREGATE3_SELECTOR);
    const serialHf = seen.filter((s) => s.selector === CALC_HF_SELECTOR);

    // The batch was attempted — this is a fallback, not a bypass.
    expect(batched.length).toBeGreaterThan(0);

    // THE ASSERTION THAT EARNS THIS TEST. Before the fix this was 0: the
    // rejection arrived as per-contract failures, the catch never ran, and
    // every loan silently counted as unevaluated.
    expect(serialHf.length).toBe(LOAN_COUNT);

    // Each retry went DIRECT to the Diamond, not back through Multicall3.
    for (const c of serialHf) {
      expect(c.to).not.toBe(MULTICALL3_ADDRESS.toLowerCase());
    }

    // And the operator can see why it degraded.
    expect(errors.join('\n')).toMatch(/aggregate3 rejected/i);
  });
});


describe('watcher batching (#1896)', () => {
  it('batches the loan lists AND the health factors, with no serial reads', async () => {
    // The watcher was the largest consumer in the #1945 pass table for a
    // structural reason: one `getUserActiveLoans` per subscriber, then one
    // `calculateHealthFactor` per loan, sequentially. With the seeded fixture
    // that is 20 + 500 subrequests per chain against a 50-per-invocation
    // ceiling. This asserts BOTH loops are gone, not just the inner one — the
    // outer per-user loop was the half that had no batching intent at all.
    const { seen, restore } = recordCalls();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { runWatcher } = await import('../src/watcher');
      await runWatcher({
        DB: watcherDb(),
        RPC_BASE_SEPOLIA: 'https://mock-rpc.invalid/base-sepolia',
        TG_BOT_TOKEN: 'test:token',
      } as never);
    } finally {
      restore();
      spy.mockRestore();
    }

    const batched = seen.filter((s) => s.selector === AGGREGATE3_SELECTOR);
    const serialHf = seen.filter((s) => s.selector === CALC_HF_SELECTOR);
    const serialLists = seen.filter((s) => s.selector === USER_LOANS_SELECTOR);

    // 1. The batch path ran. A chainless client throws LOCALLY, so without
    //    `multicallAddress` this is 0 and everything below falls to serial —
    //    which still completes, which is why this assertion exists.
    expect(batched.length).toBeGreaterThan(0);

    // 2. Every batch went to Multicall3, not the diamond.
    for (const b of batched) {
      expect(b.to).toBe(MULTICALL3_ADDRESS.toLowerCase());
    }

    // 3. NEITHER read shape appears as a standalone call. A serial
    //    `getUserActiveLoans` here means the outer loop survived; a serial
    //    `calculateHealthFactor` means the inner one did.
    expect(serialLists).toHaveLength(0);
    expect(serialHf).toHaveLength(0);

    // 4. Both shapes are present INSIDE the batches — proving the calls were
    //    batched rather than simply not made.
    const inner = batched.flatMap((b) => b.innerSelectors);
    expect(inner).toContain(USER_LOANS_SELECTOR);
    expect(inner).toContain(CALC_HF_SELECTOR);

    // 5. The whole chain costs a handful of requests, not one per loan. The
    //    point of the change is the subrequest ceiling, so bound it.
    expect(batched.length).toBeLessThanOrEqual(4);
  });

  it('falls back to serial reads when the aggregate call is REJECTED', async () => {
    // The fallback must still work for a chain genuinely missing Multicall3 —
    // it is only dangerous when it fires silently on EVERY chain, which is
    // what assertion 1 above pins.
    const { seen, restore } = recordCalls({ rejectAggregate: true });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { runWatcher } = await import('../src/watcher');
      await runWatcher({
        DB: watcherDb(),
        RPC_BASE_SEPOLIA: 'https://mock-rpc.invalid/base-sepolia',
        TG_BOT_TOKEN: 'test:token',
      } as never);
    } finally {
      restore();
      spy.mockRestore();
    }

    expect(seen.filter((s) => s.selector === AGGREGATE3_SELECTOR).length).toBeGreaterThan(0);
    expect(seen.filter((s) => s.selector === USER_LOANS_SELECTOR).length).toBeGreaterThan(0);
  });
});
