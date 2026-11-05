/**
 * Home's reads (RW-70, ACC-31). The wallet's positions, payouts and offers
 * are OWN state: read through the own rail (`useOwnRead`), bound to the
 * connected identity and chain. The protocol's pause posture and numeraire
 * are chain reads that belong to no one (`useChainRead`).
 *
 * Whose a position is follows the position NFT, never the party recorded at
 * origination: a transfer moves the NFT (and the claim right with it) but not
 * the loan's stored lender or borrower. So loans and offers are enumerated
 * from the NFTs the wallet HOLDS (`getUserPositionLoansPaginated`,
 * `getUserPositionOffersPaginated`), each side derived from the token held,
 * and hydrated in bulk; an offer counts as open only when the protocol's own
 * state reader says Open (not cancelled, expired, accepted or sold).
 *
 * Every walk is the whole inventory up to a stated cap, and a walk the cap
 * stopped is reported incomplete, never shown as all of it. A per-loan figure
 * that could not be read (a deadline, a value, a health reading) is `null`
 * (or 0 for the health factor, which the view's own convention reads as "no
 * reading"), never a made-up figure.
 */
import { hexToString, type Abi, type PublicClient } from 'viem';
import {
  AdminFacetABI,
  LoanFacetABI,
  MetricsDashboardFacetABI,
  MetricsFacetABI,
  NumeraireConfigFacetABI,
  NumeraireValueFacetABI,
  RepayPeriodicFacetABI,
  RiskFacetABI,
} from '@vaipakam/contracts/abis';
import { scanAll } from '../../shared/reads/scan';
import { ASSET_ERC20, LOAN_STATUS_ACTIVE, isLiveStatus, positionKey, type Deadlines, type LiveLoanRow, type LoanSummary } from './model';

const DASHBOARD = MetricsDashboardFacetABI as Abi;
const METRICS = MetricsFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;
const RISK = RiskFacetABI as Abi;
const PERIODIC = RepayPeriodicFacetABI as Abi;
const VALUE = NumeraireValueFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const NUMERAIRE = NumeraireConfigFacetABI as Abi;

/** Inventory slots or index rows per call, under the views' page limit (100). */
const PAGE = 100;
/** Calls per walk before it stops and says so (5,000 slots at most). */
const MAX_PAGES = 50;
/** Ids per bulk hydration call (the views' `MAX_BATCH_IDS` is 250). */
const BATCH = 200;
/** `LibMetricsTypes.OfferState.Open`. */
const OFFER_STATE_OPEN = 0;

type Hex = `0x${string}`;

/** Every promise settled, each as its value or `null`: one figure that could
 *  not be read never sinks the others, and is never read as zero. */
async function settled<T>(promises: readonly Promise<T>[]): Promise<(T | null)[]> {
  return (await Promise.allSettled(promises)).map((r) => (r.status === 'fulfilled' ? r.value : null));
}

/** Walks an ERC-721 inventory view taking `(user, offset, limit)` and
 *  returning `(ids, tokenIds, totalBalance)`, as one bounded scan. */
async function walkInventory(client: PublicClient, diamond: Hex, account: Hex, functionName: string) {
  return scanAll<{ id: bigint; tokenId: bigint }>(
    async (cursor, maxScan) => {
      const [ids, tokenIds, total] = (await client.readContract({
        address: diamond,
        abi: METRICS,
        functionName,
        args: [account, cursor, BigInt(maxScan)],
      })) as [readonly bigint[], readonly bigint[], bigint];
      const reached = cursor + BigInt(maxScan);
      const nextCursor = reached < total ? reached : total > cursor ? total : cursor;
      return { rows: ids.map((id, i) => ({ id, tokenId: tokenIds[i]! })), nextCursor };
    },
    { maxScan: PAGE, maxPages: MAX_PAGES },
  );
}

/** Bulk hydration in chunks the view accepts, positions preserved. */
async function inBatches<T>(ids: readonly bigint[], read: (chunk: bigint[]) => Promise<readonly T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += BATCH) out.push(...(await read(ids.slice(i, i + BATCH))));
  return out;
}

/** A loan position the wallet holds, with the side its token stands for and
 *  the party the protocol recorded for that side at origination. */
export interface HeldPosition {
  loan: LoanSummary;
  borrowerSide: boolean;
  recordedParty: Hex;
}

