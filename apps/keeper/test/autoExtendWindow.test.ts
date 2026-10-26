import { describe, it, expect } from 'vitest';
import { BaseError, ContractFunctionRevertedError, zeroAddress, type Address } from 'viem';
import { AutoLifecycleFacetABI } from '@vaipakam/contracts/abis';
import {
  AUTO_EXTEND_WINDOW_SELECTOR,
  EXTEND_WINDOW_SECONDS,
  contractWindowVerdict,
  extendWindowVerdict,
  readContractWindow,
  readExtendWindowSource,
  type ExtendClock,
} from '../src/autoLifecycle';

const DAY = 86_400n;
const START = 1_800_000_000n;

/** The contract's default grace schedule (no governance buckets). */
const NO_PAUSE: ExtendClock = { pauseLog: [], graceBuckets: [] };

describe('interim auto-extend window (#2738, removed by #2921)', () => {
  // A 30-day loan: due START + 30d, default grace for 30 days = 3 days.
  const loan = { startTime: START, durationDays: 30n };
  const due = START + 30n * DAY;

  it('is closed until three days before the due date', () => {
    expect(EXTEND_WINDOW_SECONDS).toBe(3n * DAY);
    // Day 2 of a 30-day loan: the re-term the issue reports, refused.
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, START + 2n * DAY)).toMatch(/^window opens at /);
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due - EXTEND_WINDOW_SECONDS - 1n)).toMatch(/^window opens at /);
  });

  it('is open from three days before the due date to the end of grace', () => {
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due - EXTEND_WINDOW_SECONDS)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due + 3n * DAY)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due + 3n * DAY + 1n)).toMatch(/^past grace/);
  });

  it('measures the window on the pause-adjusted due date', () => {
    // A two-day pause during the loan moves its due date two days later, so
    // the window that would have opened at due - 3d opens at due - 1d.
    const paused: ExtendClock = {
      pauseLog: [{ start: START + 5n * DAY, end: START + 7n * DAY, pausedBefore: 0n }],
      graceBuckets: [],
    };
    const now = due - 2n * DAY;
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, now)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, paused, now)).toMatch(/^window opens at /);
    expect(extendWindowVerdict(loan, 30n, paused, due - DAY)).toBeNull();
  });

  it('refuses a term that would make the loan defaultable sooner', () => {
    // A 365-day loan carries 30 days of grace. A 7-day term carries one day,
    // so even though its end moves later, its grace end lands earlier.
    const long = { startTime: START, durationDays: 365n };
    const longDue = START + 365n * DAY;
    const now = longDue - DAY;
    expect(extendWindowVerdict(long, 7n, NO_PAUSE, now)).toMatch(/defaultable sooner/);
    // A 30-day term from the start of the window lands exactly on the old
    // grace end (now + 30d + 3d = due - 3d + 33d), which is allowed.
    expect(extendWindowVerdict(long, 30n, NO_PAUSE, longDue - EXTEND_WINDOW_SECONDS)).toBeNull();
  });

  it('reads the grace length from the chain\'s buckets', () => {
    // Governance buckets: under 60 days get 10 days of grace, longer ones 1.
    const clock: ExtendClock = {
      pauseLog: [],
      graceBuckets: [
        { maxDurationDays: 60n, graceSeconds: 10n * DAY },
        { maxDurationDays: 0n, graceSeconds: DAY },
      ],
    };
    // Old grace end = due + 10d. A 30-day term from due - 1d ends due + 29d,
    // grace end due + 39d: allowed. The window still closes at due + 10d.
    expect(extendWindowVerdict(loan, 30n, clock, due - DAY)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, clock, due + 10n * DAY + 1n)).toMatch(/^past grace/);
  });

  it('refuses a term that does not move the due date later', () => {
    // From three days before the due date, a 2-day term ends a day early.
    expect(extendWindowVerdict(loan, 2n, NO_PAUSE, due - EXTEND_WINDOW_SECONDS)).toMatch(/would not move the due date/);
  });
});

