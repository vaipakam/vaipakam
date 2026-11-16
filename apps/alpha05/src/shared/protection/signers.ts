/**
 * ACC-41 / #3415 — the protected account's secondary signers: other wallets
 * that can cancel a waiting change, lock the account, cancel or co-sign a
 * queued payout, remove a destination and, together, approve replacing the
 * main wallet. They cannot move anything themselves.
 *
 * #3379 B2: the signers are the account's VAULT record. Each change is a
 * `VaultProtection.signerChange(action, signer, auth)` the sending wallet
 * writes to the account's vault with its own direct authorization, or the
 * permissionless `finalizeSigner(signer)`:
 *
 * - `add` (owner), `accept` (the nominee, from its own key), `remove`
 *   (owner), and `cancelAdd` / `cancelRemove` (owner, an active signer, or
 *   the nominee for its own nomination). An addition applies once the nominee
 *   has accepted and the delay has passed, within one further delay; a
 *   removal applies after the delay. `applyAdd` / `applyRemove` run
 *   `finalizeSigner`, by anyone. A loosening change (add, remove) is refused
 *   while the account is locked or in a new owner's cool-down.
 * - `cosignOn` / `cosignOff`: the Diamond's `setRequireCosign(account, on)`,
 *   by the manager. On is immediate and needs a signer; off waits the delay.
 *   With no signer left the requirement no longer binds.
 *
 * The page offers `add` only for a wallet from the reader's saved book that
 * proved control by signing, so a signer is always a key the reader showed
 * they hold. A change voided by a later lock, replacement or switch-off
 * reads as none, as the contract reports it.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, VaultProtectionABI } from '@vaipakam/contracts/abis';
import { directAuth, protectionCall, VAULT_SIGNER } from '@vaipakam/lib/protectedAccountView';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { answerOrNull, isContractAnswer } from '../reads/answer';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatUtc } from '../ui/format';
import { readProtectedRecord, VAULT } from './payout';
import { CHANGE_KIND, PROTECTED } from './safety';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;
const ADMIN = AdminFacetABI as Abi;
const VAULT_PROTECTION = VaultProtectionABI as Abi;

export type SignerAction = 'add' | 'accept' | 'cancelAdd' | 'applyAdd' | 'remove' | 'cancelRemove' | 'applyRemove' | 'cosignOn' | 'cosignOff';

/** The write each action makes: the vault's `signerChange` action code, its
 *  permissionless `finalizeSigner`, or the Diamond's co-sign switch. */
export const SIGNER_FUNCTION = {
  add: 'signerChange',
  accept: 'signerChange',
  cancelAdd: 'signerChange',
  applyAdd: 'finalizeSigner',
  remove: 'signerChange',
  cancelRemove: 'signerChange',
  applyRemove: 'finalizeSigner',
  cosignOn: 'setRequireCosign',
  cosignOff: 'setRequireCosign',
} as const satisfies Record<SignerAction, string>;

const SIGNER_CODE = {
  add: VAULT_SIGNER.add,
  accept: VAULT_SIGNER.accept,
  cancelAdd: VAULT_SIGNER.cancel,
  remove: VAULT_SIGNER.remove,
  cancelRemove: VAULT_SIGNER.cancel,
} as const;

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
  /** Its vault, which holds the signer record; null when none or unread. */
  vault: Hex | null;
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

type RawEntry = { addAt: number | bigint; removeAt: number | bigint; accepted: boolean; active: boolean };

export async function readSignerFacts(c: PublicClient, diamond: Hex, account: Hex): Promise<SignerFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const [rec, paused] = await Promise.all([
    readRecordOrAbsent(c, diamond, account, block.number),
    answerOrNull(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused', ...at }) as Promise<boolean>),
  ]);
  const record = rec === 'absent' || rec === null ? null : rec;
  const vault = record?.vault ?? null;
  // The vault's own entries; a change voided by a lock, a replacement or a
  // switch-off reads as none there.
  const entry = (s: Hex) =>
    vault === null ? Promise.resolve(null) : answerOrNull(c.readContract({ address: vault, abi: VAULT, functionName: 'signerEntry', args: [s], ...at }) as Promise<RawEntry>);
  let signers: ActiveSigner[] | null = record === null ? null : [];
  let pending: PendingSigner[] | null = record === null ? null : [];
  if (record !== null && vault !== null) {
    const entries = await Promise.all(record.signers.map(entry));
    signers = entries.some((x) => x === null) ? null : record.signers.map((s, i) => ({ signer: s, removeAt: Number(entries[i]!.removeAt) }));
    const p = await answerOrNull(c.readContract({ address: vault, abi: VAULT, functionName: 'pendingAdditions', ...at }) as Promise<readonly [readonly Hex[], readonly Hex[]]>);
    if (p === null) pending = null;
    else {
      const pe = await Promise.all(p[1].map(entry));
      pending = pe.some((x) => x === null)
        ? null
        : p[1].flatMap((s, i) => (pe[i]!.active || Number(pe[i]!.addAt) === 0 ? [] : [{ signer: s, maturesAt: Number(pe[i]!.addAt), accepted: pe[i]!.accepted }]));
    }
  }
  const m = record?.record ?? null;
  return {
    account,
    vault,
    mode:
      rec === 'absent'
        ? 'absent'
        : m === null
          ? null
          : {
              enabled: m.enabled,
              locked: m.locked,
              retired: m.retired,
              requireCosign: m.requireCosign,
              pendingCosignOffAt: Number(m.pendingCosignOffAt),
              delaySeconds: m.delaySeconds,
              cooldownUntil: Number(m.cooldownUntil),
              controller: m.controller,
            },
    signers,
    pending,
    paused,
    chainNow: Number(block.timestamp),
    readAt: Date.now(),
  };
}

