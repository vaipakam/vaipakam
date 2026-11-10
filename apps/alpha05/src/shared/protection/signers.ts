/**
 * ACC-41 / #3415 — the protected account's secondary signers: other wallets
 * that can cancel a waiting change, lock the account, cancel or co-sign a
 * queued payout, remove a destination and, together, approve replacing the
 * main wallet. They cannot move anything themselves. Each change is its own
 * call on `ProtectedAccountFacet`:
 *
 * - `add`: `addSigner(account, signer)`, by the manager. Refused during a
 *   pause, a new primary's cool-down and while the account is locked, and
 *   while any request for that wallet is still on record (a lapsed one must
 *   be cancelled first). It only ASKS: the wallet becomes a signer only once
 *   it has accepted from its own key (`accept`) AND the delay has passed,
 *   through `applyAdd`, within one further delay.
 * - `accept`: `acceptSignerRole(account)`, by the nominee, from its own key.
 * - `cancelAdd`: `cancelAddSigner(account, signer)`, by the manager, an
 *   active signer or the nominee. Open during a pause.
 * - `applyAdd`: `finalizeAddSigner(account, signer)`, by anyone, once the
 *   wait is over, the nominee has accepted, and within one further delay.
 * - `remove`: `requestRemoveSigner(account, signer)`, by the manager. It
 *   only asks: the signer leaves after the delay unless the manager or
 *   another signer cancels it (`cancelRemove`, open during a pause), and
 *   `applyRemove` (anyone, any time after) carries it out. The last
 *   signer's removal turns the co-sign requirement off.
 * - `cosignOn` / `cosignOff`: `setRequireCosign(account, on)`, by the
 *   manager. On is immediate and needs a signer; off waits the delay and is
 *   applied with the account's other matured setting changes (the Vault
 *   page's safety card).
 *
 * The page offers `add` only for a wallet from the reader's saved book that
 * proved control by signing, so a signer is always a key the reader showed
 * they hold. A change voided by a later lock, replacement or switch-off
 * reads as none, as the contract reports it.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { answerOrNull, isContractAnswer } from '../reads/answer';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatUtc } from '../ui/format';
import { CHANGE_KIND, PROTECTED } from './safety';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;
const ADMIN = AdminFacetABI as Abi;

export type SignerAction = 'add' | 'accept' | 'cancelAdd' | 'applyAdd' | 'remove' | 'cancelRemove' | 'applyRemove' | 'cosignOn' | 'cosignOff';

export const SIGNER_FUNCTION = {
  add: 'addSigner',
  accept: 'acceptSignerRole',
  cancelAdd: 'cancelAddSigner',
  applyAdd: 'finalizeAddSigner',
  remove: 'requestRemoveSigner',
  cancelRemove: 'cancelRemoveSigner',
  applyRemove: 'finalizeRemoveSigner',
  cosignOn: 'setRequireCosign',
  cosignOff: 'setRequireCosign',
} as const satisfies Record<SignerAction, string>;

/** `LibProtectedAccount.MAX_SIGNERS`: at most this many signers, and at
 *  most this many waiting. */
export const MAX_SIGNERS = 5;

/** The parts of the account's mode the signer rules read. */
export interface SignerMode {
  enabled: boolean;
  locked: boolean;
  retired: boolean;
  requireCosign: boolean;
  /** When a requested co-sign switch-off can be applied (0 = none). */
  pendingCosignOffAt: number;
  delaySeconds: number;
  cooldownUntil: number;
  controller: Hex;
}

export interface ActiveSigner {
  signer: Hex;
  /** When a requested removal can be applied (0 = none requested). */
  removeAt: number;
}

export interface PendingSigner {
  signer: Hex;
  /** When the wait ends (unix seconds). */
  maturesAt: number;
  /** Whether the nominee has accepted from its own key. */
  accepted: boolean;
}

/** Everything the signer section and a review read, at one block. */
export interface SignerFacts {
  /** The protected account the signers belong to. */
  account: Hex;
  /** The mode; 'absent' when this Diamond has no protected-account feature;
   *  null when unread. */
  mode: SignerMode | 'absent' | null;
  /** The active signers, each with its removal request; null when the list
   *  or any signer's removal request was unread. */
  signers: readonly ActiveSigner[] | null;
  pending: readonly PendingSigner[] | null;
  paused: boolean | null;
  chainNow: number | null;
  readAt: number;
}

