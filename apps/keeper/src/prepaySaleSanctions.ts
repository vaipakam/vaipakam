// apps/keeper/src/prepaySaleSanctions.ts
//
// #2984 — the PREPAY-SALE SANCTIONS SYNC, step 3 of `protocolUpkeep`: the
// keeper's call of the two permissionless syncs (S10 Invariant B,
// `docs/DesignsAndPlans/S10CentralEnforcement.md` §2).
//
// A prepay sale pays its recipients inside the marketplace fill, where a
// screen that reverts on a flagged recipient rolls its own registry write
// back. So the registration has to be committed by a separate call:
// `NFTPrepayListingFacet.syncPrepaySaleListing(loanId)` for a loan's listing,
// `OfferParallelSaleFacet.syncPrepaySaleOffer(offerId)` for an offer's. Each
// commits any recipient the oracle confirms flagged to the fail-closed
// registry and cancels the listing, so it can no longer fill. The fill then
// bars a known-flagged recipient even through an oracle outage. Without a
// caller nothing commits the flag, and a recipient flagged while its listing
// is up stays payable for as long as the oracle is unreachable.
//
// Per chain, per run:
//
//   0. The gate: a sanctions oracle is set on this chain. With none, no
//      address can read as flagged, and the step says so.
//   1. LOAN LISTINGS — one window of the active-loan list at one pinned block
//      (`activeLoanWindow.ts`), and each loan's live listing with the parties
//      its sync screens (`prepaySaleListingParties`).
//   2. OFFER LISTINGS — no view enumerates them, so the indexer's ledger of
//      `PostParallelSaleListing` nominates them: a page a run, rotating above
//      a stored floor every row before which names a listing no longer live
//      (the floor moves only on what the finalized block shows, as in step 1
//      of this pass). Each offer's live listing and its parties come from
//      `prepaySaleOfferParties`.
//   3. Which parties read as flagged now, by the contract's three-way read
//      (`ProfileFacet.sanctionsStatus`: clean, flagged, or unavailable) — the
//      rule the syncs themselves act on. An oracle that cannot answer for a
//      party reads as unavailable, never as clean, and the run's line names
//      each listing it left unscreened.
//   4. A sync for each live listing with a flagged party, simulated first. The
//      contract decides: it re-reads every party, commits only an
//      authoritative Flagged read, and cancels only then. The run's line
//      names each sync that landed, from its own `PrepaySale*Synced` event,
//      as cancelled or as left live.
//
// The party set is the contract's own (the views share the sync's rule), so
// nothing here restates who a sale pays. A listing whose parties all read
// clean costs reads, not gas. Every call is permissionless, pays no fee and
// moves no value.
//
// Gated by KEEPER_ENABLED + PROTOCOL_UPKEEP_ENABLED +
// PREPAY_SALE_SANCTIONS_SYNC_ENABLED. Ships disarmed.

