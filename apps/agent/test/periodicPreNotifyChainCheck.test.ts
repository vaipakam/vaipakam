/**
 * The periodic-interest lane asks the CHAIN before it speaks (#2213 r3).
 *
 * This lane sends a payment-due Push/Telegram and stamps the checkpoint
 * permanently — unretractable, derived from `status = 'active'` in D1. A loan
 * whose terminal event the platform missed for good sits at exactly that
 * status, so the stored row is not enough to justify the message.
 *
 * An earlier revision consulted the indexer's quarantine table instead. Three
 * review findings followed, none of them about the rule itself: a race
 * against the other Worker's write, a deploy-window coupling, and an
 * availability answer that could not separate "absent" from "could not ask".
 * Asking the chain here removes the coordination rather than tuning it — the
 * pattern the keeper's alert lane already uses.
 *
 * NO REAL NETWORK. The previous version of this file pointed viem at a closed
 * port and finished ~5ms inside the 5s deadline, which is a flake waiting for
 * a slow CI box (round 3 `4011960585`). The transport is stubbed.
 *
 * THE STUB ANSWERS `aggregate3`, NOT `getLoanDetails` (#2213 r5
 * `4012300071`). The reads are batched through Multicall3 now, and the stub
 * decodes each sub-call's calldata to find out which loan it is being asked
 * about — so a positional mix-up between the candidate slice and the results
 * array fails these tests instead of silently answering about the wrong loan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the stubbed chain answers for one loan. `null` = that sub-call failed. */
let answer: (loanId: number) => { id: bigint; status: number } | null;
/** When set, the whole batched call throws — the RPC being unreachable. */
let batchError: Error | null = null;
/** The rows D1 hands back for the loan scan, in the order it hands them back. */
let loanRows: Record<string, unknown>[] = [];
/** Per-chain override of the above, for the multi-chain allowance tests. */
let loanRowsByChain: Record<number, Record<string, unknown>[]> | null = null;

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  const { LoanFacetABI } = await import('@vaipakam/contracts/abis');
  const abi = LoanFacetABI as import('viem').Abi;

  /** A Loan struct of the right SHAPE with every field at zero. */
  const zeroFor = (t: { type: string; components?: { name: string; type: string }[] }): unknown => {
    const arr = /^(.*)\[(\d*)\]$/.exec(t.type);
    if (arr) {
      const inner = { ...t, type: arr[1]! };
      const n = arr[2] ? Number(arr[2]) : 0;
      return Array.from({ length: n }, () => zeroFor(inner));
    }
    if (t.type === 'tuple') {
      return Object.fromEntries((t.components ?? []).map((c) => [c.name, zeroFor(c)]));
    }
    if (t.type === 'address') return '0x0000000000000000000000000000000000000000';
    if (t.type === 'bool') return false;
    if (t.type === 'string') return '';
    if (t.type === 'bytes') return '0x';
    if (t.type.startsWith('bytes')) return `0x${'00'.repeat(Number(t.type.slice(5)))}`;
    return 0n;
  };
  const outputs = (
    abi.find((e) => e.type === 'function' && e.name === 'getLoanDetails') as {
      outputs: { type: string; components?: { name: string; type: string }[] }[];
    }
  ).outputs;

  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args?: readonly unknown[];
      }) => {
        if (functionName === 'getPreNotifyDays') return 3;
        if (functionName !== 'aggregate3') {
          throw new Error(`the lane must batch its reads; saw a bare ${functionName}`);
        }
        if (batchError) throw batchError;
        const calls = (args?.[0] ?? []) as { callData: `0x${string}` }[];
        return calls.map((c) => {
          const decoded = actual.decodeFunctionData({ abi, data: c.callData });
          const loanId = Number((decoded.args as readonly unknown[])[0]);
          const a = answer(loanId);
          if (!a) return { success: false, returnData: '0x' as const };
          const loan = { ...(zeroFor(outputs[0]!) as Record<string, unknown>), ...a };
          return {
            success: true,
            returnData: actual.encodeFunctionResult({
              abi,
              functionName: 'getLoanDetails',
              result: loan as never,
            }),
          };
        });
      },
    }),
  };
});

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** One periodic loan, due inside the window, never pre-notified. */
function periodicLoan(loanId: number, settledAt: number) {
  return {
    loan_id: loanId,
    chain_id: 84532,
    lender: '0x1111111111111111111111111111111111111111',
    borrower: '0x2222222222222222222222222222222222222222',
    periodic_interest_cadence: 1,
    last_period_settled_at: settledAt,
    period_pre_notified_at: null,
  };
}

const dueLoan = periodicLoan(7, NOW - 29 * DAY);

