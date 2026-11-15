/**
 * One wallet's activity (#3677, ACC activity feed): what the protocol's index
 * holds for a wallet on one network, read from the server's own wallet filter
 * (`GET /activity?wallet=…`), newest first. The index answers from two legs:
 * every event on a loan the wallet ever held a position in, and every event
 * that names the wallet (the shared participant rule). It says when its
 * record of the second leg is not yet complete, and this reader passes that
 * on rather than presenting the list as the wallet's whole history.
 *
 * The first page also carries the events in the newest blocks, which are not
 * final yet, and the loans whose ending was found by a check rather than seen
 * as an event. A row is a pointer and a record of what the index stored: an
 * amount is shown only when the index recorded one, never rebuilt from the
 * event's raw arguments.
 *
 * Every answer is checked against what was asked (the network and the
 * wallet); a row whose shape cannot be read is counted and the count stated,
 * never dropped in silence.
 */
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

/** Events per page. */
export const ACTIVITY_PAGE = 50;

export interface ActivityEvent {
  blockNumber: number;
  logIndex: number;
  txHash: Hex | null;
  kind: string;
  loanId: bigint | null;
  offerId: bigint | null;
  /** Who sent the transaction, as the index files it; null when it records
   *  none (a step anyone may take, such as a default, often has none). */
  actor: Hex | null;
  /** The block's time in unix seconds; null when it was not read (always,
   *  for an event that is not final). */
  blockAt: number | null;
  /** What the event moved or offered, as the index recorded it. Each is
   *  null when not recorded. */
  asset: Hex | null;
  assetType: number | null;
  amount: bigint | null;
  amountMax: bigint | null;
  tokenId: bigint | null;
  quantity: bigint | null;
  /** False for an event in a block that may still be replaced. */
  final: boolean;
}

/** A loan whose ending the index found by a reconciliation check: the chain
 *  showed it in `observedStatus` by `observedBlock`. When it ended, and which
 *  event ended it, were not seen. */
export interface RepairEntry {
  loanId: bigint;
  observedStatus: string;
  observedBlock: number;
  observedAt: number | null;
  /** Where it sits in the feed, on the events' log-index scale. */
  feedLogIndex: number;
}

export interface PendingLane {
  events: ActivityEvent[];
  /** False when the index's read of the newest blocks did not reach the
   *  chain's head or was cut short: some events may be missing. */
  complete: boolean;
  /** Unix seconds the index read those blocks. */
  readAt: number;
}

export interface ActivityPage {
  events: ActivityEvent[];
  repairs: RepairEntry[];
  /** False when the index could not read the endings a check found for this
   *  page (it answers null, never an empty list): some loan endings may be
   *  missing, so the page claims no end. */
  repairsKnown: boolean;
  /** Asked for on the first page only. `undefined` when not asked; `null`
   *  when the index does not know (no recent read): never an empty list. */
  pending: PendingLane | null | undefined;
  /** True once the index has recorded the participants of every event it
   *  stores; false while it is still reading older history; null when it
   *  could not say. */
  walletComplete: boolean | null;
  nextBefore: string | null;
  /** Rows on this page (events, pending events and repairs) whose shape
   *  could not be read. */
  unreadable: number;
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_TX = /^0x[0-9a-fA-F]{64}$/;
const MAX_DATE_SECONDS = 8_640_000_000_000;

function wholeNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** A non-negative integer the index sends as a decimal string or a number;
 *  `undefined` when present but unreadable, so the row is refused. */
function bigOrNull(v: unknown): bigint | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && /^\d{1,78}$/.test(v)) return BigInt(v);
  if (wholeNumber(v) !== null) return BigInt(v as number);
  return undefined;
}

function addressOrNull(v: unknown): Hex | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && HEX_ADDRESS.test(v) ? (v.toLowerCase() as Hex) : undefined;
}

