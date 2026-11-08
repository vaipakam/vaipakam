/**
 * ACC-36 / ACC-37 / ACC-43 — the Vault page's safety card: the account's
 * protected mode as the protocol stores it, and the four safety actions the
 * card offers in Basic mode. Each is its own call on `ProtectedAccountFacet`:
 *
 * - `enable`: `enableProtectedMode(delaySeconds, protectNfts)`. Immediate,
 *   because it can only reduce what a thief could take. Refused during a
 *   pause and when the mode is already on; the delay must sit inside the
 *   protocol's bounds. It creates the wallet's vault if it has none.
 * - `lock`: `lockVault(account)`, by the account's manager or a secondary
 *   signer. Immediate and open during a pause: it cancels every queued
 *   payout and transfer (their assets stay in the vault), stops new payouts
 *   and new positions, and drops every pending change.
 * - `unlock`: `requestUnlock(account)`, by the manager. Refused during a
 *   pause and a new primary's cool-down. The unlock takes effect only after
 *   the account's delay, through `finalize`.
 * - `finalize`: `finalizeSettingChanges(account)`, by anyone. Applies EVERY
 *   change that is due at once (a lowered delay, NFT protection off, co-sign
 *   off, the unlock, the switch-off); the switch-off waits until no payout is
 *   queued. Refused during a pause.
 *
 * What a review stands on is read through the wallet's connection at one
 * block, then the protocol's own dry run of the very call is asked.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, PositionNFTABI, ProtectedAccountFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { answerOrNull, isContractAnswer } from '../reads/answer';
import { frozenState, readSanctionsPosture, type FrozenState } from '../sanctions/posture';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatSpan, formatUtc } from '../ui/format';
import { positionNftForDiamond } from '../positions/positionNft';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export const PROTECTED = ProtectedAccountFacetABI as Abi;
const PAYOUT = VaultPayoutFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const POSITION_NFT = PositionNFTABI as Abi;

export type SafetyAction = 'enable' | 'lock' | 'unlock' | 'finalize';

export const SAFETY_FUNCTION = {
  enable: 'enableProtectedMode',
  lock: 'lockVault',
  unlock: 'requestUnlock',
  finalize: 'finalizeSettingChanges',
} as const satisfies Record<SafetyAction, string>;

/** `ProtectedAccountFacet.CHANGE_*`. */
export const CHANGE_KIND = { disable: 1, lowerDelay: 2, nftOff: 3, cosignOff: 4, unlock: 5 } as const;
export type PendingChange = keyof typeof CHANGE_KIND;

/** The account's protected mode as `getProtectedAccount` returns it (times
 *  in unix seconds, zero for none), with its position NFT protection. */
export interface SafetyMode {
  enabled: boolean;
  locked: boolean;
  /** Whether the account's position NFTs are protected: on a chain with the
   *  standalone PositionNFT (#3205), its holder lock, read at the token
   *  contract; on a pre-#3205 Diamond, the mode's own NFT flag. Null when
   *  the token contract gave no answer. */
  nftLock: boolean | null;
  /** When a requested holder unlock at the PositionNFT can be applied (0 =
   *  none). Applied at the token contract after the lock's delay, never by
   *  `finalizeSettingChanges`. */
  nftUnlockAt: number;
  requireCosign: boolean;
  retired: boolean;
  delaySeconds: number;
  pendingDelay: number;
  pendingDelayAt: number;
  pendingDisableAt: number;
  pendingUnlockAt: number;
  /** A pre-#3205 Diamond's pending NFT-protection switch-off, which
   *  `finalizeSettingChanges` applies (0 = none, and always 0 where the
   *  PositionNFT's holder lock protects the NFTs). */
  pendingNftOffAt: number;
  pendingCosignOffAt: number;
  cooldownUntil: number;
  lockedAt: number;
  lockedBy: Hex;
  controller: Hex;
}

/** Everything the card and a review read, at one block. */
export interface SafetyFacts {
  account: Hex;
  /** The mode; 'absent' when this Diamond has no protected-account feature;
   *  null when unread. */
  mode: SafetyMode | 'absent' | null;
  /** The protocol's delay bounds in seconds; null when unread. */
  bounds: { min: number; max: number } | null;
  paused: boolean | null;
  frozen: FrozenState;
  /** How many payouts wait in the account's queue; null when unread. */
  openRows: number | null;
  /** The block's time in unix seconds; null when unread. */
  chainNow: number | null;
  readAt: number;
}

