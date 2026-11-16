/**
 * #3624 — the Auto-lend setup's review: what it stands on, read at one block
 * through the wallet's connection, the protocol's own verdict on the setup
 * as a dry run from this wallet, and the receipt that states every figure
 * the signature binds and every consequence, including what is not known.
 */
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { judgeDryRun, type CreateVerdict } from '../post/postReview';
import { tokenAcceptsApproval } from '../offers/reads';
import { bpsPercent } from '../offers/priceGuard';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { erc20Pair, readRiskStatus, riskPlan, type RiskNeed } from '../risk/riskAccess';
import type { Receipt, ReceiptRow, ReceiptText } from '../receipt/types';
import { allowanceSteps } from '../tx/approval';
import { chainValidUntil } from '../tx/deadline';
import { askThrough } from '../tx/simulate';
import type { Posture } from '../capability/types';
import {
  exposureOf,
  fillPosture,
  readSetupFacts,
  resolvedMinFill,
  setupBlocks,
  setupCall,
  wholeDays,
  type AutoLendDraft,
  type FillPosture,
  type SetupBlock,
  type SetupFacts,
} from './autoLend';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export interface AutoLendReview {
  draft: AutoLendDraft;
  /** The wallet and network the review was read under (`reviewIdentity`). */
  identity: string;
  readAt: number;
  facts: SetupFacts;
  /** The smallest loan the setup records; null when it cannot be sized. */
  minFill: bigint | null;
  blocks: SetupBlock[];
  /** Wallet prompts the approval needs (0 when the allowance covers it). */
  approvalSteps: number;
  posture: FillPosture;
  /** The risk-access step a fill would refuse without, if any: the protocol
   *  checks it when each loan is made, not when the setup is sent, so the
   *  review reads it now rather than let every fill fail. */
  risk: RiskNeed | null;
  verdict: CreateVerdict;
}

/** The first risk-access step this wallet lacks for the pair, read through
 *  the same rule the risk step applies; null when none is needed. */
async function readRiskNeed(own: OwnStateClient, diamond: Hex, lending: Hex, collateral: Hex): Promise<RiskNeed | null> {
  const pair = erc20Pair(lending, collateral);
  for (const need of ['tier', 'mid-tier-ack'] as const) {
    const status = (await own.read((c) => readRiskStatus(c, diamond, own.account, need, { kind: 'pair', pair }))).value;
    if (riskPlan(status).kind !== 'met') return need;
  }
  return null;
}

export async function readAutoLendReview(own: OwnStateClient, diamond: Hex, draft: AutoLendDraft, identity: string): Promise<AutoLendReview> {
  const account = own.account;
  const facts = (await own.read((c) => readSetupFacts(c, diamond, account, draft.lending, draft.collateral))).value;
  const fund = draft.parsed.fund;
  const approvalSteps =
    facts.allowance >= fund
      ? 0
      : (
          await allowanceSteps(
            { accepts: (amount) => own.read((c) => tokenAcceptsApproval(c, draft.lending, account, diamond, amount)).then((x) => x.value) },
            facts.allowance,
            fund,
          )
        ).length;
  const minFill = resolvedMinFill(draft.parsed, facts.floor);
  const blocks = setupBlocks(draft, facts);
  const risk = await readRiskNeed(own, diamond, draft.lending, draft.collateral);
  let verdict: CreateVerdict;
  if (minFill === null) {
    verdict = { kind: 'unreadable', reason: 'minimum loan unread' };
  } else {
    // While the approval does not cover the funding, the terms are dry-run
    // alone: their verdict is known before any prompt, and the whole batch
    // is dry-run again with the approval in place before it is sent.
    const covers = approvalSteps === 0;
    const dry = await askThrough(own, async (c) => c.simulateContract({ address: diamond, ...setupCall(draft, minFill, await chainValidUntil(c), !covers), account }));
    const v = judgeDryRun(dry, true);
    verdict = v.kind === 'ok' && !covers ? { kind: 'needs-approval' } : v;
  }
  return { draft, identity, readAt: Date.now(), facts, minFill, blocks, approvalSteps, posture: fillPosture(facts.gates), risk, verdict };
}

/** What moved between a review and a re-read of it, as a key: a change in
 *  any figure the receipt states or the verdict stands on. */
export function reviewKey(r: AutoLendReview): string {
  return [
    r.verdict.kind,
    r.verdict.kind === 'refused' ? r.verdict.code : '',
    r.minFill ?? 'x',
    r.approvalSteps,
    r.posture,
    r.risk ?? '',
    r.blocks.map((b) => b.kind).join(','),
    r.facts.minTermsAgeSec,
    r.facts.floor ?? 'x',
  ].join('|');
}

/** The tier-A sentence for each block the review found. */
export function blockText(b: SetupBlock, r: AutoLendReview, meta: TokenMetaMap | null, copy: Copy): string {
  const { text, format } = copy;
  const amt = (v: bigint) => tokenAmount(v, r.draft.lending, meta, format);
  switch (b.kind) {
    case 'exists':
      return text('autoLend.blockExists');
    case 'lendUntil':
      return format('autoLend.blockUntil', { date: new Date(Number(b.earliest) * 1000).toLocaleString() });
    case 'floorUnread':
      return text('autoLend.blockFloorUnread');
    case 'belowFloor':
      return format('autoLend.blockFloor', { floor: amt(b.floor) });
    case 'balance':
      return format('autoLend.blockBalance', { have: amt(b.balance), need: amt(r.draft.parsed.fund) });
  }
}

