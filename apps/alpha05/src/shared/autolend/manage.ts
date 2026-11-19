/**
 * #3624 part 2 — managing one Auto-lend: add money, take back money that is
 * not lent, and stop. Everything here is pure or a read; the panel's review
 * and flow build on it.
 *
 * The protocol's rule, which each review states before anything is signed:
 * - adding money (`fundLenderIntent`) moves it from the wallet into the
 *   wallet's own vault and sets it aside for the instruction. It needs a
 *   running instruction, both assets not paused, the protocol not paused,
 *   and an approval of exactly the amount;
 * - taking money back (`withdrawLenderIntentCapital`) reaches only the money
 *   set aside and not lent. Money lent out comes back when each loan is
 *   repaid, as a claim or lent again. A paused asset does not stop it; a
 *   paused protocol does. With protected mode on, the payment waits out the
 *   account's delay (or stays in the vault while the account is locked or
 *   its queue is full), exactly as a vault withdrawal does;
 * - stopping (`cancelLenderIntent`) ends new loans at once. Open loans run
 *   to their end and are paid as usual. The money not lent stays set aside
 *   and can be taken back at any time; the stop can take it back in the same
 *   transaction, through the protocol's batch entry. A paused protocol stops
 *   only the take-back, never the stop.
 */
import { erc20Abi, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI } from '@vaipakam/contracts/abis';
import { readIntentGates } from '../offers/intents';
import { readProtection, type Protection } from '../protection/payout';
import { batchCall } from '../tx/batch';
import { INTENT, INTENT_VIEW, readIntent, type IntentRecord } from './autoLend';

type Hex = `0x${string}`;

const ADMIN = AdminFacetABI as Abi;
const DAY = 86_400n;

export type ManageKind = 'add' | 'takeBack' | 'stop';

/** One management step as confirmed: the pair and its slot (#3626), and the
 *  amount added or taken back (for a stop, what it takes back with it: 0
 *  leaves the money set aside). */
export interface ManageDraft {
  kind: ManageKind;
  lending: Hex;
  collateral: Hex;
  slot: number;
  amount: bigint;
}

/** Everything a management review stands on, read at one block. */
export interface ManageFacts {
  blockNumber: bigint;
  chainNow: bigint;
  intent: IntentRecord;
  /** Set aside and not lent: the most a take-back can return. */
  unlent: bigint;
  /** Lent out now, counted against the most at once until each loan ends. */
  lent: bigint;
  /** The whole protocol paused; null when unread. */
  protocolPaused: boolean | null;
  /** Each asset's own pause; null when unread. */
  lendingPaused: boolean | null;
  collateralPaused: boolean | null;
  /** The wallet's balance and allowance to the protocol, for adding. */
  balance: bigint;
  allowance: bigint;
  /** The account's protected mode, for a payment back; null when unread. */
  protection: Protection | null;
}

const orNull = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export async function readManageFacts(c: PublicClient, diamond: Hex, account: Hex, lending: Hex, collateral: Hex, slot: number): Promise<ManageFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const blockNumber = block.number;
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) => c.readContract({ address: diamond, abi, functionName, args, blockNumber }) as Promise<T>;
  const [intent, unlent, lent, gates, lendingPaused, collateralPaused, balance, allowance, protection] = await Promise.all([
    readIntent(c, diamond, account, lending, collateral, slot, blockNumber),
    read<bigint>(INTENT_VIEW, 'getLenderIntentCapital', [account, lending, collateral, slot]),
    read<bigint>(INTENT_VIEW, 'getLenderIntentLivePrincipal', [account, lending, collateral, slot]),
    readIntentGates(c, diamond, blockNumber),
    orNull(read<boolean>(ADMIN, 'isAssetPaused', [lending])),
    orNull(read<boolean>(ADMIN, 'isAssetPaused', [collateral])),
    c.readContract({ address: lending, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber }),
    c.readContract({ address: lending, abi: erc20Abi, functionName: 'allowance', args: [account, diamond], blockNumber }),
    orNull(readProtection(c, diamond, account, blockNumber)),
  ]);
  return {
    blockNumber,
    chainNow: block.timestamp,
    intent,
    unlent,
    lent,
    protocolPaused: gates.protocolPaused,
    lendingPaused,
    collateralPaused,
    balance,
    allowance,
    protection,
  };
}

/** Whether the instruction's end date leaves no day-long loan: it lends
 *  nothing more, the same rule Positions and the protocol's feed apply. */
export function hasEnded(intent: IntentRecord, chainNow: bigint): boolean {
  return intent.lendUntil !== 0n && intent.lendUntil < chainNow + DAY;
}

