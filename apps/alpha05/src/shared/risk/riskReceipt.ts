/**
 * ACC-RISK — what a risk-access step says before the signature and what it
 * reports after, from the status it was planned on. A step moves no funds;
 * what it changes is which pairs this wallet may use, so the receipt states
 * the reach of the change (every pair up to a level, or one exact pair),
 * when it takes effect, and what undoes it.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';
import { formatSpan, formatUtc } from '../ui/format';
import { effectiveAfter, riskLevel, type RiskLevel, type RiskPlan, type RiskStatus } from './riskAccess';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

const LEVEL_KEYS: Readonly<Record<RiskLevel, CopyKey>> = { 'blue-chip': 'risk.levelBlueChip', liquid: 'risk.levelLiquid', any: 'risk.levelAny' };

export function levelName(n: number, copy: Pick<CopyAccess, 'text'>): string {
  return copy.text(LEVEL_KEYS[riskLevel(n)]);
}

/** A step the reader can take (as opposed to a wait or a step no longer needed). */
export type ActionPlan = Extract<RiskPlan, { kind: 'raise' | 'reaffirm' | 'consent' | 'ack' }>;

export function isAction(plan: RiskPlan): plan is ActionPlan {
  return plan.kind === 'raise' || plan.kind === 'reaffirm' || plan.kind === 'consent' || plan.kind === 'ack';
}

const TITLES: Readonly<Record<ActionPlan['kind'], CopyKey>> = { raise: 'risk.titleRaise', reaffirm: 'risk.titleReaffirm', consent: 'risk.titleConsent', ack: 'risk.titleAck' };

/** What the reader is told about the step's need, in place, before opening it. */
export function needSentences(s: RiskStatus, copy: Copy, pairLabel: string): string[] {
  if (s.need === 'tier') {
    const out = [copy.format('risk.needTier', { required: levelName(s.required, copy), effective: levelName(s.effective, copy) })];
    if (s.stale) out.push(copy.format('risk.needStale', { held: levelName(s.held, copy), base: levelName(0, copy) }));
    return out;
  }
  return [copy.format(s.need === 'pair-consent' ? 'risk.needConsent' : 'risk.needAck', { pair: pairLabel })];
}

/** When the step would take effect if taken now, as a sentence. */
export function effectSentence(s: RiskStatus, copy: Copy): string {
  const at = effectiveAfter(s);
  return at === null ? copy.text('risk.effectNow') : copy.format('risk.effectLater', { span: formatSpan(Number(s.cooldown)), when: formatUtc(Number(at)) });
}

export function riskReceipt(plan: ActionPlan, s: RiskStatus, copy: Copy, opts: { chain: string; pairLabel: string; readAt: number }): Receipt {
  const { text, format } = copy;
  const at = effectiveAfter(s);
  const effect = at === null ? text('risk.effectNowValue') : format('risk.effectLaterValue', { span: formatSpan(Number(s.cooldown)), when: formatUtc(Number(at)) });
  const tier = plan.kind === 'raise' || plan.kind === 'reaffirm';
  const rows: Receipt['rows'] = tier
    ? [
        {
          label: text('risk.rowLevel'),
          value: {
            kind: 'text',
            text:
              plan.kind === 'reaffirm' || plan.level === s.effective
                ? format('risk.levelSame', { to: levelName(plan.level, copy) })
                : format('risk.levelChange', { from: levelName(s.effective, copy), to: levelName(plan.level, copy) }),
          },
          binding: true,
        },
        { label: text('risk.rowScope'), value: { kind: 'text', text: format('risk.scopeTier', { chain: opts.chain }) }, binding: true },
        { label: text('risk.rowEffect'), value: { kind: 'text', text: effect }, binding: true },
        { label: text('risk.rowMoves'), value: { kind: 'text', text: text('risk.movesNone') }, binding: true },
        { label: text('risk.rowLower'), value: { kind: 'text', text: text('risk.lowerAnyTime') }, binding: false },
      ]
    : [
        { label: text('risk.rowPair'), value: { kind: 'text', text: opts.pairLabel }, binding: true },
        { label: text('risk.rowScope'), value: { kind: 'text', text: format('risk.scopePair', { chain: opts.chain }) }, binding: true },
        { label: text('risk.rowEffect'), value: { kind: 'text', text: effect }, binding: true },
        { label: text('risk.rowMoves'), value: { kind: 'text', text: text('risk.movesNone') }, binding: true },
      ];
  const consequences = tier
    ? [text('risk.loseTier'), text('risk.loseTerms')]
    : plan.kind === 'consent'
      ? [text('risk.loseConsent'), text('risk.loseTerms')]
      : [text('risk.loseAck'), text('risk.loseTerms')];
  return { title: text(TITLES[plan.kind]), rows, consequences, prompts: 1, readAt: opts.readAt };
}

/** Whether a re-read changed what the step would do or say. */
export function planMoved(a: { plan: RiskPlan; status: RiskStatus }, b: { plan: RiskPlan; status: RiskStatus }): boolean {
  if (a.plan.kind !== b.plan.kind) return true;
  if ((a.plan.kind === 'raise' || a.plan.kind === 'reaffirm') && (b.plan.kind === 'raise' || b.plan.kind === 'reaffirm') && a.plan.level !== b.plan.level) return true;
  const x = a.status;
  const y = b.status;
  return x.effective !== y.effective || x.cooldown !== y.cooldown || x.nonce !== y.nonce || x.termsVersion !== y.termsVersion || x.required !== y.required;
}