/** Every reason the setup cannot be signed now, in the order a reader acts
 *  on them; empty when the review's verdict allows it. A risk-access step is
 *  named by the page's own gate, which offers it. */
export function reviewBlockers(r: AutoLendReview, meta: TokenMetaMap | null, copy: Copy): string[] {
  const { text, format } = copy;
  const out = r.blocks.map((b) => blockText(b, r, meta, copy));
  if (r.posture === 'halted' || r.posture === 'off') out.push(format('autoLend.blockOff', { why: text(r.posture === 'halted' ? 'autoLend.whyHalted' : 'autoLend.whyOff') }));
  // A refusal the blocks above already explain is not repeated.
  if (out.length === 0 && r.verdict.kind === 'refused') out.push(format('autoLend.blockRefused', { reason: r.verdict.reason }));
  if (out.length === 0 && r.verdict.kind === 'unreadable') out.push(format('flow.unreadable', { reason: r.verdict.reason }));
  return out;
}

/** The receipt: every figure the setup records, and what it means. */
export function autoLendReceipt(r: AutoLendReview, meta: TokenMetaMap | null, copy: Copy, matcher: Posture): Receipt {
  const { text, format } = copy;
  const d = r.draft;
  const p = d.parsed;
  const lend = assetName(d.lending, meta);
  const coll = assetName(d.collateral, meta);
  const amount = (v: bigint): ReceiptRow['value'] => ({ kind: 'amount', asset: d.lending, amount: v });
  const rows: ReceiptRow[] = [
    { label: text('autoLend.rowWhat'), value: { kind: 'text', text: format('autoLend.whatValue', { lend, coll }) }, binding: true },
    { label: text('autoLend.rowFund'), value: amount(p.fund), binding: true, movesOut: true },
    { label: text('autoLend.rowExposure'), value: amount(exposureOf(p)), binding: true },
    { label: text('autoLend.rowRate'), value: { kind: 'text', text: format('autoLend.rateValue', { rate: bpsPercent(Number(p.minRateBps)) }) }, binding: true },
    { label: text('autoLend.rowLtv'), value: { kind: 'text', text: format('autoLend.ltvValue', { ltv: bpsPercent(p.maxInitLtvBps) }) }, binding: true },
    { label: text('autoLend.rowDays'), value: { kind: 'text', text: format('autoLend.daysValue', { days: String(p.maxDurationDays) }) }, binding: true },
    {
      label: text('autoLend.rowMinFill'),
      value: r.minFill === null ? { kind: 'unknown', why: text('autoLend.minFillUnread') } : amount(r.minFill),
      binding: true,
    },
    {
      label: text('autoLend.rowUntil'),
      value: d.lendUntil === 0n ? { kind: 'text', text: text('autoLend.untilNone') } : { kind: 'time', unixSeconds: Number(d.lendUntil) },
      binding: true,
    },
    { label: text('autoLend.rowInterest'), value: { kind: 'text', text: text(p.acceptsProRata ? 'autoLend.interestBoth' : 'autoLend.interestFull') }, binding: true },
    { label: text('autoLend.rowFiller'), value: { kind: 'text', text: text('autoLend.fillerAny') }, binding: true },
    { label: text('autoLend.rowFirstFill'), value: { kind: 'time', unixSeconds: Number(r.facts.chainNow + r.facts.minTermsAgeSec) }, binding: false },
  ];
  if (r.approvalSteps > 0) rows.push({ label: text('autoLend.rowApproval'), value: amount(p.fund), binding: true, movesOut: true });

  const consequences: ReceiptText[] = [text('autoLend.loseNoDirect'), text('autoLend.loseSizing'), text('autoLend.loseRelend'), text('autoLend.loseVault')];
  if (d.lendUntil !== 0n) consequences.push(format('autoLend.loseUntil', { date: new Date(Number(d.lendUntil) * 1000).toLocaleString() }));
  if (p.acceptsProRata) consequences.push(text('autoLend.loseProRata'));
  const ageDays = wholeDays(r.facts.minTermsAgeSec);
  const wait =
    ageDays >= 1 ? format('autoLend.daysValue', { days: String(ageDays) }) : format('autoLend.minutesValue', { n: String(Math.ceil(Number(r.facts.minTermsAgeSec) / 60)) });
  if (r.facts.minTermsAgeSec > 0n) consequences.push(format('autoLend.loseTermsAge', { wait }));
  if (r.posture === 'unknown') consequences.push(text('autoLend.losePostureUnknown'));
  if (r.posture === 'service-paused') consequences.push(text('autoLend.loseServicePaused'));
  else if (matcher === 'absent') consequences.push(text('autoLend.loseServiceOff'));
  else if (matcher === 'unknown') consequences.push(text('autoLend.loseServiceUnknown'));
  return { title: text('autoLend.receiptTitle'), rows, consequences, prompts: r.approvalSteps + 1, readAt: r.readAt };
}
