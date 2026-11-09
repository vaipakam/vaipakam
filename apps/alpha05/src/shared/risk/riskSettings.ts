/**
 * ACC-33 — the rules for Settings › Risk access, from the wallet's own
 * settings read in one block (`readRiskSettings`): what each level choice
 * would do now, whether strict mode still applies, the change to sign, its
 * receipt, and whether a re-read moved anything the receipt states.
 *
 * Nothing here restates the protocol's gate: a level counts the way the
 * protocol's own effective-level read says it does, and the waiting period
 * is the protocol's configured one, read in the same block.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';
import { formatSpan, formatUtc } from '../ui/format';
import { RISK_LEVELS, type RiskSettings } from './riskAccess';
import { levelName } from './riskReceipt';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** What choosing `level` would do now. */
export type LevelChoice =
  /** It is the level that counts now: nothing to change. */
  | { kind: 'current' }
  /** It is the level the wallet chose, still in its waiting period: choosing
   *  it again would start the wait over, so it is never offered. */
  | { kind: 'waiting'; until: bigint }
  /** It is the level the wallet chose, before a risk-terms change: one
   *  confirmation makes it count again. */
  | { kind: 'reaffirm' }
  /** Above the level that counts now: waits the protocol's period. */
  | { kind: 'raise' }
  /** At or below the level that counts now: takes effect at once. */
  | { kind: 'lower' };

export function levelChoice(s: RiskSettings, level: number): LevelChoice {
  if (level === s.held) {
    if (s.stale) return { kind: 'reaffirm' };
    if (s.effective < s.held && s.unlockAt > s.chainNow) return { kind: 'waiting', until: s.unlockAt };
    return { kind: 'current' };
  }
  return level > s.effective ? { kind: 'raise' } : { kind: 'lower' };
}

/** Every level, in order, with what choosing it would do. */
export function levelChoices(s: RiskSettings): { level: number; choice: LevelChoice }[] {
  return RISK_LEVELS.map((_, level) => ({ level, choice: levelChoice(s, level) }));
}

/** Strict mode as the protocol applies it now: on, off, or switched off but
 *  still applying until its waiting period ends. */
export type StrictState = { kind: 'on' } | { kind: 'off' } | { kind: 'lingering'; until: bigint };

export function strictState(s: RiskSettings): StrictState {
  if (s.strict) return { kind: 'on' };
  if (s.strictUntil > s.chainNow) return { kind: 'lingering', until: s.strictUntil };
  return { kind: 'off' };
}

/** The change under review. */
export type RiskChange = { kind: 'level'; level: number } | { kind: 'strict'; on: boolean };

/** Whether `change` is still one the page would offer on `s`. */
export function changeOffered(s: RiskSettings, change: RiskChange): boolean {
  if (change.kind === 'strict') return change.on !== s.strict;
  const c = levelChoice(s, change.level);
  return c.kind === 'raise' || c.kind === 'lower' || c.kind === 'reaffirm';
}

/** The function the change sends, with its arguments. A level names the
 *  change counter and terms version it was read with, so a level written
 *  elsewhere since, or new risk terms, refuse it and change nothing. */
export function changeCall(change: RiskChange, s: RiskSettings): { functionName: string; args: readonly unknown[] } {
  return change.kind === 'level'
    ? { functionName: 'setVaultRiskTierChecked', args: [change.level, s.nonce, s.termsVersion] }
    : { functionName: 'setRiskStrictMode', args: [change.on] };
}

/** When the change would count if sent now: at once, or after the waiting
 *  period from the block that records it (so an estimate until then). */
export function changeEffectiveAt(change: RiskChange, s: RiskSettings): bigint | null {
  if (s.cooldown === 0n) return null;
  if (change.kind === 'level') return change.level > s.effective ? s.chainNow + s.cooldown : null;
  // Switching strict mode on counts at once; switching it off keeps it
  // applying for the period.
  return change.on ? null : s.chainNow + s.cooldown;
}

