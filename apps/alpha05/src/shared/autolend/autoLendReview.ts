/**
 * #3624 — the Auto-lend setup's review: what it stands on, read at one block
 * through the wallet's connection, the protocol's own verdict on the setup
 * as a dry run from this wallet, and the receipt that states every figure
 * the signature binds and every consequence, including what is not known.
 */
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { actionsIn, type KeeperGrant } from '../keepers/keepers';
import { judgeDryRun, type CreateVerdict } from '../post/postReview';
import { tokenAcceptsApproval } from '../offers/reads';
import { bpsPercent } from '../offers/priceGuard';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { RiskNeed } from '../risk/riskAccess';
import { readRiskNeed } from '../risk/riskNeed';
import type { Receipt, ReceiptRow, ReceiptText } from '../receipt/types';
import { allowanceSteps } from '../tx/approval';
import { chainValidUntil } from '../tx/deadline';
import { askThrough } from '../tx/simulate';
import type { Posture } from '../capability/types';
import {
  exposureOf,
  fillPosture,
  ltvCapBlock,
  readLtvCap,
  readSetupFacts,
  resolvedMinFill,
  setAsideAfter,
  setupBlocks,
  setupCall,
  wholeDays,
  type AutoLendDraft,
  type FillPosture,
  type IntentRecord,
  type LtvCap,
  type SetupBlock,
  type SetupFacts,
} from './autoLend';
import {
  anyInstant,
  changeEffective,
  effectivePreset,
  instantOff,
  presetFactsKey,
  readInstantSlot,
  readPresetFacts,
  type EffectivePreset,
  type InstantSlotRecord,
  type PresetFacts,
  type PresetLogs,
  AUTO_ROLL,
  RENEWAL_BUILT,
  readRollRunner,
} from './preset';
import type { LegOutcome } from '../tx/outcome';
import type { IndexerClient } from '../reads/world/indexerClient';
import { takeoverRouted } from '../capability/routes';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export interface AutoLendReview {
  draft: AutoLendDraft;
  /** The wallet and network the review was read under (`reviewIdentity`). */
  identity: string;
  readAt: number;
  /** #3763: whether the takeover at face value is deployed here, so the
   *  review names a handover as a way to get funds back. */
  handover: boolean;
  facts: SetupFacts;
  /** For a change, the record it replaces, as read with the facts: the most
   *  at once and smallest loan kept when none is typed, and the fill
   *  restriction kept as it is. null for a new setup. */
  base: IntentRecord | null;
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
  /** Whether the protocol's keeper may put repaid money back behind the
   *  setup (`KEEPER_ACTION_AUTO_ROLL`): the protocol refuses that roll from
   *  a keeper the wallet has not allowed, and the money then comes back as
   *  a claim instead of being lent again. */
  roll: RollPermission;
  /** The highest loan-to-value the network takes for the pair at the
   *  review's prices; null when it could not be read. Checked at each fill,
   *  not when the setup is sent, so the dry run cannot show it. */
  ltvCap: LtvCap | null;
  /** #3761 — what the lender's choices stand on (keeper settings, the
   *  instant market's reach for the pair), and what the batch carries. */
  preset: PresetFacts;
  effective: EffectivePreset;
  /** For a change, the slot's instant-market consents as recorded (setting
   *  the terms clears them, so the batch sends them again); null for a new
   *  setup, or when they could not be read (`instantUnread` then blocks). */
  instantRecord: InstantSlotRecord | null;
  /** A change whose recorded consents cannot be sent again (interest by time
   *  switched off, or the market no longer takes the pair): they are cleared. */
  instantCleared: boolean;
  verdict: CreateVerdict;
}

/** `vpfi`: the protocol never rolls a VPFI loan
 *  (`LenderIntentVpfiRollUnsupported`), whatever the keeper settings. */
export type RollPermission = 'allowed' | 'not-allowed' | 'vpfi' | 'unknown' | 'no-keeper';

/** The roll permission the setup leaves: what is given now, or what the
 *  batch gives. */
export function rollAfter(e: EffectivePreset): RollPermission {
  switch (e.relend) {
    case 'given':
    case 'granted':
      return 'allowed';
    case 'vpfi':
      return 'vpfi';
    case 'unknown':
      return 'unknown';
    case 'no-keeper':
      return 'no-keeper';
    default:
      return 'not-allowed';
  }
}


