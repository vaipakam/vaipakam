/**
 * Batch actions on offer-grouped loans (#126) — the pure half.
 *
 * Loans group by the offer they came from. A group is the connected
 * wallet's OWN positions on one side only: one offer can fill into loans
 * with different counterparties, and the contract checks the position
 * holder per call anyway, so offering another wallet's loan would only
 * produce a refusal. The borrower's groups carry the close-outs, the
 * lender's the sale listing (`batchSale.ts`).
 *
 * Each loan is planned through the shared close-out plan
 * (`closeOutPlan.ts`), and the calls go to the Diamond's multicall with
 * `allowFailure` set, so a loan that fails is skipped while the others
 * close. Outcomes are read back from the chain, never assumed from the
 * receipt.
 */
import type { Log, PublicClient } from 'viem';
import { AssetType } from '../lib/types';
import { captureTxError } from '../lib/errors';
import { TxNotSettledError } from '../contracts/ownReceipt';
import { readAllowanceNotBefore } from '../contracts/erc20';
import type { CloseOutPlan, CloseOutPull } from './closeOutPlan';

/** The fields grouping reads from a Positions row. */
export interface GroupableLoan {
  loanId: number;
  offerId: number;
  role: 'lender' | 'borrower';
  status: string;
  assetType: number;
  lendingAsset: string;
}

export interface OfferGroup<T extends GroupableLoan> {
  offerId: number;
  /** Whose side of the offer's loans the wallet holds. */
  role: 'lender' | 'borrower';
  loans: T[];
}

/** A group's identity on the page: one offer's loans can be grouped once
 *  per side, so the offer id alone does not name a card. */
export function groupKey(g: { role: 'lender' | 'borrower'; offerId: number }): string {
  return `${g.role}:${g.offerId}`;
}

/** The wallet's live ERC-20 loans on one side, grouped by originating
 *  offer, for every offer that filled into two or more of them. Ordered by
 *  offer id, loans by loan id, so the card does not reshuffle on refetch. */
function offerGroups<T extends GroupableLoan>(
  rows: readonly T[],
  role: 'lender' | 'borrower',
): OfferGroup<T>[] {
  const byOffer = new Map<number, T[]>();
  for (const r of rows) {
    if (r.role !== role || r.status !== 'active') continue;
    if (r.assetType !== AssetType.ERC20 || r.offerId <= 0) continue;
    const list = byOffer.get(r.offerId) ?? [];
    // The same loan can arrive twice (chain and indexer legs); keep one.
    if (!list.some((l) => l.loanId === r.loanId)) list.push(r);
    byOffer.set(r.offerId, list);
  }
  return [...byOffer.entries()]
    .filter(([, loans]) => loans.length >= 2)
    .sort(([a], [b]) => a - b)
    .map(([offerId, loans]) => ({
      offerId,
      role,
      loans: [...loans].sort((a, b) => a.loanId - b.loanId),
    }));
}

/** The borrower's groups: the loans "Repay all" and "Close all early"
 *  act on. */
export function borrowerOfferGroups<T extends GroupableLoan>(rows: readonly T[]): OfferGroup<T>[] {
  return offerGroups(rows, 'borrower');
}

/** The lender's groups: the positions "List all for sale" acts on. One
 *  lender offer can fill into loans with different borrowers; the lender
 *  side of each is this wallet's only while it holds that position, which
 *  is what a lender row means. */
export function lenderOfferGroups<T extends GroupableLoan>(rows: readonly T[]): OfferGroup<T>[] {
  return offerGroups(rows, 'lender');
}

/**
 * The groups to render: the live ones, plus every group whose card is
 * mid-batch or showing results. A batch can leave its offer with fewer
 * than two open loans (closes), or take its loans off the live list some
 * other way, which drops the group from the live list; without this the
 * card would unmount and take the outcomes with it. A held group renders
 * as it was when its batch started, until it is dismissed. Keyed by
 * `groupKey`.
 */
