import { describe, expect, it } from 'vitest';
import { settlementState } from './schedule';
import type { PeriodSchedule } from './loanView';

const s: PeriodSchedule = { cadence: 1, periodEndAt: 1_000n, graceEndsAt: 1_100n, expected: 50n, paid: 20n, shortfall: 30n, canSettleNow: false };

describe('settlementState', () => {
  it('names the switch first, then the pause, each unread on its own', () => {
    expect(settlementState(s, false, true, 2_000n).kind).toBe('off');
    expect(settlementState(s, null, false, 2_000n).kind).toBe('switch-unread');
    expect(settlementState({ ...s, canSettleNow: true }, true, true, 2_000n).kind).toBe('paused');
    expect(settlementState(s, true, null, 2_000n).kind).toBe('pause-unread');
  });

  it('places a period the protocol does not call settleable by the block time: running, then in its grace', () => {
    expect(settlementState(s, true, false, 900n)).toEqual({ kind: 'running', ended: false, graceEndsAt: 1_100n, shortfall: 30n });
    expect(settlementState(s, true, false, 1_000n)).toEqual({ kind: 'running', ended: true, graceEndsAt: 1_100n, shortfall: 30n });
  });

  it('never announces a sale the preview refuses: past grace and not callable is a loan that is not running', () => {
    expect(settlementState(s, true, false, 1_100n)).toEqual({ kind: 'held' });
    expect(settlementState({ ...s, canSettleNow: true }, true, false, 1_100n)).toEqual({ kind: 'due', shortfall: 30n });
  });

  it("takes the protocol's own callable-now over the block time", () => {
    expect(settlementState({ ...s, canSettleNow: true, shortfall: 0n }, true, false, null)).toEqual({ kind: 'due', shortfall: 0n });
    expect(settlementState(s, true, false, null).kind).toBe('time-unread');
  });

  it('states the switch and the pause even when the period could not be read', () => {
    expect(settlementState(null, false, false, 2_000n).kind).toBe('off');
    expect(settlementState(null, true, true, 2_000n).kind).toBe('paused');
    expect(settlementState(null, null, false, 2_000n).kind).toBe('switch-unread');
    expect(settlementState(null, true, false, 2_000n).kind).toBe('period-unread');
  });
});
