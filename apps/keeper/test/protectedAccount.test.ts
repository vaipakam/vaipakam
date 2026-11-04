/**
 * #3088 — the protected account pass: releases of queued payouts and
 * position transfers, and the finalize calls of matured protected-mode
 * changes, run against a fake Diamond that applies the contract's own
 * admission rules to each call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  ABI,
  CHANGE_FLOOR_ITEM,
  CHANGE_EVENTS,
  changeOf,
  describeReport,
  PAYOUT_EVENT,
  PAYOUT_FLOOR_ITEM,
  protectedOnce,
  stepOrder,
  TRANSFER_EVENT,
  TRANSFER_FLOOR_ITEM,
  type ProtectedAccount,
} from '../src/protectedAccount';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { memoryScanCursors } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const ALICE: Address = '0x00000000000000000000000000000000000000a1';
const BOB: Address = '0x00000000000000000000000000000000000000b2';
const DEST: Address = '0x00000000000000000000000000000000000000d3';
const SIGNER: Address = '0x00000000000000000000000000000000000000e4';
const ASSET: Address = '0x00000000000000000000000000000000000000f5';
const FLAGGED: Address = '0x0000000000000000000000000000000000000bad';
const NOW = 1_000_000n;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

function logOf(eventName: string, args: Record<string, unknown>): { address: Address; data: Hex; topics: Hex[] } {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address: DIAMOND, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

function account(over: Partial<ProtectedAccount> = {}): ProtectedAccount {
  return {
    enabled: true,
    locked: false,
    protectNfts: false,
    requireCosign: false,
    retired: false,
    delaySeconds: 3600,
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
  };
}

interface Payout {
  user: Address;
  state: number;
  cosigned: boolean;
  releaseAt: bigint;
  recipient: Address;
  amount: bigint;
}

interface Transfer {
  from: Address;
  state: number;
  releaseAt: bigint;
  to: Address;
  tokenId: bigint;
}

class FakeDiamond {
  chainServed = CHAIN;
  now = NOW;
  paused = false;
  accounts = new Map<Address, ProtectedAccount>();
  payouts = new Map<bigint, Payout>();
  transfers = new Map<bigint, Transfer>();
  allowlist = new Map<string, Set<Address>>();
  allowPending = new Map<string, bigint>();
  signerChanges = new Map<string, { addAt: bigint; accepted: boolean; removeAt: bigint }>();
  replacements = new Map<Address, { nominee: Address; proposedBy: Address; readyAt: bigint; approvals: bigint; threshold: bigint }>();
  /** Accounts with open rows, which hold a due switch-off back. */
  openRows = new Set<Address>();
  /** The finalized block's view of the payouts, when it lags the head. */
  finalPayouts: Map<bigint, Payout> | null = null;
  sent: { fn: string; args: readonly unknown[] }[] = [];
  lastLogs: ReturnType<typeof logOf>[] = [];

  acct(a: Address): ProtectedAccount {
    return this.accounts.get(a) ?? account({ enabled: false });
  }

  readContract = async ({ functionName, args = [], blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    switch (functionName) {
      case 'getPendingPayout': {
        const p = ((blockNumber !== undefined ? this.finalPayouts : null) ?? this.payouts).get(a[0]);
        return { user: p?.user ?? ZERO, kind: 0, state: p?.state ?? 0, cosigned: p?.cosigned ?? false, releaseAt: p?.releaseAt ?? 0n, asset: ASSET, recipient: p?.recipient ?? ZERO, tokenId: 0n, amount: p?.amount ?? 0n, delivered: 0n };
      }
      case 'getPendingPositionTransfer': {
        const t = this.transfers.get(a[0]);
        return { from: t?.from ?? ZERO, state: t?.state ?? 0, releaseAt: t?.releaseAt ?? 0n, to: t?.to ?? ZERO, tokenId: t?.tokenId ?? 0n };
      }
      case 'getProtectedAccount':
        // A copy, as a chain read is: a later send must not change it.
        return { ...this.acct(a[0]) };
      case 'getAllowlistPendingAt':
        return this.allowPending.get(`${a[0]}:${a[1]}`) ?? 0n;
      case 'getSignerChange':
        return this.signerChanges.get(`${a[0]}:${a[1]}`) ?? { addAt: 0n, accepted: false, removeAt: 0n };
      case 'getReplacement': {
        const p = this.replacements.get(a[0]);
        return [{ nominee: p?.nominee ?? ZERO, proposedBy: p?.proposedBy ?? ZERO, readyAt: p?.readyAt ?? 0n, round: 1, approvals: 0 }, p?.approvals ?? 0n, p?.threshold ?? 0n];
      }
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  /** The functions each batched read named, in order. */
  batches: string[][] = [];
  /** Each batched read in full, in order. */
  calls: { functionName: string; args?: readonly unknown[] }[][] = [];
  multicall = async ({ contracts, blockNumber }: { contracts: { functionName: string; args?: readonly unknown[] }[]; blockNumber?: bigint }) =>
    (this.batches.push([...new Set(contracts.map((c) => c.functionName))]),
    this.calls.push(contracts.map((c) => ({ functionName: c.functionName, args: c.args }))),
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract({ ...c, blockNumber }) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    ));

  private admit(functionName: string, a: readonly any[]): () => void {
    switch (functionName) {
      case 'releasePayout': {
        if (this.paused) throw revert('EnforcedPause');
        const p = this.payouts.get(a[0]);
        if (!p || p.state !== 1) throw revert('RowNotQueued', [a[0]]);
        const allowed = p.recipient === p.user || (this.allowlist.get(p.user)?.has(p.recipient) ?? false);
        if (!allowed) {
          return () => {
            p.state = 3;
            this.lastLogs = [logOf('PayoutCancelled', { account: p.user, id: a[0], by: DIAMOND })];
          };
        }
        if (this.now < p.releaseAt) throw revert('PayoutNotDue', [a[0], p.releaseAt]);
        const acct = this.acct(p.user);
        if (acct.locked) throw revert('ProtectedVaultLocked', [p.user]);
        if (acct.requireCosign && !p.cosigned) throw revert('CosignRequired', [a[0]]);
        if (p.recipient === FLAGGED) throw revert('SanctionedAddress', [FLAGGED]);
        return () => {
          p.state = 2;
          this.lastLogs = [logOf('PayoutReleased', { account: p.user, id: a[0], asset: ASSET, amount: p.amount, delivered: p.amount - 1n, recipient: p.recipient })];
        };
      }
      case 'releasePositionTransfer': {
        if (this.paused) throw revert('EnforcedPause');
        const t = this.transfers.get(a[0]);
        if (!t || t.state !== 1) throw revert('RowNotQueued', [a[0]]);
        if (this.now < t.releaseAt) throw revert('PayoutNotDue', [a[0], t.releaseAt]);
        if (this.acct(t.from).locked) throw revert('ProtectedVaultLocked', [t.from]);
        return () => {
          t.state = 2;
          this.lastLogs = [];
        };
      }
      case 'finalizeSettingChanges': {
        if (this.paused) throw revert('EnforcedPause');
        const acct = this.acct(a[0]);
        const due = (at: bigint) => at !== 0n && this.now >= at;
        const others = due(acct.pendingUnlockAt) || due(acct.pendingDelayAt) || due(acct.pendingNftOffAt);
        const off = due(acct.pendingDisableAt) && !this.openRows.has(a[0]);
        if (due(acct.pendingDisableAt) && !off && !others) throw revert('PendingRowsExist');
        return () => {
          const logs = [];
          const applied = (kind: number) => logs.push(logOf('SettingChangeApplied', { account: a[0], kind }));
          if (due(acct.pendingUnlockAt)) (Object.assign(acct, { locked: false, pendingUnlockAt: 0n }), applied(5));
          if (due(acct.pendingDelayAt)) (Object.assign(acct, { pendingDelayAt: 0n }), applied(2));
          if (due(acct.pendingNftOffAt)) (Object.assign(acct, { protectNfts: false, pendingNftOffAt: 0n }), applied(3));
          if (off) (this.accounts.set(a[0], account({ enabled: false })), logs.push(logOf('ProtectedModeDisabled', { account: a[0] })));
          this.lastLogs = logs;
        };
      }
      case 'finalizeAddAllowlisted': {
        const acct = this.acct(a[0]);
        if (!acct.enabled) throw revert('ProtectedModeOff', [a[0]]);
        if (acct.locked) throw revert('ProtectedVaultLocked', [a[0]]);
        const k = `${a[0]}:${a[1]}`;
        const at = this.allowPending.get(k) ?? 0n;
        if (at === 0n) throw revert('ChangeNotRequested');
        if (this.now < at) throw revert('ChangeNotMatured', [at]);
        if (this.now > at + BigInt(acct.delaySeconds)) throw revert('ChangeExpired', [at + BigInt(acct.delaySeconds)]);
        return () => {
          this.allowPending.delete(k);
          this.lastLogs = [logOf('AllowlistAdded', { account: a[0], destination: a[1] })];
        };
      }
      case 'finalizeAddSigner':
      case 'finalizeRemoveSigner': {
        const k = `${a[0]}:${a[1]}`;
        const c = this.signerChanges.get(k);
        const at = functionName === 'finalizeAddSigner' ? c?.addAt ?? 0n : c?.removeAt ?? 0n;
        if (at === 0n) throw revert('ChangeNotRequested');
        if (this.now < at) throw revert('ChangeNotMatured', [at]);
        return () => {
          this.signerChanges.delete(k);
          this.lastLogs = [logOf(functionName === 'finalizeAddSigner' ? 'SignerAdded' : 'SignerRemoved', { account: a[0], signer: a[1] })];
        };
      }
      case 'finalizeReplacement': {
        const p = this.replacements.get(a[0]);
        if (!p) throw revert('NoReplacementProposed');
        if (this.now < p.readyAt) throw revert('ReplacementNotReady');
        return () => {
          this.replacements.delete(a[0]);
          this.lastLogs = [logOf('PrimaryReplaced', { account: a[0], controller: p.nominee, cooldownUntil: 0n })];
        };
      }
      default:
        throw new Error(`unexpected call ${functionName}`);
    }
  }

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    this.admit(functionName, args);
    return { result: undefined };
  };

  getChainId = async () => this.chainServed;

  getBlock = async ({ blockTag }: { blockTag?: string } = {}) => {
    if (blockTag === 'finalized') return { number: 100n, timestamp: this.now };
    return { number: 120n, timestamp: this.now };
  };

  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: this.lastLogs, blockNumber: 1n });

  client(): PublicClient {
    return this as unknown as PublicClient;
  }

  ctx(): KeeperContext {
    return {
      client: this.client(),
      diamond: DIAMOND,
      chainId: CHAIN,
      notAfterMs: Number.POSITIVE_INFINITY,
      wallet: {
        account: { address: KEEPER },
        writeContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          this.admit(functionName, args)();
          this.sent.push({ fn: functionName, args });
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

class FakeLedger implements EventLedger {
  rows: LedgerRow[] = [];

  add(kind: string, args: Record<string, unknown>, block?: number): void {
    const n = block ?? this.rows.length + 1;
    this.rows.push({ kind, args, blockAt: n, block: n, log: 0, tx: '0x' });
  }

  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected ledger lookup');
  }

  async page(_chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    const rest = this.rows.filter((r) => kinds.includes(r.kind) && (after === null || r.block > after.block || (r.block === after.block && r.log > after.log)));
    return { rows: rest.slice(0, limit), more: rest.length > limit };
  }
}

describe('changeOf', () => {
  it('reads each kind of announced change, and nothing from a row it cannot read', () => {
    const row = (kind: string, args: Record<string, unknown>): LedgerRow => ({ kind, args, blockAt: 1, block: 1, log: 0, tx: '0x' });
    expect(changeOf(row('SettingChangeRequested', { account: ALICE, kind: 5, value: '0', effectiveAt: '10' }))).toEqual({ t: 'setting', account: ALICE, kind: 5, at: 10n });
    expect(changeOf(row('VaultUnpinRequested', { account: ALICE, effectiveAt: '11' }))).toEqual({ t: 'setting', account: ALICE, kind: 6, at: 11n });
    expect(changeOf(row('AllowlistAddRequested', { account: ALICE, destination: DEST, effectiveAt: '12' }))).toEqual({ t: 'allow', account: ALICE, other: DEST, at: 12n });
    expect(changeOf(row('ReplacementScheduled', { account: ALICE, nominee: BOB, readyAt: '13' }))).toEqual({ t: 'replace', account: ALICE, other: BOB, at: 13n });
    expect(changeOf(row('SettingChangeRequested', { account: ALICE, kind: 9, effectiveAt: '10' })), 'an unknown setting').toBeNull();
    expect(changeOf(row('SignerAddRequested', { account: 'nope', signer: SIGNER, effectiveAt: '1' }))).toBeNull();
  });

  it('names the same events the step reads', () => {
    expect([...CHANGE_EVENTS].sort()).toEqual(['AllowlistAddRequested', 'ReplacementScheduled', 'SettingChangeRequested', 'SignerAddRequested', 'SignerRemoveRequested', 'VaultUnpinRequested']);
  });
});

describe('a run', () => {
  let d: FakeDiamond;
  let ledger: FakeLedger;
  let cursors: ReturnType<typeof memoryScanCursors>;

  beforeEach(() => {
    d = new FakeDiamond();
    ledger = new FakeLedger();
    cursors = memoryScanCursors();
    d.accounts.set(ALICE, account());
    d.accounts.set(BOB, account());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (visit?: number) =>
    protectedOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: Number.POSITIVE_INFINITY,
      cursors,
      ledger,
      visit,
    });
  const fns = () => d.sent.map((s) => s.fn);
  const queuePayout = (id: bigint, p: Partial<Payout> = {}) => {
    d.payouts.set(id, { user: ALICE, state: 1, cosigned: false, releaseAt: NOW - 1n, recipient: ALICE, amount: 100n, ...p });
    ledger.add(PAYOUT_EVENT, { account: p.user ?? ALICE, id: String(id) });
  };

  describe('payouts', () => {
    it('pays each due payout, leaves one not yet due, and passes released rows with the floor', async () => {
      queuePayout(1n);
      queuePayout(2n, { state: 2 }); // already released by someone else
      queuePayout(3n, { releaseAt: NOW + 60n });
      const r = await run();
      expect(d.sent.map((s) => [s.fn, s.args])).toEqual([['releasePayout', [1n]]]);
      expect(r.released).toEqual([{ id: 1n, delivered: 99n }]);
      expect(r.waiting.get('payout-not-due')).toBe(1);
      expect(cursors.rows.get(PAYOUT_FLOOR_ITEM), 'past the two finished rows, not the waiting one').toBe(encodePos(ledger.rows[1]));
      d.now = NOW + 60n;
      d.sent = [];
      expect((await run()).released.map((x) => x.id)).toEqual([3n]);
      expect(cursors.rows.get(PAYOUT_FLOOR_ITEM)).toBe(encodePos(ledger.rows[2]));
    });

    it("reads the rows' records and their accounts in one batch, so the accounts never wait for the records", async () => {
      queuePayout(1n);
      queuePayout(2n, { user: BOB, recipient: BOB });
      d.transfers.set(3n, { from: ALICE, state: 1, releaseAt: NOW - 1n, to: DEST, tokenId: 7n });
      ledger.add(TRANSFER_EVENT, { account: ALICE, id: '3', tokenId: '7' });
      await run();
      expect(d.batches.find((b) => b.includes('getPendingPayout'))).toEqual(['getPendingPayout', 'getProtectedAccount']);
      // The transfer's account was read with the payouts: its batch adds none.
      expect(d.batches.find((b) => b.includes('getPendingPositionTransfer'))).toEqual(['getPendingPositionTransfer']);
      expect(d.batches.filter((b) => b.length === 1 && b[0] === 'getProtectedAccount'), 'no follow-up account read').toEqual([]);
    });

    it('places each account read right after the first record naming it, so a part-read batch still yields whole pairs (Codex #3090)', async () => {
      queuePayout(1n);
      queuePayout(2n, { user: BOB, recipient: BOB });
      queuePayout(3n);
      await run();
      const batch = d.calls.find((b) => b.some((c) => c.functionName === 'getPendingPayout'))!;
      expect(batch.map((c) => [c.functionName, String(c.args?.[0])])).toEqual([
        ['getPendingPayout', '1'],
        ['getProtectedAccount', ALICE],
        ['getPendingPayout', '2'],
        ['getProtectedAccount', BOB],
        ['getPendingPayout', '3'],
      ]);
    });

    it('starts each run at a different row of the page, so slow refusals at its top cannot starve a row below them', async () => {
      queuePayout(1n);
      queuePayout(2n);
      queuePayout(3n);
      await run(1); // attemptOrder(3, 1) = [1, 2, 0]
      expect(d.sent.map((s) => s.args[0])).toEqual([2n, 3n, 1n]);
    });

    it('sends nothing for a locked account or a payout that still needs its co-sign', async () => {
      d.accounts.set(BOB, account({ locked: true }));
      d.accounts.set(ALICE, account({ requireCosign: true }));
      queuePayout(1n, { user: BOB, recipient: BOB });
      queuePayout(2n);
      queuePayout(3n, { cosigned: true });
      const r = await run();
      expect(d.sent.map((s) => s.args[0])).toEqual([3n]);
      expect(r.waiting.get('payout-account-locked')).toBe(1);
      expect(r.waiting.get('payout-needs-cosign')).toBe(1);
      expect(cursors.rows.has(PAYOUT_FLOOR_ITEM), 'the first row still waits').toBe(false);
    });

    it('names a payout the release cancelled apart from a paid one', async () => {
      queuePayout(1n, { recipient: DEST }); // not on the allowlist
      const r = await run();
      expect(r.cancelled).toEqual([1n]);
      expect(r.released).toEqual([]);
      expect(describeReport(r)).toMatch(/payouts-cancelled-by-release=1 \(destination no longer allowed; the asset stays in the vault\)/);
    });

    it('keeps a payout to a flagged recipient queued, names the refusal, and tries it again next run', async () => {
      d.allowlist.set(ALICE, new Set([FLAGGED]));
      queuePayout(1n, { recipient: FLAGGED });
      const r = await run();
      expect(fns()).toEqual([]);
      expect(r.refused.get('release:1')).toBe('SanctionedAddress');
      expect(cursors.rows.has(PAYOUT_FLOOR_ITEM)).toBe(false);
      expect(d.payouts.get(1n)!.state).toBe(1);
    });

    it('moves its floor only on what the finalized block shows', async () => {
      queuePayout(1n);
      d.finalPayouts = new Map([[1n, { ...d.payouts.get(1n)! }]]);
      await run();
      expect(cursors.rows.has(PAYOUT_FLOOR_ITEM), 'the release is not final yet').toBe(false);
      d.finalPayouts = null;
      await run();
      expect(cursors.rows.get(PAYOUT_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
    });

    it('keeps a share of sends for every step, so a long payout queue cannot hold back a transfer or an unlock', async () => {
      for (let i = 1n; i <= 6n; i++) queuePayout(i);
      d.transfers.set(1n, { from: ALICE, state: 1, releaseAt: NOW - 1n, to: DEST, tokenId: 7n });
      ledger.add(TRANSFER_EVENT, { account: ALICE, id: '1', tokenId: '7' });
      d.accounts.set(BOB, account({ locked: true, pendingUnlockAt: NOW - 5n }));
      ledger.add('SettingChangeRequested', { account: BOB, kind: 5, value: '0', effectiveAt: String(NOW - 5n) });
      const r = await run();
      expect(r.released.map((x) => x.id), 'the payout step stops at its share').toEqual([1n, 2n, 3n, 4n]);
      expect(r.transferred).toEqual([1n]);
      expect(r.finalized).toEqual([`unlock:${BOB.slice(0, 10)}`]);
      expect([...r.budgetReached]).toEqual(['release']);
      expect(r.stopped, 'reaching one step\'s share does not stop the run').toBeNull();
      expect(describeReport(r)).toMatch(/step-budget-reached=release \(the rest waits for the next run\)/);
      d.sent = [];
      expect((await run()).released.map((x) => x.id)).toEqual([5n, 6n]);
    });

    it('rotates which step runs first, so each starts a run with the whole read window one run in three', async () => {
      expect([0, 1, 2, 3, -1].map((v) => stepOrder(v).join('>'))).toEqual([
        'release>transfer>finalize',
        'transfer>finalize>release',
        'finalize>release>transfer',
        'release>transfer>finalize',
        'finalize>release>transfer',
      ]);
      queuePayout(1n);
      d.transfers.set(1n, { from: ALICE, state: 1, releaseAt: NOW - 1n, to: DEST, tokenId: 7n });
      ledger.add(TRANSFER_EVENT, { account: ALICE, id: '1', tokenId: '7' });
      d.accounts.set(BOB, account({ locked: true, pendingUnlockAt: NOW - 5n }));
      ledger.add('SettingChangeRequested', { account: BOB, kind: 5, value: '0', effectiveAt: String(NOW - 5n) });
      await protectedOnce(CHAIN, DIAMOND, {
        client: d.client(),
        readClient: d.client(),
        context: () => d.ctx(),
        sendDeadline: Number.POSITIVE_INFINITY,
        cursors,
        ledger,
        visit: 2,
      });
      expect(fns()).toEqual(['finalizeSettingChanges', 'releasePayout', 'releasePositionTransfer']);
    });

    it('stops the run when the protocol is paused, and says so', async () => {
      d.paused = true;
      queuePayout(1n);
      const r = await run();
      expect(fns()).toEqual([]);
      expect(r.stopped).toBe('EnforcedPause');
    });
  });

  describe('position transfers', () => {
    it('moves a due transfer and leaves a locked account\'s', async () => {
      d.accounts.set(BOB, account({ locked: true }));
      d.transfers.set(1n, { from: ALICE, state: 1, releaseAt: NOW - 1n, to: DEST, tokenId: 7n });
      d.transfers.set(2n, { from: BOB, state: 1, releaseAt: NOW - 1n, to: DEST, tokenId: 8n });
      ledger.add(TRANSFER_EVENT, { account: ALICE, id: '1', tokenId: '7' });
      ledger.add(TRANSFER_EVENT, { account: BOB, id: '2', tokenId: '8' });
      const r = await run();
      expect(d.sent.map((s) => [s.fn, s.args])).toEqual([['releasePositionTransfer', [1n]]]);
      expect(r.transferred).toEqual([1n]);
      expect(r.waiting.get('transfer-account-locked')).toBe(1);
      expect(cursors.rows.get(TRANSFER_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
    });
  });

  describe('pending changes', () => {
    it('applies an account\'s due settings in one call, an unlock included', async () => {
      d.accounts.set(ALICE, account({ locked: true, pendingUnlockAt: NOW - 5n }));
      d.accounts.set(BOB, account({ pendingDelayAt: NOW - 5n, pendingNftOffAt: NOW - 1n }));
      ledger.add('SettingChangeRequested', { account: ALICE, kind: 5, value: '0', effectiveAt: String(NOW - 5n) });
      ledger.add('SettingChangeRequested', { account: BOB, kind: 2, value: '7200', effectiveAt: String(NOW - 5n) });
      ledger.add('SettingChangeRequested', { account: BOB, kind: 3, value: '0', effectiveAt: String(NOW - 1n) });
      const r = await run();
      expect(d.sent.map((s) => [s.fn, s.args])).toEqual([
        ['finalizeSettingChanges', [ALICE]],
        ['finalizeSettingChanges', [BOB]],
      ]);
      // Bob's one call applied both of his settings, and its receipt says so.
      expect(r.finalized).toEqual([`unlock:${ALICE.slice(0, 10)}`, `lower-delay:${BOB.slice(0, 10)}`, `nft-protection-off:${BOB.slice(0, 10)}`]);
      expect(d.accounts.get(ALICE)!.locked).toBe(false);
    });

    it('counts a switch-off held back by open rows as waiting, and does not claim one applied with other settings', async () => {
      d.accounts.set(ALICE, account({ pendingDisableAt: NOW - 5n }));
      d.accounts.set(BOB, account({ pendingDisableAt: NOW - 5n, pendingNftOffAt: NOW - 5n }));
      d.openRows.add(ALICE);
      d.openRows.add(BOB);
      ledger.add('SettingChangeRequested', { account: ALICE, kind: 1, value: '0', effectiveAt: String(NOW - 5n) });
      ledger.add('SettingChangeRequested', { account: BOB, kind: 1, value: '0', effectiveAt: String(NOW - 5n) });
      ledger.add('SettingChangeRequested', { account: BOB, kind: 3, value: '0', effectiveAt: String(NOW - 5n) });
      const r = await run();
      // Bob's call lands and applies only the NFT switch-off, which its
      // receipt reports; Alice's is refused. Both switch-offs wait.
      expect(d.sent.map((s) => [s.fn, s.args])).toEqual([['finalizeSettingChanges', [BOB]]]);
      expect(r.refused.size).toBe(0);
      expect(r.waiting.get('switch-off-waits-for-open-rows')).toBe(2);
      expect(r.finalized).toEqual([`nft-protection-off:${BOB.slice(0, 10)}`]);
      expect(d.accounts.get(BOB)!.enabled).toBe(true);
      expect(d.accounts.get(BOB)!.pendingNftOffAt).toBe(0n);
    });

    it('reports a setting only from its receipt: a landed call that applied nothing reports nothing (Codex #3090)', async () => {
      // A replacement finalized first, or a cancel between read and send,
      // leaves the setting's call landing with no SettingChangeApplied.
      d.accounts.set(ALICE, account({ pendingUnpinAt: NOW - 5n }));
      ledger.add('SettingChangeRequested', { account: ALICE, kind: 6, value: '0', effectiveAt: String(NOW - 5n) });
      const r = await run();
      expect(fns()).toEqual(['finalizeSettingChanges']);
      expect(r.finalized).toEqual([]);
      expect(r.waiting.get('change-not-applied')).toBe(1);
    });

    it('treats a change whose pending time moved on as finished, and sends nothing for it', async () => {
      // Cancelled and asked again: the chain holds a later time than the row.
      d.allowPending.set(`${ALICE}:${DEST}`, NOW + 100n);
      ledger.add('AllowlistAddRequested', { account: ALICE, destination: DEST, effectiveAt: String(NOW - 100n) });
      ledger.add('AllowlistAddRequested', { account: ALICE, destination: DEST, effectiveAt: String(NOW + 100n) });
      const r = await run();
      expect(fns()).toEqual([]);
      expect(r.waiting.get('change-not-due')).toBe(1);
      expect(cursors.rows.get(CHANGE_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
    });

    it('waits on a locked account, an expired allowlist addition, an unaccepted or expired signer addition, and a replacement short of its approvals', async () => {
      d.accounts.set(BOB, account({ locked: true }));
      d.allowPending.set(`${ALICE}:${DEST}`, NOW - 3601n);
      ledger.add('AllowlistAddRequested', { account: ALICE, destination: DEST, effectiveAt: String(NOW - 3601n) });
      d.allowPending.set(`${BOB}:${DEST}`, NOW - 1n);
      ledger.add('AllowlistAddRequested', { account: BOB, destination: DEST, effectiveAt: String(NOW - 1n) });
      d.signerChanges.set(`${ALICE}:${SIGNER}`, { addAt: NOW - 1n, accepted: false, removeAt: 0n });
      ledger.add('SignerAddRequested', { account: ALICE, signer: SIGNER, effectiveAt: String(NOW - 1n) });
      d.signerChanges.set(`${ALICE}:${DEST}`, { addAt: NOW - 3601n, accepted: true, removeAt: 0n });
      ledger.add('SignerAddRequested', { account: ALICE, signer: DEST, effectiveAt: String(NOW - 3601n) });
      d.replacements.set(ALICE, { nominee: BOB, proposedBy: SIGNER, readyAt: NOW - 1n, approvals: 1n, threshold: 2n });
      ledger.add('ReplacementScheduled', { account: ALICE, nominee: BOB, readyAt: String(NOW - 1n) });
      const r = await run();
      expect(fns()).toEqual([]);
      expect(Object.fromEntries(r.waiting)).toEqual({
        'change-account-locked': 1,
        'allowlist-add-expired': 1,
        'signer-not-accepted': 1,
        'signer-add-expired': 1,
        'replacement-lacks-approvals': 1,
      });
    });

    it('finalizes a matured allowlist addition, an accepted signer, a signer removal and a manager-led replacement', async () => {
      d.allowPending.set(`${ALICE}:${DEST}`, NOW - 1n);
      ledger.add('AllowlistAddRequested', { account: ALICE, destination: DEST, effectiveAt: String(NOW - 1n) });
      d.signerChanges.set(`${ALICE}:${SIGNER}`, { addAt: NOW - 1n, accepted: true, removeAt: 0n });
      ledger.add('SignerAddRequested', { account: ALICE, signer: SIGNER, effectiveAt: String(NOW - 1n) });
      d.signerChanges.set(`${BOB}:${SIGNER}`, { addAt: 0n, accepted: false, removeAt: NOW - 1n });
      ledger.add('SignerRemoveRequested', { account: BOB, signer: SIGNER, effectiveAt: String(NOW - 1n) });
      d.replacements.set(BOB, { nominee: DEST, proposedBy: BOB, readyAt: NOW - 1n, approvals: 0n, threshold: 2n });
      ledger.add('ReplacementScheduled', { account: BOB, nominee: DEST, readyAt: String(NOW - 1n) });
      const r = await run();
      expect(d.sent.map((s) => [s.fn, s.args])).toEqual([
        ['finalizeAddAllowlisted', [ALICE, DEST]],
        ['finalizeAddSigner', [ALICE, SIGNER]],
        ['finalizeRemoveSigner', [BOB, SIGNER]],
        ['finalizeReplacement', [BOB]],
      ]);
      expect(r.finalized).toHaveLength(4);
      expect(cursors.rows.get(CHANGE_FLOOR_ITEM)).toBe(encodePos(ledger.rows[3]));
    });
  });
});
