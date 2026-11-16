/**
 * Protected account mode — the pure classification the protection page
 * renders from. The order matters: the contract checks the lock first,
 * then the release time, then the co-signature, so a row is described by
 * the FIRST thing that would refuse its release.
 */
import { describe, expect, it } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, getAbiItem, type Log } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { additionStatus, ownFundingVerdict, ownPayoutRoute, ownWithdrawalVerdict, payoutRoute, payoutOutcome, payoutOutcomes, MAX_OPEN_ROWS, chainNowOf, hasReplacement, isDue, isManager, payoutStatus, replacementStage, type ProtectedAccountRecord } from './protectedAccount';

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
  retiredPendingUnpinAt: 0n,
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
    // Codex #3489 r2: the row's own reading of the release rule wins over the
    // account setting: an unverified destination needs a co-sign with the
    // setting off, and a signerless account needs none with it on.
    expect(payoutStatus({ ...row, needsCosign: true }, record(), 1_000n)).toBe('needsCosign');
    expect(payoutStatus({ ...row, needsCosign: false }, record({ requireCosign: true }), 1_000n)).toBe('due');
    expect(payoutStatus({ ...row, needsCosign: null }, record({ requireCosign: true }), 1_000n)).toBe('needsCosign');
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

describe('replacementStage', () => {
  const account = '0x00000000000000000000000000000000000000a1' as const;
  const nominee = '0x00000000000000000000000000000000000000b2' as const;
  const s = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      signer: `0x${(0xc0 + i).toString(16).padStart(40, '0')}` as `0x${string}`,
      removeAt: 0n,
    }));
  const rec = { retired: false, controller: '0x0000000000000000000000000000000000000000' } as unknown as Parameters<
    typeof replacementStage
  >[1];
  const base = { nominee, proposedBy: s(1)[0].signer, readyAt: 100n, round: 1, approvals: 2, threshold: 2 };

  it('is due once a signer-led move keeps its majority past readyAt', () => {
    expect(replacementStage(base, rec, account, s(3), 100n)).toBe('due');
    expect(replacementStage(base, rec, account, s(3), 99n)).toBe('scheduled');
  });
  it('reports a lost quorum instead of offering completion', () => {
    expect(replacementStage({ ...base, approvals: 1 }, rec, account, s(3), 200n)).toBe('quorumLost');
    expect(replacementStage(base, rec, account, s(2), 200n)).toBe('quorumLost');
    expect(replacementStage({ ...base, readyAt: 0n, approvals: 1 }, rec, account, s(3), 200n)).toBe('collecting');
  });
  it('needs no signer approval for the manager’s own move', () => {
    expect(replacementStage({ ...base, proposedBy: account, approvals: 0 }, rec, account, [], 200n)).toBe('due');
  });
  it('refuses a nominee who became a signer, and is unknown without the signer list', () => {
    expect(replacementStage({ ...base, nominee: s(3)[2].signer }, rec, account, s(3), 200n)).toBe('nomineeIsSigner');
    expect(replacementStage(base, rec, account, null, 200n)).toBeNull();
  });
});

describe('ownFundingVerdict', () => {
  const rec = (retired: boolean) =>
    ({ retired, controller: '0x00000000000000000000000000000000000000c1' }) as unknown as ProtectedAccountRecord;
  it('is unread until the record is read', () => {
    expect(ownFundingVerdict(undefined, false).kind).toBe('unread');
    expect(ownFundingVerdict({ supported: true, recordFailed: false, record: rec(false) }, true).kind).toBe('unread');
    expect(ownFundingVerdict({ supported: true, recordFailed: true, record: null }, false).kind).toBe('unread');
  });
  it('is open on a Diamond without protected account mode', () => {
    expect(ownFundingVerdict({ supported: false, recordFailed: false, record: null }, false).kind).toBe('open');
  });
  it('refuses a retired wallet and names its controller', () => {
    expect(ownFundingVerdict({ supported: true, recordFailed: false, record: rec(true) }, false)).toEqual({
      kind: 'retired',
      controller: '0x00000000000000000000000000000000000000c1',
    });
    expect(ownFundingVerdict({ supported: true, recordFailed: false, record: rec(false) }, false).kind).toBe('open');
  });
});

describe('ownWithdrawalVerdict', () => {
  const snap = (over: Partial<ProtectedAccountRecord>, rows = 0) => ({
    supported: true,
    recordFailed: false,
    record: record({ enabled: true, ...over }),
    payouts: Array.from({ length: rows }) as never[],
    transfers: [] as never[],
  });
  it('queues for a protected account with room', () => {
    expect(ownWithdrawalVerdict(snap({}), false)).toEqual({ kind: 'open', queued: true });
  });
  it('refuses a full queue, a lock, and the old wallet of a retired account', () => {
    expect(ownWithdrawalVerdict(snap({}, MAX_OPEN_ROWS), false).kind).toBe('queueFull');
    expect(ownWithdrawalVerdict(snap({ locked: true }), false).kind).toBe('locked');
    expect(ownWithdrawalVerdict(snap({ retired: true }), false).kind).toBe('retired');
  });
  it('lets the controller of a retired account withdraw', () => {
    expect(ownWithdrawalVerdict(snap({ retired: true }), false, true).kind).toBe('open');
  });
  it('is unread while the queue is unread, and pays now with protection off', () => {
    expect(ownWithdrawalVerdict({ ...snap({}), payouts: null }, false).kind).toBe('unread');
    expect(ownWithdrawalVerdict(snap({ enabled: false }), false)).toEqual({ kind: 'open', queued: false });
  });
});