export interface LiveLoans {
  rows: LiveLoanRow[];
  complete: boolean;
  /** Keyed by `positionKey`; null = the read failed. */
  deadlines: Readonly<Record<string, Deadlines | null>>;
  /** Each position's principal in the numeraire (1e18), a debt rounded up
   *  and an asset rounded down; null = the protocol could not value it now
   *  (an NFT leg, an unpriced asset, or a failed read). */
  values: Readonly<Record<string, bigint | null>>;
}

export interface PayoutRow {
  loanId: bigint;
  side: 'lender' | 'borrower';
}

export interface Payouts {
  rows: PayoutRow[];
  complete: boolean;
  /** Ended (or fallback) loans whose position the wallet holds but did not
   *  originate on that side: the protocol's pending rule is listed only for
   *  the recorded party, so whether these pay out is not known here. */
  unlisted: number;
}

export interface PositionBook {
  loans: LiveLoans;
  payouts: Payouts;
}

/**
 * The loan positions the wallet holds, split into live loans (with their
 * deadlines, values and health readings) and payouts ready to collect.
 *
 * A payout is listed when the protocol's pending rule (#941, the dashboard's
 * claimables view) says a claim would pay the recorded party AND the wallet
 * still holds that side's position, since the claim pays the holder. A held
 * position on an ended loan the wallet received from someone else is not
 * covered by that view; it is counted (`unlisted`) rather than guessed.
 */
export async function readPositionBook(client: PublicClient, diamond: Hex, account: Hex): Promise<PositionBook> {
  const inventory = await walkInventory(client, diamond, account, 'getUserPositionLoansPaginated');
  const views = await inBatches(
    inventory.rows.map((r) => r.id),
    async (chunk) =>
      (await client.readContract({ address: diamond, abi: DASHBOARD, functionName: 'getLoansBatch', args: [chunk] })) as readonly {
        loan: LoanSummary;
        lender: Hex;
        borrower: Hex;
      }[],
  );
  const held: HeldPosition[] = [];
  inventory.rows.forEach((r, i) => {
    const v = views[i];
    if (!v || v.loan.id === 0n) return;
    if (r.tokenId === v.loan.borrowerTokenId) held.push({ loan: v.loan, borrowerSide: true, recordedParty: v.borrower });
    else if (r.tokenId === v.loan.lenderTokenId) held.push({ loan: v.loan, borrowerSide: false, recordedParty: v.lender });
  });

  const live = held.filter((h) => isLiveStatus(h.loan.status));

  const [healthList, deadlineList, valueList, payouts] = await Promise.all([
    settled(live.map(async (h) => (await client.readContract({ address: diamond, abi: RISK, functionName: 'calculateHealthFactor', args: [h.loan.id] })) as bigint)),
    settled(
      // Both dates the loan answers to: maturity and, with a periodic-interest
      // cadence, the next checkpoint. Either unread leaves the deadline
      // unknown rather than half-known.
      live.map(async (h) => {
        const [[, pauseCredit, maturity, graceEnd], [cadence, periodEndAt, graceEndsAt, , , shortfall]] = (await Promise.all([
          client.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDeadlines', args: [h.loan.id] }),
          client.readContract({ address: diamond, abi: PERIODIC, functionName: 'previewPeriodicSettle', args: [h.loan.id] }),
        ])) as [[bigint, bigint, bigint, bigint], [number, bigint, bigint, bigint, bigint, bigint, boolean]];
        return { maturity, graceEnd, pauseCredit, periodic: cadence === 0 ? null : { periodEndAt, graceEndsAt, shortfall } } satisfies Deadlines;
      }),
    ),
    settled(
      live.map(async (h) => {
        if (h.loan.assetType !== ASSET_ERC20) throw new Error('an NFT leg has no numeraire value');
        return (await client.readContract({
          address: diamond,
          abi: VALUE,
          functionName: 'getNumeraireValue',
          args: [h.loan.principalAsset, h.loan.principal, h.borrowerSide],
        })) as bigint;
      }),
    ),
    readPayouts(client, diamond, account, held, inventory.complete),
  ]);

  const rows: LiveLoanRow[] = live.map((h, i) => ({ loan: h.loan, borrowerSide: h.borrowerSide, healthFactor: healthList[i] ?? 0n }));
  const deadlines: Record<string, Deadlines | null> = {};
  const values: Record<string, bigint | null> = {};
  rows.forEach((r, i) => {
    deadlines[positionKey(r)] = deadlineList[i] ?? null;
    values[positionKey(r)] = valueList[i] ?? null;
  });
  return { loans: { rows, complete: inventory.complete, deadlines, values }, payouts };
}

