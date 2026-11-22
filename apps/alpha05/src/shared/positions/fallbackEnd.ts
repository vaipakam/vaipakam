/**
 * #3865 — the dated end of a loan left in the fallback state.
 *
 * Every entry into fallback records when it began and the wait in force
 * then. Once that date has passed, anyone may finish the loan in kind
 * (`FallbackCustodyFacet.finishFallbackInKind`): the split recorded at entry
 * is applied as it stands, the loan becomes Defaulted, and each side's part
 * waits for its own claim. Nothing is sold or priced, and the caller and no
 * wallet is paid.
 *
 * The date is the protocol's, read from `getFallbackEnd`, never worked out
 * here: it is counted on the loan clock, so it moves later by any time the
 * platform spends paused, and past a network outage window it falls in. The
 * page therefore states it as "as it stands now", with what moves it.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { FallbackCustodyFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import type { Receipt, ReceiptRow } from '../receipt/types';
import { askThrough } from '../tx/simulate';
import type { LegOutcome } from '../tx/outcome';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export const FALLBACK_CUSTODY = FallbackCustodyFacetABI as Abi;

/** `getFallbackEnd(loanId)`, as the protocol reports it now. All zero when
 *  the loan has no dated end (not in fallback under a live snapshot, or no
 *  entry recorded). */
export interface FallbackEnd {
  enteredAt: bigint;
  waitSeconds: bigint;
  endAt: bigint;
  /** The protocol's own answer: the date has passed, the platform is not
   *  paused and the custody can be finished. It does not foresee a revert
   *  inside a step the finish calls; the dry run does. */
  finishable: boolean;
}

export async function readFallbackEnd(c: PublicClient, diamond: Hex, loanId: bigint, blockNumber?: bigint): Promise<FallbackEnd> {
  const [enteredAt, waitSeconds, endAt, finishable] = (await c.readContract({
    address: diamond,
    abi: FALLBACK_CUSTODY,
    functionName: 'getFallbackEnd',
    args: [loanId],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  })) as readonly [bigint, bigint, bigint, boolean];
  return { enteredAt, waitSeconds, endAt, finishable };
}

/** What the page can say of the dated end now. */
export type FallbackEndState =
  /** No dated end is recorded: nothing to count down or finish. */
  | { kind: 'none' }
  /** The date has not passed. */
  | { kind: 'waiting'; end: FallbackEnd }
  /** The date has passed and the protocol says it can be finished now. */
  | { kind: 'finishable'; end: FallbackEnd }
  /** The date has passed but the protocol says it cannot be finished now
   *  (the platform is paused, or the custody is of a kind it refuses). */
  | { kind: 'held'; end: FallbackEnd };

export function fallbackEndState(end: FallbackEnd, nowSec: number): FallbackEndState {
  if (end.endAt === 0n) return { kind: 'none' };
  if (end.finishable) return { kind: 'finishable', end };
  if (BigInt(nowSec) < end.endAt) return { kind: 'waiting', end };
  return { kind: 'held', end };
}

/** What finishing stands on: the dated end at one block, and the protocol's
 *  dry run of the finish. */
export interface FinishReview {
  identity: string;
  loanId: bigint;
  end: FallbackEnd;
  /** null when the dry run passes, its refusal when it refuses, 'unread'
   *  when it could not be run. */
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

export function finishCall(loanId: bigint) {
  return { abi: FALLBACK_CUSTODY, functionName: 'finishFallbackInKind' as const, args: [loanId] as const };
}

export async function readFinishReview(own: OwnStateClient, diamond: Hex, loanId: bigint, identity: string): Promise<FinishReview> {
  const end = await own
    .read(async (c: PublicClient) => readFallbackEnd(c, diamond, loanId, await c.getBlockNumber({ cacheTime: 0 })))
    .then((x) => x.value);
  let dryRun: FinishReview['dryRun'] = null;
  if (end.finishable) {
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...finishCall(loanId), account: own.account }));
    dryRun = dry.kind === 'reverted' ? refusalFromError(dry.error) : dry.kind === 'unreadable' ? 'unread' : null;
  }
  return { identity, loanId, end, dryRun, readAt: Date.now() };
}

/** What a re-read found changed, in words, or null. The date itself may move
 *  later while paused; only whether it can be finished matters here. */
export function finishChanged(a: FinishReview, b: FinishReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (a.end.finishable !== b.end.finishable || a.end.enteredAt !== b.end.enteredAt) return copy.text('fallbackEnd.changed');
  return null;
}

/** What stops the finish here, in words (empty when nothing does). */
export function finishBlockers(r: FinishReview, copy: Copy): string[] {
  if (!r.end.finishable) return [copy.text(r.end.endAt === 0n ? 'fallbackEnd.noneNow' : 'fallbackEnd.notFinishableNow')];
  if (r.dryRun === 'unread') return [copy.text('fallbackEnd.dryRunUnread')];
  if (r.dryRun !== null) return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

export function finishReceipt(r: FinishReview, copy: Copy): Receipt {
  const { text, format } = copy;
  const rows: ReceiptRow[] = [];
  if (r.end.endAt > 0n) rows.push({ label: text('fallbackEnd.rowEnd'), value: { kind: 'time', unixSeconds: Number(r.end.endAt) }, binding: false });
  rows.push({ label: text('fallbackEnd.rowYouGet'), value: { kind: 'text', text: text('fallbackEnd.youGetNothing') }, binding: true });
  return {
    title: format('fallbackEnd.title', { id: r.loanId.toString() }),
    rows,
    consequences: [text('fallbackEnd.applySplit'), text('fallbackEnd.defaulted'), text('fallbackEnd.eachClaims'), text('loanClaim.pauseHolds')],
    prompts: 1,
    readAt: r.readAt,
  };
}

/** The finish's record, from the Diamond's own logs. */
export interface FinishedInKind {
  lenderPart: bigint;
  treasuryPart: bigint;
  borrowerPart: bigint;
  caller: Hex;
}

export function finishedInKind(logs: readonly Log[], diamond: Hex, loanId: bigint): FinishedInKind | null {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: FALLBACK_CUSTODY, logs: [...own], eventName: 'FallbackFinishedInKind', strict: false }) as unknown as {
    args: Record<string, unknown>;
  }[];
  const hit = events.find((e) => BigInt(e.args.loanId as bigint) === loanId);
  if (!hit) return null;
  return {
    lenderPart: BigInt(hit.args.lenderPart as bigint),
    treasuryPart: BigInt(hit.args.treasuryPart as bigint),
    borrowerPart: BigInt(hit.args.borrowerPart as bigint),
    caller: hit.args.caller as Hex,
  };
}

/** RB-CONFIDENCE — the finish card: whether the loan was finished, and the
 *  split the protocol recorded, in the collateral asset. */
export function measureFinish(r: FinishReview, logs: readonly Log[], diamond: Hex, amount: (v: bigint) => string, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const done = finishedInKind(logs, diamond, r.loanId);
  const label = format('fallbackEnd.legFinished', { id: r.loanId.toString() });
  if (done === null) return [{ status: 'not-done', label, reason: text('fallbackEnd.notFinished') }];
  return [
    { status: 'done', label },
    { status: 'done', label: format('fallbackEnd.legLender', { amount: amount(done.lenderPart) }) },
    { status: 'done', label: format('fallbackEnd.legBorrower', { amount: amount(done.borrowerPart) }) },
    { status: 'done', label: format('fallbackEnd.legTreasury', { amount: amount(done.treasuryPart) }) },
  ];
}
