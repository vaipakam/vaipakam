/**
 * LN-52 — what withdrawing a past seller's interest stands on, read in one go
 * through the wallet's connection, the receipt it is confirmed against, and
 * its outcome measured from the transaction's own record.
 *
 * `claimAsSeller` withdraws from the seller's OWN vault to their wallet, so
 * protected account mode queues it like any withdrawal of the account's own
 * (RB-PAYOUT-ROUTE). On an ended loan it first splits the lender's recovery
 * between the holder's principal and every open seller claim, which closes
 * them all; the receipt states the seller's part and what stays unpaid.
 */
import type { PublicClient } from 'viem';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal, Verdict } from '../eligibility/types';
import { moved } from '../offers/acceptOutcome';
import { payoutOutcomes, payoutRoute, readProtection, type PayoutRoute, type Protection } from '../protection/payout';
import { payoutLegs, routeChanged, routedDestination, routeNotes } from '../protection/payoutCopy';
import { figured, type Receipt, type ReceiptRow, type ReceiptText } from '../receipt/types';
import { askThrough } from '../tx/simulate';
import type { LegOutcome } from '../tx/outcome';
import {
  mineGross,
  netOwed,
  readPaused,
  readSellerRow,
  rowFeeBps,
  SELLER,
  sellerLogs,
  sellerRowKey,
  sellerVerdict,
  splitFinal,
  splitPart,
  type SellerRow,
  type SplitPart,
} from './sellerClaim';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export interface SellerClaimReview {
  identity: string;
  loanId: bigint;
  row: SellerRow;
  paused: boolean | null;
  protection: Protection | null;
  route: PayoutRoute;
  /** The seller's part of an ended loan's split (see `splitPart`). */
  part: SplitPart;
  /** The protocol's dry run of this withdrawal now: null when it passes,
   *  its refusal when it refuses, 'unread' when it could not be run. Asked
   *  only when the app's own rule is open. */
  dryRun: Refusal | null | 'unread';
  verdict: Verdict;
  readAt: number;
}

