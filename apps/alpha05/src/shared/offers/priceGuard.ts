/**
 * #3358 — the maker's price-move guard on an offer
 * (`OfferPriceGuardFacet`). An offer waits on the book while the market
 * moves, and a taker can fill it the moment the price has moved in the
 * taker's favour. The guard lets the creator bound that: a guarded offer
 * refuses a fill when the collateral-to-principal rate has moved more than
 * the creator's limit since the guard was recorded, when the pair is not
 * calm against the last two hourly price checks, or when a price or a check
 * is missing. It only ever refuses a fill; it moves nothing and changes no
 * term of a loan.
 *
 * This module is the creator's change on an offer already posted:
 * `setOfferPriceGuard(offerId, bps)`, recorded from the prices when it
 * lands. A non-zero limit sets or changes it (re-recording the prices);
 * 0 clears it. The protocol's rule, stated before anything is signed:
 * - only the creator, only while the offer is open, never during a pause;
 * - only an offer of an ERC-20 against ERC-20 collateral whose prices can
 *   both be read now (`OfferPriceGuardUnpriced` otherwise);
 * - the limit is between 0.5% and 50%;
 * - between the post and this change the offer was not guarded.
 *
 * Every fill reads it at loan creation, so a direct take and a match are
 * both covered; the previews report a refusal as `PriceGuardRefused`.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, OfferPriceGuardFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { ASSET_ERC20 } from '../positions/model';
import { answerOrNull, isContractAnswer } from '../reads/answer';
import type { Receipt } from '../receipt/types';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatUtc } from '../ui/format';
import { readOfferDetail } from './offerDetail';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export const PRICE_GUARD = OfferPriceGuardFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;

/** `LibVaipakam.OFFER_PRICE_GUARD_BPS_MIN` / `_MAX`. */
export const GUARD_BPS_MIN = 50;
export const GUARD_BPS_MAX = 5_000;

/** `LibOfferPriceGuard.Status`, in its order. */
export const GUARD_STATUS = ['off', 'no-offer', 'clear', 'moved', 'no-checkpoint', 'not-calm', 'unpriced'] as const;
export type GuardStatus = (typeof GUARD_STATUS)[number] | 'unknown';

/** An offer's guard and where it stands now, as `getOfferPriceGuard`
 *  reports it. */
export interface PriceGuard {
  /** The creator's limit in bps; 0 = no guard. */
  maxMoveBps: number;
  /** When it was recorded (unix seconds; 0 = never). */
  setAt: number;
  status: GuardStatus;
  /** How far the rate has moved since, in bps (0 when it cannot be measured). */
  moveBps: number;
  /** The calm bound against the hourly checks, in bps. */
  calmMoveBps: number;
}

/** The guard of `offerId`: 'absent' when this network's protocol has no
 *  guard yet, null when it could not be read. */
