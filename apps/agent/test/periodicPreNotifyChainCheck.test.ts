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
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the stubbed chain answers for `getLoanDetails`. */
let chainStatus: number | Error = 0;
/** The `id` field of that answer — `0` is the zero struct of a loan that does not exist. */
let chainLoanId = 7;

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getPreNotifyDays') return 3;
        if (chainStatus instanceof Error) throw chainStatus;
        return { id: BigInt(chainLoanId), status: chainStatus };
      },
    }),
  };
});

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** One periodic loan, due inside the window, never pre-notified. */
const dueLoan = {
  loan_id: 7,
  chain_id: 84532,
  lender: '0x1111111111111111111111111111111111111111',
  borrower: '0x2222222222222222222222222222222222222222',
  periodic_interest_cadence: 1,
  last_period_settled_at: NOW - 29 * DAY,
  period_pre_notified_at: null,
};

function env() {
  const writes: string[] = [];
  const DB = {
    prepare(sql: string) {
      const isLoanScan = sql.includes('periodic_interest_cadence') && sql.includes('FROM loans');
      if (!sql.trim().startsWith('SELECT')) writes.push(sql);
      return {
        bind: () => ({
          all: async () => ({ results: isLoanScan ? [dueLoan] : [] }),
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } }),
        }),
        all: async () => ({ results: isLoanScan ? [dueLoan] : [] }),
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
  };
  return { env: { DB, RPC_BASE_SEPOLIA: 'https://stubbed.invalid' } as never, writes };
}

async function run() {
  vi.resetModules();
  const { env: e, writes } = env();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  warn.mockClear();
  const mod = await import('../src/periodicPreNotify');
  await mod.runPeriodicPreNotify(e).catch(() => undefined);
  const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
  warn.mockRestore();
  return { writes, said };
}

beforeEach(() => {
  chainStatus = 0;
  chainLoanId = 7;
});

describe('periodic pre-notify checks the chain before an unretractable send', () => {
  it('does not remind when the chain says the loan has ended', async () => {
    // Status 1 = Repaid. The stored row still says active — that IS the
    // defect this guards, and the reason a stored-status check is not enough.
    chainStatus = 1;
    const { writes, said } = await run();
    // Nothing stamped: no delivery happened, so the checkpoint stays open for
    // a later tick if the row turns out to be right after all.
    expect(writes.join('\n')).not.toContain('period_pre_notified_at');
    expect(said).toContain('reports status 1');
  });

  it('does not remind when the status read FAILS', async () => {
    // Sending on a failed read would choose the unretractable outcome on no
    // evidence. Skipping costs a tick, and the window is days wide.
    chainStatus = new Error('rpc unavailable');
    const { writes, said } = await run();
    expect(writes.join('\n')).not.toContain('period_pre_notified_at');
    expect(said).toContain('status read');
  });

  it('proceeds when the chain confirms the loan is still open', async () => {
    // The ordinary case must not be collateral damage of the guard.
    chainStatus = 0;
    const { said } = await run();
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
    chainLoanId = 0;
    chainStatus = 0;
    const { writes, said } = await run();
    expect(writes.join('\n')).not.toContain('period_pre_notified_at');
    expect(said).toContain('no such loan');
  });

  it('does not remind on FallbackPending, which cannot be settled', async () => {
    // #2213 r4 `4012114096`. Non-terminal is not the same as eligible:
    // `settlePeriodicInterest` accepts only `Active` and reverts on anything
    // else, so "your payment is due" here invites an action the contract
    // refuses. Eligibility is the ACTION's precondition, not generic liveness.
    chainStatus = 4;
    const { writes, said } = await run();
    expect(writes.join('\n')).not.toContain('period_pre_notified_at');
    expect(said).toContain('reports status 4');
  });

  it('treats a status this build does not recognise as ended', async () => {
    // An allow-list of open states, not a deny-list of terminal ones: a
    // member appended to the enum must not silently become "still running"
    // in a lane that messages users about running loans.
    chainStatus = 99;
    const { said } = await run();
    expect(said).toContain('reports status 99');
  });
});