export async function readSellerClaimReview(own: OwnStateClient, diamond: Hex, loanId: bigint, identity: string, copy: Pick<CopyAccess, 'text'>): Promise<SellerClaimReview> {
  const seller = own.account;
  const facts = await own
    .read(async (c: PublicClient) => {
      const [row, paused, protection] = await Promise.all([readSellerRow(c, diamond, loanId, seller), readPaused(c, diamond), readProtection(c, diamond, seller)]);
      return { row, paused, protection };
    })
    .then((x) => x.value);
  const readAt = Date.now();
  const verdict = sellerVerdict(facts.row, seller, facts.paused, copy, readAt);
  let dryRun: SellerClaimReview['dryRun'] = null;
  if (verdict.state === 'open') {
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: SELLER, functionName: 'claimAsSeller', args: [loanId], account: seller }));
    dryRun = dry.kind === 'reverted' ? refusalFromError(dry.error) : dry.kind === 'unreadable' ? 'unread' : null;
  }
  return {
    identity,
    loanId,
    row: facts.row,
    paused: facts.paused,
    protection: facts.protection,
    // From the seller's own vault to the seller's wallet.
    route: payoutRoute(facts.protection, seller, seller),
    part: splitPart(facts.row, seller),
    dryRun,
    verdict,
    readAt,
  };
}

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function sellerClaimChanged(a: SellerClaimReview, b: SellerClaimReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (sellerRowKey(a.row) !== sellerRowKey(b.row)) return text('sellerClaim.changed');
  if (a.paused !== b.paused) return text('repay.changedHolders');
  if (routeChanged(a, b)) return text('payout.changed');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('repay.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does). */
export function sellerClaimBlockers(r: SellerClaimReview, copy: Copy): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  if (r.dryRun === 'unread') return [copy.text('sellerClaim.dryRunUnread')];
  if (r.dryRun !== null) return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

/** Amounts in words, short and exact. */
export interface SellerWords {
  amount: (asset: Hex, v: bigint, exact: boolean) => string;
}

/** What the withdrawal pays now, per asset: the vault's balance for the
 *  seller plus, on an ended loan in the principal asset, the split's part.
 *  Null when a figure is not known before it runs (an in-kind split, or an
 *  unread input). */
export function sellerPays(r: Pick<SellerClaimReview, 'row' | 'part'>): { asset: Hex; amount: bigint }[] | null {
  if (r.row.held === null || r.row.loan === null || r.part?.kind === 'unknown' || r.part?.kind === 'inKind') return null;
  const out = r.row.held.map((h) => ({ ...h }));
  if (r.part?.kind === 'exact' && r.part.amount > 0n) {
    const p = r.row.loan.principalAsset.toLowerCase();
    const at = out.find((h) => h.asset.toLowerCase() === p);
    if (at) at.amount += r.part.amount;
    else out.push({ asset: r.row.loan.principalAsset, amount: r.part.amount });
  }
  return out.filter((h) => h.amount > 0n);
}

export function sellerClaimReceipt(r: SellerClaimReview, account: Hex, w: SellerWords, copy: Copy): Receipt {
  const { text, format } = copy;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const rows: ReceiptRow[] = [];
  const loan = r.row.loan;
  const mine = mineGross(r.row, account);
  const fee = rowFeeBps(r.row);
  const final = loan !== null && splitFinal(Number(loan.status));
  if (loan && mine !== null && mine > 0n && fee) {
    rows.push({
      label: format('sellerClaim.rowOwed', { pct: (fee.bps / 100).toString() }),
      value: { kind: 'amount', asset: loan.principalAsset, amount: netOwed(mine, fee.bps) },
      binding: false,
    });
  }
  if (r.row.held === null) rows.push({ label: text('sellerClaim.rowHeld'), value: unknown, binding: true });
  else for (const h of r.row.held) if (h.amount > 0n) rows.push({ label: text('sellerClaim.rowHeld'), value: { kind: 'amount', asset: h.asset, amount: h.amount }, binding: true });
  if (r.part?.kind === 'exact') {
    rows.push({ label: text('sellerClaim.rowSplit'), value: { kind: 'amount', asset: loan!.principalAsset, amount: r.part.amount }, binding: true });
    if (r.part.unpaid > 0n) rows.push({ label: text('sellerClaim.rowUnpaid'), value: { kind: 'amount', asset: loan!.principalAsset, amount: r.part.unpaid }, binding: true });
  } else if (r.part?.kind === 'inKind') rows.push({ label: text('sellerClaim.rowSplit'), value: { kind: 'text', text: text('sellerClaim.splitInKind') }, binding: true });
  else if (r.part?.kind === 'unknown') rows.push({ label: text('sellerClaim.rowSplit'), value: unknown, binding: true });
  const to = r.route === 'wallet' ? text('loanClaim.toWallet') : routedDestination(r.route, r.protection, copy);
  rows.push({ label: text('takeBack.rowTo'), value: to === null ? unknown : { kind: 'text', text: to }, binding: true });

  const consequences: ReceiptText[] = [];
  if (final && mine !== null && mine > 0n) consequences.push(text('sellerClaim.splitNote'));
  if (!final && mine !== null && mine > 0n)
    consequences.push(figured((exact) => format('sellerClaim.restLater', { amount: w.amount(loan!.principalAsset, netOwed(mine, fee!.bps), exact) })));
  if (fee?.legacy) consequences.push(text('sellerClaim.legacyFee'));
  consequences.push(...routeNotes(r.route, r.protection, copy), text('loanClaim.pauseHolds'));
  return { title: format('sellerClaim.title', { id: r.loanId.toString() }), rows, consequences, prompts: 1, readAt: r.readAt };
}

/** RB-CONFIDENCE — the finish card: each claim the split closed for the
 *  seller (what it paid, against what the review said), and each asset the
 *  withdrawal moved, measured where it landed (the wallet, or protected
 *  account mode's queue or vault). */
export function measureSellerClaim(r: SellerClaimReview, logs: Parameters<typeof sellerLogs>[0], diamond: Hex, account: Hex, w: SellerWords, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const legs: LegOutcome[] = [];
  const { closed, withdrawn } = sellerLogs(logs, diamond, r.loanId, account);
  if (withdrawn.length === 0) return [{ status: 'not-done', label: format('sellerClaim.title', { id: r.loanId.toString() }), reason: text('sellerClaim.notWithdrawn') }];
  for (const c of closed) {
    const label = c.fullyPaid
      ? format('sellerClaim.legClosedPaid', { amount: w.amount(c.asset, c.credited, false) })
      : format('sellerClaim.legClosedShort', { amount: w.amount(c.asset, c.credited, false), owed: w.amount(r.row.loan?.principalAsset ?? c.asset, c.netOwed, false) });
    // In the principal asset the review stated the part exactly; a
    // different figure is said beside it.
    if (r.part?.kind === 'exact' && closed.length === 1 && c.paid !== r.part.amount)
      legs.push({
        status: 'unknown',
        label,
        reason: format('sellerClaim.splitOther', { amount: w.amount(c.asset, c.paid, true), expected: w.amount(c.asset, r.part.amount, true) }),
      });
    else legs.push({ status: 'done', label });
  }
  if (closed.length === 0 && r.part !== null && r.part.kind !== 'unknown')
    legs.push({ status: 'unknown', label: text('sellerClaim.legNoSplit'), reason: text('sellerClaim.noSplit') });
  const expected = sellerPays(r);
  for (const wd of withdrawn) {
    const want = expected?.find((e) => e.asset.toLowerCase() === wd.asset.toLowerCase())?.amount ?? wd.amount;
    const outcomes = payoutOutcomes(logs, diamond, account, wd.asset);
    const wallet = moved(logs, wd.asset, null, account);
    legs.push(
      ...payoutLegs(
        {
          outcomes,
          wallet,
          expected: want,
          protection: r.protection,
          what: (v) => w.amount(wd.asset, v, false),
          exact: (v) => w.amount(wd.asset, v, true),
          walletLeg: (what) => format('loanClaim.legArrived', { amount: what }),
          walletOther: (got, wantText) => format('loanClaim.arrivedOther', { amount: got, expected: wantText }),
        },
        copy,
      ),
    );
  }
  // A reviewed asset the withdrawal did not move at all is flagged.
  for (const e of expected ?? [])
    if (!withdrawn.some((wd) => wd.asset.toLowerCase() === e.asset.toLowerCase()))
      legs.push({ status: 'not-done', label: format('loanClaim.legArrived', { amount: w.amount(e.asset, e.amount, false) }), reason: text('sellerClaim.notWithdrawn') });
  return legs;
}
