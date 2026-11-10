/**
 * #3088 — the protected account pass: releases of queued payouts and
 * position transfers, and the finalize calls of matured protected-mode
 * changes, run against a fake Diamond that applies the contract's own
 * admission rules to each call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type Abi,
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
import { VaultProtectionABI } from '@vaipakam/contracts/abis';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { SEND_RESERVE_MS } from '../src/runWindow';
import { memoryScanCursors } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';
import type { Alert, DeliveryOutcome } from '../src/alertDelivery';
import { ALERT_NEXT_ITEM, type LockOutcome, type LockRequest, type ProtectedStore, type Subscriber } from '../src/protectedTelegram';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const ALICE: Address = '0x00000000000000000000000000000000000000a1';
const BOB: Address = '0x00000000000000000000000000000000000000b2';
const DEST: Address = '0x00000000000000000000000000000000000000d3';
const SIGNER: Address = '0x00000000000000000000000000000000000000e4';
const ASSET: Address = '0x00000000000000000000000000000000000000f5';
const FLAGGED: Address = '0x0000000000000000000000000000000000000bad';
const CAROL: Address = '0x00000000000000000000000000000000000000c7';
const OLD_1: Address = '0x00000000000000000000000000000000000001d1';
const OLD_2: Address = '0x00000000000000000000000000000000000001d2';
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
    retiredPendingUnpinAt: 0n,
    vault: ZERO,
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

/** #3379 B2 — each account's vault, where its protected record lives. */
const vaultOf = (a: Address): Address => `0x9${a.slice(3)}` as Address;
const PROTECTION_ABI = VaultProtectionABI as Abi;

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
  /** Each send: the function (a vault write as `protect:<fn>`) and its
   *  arguments (a vault write's own). */
  sent: { fn: string; args: readonly unknown[] }[] = [];
  /** Accounts that granted the keeper the lock bit. */
  lockGranted = new Set<Address>();
  codeFails = false;
  /** The co-sign switch-off call lands but applies nothing (a cancel between
   *  the read and the send). */
  settingsApplyNothing = false;
  lastLogs: ReturnType<typeof logOf>[] = [];

  acct(a: Address): ProtectedAccount {
    return this.accounts.get(a) ?? account({ enabled: false });
  }

  /** The account a vault address belongs to. */
  ownerOfVault(v: Address): Address {
    for (const a of [...this.accounts.keys(), ALICE, BOB, CAROL, DEST, SIGNER]) if (vaultOf(a) === v) return a;
    throw new Error(`unknown vault ${v}`);
  }

  private keyed(prefix: Address, m: Map<string, unknown>): Address[] {
    return [...m.keys()].filter((k) => k.startsWith(`${prefix}:`)).map((k) => k.slice(prefix.length + 1) as Address);
  }

  readContract = async ({ address, functionName, args = [], blockNumber }: { address?: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    // The vault's own views.
    if (address !== undefined && address !== DIAMOND && !['decimals', 'symbol'].includes(functionName)) {
      const owner = this.ownerOfVault(address);
      const r = this.acct(owner);
      switch (functionName) {
        case 'protectionState':
          return [r.enabled, r.locked, r.delaySeconds, r.cooldownUntil, r.lockedBy, [], [...(this.allowlist.get(owner) ?? [])]];
        case 'vaultOwner':
          return r.retired ? r.controller : owner;
        case 'allowEntry':
          return { readyAt: this.allowPending.get(`${owner}:${a[0]}`) ?? 0n, epoch: 0n, active: this.allowlist.get(owner)?.has(a[0]) ?? false, verified: false };
        case 'signerEntry': {
          const c = this.signerChanges.get(`${owner}:${a[0]}`);
          return { addAt: c?.addAt ?? 0n, removeAt: c?.removeAt ?? 0n, epoch: 0n, accepted: c?.accepted ?? false, active: (c?.removeAt ?? 0n) !== 0n };
        }
        case 'pendingAdditions':
          return [
            this.keyed(owner, this.allowPending),
            this.keyed(owner, this.signerChanges).filter((w) => this.signerChanges.get(`${owner}:${w}`)!.addAt !== 0n),
          ];
        case 'replacementProposal': {
          const p = this.replacements.get(owner);
          return [p?.nominee ?? ZERO, p?.proposedBy ?? ZERO, p?.readyAt ?? 0n, 1];
        }
        default:
          throw new Error(`unexpected vault read ${functionName}`);
      }
    }
    switch (functionName) {
      case 'getPendingPayout': {
        const p = ((blockNumber !== undefined ? this.finalPayouts : null) ?? this.payouts).get(a[0]);
        return { user: p?.user ?? ZERO, kind: 0, state: p?.state ?? 0, cosigned: p?.cosigned ?? false, releaseAt: p?.releaseAt ?? 0n, asset: ASSET, recipient: p?.recipient ?? ZERO, tokenId: 0n, amount: p?.amount ?? 0n, delivered: 0n };
      }
      case 'getPendingPositionTransfer': {
        const t = this.transfers.get(a[0]);
        return { from: t?.from ?? ZERO, state: t?.state ?? 0, releaseAt: t?.releaseAt ?? 0n, to: t?.to ?? ZERO, tokenId: t?.tokenId ?? 0n };
      }
      case 'getProtection': {
        const r = this.acct(a[0]);
        return [vaultOf(a[0]), r.requireCosign, r.pendingCosignOffAt];
      }
      case 'requestCode':
        if (this.codeFails) throw new Error('rpc down');
        return 123456;
      case 'decimals':
        return 6;
      case 'symbol':
        return 'USDC';
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  /** The functions each batched read named, in order. */
  batches: string[][] = [];
  /** Each batched read in full, in order. */
  calls: { functionName: string; args?: readonly unknown[] }[][] = [];
  multicall = async ({ contracts, blockNumber }: { contracts: { address?: Address; functionName: string; args?: readonly unknown[] }[]; blockNumber?: bigint }) =>
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

  /** A vault write (`protect(data)` on `vault`): its own function and args. */
  private inner(data: Hex): { fn: string; args: readonly unknown[] } {
    const d = decodeFunctionData({ abi: PROTECTION_ABI, data });
    // Addresses decode checksummed; the fake keys them lower-case.
    return { fn: d.functionName, args: ((d.args ?? []) as readonly unknown[]).map((x) => (typeof x === 'string' ? x.toLowerCase() : x)) };
  }

  private admitVault(vault: Address, fn: string, a: readonly any[]): () => void {
    const owner = this.ownerOfVault(vault);
    const acct = this.acct(owner);
    const vlog = (eventName: string, args: Record<string, unknown>) => ({ ...logOf(eventName, args), address: vault });
    if (!acct.enabled) throw revert('NotEnabled');
    switch (fn) {
      case 'finalizeSettings': {
        const due = (at: bigint) => at !== 0n && this.now >= at;
        const others = due(acct.pendingUnlockAt) || due(acct.pendingDelayAt);
        const off = due(acct.pendingDisableAt) && !this.openRows.has(owner);
        if (due(acct.pendingDisableAt) && !off && !others) throw revert('PendingRowsExist');
        return () => {
          const logs = [];
          if (due(acct.pendingDelayAt)) (Object.assign(acct, { pendingDelayAt: 0n }), logs.push(vlog('ProtectionSettingApplied', { action: 2, value: 0n })));
          if (due(acct.pendingUnlockAt)) (Object.assign(acct, { locked: false, pendingUnlockAt: 0n }), logs.push(vlog('ProtectionSettingApplied', { action: 4, value: 0n })));
          if (off) (this.accounts.set(owner, account({ enabled: false })), logs.push(vlog('ProtectionDisabled', {})));
          this.lastLogs = logs;
        };
      }
      case 'finalizeAllowlisted': {
        if (acct.locked) throw revert('Locked');
        const k = `${owner}:${a[0]}`;
        const at = this.allowPending.get(k) ?? 0n;
        if (at === 0n) throw revert('NotRequested');
        if (this.now < at) throw revert('NotReady', [at]);
        if (this.now > at + BigInt(acct.delaySeconds)) throw revert('Expired', [at + BigInt(acct.delaySeconds)]);
        return () => {
          this.allowPending.delete(k);
          this.lastLogs = [vlog('AllowlistAdded', { destination: a[0] })];
        };
      }
      case 'finalizeSigner': {
        const k = `${owner}:${a[0]}`;
        const c = this.signerChanges.get(k);
        const add = (c?.addAt ?? 0n) !== 0n;
        const at = add ? c!.addAt : c?.removeAt ?? 0n;
        if (at === 0n) throw revert('NotRequested');
        if (this.now < at) throw revert('NotReady', [at]);
        return () => {
          this.signerChanges.delete(k);
          this.lastLogs = [vlog(add ? 'SignerAdded' : 'SignerRemoved', { signer: a[0] })];
        };
      }
      case 'finalizeReplacement': {
        const p = this.replacements.get(owner);
        if (!p) throw revert('NoProposal');
        if (this.now < p.readyAt) throw revert('NotReady', [p.readyAt]);
        if (p.proposedBy !== owner && p.approvals < p.threshold) throw revert('NotReady', [p.readyAt]);
        return () => {
          this.replacements.delete(owner);
          Object.assign(acct, { retired: true, controller: p.nominee });
          this.lastLogs = [vlog('PrimaryReplaced', { previousOwner: owner, newOwner: p.nominee, cooldownUntil: 0n })];
        };
      }
      default:
        throw new Error(`unexpected vault call ${fn}`);
    }
  }

  private admit(functionName: string, a: readonly any[], address?: Address): () => void {
    if (functionName === 'protect') {
      const { fn, args } = this.inner(a[0]);
      return this.admitVault(address!, fn, args);
    }
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
      case 'lockVaultFor': {
        const acct = this.acct(a[0]);
        if (!acct.enabled) throw revert('ProtectedModeOff', [a[0]]);
        if (!this.lockGranted.has(a[0])) throw revert('KeeperAccessRequired');
        return () => {
          // A repeat lock still drops every pending loosening change.
          Object.assign(acct, { locked: true, pendingUnlockAt: 0n, pendingDisableAt: 0n, pendingDelayAt: 0n, pendingCosignOffAt: 0n });
          for (const p of this.payouts.values()) if (p.user === a[0] && p.state === 1) p.state = 3;
          this.lastLogs = [];
        };
      }
      case 'finalizeSettingChanges': {
        if (this.paused) throw revert('EnforcedPause');
        const acct = this.acct(a[0]);
        if (acct.pendingCosignOffAt === 0n) throw revert('ChangeNotRequested');
        if (this.now < acct.pendingCosignOffAt) throw revert('ChangeNotMatured', [acct.pendingCosignOffAt]);
        if (acct.locked) throw revert('ProtectedVaultLocked', [a[0]]);
        return () => {
          if (this.settingsApplyNothing) {
            this.lastLogs = [];
            return;
          }
          Object.assign(acct, { requireCosign: false, pendingCosignOffAt: 0n });
          this.lastLogs = [logOf('SettingChangeApplied', { account: a[0], kind: 4 })];
        };
      }
      case 'applyProtection':
        return () => {
          this.lastLogs = [];
        };
      default:
        throw new Error(`unexpected call ${functionName}`);
    }
  }

  simulateContract = async ({ address, functionName, args }: { address?: Address; functionName: string; args: readonly unknown[] }) => {
    this.admit(functionName, args, address);
    return { result: undefined };
  };

  getChainId = async () => this.chainServed;

  getBlock = async ({ blockTag }: { blockTag?: string } = {}) => {
    if (blockTag === 'finalized') return { number: 100n, timestamp: this.now };
    return { number: 120n, timestamp: this.now };
  };

  getTransactionCount = async () => 7;
  /** How long a receipt takes to arrive. */
  receiptDelayMs = 0;
  waitForTransactionReceipt = async () => {
    if (this.receiptDelayMs > 0) await new Promise((res) => setTimeout(res, this.receiptDelayMs));
    return { status: 'success', logs: this.lastLogs, blockNumber: 1n };
  };

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
        writeContract: async ({ address, functionName, args }: { address?: Address; functionName: string; args: readonly unknown[] }) => {
          this.admit(functionName, args, address)();
          if (functionName === 'protect') {
            const { fn, args: inner } = this.inner(args[0] as Hex);
            this.sent.push({ fn: `protect:${fn}`, args: inner });
          } else {
            this.sent.push({ fn: functionName, args });
          }
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
    expect(changeOf(row('AllowlistAddRequested', { account: ALICE, destination: DEST, effectiveAt: '12' }))).toEqual({ t: 'allow', account: ALICE, other: DEST, at: 12n });
    expect(changeOf(row('ReplacementScheduled', { account: ALICE, nominee: BOB, readyAt: '13' }))).toEqual({ t: 'replace', account: ALICE, other: BOB, at: 13n });
    expect(changeOf(row('SettingChangeRequested', { account: ALICE, kind: 9, effectiveAt: '10' })), 'an unknown setting').toBeNull();
    expect(changeOf(row('SignerAddRequested', { account: 'nope', signer: SIGNER, effectiveAt: '1' }))).toBeNull();
  });

  it('names the same events the step reads', () => {
    expect([...CHANGE_EVENTS].sort()).toEqual(['AllowlistAddRequested', 'ReplacementScheduled', 'SettingChangeRequested', 'SignerAddRequested', 'SignerRemoveRequested']);
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
      expect(d.batches.find((b) => b.includes('getPendingPayout'))).toEqual(['getPendingPayout', 'getProtection']);
      // The transfer's account was read with the payouts: its batch adds none.
      expect(d.batches.find((b) => b.includes('getPendingPositionTransfer'))).toEqual(['getPendingPositionTransfer']);
      expect(d.batches.filter((b) => b.length === 1 && b[0] === 'getProtection'), 'no follow-up account read').toEqual([]);
    });

    it('reads each record with its own account read beside it, so a part-read batch still yields whole pairs (Codex #3090)', async () => {
      queuePayout(1n);
      queuePayout(2n, { user: BOB, recipient: BOB });
      queuePayout(3n);
      await run();
      const batch = d.calls.find((b) => b.some((c) => c.functionName === 'getPendingPayout'))!;
      expect(batch.map((c) => [c.functionName, String(c.args?.[0])])).toEqual([
        ['getPendingPayout', '1'],
        ['getProtection', ALICE],
        ['getPendingPayout', '2'],
        ['getProtection', BOB],
        ['getPendingPayout', '3'],
        ['getProtection', ALICE],
      ]);
    });

    it('keeps every record in the same chunk as its account read, even where an account names records far apart (Codex #3090 r7)', async () => {
      // 200 payouts in two chunks: payouts 1 and 101 are ALICE's, the rest
      // each a different account's and waiting on a co-sign. A run whose
      // window completes only the chunk holding payout 101 must still send it.
      const other = (i: number) => `0x${(0x1000 + i).toString(16).padStart(40, '0')}` as Address;
      d.accounts.set(ALICE, account({ requireCosign: true }));
      for (let i = 1; i <= 200; i++) {
        const id = BigInt(i);
        if (i === 1 || i === 101) queuePayout(id, { cosigned: i === 101 });
        else {
          d.accounts.set(other(i), account({ requireCosign: true }));
          queuePayout(id, { user: other(i), recipient: other(i) });
        }
      }
      const full = d.multicall;
      // #3379 B2: the account's record is then completed from its vault, a
      // read made after the chunk; it comes back here.
      const vaultRead = (q: Parameters<typeof full>[0]) => q.contracts.every((c) => c.functionName === 'protectionState' || c.functionName === 'vaultOwner');
      d.multicall = async (q) =>
        q.contracts.some((c) => c.functionName === 'getPendingPayout' && c.args?.[0] === 101n) || vaultRead(q)
          ? full(q)
          : q.contracts.map(() => ({ status: 'failure' as const, error: new Error('still in flight') }));
      await run();
      expect(d.sent.map((s) => [s.fn, s.args[0]])).toEqual([['releasePayout', 101n]]);
      for (const batch of d.calls.filter((b) => b.some((c) => c.functionName === 'getPendingPayout'))) {
        const users = new Set(batch.filter((c) => c.functionName === 'getProtection').map((c) => c.args?.[0]));
        for (const c of batch.filter((x) => x.functionName === 'getPendingPayout')) {
          expect(users.has(d.payouts.get(c.args?.[0] as bigint)!.user), `payout ${c.args?.[0]} without its account`).toBe(true);
        }
      }
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
      // #3379 B2: the co-sign switch-off is the setting whose time is readable.
      d.accounts.set(BOB, account({ pendingCosignOffAt: NOW - 5n }));
      ledger.add('SettingChangeRequested', { account: BOB, kind: 4, value: '0', effectiveAt: String(NOW - 5n) });
      const r = await run();
      expect(r.released.map((x) => x.id), 'the payout step stops at its share').toEqual([1n, 2n, 3n, 4n]);
      expect(r.transferred).toEqual([1n]);
      expect(r.finalized).toEqual([`cosign-off:${BOB.slice(0, 10)}`]);
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
      d.accounts.set(BOB, account({ pendingCosignOffAt: NOW - 5n }));
      ledger.add('SettingChangeRequested', { account: BOB, kind: 4, value: '0', effectiveAt: String(NOW - 5n) });
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
    it("applies the co-sign switch-off on the Diamond, and leaves the vault's settings unread: their times are not readable (#3379 B2)", async () => {
      d.accounts.set(ALICE, account({ locked: true, pendingUnlockAt: NOW - 5n }));
      d.accounts.set(BOB, account({ pendingDelayAt: NOW - 5n, pendingCosignOffAt: NOW - 1n }));
      ledger.add('SettingChangeRequested', { account: ALICE, kind: 5, value: '0', effectiveAt: String(NOW - 5n) });
      ledger.add('SettingChangeRequested', { account: BOB, kind: 2, value: '7200', effectiveAt: String(NOW - 5n) });
      ledger.add('SettingChangeRequested', { account: BOB, kind: 4, value: '0', effectiveAt: String(NOW - 1n) });
      ledger.add('SettingChangeRequested', { account: BOB, kind: 3, value: '0', effectiveAt: String(NOW - 1n) });
      const r = await run();
      expect(d.sent.map((s) => [s.fn, s.args])).toEqual([['finalizeSettingChanges', [BOB]]]);
      expect(r.finalized).toEqual([`cosign-off:${BOB.slice(0, 10)}`]);
      // The unlock and the lowered delay are the vault's: never sent, never
      // settled, and said so.
      expect(r.unread.get(`finalize:setting:${ALICE}:5:${NOW - 5n}`)).toMatch(/does not expose/);
      expect(r.unread.get(`finalize:setting:${BOB}:2:${NOW - 5n}`)).toMatch(/does not expose/);
      expect(d.accounts.get(ALICE)!.locked).toBe(true);
      // The retired NFT switch-off has nothing pending: finished, below the
      // unread rows, so the floor stays.
      expect(cursors.rows.has(CHANGE_FLOOR_ITEM)).toBe(false);
    });

    it('reports a setting only from its receipt: a landed call that applied nothing reports nothing (Codex #3090)', async () => {
      // A replacement finalized first, or a cancel between read and send,
      // leaves the setting's call landing with no SettingChangeApplied.
      d.accounts.set(ALICE, account({ pendingCosignOffAt: NOW - 5n }));
      d.settingsApplyNothing = true;
      ledger.add('SettingChangeRequested', { account: ALICE, kind: 4, value: '0', effectiveAt: String(NOW - 5n) });
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

    it('waits on a locked account, an expired allowlist addition, an unaccepted or expired signer addition, and sends no replacement short of its approvals', async () => {
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
      });
      // #3379 B2: the vault does not expose the approval tally; its own check
      // refuses the replacement at the simulation, and nothing is sent.
      expect(r.refused.get(`finalize:replace:${ALICE}`)).toBe('NotReady');
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
      // #3379 B2: each goes to its account's vault, through `protect`; the
      // replacement is followed by the Diamond's `applyProtection`.
      expect(d.sent.map((s) => [s.fn, s.args])).toEqual([
        ['protect:finalizeAllowlisted', [DEST]],
        ['protect:finalizeSigner', [SIGNER]],
        ['protect:finalizeSigner', [SIGNER]],
        ['protect:finalizeReplacement', []],
        ['applyProtection', [BOB]],
      ]);
      expect(r.finalized).toHaveLength(4);
      expect(cursors.rows.get(CHANGE_FLOOR_ITEM)).toBe(encodePos(ledger.rows[3]));
    });
  });
});

