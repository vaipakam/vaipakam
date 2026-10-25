import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { inTermOnLoanClock } from '../src/loanClockReads';

const DIAMOND = '0x0000000000000000000000000000000000000d1a' as const;
const DAY = 86_400n;
const START = 1_000_000n;
const loan = { startTime: START, durationDays: 10n };
const ORIGINAL_END = START + 10n * DAY;

const client = (answer: () => unknown): PublicClient =>
  ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName !== 'getPauseIntervals') throw new Error(`unexpected ${functionName}`);
      return answer();
    },
  }) as unknown as PublicClient;

describe('inTermOnLoanClock (#2808)', () => {
  it('keeps a loan in term past its original due date while a pause credit covers it', async () => {
    // Paused for two days while the loan was open: due two days later.
    const log = [{ start: START + DAY, end: START + 3n * DAY, pausedBefore: 0n }];
    const at = ORIGINAL_END + DAY;
    expect(await inTermOnLoanClock(client(() => [log, 1n]), DIAMOND, loan, at)).toEqual({
      known: true,
      inTerm: true,
    });
    expect(
      await inTermOnLoanClock(client(() => [log, 1n]), DIAMOND, loan, ORIGINAL_END + 2n * DAY),
    ).toEqual({ known: true, inTerm: false });
  });

  it('is the original schedule when the protocol was never paused', async () => {
    const r = await inTermOnLoanClock(client(() => [[], 0n]), DIAMOND, loan, ORIGINAL_END + 1n);
    expect(r).toEqual({ known: true, inTerm: false });
  });

  it('says the answer is unknown, never the original date, when the log does not read', async () => {
    const r = await inTermOnLoanClock(
      client(() => {
        throw new Error('HTTP request failed. URL: https://rpc.example/v2/SECRETKEY123 Status: 503');
      }),
      DIAMOND,
      loan,
      ORIGINAL_END + DAY,
    );
    expect(r.known).toBe(false);
    expect(r.known === false && r.reason).toMatch(/pause log unread/);
    // Never the raw message: it carries the RPC URL and its key.
    expect(r.known === false && r.reason).not.toMatch(/SECRETKEY123/);
  });
});