/** `getProtectedAccount`'s answer. `retiredProtectNfts` and
 *  `retiredPendingNftOffAt` hold the NFT flag only on a pre-#3205 Diamond
 *  (where the same fields were `protectNfts` / `pendingNftOffAt`). */
type RawMode = Record<string, boolean | number | bigint | string>;

/** The PositionNFT holder lock's answer, or null when unread; 'legacy' on a
 *  pre-#3205 Diamond, whose mode carries the flag itself. */
type NftLockRead = { locked: boolean; unlockAt: number } | 'legacy' | null;

export function toMode(r: RawMode, lock: NftLockRead): SafetyMode {
  const n = (v: unknown) => Number(v as number | bigint);
  const legacy = lock === 'legacy';
  return {
    enabled: r.enabled === true,
    locked: r.locked === true,
    nftLock: legacy ? r.retiredProtectNfts === true : lock === null ? null : lock.locked,
    nftUnlockAt: legacy || lock === null ? 0 : lock.unlockAt,
    requireCosign: r.requireCosign === true,
    retired: r.retired === true,
    delaySeconds: n(r.delaySeconds),
    pendingDelay: n(r.pendingDelay),
    pendingDelayAt: n(r.pendingDelayAt),
    pendingDisableAt: n(r.pendingDisableAt),
    pendingUnlockAt: n(r.pendingUnlockAt),
    pendingNftOffAt: legacy ? n(r.retiredPendingNftOffAt) : 0,
    pendingCosignOffAt: n(r.pendingCosignOffAt),
    cooldownUntil: n(r.cooldownUntil),
    lockedAt: n(r.lockedAt),
    lockedBy: r.lockedBy as Hex,
    controller: r.controller as Hex,
  };
}

/** The mode, 'absent' when the Diamond routes no such function (it reverts
 *  `FunctionDoesNotExist`), null for any other revert. A failed source is
 *  thrown, so the own rail tries the next one. */
async function readMode(c: PublicClient, diamond: Hex, account: Hex, blockNumber: bigint): Promise<SafetyMode | 'absent' | null> {
  try {
    const [raw, lock] = await Promise.all([
      c.readContract({ address: diamond, abi: PROTECTED, functionName: 'getProtectedAccount', args: [account], blockNumber }) as Promise<RawMode>,
      readNftLock(c, diamond, account, blockNumber),
    ]);
    return toMode(raw, lock);
  } catch (e) {
    if (!isContractAnswer(e)) throw e;
    return refusalFromError(e).code === 'FunctionDoesNotExist' ? 'absent' : null;
  }
}

/** The account's position NFT protection: the PositionNFT's holder lock
 *  where the chain has the standalone token (#3205), or 'legacy' where the
 *  pre-#3205 Diamond keeps it in the mode itself. */
async function readNftLock(c: PublicClient, diamond: Hex, account: Hex, blockNumber: bigint): Promise<NftLockRead> {
  const surface = positionNftForDiamond(diamond);
  if (surface.mode === 'legacy') return 'legacy';
  const l = await answerOrNull(
    c.readContract({ address: surface.nft, abi: POSITION_NFT, functionName: 'lockOf', args: [account], blockNumber }) as Promise<
      readonly [boolean, bigint, bigint, bigint, bigint]
    >,
  );
  return l === null ? null : { locked: l[0], unlockAt: Number(l[2]) };
}

export async function readSafetyFacts(c: PublicClient, diamond: Hex, account: Hex): Promise<SafetyFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    answerOrNull(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
  const [mode, bounds, paused, posture, ids] = await Promise.all([
    readMode(c, diamond, account, block.number),
    read<readonly [bigint, bigint]>(PROTECTED, 'getProtectedDelayBounds'),
    read<boolean>(ADMIN, 'paused'),
    readSanctionsPosture(c, diamond, account, block.number),
    read<readonly bigint[]>(PAYOUT, 'getPendingPayoutIds', [account]),
  ]);
  return {
    account,
    mode,
    bounds: bounds === null ? null : { min: Number(bounds[0]), max: Number(bounds[1]) },
    paused,
    frozen: frozenState(posture),
    openRows: ids === null ? null : ids.length,
    chainNow: Number(block.timestamp),
    readAt: Date.now(),
  };
}

/** The chain's clock now: the block time at the read plus what has passed. */
export function safetyClock(f: Pick<SafetyFacts, 'chainNow' | 'readAt'>, nowMs: number): number | null {
  return f.chainNow === null ? null : f.chainNow + Math.max(0, Math.floor((nowMs - f.readAt) / 1000));
}

