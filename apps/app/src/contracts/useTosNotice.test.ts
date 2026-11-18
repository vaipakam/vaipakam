import { describe, expect, it } from 'vitest';
import {
  LATER_FINAL_WEEK_SEC,
  noticeHiddenByLater,
  tosNoticeOf,
  type TosNotice,
} from './useTosNotice';

const H1 = `0x${'11'.repeat(32)}` as const;
const H2 = `0x${'22'.repeat(32)}` as const;

function base(over: Partial<TosNotice> = {}): TosNotice {
  return { latest: 1, latestHash: H1, minimum: 1, accepted: [1], announced: null, ...over };
}

describe('tosNoticeOf', () => {
  it('shows nothing on a failed read or with no terms in force', () => {
    expect(tosNoticeOf(null)).toEqual({ kind: 'none' });
    expect(tosNoticeOf(base({ latest: 0, accepted: [] }))).toEqual({ kind: 'none' });
  });

  it('shows nothing when the latest is accepted and nothing is announced', () => {
    expect(tosNoticeOf(base())).toEqual({ kind: 'none' });
  });

  it('offers a small change the wallet has not accepted, optionally', () => {
    const n = base({ latest: 2, latestHash: H2, accepted: [1] });
    expect(tosNoticeOf(n)).toEqual({ kind: 'small', version: 2, hash: H2 });
  });

  it('asks about an announced material change with its date', () => {
    const n = base({
      announced: { version: 2, hash: H2, effectiveAt: 5_000, newVersion: true },
    });
    expect(tosNoticeOf(n)).toEqual({ kind: 'material', version: 2, hash: H2, effectiveAt: 5_000 });
  });

  it('asks about a raise of the minimum to a latest the wallet skipped', () => {
    const n = base({
      latest: 2,
      latestHash: H2,
      accepted: [1],
      announced: { version: 2, hash: H2, effectiveAt: 9_000, newVersion: false },
    });
    expect(tosNoticeOf(n)).toEqual({ kind: 'material', version: 2, hash: H2, effectiveAt: 9_000 });
  });

  it('is quiet once the announced version is accepted early', () => {
    const n = base({
      accepted: [1, 2],
      announced: { version: 2, hash: H2, effectiveAt: 5_000, newVersion: true },
    });
    expect(tosNoticeOf(n)).toEqual({ kind: 'none' });
  });
});

describe('noticeHiddenByLater', () => {
  const material = { kind: 'material', version: 2, hash: H2, effectiveAt: 100 * 86_400 } as const;
  const small = { kind: 'small', version: 3, hash: H2 } as const;

  it('never hides without a matching "later"', () => {
    expect(noticeHiddenByLater(material, null, 0)).toBe(false);
    expect(noticeHiddenByLater(material, 1, 0)).toBe(false);
    expect(noticeHiddenByLater(small, 2, 0)).toBe(false);
  });

  it('hides a small change for good once put off', () => {
    expect(noticeHiddenByLater(small, 3, 10 ** 12)).toBe(true);
  });

  it('hides a material change only until its final week', () => {
    const lastHidden = material.effectiveAt - LATER_FINAL_WEEK_SEC - 1;
    expect(noticeHiddenByLater(material, 2, lastHidden)).toBe(true);
    expect(noticeHiddenByLater(material, 2, lastHidden + 1)).toBe(false);
  });
});