/** Why a management step cannot be sent as it stands, before any dry run:
 *  each a fact the reader can act on. */
export type ManageBlock =
  | { kind: 'stopped' }
  | { kind: 'ended' }
  | { kind: 'zero' }
  | { kind: 'balance'; balance: bigint }
  | { kind: 'aboveUnlent'; unlent: bigint }
  | { kind: 'assetPaused' }
  | { kind: 'protocolPaused' }
  | { kind: 'unread' };

export function manageBlocks(d: ManageDraft, f: ManageFacts): ManageBlock[] {
  const out: ManageBlock[] = [];
  const running = f.intent.active;
  if (d.kind === 'add') {
    if (!running) out.push({ kind: 'stopped' });
    else if (hasEnded(f.intent, f.chainNow)) out.push({ kind: 'ended' });
    if (d.amount === 0n) out.push({ kind: 'zero' });
    if (f.balance < d.amount) out.push({ kind: 'balance', balance: f.balance });
    if (f.lendingPaused === true || f.collateralPaused === true) out.push({ kind: 'assetPaused' });
    if (f.protocolPaused === true) out.push({ kind: 'protocolPaused' });
    if (f.protocolPaused === null || f.lendingPaused === null || f.collateralPaused === null) out.push({ kind: 'unread' });
    return out;
  }
  if (d.kind === 'stop' && !running) out.push({ kind: 'stopped' });
  if (d.kind === 'takeBack' && d.amount === 0n) out.push({ kind: 'zero' });
  if (d.amount > f.unlent) out.push({ kind: 'aboveUnlent', unlent: f.unlent });
  // Only the take-back is closed by a pause; a stop alone moves no money.
  if (d.amount > 0n) {
    if (f.protocolPaused === true) out.push({ kind: 'protocolPaused' });
    else if (f.protocolPaused === null) out.push({ kind: 'unread' });
  }
  return out;
}

/** The step as one contract call: the stop and its take-back go in one
 *  transaction, so the instruction is never stopped with the take-back
 *  failing silently, nor the money taken back with the instruction left
 *  running. */
export function manageCall(d: ManageDraft, account: Hex) {
  const withdraw = { abi: INTENT, functionName: 'withdrawLenderIntentCapital', args: [account, d.lending, d.collateral, d.slot, d.amount] as const };
  switch (d.kind) {
    case 'add':
      return { abi: INTENT, functionName: 'fundLenderIntent', args: [d.lending, d.collateral, d.slot, d.amount] as const };
    case 'takeBack':
      return withdraw;
    case 'stop':
      if (d.amount === 0n) return { abi: INTENT, functionName: 'cancelLenderIntent', args: [d.lending, d.collateral, d.slot] as const };
      return batchCall([{ abi: INTENT, functionName: 'cancelLenderIntent', args: [d.lending, d.collateral, d.slot] }, withdraw]);
  }
}

/** What a management step's own logs record, for this wallet, pair and slot: the
 *  amount set aside, the amount taken back, and whether it was stopped. */
export interface ManageLogs {
  funded: bigint | null;
  withdrawn: bigint | null;
  stopped: boolean;
}

export function manageLogs(logs: readonly Log[], diamond: Hex, account: Hex, lending: Hex, collateral: Hex, slot: number): ManageLogs {
  const same = (a: unknown, b: Hex) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const mine = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: INTENT, logs: mine as Log[], strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[];
  const out: ManageLogs = { funded: null, withdrawn: null, stopped: false };
  for (const e of events) {
    const a = e.args;
    if (!same(a.owner, account) || !same(a.lendingAsset, lending) || !same(a.collateralAsset, collateral) || Number(a.slot) !== slot) continue;
    if (e.eventName === 'LenderIntentFunded' && typeof a.amount === 'bigint') out.funded = (out.funded ?? 0n) + a.amount;
    if (e.eventName === 'LenderIntentCapitalWithdrawn' && typeof a.amount === 'bigint') out.withdrawn = (out.withdrawn ?? 0n) + a.amount;
    if (e.eventName === 'LenderIntentCancelled') out.stopped = true;
  }
  return out;
}

/** The management steps a card offers, by where the instruction stands:
 *  adding only while it can still lend; taking back while money waits;
 *  stopping while it runs. */
export function manageOffers(active: boolean, ended: boolean, unlent: bigint): ManageKind[] {
  const out: ManageKind[] = [];
  if (active && !ended) out.push('add');
  if (unlent > 0n) out.push('takeBack');
  if (active) out.push('stop');
  return out;
}