/** The account's vault record, 'absent' on a Diamond without the feature,
 *  null when unread. */
async function readRecordOrAbsent(c: PublicClient, diamond: Hex, account: Hex, blockNumber: bigint) {
  try {
    return await readProtectedRecord(c, diamond, account, blockNumber);
  } catch (e) {
    // A failed source is thrown, so the own rail tries the next one.
    if (!isContractAnswer(e)) throw e;
    return refusalFromError(e).code === 'FunctionDoesNotExist' ? ('absent' as const) : null;
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

/** The call that runs `action`. A signer change is a write to the
 *  account's vault (`protect`), authorized directly by `sender`, the wallet
 *  that sends it; applying one is the vault's permissionless
 *  `finalizeSigner`; the co-sign switch is the Diamond's. Null when the
 *  vault a vault write needs is unknown. */
export function signerCall(action: SignerAction, account: Hex, signer: Hex, sender: Hex, vault: Hex | null, diamond: Hex) {
  if (action === 'cosignOn' || action === 'cosignOff') {
    return { address: diamond, abi: PROTECTED, functionName: 'setRequireCosign', args: [account, action === 'cosignOn'] as readonly unknown[] };
  }
  if (vault === null) return null;
  const data =
    action === 'applyAdd' || action === 'applyRemove'
      ? protectionCall('finalizeSigner', [signer])
      : protectionCall('signerChange', [SIGNER_CODE[action], signer, directAuth(sender)]);
  return { address: vault, abi: VAULT, functionName: 'protect', args: [data] as readonly unknown[] };
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
  const call = signerCall(action, account, signer, own.account, facts.vault, diamond);
  if (call === null) return { ...base, dryRun: 'unread', readAt: Date.now() };
  const dry = await askThrough(own, (c) => c.simulateContract({ ...call, account: own.account }));
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

/** The action's outcome: a signer change from the vault's own logs (the
 *  signers are its record), the co-sign switch from the Diamond's. */
export function measureSigner(r: SignerReview, logs: readonly Log[], diamond: Hex, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const account = r.facts.account.toLowerCase();
  const vault = r.facts.vault?.toLowerCase() ?? null;
  const events = (parseEventLogs({ abi: PROTECTED, logs: logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase()), strict: false }) as unknown as {
    eventName: string;
    args: Args;
  }[]).filter((e) => String(e.args.account ?? '').toLowerCase() === account);
  const fromVault =
    vault === null
      ? []
      : (parseEventLogs({ abi: VAULT_PROTECTION, logs: logs.filter((l) => l.address.toLowerCase() === vault), strict: false }) as unknown as { eventName: string; args: Args }[]);
  const forSigner = (name: string) => fromVault.filter((e) => e.eventName === name && String(e.args.signer ?? '').toLowerCase() === r.signer.toLowerCase());
  const missing = (): LegOutcome[] => [{ status: 'not-done', label: text(TITLE[r.action]), reason: text('signer.notRecorded') }];
  const signer = r.signer;
  switch (r.action) {
    case 'add': {
      const asked = forSigner('SignerAddRequested')[0];
      return asked ? [{ status: 'done', label: format('signer.legAsked', { signer, at: formatUtc(BigInt(asked.args.readyAt as bigint)) }) }] : missing();
    }
    case 'accept':
      return forSigner('SignerAccepted').length > 0 ? [{ status: 'done', label: format('signer.legAccepted', { account: r.facts.account }) }] : missing();
    case 'cancelAdd':
      return forSigner('SignerChangeCancelled').length > 0 ? [{ status: 'done', label: format('signer.legCancelled', { signer }) }] : missing();
    case 'applyAdd':
      return forSigner('SignerAdded').length > 0 ? [{ status: 'done', label: format('signer.legAdded', { signer }) }] : missing();
    case 'remove': {
      const asked = forSigner('SignerRemoveRequested')[0];
      return asked
        ? [{ status: 'done', label: format('signer.legRemoveAsked', { signer, at: formatUtc(BigInt(asked.args.readyAt as bigint)) }) }]
        : missing();
    }
    case 'cancelRemove':
      return forSigner('SignerChangeCancelled').length > 0 ? [{ status: 'done', label: format('signer.legRemoveCancelled', { signer }) }] : missing();
    case 'applyRemove': {
      if (forSigner('SignerRemoved').length === 0) return missing();
      const legs: LegOutcome[] = [{ status: 'done', label: format('signer.legRemoved', { signer }) }];
      // The co-sign requirement never binds an account with no signer left
      // (the Diamond's own rule, #3489 r2), so removing the last one ends it
      // in this transaction even before the platform clears the stored flag.
      const m = r.facts.mode;
      const wasLast = r.facts.signers !== null && r.facts.signers.length === 1 && r.facts.signers[0].signer.toLowerCase() === signer.toLowerCase();
      const cosignEnded =
        events.some((e) => e.eventName === 'CosignRequirementSet' && e.args.on === false) || (wasLast && m !== null && m !== 'absent' && m.requireCosign);
      if (cosignEnded) legs.push({ status: 'done', label: text('signer.legCosignOff') });
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