const DIAMOND = '0x00000000000000000000000000000000000d1a30' as Address;
const HOST = '0x0000000000000000000000000000000000000f0c' as Address;

/** A read that reverts with `errorName`, the way viem surfaces one. */
function revert(errorName: string): Error {
  const inner = new ContractFunctionRevertedError({
    abi: AutoLifecycleFacetABI as never,
    functionName: 'getAutoExtendWindow',
    data: '0x',
  });
  (inner as { data?: unknown }).data = { errorName, args: [] };
  return new BaseError('reverted', { cause: inner });
}

describe('window source (#2738 contract half)', () => {
  it('uses the contract view where the loupe routes it, and reads no loan clock', async () => {
    const calls: string[] = [];
    const client = {
      readContract: async (req: { functionName: string; args?: readonly unknown[] }) => {
        calls.push(req.functionName);
        expect(req.args).toEqual([AUTO_EXTEND_WINDOW_SELECTOR]);
        return HOST;
      },
    };
    expect(await readExtendWindowSource(client as never, DIAMOND)).toEqual({ kind: 'contract' });
    expect(calls).toEqual(['facetAddress']);
  });

  it('falls back to the interim copy on a Diamond that predates the view', async () => {
    const calls: string[] = [];
    const client = {
      readContract: async (req: { functionName: string }) => {
        calls.push(req.functionName);
        if (req.functionName === 'facetAddress') return zeroAddress;
        if (req.functionName === 'getGraceBuckets') return [];
        if (req.functionName === 'getPauseIntervals') return [[], 0n];
        throw new Error(`unexpected ${req.functionName}`);
      },
    };
    const source = await readExtendWindowSource(client as never, DIAMOND);
    expect(source.kind).toBe('interim');
    expect(calls[0]).toBe('facetAddress');
    expect(calls).toContain('getGraceBuckets');
  });

  it('throws when the loupe does not read, so the chain is skipped', async () => {
    const client = { readContract: async () => { throw new Error('rpc down'); } };
    await expect(readExtendWindowSource(client as never, DIAMOND)).rejects.toThrow('rpc down');
  });
});

describe('contract window (#2738)', () => {
  const OPENS = 1_800_000_000n;
  const CLOSES = OPENS + 6n * DAY;

  it('is open between the published bounds, both inclusive', () => {
    expect(contractWindowVerdict(OPENS, CLOSES, OPENS - 1n)).toBe(`window opens at ${OPENS}`);
    expect(contractWindowVerdict(OPENS, CLOSES, OPENS)).toBeNull();
    expect(contractWindowVerdict(OPENS, CLOSES, CLOSES)).toBeNull();
    expect(contractWindowVerdict(OPENS, CLOSES, CLOSES + 1n)).toBe(`past grace (ended ${CLOSES})`);
  });

  it('reads the loan\'s window from the view', async () => {
    const client = {
      readContract: async (req: { functionName: string; args?: readonly unknown[] }) => {
        expect(req.functionName).toBe('getAutoExtendWindow');
        expect(req.args).toEqual([7n]);
        return [OPENS, CLOSES] as const;
      },
    };
    expect(await readContractWindow(client as never, DIAMOND, 7n, OPENS + DAY)).toBeNull();
    expect(await readContractWindow(client as never, DIAMOND, 7n, OPENS - DAY)).toMatch(/^window opens at /);
  });

  it('skips a loan that left Active since its page was read', async () => {
    const client = { readContract: async () => { throw revert('LoanNotActive'); } };
    expect(await readContractWindow(client as never, DIAMOND, 7n, OPENS)).toBe('no longer active');
  });

  it('leaves the loan for the next run when the view does not read', async () => {
    const client = { readContract: async () => { throw new Error('rpc down'); } };
    expect(await readContractWindow(client as never, DIAMOND, 7n, OPENS)).toMatch(/^window unread — /);
  });
});
