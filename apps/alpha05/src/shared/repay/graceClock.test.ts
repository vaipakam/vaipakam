import { describe, expect, it } from 'vitest';
import { GRACE_URGENT_SECONDS, estimatedChainNow, graceClock } from './graceClock';

const READ_AT = 1_700_000_000_000;
const DUE = 1_000_000n;
const END = DUE + 3n * 86_400n;
const at = (chainNow: bigint, maturity: bigint | null = DUE, graceEnd: bigint | null = END) => ({ maturity, graceEnd, chainNow, readAt: READ_AT });

describe('the grace clock on a repayment', () => {
  it('shows nothing before the due date, in fallback or with the dates unread', () => {
    expect(graceClock(at(DUE - 1n), READ_AT)).toEqual({ kind: 'none' });
    expect(graceClock(at(DUE + 10n, null, null), READ_AT)).toEqual({ kind: 'none' });
    expect(graceClock(at(DUE + 10n, DUE, null), READ_AT)).toEqual({ kind: 'none' });
    expect(graceClock(at(DUE + 10n, null, END), READ_AT)).toEqual({ kind: 'none' });
  });

  it('counts down from the due date to the end of grace', () => {
    expect(graceClock(at(DUE), READ_AT)).toEqual({ kind: 'running', endsAt: END, leftSeconds: 3 * 86_400 });
  });

  it('turns urgent with an hour or less left', () => {
    expect(graceClock(at(END - BigInt(GRACE_URGENT_SECONDS) - 1n), READ_AT).kind).toBe('running');
    expect(graceClock(at(END - BigInt(GRACE_URGENT_SECONDS)), READ_AT)).toEqual({ kind: 'urgent', endsAt: END, leftSeconds: GRACE_URGENT_SECONDS });
    expect(graceClock(at(END - 1n), READ_AT)).toEqual({ kind: 'urgent', endsAt: END, leftSeconds: 1 });
  });

  it('counts the last second of grace, which the protocol still accepts', () => {
    expect(graceClock(at(END), READ_AT)).toEqual({ kind: 'urgent', endsAt: END, leftSeconds: 0 });
  });

  it('leaves a read already past grace to the review’s own refusal', () => {
    expect(graceClock(at(END + 1n), READ_AT)).toEqual({ kind: 'none' });
    expect(graceClock(at(END + 1n), READ_AT + 3_600_000)).toEqual({ kind: 'none' });
  });

  it('moves on with the time since the read, by the chain clock read then', () => {
    const d = at(END - 120n);
    expect(graceClock(d, READ_AT + 60_999)).toEqual({ kind: 'urgent', endsAt: END, leftSeconds: 60 });
    expect(graceClock(d, READ_AT + 120_000)).toEqual({ kind: 'urgent', endsAt: END, leftSeconds: 0 });
    expect(graceClock(d, READ_AT + 121_000)).toEqual({ kind: 'ended', endsAt: END });
    // A local clock behind the read never moves the chain clock back.
    expect(estimatedChainNow(d, READ_AT - 5_000)).toBe(END - 120n);
  });
});