/** One event, or null when its shape cannot be read. */
export function parseActivityEvent(raw: unknown, final: boolean): ActivityEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const blockNumber = wholeNumber(r.blockNumber);
  const logIndex = wholeNumber(r.logIndex);
  if (blockNumber === null || logIndex === null || typeof r.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(r.kind)) return null;
  const txHash = r.txHash === null || r.txHash === undefined ? null : typeof r.txHash === 'string' && HEX_TX.test(r.txHash) ? (r.txHash.toLowerCase() as Hex) : undefined;
  const blockAt = r.blockAt === null || r.blockAt === undefined ? null : wholeNumber(r.blockAt);
  const assetType = r.assetType === null || r.assetType === undefined ? null : wholeNumber(r.assetType);
  const loanId = bigOrNull(r.loanId);
  const offerId = bigOrNull(r.offerId);
  const actor = addressOrNull(r.actor);
  const asset = addressOrNull(r.asset);
  const amount = bigOrNull(r.amount);
  const amountMax = bigOrNull(r.amountMax);
  const tokenId = bigOrNull(r.tokenId);
  const quantity = bigOrNull(r.quantity);
  if (
    txHash === undefined ||
    (r.blockAt !== null && r.blockAt !== undefined && (blockAt === null || blockAt > MAX_DATE_SECONDS)) ||
    (r.assetType !== null && r.assetType !== undefined && assetType === null) ||
    loanId === undefined ||
    offerId === undefined ||
    actor === undefined ||
    asset === undefined ||
    amount === undefined ||
    amountMax === undefined ||
    tokenId === undefined ||
    quantity === undefined
  ) {
    return null;
  }
  // Zero is "no loan / no offer", never an id.
  return {
    blockNumber,
    logIndex,
    txHash,
    kind: r.kind,
    loanId: loanId === 0n ? null : loanId,
    offerId: offerId === 0n ? null : offerId,
    actor,
    blockAt,
    asset,
    assetType,
    amount,
    amountMax,
    tokenId,
    quantity,
    final,
  };
}

/** One repaired ending, or null when its shape cannot be read. */
export function parseRepairEntry(raw: unknown): RepairEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const loanId = bigOrNull(r.loanId);
  const observedBlock = wholeNumber(r.observedBlock);
  const feedLogIndex = wholeNumber(r.feedLogIndex);
  const observedAt = r.observedAt === null || r.observedAt === undefined ? null : wholeNumber(r.observedAt);
  if (
    loanId === undefined ||
    loanId === null ||
    loanId === 0n ||
    observedBlock === null ||
    feedLogIndex === null ||
    typeof r.observedStatus !== 'string' ||
    !/^[a-z_]{1,40}$/.test(r.observedStatus) ||
    (r.observedAt !== null && r.observedAt !== undefined && (observedAt === null || observedAt > MAX_DATE_SECONDS))
  ) {
    return null;
  }
  return { loanId, observedStatus: r.observedStatus, observedBlock, observedAt, feedLogIndex };
}

/**
 * One page of `wallet`'s activity on `chainId`, newest first, from the
 * position `before` (the index's `block:logIndex` cursor). The first page
 * also asks for the events not final yet. Throws {@link IndexerUnavailable}
 * when the index does not answer, or answers for another network or wallet.
 */
export async function readActivityPage(indexer: IndexerClient, chainId: number, wallet: Hex, before: string | null = null, limit = ACTIVITY_PAGE): Promise<ActivityPage> {
  const q = new URLSearchParams({ chainId: String(chainId), wallet: wallet.toLowerCase(), limit: String(limit), repairObservations: '1' });
  if (before !== null) q.set('before', before);
  else q.set('pending', '1');
  const res: Record<string, unknown> = await indexer.getJson(`/activity?${q.toString()}`);
  if (res.chainId !== chainId || typeof res.wallet !== 'string' || res.wallet.toLowerCase() !== wallet.toLowerCase() || !Array.isArray(res.events)) {
    throw new IndexerUnavailable('shape', 'The index answered for another network or wallet.');
  }
  const nextBefore =
    res.nextBefore === null || res.nextBefore === undefined ? null : typeof res.nextBefore === 'string' && /^\d{1,15}:\d{1,20}$/.test(res.nextBefore) ? res.nextBefore : undefined;
  if (nextBefore === undefined) throw new IndexerUnavailable('shape', 'The index’s page cursor could not be read.');
  const walletComplete = typeof res.walletComplete === 'boolean' ? res.walletComplete : null;

  let unreadable = 0;
  const events: ActivityEvent[] = [];
  for (const raw of res.events) {
    const e = parseActivityEvent(raw, true);
    if (e === null) unreadable++;
    else events.push(e);
  }
  const repairs: RepairEntry[] = [];
  const repairsKnown = Array.isArray(res.repairObservations);
  if (Array.isArray(res.repairObservations)) {
    for (const raw of res.repairObservations) {
      const r = parseRepairEntry(raw);
      if (r === null) unreadable++;
      else repairs.push(r);
    }
  }
  let pending: PendingLane | null | undefined;
  if (before === null) {
    const p = typeof res.pending === 'object' && res.pending !== null ? (res.pending as Record<string, unknown>) : null;
    const readAt = wholeNumber(p?.readAt);
    if (p === null || !Array.isArray(p.events) || readAt === null || typeof p.complete !== 'boolean') {
      pending = null;
    } else {
      const lane: ActivityEvent[] = [];
      for (const raw of p.events) {
        const e = parseActivityEvent(raw, false);
        if (e === null) unreadable++;
        else lane.push(e);
      }
      pending = { events: lane, complete: p.complete, readAt };
    }
  }
  return { events, repairs, repairsKnown, pending, walletComplete, nextBefore, unreadable };
}

