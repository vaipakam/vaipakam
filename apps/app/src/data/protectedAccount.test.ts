/**
 * Protected account mode — the pure classification the protection page
 * renders from. The order matters: the contract checks the lock first,
 * then the release time, then the co-signature, so a row is described by
 * the FIRST thing that would refuse its release.
 */
import { describe, expect, it } from 'vitest';
import { additionStatus, chainNowOf, hasReplacement, isDue, isManager, payoutStatus, type ProtectedAccountRecord } from './protectedAccount';

const ACCOUNT = '0x00000000000000000000000000000000000000a1';
const CONTROLLER = '0x00000000000000000000000000000000000000c2';
const ZERO = '0x0000000000000000000000000000000000000000';

const record = (over: Partial<ProtectedAccountRecord> = {}): ProtectedAccountRecord => ({
  enabled: true,
  locked: false,
  protectNfts: false,
  requireCosign: false,
  retired: false,
  delaySeconds: 172_800,
  pendingDelay: 0,
  pendingDelayAt: 0n,
  pendingDisableAt: 0n,
  pendingUnlockAt: 0n,
  pendingNftOffAt: 0n,
  pendingCosignOffAt: 0n,
  cooldownUntil: 0n,
  lockedAt: 0n,
  lockedBy: ZERO,
  controller: ZERO,
  pendingUnpinAt: 0n,
  ...over,
});

describe('payoutStatus', () => {
  const row = { releaseAt: 1_000n, cosigned: false };

  it('reports the lock before anything else', () => {
    expect(payoutStatus(row, record({ locked: true, requireCosign: true }), 5_000n)).toBe('locked');
  });

  it('waits until the release time', () => {
    expect(payoutStatus(row, record(), 999n)).toBe('waiting');
  });

  it('is due at exactly the release time', () => {
    expect(payoutStatus(row, record(), 1_000n)).toBe('due');
  });

  it('needs a co-signature only when the account requires one', () => {
    expect(payoutStatus(row, record({ requireCosign: true }), 1_000n)).toBe('needsCosign');
    expect(payoutStatus({ ...row, cosigned: true }, record({ requireCosign: true }), 1_000n)).toBe('due');
  });

  it('reports the time before the missing co-signature', () => {
    expect(payoutStatus(row, record({ requireCosign: true }), 10n)).toBe('waiting');
  });
});

describe('isDue', () => {
  it('treats zero as no pending change, never as due', () => {
    expect(isDue(0n, 10_000n)).toBe(false);
  });

  it('is due from the stated time on', () => {
    expect(isDue(100n, 99n)).toBe(false);
    expect(isDue(100n, 100n)).toBe(true);
  });
});

describe('additionStatus', () => {
  it('waits until it matures, is ready for one further delay, then expires', () => {
    expect(additionStatus(100n, 50, 99n)).toBe('waiting');
    expect(additionStatus(100n, 50, 100n)).toBe('ready');
    expect(additionStatus(100n, 50, 150n)).toBe('ready');
    expect(additionStatus(100n, 50, 151n)).toBe('expired');
  });
});

describe('chainNowOf', () => {
  it('adds wall time elapsed since the pinned read to the block time', () => {
    expect(chainNowOf({ chainNowSec: 500n, fetchedAtMs: 1_000_000 }, 1_030)).toBe(530n);
  });

  it('never moves the clock backwards when the wall clock is behind', () => {
    expect(chainNowOf({ chainNowSec: 500n, fetchedAtMs: 1_000_000 }, 900)).toBe(500n);
  });
});

describe('isManager', () => {
  it('is the account itself while it is not retired', () => {
    expect(isManager(ACCOUNT, record(), ACCOUNT.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isManager(ACCOUNT, record(), CONTROLLER)).toBe(false);
  });

  it('is only the controller once the account is retired', () => {
    const r = record({ retired: true, controller: CONTROLLER });
    expect(isManager(ACCOUNT, r, CONTROLLER)).toBe(true);
    expect(isManager(ACCOUNT, r, ACCOUNT)).toBe(false);
  });

  it('is nobody without a connected wallet', () => {
    expect(isManager(ACCOUNT, record(), undefined)).toBe(false);
  });
});

describe('hasReplacement', () => {
  it('reads a zero nominee or an unread state as no proposal', () => {
    expect(hasReplacement(null)).toBe(false);
    expect(
      hasReplacement({ nominee: ZERO, proposedBy: ZERO, readyAt: 0n, round: 0, approvals: 0, threshold: 0 }),
    ).toBe(false);
    expect(
      hasReplacement({ nominee: CONTROLLER, proposedBy: ACCOUNT, readyAt: 0n, round: 1, approvals: 1, threshold: 2 }),
    ).toBe(true);
  });
});
