/**
 * #3624 part 2 — the review of one Auto-lend management step (add money,
 * take back money not lent, stop): what it stands on, read at one block
 * through the wallet's connection, the protocol's own verdict as a dry run
 * from this wallet, and the receipt stating every figure it binds and every
 * consequence, including what is not known.
 */
import type { CopyKey } from '../copy/useCopy';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { judgeDryRun, type CreateVerdict } from '../post/postReview';
import { tokenAcceptsApproval } from '../offers/reads';
import { payoutRoute, type PayoutRoute } from '../protection/payout';
import { routeChanged, routedDestination, routeNotes } from '../protection/payoutCopy';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { Receipt, ReceiptRow, ReceiptText } from '../receipt/types';
import { allowanceSteps } from '../tx/approval';
import { askThrough } from '../tx/simulate';
import { manageBlocks, manageCall, readManageFacts, type ManageBlock, type ManageDraft, type ManageFacts } from './manage';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export interface ManageReview {
  draft: ManageDraft;
  /** The wallet and network the review was read under (`reviewIdentity`). */
  identity: string;
  readAt: number;
  facts: ManageFacts;
  blocks: ManageBlock[];
  /** Wallet prompts the approval needs before adding (0 otherwise). */
  approvalSteps: number;
  /** Where money taken back goes; null when nothing is taken back. */
  route: PayoutRoute | null;
  verdict: CreateVerdict;
}

export async function readManageReview(own: OwnStateClient, diamond: Hex, draft: ManageDraft, identity: string): Promise<ManageReview> {
  const account = own.account;
  const facts = (await own.read((c) => readManageFacts(c, diamond, account, draft.lending, draft.collateral))).value;
  const approvalSteps =
    draft.kind !== 'add' || facts.allowance >= draft.amount
      ? 0
      : (
          await allowanceSteps(
            { accepts: (amount) => own.read((c) => tokenAcceptsApproval(c, draft.lending, account, diamond, amount)).then((x) => x.value) },
            facts.allowance,
            draft.amount,
          )
        ).length;
  const blocks = manageBlocks(draft, facts);
  // The money comes from the wallet's own vault to the wallet.
  const route = draft.kind !== 'add' && draft.amount > 0n ? payoutRoute(facts.protection, account, account) : null;
  let verdict: CreateVerdict;
  if (approvalSteps > 0) {
    // Adding pulls from the wallet, which the protocol refuses until the
    // approval is in place: the dry run waits for it, and the flow runs it
    // again with the approval in place before the write.
    verdict = { kind: 'needs-approval' };
  } else {
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...manageCall(draft, account), account }));
    verdict = judgeDryRun(dry, true);
  }
  return { draft, identity, readAt: Date.now(), facts, blocks, approvalSteps, route, verdict };
}

/** What moved between a review and a re-read of it, as a key: a change in
 *  any figure the receipt states or the verdict stands on, and in any of the
 *  instruction's terms. */