export async function readPriceGuard(c: PublicClient, diamond: Hex, offerId: bigint, blockNumber?: bigint): Promise<PriceGuard | 'absent' | null> {
  try {
    const v = (await c.readContract({
      address: diamond,
      abi: PRICE_GUARD,
      functionName: 'getOfferPriceGuard',
      args: [offerId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    })) as { maxMoveBps: number | bigint; setAt: number | bigint; status: number | bigint; moveBps: bigint; calmMoveBps: number | bigint };
    return {
      maxMoveBps: Number(v.maxMoveBps),
      setAt: Number(v.setAt),
      status: GUARD_STATUS[Number(v.status)] ?? 'unknown',
      moveBps: Number(v.moveBps),
      calmMoveBps: Number(v.calmMoveBps),
    };
  } catch (e) {
    // A failed source is thrown, so the own rail tries the next one.
    if (!isContractAnswer(e)) throw e;
    return refusalFromError(e).code === 'FunctionDoesNotExist' ? 'absent' : null;
  }
}

/** Whether a fill is refused now by the guard. */
export function guardRefuses(g: PriceGuard): boolean {
  return g.maxMoveBps > 0 && g.status !== 'clear' && g.status !== 'off';
}

/** A limit in bps, in words: "5%", "2.5%". */
export function bpsPercent(bps: number): string {
  const whole = bps / 100;
  return `${Number.isInteger(whole) ? whole.toString() : whole.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** A percent the reader typed, in bps; null when it is not a number with at
 *  most two decimals. */
export function parsePercent(input: string): number | null {
  const s = input.trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

/** Where the guard stands, in words, for the offer page. */
export function guardStatusLine(g: PriceGuard, copy: Copy): string {
  const { text, format } = copy;
  const move = bpsPercent(g.moveBps);
  const limit = bpsPercent(g.maxMoveBps);
  switch (g.status) {
    case 'clear':
      return format('priceGuard.statusClear', { move, limit });
    case 'moved':
      return format('priceGuard.statusMoved', { move, limit });
    case 'no-checkpoint':
      return text('priceGuard.statusNoCheckpoint');
    case 'not-calm':
      return format('priceGuard.statusNotCalm', { calm: bpsPercent(g.calmMoveBps) });
    case 'unpriced':
      return text('priceGuard.statusUnpriced');
    default:
      return text('priceGuard.statusUnknown');
  }
}

/** The facts a guard change is reviewed against, at one block. */
export interface GuardFacts {
  offerId: bigint;
  creator: Hex | null;
  /** Whether the offer is open now; null when unread or never posted. */
  open: boolean | null;
  /** Both legs ERC-20 (the only offers a guard can be put on). */
  erc20Pair: boolean | null;
  guard: PriceGuard | 'absent' | null;
  paused: boolean | null;
  chainNow: number | null;
  readAt: number;
}

export async function readGuardFacts(c: PublicClient, diamond: Hex, offerId: bigint): Promise<GuardFacts> {
  const d = await readOfferDetail(c, diamond, offerId);
  const [guard, paused, block] = await Promise.all([
    readPriceGuard(c, diamond, offerId, d.block),
    answerOrNull(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused', blockNumber: d.block }) as Promise<boolean>),
    c.getBlock({ blockNumber: d.block }),
  ]);
  const offer = d.kind === 'offer' ? d.offer : null;
  return {
    offerId,
    creator: offer?.creator ?? null,
    open: d.kind === 'offer' ? d.state === 'open' : null,
    erc20Pair: offer === null ? null : offer.assetType === ASSET_ERC20 && offer.collateralAssetType === ASSET_ERC20,
    guard,
    paused,
    chainNow: Number(block.timestamp),
    readAt: Date.now(),
  };
}

/** One guard change: a limit in bps to set or change it, 0 to clear it. */
export interface GuardReview {
  identity: string;
  account: Hex;
  bps: number;
  facts: GuardFacts;
  /** The protocol's dry run: null = it would land; 'unread' = not asked. */
  dryRun: Refusal | 'unread' | null;
  readAt: number;
}

export function guardCall(offerId: bigint, bps: number) {
  return { abi: PRICE_GUARD, functionName: 'setOfferPriceGuard', args: [offerId, bps] as const };
}

export async function readGuardReview(own: OwnStateClient, diamond: Hex, offerId: bigint, bps: number, identity: string, copy: Copy): Promise<GuardReview> {
  const facts = await own.read((c: PublicClient) => readGuardFacts(c, diamond, offerId)).then((x) => x.value);
  const base: GuardReview = { identity, account: own.account, bps, facts, dryRun: null, readAt: Date.now() };
  if (guardBlockers(base, copy).length > 0) return base;
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...guardCall(offerId, bps), account: own.account }));
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

/** What stops the change, in words (empty when nothing does), most
 *  fundamental first. */
export function guardBlockers(r: GuardReview, copy: Copy): string[] {
  const { text, format } = copy;
  const f = r.facts;
  if (f.guard === 'absent') return [text('priceGuard.absent')];
  if (f.creator === null && f.open === null) return [text('priceGuard.noOffer')];
  if (f.creator !== null && f.creator.toLowerCase() !== r.account.toLowerCase()) return [text('priceGuard.notCreator')];
  if (f.open === false) return [text('priceGuard.notOpen')];
  if (f.erc20Pair === false) return [text('priceGuard.notErc20')];
  if (f.paused === true) return [text('priceGuard.paused')];
  if (r.bps !== 0 && (r.bps < GUARD_BPS_MIN || r.bps > GUARD_BPS_MAX))
    return [format('priceGuard.outOfRange', { min: bpsPercent(GUARD_BPS_MIN), max: bpsPercent(GUARD_BPS_MAX) })];
  const g = f.guard;
  if (g !== null && r.bps === 0 && g.maxMoveBps === 0) return [text('priceGuard.alreadyOff')];
  const out: string[] = [];
  if (r.dryRun !== null && r.dryRun !== 'unread')
    out.push(r.dryRun.code === 'OfferPriceGuardUnpriced' ? text('priceGuard.refusedUnpriced') : format('safety.dryRunRefused', { reason: r.dryRun.reason }));
  return out;
}

/** What changed between two reads that the reader should see before
 *  signing; null when nothing did. */
export function guardChanged(before: GuardReview, next: GuardReview, copy: Copy): string | null {
  const { text } = copy;
  const a = before.facts;
  const b = next.facts;
  if (a.open !== b.open) return text('priceGuard.changedOpen');
  const ga = a.guard !== null && a.guard !== 'absent' ? a.guard.maxMoveBps : null;
  const gb = b.guard !== null && b.guard !== 'absent' ? b.guard.maxMoveBps : null;
  if (ga !== gb) return text('priceGuard.changedGuard');
  if (a.paused !== b.paused) return text('priceGuard.changedPause');
  return null;
}

/** The receipt the change is confirmed against (RB-CONFIDENCE). */
export function guardReceipt(r: GuardReview, copy: Copy): Receipt {
  const { text, format } = copy;
  const g = r.facts.guard !== null && r.facts.guard !== 'absent' ? r.facts.guard : null;
  const clearing = r.bps === 0;
  const rows = [
    { label: text('priceGuard.rowOffer'), value: { kind: 'text' as const, text: `#${r.facts.offerId.toString()}` }, binding: true },
    {
      label: text('priceGuard.rowLimit'),
      value: { kind: 'text' as const, text: clearing ? text('priceGuard.limitNone') : bpsPercent(r.bps) },
      binding: true,
    },
    {
      label: text('priceGuard.rowNow'),
      value:
        g === null
          ? { kind: 'unknown' as const, why: text('receipt.unknown') }
          : {
              kind: 'text' as const,
              text:
                g.maxMoveBps === 0 ? text('priceGuard.limitNone') : format('priceGuard.nowSet', { limit: bpsPercent(g.maxMoveBps), at: formatUtc(g.setAt) }),
            },
      binding: false,
    },
  ];
  const consequences = clearing
    ? [text('priceGuard.clearWhat'), text('priceGuard.clearUndo')]
    : [
        format('priceGuard.setWhat', { limit: bpsPercent(r.bps) }),
        text('priceGuard.setCalm'),
        text('priceGuard.setRecorded'),
        g !== null && g.maxMoveBps > 0 ? text('priceGuard.setReplaces') : text('priceGuard.setGap'),
        text('priceGuard.setCheckpoints'),
        text('priceGuard.setOnlyRefuses'),
      ];
  if (g === null) consequences.push(text('priceGuard.guardUnread'));
  if (r.dryRun === 'unread') consequences.push(text('safety.dryRunUnread'));
  consequences.push(text('priceGuard.nothingMoves'));
  return {
    title: text(clearing ? 'priceGuard.titleClear' : g !== null && g.maxMoveBps > 0 ? 'priceGuard.titleChange' : 'priceGuard.titleSet'),
    rows,
    consequences,
    prompts: 1,
    readAt: r.readAt,
  };
}

/** What the transaction recorded for this offer, from its own logs. */
export function measureGuard(r: GuardReview, logs: readonly Log[], diamond: Hex, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const events = parseEventLogs({ abi: PRICE_GUARD, logs: logs as Log[], eventName: 'OfferPriceGuardSet', strict: false }).filter(
    (l) => l.address.toLowerCase() === diamond.toLowerCase() && (l.args as { offerId?: bigint }).offerId === r.facts.offerId,
  );
  const label = r.bps === 0 ? text('priceGuard.legCleared') : format('priceGuard.legSet', { limit: bpsPercent(r.bps) });
  const hit = events.find((l) => Number((l.args as { maxMoveBps?: number | bigint }).maxMoveBps ?? -1) === r.bps);
  return [hit ? { status: 'done', label } : { status: 'not-done', label, reason: text('priceGuard.legMissing') }];
}