type RawMode = {
  enabled: boolean;
  locked: boolean;
  retired: boolean;
  requireCosign: boolean;
  pendingCosignOffAt: number | bigint;
  delaySeconds: number | bigint;
  cooldownUntil: number | bigint;
  controller: Hex;
};
type RawChange = { addAt: number | bigint; accepted: boolean; removeAt: number | bigint; epoch: number | bigint };

export async function readSignerFacts(c: PublicClient, diamond: Hex, account: Hex): Promise<SignerFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    answerOrNull(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
  const [mode, list, pending, paused] = await Promise.all([
    readSignerMode(c, diamond, account, block.number),
    read<readonly Hex[]>(PROTECTED, 'getProtectedSigners', [account]),
    read<readonly [readonly Hex[], readonly bigint[], readonly boolean[]]>(PROTECTED, 'getPendingSignerAdditions', [account]),
    read<boolean>(ADMIN, 'paused'),
  ]);
  let signers: ActiveSigner[] | null = null;
  if (list !== null) {
    const changes = await Promise.all(list.map((s) => read<RawChange>(PROTECTED, 'getSignerChange', [account, s])));
    if (changes.every((x) => x !== null)) signers = list.map((s, i) => ({ signer: s, removeAt: Number(changes[i]!.removeAt) }));
  }
  return {
    account,
    mode,
    signers,
    pending: pending === null ? null : pending[0].map((s, i) => ({ signer: s, maturesAt: Number(pending[1][i] ?? 0n), accepted: pending[2][i] === true })),
    paused,
    chainNow: Number(block.timestamp),
    readAt: Date.now(),
  };
}

async function readSignerMode(c: PublicClient, diamond: Hex, account: Hex, blockNumber: bigint): Promise<SignerMode | 'absent' | null> {
  try {
    const m = (await c.readContract({ address: diamond, abi: PROTECTED, functionName: 'getProtectedAccount', args: [account], blockNumber })) as RawMode;
    return {
      enabled: m.enabled,
      locked: m.locked,
      retired: m.retired,
      requireCosign: m.requireCosign,
      pendingCosignOffAt: Number(m.pendingCosignOffAt),
      delaySeconds: Number(m.delaySeconds),
      cooldownUntil: Number(m.cooldownUntil),
      controller: m.controller,
    };
  } catch (e) {
    // A failed source is thrown, so the own rail tries the next one.
    if (!isContractAnswer(e)) throw e;
    return refusalFromError(e).code === 'FunctionDoesNotExist' ? 'absent' : null;
  }
}

/** The chain's clock now: the block time at the read plus what has passed. */
export function signerClock(f: Pick<SignerFacts, 'chainNow' | 'readAt'>, nowMs: number): number | null {
  return f.chainNow === null ? null : f.chainNow + Math.max(0, Math.floor((nowMs - f.readAt) / 1000));
}

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/** Where a waiting addition stands at `now`: still waiting, ready to apply
 *  (which also needs the nominee's acceptance), or lapsed. */
export type NomineeState = 'waiting' | 'ready' | 'expired';

export function nomineeState(p: PendingSigner, delaySeconds: number, now: number): NomineeState {
  if (now < p.maturesAt) return 'waiting';
  return now > p.maturesAt + delaySeconds ? 'expired' : 'ready';
}

export interface SignerReview {
  identity: string;
  action: SignerAction;
  /** The signer the change is about (the connected wallet for `accept`; the
   *  account itself for the co-sign switch, which names no signer). */
  signer: Hex;
  facts: SignerFacts;
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

export function signerCall(action: SignerAction, account: Hex, signer: Hex) {
  const fn = SIGNER_FUNCTION[action];
  const args =
    action === 'accept'
      ? ([account] as const)
      : action === 'cosignOn' || action === 'cosignOff'
        ? ([account, action === 'cosignOn'] as const)
        : ([account, signer] as const);
  return { abi: PROTECTED, functionName: fn, args };
}

/**
 * Read a review of `action`. `account` is the protected account: the
 * connected wallet's own on the Protection page, and the linked account on
 * the nominee's accept page, where the connected wallet is the signer.
 */
export async function readSignerReview(
  own: OwnStateClient,
  diamond: Hex,
  account: Hex,
  action: SignerAction,
  signer: Hex,
  identity: string,
  copy: Copy,
): Promise<SignerReview> {
  const facts = await own.read((c: PublicClient) => readSignerFacts(c, diamond, account)).then((x) => x.value);
  const base: SignerReview = { identity, action, signer, facts, dryRun: null, readAt: Date.now() };
  if (signerBlockers(base, copy).length > 0) return base;
  const call = signerCall(action, account, signer);
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account: own.account }));
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