describe('ownPayoutRoute', () => {
  const snap = (over: Partial<ProtectedAccountRecord>, rows = 0) => ({
    supported: true,
    recordFailed: false,
    record: record({ enabled: true, delaySeconds: 172800, ...over }),
    payouts: Array.from({ length: rows }) as never[],
    transfers: [] as never[],
  });
  it('pays the wallet with protection off or absent', () => {
    expect(ownPayoutRoute(snap({ enabled: false }), false).kind).toBe('wallet');
    expect(ownPayoutRoute({ supported: false, recordFailed: false, record: null, payouts: null, transfers: null }, false).kind).toBe('wallet');
  });
  it('queues with protection on, naming the delay and the co-signature', () => {
    expect(ownPayoutRoute(snap({ requireCosign: true }), false)).toEqual({ kind: 'queued', delaySeconds: 172800, cosign: true, to: null });
  });
  describe('a payment out of another account\'s vault', () => {
    const me = '0x00000000000000000000000000000000000000a1';
    const old = '0x00000000000000000000000000000000000000b2';
    const off = snap({ enabled: false });
    it('is credited to a protected recipient\'s vault, queueing nothing', () => {
      expect(payoutRoute({ address: me, snap: snap({}), readFailed: false }, { address: old, snap: off, readFailed: false }).kind).toBe('creditedToVault');
      expect(payoutRoute({ address: me, snap: off, readFailed: false }, { address: old, snap: off, readFailed: false }).kind).toBe('wallet');
    });
    it('goes through the source account\'s gate when the recipient is its controller', () => {
      const retired = (over: Partial<ProtectedAccountRecord> = {}) => snap({ retired: true, controller: me, ...over });
      // Whatever the controller's own protection, the retired account queues it.
      expect(payoutRoute({ address: me, snap: off, readFailed: false }, { address: old, snap: retired(), readFailed: false })).toEqual({
        kind: 'queued',
        delaySeconds: 172800,
        cosign: false,
        to: null,
      });
      expect(payoutRoute({ address: me, snap: snap({}), readFailed: false }, { address: old, snap: retired({ locked: true }), readFailed: false }).kind).toBe('vault');
    });
    it('counts the rows earlier legs of a batch take', () => {
      const own = { address: me, snap: snap({}, MAX_OPEN_ROWS - 1), readFailed: false };
      expect(payoutRoute(own).kind).toBe('queued');
      expect(payoutRoute(own, undefined, () => 1).kind).toBe('vault');
    });
    it('names the controller as the only one who can withdraw a retired account\'s held payout', () => {
      const ctl = '0x00000000000000000000000000000000000000c0';
      expect(ownPayoutRoute(snap({ retired: true, controller: ctl, locked: true }), false)).toEqual({ kind: 'vault', manager: ctl });
      expect(payoutRoute({ address: me, snap: snap({ retired: true, controller: ctl }), readFailed: false }, { address: old, snap: off, readFailed: false })).toEqual({
        kind: 'creditedToVault',
        manager: ctl,
      });
    });
    it('is unread when the source account is unread', () => {
      expect(payoutRoute({ address: me, snap: off, readFailed: false }, { address: old, snap: undefined, readFailed: true }).kind).toBe('unread');
    });
  });
  it('names the controller of a retired account, which the gate pays instead of this wallet', () => {
    const controller = '0x00000000000000000000000000000000000000c0';
    expect(ownPayoutRoute(snap({ retired: true, controller }), false)).toEqual({
      kind: 'queued',
      delaySeconds: 172800,
      cosign: false,
      to: controller,
    });
  });
  it('keeps the payment in the vault when locked or full, as the payout gate does', () => {
    expect(ownPayoutRoute(snap({ locked: true }), false).kind).toBe('vault');
    expect(ownPayoutRoute(snap({}, MAX_OPEN_ROWS), false).kind).toBe('vault');
  });
  it('is unread when the record or the queue is unread', () => {
    expect(ownPayoutRoute(undefined, false).kind).toBe('unread');
    expect(ownPayoutRoute({ ...snap({}), transfers: null }, false).kind).toBe('unread');
  });
});

describe('payoutOutcomes', () => {
  const me = '0x00000000000000000000000000000000000000a1';
  const token = '0x00000000000000000000000000000000000000e2';
  const log = (eventName: 'PayoutQueued' | 'PayoutHeldInVault', args: Record<string, unknown>): Log => {
    const item = getAbiItem({ abi: DIAMOND_ABI_VIEM, name: eventName }) as {
      inputs: readonly { name: string; type: string; indexed?: boolean }[];
    };
    const data = item.inputs.filter((i) => !i.indexed);
    return {
      address: '0x0000000000000000000000000000000000000d00',
      topics: encodeEventTopics({ abi: DIAMOND_ABI_VIEM, eventName, args } as never) as Log['topics'],
      data: encodeAbiParameters(data as never, data.map((i) => args[i.name]) as never),
      blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
    } as Log;
  };
  const queued = log('PayoutQueued', { account: me, id: 1n, asset: token, kind: 0, tokenId: 0n, amount: 5n, recipient: me, releaseAt: 9n });
  const held = log('PayoutHeldInVault', { account: me, asset: token, tokenId: 0n, amount: 5n });
  it('states every outcome of a batch that both queues and holds', () => {
    expect(payoutOutcomes([queued, held], me)).toEqual([
      { kind: 'queued', recipient: me },
      { kind: 'held', account: me },
    ]);
  });
  it('is empty when the wallet was paid, and ignores another account\'s events', () => {
    expect(payoutOutcomes([], me)).toEqual([]);
    expect(payoutOutcomes([held], '0x00000000000000000000000000000000000000ff')).toEqual([]);
    expect(payoutOutcome([], me).kind).toBe('paid');
  });
});