/** A claim can be open on a loan that is still live (a lender's claim on a
 *  FallbackPending loan, recorded at fallback entry), so the pending rows are
 *  matched against every held position, not only ended ones. */
async function readPayouts(client: PublicClient, diamond: Hex, account: Hex, held: readonly HeldPosition[], inventoryComplete: boolean): Promise<Payouts> {
  const heldKeys = new Set(held.map((h) => positionKey(h)));
  const side = (borrowerSide: boolean) =>
    scanAll<PayoutRow>(
      async (cursor, maxScan) => {
        const [loanIds, , nextCursor] = (await client.readContract({
          address: diamond,
          abi: DASHBOARD,
          functionName: 'getUserDashboardClaimables',
          args: [account, borrowerSide, cursor, maxScan],
        })) as [readonly bigint[], readonly unknown[], bigint];
        return { rows: loanIds.map((loanId) => ({ loanId, side: borrowerSide ? 'borrower' : 'lender' }) as PayoutRow), nextCursor };
      },
      { maxScan: PAGE, maxPages: MAX_PAGES },
    );
  const [lender, borrower] = await Promise.all([side(false), side(true)]);
  const rows = [...lender.rows, ...borrower.rows]
    .filter((p) => heldKeys.has(positionKey({ loan: { id: p.loanId }, borrowerSide: p.side === 'borrower' })))
    .sort((a, b) => (a.loanId < b.loanId ? -1 : a.loanId > b.loanId ? 1 : 0));
  // Positions the pending view cannot cover: received from another wallet,
  // on a loan that is no longer simply Active (ended, or in fallback).
  const unlisted = held.filter((h) => h.loan.status !== LOAN_STATUS_ACTIVE && h.recordedParty.toLowerCase() !== account.toLowerCase()).length;
  return { rows, complete: inventoryComplete && lender.complete && borrower.complete, unlisted };
}

export interface OpenOffer {
  id: bigint;
  offerType: number;
  createdAt: bigint;
  expiresAt: bigint;
  lendingAsset: Hex;
  assetType: number;
  amount: bigint;
  amountMax: bigint;
  amountFilled: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  durationDays: bigint;
  tokenId: bigint;
}

export interface OpenOffers {
  rows: OpenOffer[];
  complete: boolean;
}

/** The offers whose position NFT the wallet holds and that the protocol's
 *  state reader calls Open, newest first. */
export async function readOpenOffers(client: PublicClient, diamond: Hex, account: Hex): Promise<OpenOffers> {
  const inventory = await walkInventory(client, diamond, account, 'getUserPositionOffersPaginated');
  const views = await inBatches(
    inventory.rows.map((r) => r.id),
    async (chunk) =>
      (await client.readContract({ address: diamond, abi: DASHBOARD, functionName: 'getOffersWithState', args: [chunk] })) as readonly (OpenOffer & {
        state: number;
      })[],
  );
  const rows = views.filter((v) => v.id !== 0n && v.state === OFFER_STATE_OPEN);
  return { rows: rows.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)), complete: inventory.complete };
}

export interface ProtocolPosture {
  paused: boolean;
  /** When an automatic pause window ends (unix seconds); 0 when none runs. */
  pausedUntil: bigint;
  keepersPaused: boolean;
}

export async function readPosture(client: PublicClient, diamond: Hex): Promise<ProtocolPosture> {
  const call = (functionName: string) => client.readContract({ address: diamond, abi: ADMIN, functionName });
  const [paused, pausedUntil, keepersPaused] = await Promise.all([call('paused'), call('pausedUntil'), call('keepersPaused')]);
  return { paused: paused as boolean, pausedUntil: pausedUntil as bigint, keepersPaused: keepersPaused as boolean };
}

/** The numeraire's display symbol ("USD"), or null when unset or unreadable. */
export async function readNumeraireSymbol(client: PublicClient, diamond: Hex): Promise<string | null> {
  const raw = (await client.readContract({ address: diamond, abi: NUMERAIRE, functionName: 'getNumeraireSymbol' })) as Hex;
  const text = hexToString(raw, { size: 32 }).replace(/\0+$/, '');
  return text.length > 0 ? text : null;
}