/** What stops the action, in words (empty when nothing does), most
 *  fundamental first. */
export function signerBlockers(r: SignerReview, copy: Copy): string[] {
  const { text, format } = copy;
  const f = r.facts;
  const m = f.mode;
  if (m === 'absent') return [text('safety.unavailable')];
  if (m !== null) {
    // Retirement ends the original wallet's management, not the account's
    // signers: the nominee still accepts, and the permissionless steps
    // still apply.
    const actsAsManager = !(r.action === 'accept' || r.action === 'applyAdd' || r.action === 'applyRemove');
    if (m.retired && actsAsManager) return [text('safety.retired')];
    if (!m.enabled) return [text('signer.modeOff')];
  }
  const now = signerClock(f, Date.now());
  const pend = f.pending?.find((p) => same(p.signer, r.signer)) ?? null;
  const active = f.signers?.find((s) => same(s.signer, r.signer)) ?? null;
  const pauseCloses = !(r.action === 'cancelAdd' || r.action === 'cancelRemove');
  if (pauseCloses && f.paused === true) return [text('signer.paused')];
  const loosening = r.action === 'add' || r.action === 'remove' || r.action === 'cosignOff';
  if (loosening && m !== null) {
    if (m.locked) return [text('signer.locked')];
    if (now !== null && now < m.cooldownUntil) return [format('safety.cooldown', { at: formatUtc(m.cooldownUntil) })];
  }
  switch (r.action) {
    case 'add':
      if (same(r.signer, f.account)) return [text('signer.isSelf')];
      if (f.signers !== null && active !== null) return [text('signer.alreadySigner')];
      if (pend !== null) {
        if (m !== null && now !== null && nomineeState(pend, m.delaySeconds, now) === 'expired') return [text('signer.lapsedCancelFirst')];
        return [format('signer.alreadyWaiting', { at: formatUtc(pend.maturesAt) })];
      }
      if (f.signers !== null && f.signers.length >= MAX_SIGNERS) return [format('signer.full', { max: String(MAX_SIGNERS) })];
      if (f.pending !== null && f.pending.length >= MAX_SIGNERS) return [format('signer.pendingFull', { max: String(MAX_SIGNERS) })];
      break;
    case 'accept':
      if (f.pending !== null && pend === null) return [text('signer.notNominated')];
      if (pend !== null && pend.accepted) return [text('signer.alreadyAccepted')];
      if (pend !== null && m !== null && now !== null && nomineeState(pend, m.delaySeconds, now) === 'expired')
        return [format('signer.expired', { at: formatUtc(pend.maturesAt + m.delaySeconds) })];
      break;
    case 'cancelAdd':
      if (f.pending !== null && pend === null) return [text('signer.notWaiting')];
      break;
    case 'applyAdd':
      if (f.pending !== null && pend === null) return [text('signer.notWaiting')];
      if (m !== null && m.locked) return [text('signer.locked')];
      if (pend !== null && m !== null && now !== null) {
        const s = nomineeState(pend, m.delaySeconds, now);
        if (s === 'waiting') return [format('signer.notYet', { at: formatUtc(pend.maturesAt) })];
        if (s === 'expired') return [format('signer.expired', { at: formatUtc(pend.maturesAt + m.delaySeconds) })];
      }
      if (pend !== null && !pend.accepted) return [text('signer.notAccepted')];
      if (f.signers !== null && f.signers.length >= MAX_SIGNERS) return [format('signer.full', { max: String(MAX_SIGNERS) })];
      break;
    case 'remove':
      if (f.signers !== null && active === null) return [text('signer.notSigner')];
      if (active !== null && active.removeAt !== 0) return [format('signer.alreadyRemoving', { at: formatUtc(active.removeAt) })];
      break;
    case 'cancelRemove':
      if (f.signers !== null && (active === null || active.removeAt === 0)) return [text('signer.notRemoving')];
      break;
    case 'applyRemove':
      if (m !== null && m.locked) return [text('signer.locked')];
      if (f.signers !== null && (active === null || active.removeAt === 0)) return [text('signer.notRemoving')];
      if (active !== null && now !== null && now < active.removeAt) return [format('signer.removeNotYet', { at: formatUtc(active.removeAt) })];
      break;
    case 'cosignOn':
      if (f.signers !== null && f.signers.length === 0) return [text('signer.cosignNeedsSigner')];
      if (m !== null && m.requireCosign && m.pendingCosignOffAt === 0) return [text('signer.cosignAlreadyOn')];
      break;
    case 'cosignOff':
      if (m !== null && !m.requireCosign) return [text('signer.cosignAlreadyOff')];
      if (m !== null && m.pendingCosignOffAt !== 0) return [format('signer.cosignOffAsked', { at: formatUtc(m.pendingCosignOffAt) })];
      break;
  }
  if (r.dryRun !== null && r.dryRun !== 'unread') return [format('safety.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function signerChanged(a: SignerReview, b: SignerReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  const key = (r: SignerReview) => JSON.stringify([r.facts.mode, r.facts.signers, r.facts.pending]);
  if (key(a) !== key(b)) return text('signer.changed');
  if (a.facts.paused !== b.facts.paused) return text('repay.changedVerdict');
  if ((a.dryRun === null) !== (b.dryRun === null) || (a.dryRun === 'unread') !== (b.dryRun === 'unread')) return text('repay.changedVerdict');
  return null;
}

type Args = Record<string, unknown>;

const TITLE = {
  add: 'signer.titleAdd',
  accept: 'signer.titleAccept',
  cancelAdd: 'signer.titleCancelAdd',
  applyAdd: 'signer.titleApplyAdd',
  remove: 'signer.titleRemove',
  cancelRemove: 'signer.titleCancelRemove',
  applyRemove: 'signer.titleApplyRemove',
  cosignOn: 'signer.titleCosignOn',
  cosignOff: 'signer.titleCosignOff',
} as const satisfies Record<SignerAction, string>;

export function signerTitle(action: SignerAction): (typeof TITLE)[SignerAction] {
  return TITLE[action];
}

/** The action's outcome, from the Diamond's own logs for this account. */
export function measureSigner(r: SignerReview, logs: readonly Log[], diamond: Hex, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const account = r.facts.account.toLowerCase();
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = (parseEventLogs({ abi: PROTECTED, logs: [...own], strict: false }) as unknown as { eventName: string; args: Args }[]).filter(
    (e) => String(e.args.account ?? '').toLowerCase() === account,
  );
  const forSigner = (name: string) => events.filter((e) => e.eventName === name && String(e.args.signer ?? '').toLowerCase() === r.signer.toLowerCase());
  const missing = (): LegOutcome[] => [{ status: 'not-done', label: text(TITLE[r.action]), reason: text('signer.notRecorded') }];
  const signer = r.signer;
  switch (r.action) {
    case 'add': {
      const asked = forSigner('SignerAddRequested')[0];
      return asked ? [{ status: 'done', label: format('signer.legAsked', { signer, at: formatUtc(BigInt(asked.args.effectiveAt as bigint)) }) }] : missing();
    }
    case 'accept':
      return forSigner('SignerAccepted').length > 0 ? [{ status: 'done', label: format('signer.legAccepted', { account: r.facts.account }) }] : missing();
    case 'cancelAdd':
      return forSigner('SignerAddCancelled').length > 0 ? [{ status: 'done', label: format('signer.legCancelled', { signer }) }] : missing();
    case 'applyAdd':
      return forSigner('SignerAdded').length > 0 ? [{ status: 'done', label: format('signer.legAdded', { signer }) }] : missing();
    case 'remove': {
      const asked = forSigner('SignerRemoveRequested')[0];
      return asked
        ? [{ status: 'done', label: format('signer.legRemoveAsked', { signer, at: formatUtc(BigInt(asked.args.effectiveAt as bigint)) }) }]
        : missing();
    }
    case 'cancelRemove':
      return forSigner('SignerRemoveCancelled').length > 0 ? [{ status: 'done', label: format('signer.legRemoveCancelled', { signer }) }] : missing();
    case 'applyRemove': {
      if (forSigner('SignerRemoved').length === 0) return missing();
      const legs: LegOutcome[] = [{ status: 'done', label: format('signer.legRemoved', { signer }) }];
      if (events.some((e) => e.eventName === 'CosignRequirementSet' && e.args.on === false)) legs.push({ status: 'done', label: text('signer.legCosignOff') });
      return legs;
    }
    case 'cosignOn':
      return events.some((e) => e.eventName === 'CosignRequirementSet' && e.args.on === true)
        ? [{ status: 'done', label: text('signer.legCosignOn') }]
        : missing();
    case 'cosignOff': {
      const asked = events.find((e) => e.eventName === 'SettingChangeRequested' && Number(e.args.kind) === CHANGE_KIND.cosignOff);
      return asked ? [{ status: 'done', label: format('signer.legCosignOffAsked', { at: formatUtc(BigInt(asked.args.effectiveAt as bigint)) }) }] : missing();
    }
  }
}