export async function readAutoLendReview(own: OwnStateClient, diamond: Hex, draft: AutoLendDraft, identity: string, indexer: IndexerClient): Promise<AutoLendReview> {
  const account = own.account;
  const rollRunner = await readRollRunner(indexer, own.chainId, diamond);
  const facts = (await own.read((c) => readSetupFacts(c, diamond, account, draft.lending, draft.collateral, draft.slot))).value;
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
  const base = draft.change ? facts.record : null;
  const minFill = resolvedMinFill(draft.parsed, facts.floor, base);
  const [risk, preset, instantRecord, ltvCap, handover] = await Promise.all([
    readRiskNeed(own, diamond, draft.lending, draft.collateral),
    own.read((c) => readPresetFacts(c, diamond, account, own.chainId, draft.lending, draft.collateral, draft.slot, rollRunner)).then((x) => x.value),
    draft.change
      ? own
          .read((c) => readInstantSlot(c, diamond, account, draft.lending, draft.collateral, draft.slot, facts.blockNumber))
          .then((x) => x.value)
          .catch(() => null)
      : Promise.resolve(null),
    minFill === null || minFill === 0n
      ? Promise.resolve(null)
      : own
          .read((c) => readLtvCap(c, diamond, draft.lending, draft.collateral, minFill, draft.parsed.maxInitLtvBps, facts.blockNumber))
          .then((x) => x.value)
          .catch(() => null),
    own
      .read((c) => takeoverRouted(c, diamond))
      .then((x) => x.value)
      .catch(() => false),
  ]);
  const capBlock = ltvCapBlock(ltvCap);
  const blocks = capBlock === null ? setupBlocks(draft, facts) : [...setupBlocks(draft, facts), capBlock];
  // A new setup carries the lender's choices; a change sends again the
  // consents the slot had, where they can still be sent.
  let effective: EffectivePreset;
  let instantCleared = false;
  if (draft.preset !== null) {
    effective = effectivePreset({ ...draft.preset, proRata: draft.parsed.acceptsProRata }, preset.relend, preset.instant, draft.relendConfirmed);
    if (effective.relend === 'unconfirmed') blocks.push({ kind: 'keeperList' });
  } else {
    const c = changeEffective(instantRecord, draft.parsed.acceptsProRata, preset.instant, preset.relend);
    effective = c.effective;
    instantCleared = c.cleared;
    if (draft.change && instantRecord === null) blocks.push({ kind: 'instantUnread' });
  }
  const roll = rollAfter(effective);
  let verdict: CreateVerdict;
  if (minFill === null) {
    verdict = { kind: 'unreadable', reason: 'minimum loan unread' };
  } else {
    // While the approval does not cover the funding, the terms are dry-run
    // alone: their verdict is known before any prompt, and the whole batch
    // is dry-run again with the approval in place before it is sent.
    const covers = approvalSteps === 0;
    const dry = await askThrough(own, async (c) =>
      c.simulateContract({ address: diamond, ...setupCall(draft, minFill, await chainValidUntil(c), base, !covers, effective), account }),
    );
    const v = judgeDryRun(dry, true);
    verdict = v.kind === 'ok' && !covers ? { kind: 'needs-approval' } : v;
  }
  return {
    draft,
    identity,
    readAt: Date.now(),
    handover,
    facts,
    base,
    minFill,
    blocks,
    approvalSteps,
    posture: fillPosture(facts.gates),
    risk,
    roll,
    ltvCap,
    preset,
    effective,
    instantRecord,
    instantCleared,
    verdict,
  };
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
    r.roll,
    r.handover,
    r.ltvCap === null ? 'x' : r.ltvCap.kind === 'cap' ? `${r.ltvCap.fits}:${r.ltvCap.approxBps}` : r.ltvCap.kind,
    r.blocks.map((b) => b.kind).join(','),
    r.facts.minTermsAgeSec,
    r.facts.floor ?? 'x',
    // A change stands on the record it replaces and the money around it.
    r.base === null
      ? ''
      : Object.entries(r.base)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(','),
    r.facts.unlent,
    r.facts.lent,
    String(r.facts.priority),
    presetFactsKey(r.preset),
    JSON.stringify({ ...r.effective, keeper: r.effective.keeper.map((k) => JSON.stringify(k)) }),
    r.instantRecord === null ? 'x' : `${r.instantRecord.fills}${r.instantRecord.renewal}${r.instantRecord.takeover}`,
    String(r.instantCleared),
  ].join('|');
}

