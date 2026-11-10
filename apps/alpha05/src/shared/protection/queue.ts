/**
 * LN-54 / LN-55 / LN-56 — a protected account's payout queue: what waits,
 * for how long, to which destination, under which request code, and the one
 * rule per action (release, cancel, co-sign) that decides whether this wallet
 * may run it now (RB-ELIG).
 *
 * What the contract checks, in its own order (`VaultPayoutFacet`):
 * - release (anyone): the pause, unless the escape route is open; a queued
 *   row whose destination is no longer allowed is CANCELLED instead of paid,
 *   before any time check, and its asset stays in the vault; otherwise the
 *   row must be queued, due, the account unlocked, and co-signed when the
 *   account requires it;
 * - cancel: the account's manager (its own wallet, or its controller once a
 *   replacement retired it) or one of its secondary signers, for a queued
 *   row; it works during a pause;
 * - co-sign: one of the account's secondary signers, for a queued row.
 *
 * A row's destination is allowed when it is the manager wallet or on the
 * account's allowlist (`LibProtectedAccount.isAllowed`). A lock cancels every
 * queued row, so a locked account's queue is empty.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import { formatRequestCode } from '@vaipakam/lib/requestCode';
import type { CopyAccess } from '../copy/useCopy';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from '../eligibility/types';
import { answerOrNull } from '../reads/answer';
import { readProtectedRecord } from './payout';

type Hex = `0x${string}`;

export const PAYOUT = VaultPayoutFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;

/** `LibProtectedAccount.ROW_*`. */
export const ROW_QUEUED = 1;
export const ROW_RELEASED = 2;
export const ROW_CANCELLED = 3;

/** `LibVaipakam.AssetType.ERC20`. */
export const KIND_ERC20 = 0;

/** One queued payout as the protocol stores it. */
export interface PendingPayout {
  /** The protected account the row belongs to. */
  user: Hex;
  state: number;
  kind: number;
  asset: Hex;
  tokenId: bigint;
  amount: bigint;
  recipient: Hex;
  /** Unix seconds from which it can be released. */
  releaseAt: number;
  cosigned: boolean;
}

/** A row of the queue: its id, the row (null when its read failed), and its
 *  request code exactly as alerts write it (null when unread). */
export interface QueueRow {
  id: bigint;
  payout: PendingPayout | null;
  code: string | null;
}

/** The parts of the account's mode the queue's rules read. */
export interface QueueMode {
  enabled: boolean;
  locked: boolean;
  requireCosign: boolean;
  retired: boolean;
  delaySeconds: number;
  controller: Hex;
}

export interface AccountQueue {
  account: Hex;
  mode: QueueMode | null;
  signers: readonly Hex[] | null;
  allowlist: readonly Hex[] | null;
  paused: boolean | null;
  escapeOpen: boolean | null;
  /** Unix seconds the escape route opens under the pause in force; 0 when
   *  no manual pause is in force; null when unread. */
  escapeOpensAt: number | null;
  /** In the order they come due; null when the list itself was unread. */
  rows: QueueRow[] | null;
  /** The latest block's time (unix seconds) when read: a row comes due by
   *  the chain's clock, not the browser's. Null when unread. */
  chainNow: number | null;
  readAt: number;
}

/** The chain's clock now: its time at the read plus what has passed since,
 *  or null when the block time was unread. */
export function queueClock(q: Pick<AccountQueue, 'chainNow' | 'readAt'>, nowMs: number): number | null {
  return q.chainNow === null ? null : q.chainNow + Math.max(0, Math.floor((nowMs - q.readAt) / 1000));
}

type RawPayout = {
  user: Hex;
  kind: number | bigint;
  state: number | bigint;
  cosigned: boolean;
  releaseAt: number | bigint;
  asset: Hex;
  recipient: Hex;
  tokenId: bigint;
  amount: bigint;
};
type RawMode = { enabled: boolean; locked: boolean; requireCosign: boolean; retired: boolean; delaySeconds: number | bigint; controller: Hex };

/** The account's queue and every fact its rules read, in one go. A row
 *  whose read failed stays in the list, said so. */