function env(extra: Record<string, unknown> = {}) {
  const writes: { sql: string; params: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      const isLoanScan = sql.includes('periodic_interest_cadence') && sql.includes('FROM loans');
      // The loan scan binds the chain id first, so a multi-chain test can hand
      // each chain its own rows.
      const rowsFor = (params: unknown[]) => {
        if (!isLoanScan) return [];
        const chainId = Number(params[0]);
        return loanRowsByChain?.[chainId] ?? (loanRowsByChain ? [] : loanRows);
      };
      const record = (params: unknown[]) => {
        if (!sql.trim().startsWith('SELECT')) writes.push({ sql, params });
      };
      const leaf = (params: unknown[]) => ({
        all: async () => ({ results: rowsFor(params) }),
        first: async () => null,
        run: async () => {
          record(params);
          return { meta: { changes: 0 } };
        },
      });
      return { bind: (...params: unknown[]) => leaf(params), ...leaf([]) };
    },
  };
  return {
    env: { DB, RPC_BASE_SEPOLIA: 'https://stubbed.invalid', ...extra } as never,
    writes,
  };
}

async function run(extra: Record<string, unknown> = {}) {
  vi.resetModules();
  const { env: e, writes } = env(extra);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  warn.mockClear();
  const mod = await import('../src/periodicPreNotify');
  await mod.runPeriodicPreNotify(e).catch(() => undefined);
  const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
  warn.mockRestore();
  // `UPDATE loans SET period_pre_notified_at = ?, updated_at = ? WHERE chain_id = ? AND loan_id = ?`
  const stamps = writes
    .filter((w) => w.sql.includes('period_pre_notified_at'))
    .map((w) => ({ chainId: Number(w.params[2]), loanId: Number(w.params[3]) }));
  return { writes, said, stamps, stamped: stamps.map((s) => s.loanId) };
}

beforeEach(() => {
  answer = (id) => ({ id: BigInt(id), status: 0 });
  batchError = null;
  loanRows = [dueLoan];
  loanRowsByChain = null;
});

describe('periodic pre-notify checks the chain before an unretractable send', () => {
  it('does not remind when the chain says the loan has ended', async () => {
    // Status 1 = Repaid. The stored row still says active — that IS the
    // defect this guards, and the reason a stored-status check is not enough.
    answer = (id) => ({ id: BigInt(id), status: 1 });
    const { stamped, said } = await run();
    // Nothing stamped: no delivery happened, so the checkpoint stays open for
    // a later tick if the row turns out to be right after all.
    expect(stamped).toEqual([]);
    expect(said).toContain('reports status 1');
  });

  it('does not remind when the whole batched read FAILS', async () => {
    // Sending on a failed read would choose the unretractable outcome on no
    // evidence. Skipping costs a tick, and the window is days wide.
    batchError = new Error('rpc unavailable');
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(said).toContain('status read');
  });

  it('does not put the RPC URL in the log when the read fails', async () => {
    // #2213 r5 `4012300079`. viem's HttpRequestError carries the full request
    // URL — API key and all — near the START of its message, so truncating is
    // not redaction. Only bounded fields may be logged.
    const err = Object.assign(
      new Error('HTTP request failed.\nURL: https://rpc.example/v1/SUPERSECRETKEY'),
      { name: 'HttpRequestError', status: 429 },
    );
    batchError = err;
    const { said } = await run();
    expect(said).not.toContain('SUPERSECRETKEY');
    expect(said).not.toContain('rpc.example');
    // Still useful: the class and the status are what an operator separates on.
    expect(said).toContain('HttpRequestError');
    expect(said).toContain('HTTP 429');
  });

  it('does not remind when the batch returns but THIS loan’s sub-call failed', async () => {
    // `aggregate3` reports per-call success, so one unreadable loan must not
    // cost the rest of the slice its reminders — nor be treated as an answer.
    answer = () => null;
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(said).toContain('status read');
  });

  it('proceeds when the chain confirms the loan is still open', async () => {
    // The ordinary case must not be collateral damage of the guard.
    const { stamped, said } = await run();
    expect(stamped).toEqual([7]);
    expect(said).not.toContain('reports status');
    expect(said).not.toContain('status read');
  });

  it('does not remind on the ZERO STRUCT of a loan the chain has never had', async () => {
    // #2213 r4 `4012114089`. `getLoanDetails` does not revert for an unknown
    // id — it returns the mapping's zero struct, whose status is 0, which is
    // Active. So the orphaned row this whole feature exists to catch reads
    // back as a healthy running loan unless `id` is checked. The
    // reconciliation reader has rejected the zero struct since #2190; asking
    // the chain in a second place meant carrying the rule there too, and the
    // first version did not.
    answer = () => ({ id: 0n, status: 0 });
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(said).toContain('no such loan');
  });

  it('does not remind on FallbackPending, which cannot be settled', async () => {
    // #2213 r4 `4012114096`. Non-terminal is not the same as eligible:
    // `settlePeriodicInterest` accepts only `Active` and reverts on anything
    // else, so "your payment is due" here invites an action the contract
    // refuses. Eligibility is the ACTION's precondition, not generic liveness.
    answer = (id) => ({ id: BigInt(id), status: 4 });
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(said).toContain('reports status 4');
  });

  it('treats a status this build does not recognise as ended', async () => {
    // An allow-list of open states, not a deny-list of terminal ones: a
    // member appended to the enum must not silently become "still running"
    // in a lane that messages users about running loans.
    answer = (id) => ({ id: BigInt(id), status: 99 });
    const { said } = await run();
    expect(said).toContain('reports status 99');
  });
});