import { decodeEventLog, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { NFTPrepayListingFacetABI, OfferParallelSaleFacetABI, ProfileFacetABI } from '@vaipakam/contracts/abis';
import { deadlineClient, PastRunDeadline, settledChunkedRead } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import { readActiveWindow, type ScanWindow } from './activeLoanWindow';
import { decodePos, encodePos, posAfter, rowFinalized, type EventLedger } from './eventLedger';
import { priorStageCutoffMs, readCutoffMs } from './runWindow';
import { finalFloor, type FinalBlock, type ScanCursors } from './scanCursors';
import type { StepSender } from './stepSender';

export const SALES_ABI = [
  ...(NFTPrepayListingFacetABI as Abi),
  ...(OfferParallelSaleFacetABI as Abi),
  ...(ProfileFacetABI as Abi),
] as Abi;

/** Ledger rows of offer listings read per run, rotating above the floor. */
export const OFFER_PAGE = 200;
export const OFFER_FLOOR_ITEM = 'sale-offer-floor';
export const OFFER_NEXT_ITEM = 'sale-offer-next';
const LISTING_EVENT = 'PostParallelSaleListing';
/** Reads per aggregate. */
const READ_CHUNK = 100;
/** The refusals that mean the listing went since it was read. */
export const SALE_RACES: readonly string[] = ['PrepayListingNotFound', 'ParallelSaleListingNotFound'];

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = /^0x0{40}$/i;
/** `ProfileFacet.sanctionsStatus`'s answers (`LibVaipakam.SanctionsRead`). */
const SANCTIONS_FLAGGED = 1;
const SANCTIONS_UNAVAILABLE = 2;

/** What the step reads and signs with. */
export interface SalesSyncDeps {
  /** Plain client for every read here; each read carries its own cutoff. */
  readClient: PublicClient;
  sendDeadline: number;
  /** Which window of the active list, and where the rotated reads start. */
  visit: number;
  cursors: ScanCursors;
  ledger: EventLedger;
  finalized: () => Promise<FinalBlock | null>;
}

/** What the step did on one chain. */
export interface SalesSyncReport {
  /** Why it did nothing this run, when it did nothing. */
  off: string | null;
  window: ScanWindow | null;
  /** Live listings read: by loan, and by offer. */
  loanListings: number;
  offerListings: number;
  /** Live listings with a party that reads as flagged, e.g. `loan 5`. */
  flagged: string[];
  /** Live listings with no flagged party but one the oracle could not answer
   *  for: not screened this run, so not known to be clean. */
  unscreened: string[];
  /** Syncs that landed and cancelled their listing. */
  cancelled: string[];
  /** Syncs that landed and left their listing live: the contract's own read
   *  found no authoritative flag (an oracle outage at that block, say). */
  leftLive: string[];
  /** Syncs that landed whose event was not in the receipt read. */
  landedUnread: string[];
}

export function emptySalesReport(): SalesSyncReport {
  return { off: null, window: null, loanListings: 0, offerListings: 0, flagged: [], unscreened: [], cancelled: [], leftLive: [], landedUnread: [] };
}

/** The step's figures for the run's line. */
export function describeSales(r: SalesSyncReport | null): string[] {
  if (r === null) return ['sale-sanctions-sync=off (PREPAY_SALE_SANCTIONS_SYNC_ENABLED not armed)'];
  if (r.off !== null) return [`sale-sanctions-sync=not worked (${r.off})`];
  const list = (xs: readonly string[]) => xs.join(',') || 'none';
  return [
    ...(r.window ? [`sale-loan-window=${r.window.index + 1}/${r.window.count} of ${r.window.total} active`] : []),
    `sale-listings=${r.loanListings} by loan, ${r.offerListings} by offer`,
    `sale-flagged=${list(r.flagged)}`,
    ...(r.unscreened.length > 0 ? [`sale-unscreened=${list(r.unscreened)} (the sanctions oracle could not answer for a party, so not known clean)`] : []),
    `sale-synced-cancelled=${list(r.cancelled)}`,
    ...(r.leftLive.length > 0 ? [`sale-synced-left-live=${list(r.leftLive)} (the contract found no authoritative flag at that block)`] : []),
    ...(r.landedUnread.length > 0 ? [`sale-synced-event-unread=${list(r.landedUnread)}`] : []),
  ];
}

interface Listing {
  kind: 'loan' | 'offer';
  id: bigint;
  parties: Address[];
}

const label = (l: Pick<Listing, 'kind' | 'id'>) => `${l.kind} ${l.id}`;
/** Why a read came back empty: its stage ran out of time, or the RPC said. */
const whyUnread = (err: unknown) => (err instanceof PastRunDeadline ? 'not read by its stage cutoff' : shortErr(err));

/** One chain's step. It never throws for running out of time: a stage that
 *  reaches its cutoff is reported unread in the step's own report, so an armed
 *  step always says what it read and what it did not. */
export async function syncSaleListings(chainId: number, diamond: Address, sender: StepSender, deps: SalesSyncDeps): Promise<SalesSyncReport> {
  const out = emptySalesReport();
  // Each read stage stops early enough to leave the stages after it their
  // time (runWindow.ts, rule 3): the party screens by the read cutoff, which
  // reserves the sends' time; the listing reads a stage reserve before that;
  // the gate and the window scan a stage reserve before those.
  const readCutoff = readCutoffMs(deps.sendDeadline);
  const listingCutoff = priorStageCutoffMs(readCutoff);
  const scanCutoff = priorStageCutoffMs(listingCutoff);
  const scanClient = deadlineClient(deps.readClient, scanCutoff);

  // 0. The gate.
  let oracle: Address;
  try {
    oracle = (await boundedCall(scanCutoff, 'the sanctions oracle setting', () =>
      scanClient.readContract({ address: diamond, abi: SALES_ABI, functionName: 'getSanctionsOracle' }),
    )) as Address;
  } catch (err) {
    sender.noteUnread('sales', `the sanctions oracle setting (${whyUnread(err)})`);
    out.off = 'the sanctions oracle setting could not be read';
    return out;
  }
  if (ZERO_ADDRESS.test(oracle)) {
    out.off = 'no sanctions oracle is set on this chain, so no party can read as flagged';
    return out;
  }

  const listings: Listing[] = [];
  const partiesOf = (raw: unknown): { hash: string; parties: Address[] } | null => {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    return { hash: String(raw[0]).toLowerCase(), parties: (raw[1] as Address[]) ?? [] };
  };

  // 1. Loan listings.
  try {
    const scan = await boundedCall(scanCutoff, 'the active-loan window', () => readActiveWindow(scanClient, diamond, deps.visit));
    out.window = scan.window;
    const res = await settledChunkedRead(
      deps.readClient,
      scan.ids,
      READ_CHUNK,
      (id) => ({ address: diamond, abi: SALES_ABI, functionName: 'prepaySaleListingParties', args: [id] }),
      'protocolUpkeep sale-listing parties',
      listingCutoff,
      scan.window.round,
      scan.blockNumber,
    );
    let unread = 0;
    for (const id of scan.ids) {
      const x = res.get(id);
      const p = x?.status === 'success' ? partiesOf(x.result) : null;
      if (p === null) {
        unread += 1;
        continue;
      }
      if (p.hash !== ZERO_HASH) listings.push({ kind: 'loan', id, parties: p.parties });
    }
    if (unread > 0) sender.noteUnread('sales:loans', `the listing of ${unread} loan(s) in the window`);
  } catch (err) {
    sender.noteUnread('sales:loans', `the active-loan window (${whyUnread(err)})`);
  }
  out.loanListings = listings.length;

  // 2. Offer listings, nominated by the ledger.
  // Each wait in the stage stops at its cutoff on its own: a storage wait
  // there leaves the offers unread this run, while the listing reads keep
  // every batch they finished. The loan listings already read are screened
  // either way.
  try {
    const offers = await readOfferListings(chainId, diamond, sender, deps, listingCutoff, partiesOf);
    listings.push(...offers.listings);
    // Unfinished by the cutoff, the floor stays where it is.
    await boundedCall(listingCutoff, 'the offer floor', offers.liftFloor).catch(() => undefined);
  } catch (err) {
    sender.noteUnread('sales:offers', `the offer listings (${whyUnread(err)})`);
  }
  out.offerListings = listings.length - out.loanListings;

  // 3. Which parties read as flagged now.
  const addrs = [...new Set(listings.flatMap((l) => l.parties.map((a) => a.toLowerCase())).filter((a) => !ZERO_ADDRESS.test(a)))];
  const screens = await settledChunkedRead(
    deps.readClient,
    addrs,
    READ_CHUNK,
    (a) => ({ address: diamond, abi: SALES_ABI, functionName: 'sanctionsStatus', args: [a] }),
    'protocolUpkeep sale-party screens',
    readCutoff,
    deps.visit,
  );
  const due: Listing[] = [];
  for (const l of listings) {
    let flagged = false;
    let unread = false;
    let unavailable = false;
    for (const a of l.parties) {
      if (ZERO_ADDRESS.test(a)) continue;
      const x = screens.get(a.toLowerCase());
      if (x?.status !== 'success') unread = true;
      else if (Number(x.result) === SANCTIONS_FLAGGED) flagged = true;
      else if (Number(x.result) === SANCTIONS_UNAVAILABLE) unavailable = true;
    }
    if (flagged) due.push(l);
    else if (unavailable) {
      out.unscreened.push(label(l));
      sender.noteUnread(`sales:${l.kind}:${l.id}`, 'the sanctions screen of a party to its listing (the oracle could not answer)');
    } else if (unread) sender.noteUnread(`sales:${l.kind}:${l.id}`, 'the sanctions screen of a party to its listing');
  }
  out.flagged = due.map(label);

  // 4. The contract decides.
  for (const l of due) {
    if (sender.stopped) break;
    const fn = l.kind === 'loan' ? 'syncPrepaySaleListing' : 'syncPrepaySaleOffer';
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('sanctions-sync', label(l), fn, [l.id]);
    if (res !== 'landed') continue;
    const found = syncedEvent(diamond, l, sender.receipt?.logs ?? []);
    if (found === null) out.landedUnread.push(label(l));
    else (found ? out.cancelled : out.leftLive).push(label(l));
  }
  return out;
}

/** Step 2: the offer listings the ledger nominates, live at the head; and how
 *  to move the floor past the rows no longer live, which the caller bounds on
 *  its own so a slow floor read cannot lose the listings already read. */
async function readOfferListings(
  chainId: number,
  diamond: Address,
  sender: StepSender,
  deps: SalesSyncDeps,
  cutoff: number,
  partiesOf: (raw: unknown) => { hash: string; parties: Address[] } | null,
): Promise<{ listings: Listing[]; liftFloor: () => Promise<void> }> {
  const listings: Listing[] = [];
  const { cursors } = deps;
  // The storage waits are bounded one by one, not with the reads around
  // them: `settledChunkedRead` stops at the cutoff itself and keeps the
  // batches it finished, which a bound over the whole stage would discard.
  const stored = await boundedCall(cutoff, 'the offer cursors', () => cursors.get([OFFER_FLOOR_ITEM, OFFER_NEXT_ITEM]));
  const floor = decodePos(stored.get(OFFER_FLOOR_ITEM));
  const next = decodePos(stored.get(OFFER_NEXT_ITEM));
  const start = next !== null && (floor === null || posAfter(next, floor)) ? next : floor;
  const page = await boundedCall(cutoff, 'the listing ledger', () => deps.ledger.page(chainId, [LISTING_EVENT], start, OFFER_PAGE));
  if (page === null) {
    sender.noteUnread('sales:offers', 'the event ledger of parallel-sale listings');
    return { listings, liftFloor: async () => {} };
  }
  const last = page.rows[page.rows.length - 1];
  // Past the last page the next run starts at the floor again.
  const nextPos = page.more && last !== undefined ? encodePos(last) : '';
  // Unwritten by the cutoff, the next run reads this page again.
  if (nextPos !== (stored.get(OFFER_NEXT_ITEM) ?? '')) {
    await boundedCall(cutoff, 'the offer rotation', () => cursors.put(OFFER_NEXT_ITEM, nextPos)).catch(() => undefined);
  }

  // The listing each row names; a row that names none nominates nothing.
  const rows = page.rows.map((row) => {
    const hash = String(row.args.orderHash ?? '').toLowerCase();
    let offerId: bigint | null = null;
    try {
      offerId = BigInt(String(row.args.offerId));
    } catch {
      offerId = null;
    }
    return offerId === null || !/^0x[0-9a-f]{64}$/.test(hash) ? null : { offerId, hash };
  });
  const offers = [...new Set(rows.flatMap((r) => (r === null ? [] : [r.offerId])))];
  const readAt = async (ids: readonly bigint[], blockNumber?: bigint) =>
    settledChunkedRead(
      deps.readClient,
      ids,
      READ_CHUNK,
      (id) => ({ address: diamond, abi: SALES_ABI, functionName: 'prepaySaleOfferParties', args: [id] }),
      `protocolUpkeep sale-offer parties${blockNumber === undefined ? '' : ' (finalized)'}`,
      cutoff,
      deps.visit,
      blockNumber,
    );
  const head = await readAt(offers);
  const liveHash = new Map<bigint, string>();
  let unread = 0;
  for (const id of offers) {
    const x = head.get(id);
    const p = x?.status === 'success' ? partiesOf(x.result) : null;
    if (p === null) {
      unread += 1;
      continue;
    }
    liveHash.set(id, p.hash);
    if (p.hash !== ZERO_HASH) listings.push({ kind: 'offer', id, parties: p.parties });
  }
  if (unread > 0) sender.noteUnread('sales:offers', `the listing of ${unread} offer(s) the ledger names`);

  // A row is finished when the listing it records is no longer the offer's
  // live one: cancelled, filled, released, or replaced by a later post (whose
  // own row is above it). On a page read from the floor, the floor moves past
  // the leading finished rows, at the head AND at the finalized block.
  if (start !== floor) return { listings, liftFloor: async () => {} };
  const done = (i: number, hashes: ReadonlyMap<bigint, string>) => {
    const r = rows[i];
    if (r === null) return true;
    const h = hashes.get(r.offerId);
    return h !== undefined && h !== r.hash;
  };
  const positions = page.rows.map((_, i) => i);
  // The finalized block by this stage's cutoff too; unread, the floor stays.
  const finalized = () => boundedCall(cutoff, 'the finalized block', deps.finalized).catch(() => null);
  const liftFloor = async () => {
    const n = await finalFloor(0, positions, (i) => done(i, liveHash), finalized, async (passed, block) => {
      const live = passed.filter((i) => rows[i] === null || rowFinalized(page.rows[i], block));
      const named = [...new Set(live.flatMap((i) => (rows[i] === null ? [] : [rows[i]!.offerId])))];
      const at = await readAt(named, block.number);
      const hashes = new Map<bigint, string>();
      for (const id of named) {
        const x = at.get(id);
        const p = x?.status === 'success' ? partiesOf(x.result) : null;
        if (p !== null) hashes.set(id, p.hash);
      }
      return new Set(live.filter((i) => done(i, hashes)));
    });
    if (n > 0) await cursors.put(OFFER_FLOOR_ITEM, encodePos(page.rows[n - 1]));
  };
  return { listings, liftFloor };
}

/** Whether a landed sync found a flag, from its own event; null when the
 *  receipt read holds no event for this listing. */
export function syncedEvent(
  diamond: Address,
  l: Pick<Listing, 'kind' | 'id'>,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
): boolean | null {
  const name = l.kind === 'loan' ? 'PrepaySaleListingSynced' : 'PrepaySaleOfferSynced';
  const key = l.kind === 'loan' ? 'loanId' : 'offerId';
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: SALES_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (ev.eventName !== name) continue;
    const a = ev.args as unknown as Record<string, unknown>;
    if (BigInt(a[key] as bigint) !== l.id) continue;
    return a.flaggedFound === true;
  }
  return null;
}