class FakeStore implements ProtectedStore {
  requests: LockRequest[] = [];
  subs = new Map<string, Subscriber>();
  handled = new Map<number, { outcome: LockOutcome; at: number }>();
  markFails = false;
  /** One entry per wallet, in the order of its oldest open request, with
   *  its newest id and time (as `d1ProtectedStore` reads them). */
  async lockRequests(_chainId: number, limit: number) {
    const groups = new Map<Address, LockRequest>();
    for (const q of this.requests) {
      if (this.handled.has(q.id)) continue;
      const g = groups.get(q.wallet);
      groups.set(q.wallet, g === undefined ? q : { ...q, requestedAt: Math.max(g.requestedAt, q.requestedAt) });
    }
    return [...groups.values()].slice(0, limit);
  }
  async markHandled(_chainId: number, wallet: Address, upToId: number, outcome: LockOutcome, at: number) {
    if (this.markFails) throw new Error('D1 unavailable');
    for (const q of this.requests) if (q.wallet === wallet && q.id <= upToId && !this.handled.has(q.id)) this.handled.set(q.id, { outcome, at });
  }
  async subscriber(chainId: number, wallet: Address) {
    return this.subs.get(`${chainId}:${wallet}`) ?? null;
  }
  readiness = new Map<number, number>();
  async publishLockReadiness(chainId: number, nowSec: number) {
    this.readiness.set(chainId, nowSec);
  }
  pendingFails = false;
  async pendingLockWallets(_chainId: number, sinceSec: number) {
    if (this.pendingFails) throw new Error('D1 unavailable');
    return new Set(this.requests.filter((q) => !this.handled.has(q.id) && q.requestedAt >= sinceSec).map((q) => q.wallet));
  }
}

