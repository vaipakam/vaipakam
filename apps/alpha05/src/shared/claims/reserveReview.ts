/**
 * LN-62 — what withdrawing an unused extension reserve stands on, read in one
 * go through the wallet's connection, the receipt it is confirmed against,
 * and its outcome measured from the transaction's own record.
 *
 * `withdrawExtendReserve` takes the whole reserve the review read, from the
 * wallet's OWN vault to the wallet, so protected account mode queues it like
 * any withdrawal of the account's own (RB-PAYOUT-ROUTE). An extension that
 * draws on the reserve before the withdrawal confirms makes the amount too
 * large; the protocol then refuses it and nothing moves.
 */
import type { PublicClient } from 'viem';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal, Verdict } from '../eligibility/types';
import { moved } from '../offers/acceptOutcome';
import { payoutOutcomes, payoutRoute, readProtection, type PayoutRoute, type Protection } from '../protection/payout';
import { payoutLegs, routeChanged, routedDestination, routeNotes } from '../protection/payoutCopy';
import { frozenRefusal, frozenState, isFrozenRefusal, readSanctionsPosture, type FrozenState } from '../sanctions/posture';
import type { Receipt, ReceiptRow, ReceiptText } from '../receipt/types';
import { askThrough } from '../tx/simulate';
import type { LegOutcome } from '../tx/outcome';
import { readPaused } from './sellerClaim';
import { AUTO, readReserveRow, reserveDrawable, reserveLogs, reserveRowKey, reserveVerdict, type ReserveRow } from './reserve';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export interface ReserveReview {
  identity: string;
  loanId: bigint;
  row: ReserveRow;
  paused: boolean | null;
  protection: Protection | null;
  route: PayoutRoute;
  /** The wallet's standing with the sanctions screen at the review's block. */
  frozen: FrozenState;
  /** The protocol's dry run of withdrawing the whole reserve now: null when
   *  it passes, its refusal when it refuses, 'unread' when it could not be
   *  run. Asked only when the app's own rule is open. */
  dryRun: Refusal | null | 'unread';
  verdict: Verdict;
  readAt: number;
}

/** The call the review stands for: the wallet's own reserve on the loan,
 *  all of it. */
export function reserveCall(loanId: bigint, account: Hex, amount: bigint) {
  return { abi: AUTO, functionName: 'withdrawExtendReserve' as const, args: [account, loanId, amount] as const };
}

export async function readReserveReview(own: OwnStateClient, diamond: Hex, loanId: bigint, identity: string, copy: Pick<CopyAccess, 'text'>): Promise<ReserveReview> {
  const wallet = own.account;
  const facts = await own
    .read(async (c: PublicClient) => {
      // One block for everything the review states.
      const block = await c.getBlockNumber({ cacheTime: 0 });
      const [row, paused, protection, posture] = await Promise.all([
        readReserveRow(c, diamond, loanId, wallet, block),
        readPaused(c, diamond, block),
        readProtection(c, diamond, wallet, block),
        readSanctionsPosture(c, diamond, wallet, block),
      ]);
      return { row, paused, protection, frozen: frozenState(posture) };
    })
    .then((x) => x.value);
  const readAt = Date.now();
  const verdict = reserveVerdict(facts.row, facts.paused, copy, readAt, facts.frozen);
  let dryRun: ReserveReview['dryRun'] = null;
  if (verdict.state === 'open' && facts.row.funding) {
    const call = reserveCall(loanId, wallet, facts.row.funding.reserved);
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account: wallet }));
    dryRun = dry.kind === 'reverted' ? refusalFromError(dry.error) : dry.kind === 'unreadable' ? 'unread' : null;
  }
  return {
    identity,
    loanId,
    row: facts.row,
    paused: facts.paused,
    protection: facts.protection,
    // From the wallet's own vault to the wallet.
    route: payoutRoute(facts.protection, wallet, wallet),
    frozen: facts.frozen,
    dryRun,
    verdict,
    readAt,
  };
}

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function reserveChanged(a: ReserveReview, b: ReserveReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if (reserveRowKey(a.row) !== reserveRowKey(b.row)) return text('reserve.changed');
  if (a.paused !== b.paused) return text('repay.changedHolders');
  if (a.frozen !== b.frozen) return text('repay.changedVerdict');
  if (routeChanged(a, b)) return text('payout.changed');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('repay.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does). */
export function reserveBlockers(r: ReserveReview, copy: Copy): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  if (r.dryRun === 'unread') return [copy.text('reserve.dryRunUnread')];
  // A sanctions refusal is said in the frozen-proceeds words (RB-FROZEN).
  if (r.dryRun !== null && isFrozenRefusal(r.dryRun)) return [frozenRefusal(r.dryRun.code === 'SanctionsOracleUnavailable' ? 'outage' : 'flagged', copy).reason];
  if (r.dryRun !== null && r.dryRun.code === 'NotAccountManager') return [copy.text('reserve.notManager')];
  if (r.dryRun !== null) return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

/** Amounts in words, short and exact. */
export interface ReserveWords {
  amount: (asset: Hex, v: bigint, exact: boolean) => string;
}

export function reserveReceipt(r: ReserveReview, account: Hex, copy: Copy): Receipt {
  const { text, format } = copy;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const rows: ReceiptRow[] = [];
  const f = r.row.funding;
  rows.push({ label: text('reserve.rowReserved'), value: f === null ? unknown : { kind: 'amount', asset: f.asset, amount: f.reserved }, binding: true });
  const to = r.route === 'wallet' ? text('loanClaim.toWallet') : routedDestination(r.route, r.protection, copy);
  rows.push({ label: text('takeBack.rowTo'), value: to === null ? unknown : { kind: 'text', text: to }, binding: true });

  const consequences: ReceiptText[] = [];
  const drawable = reserveDrawable(r.row, account);
  if (drawable === true) consequences.push(text('reserve.afterDrawable'));
  else if (drawable === null) consequences.push(text('reserve.drawUnread'));
  consequences.push(...routeNotes(r.route, r.protection, copy), text('loanClaim.pauseHolds'));
  return { title: format('reserve.title', { id: r.loanId.toString() }), rows, consequences, prompts: 1, readAt: r.readAt };
}

/** RB-CONFIDENCE — the finish card: what left the reserve, measured where it
 *  landed (the wallet, or protected account mode's queue or vault). */
export function measureReserve(r: ReserveReview, logs: Parameters<typeof reserveLogs>[0], diamond: Hex, account: Hex, w: ReserveWords, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const withdrawn = reserveLogs(logs, diamond, r.loanId, account);
  if (withdrawn.length === 0) return [{ status: 'not-done', label: format('reserve.title', { id: r.loanId.toString() }), reason: text('reserve.notWithdrawn') }];
  const legs: LegOutcome[] = [];
  for (const wd of withdrawn) {
    const want = r.row.funding?.reserved ?? wd.amount;
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
    // Funded again after the review: what stays reserved is said, never hidden.
    if (wd.reserved > 0n) legs.push({ status: 'done', label: format('reserve.legLeft', { amount: w.amount(wd.asset, wd.reserved, false) }) });
  }
  return legs;
}