describe('the invocation spends a bounded allowance, nearest deadline first', () => {
  // #2213 r5 `4012300071`. A Worker invocation has ~50 outbound subrequests
  // and each reminded loan costs up to four, so the lane caps how many it
  // messages about. A cap without an order is what starves a borrower: the
  // database hands back the same rows every tick, so the ones behind them are
  // never reached and miss the very deadline the reminder was for.

  /** Ten due loans, ids DESCENDING with the deadline, handed back FARTHEST FIRST. */
  function tenLoans() {
    // k = 0 is nearest (settled longest ago), and carries the highest id — so
    // neither row order nor id order accidentally produces the right answer.
    const loans = Array.from({ length: 10 }, (_, k) =>
      periodicLoan(100 - k, NOW - 29 * DAY + k * 3600),
    );
    return loans.reverse();
  }

  it('reminds only as many as the allowance permits, and takes the nearest', async () => {
    loanRows = tenLoans();
    const { stamped, said } = await run();
    expect(stamped.length).toBe(8);
    // The eight nearest deadlines are ids 100…93; 92 and 91 wait.
    expect([...stamped].sort((a, b) => b - a)).toEqual([100, 99, 98, 97, 96, 95, 94, 93]);
    // SAID, with what happens to the rest — a silently dropped reminder is
    // indistinguishable from one that was never due.
    expect(said).toContain('10 loan(s) are inside');
    expect(said).toContain('this invocation can afford 8');
  });

  it('matches each answer to the loan it was asked about', async () => {
    // The batch returns an ARRAY, and the candidates are a separate array;
    // pairing them by position is only correct if nothing reorders in
    // between. Here exactly one loan in the middle has ended, so a lane that
    // read the wrong slot would withhold the wrong borrower's reminder —
    // and, worse, send the one it was supposed to withhold.
    loanRows = tenLoans().slice(-5); // ids 96…100 — the five nearest deadlines
    answer = (id) => ({ id: BigInt(id), status: id === 98 ? 1 : 0 });
    const { stamped, said } = await run();
    expect([...stamped].sort((a, b) => b - a)).toEqual([100, 99, 97, 96]);
    expect(said).toContain('loan=98');
    expect(said).toContain('reports status 1');
  });

  it('is ONE allowance for the whole invocation, not one per chain', async () => {
    // The budget's whole purpose is the invocation's subrequest ceiling,
    // which every chain draws from. A per-chain allowance would let two
    // chains spend sixteen against a limit of about fifty — and then the
    // throw lands in the per-chain catch, costing later chains everything.
    loanRowsByChain = {
      84532: tenLoans().slice(-5),
      421614: tenLoans().slice(-5),
    };
    const { stamps } = await run({ RPC_ARB_SEPOLIA: 'https://stubbed.invalid' });
    expect(stamps.length).toBe(8);
    // Both chains were reached — whichever went first, the second got the
    // remainder rather than nothing.
    expect(new Set(stamps.map((s) => s.chainId)).size).toBe(2);
  });

  it('starts at a different chain as the minute changes', async () => {
    // Without rotation the first chain in the list spends the allowance every
    // tick and the chains behind it are never reached AT ALL — a permanent
    // silence rather than a delay. Each chain here has more due loans than
    // the whole allowance, so whoever goes first takes all of it, and the
    // starting chain is directly observable.
    const withMinute = async (minute: number) => {
      vi.useFakeTimers();
      // A minute of the chosen parity, close to real now so the loans below
      // land inside the notification window either way.
      const m = Math.floor(Date.now() / 60_000);
      const at = (m - (m % 2) + minute) * 60_000;
      vi.setSystemTime(at);
      const nowSec = Math.floor(at / 1000);
      const rows = Array.from({ length: 10 }, (_, k) =>
        periodicLoan(100 - k, nowSec - 29 * DAY + k * 3600),
      );
      loanRowsByChain = { 84532: rows, 421614: rows };
      try {
        const { stamps } = await run({ RPC_ARB_SEPOLIA: 'https://stubbed.invalid' });
        return new Set(stamps.map((s) => s.chainId));
      } finally {
        vi.useRealTimers();
      }
    };
    const even = await withMinute(0);
    const odd = await withMinute(1);
    expect(even.size).toBe(1);
    expect(odd.size).toBe(1);
    expect([...even][0]).not.toBe([...odd][0]);
  });

  it('says nothing about a cap it did not reach', async () => {
    // The ordinary case: a handful of due loans, everything sent, no warning
    // an operator has to learn to ignore.
    loanRows = tenLoans().slice(-3);
    const { stamped, said } = await run();
    expect(stamped.length).toBe(3);
    expect(said).not.toContain('can afford');
  });
});