/**
 * Event kinds that restate or record bookkeeping for another event in the
 * same transaction. A transaction's line leads with its first event of
 * another kind, so "A loan started" heads a transaction rather than the token
 * transfer inside it; the rest stay listed under it.
 */
export const DETAIL_KINDS: ReadonlySet<string> = new Set([
  'Approval',
  'ApprovalForAll',
  'Transfer',
  'NFTMinted',
  'LoanInitiatedDetails',
  'OfferCreatedDetails',
  'OfferCanceledDetails',
  'LoanSettlementBreakdown',
  'LoanStatusChanged',
  'FeeEntitlementStamped',
  'FeeEntitlementRepriced',
  'LenderEntryStamped',
  'OwedAtDefaultRecorded',
  'OwedAtInternalMatchRecorded',
  'PaymentCreditedToVault',
  'VPFIYieldFeeDiscountApplied',
  'VaultOutflow',
  'VaultGrantSettled',
  'VaultVpfiDebited',
  'SwapAdapterAttempted',
  'SwapAdapterSucceeded',
  'SwapToRepayIntentLotPulled',
  'SignedOfferNonceBurned',
  'RewardEntryHorizonStamped',
  'PrepaySaleListingSynced',
  'PrepaySaleOfferSynced',
]);

/**
 * Event kinds that accompany the event saying what a transaction did: an
 * accept or a match also starts a loan, and a first action may create the
 * vault. They lead a line only when nothing else in it can, so an accept
 * reads as "A loan started" with the accept listed under it.
 */
export const SECONDARY_KINDS: ReadonlySet<string> = new Set(['OfferAccepted', 'OfferMatched', 'SignedOfferMatched', 'UserVaultCreated']);

/** The event a transaction's line leads with. */
function leadOf(group: readonly ActivityEvent[]): ActivityEvent {
  return group.find((e) => !DETAIL_KINDS.has(e.kind) && !SECONDARY_KINDS.has(e.kind)) ?? group.find((e) => !DETAIL_KINDS.has(e.kind)) ?? group[0]!;
}

/** One line of the list: a transaction's events, or a repaired ending. */
export type ActivityLine = { kind: 'tx'; key: string; lead: ActivityEvent; rest: ActivityEvent[]; final: boolean } | { kind: 'repair'; key: string; repair: RepairEntry };

function eventKey(e: ActivityEvent): string {
  return `${e.final ? 'f' : 'p'}:${e.blockNumber}:${e.logIndex}`;
}

/**
 * The events in feed order, one line per transaction: consecutive events of
 * one transaction (they are adjacent, newest first) become one line led by
 * the event that says what happened (see `leadOf`). An event with no transaction hash
 * stands alone. Repaired endings are placed at their feed position.
 */
export function activityLines(events: readonly ActivityEvent[], repairs: readonly RepairEntry[] = []): ActivityLine[] {
  const lines: ActivityLine[] = [];
  let group: ActivityEvent[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const lead = leadOf(group);
    lines.push({ kind: 'tx', key: eventKey(group[0]!), lead, rest: group.filter((e) => e !== lead), final: group[0]!.final });
    group = [];
  };
  // Repairs sort into the events by (block, log index), newest first.
  const pendingRepairs = [...repairs].sort((a, b) => b.observedBlock - a.observedBlock || b.feedLogIndex - a.feedLogIndex);
  let ri = 0;
  for (const e of events) {
    while (ri < pendingRepairs.length) {
      const r = pendingRepairs[ri]!;
      if (r.observedBlock < e.blockNumber || (r.observedBlock === e.blockNumber && r.feedLogIndex < e.logIndex)) break;
      flush();
      lines.push({ kind: 'repair', key: `r:${r.loanId.toString()}:${r.observedBlock}`, repair: r });
      ri++;
    }
    const last = group[group.length - 1];
    if (last && (e.txHash === null || last.txHash !== e.txHash || last.final !== e.final)) flush();
    group.push(e);
  }
  flush();
  for (; ri < pendingRepairs.length; ri++) {
    const r = pendingRepairs[ri]!;
    lines.push({ kind: 'repair', key: `r:${r.loanId.toString()}:${r.observedBlock}`, repair: r });
  }
  return lines;
}
