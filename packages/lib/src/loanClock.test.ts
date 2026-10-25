import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import {
  OPEN_PAUSE_END,
  describePauseCredit,
  graceSecondsFromBuckets,
  interestTermEnd,
  loanDeadlines,
  loanMaturity,
  pauseInForceAt,
  pauseLogFromJson,
  pauseLogToJson,
  pausedSecondsAt,
  pausedSecondsBetween,
  periodicPeriod,
  PauseLogTooLongError,
  readPauseLog,
  type PauseLog,
} from './loanClock';

const DAY = 86_400n;

/** Two closed pauses (1 day, then 2 hours) and a manual pause still open —
 *  built the way `LibPausable` appends: `pausedBefore` is the running total. */
const LOG: PauseLog = [
  { start: 1_000_000n, end: 1_000_000n + DAY, pausedBefore: 0n },
  { start: 2_000_000n, end: 2_007_200n, pausedBefore: DAY },
  { start: 3_000_000n, end: OPEN_PAUSE_END, pausedBefore: DAY + 7_200n },
];

describe('pausedSecondsAt — the contract mirror', () => {
  it('is zero before the first pause', () => {
    expect(pausedSecondsAt(LOG, 999_999n)).toBe(0n);
    expect(pausedSecondsAt([], 5_000_000n)).toBe(0n);
  });
  it('counts the part of an interval before t', () => {
    expect(pausedSecondsAt(LOG, 1_000_100n)).toBe(100n);
  });
  it('counts every closed interval after it', () => {
    expect(pausedSecondsAt(LOG, 2_500_000n)).toBe(DAY + 7_200n);
  });
  it('counts an open interval up to t', () => {
    expect(pausedSecondsAt(LOG, 3_000_500n)).toBe(DAY + 7_200n + 500n);
  });
  it('gives the paused time between two moments, zero when reversed', () => {
    expect(pausedSecondsBetween(LOG, 1_500_000n, 2_500_000n)).toBe(7_200n);
    expect(pausedSecondsBetween(LOG, 2_500_000n, 1_500_000n)).toBe(0n);
  });
});

describe('pauseInForceAt', () => {
  it('is true inside an interval and false between them', () => {
    expect(pauseInForceAt(LOG, 1_000_000n)).toBe(true);
    expect(pauseInForceAt(LOG, 1_000_000n + DAY)).toBe(false);
    expect(pauseInForceAt(LOG, 2_500_000n)).toBe(false);
    expect(pauseInForceAt(LOG, 9_000_000n)).toBe(true); // the open manual pause
    expect(pauseInForceAt([], 9_000_000n)).toBe(false);
  });
});

describe('loanDeadlines', () => {
  const loan = { startTime: 500_000n, durationDays: 30n };
  it('moves the due date and grace end by the pauses since the start', () => {
    const d = loanDeadlines(loan, 3n * DAY, LOG, 2_500_000n);
    expect(d.originalMaturity).toBe(500_000n + 30n * DAY);
    expect(d.pauseCredit).toBe(DAY + 7_200n);
    expect(d.maturity).toBe(d.originalMaturity + DAY + 7_200n);
    expect(d.graceEnd).toBe(d.maturity + 3n * DAY);
  });
  it('credits only the pauses after a reset start', () => {
    const d = loanDeadlines({ startTime: 1_500_000n, durationDays: 30n }, 0n, LOG, 2_500_000n);
    expect(d.pauseCredit).toBe(7_200n);
  });
  it('is the original schedule when the protocol was never paused', () => {
    const d = loanDeadlines(loan, DAY, [], 9_000_000n);
    expect(d.maturity).toBe(d.originalMaturity);
    expect(d.pauseCredit).toBe(0n);
  });
  it('gives the same due date through loanMaturity', () => {
    expect(loanMaturity(loan, LOG, 2_500_000n)).toBe(
      loanDeadlines(loan, 3n * DAY, LOG, 2_500_000n).maturity,
    );
  });
});

describe('periodicPeriod', () => {
  it('keeps the unmoved period end as identity and moves only the deadline', () => {
    const p = periodicPeriod(
      { startTime: 500_000n, lastPeriodicInterestSettledAt: 600_000n },
      30n,
      LOG,
      2_500_000n,
    );
    expect(p).not.toBeNull();
    expect(p!.periodEnd).toBe(600_000n + 30n * DAY);
    expect(p!.pauseCredit).toBe(DAY + 7_200n);
    expect(p!.deadline).toBe(p!.periodEnd + DAY + 7_200n);
  });
  it('has no period without a cadence', () => {
    expect(periodicPeriod({ startTime: 1n, lastPeriodicInterestSettledAt: 1n }, 0n, LOG, 2n)).toBeNull();
  });
});

describe('interestTermEnd', () => {
  it('moves the term by the pauses since the interest clock started', () => {
    expect(
      interestTermEnd({ interestAccrualStart: 1_500_000n, interestRemainingDays: 10n }, LOG, 2_500_000n),
    ).toBe(1_500_000n + 10n * DAY + 7_200n);
  });
});

