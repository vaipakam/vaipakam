/**
 * #3761 — the "Borrow now" review as a receipt: every fill the call opens in
 * this block, each at its own source's rate, labelled as what this block
 * gives; the approval for exactly the wallet's part, naming the contract it
 * is given to; and the #3763 statement of what each loan is, in its
 * non-renewing variant (renewal is not built).
 */
import type { CopyAccess } from '../copy/useCopy';
import { figured, textValue, type Receipt, type ReceiptRow, type ReceiptText } from '../receipt/types';
import { assetName, exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { loanRiskKey } from '../risk/keyRisks';
import { formatBps } from '../ui/format';
import { lifFeeOf, lifRateText } from '../offers/initiationFee';
import { coverage, planOf, restOf, type BorrowNowReview } from './borrowNow';

type Hex = `0x${string}`;

/** Why the review cannot be signed as it reads, if it cannot. */
export function borrowNowBlocker(r: BorrowNowReview, meta: TokenMetaMap | null, copy: CopyAccess): string | null {
  const { text, format } = copy;
  const s = r.state;
  switch (s.kind) {
    case 'plan':
      return null;
    case 'market-off':
      return text('borrowNow.stateMarketOff');
    case 'no-source':
      return text('borrowNow.stateNoSource');
    case 'none-found':
      return text('borrowNow.stateNoneFound');
    case 'short-collateral':
      return format('borrowNow.stateShort', { have: tokenAmount(s.have, r.terms.collateral, meta, format), need: tokenAmount(s.need, r.terms.collateral, meta, format) });
    case 'needs-approval':
      return format('borrowNow.stateNeedsApproval', { amount: exactTokenAmount(r.walletPart, r.terms.collateral, meta, format) });
    case 'refused':
      return format('borrowNow.stateRefused', { reason: s.reason });
  }
}

/** The receipt; `diamond` is the contract the approval is given to. */
export function borrowNowReceipt(r: BorrowNowReview, diamond: Hex, meta: TokenMetaMap | null, copy: CopyAccess): Receipt {
  const { text, format } = copy;
  const t = r.terms;
  const lend = assetName(t.lending, meta);
  const coll = assetName(t.collateral, meta);
  const amt = (asset: Hex, v: bigint, exact: boolean) => (exact ? exactTokenAmount(v, asset, meta, format) : tokenAmount(v, asset, meta, format));
  const plan = planOf(r);

  const rows: ReceiptRow[] = [
    { label: text('borrowNow.rowWhat'), value: { kind: 'text', text: format('borrowNow.whatValue', { lend, coll }) }, binding: true },
    { label: text('borrowNow.rowAsked'), value: { kind: 'amount', asset: t.lending, amount: t.amount }, binding: false },
    plan === null
      ? { label: text('borrowNow.rowGives'), value: { kind: 'unknown', why: borrowNowBlocker(r, meta, copy) ?? text('flow.reading') }, binding: false }
      : { label: text('borrowNow.rowGives'), value: { kind: 'amount', asset: t.lending, amount: plan.total }, binding: false },
  ];
  if (plan !== null) {
    plan.fills.forEach((f, i) => {
      const line = figured((exact) =>
        format(f.source.kind === 0 ? 'borrowNow.loanSlot' : 'borrowNow.loanOffer', {
          amount: amt(t.lending, f.amount, exact),
          rate: formatBps(f.rateBps),
          id: f.source.offerId.toString(),
          collateral: amt(t.collateral, f.collateral, exact),
        }),
      );
      // What this block gives, per source: the call binds the least it
      // borrows and the highest rate, not these parts.
      rows.push({ label: format('borrowNow.rowLoan', { n: String(i + 1) }), value: textValue(line), binding: false });
    });
    rows.push({ label: text('borrowNow.rowLeast'), value: { kind: 'amount', asset: t.lending, amount: plan.total }, binding: true });
    rows.push({ label: text('borrowNow.rowMaxRate'), value: { kind: 'text', text: format('borrowNow.maxRateValue', { rate: formatBps(t.maxRateBps) }) }, binding: true });
    // The fee each loan's own amount pays, at the list rate for the term
    // (rounded down per loan, as charged); a discount can only lower it.
    if (r.lif === null) {
      rows.push({ label: text('borrowNow.rowFee'), value: { kind: 'unknown', why: text('borrowNow.feeUnknown') }, binding: false });
      rows.push({ label: text('borrowNow.rowNet'), value: { kind: 'unknown', why: text('borrowNow.netUnknown') }, binding: false });
    } else {
      const lif = r.lif;
      const fee = plan.fills.reduce((sum, f) => sum + lifFeeOf(f.amount, lif, t.termDays), 0n);
      rows.push({
        label: text('borrowNow.rowFee'),
        value: textValue(
          figured((exact) => format('borrowNow.feeValue', { amount: amt(t.lending, fee, exact), rate: lifRateText(lif, t.termDays), days: String(t.termDays) })),
        ),
        binding: false,
      });
      rows.push({ label: text('borrowNow.rowNet'), value: { kind: 'amount', asset: t.lending, amount: plan.total - fee }, binding: false });
    }
    // What this block's fills lock; more may be ready when it confirms, and
    // the call can then lock up to all the collateral offered.
    rows.push({ label: text('borrowNow.rowLocked'), value: { kind: 'amount', asset: t.collateral, amount: plan.collateralLocked }, binding: false });
    rows.push({ label: text('borrowNow.rowLockedMost'), value: { kind: 'amount', asset: t.collateral, amount: t.collateralOffered }, binding: true });
    if (coverage(plan, t.amount) === 'part') {
      const rest = restOf(t, plan);
      rows.push({
        label: text('borrowNow.rowRest'),
        value: textValue(figured((exact) => format('borrowNow.restValue', { amount: amt(t.lending, rest.amount, exact) }))),
        binding: false,
      });
    }
  }
  // The split between vault and wallet is worked out again when the call
  // runs: if the vault's free collateral drops before then, more comes from
  // the wallet, up to what the approval allows. So the planned wallet part
  // is an estimate, and the binding figure is that ceiling.
  const allowanceAfter = r.approvalNeeded ? r.walletPart : r.allowance;
  const walletMost = allowanceAfter < t.collateralOffered ? allowanceAfter : t.collateralOffered;
  if (r.walletPart > 0n) rows.push({ label: text('borrowNow.rowFromWallet'), value: { kind: 'amount', asset: t.collateral, amount: r.walletPart }, binding: false });
  if (walletMost > 0n) rows.push({ label: text('borrowNow.rowWalletMost'), value: { kind: 'amount', asset: t.collateral, amount: walletMost }, binding: true, movesOut: true });
  rows.push(
    r.approvalSteps > 0
      ? {
          label: text('borrowNow.rowApproval'),
          value: textValue(figured((exact) => format('borrowNow.approvalValue', { amount: amt(t.collateral, r.walletPart, exact), spender: diamond }))),
          binding: true,
          movesOut: true,
        }
      : { label: text('borrowNow.rowApproval'), value: { kind: 'text', text: text('borrowNow.approvalNone') }, binding: false },
  );
  rows.push(
    { label: text('borrowNow.rowTerm'), value: { kind: 'text', text: format('borrowNow.termValue', { days: String(t.termDays) }) }, binding: true },
    { label: text('borrowNow.rowInterest'), value: { kind: 'text', text: text('borrowNow.interestValue') }, binding: true },
    { label: text('borrowNow.rowPartial'), value: { kind: 'text', text: text(t.allowsPartialRepay ? 'borrowNow.partialYes' : 'borrowNow.partialNo') }, binding: true },
  );

  const consequences: ReceiptText[] = [
    text('borrowNow.loseBlock'),
    text('borrowNow.loseMore'),
    ...(r.searchComplete ? [] : [text('borrowNow.loseSearchBounded')]),
    text('borrowNow.loseFee'),
    text('borrowNow.loseCollateral'),
  ];
  const sections = [{ title: text('borrowNow.statementTitle'), body: [format('borrowNow.statement', { days: String(t.termDays) }), text('borrowNow.statementEach')] }];
  return {
    title: text('borrowNow.title'),
    rows,
    consequences,
    ifWrong: text(loanRiskKey('borrower', 'unknown')),
    sections,
    prompts: r.approvalSteps + 1,
    readAt: r.readAt,
  };
}