export async function readAccountQueue(c: PublicClient, diamond: Hex, account: Hex): Promise<AccountQueue> {
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => answerOrNull(c.readContract({ address: diamond, abi, functionName, args }) as Promise<T>);
  // #3379 B2: the mode, its signers and its allowlist are the vault's record.
  const [block, record, paused, escapeOpen, escapeOpensAt, ids] = await Promise.all([
    c.getBlock(),
    answerOrNull(readProtectedRecord(c, diamond, account)),
    read<boolean>(ADMIN, 'paused'),
    read<boolean>(PAYOUT, 'isEscapeOpen'),
    read<bigint>(PAYOUT, 'escapeOpensAt'),
    read<readonly bigint[]>(PAYOUT, 'getPendingPayoutIds', [account]),
  ]);
  const rows = ids === null ? null : await Promise.all(ids.map((id) => readQueueRow(c, diamond, id)));
  const mode: RawMode | null = record === null ? null : record.record;
  const signers = record === null ? null : record.signers;
  const allowlist = record === null ? null : record.allowlist;
  return {
    account,
    mode:
      mode === null
        ? null
        : {
            enabled: mode.enabled,
            locked: mode.locked,
            requireCosign: mode.requireCosign,
            retired: mode.retired,
            delaySeconds: Number(mode.delaySeconds),
            controller: mode.controller,
          },
    signers,
    allowlist,
    paused,
    escapeOpen,
    escapeOpensAt: escapeOpensAt === null ? null : Number(escapeOpensAt),
    rows: rows === null ? null : orderByDue(rows),
    chainNow: Number(block.timestamp),
    readAt: Date.now(),
  };
}

/** One row by its id, in whatever state it is: the row and its request
 *  code, each null when its read failed. */
export async function readQueueRow(c: PublicClient, diamond: Hex, id: bigint): Promise<QueueRow> {
  const read = <T>(functionName: string) => answerOrNull(c.readContract({ address: diamond, abi: PAYOUT, functionName, args: [id] }) as Promise<T>);
  const [p, code] = await Promise.all([read<RawPayout>('getPendingPayout'), read<number | bigint>('requestCode')]);
  return {
    id,
    payout:
      p === null
        ? null
        : {
            user: p.user,
            state: Number(p.state),
            kind: Number(p.kind),
            asset: p.asset,
            tokenId: p.tokenId,
            amount: p.amount,
            recipient: p.recipient,
            releaseAt: Number(p.releaseAt),
            cosigned: p.cosigned,
          },
    code: code === null ? null : formatRequestCode(code),
  };
}