export function manageKey(r: ManageReview): string {
  const f = r.facts;
  return [
    r.verdict.kind,
    r.verdict.kind === 'refused' ? r.verdict.code : '',
    r.approvalSteps,
    r.route ?? '',
    r.blocks.map((b) => b.kind).join(','),
    f.unlent,
    f.lent,
    // The whole instruction, so any change to its terms (a re-set of the
    // limits, the cap a receipt states, the end date) asks for a new review.
    ...Object.entries(f.intent)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${String(v)}`),
  ].join('|');
}

/** Whether the payout's route moved between two reads (the route, or a
 *  queued payout's delay, signer or wallet). */
export function manageRouteChanged(a: ManageReview, b: ManageReview): boolean {
  if (a.route === null || b.route === null) return a.route !== b.route;
  return routeChanged({ route: a.route, protection: a.facts.protection }, { route: b.route, protection: b.facts.protection });
}

const BLOCK_KEY: Record<Exclude<ManageBlock['kind'], 'balance' | 'aboveUnlent'>, CopyKey> = {
  stopped: 'autoLend.mBlockStopped',
  ended: 'autoLend.mBlockEnded',
  zero: 'autoLend.mBlockZero',
  assetPaused: 'autoLend.mBlockAssetPaused',
  protocolPaused: 'autoLend.mBlockPaused',
  unread: 'autoLend.mBlockUnread',
};

/** Every reason the step cannot be signed now, in the order a reader acts
 *  on them; empty when the review's verdict allows it. */
export function manageBlockers(r: ManageReview, meta: TokenMetaMap | null, copy: Copy): string[] {
  const { text, format } = copy;
  const amt = (v: bigint) => tokenAmount(v, r.draft.lending, meta, format);
  const out = r.blocks.map((b) => {
    if (b.kind === 'balance') return format('autoLend.blockBalance', { have: amt(b.balance), need: amt(r.draft.amount) });
    if (b.kind === 'aboveUnlent') return format('autoLend.mBlockAboveUnlent', { unlent: amt(b.unlent) });
    if (b.kind === 'protocolPaused' && r.draft.kind === 'stop') return text('autoLend.mBlockPausedStop');
    return text(BLOCK_KEY[b.kind]);
  });
  if (out.length === 0 && r.verdict.kind === 'refused') out.push(format('autoLend.blockRefused', { reason: r.verdict.reason }));
  if (out.length === 0 && r.verdict.kind === 'unreadable') out.push(format('flow.unreadable', { reason: r.verdict.reason }));
  return out;
}

const TITLE: Record<ManageDraft['kind'], CopyKey> = { add: 'autoLend.mTitleAdd', takeBack: 'autoLend.mTitleTakeBack', stop: 'autoLend.mTitleStop' };

/** The receipt: every figure the step binds, and what it means. */
export function manageReceipt(r: ManageReview, meta: TokenMetaMap | null, copy: Copy): Receipt {
  const { text, format } = copy;
  const d = r.draft;
  const f = r.facts;
  const amount = (v: bigint): ReceiptRow['value'] => ({ kind: 'amount', asset: d.lending, amount: v });
  const pair = format('autoLend.whatValue', { lend: assetName(d.lending, meta), coll: assetName(d.collateral, meta) });
  const rows: ReceiptRow[] = [{ label: text('autoLend.rowWhat'), value: { kind: 'text', text: pair }, binding: true }];
  const consequences: ReceiptText[] = [];

  if (d.kind === 'add') {
    rows.push({ label: text('autoLend.rowFund'), value: amount(d.amount), binding: true, movesOut: true });
    rows.push({ label: text('autoLend.mRowUnlentAfter'), value: amount(f.unlent + d.amount), binding: false });
    if (r.approvalSteps > 0) rows.push({ label: text('autoLend.rowApproval'), value: amount(d.amount), binding: true, movesOut: true });
    consequences.push(text('autoLend.loseVault'));
    // Money above the most at once waits until loans end.
    if (f.lent + f.unlent + d.amount > f.intent.maxExposure)
      consequences.push(format('autoLend.mLoseAboveCap', { cap: tokenAmount(f.intent.maxExposure, d.lending, meta, format) }));
    consequences.push(text('autoLend.mLoseAddNoFill'));
  } else {
    if (d.kind === 'stop') {
      rows.push({ label: text('autoLend.mRowStop'), value: { kind: 'text', text: text('autoLend.mStopValue') }, binding: true });
      consequences.push(text('autoLend.mLoseStopLoans'));
    }
    if (d.amount > 0n) {
      // The wallet route is the only one paid at once; an unread mode stays
      // unknown, never "your wallet, at once".
      const where = r.route === 'wallet' ? text('autoLend.mToWallet') : r.route === null ? null : routedDestination(r.route, f.protection, copy);
      rows.push({ label: text('autoLend.mRowTakeBack'), value: amount(d.amount), binding: true });
      rows.push({
        label: text('autoLend.mRowTo'),
        value: where === null ? { kind: 'unknown', why: text('receipt.unknown') } : { kind: 'text', text: where },
        binding: true,
      });
      rows.push({ label: text('autoLend.mRowUnlentAfter'), value: amount(f.unlent - (d.amount > f.unlent ? f.unlent : d.amount)), binding: false });
      if (r.route !== null) consequences.push(...routeNotes(r.route, f.protection, copy));
    } else if (d.kind === 'stop' && f.unlent > 0n) {
      consequences.push(format('autoLend.mLoseStopKeeps', { amount: tokenAmount(f.unlent, d.lending, meta, format) }));
    }
    if (f.lent > 0n) consequences.push(format('autoLend.mLoseLent', { amount: tokenAmount(f.lent, d.lending, meta, format) }));
  }
  return { title: text(TITLE[d.kind]), rows, consequences, prompts: r.approvalSteps + 1, readAt: r.readAt };
}