export function withHeldGroups<T extends GroupableLoan>(
  live: readonly OfferGroup<T>[],
  held: ReadonlyMap<string, OfferGroup<T>>,
): OfferGroup<T>[] {
  const byKey = new Map(live.map((g) => [groupKey(g), g]));
  for (const [key, g] of held) byKey.set(key, g);
  return [...byKey.values()].sort(
    (a, b) => a.offerId - b.offerId || a.role.localeCompare(b.role),
  );
}

/** What the ready loans will take, summed per token. */
export function pullTotals(plans: readonly CloseOutPlan[]): CloseOutPull[] {
  const byToken = new Map<string, CloseOutPull>();
  for (const p of plans) {
    if (p.kind !== 'ready' || !p.pull) continue;
    const key = p.pull.token.toLowerCase();
    const prev = byToken.get(key);
    byToken.set(
      key,
      prev
        ? { token: prev.token, due: prev.due + p.pull.due, approve: prev.approve + p.pull.approve }
        : { ...p.pull },
    );
  }
  return [...byToken.values()];
}

/** A loan's outcome, decided by reading it back after the batch.
 *  `closed` is Repaid, the status both calls leave; any other status a
 *  loan left Active for (a default, a liquidation) is `changed`, never
 *  reported as this batch's close. */
export type BatchOutcome =
  | { loanId: number; kind: 'closed' }
  | { loanId: number; kind: 'changed' }
  /** Sent, and neither confirmed nor refused yet: it may still close. */
  | { loanId: number; kind: 'pending' }
  | { loanId: number; kind: 'open'; reason: string }
  | { loanId: number; kind: 'left-out'; reason: string }
  | { loanId: number; kind: 'unknown' };

/** How one multicall send ended, as far as the chain can say. A mined
 *  send carries its receipt's logs: the items that ran emitted them, and
 *  an item that reverted had its logs rolled back with it. */
export type Mined =
  | { block: bigint; logs: readonly Log[] }
  | { failure: string }
  | { pending: true };

/**
 * What a send that did not come back with a receipt actually did. Never
 * signed: a failure. Settled as not run (`TxNotSettledError`: reverted,
 * or cancelled or replaced in the wallet, which the receipt wait has
 * already established): a failure. Otherwise the write can throw while
 * its transaction is still on its way (a receipt wait that timed out),
 * so the submitted hash is looked up. Mined and successful: read back at
 * its block, as if the write had returned. Mined and reverted: a failure. Not found (still
 * pending, or replaced under another hash): pending, never a failure —
 * reading its loans as open and unwinding the approval would misreport a
 * batch that may still close them.
 */
export async function settleFailedSend(
  publicClient: PublicClient,
  submitted: `0x${string}` | null,
  err: unknown,
): Promise<Mined> {
  const failure = captureTxError(err);
  if (!submitted || err instanceof TxNotSettledError) return { failure };
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: submitted });
    return receipt.status === 'success'
      ? { block: receipt.blockNumber, logs: receipt.logs }
      : { failure };
  } catch {
    return { pending: true };
  }
}

/**
 * The allowance left standing after a batch, per token, read live from a
 * node that has reached `notBefore`, the last block the batch wrote in.
 * Null when any token could not be read from that far: a figure from
 * before the batch's own writes would be stated as current.
 */
export async function readApprovalsLeft(
  ctx: { publicClient: PublicClient; diamond: `0x${string}`; holder: `0x${string}` },
  tokens: readonly `0x${string}`[],
  notBefore: bigint,
): Promise<bigint[] | null> {
  const left = await Promise.all(
    tokens.map((token) =>
      readAllowanceNotBefore(ctx.publicClient, token, ctx.holder, ctx.diamond, notBefore),
    ),
  );
  const read = left.filter((v): v is bigint => v !== null);
  return read.length === left.length ? read : null;
}