/** The queue in the order it comes due; a row whose read failed last. */
export function orderByDue(rows: readonly QueueRow[]): QueueRow[] {
  return [...rows].sort((a, b) => {
    if (a.payout === null || b.payout === null) return a.payout === null ? (b.payout === null ? 0 : 1) : -1;
    return a.payout.releaseAt - b.payout.releaseAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/** The wallet that manages the account: its controller once retired. */
export function queueManager(q: Pick<AccountQueue, 'account' | 'mode'>): Hex | null {
  if (q.mode === null) return null;
  return q.mode.retired ? q.mode.controller : q.account;
}

/** Whether `who` is one of the account's secondary signers; null unread. */
export function isQueueSigner(q: Pick<AccountQueue, 'signers'>, who: Hex): boolean | null {
  return q.signers === null ? null : q.signers.some((s) => same(s, who));
}

/** Whether a payout may still go to its destination; null when unread. */
export function destinationAllowed(q: Pick<AccountQueue, 'account' | 'mode' | 'allowlist'>, recipient: Hex): boolean | null {
  const manager = queueManager(q);
  if (manager === null) return null;
  if (same(recipient, manager)) return true;
  return q.allowlist === null ? null : q.allowlist.some((a) => same(a, recipient));
}

export type QueueAction = 'release' | 'cancel' | 'cosign';

/** The call each action runs. */
export const QUEUE_FUNCTION: Record<QueueAction, string> = { release: 'releasePayout', cancel: 'cancelPayout', cosign: 'cosignPayout' };

/** Whether releasing this row would cancel it instead of paying it (its
 *  destination is no longer allowed); null when unread. */
export function releaseCancels(q: AccountQueue, row: QueueRow): boolean | null {
  if (row.payout === null) return null;
  if (row.payout.state !== ROW_QUEUED) return false;
  const allowed = destinationAllowed(q, row.payout.recipient);
  return allowed === null ? null : !allowed;
}

/** RB-ELIG: whether `viewer` may run `action` on `row` now, `nowSec` being
 *  the chain's clock (`queueClock`; null when unread). */
export function queueVerdict(action: QueueAction, q: AccountQueue, row: QueueRow, viewer: Hex, nowSec: number | null, copy: Pick<CopyAccess, 'text'>): Verdict {
  const { text } = copy;
  const readAt = q.readAt;
  const refuse = (code: string, reason: string, reopensAt: number | null = null, switchClass: '2' | null = null): Verdict =>
    closed([{ code, reason, reopensAt, remedy: null } satisfies Refusal], switchClass, readAt, 'own');
  const open = (): Verdict => ({ ...OPEN, readAt, rail: 'own' });
  const unread = () => unknownVerdict(text('queue.unread'));
  const p = row.payout;

  if (action === 'release') {
    if (q.paused === null) return unread();
    if (q.paused) {
      if (q.escapeOpen === null) return unread();
      if (!q.escapeOpen) return refuse('EnforcedPause', text('queue.paused'), q.escapeOpensAt ? q.escapeOpensAt : null, '2');
    }
    if (p === null) return unread();
    if (p.state !== ROW_QUEUED) return refuse('RowNotQueued', text('queue.notQueued'));
    const cancels = releaseCancels(q, row);
    if (cancels === null) return unread();
    // The contract cancels a row it may no longer pay before any other
    // check: releasing it is open, and the receipt says it cancels.
    if (cancels) return open();
    if (nowSec === null) return unread();
    if (nowSec < p.releaseAt) return refuse('PayoutNotDue', text('queue.notDue'), p.releaseAt);
    if (q.mode === null) return unread();
    if (q.mode.locked) return refuse('ProtectedVaultLocked', text('queue.locked'));
    if (q.mode.requireCosign && !p.cosigned) return refuse('CosignRequired', text('queue.cosignNeeded'));
    return open();
  }

  if (p === null) return unread();
  const signer = isQueueSigner(q, viewer);
  if (action === 'cancel') {
    // The role first, then the row, as `cancelPayout` checks them.
    const manager = queueManager(q);
    const isManager = manager !== null && same(manager, viewer);
    if (!isManager) {
      if (manager === null || signer === null) return unread();
      if (!signer) return refuse('NotManagerOrSigner', text('queue.notManager'));
    }
    if (p.state !== ROW_QUEUED) return refuse('RowNotQueued', text('queue.notQueued'));
    return open();
  }
  // Co-sign: the row, then the signer.
  if (p.state !== ROW_QUEUED) return refuse('RowNotQueued', text('queue.notQueued'));
  if (signer === null) return unread();
  if (!signer) return refuse('NotSigner', text('queue.notSigner'));
  if (p.cosigned) return refuse('AlreadyCosigned', text('queue.alreadyCosigned'));
  if (q.mode === null) return unread();
  if (!q.mode.requireCosign) return refuse('CosignNotRequired', text('queue.cosignNotRequired'));
  return open();
}

/** Whether `viewer` holds a role this action needs (cancel: manager or
 *  signer; co-sign: signer). Release is anyone's. A page offers an action
 *  only to a wallet that may use it, and states a closed release. */
export function holdsRole(action: QueueAction, q: AccountQueue, viewer: Hex): boolean {
  if (action === 'release') return true;
  const signer = isQueueSigner(q, viewer) === true;
  if (action === 'cosign') return signer;
  const manager = queueManager(q);
  return signer || (manager !== null && same(manager, viewer));
}

type Args = Record<string, bigint | number | string | boolean | undefined>;

/** What the transaction's own logs show happened to row `id`. */
export interface QueueLogs {
  released: { amount: bigint; delivered: bigint; recipient: Hex } | null;
  cancelled: { by: Hex } | null;
  cosigned: { signer: Hex } | null;
}

export function queueLogs(logs: readonly Log[], diamond: Hex, id: bigint): QueueLogs {
  const own = logs.filter((l) => same(l.address as Hex, diamond));
  const events = parseEventLogs({ abi: PAYOUT, logs: [...own], strict: false }) as unknown as { eventName: string; args: Args }[];
  const find = (name: string) => events.find((e) => e.eventName === name && BigInt(e.args.id ?? -1n) === id)?.args ?? null;
  const released = find('PayoutReleased');
  const cancelled = find('PayoutCancelled');
  const cosigned = find('PayoutCosigned');
  return {
    released: released ? { amount: BigInt(released.amount ?? 0n), delivered: BigInt(released.delivered ?? 0n), recipient: String(released.recipient) as Hex } : null,
    cancelled: cancelled ? { by: String(cancelled.by) as Hex } : null,
    cosigned: cosigned ? { signer: String(cosigned.signer) as Hex } : null,
  };
}