/** The tier-A sentence for each block the review found. */
export function blockText(b: SetupBlock, r: AutoLendReview, meta: TokenMetaMap | null, copy: Copy): string {
  const { text, format } = copy;
  const amt = (v: bigint) => tokenAmount(v, r.draft.lending, meta, format);
  switch (b.kind) {
    case 'exists':
      return text('autoLend.blockExists');
    case 'missing':
      return text('autoLend.blockMissing');
    case 'minAboveExposure':
      return format('autoLend.blockMinAboveExposure', { min: amt(b.minFill) });
    case 'lendUntil':
      return format('autoLend.blockUntil', { date: new Date(Number(b.earliest) * 1000).toLocaleString() });
    case 'floorUnread':
      return text('autoLend.blockFloorUnread');
    case 'belowFloor':
      return format('autoLend.blockFloor', { floor: amt(b.floor) });
    case 'minAboveFund':
      return format(r.draft.change ? 'autoLend.blockMinAboveWaiting' : 'autoLend.blockMinAboveFund', { min: amt(b.minFill), fund: amt(setAsideAfter(r.draft, r.facts)) });
    case 'balance':
      return format('autoLend.blockBalance', { have: amt(b.balance), need: amt(r.draft.parsed.fund) });
    case 'ltvCap':
      return format('autoLend.blockLtvCap', { ltv: bpsPercent(r.draft.parsed.maxInitLtvBps), cap: bpsPercent(b.capBps) });
    case 'ltvClosed':
      return text('autoLend.blockLtvClosed');
    case 'keeperList':
      return text('autoLend.blockKeeperList');
    case 'instantUnread':
      return text('autoLend.blockInstantUnread');
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
  const base = r.base;
  const exposure = exposureOf(p, base);
  const fundRows: ReceiptRow[] = !d.change
    ? [{ label: text('autoLend.rowFund'), value: amount(p.fund), binding: true, movesOut: true }]
    : [
        p.fund > 0n
          ? { label: text('autoLend.rowAdd'), value: amount(p.fund), binding: true, movesOut: true }
          : { label: text('autoLend.rowAdd'), value: { kind: 'text', text: text('autoLend.addNone') }, binding: true },
        { label: text('autoLend.rowSetAside'), value: amount(setAsideAfter(d, r.facts)), binding: false },
      ];
  const rows: ReceiptRow[] = [
    { label: text('autoLend.rowWhat'), value: { kind: 'text', text: format('autoLend.whatValue', { lend, coll }) }, binding: true },
    ...fundRows,
    { label: text('autoLend.rowExposure'), value: amount(exposure), binding: true },
    {
      label: text('autoLend.rowRate'),
      value: { kind: 'text', text: p.minRateBps === 0n ? text('autoLend.rateAny') : format('autoLend.rateValue', { rate: bpsPercent(Number(p.minRateBps)) }) },
      binding: true,
    },
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
    ...presetRows(r, copy),
    { label: text('autoLend.rowFiller'), value: { kind: 'text', text: text(base?.requiresKeeperAuth === true ? 'autoLend.fillerAllowed' : 'autoLend.fillerAny') }, binding: true },
    { label: text('autoLend.rowFirstFill'), value: { kind: 'time', unixSeconds: Number(r.facts.chainNow + r.facts.minTermsAgeSec) }, binding: false },
  ];
  if (r.approvalSteps > 0) rows.push({ label: text('autoLend.rowApproval'), value: amount(p.fund), binding: true, movesOut: true });

  const consequences: ReceiptText[] = [
    text('autoLend.loseNoDirect'),
    text('autoLend.loseSizing'),
    text(
      r.roll === 'allowed'
        ? 'autoLend.loseRelend'
        : r.roll === 'not-allowed'
          ? 'autoLend.loseRelendOff'
          : r.roll === 'vpfi'
            ? 'autoLend.loseRelendVpfi'
            : r.roll === 'no-keeper'
              ? 'autoLend.loseRelendNoKeeper'
              : 'autoLend.loseRelendUnknown',
    ),
    text('autoLend.loseVault'),
  ];
  consequences.push(...presetConsequences(r, copy));
  if (r.ltvCap === null) consequences.push(text('autoLend.loseLtvCapUnread'));
  else if (r.ltvCap.kind === 'cap' && r.ltvCap.fits) consequences.push(text('autoLend.loseLtvCap'));
  if (d.lendUntil !== 0n) consequences.push(format('autoLend.loseUntil', { date: new Date(Number(d.lendUntil) * 1000).toLocaleString() }));
  if (p.acceptsProRata) consequences.push(text('autoLend.loseProRata'));
  const ageDays = wholeDays(r.facts.minTermsAgeSec);
  const wait =
    ageDays >= 1 ? format('autoLend.daysValue', { days: String(ageDays) }) : format('autoLend.minutesValue', { n: String(Math.ceil(Number(r.facts.minTermsAgeSec) / 60)) });
  if (r.facts.minTermsAgeSec > 0n) consequences.push(format(d.change ? 'autoLend.loseTermsAgeRestart' : 'autoLend.loseTermsAge', { wait }));
  if (base !== null) {
    consequences.push(text('autoLend.loseChangeOpen'));
    if (!base.active) consequences.push(text('autoLend.loseStartAgain'));
    if (r.facts.lent > 0n && r.facts.lent >= exposure) consequences.push(format('autoLend.loseBelowLent', { lent: tokenAmount(r.facts.lent, d.lending, meta, format) }));
    if (base.requiresKeeperAuth) consequences.push(text('autoLend.loseKeeperOnly'));
    if (r.facts.priority === true) consequences.push(text('autoLend.losePriority'));
    else if (r.facts.priority === null) consequences.push(text('autoLend.losePriorityUnknown'));
  }
  if (r.posture === 'unknown') consequences.push(text('autoLend.losePostureUnknown'));
  if (r.posture === 'service-paused') consequences.push(text('autoLend.loseServicePaused'));
  else if (matcher === 'absent') consequences.push(text('autoLend.loseServiceOff'));
  else if (matcher === 'unknown') consequences.push(text('autoLend.loseServiceUnknown'));
  const title = base === null ? 'autoLend.receiptTitle' : base.active ? 'autoLend.changeTitle' : 'autoLend.startTitle';
  // #3763: what open-ended means here, for a new Auto-lend and a change alike.
  const sections = openEndedSections(d, r.handover, copy);
  return { title: text(title), rows, consequences, sections, prompts: r.approvalSteps + 1, readAt: r.readAt };
}

/** #3761 — the receipt rows for the lender's choices: each stated as the
 *  batch carries it, with the reason where it is off whatever was chosen. */
export function presetRows(r: AutoLendReview, copy: Copy): ReceiptRow[] {
  const { text, format } = copy;
  const e = r.effective;
  const chosen = r.draft.preset;
  const row = (labelKey: CopyKey, value: string, binding: boolean): ReceiptRow => ({ label: text(labelKey), value: { kind: 'text', text: value }, binding });
  const rows: ReceiptRow[] = [];
  const relend = (): string => {
    switch (e.relend) {
      case 'given':
        return text(chosen !== null && !chosen.relend ? 'autoLend.relendGivenKept' : 'autoLend.relendGiven');
      case 'granted': {
        const s = r.preset.relend;
        const regain = s.kind === 'grant' && s.regain.length > 0;
        return regain ? text('autoLend.relendGrantedRegain') : format('autoLend.relendGranted', { keeper: r.preset.keeper ?? '' });
      }
      case 'off':
        return text('autoLend.relendOff');
      case 'vpfi':
        return text('autoLend.relendVpfi');
      case 'full':
        return text('autoLend.relendFull');
      case 'unconfirmed':
        return text('autoLend.relendUnconfirmed');
      case 'unknown':
        return text('autoLend.relendUnknown');
      case 'no-keeper':
        return text('autoLend.relendNoKeeper');
    }
  };
  rows.push(row('autoLend.rowRelend', relend(), e.relend === 'granted'));
  if (chosen !== null) {
    const off = instantOff(e.proRata, r.preset.instant);
    const instant = (on: boolean, picked: boolean): string => {
      if (on) return text('autoLend.instantOn');
      switch (off) {
        case 'market-off':
          return text('autoLend.instantOffMarket');
        case 'pair-not-eligible':
          return text('autoLend.instantOffPair');
        case 'unknown':
          return text('autoLend.instantOffUnknown');
        case 'needs-pro-rata':
          return text('autoLend.instantOffProRata');
        default:
          return text(picked ? 'autoLend.instantOffUnknown' : 'autoLend.instantSwitchedOff');
      }
    };
    rows.push(row('autoLend.rowFills', instant(e.fills, chosen.fills), true));
    rows.push(row('autoLend.rowRenewal', RENEWAL_BUILT ? instant(e.renewal, chosen.renewal) : text('autoLend.renewalNotYetRow'), true));
    rows.push(row('autoLend.rowTakeover', instant(e.takeover, chosen.takeover), true));
  } else if (r.instantRecord !== null) {
    rows.push(row('autoLend.rowInstantChange', text(anyInstant(e) ? 'autoLend.instantResent' : r.instantCleared ? 'autoLend.instantCleared' : 'autoLend.instantNone'), true));
  }
  return rows;
}

/** #3761 — what the lender's choices mean, stated before signing. */
export function presetConsequences(r: AutoLendReview, copy: Copy): ReceiptText[] {
  const { text, format } = copy;
  const e = r.effective;
  const out: ReceiptText[] = [];
  const s = r.preset.relend;
  if (e.relend === 'granted' && s.kind === 'grant' && s.regain.length > 0) {
    out.push(format('autoLend.loseRelendRegain', { list: s.regain.map((g) => regainLine(g, copy)).join('; ') }));
  }
  // #3763 rule 7: a permission given or held is not a runner.
  if ((e.relend === 'granted' || e.relend === 'given') && r.preset.roll !== 'running') {
    out.push(text(r.preset.roll === 'unknown' ? 'autoLend.loseRelendRunUnknown' : 'autoLend.loseRelendNoRun'));
  }
  if (anyInstant(e)) {
    out.push(text('autoLend.loseInstantWhat'));
    if (e.takeover) out.push(text('autoLend.loseTakeover'));
    if (RENEWAL_BUILT && !e.renewal) out.push(text('autoLend.loseRenewalOff'));
    out.push(text('autoLend.loseInstantReady'));
  }
  if (r.instantCleared) out.push(text('autoLend.loseInstantCleared'));
  return out;
}

/** #3763 — what open-ended means here, under its two headings (§3.6),
 *  stated on the review before signing. `handover` where the takeover at
 *  face value is deployed on this network. */
export function openEndedSections(draft: AutoLendDraft, handover: boolean, copy: Copy): { title: string; body: string[] }[] {
  const { text, format } = copy;
  const length =
    draft.parsed.lendUntilDate === null
      ? { title: text('autoLend.openEndedTitle'), body: [text('autoLend.openEndedBody')] }
      : { title: format('autoLend.setPeriodTitle', { date: draft.parsed.lendUntilDate }), body: [format('autoLend.setPeriodBody', { date: draft.parsed.lendUntilDate })] };
  return [
    length,
    {
      title: text('autoLend.fundsBackTitle'),
      body: [text('autoLend.fundsBackBody'), text(handover ? 'autoLend.fundsBackSooner' : 'autoLend.fundsBackSoonerSale'), text('autoLend.fundsBackNoPromise')],
    },
  ];
}

/** One keeper approval switching access back on restores, in plain words. */
export function regainLine(g: KeeperGrant, copy: Copy): string {
  const acts = actionsIn(g.actions).map((a) => copy.text(a.key));
  return copy.format('autoLend.regainLine', { keeper: g.keeper, actions: acts.length > 0 ? acts.join(', ') : copy.text('autoLend.regainNone') });
}

/** #3761 — the outcome of each choice the batch carried, measured from its
 *  own logs: the instant-market consents as recorded, and the keeper's roll
 *  permission (and keeper access, where the batch switched it on). */
export function presetLegs(logs: PresetLogs, e: EffectivePreset, copy: Copy): LegOutcome[] {
  const { text } = copy;
  const legs: LegOutcome[] = [];
  if (anyInstant(e)) {
    const label = text('autoLend.legInstant');
    const got = logs.instant;
    if (got !== null && got.fills === e.fills && got.renewal === e.renewal && got.takeover === e.takeover) legs.push({ status: 'done', label });
    else legs.push({ status: 'not-done', label, reason: text('autoLend.legInstantMissing') });
  }
  if (e.keeper.length > 0) {
    const label = text('autoLend.legRelend');
    const wantsAccess = e.keeper.some((c) => c.kind === 'access');
    const wantsActions = e.keeper.some((c) => c.kind === 'approve' || c.kind === 'actions');
    const actionsOk = !wantsActions || (logs.keeperActions !== null && (logs.keeperActions & AUTO_ROLL) !== 0);
    const accessOk = !wantsAccess || logs.access === true;
    if (actionsOk && accessOk) legs.push({ status: 'done', label });
    else legs.push({ status: 'not-done', label, reason: text('autoLend.legRelendMissing') });
  }
  return legs;
}