/** Whether a re-read moved anything the change's receipt states or relies on. */
export function changeMoved(change: RiskChange, a: RiskSettings, b: RiskSettings): boolean {
  if (a.cooldown !== b.cooldown || a.gateOn !== b.gateOn) return true;
  if (change.kind === 'strict') return a.strict !== b.strict || a.strictUntil !== b.strictUntil;
  return a.nonce !== b.nonce || a.termsVersion !== b.termsVersion || a.held !== b.held || a.effective !== b.effective || a.stale !== b.stale || a.unlockAt !== b.unlockAt;
}

const STRICT_TITLE: Readonly<Record<'on' | 'off', CopyKey>> = { on: 'riskSettings.titleStrictOn', off: 'riskSettings.titleStrictOff' };

export function changeReceipt(change: RiskChange, s: RiskSettings, copy: Copy, opts: { chain: string; readAt: number }): Receipt {
  const { text, format } = copy;
  const at = changeEffectiveAt(change, s);
  const span = formatSpan(Number(s.cooldown));
  const moves = { label: text('risk.rowMoves'), value: { kind: 'text' as const, text: text('risk.movesNone') }, binding: true };
  const scope = { label: text('risk.rowScope'), value: { kind: 'text' as const, text: format('riskSettings.scopeAccount', { chain: opts.chain }) }, binding: true };
  if (change.kind === 'strict') {
    const effect =
      at === null ? text('risk.effectNowValue') : format('riskSettings.strictOffLater', { span, when: formatUtc(Number(at)) });
    const consequences = change.on
      ? [text('riskSettings.strictOnLose'), text('riskSettings.strictOnOffLater')]
      : [text('riskSettings.strictOffLose')];
    if (!s.gateOn) consequences.push(text('riskSettings.gateOffSaved'));
    return {
      title: text(STRICT_TITLE[change.on ? 'on' : 'off']),
      rows: [
        { label: text('riskSettings.rowStrict'), value: { kind: 'text', text: text(change.on ? 'riskSettings.strictTurnsOn' : 'riskSettings.strictTurnsOff') }, binding: true },
        scope,
        { label: text('risk.rowEffect'), value: { kind: 'text', text: effect }, binding: true },
        moves,
      ],
      consequences,
      prompts: 1,
      readAt: opts.readAt,
    };
  }
  const choice = levelChoice(s, change.level);
  const effect = at === null ? text('risk.effectNowValue') : format('risk.effectLaterValue', { span, when: formatUtc(Number(at)) });
  const consequences: string[] = [];
  if (choice.kind === 'raise' || choice.kind === 'reaffirm') consequences.push(text('risk.loseTier'));
  else consequences.push(text('riskSettings.lowerLose'));
  if (s.held !== change.level && s.held > s.effective) consequences.push(format('riskSettings.replacesChoice', { held: levelName(s.held, copy) }));
  consequences.push(text('risk.loseTerms'));
  if (!s.gateOn) consequences.push(text('riskSettings.gateOffSaved'));
  return {
    title: text(choice.kind === 'reaffirm' ? 'risk.titleReaffirm' : choice.kind === 'raise' ? 'risk.titleRaise' : 'riskSettings.titleLower'),
    rows: [
      { label: text('riskSettings.rowNow'), value: { kind: 'text', text: levelName(s.effective, copy) }, binding: true },
      {
        label: text('riskSettings.rowAfter'),
        value: { kind: 'text', text: choice.kind === 'reaffirm' ? format('risk.levelSame', { to: levelName(change.level, copy) }) : levelName(change.level, copy) },
        binding: true,
      },
      scope,
      { label: text('risk.rowEffect'), value: { kind: 'text', text: effect }, binding: true },
      moves,
    ],
    consequences,
    prompts: 1,
    readAt: opts.readAt,
  };
}