describe('graceSecondsFromBuckets', () => {
  it('is the compile-time schedule for an empty set', () => {
    expect(graceSecondsFromBuckets([], 3n)).toBe(3_600n);
    expect(graceSecondsFromBuckets([], 30n)).toBe(3n * DAY);
    expect(graceSecondsFromBuckets([], 400n)).toBe(30n * DAY);
  });
  it('walks governance buckets like the contract, catch-all last', () => {
    const buckets = [
      { maxDurationDays: 10n, graceSeconds: 100n },
      { maxDurationDays: 0n, graceSeconds: 900n },
    ];
    expect(graceSecondsFromBuckets(buckets, 5n)).toBe(100n);
    expect(graceSecondsFromBuckets(buckets, 10n)).toBe(900n);
  });
});

describe('describePauseCredit', () => {
  it('states the credit exactly, largest unit first, never rounded up', () => {
    expect(describePauseCredit(0n)).toBe('no time');
    expect(describePauseCredit(30n)).toBe('under a minute');
    expect(describePauseCredit(7_200n)).toBe('2 hours');
    expect(describePauseCredit(DAY + 60n)).toBe('1 day 1 minute');
    expect(describePauseCredit(2n * DAY + 3n * 3_600n + 120n)).toBe('2 days 3 hours 2 minutes');
  });
});

describe('pause log JSON', () => {
  it('round-trips, open end included', () => {
    expect(pauseLogFromJson(pauseLogToJson(LOG))).toEqual(LOG);
    expect(pauseLogFromJson([])).toEqual([]);
  });
  it('refuses a damaged log rather than reading it as fewer pauses', () => {
    expect(pauseLogFromJson(null)).toBeNull();
    expect(pauseLogFromJson([{ start: '1', end: '2' }])).toBeNull();
    expect(pauseLogFromJson([{ start: '5', end: '2', pausedBefore: '0' }])).toBeNull();
    // A running total that does not add up.
    const bad = pauseLogToJson(LOG);
    bad[1].pausedBefore = '1';
    expect(pauseLogFromJson(bad)).toBeNull();
    // Overlap.
    expect(
      pauseLogFromJson([
        { start: '10', end: '20', pausedBefore: '0' },
        { start: '15', end: '30', pausedBefore: '10' },
      ]),
    ).toBeNull();
  });
});

/** A viem-shaped revert: `walk` reaches a `ContractFunctionRevertedError`. */
function revertError(inner: Record<string, unknown>): Error {
  const err = new Error('reverted') as Error & { walk: (fn: (x: unknown) => boolean) => unknown };
  const node = { name: 'ContractFunctionRevertedError', ...inner };
  err.walk = (fn) => (fn(node) ? node : null);
  return err;
}

describe('readPauseLog', () => {
  const diamond = '0x0000000000000000000000000000000000000001' as const;

  it('pages the whole log at one block', async () => {
    const calls: { args: readonly bigint[]; blockNumber?: bigint }[] = [];
    const entries = Array.from({ length: 70 }, (_, i) => ({
      start: BigInt(i * 10),
      end: BigInt(i * 10 + 1),
      pausedBefore: BigInt(i),
    }));
    const client = {
      readContract: async (req: { args: readonly bigint[]; blockNumber?: bigint }) => {
        calls.push(req);
        const [from, count] = req.args;
        return [entries.slice(Number(from), Number(from + count)), BigInt(entries.length)];
      },
    } as unknown as PublicClient;
    const log = await readPauseLog({ client, diamond, blockNumber: 42n });
    expect(log).toHaveLength(70);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.blockNumber === 42n)).toBe(true);
  });

  it('refuses, rather than truncates, a log longer than the caller allows', async () => {
    const calls: unknown[] = [];
    const client = {
      readContract: async (req: unknown) => {
        calls.push(req);
        return [[{ start: 1n, end: 2n, pausedBefore: 0n }], 5n];
      },
    } as unknown as PublicClient;
    const err = await readPauseLog({ client, diamond, pageSize: 4n, maxPages: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(PauseLogTooLongError);
    expect((err as PauseLogTooLongError).total).toBe(5n);
    expect(calls).toHaveLength(1);
  });

  it('reads a Diamond without the loan clock as never moving a deadline', async () => {
    const client = {
      readContract: async () => {
        throw revertError({ data: { errorName: 'FunctionDoesNotExist' } });
      },
    } as unknown as PublicClient;
    await expect(readPauseLog({ client, diamond })).resolves.toEqual([]);
    const rawClient = {
      readContract: async () => {
        throw revertError({ raw: '0xa9ad62f8' });
      },
    } as unknown as PublicClient;
    await expect(readPauseLog({ client: rawClient, diamond })).resolves.toEqual([]);
  });

  it('never reads a failed read as an empty log', async () => {
    const client = {
      readContract: async () => {
        throw new Error('fetch failed');
      },
    } as unknown as PublicClient;
    await expect(readPauseLog({ client, diamond })).rejects.toThrow('fetch failed');
    const otherRevert = {
      readContract: async () => {
        throw revertError({ data: { errorName: 'SomethingElse' } });
      },
    } as unknown as PublicClient;
    await expect(readPauseLog({ client: otherRevert, diamond })).rejects.toThrow();
  });
});
