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
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * Every outbound send the lane made this run, in order.
 *
 * The allowance counts SENDS, so a suite whose stubs never send exercises
 * none of it — which is how rounds 5 and 6 shipped a budget that a
 * non-sending candidate could hold (#2213 r7 `4012662252`). Both rails are
 * stubbed and counted here so the cap tests below cost what a real tick costs.
 */
const sends: string[] = [];
/**
 * What the stubbed `sendPush` reports back.
 *
 * It swallows its own failures, so "called" and "made a request" are
 * different answers and the lane must charge from the second (#2213 r9
 * `4012940120`). A stub that always reported success could not see that.
 */
let pushAttemptFor: (subscriber: string) => 'accepted' | 'failed' | 'not-requested';
/** Whether Telegram ACCEPTS the message. `false` = a 401/400 or a dead network. */
let tgAccepts: boolean;
vi.mock('../src/push', () => ({
  sendPush: vi.fn(async (_pk: string, m: { subscriber: string }) => {
    const attempt = pushAttemptFor(m.subscriber);
    if (attempt !== 'not-requested') sends.push(`push:${m.subscriber}`);
    return attempt;
  }),
}));
vi.mock('../src/telegram', () => ({
  sendMessage: vi.fn(async (_t: string, chat: string) => {
    sends.push(`tg:${chat}`);
    return tgAccepts;
  }),
}));

/** Who is subscribed, and how. `null` = no subscription row at all. */
let subscriberFor: (wallet: string) => Record<string, unknown> | null;

/** A subscriber on both rails — four sends for a loan with two of them. */
function bothRails(wallet: string) {
  return {
    wallet,
    push_channel: '0xchannel',
    tg_chat_id: '12345',
    locale: 'en',
    notify_maturity_approaching: 1,
  };
}

/**
 * What the stubbed chain answers for one loan. `null` = that sub-call failed.
 *
 * The struct carries the PERIOD fields as well as id and status, because the
 * rule now checks that the checkpoint the lane is about to speak about is the
 * one the chain is still on (#2213 r12 `4013387394`). `chainSettledAt` lets a
 * case move the chain's last settlement without touching the stored row —
 * which is exactly the "they just paid, the indexer has not caught up" shape.
 */
let answer: (
  loanId: number,
) =>
  | {
      id: bigint;
      status: number;
      periodicInterestCadence?: number;
      lastPeriodicInterestSettledAt?: number;
    }
  | null;
/** When set, the whole batched call throws — the RPC being unreachable. */
let batchError: Error | null = null;
/** When set, the Nth batched call (1-based) and every later one throws. */
let failBatchFrom: number | null = null;
/** How many batched `aggregate3` calls the lane made this run. */
let batchedReads = 0;
/** What the stubbed RPC reports as its current head. */
let headBlock: bigint;
/** What the stubbed RPC says it IS. `null` → it answers with the chain asked for. */
let reportedChainId: number | null;
/** When set, the identity probe cannot answer at all. */
let identityThrows: boolean;
/** What the shared database says the indexer has scanned this chain through. */
let indexedBlock: number | null;
/** Whether reading the indexer cursor FAILS (a different thing from absent). */
let cursorReadFails: boolean;
/** The lane's own persisted scan position, surviving across ticks like D1 does. */
const scanOffsets = new Map<string, number>();
/** Blocks the batched read was pinned to, so the pin can be asserted. */
const pinnedAt: (bigint | undefined)[] = [];
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
    // The transport is tagged with its URL so the stubbed client can answer
    // `eth_chainId` as the chain that URL is configured for — the lane now
    // refuses an endpoint that says it is a different chain (#2213 r14
    // `4013761179`), so a stub answering one id for every chain would look
    // like a mis-pointed secret on all but the first.
    http: (url: string) => ({ __stubUrl: url }),
    createPublicClient: ({ transport }: { transport: { __stubUrl: string } }) => ({
      getChainId: async () => {
        if (identityThrows) throw new Error('transport down');
        return reportedChainId ?? Number(/stub-(\d+)/.exec(transport.__stubUrl)?.[1] ?? 84532);
      },
      getBlockNumber: async () => headBlock,
      readContract: async ({
        functionName,
        args,
        blockNumber,
      }: {
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: bigint;
      }) => {
        if (functionName === 'getPreNotifyDays') return 3;
        if (functionName !== 'aggregate3') {
          throw new Error(`the lane must batch its reads; saw a bare ${functionName}`);
        }
        if (batchError) throw batchError;
        batchedReads += 1;
        if (failBatchFrom !== null && batchedReads >= failBatchFrom) {
          throw new Error('rpc gave out mid-pass');
        }
        pinnedAt.push(blockNumber);
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

/** The stored `last_period_settled_at` for a loan, so the stub can agree with it. */
const settledAtOf = new Map<number, number>();

/** One periodic loan, due inside the window, never pre-notified. */
function periodicLoan(loanId: number, settledAt: number) {
  settledAtOf.set(loanId, settledAt);
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

/** Ten due loans, ids DESCENDING with the deadline, handed back FARTHEST FIRST. */
function tenLoans() {
  // k = 0 is nearest (settled longest ago), and carries the highest id — so
  // neither row order nor id order accidentally produces the right answer.
  const loans = Array.from({ length: 10 }, (_, k) =>
    periodicLoan(100 - k, NOW - 29 * DAY + k * 3600),
  );
  return loans.reverse();
}

/** Run with the clock pinned to a minute of the given parity. */
async function atMinute(minute: number, extra: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  const m = Math.floor(Date.now() / 60_000);
  vi.setSystemTime((m - (m % 2) + minute) * 60_000);
  try {
    return await run(extra);
  } finally {
    vi.useRealTimers();
  }
}

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
      const isSubscriberLookup = sql.includes('FROM user_thresholds');
      const isIndexerCursor =
        sql.includes('FROM indexer_cursor') && sql.includes('kind = ?');
      const isCursorWrite = sql.includes('INSERT INTO indexer_cursor');
      const leaf = (params: unknown[]) => ({
        all: async () => ({ results: rowsFor(params) }),
        first: async () => {
          if (isIndexerCursor) {
            const kind = String(params[1] ?? '');
            if (kind.startsWith('prenotify_')) {
              // The lane's OWN rows — scan position and rotation leader —
              // which persist across ticks exactly as D1 does.
              const at = scanOffsets.get(`${kind}:${Number(params[0])}`);
              return at === undefined ? null : { last_block: at };
            }
            if (cursorReadFails) throw new Error('D1_ERROR: cursor unavailable');
            return indexedBlock === null ? null : { last_block: indexedBlock };
          }
          return isSubscriberLookup ? subscriberFor(String(params[1] ?? '')) : null;
        },
        run: async () => {
          if (isCursorWrite && String(params[1] ?? '').startsWith('prenotify_')) {
            scanOffsets.set(`${String(params[1])}:${Number(params[0])}`, Number(params[2]));
          }
          record(params);
          return { meta: { changes: 0 } };
        },
      });
      return { bind: (...params: unknown[]) => leaf(params), ...leaf([]) };
    },
  };
  return {
    env: {
      DB,
      RPC_BASE_SEPOLIA: 'https://stub-84532.invalid',
      // Both rails configured, so a reminded loan costs the full four sends
      // the lane reserves for one.
      PUSH_CHANNEL_PK: '0xpk',
      TG_BOT_TOKEN: 'bot-token',
      FRONTEND_ORIGIN: 'https://app.example',
      ...extra,
    } as never,
    writes,
  };
}

/**
 * PAY THE COLD IMPORT ONCE, OUTSIDE ANY TEST'S DEADLINE (#2213 r7
 * `4012662256`). `run()` calls `vi.resetModules()` and re-imports the lane,
 * and while the module REGISTRY is cleared each time, the transform is cached
 * — so only the first import is expensive. Left inside the first test it put a
 * multi-second transform under a five-second deadline, which review observed
 * failing twice at ~5.0s and ~5.3s. Worse than the flake itself is what
 * follows it: the timed-out case goes on to restore the warning spy while the
 * NEXT case is running, so one slow import fails two tests and the second
 * failure looks unrelated to the first.
 */
beforeAll(async () => {
  await import('../src/periodicPreNotify');
}, 30_000);

async function run(extra: Record<string, unknown> = {}) {
  vi.resetModules();
  const { env: e, writes } = env(extra);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  warn.mockClear();
  let said: string;
  try {
    const mod = await import('../src/periodicPreNotify');
    await mod.runPeriodicPreNotify(e).catch(() => undefined);
  } finally {
    // RESTORED ON THE WAY OUT, whatever happened. A spy left installed by a
    // throwing or timing-out case is what turns one failure into two, and the
    // second one names a test that is fine.
    said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
  }
  // `UPDATE loans SET period_pre_notified_at = ?, updated_at = ? WHERE chain_id = ? AND loan_id = ?`
  const stamps = writes
    .filter((w) => w.sql.includes('period_pre_notified_at'))
    .map((w) => ({ chainId: Number(w.params[2]), loanId: Number(w.params[3]) }));
  return { writes, said, stamps, stamped: stamps.map((s) => s.loanId) };
}

beforeEach(() => {
  // AGREES WITH THE STORED ROW by default: the ordinary case is a chain and an
  // index that are in step, and every pre-r12 case was written assuming it.
  answer = (id) => ({
    id: BigInt(id),
    status: 0,
    periodicInterestCadence: 1,
    lastPeriodicInterestSettledAt: settledAtOf.get(id) ?? 0,
  });
  batchError = null;
  failBatchFrom = null;
  batchedReads = 0;
  pinnedAt.length = 0;
  headBlock = 1_000n;
  reportedChainId = null;
  identityThrows = false;
  indexedBlock = 900;
  cursorReadFails = false;
  scanOffsets.clear();
  sends.length = 0;
  pushAttemptFor = () => 'accepted';
  tgAccepts = true;
  subscriberFor = (w) => bothRails(w);
  loanRows = [dueLoan];
  loanRowsByChain = null;
});

describe('periodic pre-notify checks the chain before an unretractable send', () => {
  it('does not remind when the chain says the loan has ended', async () => {
    // Status 1 = Repaid. The stored row still says active — that IS the
    // defect this guards, and the reason a stored-status check is not enough.
    answer = (id) => ({ id: BigInt(id), status: 1, periodicInterestCadence: 1 });
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
    answer = () => ({ id: 0n, status: 0, periodicInterestCadence: 1 });
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(said).toContain('no such loan');
  });

  it('does not remind on FallbackPending, which cannot be settled', async () => {
    // #2213 r4 `4012114096`. Non-terminal is not the same as eligible:
    // `settlePeriodicInterest` accepts only `Active` and reverts on anything
    // else, so "your payment is due" here invites an action the contract
    // refuses. Eligibility is the ACTION's precondition, not generic liveness.
    answer = (id) => ({ id: BigInt(id), status: 4, periodicInterestCadence: 1 });
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(said).toContain('reports status 4');
  });

  it('treats a status this build does not recognise as ended', async () => {
    // An allow-list of open states, not a deny-list of terminal ones: a
    // member appended to the enum must not silently become "still running"
    // in a lane that messages users about running loans.
    answer = (id) => ({ id: BigInt(id), status: 99, periodicInterestCadence: 1 });
    const { said } = await run();
    expect(said).toContain('reports status 99');
  });
});

describe('an endpoint that may not be the chain it claims', () => {
  it('sends nothing when the RPC answers a DIFFERENT chain id', async () => {
    // #2213 r14 `4013761179`. An `RPC_*` secret swapped to a foreign network
    // — head past our cursor, plausible state at the same address — answers
    // every read below confidently and wrongly, certifying a foreign loan as
    // running. The indexer has refused this configuration before reading
    // state since #1415; this lane became authoritative in r11 and did not.
    reportedChainId = 1; // Ethereum, not Base Sepolia
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(sends).toEqual([]);
    expect(batchedReads).toBe(0); // it never gets as far as asking
    expect(said).toContain('not this chain');
  });

  it('sends nothing when the RPC cannot say which chain it serves', async () => {
    // An endpoint that cannot answer could BE the mis-pointed one, so an
    // unanswered identity probe stops the chain exactly as a mismatch does.
    // Same rule as the cursor read: an unanswered question is not an answer.
    identityThrows = true;
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(batchedReads).toBe(0);
    expect(said).toContain('could not confirm which chain it serves');
  });
});

describe('a head that cannot confirm anything', () => {
  it('sends nothing when the RPC is behind what the platform has indexed', async () => {
    // #2213 r11 `4013218986`. The chain check exists to catch a stored row
    // whose ending was missed. An endpoint behind the indexer's own cursor
    // still reports such a loan as running, so the check passes and the lane
    // sends the very reminder it was built to withhold — a check that
    // endorses the wrong answer is worse than no check.
    headBlock = 800n;
    indexedBlock = 900;
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(sends).toEqual([]);
    expect(batchedReads).toBe(0); // it does not even ask
    expect(said).toContain('behind the indexed cursor');
  });

  it('proceeds, and pins the read, when the head covers the indexed state', async () => {
    // The ordinary case, and the pin: every loan in a batch is read at ONE
    // block, so a load-balanced endpoint answering one chunk from a node
    // several blocks behind another errors instead of quietly mixing states.
    headBlock = 1_000n;
    indexedBlock = 900;
    const { stamped } = await run();
    expect(stamped).toEqual([7]);
    expect(pinnedAt).toEqual([1_000n]);
  });

  it('sends nothing when the cursor cannot be READ, which is not the same as absent', async () => {
    // #2213 r12 `4013387361`. A transient D1 failure used to look exactly like
    // "no cursor exists" and waved the pass through — so a database hiccup
    // became permission to send on precisely the stale head the comparison
    // exists to catch. An unanswered question is not an answer.
    cursorReadFails = true;
    headBlock = 800n; // and the head IS behind, so the guard matters here
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(batchedReads).toBe(0);
    expect(said).toContain('could not read the indexer cursor');
  });

  it('proceeds when the platform has no cursor for this chain at all', async () => {
    // A chain the indexer has never scanned has no cursor to be behind.
    // Blocking on its absence would silence the lane on a fresh deployment
    // for a comparison that could not have said anything.
    indexedBlock = null;
    const { stamped } = await run();
    expect(stamped).toEqual([7]);
  });
});

describe('what counts as a send, and what only looks like one', () => {
  it('does not charge the allowance when the deployment has no Push signer', async () => {
    // #2213 r8 `4012811567`. `sendPush` returns without issuing anything when
    // `PUSH_CHANNEL_PK` is unset, so charging for it spends the allowance on a
    // request that was never made — the r7 failure one layer down, where the
    // condition that decides whether a request happens was not the condition
    // that charged for it.
    loanRows = [dueLoan];
    const { stamped } = await run({ PUSH_CHANNEL_PK: undefined });
    expect(stamped).toEqual([7]);
    // Telegram still goes out for both counterparties; Push does not, and is
    // not charged for.
    expect(sends).toEqual(['tg:12345', 'tg:12345']);
  });

  it('does not count a subscriber with no usable rail as reminded', async () => {
    // #2213 r8 `4012811575`. A row with both rails empty is a real shape the
    // settings upsert produces. It still STAMPS — there is nothing to retry
    // for them, so re-querying every tick is waste — but reporting it as a
    // reminder would let the operator count claim hundreds were told on a
    // tick that sent nothing.
    loanRows = tenLoans();
    subscriberFor = (w) => ({
      wallet: w,
      push_channel: null,
      tg_chat_id: null,
      locale: 'en',
      notify_maturity_approaching: 1,
    });
    const { stamped, said } = await run();
    expect(sends).toEqual([]);
    // Stamped exactly as before — the semantics that existed are preserved.
    expect(stamped.length).toBe(10);
    // Nothing sent, so the allowance is untouched and there is no stop-early
    // warning to read a count out of. That is why the NEXT test exists: this
    // assertion alone would pass whatever the count did.
    expect(said).toBe('');
  });

  it('reports only the loans that actually sent, when the tick stops early', async () => {
    // The assertion above cannot see the count, so this one makes the count
    // observable: ten loans with no usable rail, then ten fully subscribed.
    // The subscribed ones exhaust the allowance and the warning fires, and it
    // must say EIGHT reminded out of EIGHTEEN examined — not eighteen.
    const ids = Array.from({ length: 20 }, (_, k) => 200 - k); // nearest first
    const noRoute = new Set(ids.slice(0, 10));
    const known = new Map<string, number>();
    loanRows = ids
      .map((id, k) => periodicLoan(id, NOW - 29 * DAY + k * 60))
      .reverse()
      .map((r) => {
        const id = r.loan_id as number;
        const lender = `0x${String(id).padStart(40, '1')}`;
        const borrower = `0x${String(id).padStart(40, '2')}`;
        known.set(lender.toLowerCase(), id);
        known.set(borrower.toLowerCase(), id);
        return { ...r, lender, borrower };
      });
    subscriberFor = (w) => {
      const id = known.get(w.toLowerCase());
      if (id === undefined) return null;
      if (noRoute.has(id)) {
        return {
          wallet: w,
          push_channel: null,
          tg_chat_id: null,
          locale: 'en',
          notify_maturity_approaching: 1,
        };
      }
      return bothRails(w);
    };
    const { said } = await run();
    // 40 requests less two opening reads and one batch read leaves 37;
    // nine loans × 2 counterparties × 2 rails = 36.
    expect(sends.length).toBe(36)
    expect(said).toContain('19 examined, 9 reminded');
    // #2213 r12 `4013387370`: and the ten unreachable ones are accounted for
    // rather than vanishing between "examined" and "reminded".
    expect(said).toContain('10 with nobody to tell');
  });

  it('does not charge — or count — a Push that never left', async () => {
    // #2213 r9 `4012940120`. A malformed channel key is non-empty, so the
    // rail LOOKS usable; `sendPush` then fails inside and returns quietly. On
    // a deployment misconfigured that way every push behaves like this, so
    // charging on "we called it" spends the whole allowance on requests that
    // never happened and defers the recipients the platform could still reach.
    const ids = Array.from({ length: 20 }, (_, k) => 300 - k); // nearest first
    const pushOnly = new Set(ids.slice(0, 10));
    const known = new Map<string, number>();
    loanRows = ids
      .map((id, k) => periodicLoan(id, NOW - 29 * DAY + k * 60))
      .reverse()
      .map((r) => {
        const id = r.loan_id as number;
        const lender = `0x${String(id).padStart(40, '1')}`;
        const borrower = `0x${String(id).padStart(40, '2')}`;
        known.set(lender.toLowerCase(), id);
        known.set(borrower.toLowerCase(), id);
        return { ...r, lender, borrower };
      });
    subscriberFor = (w) => {
      const id = known.get(w.toLowerCase());
      if (id === undefined) return null;
      // The nearest ten are Push-only...
      return pushOnly.has(id) ? { ...bothRails(w), tg_chat_id: null } : bothRails(w);
    };
    // ...and their Push is the one that never leaves.
    pushAttemptFor = (subscriber) => {
      const id = known.get(subscriber.toLowerCase());
      return id !== undefined && pushOnly.has(id) ? 'not-requested' : 'accepted';
    };
    const { said } = await run();
    // Nothing went out for the Push-only ten; the fully-routed loans spend
    // the allowance, eight of them fitting inside it.
    expect(sends.filter((s) => s.startsWith('push:')).length).toBe(18);
    expect(sends.length).toBe(36); // nine loans × 2 counterparties × 2 rails
    // Eighteen examined, and the ten whose only rail never left are NOT among
    // the reminded. Charging on truthiness gave them the allowance and called
    // them reminded.
    expect(said).toContain('19 examined, 9 reminded');
  });

  it('does not remind about a period the chain has already moved past', async () => {
    // #2213 r12 `4013387394`. The loan is legitimately ACTIVE and the stored
    // row is legitimately in the window — the borrower simply paid, and the
    // indexer has not caught up. Every earlier condition passes, and the
    // reminder would land moments after the payment. The chain's own
    // `lastPeriodicInterestSettledAt` was already in the answer being read.
    answer = (id) => ({
      id: BigInt(id),
      status: 0,
      periodicInterestCadence: 1,
      // One period further on than the stored row believes.
      lastPeriodicInterestSettledAt: (settledAtOf.get(id) ?? 0) + 30 * DAY,
    });
    const { stamped, said } = await run();
    expect(stamped).toEqual([]);
    expect(sends).toEqual([]);
    expect(said).toContain('not the one the chain is on');
  });

  it('does not call a rejected delivery a reminder', async () => {
    // #2213 r10 `4013087415`. Telegram answering 401 (a rotated token) and the
    // Push SDK throwing are both REQUESTS — charged, because one may have gone
    // — and neither is evidence that anyone was told. Counting them as
    // reminders lets a run report deliveries it has no basis for, which is the
    // number an operator reads while investigating silence.
    tgAccepts = false;
    pushAttemptFor = () => 'failed';
    const ids = Array.from({ length: 12 }, (_, k) => 400 - k);
    loanRows = ids.map((id, k) => periodicLoan(id, NOW - 29 * DAY + k * 60)).reverse();
    const { stamped, said } = await run();
    // Both rails were issued for eight loans, so the allowance is spent and
    // the stamp behaviour is unchanged — nothing here is about who gets told
    // NEXT tick.
    expect(sends.length).toBe(36);
    expect(stamped.length).toBe(9);
    // ...and the report says plainly that nobody was confirmed reached.
    expect(said).toContain('0 reminded');
    expect(said).toContain('9 reached nobody');
    // TWO rails failed per loan across twelve loans... but only the eight
    // loans the allowance reached were attempted at all: 8 × 2 counterparties
    // × 2 rails.
    expect(said).toContain('36 rail(s) unconfirmed');
  });

  it('counts a loan as reminded when EITHER rail is accepted', async () => {
    // The mirror of the case above, so "0 reminded" cannot be passing because
    // the counter is simply stuck at zero. Push fails, Telegram accepts, and
    // the loan is a reminder — one confirmed rail is enough to have told
    // someone.
    pushAttemptFor = () => 'failed';
    tgAccepts = true;
    // The SAME shape as the case above — twelve loans, both rails issued,
    // eight of them fitting the allowance — so the two differ in exactly one
    // thing: whether Telegram accepted. That is what makes "0 reminded" above
    // a measurement rather than a counter stuck at zero.
    const ids = Array.from({ length: 12 }, (_, k) => 400 - k);
    loanRows = ids.map((id, k) => periodicLoan(id, NOW - 29 * DAY + k * 60)).reverse();
    const { said, stamped } = await run();
    expect(sends.length).toBe(36);
    expect(stamped.length).toBe(9);
    expect(said).toContain('9 reminded');
    expect(said).toContain('0 reached nobody');
    // #2213 r11 `4013218976`: Telegram carried these, and Push failed on every
    // one of them. A run that reported only "8 reminded" would hide a
    // deployment-wide Push outage behind a working second channel.
    expect(said).toContain('18 rail(s) unconfirmed');
  });

  it('still stamps when one side has no route and the other opted out', async () => {
    // Splitting `no-route` out of `sent` must not change WHO gets stamped —
    // that semantics predates this PR (#1056) and nobody asked to change it.
    // Here nothing is sent at all, yet the loan stamps, because the side that
    // was reachable was handled: there is nothing to retry for them.
    const lender = `0x${'1'.repeat(40)}`;
    const borrower = `0x${'2'.repeat(40)}`;
    loanRows = [{ ...dueLoan, lender, borrower }];
    subscriberFor = (w) =>
      w.toLowerCase() === borrower.toLowerCase()
        ? {
            wallet: w,
            push_channel: null,
            tg_chat_id: null,
            locale: 'en',
            notify_maturity_approaching: 1,
          }
        : { ...bothRails(w), notify_maturity_approaching: 0 };
    const { stamped } = await run();
    expect(sends).toEqual([]);
    expect(stamped).toEqual([7]);
  });
});

describe('the invocation spends a bounded allowance, nearest deadline first', () => {
  // #2213 r5 `4012300071`. A Worker invocation has ~50 outbound subrequests
  // and each reminded loan costs up to four, so the lane caps how many it
  // messages about. A cap without an order is what starves a borrower: the
  // database hands back the same rows every tick, so the ones behind them are
  // never reached and miss the very deadline the reminder was for.

  it('reminds only as many as the allowance permits, and takes the nearest', async () => {
    loanRows = tenLoans();
    const { stamped, said } = await run();
    expect(stamped.length).toBe(9);
    // The nine nearest deadlines are ids 100…92; 91 waits.
    expect([...stamped].sort((a, b) => b - a)).toEqual([
      100, 99, 98, 97, 96, 95, 94, 93, 92,
    ]);
    // SAID, with what happens to the rest — a silently dropped reminder is
    // indistinguishable from one that was never due.
    expect(said).toContain('10 loan(s) in the notification window');
    expect(said).toContain('9 examined, 9 reminded');
    expect(said).toContain('outbound-request allowance is down to');
    // 8 loans × 2 counterparties × 2 rails.
    expect(sends.length).toBe(36);
  });

  it('matches each answer to the loan it was asked about', async () => {
    // The batch returns an ARRAY, and the candidates are a separate array;
    // pairing them by position is only correct if nothing reorders in
    // between. Here exactly one loan in the middle has ended, so a lane that
    // read the wrong slot would withhold the wrong borrower's reminder —
    // and, worse, send the one it was supposed to withhold.
    loanRows = tenLoans().slice(-5); // ids 96…100 — the five nearest deadlines
    answer = (id) => ({
      id: BigInt(id),
      status: id === 98 ? 1 : 0,
      periodicInterestCadence: 1,
      lastPeriodicInterestSettledAt: settledAtOf.get(id) ?? 0,
    });
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
    const { stamps } = await run({ RPC_ARB_SEPOLIA: 'https://stub-421614.invalid' });
    // TWO chains pay two openings (2 reads each plus a batch read), so the
    // shared allowance covers eight loans here where one chain covers nine —
    // which is the point: the reads come out of the same budget as the sends.
    expect(stamps.length).toBe(8);
    // Both chains were reached — whichever went first, the second got the
    // remainder rather than nothing.
    expect(new Set(stamps.map((s) => s.chainId)).size).toBe(2);
  });

  it('leads with a different chain on each invocation, remembering which', async () => {
    // #2213 r13 `4013571003`. This rotation was `minute % chains.length` —
    // the same clock aliasing r12 retired one level down, which I left in
    // place here without noticing. At a `*/3` schedule with three chains the
    // minute is always a multiple of three, so one chain leads every tick and
    // could hold the shared allowance forever. It is remembered now, so this
    // test manipulates no clock: two consecutive invocations, different
    // leaders.
    const rows = Array.from({ length: 10 }, (_, k) =>
      periodicLoan(100 - k, NOW - 29 * DAY + k * 3600),
    ).reverse();
    loanRowsByChain = { 84532: rows, 421614: rows };
    const first = await run({ RPC_ARB_SEPOLIA: 'https://stub-421614.invalid' });
    const second = await run({ RPC_ARB_SEPOLIA: 'https://stub-421614.invalid' });
    const leaderOf = (stamps: { chainId: number }[]) => stamps[0]?.chainId;
    expect(leaderOf(first.stamps)).toBeDefined();
    expect(leaderOf(second.stamps)).toBeDefined();
    expect(leaderOf(first.stamps)).not.toBe(leaderOf(second.stamps));
  });

  it('scans PAST loans the chain rejects, in the same tick', async () => {
    // #2213 r6 `4012464544`. Round 5 read and messaged inside ONE slice of
    // `budget.remaining`, so a rejected candidate held a read slot while
    // spending no allowance. Eight orphans at the head of the deadline order
    // therefore filled the slice on every tick, forever, and the eligible
    // loans behind them were never looked at — a cap meant to defer a loan by
    // a tick deferred those indefinitely.
    loanRows = tenLoans(); // ids 100…91, nearest deadline first
    // The nearest eight are orphans: the chain has no such loan. The two
    // behind them are healthy and inside their own window.
    const orphans = new Set([100, 99, 98, 97, 96, 95, 94, 93]);
    answer = (id) => ({
      id: orphans.has(id) ? 0n : BigInt(id),
      status: 0,
      periodicInterestCadence: 1,
      lastPeriodicInterestSettledAt: settledAtOf.get(id) ?? 0,
    });
    const { stamped, said } = await run();
    expect([...stamped].sort((a, b) => b - a)).toEqual([92, 91]);
    expect(said).toContain('no such loan');
    // One batch covered all ten — the scan does not pay a read per loan to do
    // this.
    expect(batchedReads).toBe(1);
  });

  it('does not let opted-out loans hold the allowance', async () => {
    // #2213 r7 `4012662252`. The same failure as the rejected-candidate one,
    // a door further in: the eight nearest loans have both counterparties
    // opted out, so nothing is sent AND nothing is stamped (an opt-out is
    // deliberately not stamped — the user may re-enable before the deadline).
    // Charging them a loan slot, as rounds 5 and 6 did, meant they consumed
    // the whole allowance on every tick while the subscribed borrowers behind
    // them were never reached.
    loanRows = tenLoans(); // ids 100…91, nearest deadline first
    const optedOut = new Set([100, 99, 98, 97, 96, 95, 94, 93]);
    // The subscriber rows are per WALLET, so the opted-out loans get their own
    // counterparties rather than sharing the shared test pair.
    const wallets = new Map<string, number>();
    loanRows = loanRows.map((r) => {
      const id = r.loan_id as number;
      const lender = `0x${String(id).padStart(40, '1')}`;
      const borrower = `0x${String(id).padStart(40, '2')}`;
      wallets.set(lender.toLowerCase(), id);
      wallets.set(borrower.toLowerCase(), id);
      return { ...r, lender, borrower };
    });
    subscriberFor = (w) => {
      const id = wallets.get(w.toLowerCase());
      if (id === undefined) return null;
      const row = bothRails(w);
      return optedOut.has(id) ? { ...row, notify_maturity_approaching: 0 } : row;
    };
    const { stamped } = await run();
    // The two subscribed loans are reminded in the SAME tick, and only they
    // cost anything: 2 loans × 2 counterparties × 2 rails.
    expect([...stamped].sort((a, b) => b - a)).toEqual([92, 91]);
    expect(sends.length).toBe(8);
  });

  it('never overshoots the ceiling, even when loans cost different amounts', async () => {
    // The allowance only divides evenly by chance. Give the nearest loan one
    // subscribed counterparty instead of two and the running total stops
    // landing on a multiple of four — so a tick that merely checks "is there
    // anything left" starts a four-send loan with two left and overshoots.
    // Nothing inside a loan re-checks (stopping mid-loan would stamp the
    // checkpoint with one side never told), so refusing to begin is the only
    // place the ceiling can be held.
    loanRows = Array.from({ length: 12 }, (_, k) =>
      periodicLoan(100 - k, NOW - 29 * DAY + k * 3600),
    ).reverse();
    const lenderOf = (id: number) => `0x${String(id).padStart(40, '1')}`;
    const borrowerOf = (id: number) => `0x${String(id).padStart(40, '2')}`;
    const known = new Map<string, number>();
    loanRows = loanRows.map((r) => {
      const id = r.loan_id as number;
      known.set(lenderOf(id).toLowerCase(), id);
      known.set(borrowerOf(id).toLowerCase(), id);
      return { ...r, lender: lenderOf(id), borrower: borrowerOf(id) };
    });
    subscriberFor = (w) => {
      const id = known.get(w.toLowerCase());
      if (id === undefined) return null;
      // Loan 100 (the nearest) has no lender subscription: two sends, not four.
      if (id === 100 && w.toLowerCase() === lenderOf(100).toLowerCase()) return null;
      return bothRails(w);
    };
    const { stamped } = await run();
    // 37 sendable after the three reads: 2 + 4×8 = 34 spent, 3 left, and the
    // ninth full-cost loan is refused rather than begun.
    expect(sends.length).toBe(34);
    expect(sends.length).toBeLessThanOrEqual(37);
    expect(stamped.length).toBe(9);
  });

  it('RESUMES where it stopped, so a wide window cannot hide its tail', async () => {
    // #2213 r8 `4012464544` found the starvation; r12 `4013387382` found that
    // the clock-derived rotation which fixed it aliased with the chain
    // rotation — a chain scanned every third tick sees the minute advance in
    // threes, so `minute % spans` can be constant on every opportunity it
    // gets. The position is stored now and advances on its own progress, so
    // this test manipulates no clock at all: that is the property being
    // bought.
    const N = 350;
    const ids = Array.from({ length: N }, (_, k) => 1000 - k); // nearest first
    loanRows = ids
      .map((id, k) => periodicLoan(id, NOW - 29 * DAY + k * 60))
      .reverse();
    // The first 300 have opted out: they send nothing, are never stamped, and
    // never leave the front of the deadline order.
    const optedOut = new Set(ids.slice(0, 300));
    const known = new Map<string, number>();
    loanRows = loanRows.map((r) => {
      const id = r.loan_id as number;
      const lender = `0x${String(id).padStart(40, '1')}`;
      const borrower = `0x${String(id).padStart(40, '2')}`;
      known.set(lender.toLowerCase(), id);
      known.set(borrower.toLowerCase(), id);
      return { ...r, lender, borrower };
    });
    subscriberFor = (w) => {
      const id = known.get(w.toLowerCase());
      if (id === undefined) return null;
      const row = bothRails(w);
      return optedOut.has(id) ? { ...row, notify_maturity_approaching: 0 } : row;
    };

    const first = await run();
    expect(first.stamped).toEqual([]); // the whole first pass is opted-out
    expect(first.said).toContain('300 examined');
    const second = await run();
    // The tail is reached on the very next tick, with no clock involved.
    expect(second.stamped.length).toBeGreaterThan(0);
    expect(second.stamped.every((id) => !optedOut.has(id))).toBe(true);
    expect(second.said).toContain('resumed at 300');
  });

  it('does not claim a remainder when a RESUMED pass finishes the window', async () => {
    // #2213 r13 `4013571024`. A pass that resumes at 7 in a 10-row window
    // examines 3 and reaches the end — `examined` is 3, which is less than
    // the window, but there is nothing left. Testing the count rather than the
    // cursor announced a remainder the tick had just consumed, telling an
    // operator the run was partial when it had completed.
    loanRows = tenLoans();
    scanOffsets.set('prenotify_scan:84532', 7);
    const { stamped, said } = await run();
    expect(stamped.length).toBe(3);
    expect(said).toBe('');
  });

  it('starts over once it has been round the window', async () => {
    // The position wraps rather than running off the end, so a window that
    // shrinks below the stored offset is not skipped entirely.
    scanOffsets.set('prenotify_scan:84532', 5_000);
    loanRows = tenLoans();
    const { stamped } = await run();
    expect(stamped.length).toBe(9);
  });

  it('names the allowance when it stops one request short of a batch', async () => {
    // #2213 r14 `4013761165`. The loop needs a batch read AND a loan's sends
    // to continue, so a tick that finishes a batch with exactly four requests
    // left was stopped by the allowance — and the stop reason tested only
    // four, so it reported a bare "stopping" and told an operator nothing.
    const ids = Array.from({ length: 150 }, (_, k) => 3000 - k);
    const known = new Map<string, number>();
    loanRows = ids
      .map((id, k) => periodicLoan(id, NOW - 29 * DAY + k * 60))
      .reverse()
      .map((r) => {
        const id = r.loan_id as number;
        const lender = `0x${String(id).padStart(40, '1')}`;
        const borrower = `0x${String(id).padStart(40, '2')}`;
        known.set(lender.toLowerCase(), id);
        known.set(borrower.toLowerCase(), id);
        return { ...r, lender, borrower };
      });
    // The nearest eight cost four requests each (32); the other ninety-two in
    // the batch cost nothing. Four opening reads plus 32 leaves exactly four —
    // one short of the five the next batch needs.
    const routed = new Set(ids.slice(0, 8));
    subscriberFor = (w) => {
      const id = known.get(w.toLowerCase());
      if (id === undefined) return null;
      if (routed.has(id)) return bothRails(w);
      return {
        wallet: w,
        push_channel: null,
        tg_chat_id: null,
        locale: 'en',
        notify_maturity_approaching: 1,
      };
    };
    const { said } = await run();
    expect(sends.length).toBe(32);
    expect(said).toContain('outbound-request allowance is down to 4');
  });

  it('keeps what earlier batches did when a later read fails', async () => {
    // #2213 r12 `4013387389`. The first batch may already have sent messages
    // and stamped checkpoints permanently. Returning on the second batch's
    // failure discarded those counters and skipped the summary, so an RPC
    // incident showed an operator only "not pre-notifying this tick" — while
    // deliveries and failed rails from the completed batch went unreported.
    failBatchFrom = 2;
    const ids = Array.from({ length: 150 }, (_, k) => 2000 - k);
    const known = new Map<string, number>();
    loanRows = ids
      .map((id, k) => periodicLoan(id, NOW - 29 * DAY + k * 60))
      .reverse()
      .map((r) => {
        const id = r.loan_id as number;
        const lender = `0x${String(id).padStart(40, '1')}`;
        const borrower = `0x${String(id).padStart(40, '2')}`;
        known.set(lender.toLowerCase(), id);
        known.set(borrower.toLowerCase(), id);
        return { ...r, lender, borrower };
      });
    // Only two of the first hundred are reachable, so the first batch does
    // real work WITHOUT exhausting the allowance — which is what lets the scan
    // reach a second batch at all.
    const reachable = new Set([2000, 1999]);
    subscriberFor = (w) => {
      const id = known.get(w.toLowerCase());
      if (id === undefined) return null;
      if (reachable.has(id)) return bothRails(w);
      return {
        wallet: w,
        push_channel: null,
        tg_chat_id: null,
        locale: 'en',
        notify_maturity_approaching: 1,
      };
    };
    const { stamped, said } = await run();
    // The completed batch's work survives: a hundred loans handled, two of
    // them actually messaged.
    expect(stamped.length).toBe(100);
    expect(said).toContain('100 examined, 2 reminded');
    expect(said).toContain('98 with nobody to tell');
    // The failure is still stated, and described as THIS batch's.
    expect(said).toContain('status read failed');
  });

  it('stops scanning at the read cap, and says what it found', async () => {
    // The residue, stated rather than implied: a window whose first three
    // hundred candidates are all rejected still defers whatever is behind
    // them. That is a chain with three hundred orphaned rows — an operator
    // problem the scan REPORTS rather than a load problem it absorbs.
    loanRows = Array.from({ length: 350 }, (_, k) =>
      periodicLoan(1000 - k, NOW - 29 * DAY + k * 60),
    ).reverse();
    answer = () => ({ id: 0n, status: 0 }); // every one an orphan
    // THE MINUTE IS PINNED because the scan start rotates once the window
    // exceeds one tick's reach (#2213 r8) — 350 candidates is two spans, so an
    // unpinned clock would scan 300 on one tick and 50 on the next and this
    // assertion would flake. Span 1 is the one with a full read cap to hit.
    const { stamped, said } = await atMinute(0);
    expect(stamped).toEqual([]);
    expect(batchedReads).toBe(3); // 3 × 100, not 350 reads and not one
    expect(said).toContain('300 examined');
    expect(said).toContain('300 rejected by the chain');
    expect(said).toContain('read cap');
  });

  it('says nothing about a cap it did not reach', async () => {
    // The ordinary case: a handful of due loans, everything sent, no warning
    // an operator has to learn to ignore.
    loanRows = tenLoans().slice(-3);
    const { stamped, said } = await run();
    expect(stamped.length).toBe(3);
    expect(said).not.toContain('in the notification window');
  });
});