/** Every change waiting on the account, soonest first. */
export function pendingChanges(m: SafetyMode): { change: PendingChange; at: number }[] {
  const all: { change: PendingChange; at: number }[] = [
    { change: 'lowerDelay', at: m.pendingDelayAt },
    { change: 'nftOff', at: m.pendingNftOffAt },
    { change: 'cosignOff', at: m.pendingCosignOffAt },
    { change: 'unlock', at: m.pendingUnlockAt },
    { change: 'disable', at: m.pendingDisableAt },
  ];
  return all.filter((p) => p.at !== 0).sort((a, b) => a.at - b.at);
}

/** The changes `finalizeSettingChanges` would apply at `now`. */
export function dueChanges(m: SafetyMode, now: number): PendingChange[] {
  return pendingChanges(m)
    .filter((p) => now >= p.at)
    .map((p) => p.change);
}

/** What the reader chose for `enable`. */
export interface SafetyDraft {
  delaySeconds: number;
  protectNfts: boolean;
}

export interface SafetyReview {
  identity: string;
  action: SafetyAction;
  /** `enable` only. */
  draft: SafetyDraft | null;
  facts: SafetyFacts;
  /** The changes due when read (`finalize` only). */
  due: PendingChange[];
  /** The protocol's dry run: null when it passes, its refusal, or 'unread'.
   *  Asked only when nothing the app reads already stops it. */
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

/** The call an action stands for. */
export function safetyCall(action: SafetyAction, account: Hex, draft: SafetyDraft | null) {
  const args = action === 'enable' ? ([draft?.delaySeconds ?? 0, draft?.protectNfts ?? false] as const) : ([account] as const);
  return { abi: PROTECTED, functionName: SAFETY_FUNCTION[action], args };
}

export async function readSafetyReview(own: OwnStateClient, diamond: Hex, action: SafetyAction, draft: SafetyDraft | null, identity: string, copy: Copy): Promise<SafetyReview> {
  const account = own.account;
  const facts = await own.read((c: PublicClient) => readSafetyFacts(c, diamond, account)).then((x) => x.value);
  const now = safetyClock(facts, Date.now());
  const due = action === 'finalize' && facts.mode !== null && facts.mode !== 'absent' && now !== null ? dueChanges(facts.mode, now) : [];
  const base: SafetyReview = { identity, action, draft, facts, due, dryRun: null, readAt: Date.now() };
  if (safetyBlockers(base, copy).length > 0) return base;
  const call = safetyCall(action, account, draft);
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

/** What stops the action, in words (empty when nothing does), most
 *  fundamental first. An unread fact stops nothing on its own: the
 *  protocol's dry run decides, and the receipt says what was unread. */
export function safetyBlockers(r: SafetyReview, copy: Copy): string[] {
  const { text, format } = copy;
  const f = r.facts;
  const m = f.mode;
  if (m === 'absent') return [text('safety.unavailable')];
  if (m !== null && m.retired) return [text('safety.retired')];
  const pauseCloses = r.action !== 'lock';
  if (pauseCloses && f.paused === true) return [text('safety.paused')];
  if (r.action === 'enable') {
    if (f.frozen === 'flagged') return [text('safety.flagged')];
    if (m !== null && m.enabled) return [text('safety.alreadyOn')];
    const d = r.draft?.delaySeconds ?? 0;
    if (f.bounds !== null && (d < f.bounds.min || d > f.bounds.max)) return [format('safety.delayOutOfBounds', { min: formatSpan(f.bounds.min), max: formatSpan(f.bounds.max) })];
  } else if (m !== null) {
    if (!m.enabled) return [text('safety.notOn')];
    const now = safetyClock(f, Date.now());
    if (r.action === 'lock' && m.locked) return [text('safety.alreadyLocked')];
    if (r.action === 'unlock') {
      if (!m.locked) return [text('safety.notLocked')];
      if (m.pendingUnlockAt !== 0) return [format('safety.unlockPending', { at: formatUtc(m.pendingUnlockAt) })];
      if (now !== null && now < m.cooldownUntil) return [format('safety.cooldown', { at: formatUtc(m.cooldownUntil) })];
    }
    if (r.action === 'finalize') {
      if (r.due.length === 0) return [text('safety.nothingDue')];
      if (r.due.length === 1 && r.due[0] === 'disable' && f.openRows !== null && f.openRows > 0) return [text('safety.rowsOpen')];
    }
  }
  if (r.dryRun !== null && r.dryRun !== 'unread') return [format('safety.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

const modeKey = (m: SafetyFacts['mode']) => (m === null || m === 'absent' ? String(m) : JSON.stringify(m));

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function safetyChanged(a: SafetyReview, b: SafetyReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (modeKey(a.facts.mode) !== modeKey(b.facts.mode)) return text('safety.changedMode');
  if (a.due.join() !== b.due.join()) return text('safety.changedDue');
  if (a.action === 'lock' && a.facts.openRows !== b.facts.openRows) return text('safety.changedRows');
  if (a.facts.bounds?.min !== b.facts.bounds?.min || a.facts.bounds?.max !== b.facts.bounds?.max) return text('safety.changedBounds');
  if (a.facts.paused !== b.facts.paused || a.facts.frozen !== b.facts.frozen) return text('repay.changedVerdict');
  if ((a.dryRun === null) !== (b.dryRun === null) || (a.dryRun === 'unread') !== (b.dryRun === 'unread')) return text('repay.changedVerdict');
  return null;
}

type Args = Record<string, unknown>;

/** The words for each change, as the card and the finish card name it. */
export const CHANGE_WORDS = {
  lowerDelay: 'safety.changeLowerDelay',
  nftOff: 'safety.changeNftOff',
  cosignOff: 'safety.changeCosignOff',
  unlock: 'safety.changeUnlock',
  disable: 'safety.changeDisable',
} as const satisfies Record<PendingChange, string>;

/** A pending change in words; a shorter delay names the delay it sets, so
 *  the reader never confirms a reduction without seeing what it becomes. */
export function changeText(change: PendingChange, m: SafetyMode | null, copy: Copy): string {
  if (change === 'lowerDelay' && m !== null && m.pendingDelay > 0) return copy.format('safety.changeLowerDelayTo', { delay: formatSpan(m.pendingDelay) });
  return copy.text(CHANGE_WORDS[change]);
}

/** The action's outcome, from the Diamond's own logs for this account. */
export function measureSafety(r: SafetyReview, logs: readonly Log[], diamond: Hex, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const account = r.facts.account.toLowerCase();
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = (parseEventLogs({ abi: [...PROTECTED, ...PAYOUT] as Abi, logs: [...own], strict: false }) as unknown as { eventName: string; args: Args }[]).filter(
    (e) => String(e.args.account ?? '').toLowerCase() === account,
  );
  const find = (name: string) => events.filter((e) => e.eventName === name);
  if (r.action === 'enable') {
    const on = find('ProtectedModeEnabled')[0];
    if (!on) return [{ status: 'not-done', label: text('safety.titleEnable'), reason: text('safety.notEnabled') }];
    const delay = Number(on.args.delaySeconds as number | bigint);
    const label = format('safety.legEnabled', { delay: formatSpan(delay) });
    if (r.draft !== null && delay !== r.draft.delaySeconds) return [{ status: 'unknown', label, reason: text('safety.enabledOther') }];
    return [{ status: 'done', label }];
  }
  if (r.action === 'lock') {
    if (find('VaultLocked').length === 0) return [{ status: 'not-done', label: text('safety.titleLock'), reason: text('safety.lockNotRecorded') }];
    const cancelled = find('PayoutCancelled').length;
    const legs: LegOutcome[] = [{ status: 'done', label: text('safety.legLocked') }];
    if (cancelled > 0) legs.push({ status: 'done', label: format('safety.legCancelled', { count: String(cancelled) }) });
    return legs;
  }
  if (r.action === 'unlock') {
    const asked = find('SettingChangeRequested').find((e) => Number(e.args.kind as number | bigint) === CHANGE_KIND.unlock);
    if (!asked) return [{ status: 'not-done', label: text('safety.titleUnlock'), reason: text('safety.notRequested') }];
    return [{ status: 'done', label: format('safety.legUnlockRequested', { at: formatUtc(BigInt(asked.args.effectiveAt as bigint)) }) }];
  }
  const applied = new Set(find('SettingChangeApplied').map((e) => Number(e.args.kind as number | bigint)));
  const disabled = find('ProtectedModeDisabled').length > 0;
  const mode = r.facts.mode === null || r.facts.mode === 'absent' ? null : r.facts.mode;
  const legs: LegOutcome[] = r.due.map((change) => {
    const label = changeText(change, mode, copy);
    const done = change === 'disable' ? disabled : applied.has(CHANGE_KIND[change]);
    return done ? { status: 'done', label } : { status: 'not-done', label, reason: text(change === 'disable' ? 'safety.rowsOpen' : 'safety.notApplied') };
  });
  return legs.length > 0 ? legs : [{ status: 'not-done', label: text('safety.titleFinalize'), reason: text('safety.nothingDue') }];
}