describe('the Telegram steps', () => {
  let d: FakeDiamond;
  let ledger: FakeLedger;
  let cursors: ReturnType<typeof memoryScanCursors>;
  let store: FakeStore;
  let sent: Alert[];
  /** What each channel does with the next alerts, in order; then `SENT`. */
  let outcomes: DeliveryOutcome[];
  const SENT: DeliveryOutcome = { telegram: 'sent', push: 'off' };
  const notify = async (a: Alert): Promise<DeliveryOutcome> => {
    sent.push(a);
    return outcomes.shift() ?? SENT;
  };
  // The agent's clock and the chain's agree, as they do to within seconds.
  const NOW_SEC = Number(NOW);

  beforeEach(() => {
    d = new FakeDiamond();
    ledger = new FakeLedger();
    cursors = memoryScanCursors();
    store = new FakeStore();
    sent = [];
    outcomes = [];
    d.accounts.set(ALICE, account());
    d.accounts.set(BOB, account({ locked: true }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (lock = true, alerts = true) =>
    protectedOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: Number.POSITIVE_INFINITY,
      cursors,
      ledger,
      telegram: { lock, alerts, store, notify, appOrigin: 'https://app.test', nowSec: () => NOW_SEC },
    });
  const request = (id: number, wallet: Address, ageSec = 10): LockRequest => ({ id, wallet, chatId: `chat-${id}`, requestedAt: NOW_SEC - ageSec, locale: 'en' });

  it('locks a granted account before any release, and answers every request with what it saw', async () => {
    d.lockGranted.add(ALICE);
    d.lockGranted.add(BOB);
    d.payouts.set(1n, { user: ALICE, state: 1, cosigned: false, releaseAt: NOW - 1n, recipient: ALICE, amount: 100n });
    ledger.add(PAYOUT_EVENT, { account: ALICE, id: '1' });
    d.accounts.set(DEST, account());
    // Locked since its request; #3379 B2: the vault does not expose when, so
    // it is locked again rather than answered as already locked.
    d.accounts.set(CAROL, account({ locked: true, lockedAt: NOW - 5n }));
    d.lockGranted.add(CAROL);
    store.requests = [
      request(1, ALICE),
      request(2, BOB), // locked before its request
      request(3, DEST), // not granted
      request(4, SIGNER), // protected mode off
      request(5, CAROL, 60),
      request(6, OLD_1, 2 * 3600), // older than an hour
      request(7, OLD_2, 3 * 86400), // older than a day: silent
      request(8, ALICE), // sent again: one lock answers both
    ];
    const r = await run(true, false);
    expect(d.sent.map((s) => [s.fn, s.args])).toEqual([['lockVaultFor', [ALICE]], ['lockVaultFor', [BOB]], ['lockVaultFor', [CAROL]]]);
    expect(r.locks!.map((l) => l.outcome)).toEqual(['locked', 'locked-again', 'not-allowed', 'not-protected', 'locked-again', 'expired', 'dropped-old']);
    expect(r.released, 'the lock cancelled the payout before the release step').toEqual([]);
    expect(sent.map((a) => a.tgChatId)).toEqual(['chat-8', 'chat-2', 'chat-3', 'chat-4', 'chat-5', 'chat-6']);
    expect(sent[0].text).toMatch(/^Locked: /);
    expect(sent[1].text).toMatch(/lock was set again, which cancels any pending unlock/);
    expect(sent[2].text).toMatch(/not allowed the keeper to lock/);
    expect(sent[4].text).toMatch(/lock was set again, which cancels any pending unlock/);
    expect(sent.every((a) => !a.pushSubscriber), 'an answer goes to the chat only').toBe(true);
    expect([...store.handled].map(([id, h]) => [id, h.outcome, h.at])).toEqual([
      [1, 'locked', NOW_SEC],
      [8, 'locked', NOW_SEC],
      [2, 'locked-again', NOW_SEC],
      [3, 'not-allowed', NOW_SEC],
      [4, 'not-protected', NOW_SEC],
      [5, 'locked-again', NOW_SEC],
      [6, 'expired', NOW_SEC],
      [7, 'dropped-old', NOW_SEC],
    ]);
    sent = [];
    d.sent = [];
    const again = await run(true, false);
    expect(again.locks, 'a handled request is never read again').toEqual([]);
    expect(sent).toEqual([]);
  });

  it('locks an already-locked account again, so a pending unlock cannot mature in the same run', async () => {
    d.lockGranted.add(BOB);
    d.accounts.set(BOB, account({ locked: true, pendingUnlockAt: NOW - 5n }));
    ledger.add('SettingChangeRequested', { account: BOB, kind: 5, value: '0', effectiveAt: String(NOW - 5n) });
    store.requests = [request(1, BOB)];
    const r = await run(true, false);
    expect(r.locks!.map((l) => l.outcome)).toEqual(['locked-again']);
    expect(sent[0].text).toMatch(/lock was set again, which cancels any pending unlock/);
    expect(d.sent.map((s) => s.fn)).toEqual(['lockVaultFor']);
    expect(d.accounts.get(BOB)!.locked, 'the unlock was dropped, not applied').toBe(true);
  });

  it('reads requests again when their record could not be written', async () => {
    d.lockGranted.add(ALICE);
    d.lockGranted.add(BOB);
    store.requests = [request(1, ALICE), request(2, BOB)];
    store.markFails = true;
    const r = await run(true, false);
    expect(r.locks!.map((l) => l.outcome), 'it stops at the first unrecorded request').toEqual(['locked']);
    expect(r.unread.get(`lock:${ALICE}`)).toMatch(/the record of its LOCK request/);
    expect(sent.map((a) => a.text), 'the lock was made, so it is still answered').toEqual([expect.stringMatching(/^Locked: /)]);
    store.markFails = false;
    sent = [];
    const again = await run(true, false);
    // #3379 B2: the vault does not expose when its lock was set, so a lock
    // that postdates Alice's request cannot be told from an older one: she
    // is locked again (a repeat lock changes nothing else), and answered so.
    expect(again.locks!.map((l) => [l.wallet, l.outcome])).toEqual([[ALICE, 'locked-again'], [BOB, 'locked-again']]);
    expect(d.sent.filter((s) => s.fn === 'lockVaultFor').map((s) => s.args)).toEqual([[ALICE], [ALICE], [BOB]]);
    expect(store.handled.size).toBe(2);
  });

  it('records a lock whose receipt arrived after the read cutoff', async () => {
    d.lockGranted.add(ALICE);
    store.requests = [request(1, ALICE)];
    // The read window (deadline less the send reserve) is spent when the
    // receipt arrives: the record is still written.
    const deadline = Date.now() + SEND_RESERVE_MS + 300;
    d.receiptDelayMs = 600;
    const r = await protectedOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: deadline,
      cursors,
      ledger,
      telegram: { lock: true, alerts: false, store, notify, appOrigin: '', nowSec: () => NOW_SEC },
    });
    expect(r.locks!.map((l) => [l.wallet, l.outcome])).toEqual([[ALICE, 'locked']]);
    expect(store.handled.get(1)?.outcome).toBe('locked');
  });

  it('leaves a request it could not finish for the next run', async () => {
    d.lockGranted.add(ALICE);
    store.requests = [request(1, ALICE)];
    d.paused = true; // does not stop a lock
    const r = await protectedOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => null, // no signing key: the send is skipped
      sendDeadline: Number.POSITIVE_INFINITY,
      cursors,
      ledger,
      telegram: { lock: true, alerts: false, store, notify, appOrigin: '', nowSec: () => NOW_SEC },
    });
    expect(r.locks).toEqual([]);
    expect(sent).toEqual([]);
    expect(store.handled.size).toBe(0);
  });

  it('alerts the subscribed owner on a lock, a queued payout and a proposed replacement', async () => {
    store.subs.set(`${CHAIN}:${ALICE}`, { tgChatId: '42', push: true, locale: 'en' });
    const at = NOW_SEC - 30;
    ledger.rows.push({ kind: 'VaultLocked', args: { account: ALICE, by: SIGNER }, blockAt: at, block: 1, log: 0, tx: '0x' });
    ledger.rows.push({ kind: 'PayoutQueued', args: { account: ALICE, id: '9', asset: ASSET, kind: '0', tokenId: '0', amount: '2500000', recipient: DEST, releaseAt: String(NOW_SEC + 3600) }, blockAt: at, block: 2, log: 0, tx: '0x' });
    ledger.rows.push({ kind: 'ReplacementProposed', args: { account: ALICE, nominee: BOB, by: SIGNER, round: '1' }, blockAt: at, block: 3, log: 0, tx: '0x' });
    ledger.rows.push({ kind: 'VaultLocked', args: { account: BOB, by: BOB }, blockAt: at, block: 4, log: 0, tx: '0x' }); // no subscription
    ledger.rows.push({ kind: 'VaultLocked', args: { account: ALICE, by: ALICE }, blockAt: NOW_SEC - 7200, block: 5, log: 0, tx: '0x' }); // stale
    const r = await run(false, true);
    expect(r.alerts).toEqual({ sent: 3, undelivered: 0, retrying: 0, stale: 1, unsubscribed: 1 });
    expect(sent.map((a) => [a.tgChatId, a.pushSubscriber])).toEqual([['42', ALICE], ['42', ALICE], ['42', ALICE]]);
    expect(sent[0].text).toContain(`locked by ${SIGNER}, a wallet allowed to lock it`);
    expect(sent[1].text).toContain('2.5 USDC');
    expect(sent[1].text).toContain(`to ${DEST}`);
    // The app's rendering of the same code (`formatRequestCode`).
    expect(sent[1].text).toContain('Request code AADYSA');
    // LOCK is off in this run, so the payout alert does not suggest it (Codex #3092 r11).
    expect(sent[1].text).not.toContain('send LOCK');
    expect(sent[1].text).toContain('lock the vault in the app');
    expect(sent[2].text).toContain(`naming ${BOB}`);
    // The owner cannot cancel while a signer holds a lock, and is told so.
    expect(sent[2].text).toContain('only a signer can cancel it');
    expect(cursors.rows.get(ALERT_NEXT_ITEM)).toBe(encodePos(ledger.rows[4]));
    // Read again: nothing is alerted twice.
    sent = [];
    await run(false, true);
    expect(sent).toEqual([]);
  });

  describe('the LOCK advice in a payout alert', () => {
    const queue = () =>
      ledger.rows.push({ kind: 'PayoutQueued', args: { account: ALICE, id: '9', asset: ASSET, kind: '0', tokenId: '0', amount: '2500000', recipient: DEST, releaseAt: String(NOW_SEC + 3600) }, blockAt: NOW_SEC - 30, block: 1, log: 0, tx: '0x' });

    it('suggests LOCK where a LOCK from the linked chat would lock the vault (Codex #3092 r11)', async () => {
      d.lockGranted.add(ALICE);
      store.subs.set(`${CHAIN}:${ALICE}`, { tgChatId: '42', push: false, locale: 'en' });
      queue();
      await run(true, true);
      expect(sent.map((a) => a.text)).toEqual([expect.stringContaining('send LOCK')]);
      // The advice was simulated, never sent.
      expect(d.sent.filter((s) => s.fn === 'lockVaultFor')).toEqual([]);
    });

    it('gives the app-only advice to a Push-only subscriber, who has no chat to send LOCK from (Codex #3092 r12)', async () => {
      d.lockGranted.add(ALICE);
      store.subs.set(`${CHAIN}:${ALICE}`, { tgChatId: null, push: true, locale: 'en' });
      queue();
      await run(true, true);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).not.toContain('send LOCK');
      expect(sent[0].text).toContain('lock the vault in the app');
    });

    it('gives the app-only advice when the owner has not granted the keeper the lock', async () => {
      store.subs.set(`${CHAIN}:${ALICE}`, { tgChatId: '42', push: false, locale: 'en' });
      queue();
      await run(true, true);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).not.toContain('send LOCK');
      expect(sent[0].text).toContain('lock the vault in the app');
    });
  });

  it("sends a retired account's alerts to its controller, never to the old wallet (Codex #3092 r9)", async () => {
    d.accounts.set(ALICE, account({ retired: true, controller: BOB }));
    store.subs.set(`${CHAIN}:${ALICE}`, { tgChatId: '42', push: true, locale: 'en' }); // the old wallet's channels
    store.subs.set(`${CHAIN}:${BOB}`, { tgChatId: '7', push: true, locale: 'en' });
    const at = NOW_SEC - 30;
    ledger.rows.push({ kind: 'VaultLocked', args: { account: ALICE, by: BOB }, blockAt: at, block: 1, log: 0, tx: '0x' });
    ledger.rows.push({ kind: 'ReplacementProposed', args: { account: ALICE, nominee: DEST, by: SIGNER, round: '2' }, blockAt: at, block: 2, log: 0, tx: '0x' });
    ledger.rows.push({ kind: 'PayoutQueued', args: { account: ALICE, id: '9', asset: ASSET, kind: '0', tokenId: '0', amount: '2500000', recipient: DEST, releaseAt: String(NOW_SEC + 3600) }, blockAt: at, block: 3, log: 0, tx: '0x' });
    const r = await run(true, true); // LOCK on: only the retirement withholds the advice
    expect(r.alerts!.sent).toBe(3);
    expect(sent.map((a) => [a.tgChatId, a.pushSubscriber])).toEqual([['7', BOB], ['7', BOB], ['7', BOB]]);
    // The text still names the vault, and a lock by its controller is the owner's own.
    expect(sent[0].text).toContain(ALICE.slice(0, 6));
    expect(sent[0].text).not.toContain('a wallet allowed to lock it');
    // A LOCK from the controller's chat would lock the controller's own
    // vault, so the payout alert does not offer it (Codex #3092 r10).
    expect(sent[2].text).not.toContain('send LOCK');
    expect(sent[2].text).toContain('lock the vault in the app');
  });

  it("waits for a payout alert's request code rather than alerting without it", async () => {
    store.subs.set(`${CHAIN}:${ALICE}`, { tgChatId: '42', push: false, locale: 'en' });
    d.codeFails = true;
    ledger.rows.push({ kind: 'PayoutQueued', args: { account: ALICE, id: '9', asset: ASSET, kind: '0', tokenId: '0', amount: '1', recipient: DEST, releaseAt: '0' }, blockAt: NOW_SEC, block: 1, log: 0, tx: '0x' });
    const r = await run(false, true);
    expect(r.alerts!.sent).toBe(0);
    expect(cursors.rows.has(ALERT_NEXT_ITEM)).toBe(false);
    d.codeFails = false;
    expect((await run(false, true)).alerts!.sent).toBe(1);
  });

  it('says it is working LOCK requests only while it can sign', async () => {
    await run(true, false);
    expect(store.readiness.get(CHAIN), 'a keeper with a key publishes the heartbeat').toBe(NOW_SEC);
    store.readiness.clear();
    const r = await protectedOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => null,
      sendDeadline: Number.POSITIVE_INFINITY,
      cursors,
      ledger,
      telegram: { lock: true, alerts: false, store, notify, appOrigin: '', nowSec: () => NOW_SEC },
    });
    expect(store.readiness.size, 'no key, no heartbeat: the agent stops taking LOCK').toBe(0);
    expect(r.unread.get('lock')).toMatch(/a signing key for this chain/);
    await run(false, true);
    expect(store.readiness.size, 'nor while the LOCK step is off').toBe(0);
  });

  it("holds an account's releases while its LOCK request waits for the next run", async () => {
    // Five owners ask to lock; the step's share is four sends a run, so the
    // fifth waits. Its payout is due, and must not go before its lock.
    const owners = [1, 2, 3, 4, 5].map((n) => `0x${(0xc00 + n).toString(16).padStart(40, '0')}` as Address);
    owners.forEach((o, i) => {
      d.accounts.set(o, account());
      d.lockGranted.add(o);
      store.requests.push(request(i + 1, o));
    });
    const last = owners[4]!;
    d.payouts.set(1n, { user: last, state: 1, cosigned: false, releaseAt: NOW - 1n, recipient: DEST, amount: 100n });
    ledger.add(PAYOUT_EVENT, { account: last, id: '1' });
    d.transfers.set(2n, { from: last, state: 1, releaseAt: NOW - 1n, to: DEST, tokenId: 7n });
    ledger.add(TRANSFER_EVENT, { from: last, id: '2' });
    const r = await run(true, false);
    expect(d.sent.filter((s) => s.fn === 'lockVaultFor')).toHaveLength(4);
    expect(r.released).toEqual([]);
    expect(r.transferred).toEqual([]);
    expect(r.waiting.get('payout-lock-requested')).toBe(1);
    expect(r.waiting.get('transfer-lock-requested')).toBe(1);
    // The next run locks it, and the lock cancels the payout.
    const again = await run(true, false);
    expect(again.locks!.map((l) => [l.wallet, l.outcome])).toEqual([[last, 'locked']]);
    expect(again.released).toEqual([]);
  });

  it('releases nothing when the open LOCK requests cannot be read', async () => {
    d.payouts.set(1n, { user: ALICE, state: 1, cosigned: false, releaseAt: NOW - 1n, recipient: ALICE, amount: 100n });
    ledger.add(PAYOUT_EVENT, { account: ALICE, id: '1' });
    store.pendingFails = true;
    const r = await run(true, false);
    expect(r.released).toEqual([]);
    expect(r.unread.get('release')).toMatch(/no payout or transfer is released this run/);
    store.pendingFails = false;
    expect((await run(true, false)).released.map((x) => x.id)).toEqual([1n]);
  });

  it('keeps an alert no channel took but one may, and passes over one refused for good', async () => {
    store.subs.set(`${CHAIN}:${ALICE}`, { tgChatId: '42', push: true, locale: 'en' });
    const at = NOW_SEC - 30;
    ledger.rows.push({ kind: 'VaultLocked', args: { account: ALICE, by: ALICE }, blockAt: at, block: 1, log: 0, tx: '0x' });
    ledger.rows.push({ kind: 'VaultLocked', args: { account: ALICE, by: SIGNER }, blockAt: at, block: 2, log: 0, tx: '0x' });
    outcomes = [{ telegram: 'retry', push: 'refused' }];
    const first = await run(false, true);
    expect(first.alerts).toMatchObject({ sent: 0, retrying: 1, undelivered: 0 });
    expect(cursors.rows.has(ALERT_NEXT_ITEM), 'the cursor stays before it').toBe(false);
    expect(describeReport(first)).toMatch(/owner-alerts=sent 0, retrying 1, undelivered 0/);
    // Next run: Telegram takes the first while Push may not have; the second
    // is refused on both, for good.
    outcomes = [{ telegram: 'sent', push: 'retry' }, { telegram: 'refused', push: 'refused' }];
    const second = await run(false, true);
    expect(second.alerts).toMatchObject({ sent: 1, retrying: 0, undelivered: 1 });
    expect(cursors.rows.get(ALERT_NEXT_ITEM)).toBe(encodePos(ledger.rows[1]));
  });

  it('runs the alerts before the LOCK step, and names a LOCK answer that did not reach the chat', async () => {
    d.lockGranted.add(ALICE);
    store.subs.set(`${CHAIN}:${ALICE}`, { tgChatId: '42', push: false, locale: 'en' });
    ledger.rows.push({ kind: 'VaultLocked', args: { account: ALICE, by: SIGNER }, blockAt: NOW_SEC - 30, block: 1, log: 0, tx: '0x' });
    store.requests = [request(1, ALICE)];
    outcomes = [SENT, { telegram: 'retry', push: 'off' }];
    const r = await run(true, true);
    expect(sent.map((a) => a.tgChatId)).toEqual(['42', 'chat-1']);
    expect(r.locks).toEqual([{ wallet: ALICE, outcome: 'locked', answered: false }]);
    expect(store.handled.get(1)?.outcome, 'the row records what was done either way').toBe('locked');
    expect(describeReport(r)).toMatch(/\(locked, answer not delivered\)/);
  });

  it('still locks for an owner who unlinked Telegram since, and answers nowhere', async () => {
    d.lockGranted.add(ALICE);
    store.requests = [{ ...request(1, ALICE), chatId: null }];
    const r = await run(true, false);
    expect(d.sent.map((s) => [s.fn, s.args])).toEqual([['lockVaultFor', [ALICE]]]);
    expect(r.locks).toEqual([{ wallet: ALICE, outcome: 'locked', answered: null }]);
    expect(sent, 'no chat is kept for it, so none is messaged').toEqual([]);
    expect(store.handled.get(1)?.outcome).toBe('locked');
  });

  it('gives the alerts a share of the window: a slow channel leaves the LOCK step its time, and nothing sent is sent twice', async () => {
    d.lockGranted.add(ALICE);
    store.requests = [request(1, ALICE)];
    store.subs.set(`${CHAIN}:${BOB}`, { tgChatId: '7', push: false, locale: 'en' });
    for (let b = 1; b <= 4; b++) ledger.rows.push({ kind: 'VaultLocked', args: { account: BOB, by: BOB }, blockAt: NOW_SEC - 30, block: b, log: 0, tx: '0x' });
    const slow = async (a: Alert): Promise<DeliveryOutcome> => {
      sent.push(a);
      if (a.tgChatId === '7') await new Promise((res) => setTimeout(res, 600));
      return SENT;
    };
    // The read cutoff is 3 s away, so the alerts' share ends after 1 s:
    // two slow alerts go out, and the rest wait.
    const opts = () => ({
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: Date.now() + SEND_RESERVE_MS + 3000,
      cursors,
      ledger,
      telegram: { lock: true, alerts: true, store, notify: slow, appOrigin: '', nowSec: () => NOW_SEC },
    });
    const r = await protectedOnce(CHAIN, DIAMOND, opts());
    expect(r.alerts!.sent).toBe(2);
    expect(r.unread.get('alert')).toMatch(/past the step's cutoff/);
    expect(cursors.rows.get(ALERT_NEXT_ITEM), 'written after each alert sent').toBe(encodePos(ledger.rows[1]));
    expect(d.sent.map((s) => s.fn), 'the LOCK step still ran').toEqual(['lockVaultFor']);
    sent = [];
    const again = await protectedOnce(CHAIN, DIAMOND, opts());
    expect(again.alerts!.sent).toBe(2);
    expect(sent.filter((a) => a.tgChatId === '7'), 'the next run starts at the third alert').toHaveLength(2);
    expect(cursors.rows.get(ALERT_NEXT_ITEM)).toBe(encodePos(ledger.rows[3]));
  });

  it("gives the LOCK step a share of the window: slow lock receipts leave the other owners' releases their time (Codex #3092 r10)", async () => {
    d.lockGranted.add(ALICE);
    d.lockGranted.add(BOB);
    d.accounts.set(BOB, account());
    d.accounts.set(DEST, account());
    d.payouts.set(1n, { user: DEST, state: 1, cosigned: false, releaseAt: NOW - 1n, recipient: DEST, amount: 100n });
    ledger.add(PAYOUT_EVENT, { account: DEST, id: '1' });
    store.requests = [request(1, ALICE), request(2, BOB)];
    d.receiptDelayMs = 1200;
    // The read cutoff is 2 s away, so the LOCK step starts locks only in the
    // first second: one lock goes out, and the payout is still released.
    const r = await protectedOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: Date.now() + SEND_RESERVE_MS + 2000,
      cursors,
      ledger,
      telegram: { lock: true, alerts: false, store, notify, appOrigin: '', nowSec: () => NOW_SEC },
    });
    expect(d.sent.map((x) => [x.fn, x.args[0]])).toEqual([['lockVaultFor', ALICE], ['releasePayout', 1n]]);
    expect(r.locks!.map((l) => l.wallet)).toEqual([ALICE]);
  });

  it('runs neither step when its flag is off, and says so in the line', async () => {
    store.requests = [request(1, ALICE)];
    const r = await run(false, false);
    expect(r.locks).toBeNull();
    expect(r.alerts).toBeNull();
    expect(describeReport(r)).not.toMatch(/telegram-locks|owner-alerts/);
  });
});
