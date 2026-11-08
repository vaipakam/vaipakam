/**
 * LN-52 — interest owed to a wallet that SOLD a lender position (#1209). A
 * sale turns the interest the seller earned and was not paid into a seller
 * claim on the loan. While the loan runs, every interest payment pays the
 * open claims first, oldest first, into each seller's own vault; when the
 * loan ends, the lender's recovery is split once: the holder's principal
 * first, then the claims oldest first, and whatever a claim is not paid
 * closes unpaid. A seller withdraws what reached their vault with
 * `claimAsSeller`, which on an ended loan first runs that split.
 *
 * Everything here is read from the chain. The indexer only names the loans a
 * wallet has a seller claim on (candidates widen, never decide); each loan is
 * then read as `claimAsSeller` reads it, and the protocol's dry run is the
 * last word on whether it pays now (it also screens the wallet against the
 * sanctions list). A figure the app cannot substantiate is unknown, never
 * guessed: an in-kind recovery is split by value at the moment it runs, so
 * the seller's part of it is stated as decided then.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, ClaimFacetABI, LoanFacetABI, SellerClaimFacetABI } from '@vaipakam/contracts/abis';
import type { CopyAccess } from '../copy/useCopy';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from '../eligibility/types';
import { treasuryShareBps, type LoanDetails } from '../positions/loanView';
import type { IndexerClient } from '../reads/world/indexerClient';
import { answerOrNull } from '../reads/answer';

type Hex = `0x${string}`;

export const SELLER = SellerClaimFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;
const CLAIM = ClaimFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;

/** `LibVaipakam.LoanStatus`. */
const ACTIVE = 0;
const REPAID = 1;
const DEFAULTED = 2;
const SETTLED = 3;
const FALLBACK = 4;
const MATCHED = 5;
const BPS = 10_000n;

/** The four events the indexer files under the seller as its actor. */
export const SELLER_KINDS = ['SellerInterestClaimRecorded', 'SellerInterestPaid', 'SellerInterestClaimClosed', 'SellerInterestWithdrawn'] as const;
/** How far the discovery walks the wallet's seller history (pages of 100). */
export const DISCOVERY_MAX_PAGES = 10;

/** Whether the loan's lender claim is final, so a withdrawal first splits
 *  it (`SellerClaimFacet._final`): ended and lender-claimable, not in
 *  fallback (whose claim-time retry can still rewrite the row), or settled. */
export function splitFinal(status: number): boolean {
  return status === REPAID || status === DEFAULTED || status === SETTLED || status === MATCHED;
}

/** What a claim of `gross` is owed after the loan's own fee on interest,
 *  rounded as the protocol rounds it. */
export function netOwed(gross: bigint, feeBps: number): bigint {
  return (gross * (BPS - BigInt(feeBps))) / BPS;
}

export interface SellerClaimEntry {
  seller: Hex;
  grossOwed: bigint;
}

export interface SellerHeld {
  asset: Hex;
  amount: bigint;
}

/** One loan as a past seller's withdrawal reads it. */
export interface SellerRow {
  loanId: bigint;
  /** Null when the loan could not be read; every other field is then null. */
  loan: LoanDetails | null;
  /** Every open seller claim on the loan, oldest first; null when unread. */
  claims: SellerClaimEntry[] | null;
  /** The asset the loan's lender claim row is in, when one is recorded
   *  (an ended loan; in kind, the collateral). Null when none or unread. */
  claimAsset: Hex | null;
  /** What waits in the seller's vault for them on this loan, per asset
   *  (the principal and, when different, the claim row's asset); null when
   *  any of it could not be read. */
  held: SellerHeld[] | null;
  /** On a loan whose claim is final with claims open: the part of the
   *  lender claim row the split moves to all the open claims together, as
   *  the row stands now. Null when not asked or unread. */
  share: bigint | null;
}

type ClaimableTuple = readonly [Hex, bigint, boolean, number, bigint, bigint, bigint, boolean];
type LedgerTuple = readonly [bigint, bigint, bigint | number, readonly { seller: Hex; grossOwed: bigint }[]];

/** One loan, read as `claimAsSeller` reads it for `seller`, every read at
 *  one block (`blockNumber`, or the head when none is given): the open
 *  claims, the vault balances and the split's share move together when the
 *  loan's holder collects, so reads from two blocks could state a claim as
 *  unpaid beside the payment already waiting for it. */
export async function readSellerRow(c: PublicClient, diamond: Hex, loanId: bigint, seller: Hex, blockNumber?: bigint): Promise<SellerRow> {
  const at = { blockNumber: blockNumber ?? (await c.getBlockNumber({ cacheTime: 0 })) };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[]) => answerOrNull(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
  const loan = await read<LoanDetails>(LOAN, 'getLoanDetails', [loanId]);
  if (loan === null) return { loanId, loan: null, claims: null, claimAsset: null, held: null, share: null };
  const [ledger, row] = await Promise.all([read<LedgerTuple>(SELLER, 'getInterestLedger', [loanId]), read<ClaimableTuple>(CLAIM, 'getClaimable', [loanId, true])]);
  const claims = ledger ? ledger[3].map((e) => ({ seller: e.seller, grossOwed: e.grossOwed })) : null;
  // The claim row's asset, when a close-out recorded one (`claimAsSeller`
  // withdraws that asset too when it differs from the principal).
  const claimAsset = row && row[0].toLowerCase() !== '0x0000000000000000000000000000000000000000' ? row[0] : null;
  const assets: Hex[] = [loan.principalAsset, ...(claimAsset && claimAsset.toLowerCase() !== loan.principalAsset.toLowerCase() ? [claimAsset] : [])];
  const final = splitFinal(Number(loan.status));
  const [amounts, share] = await Promise.all([
    Promise.all(assets.map((a) => read<bigint>(SELLER, 'getSellerInterestHeld', [loanId, seller, a]))),
    final && claims !== null && claims.length > 0 ? read<bigint>(SELLER, 'getSellersShareOfLenderClaim', [loanId]) : null,
  ]);
  const held = row === null || amounts.some((a) => a === null) ? null : assets.map((asset, i) => ({ asset, amount: amounts[i]! }));
  return { loanId, loan, claims, claimAsset, held, share };
}

/** The loans the index names under `seller` for any step of a seller claim,
 *  newest first, walked to its end or to the cap. Throws when the index does
 *  not answer, so the surface states that instead of an empty list. */
export async function discoverSoldLoans(indexer: IndexerClient, chainId: number, seller: Hex): Promise<{ loanIds: bigint[]; complete: boolean }> {
  const ids = new Set<string>();
  let before: string | null = null;
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
    const q = new URLSearchParams({ chainId: String(chainId), actor: seller, kind: SELLER_KINDS.join(','), limit: '100' });
    if (before) q.set('before', before);
    const res: { events?: { loanId: number | string | null }[]; nextBefore?: string | null } = await indexer.getJson(`/activity?${q.toString()}`);
    for (const e of res.events ?? []) if (e.loanId !== null && e.loanId !== undefined) ids.add(String(e.loanId));
    if (!res.nextBefore) return { loanIds: [...ids].map((s) => BigInt(s)), complete: true };
    before = res.nextBefore;
  }
  return { loanIds: [...ids].map((s) => BigInt(s)), complete: false };
}

/** The seller's open claims on the row, summed (a seller who sold twice can
 *  hold more than one, each in its place). */
export function mineGross(row: Pick<SellerRow, 'claims'>, seller: Hex): bigint | null {
  if (row.claims === null) return null;
  return row.claims.filter((e) => e.seller.toLowerCase() === seller.toLowerCase()).reduce((t, e) => t + e.grossOwed, 0n);
}

/** What the seller's open claims are owed after the loan's fee, each claim
 *  netted on its own and then summed, as the protocol ranks and closes them
 *  (netting the sum instead can state a unit more than is ever paid). Null
 *  when the loan or its claims could not be read. */
export function mineNet(row: Pick<SellerRow, 'claims' | 'loan'>, seller: Hex): bigint | null {
  if (row.claims === null || row.loan === null) return null;
  const fee = treasuryShareBps(row.loan).bps;
  return row.claims.filter((e) => e.seller.toLowerCase() === seller.toLowerCase()).reduce((t, e) => t + netOwed(e.grossOwed, fee), 0n);
}

/** The loan's fee on interest, as the split applies it. */
export function rowFeeBps(row: SellerRow): { bps: number; legacy: boolean } | null {
  return row.loan ? treasuryShareBps(row.loan) : null;
}

/** The seller's part of the split on an ended loan:
 *  - `exact`: the row is in the principal asset, so the split pays each
 *    claim its net owed in order until the share runs out, and the seller's
 *    part follows exactly from the total share;
 *  - `inKind`: the row is in another token, split by value when it runs;
 *  - `unknown`: an input could not be read;
 *  - null: no split applies (the loan is not final, or nothing is open). */
export type SplitPart = { kind: 'exact'; amount: bigint; unpaid: bigint } | { kind: 'inKind'; asset: Hex } | { kind: 'unknown' } | null;

export function splitPart(row: SellerRow, seller: Hex): SplitPart {
  if (row.loan === null || row.claims === null) return { kind: 'unknown' };
  if (!splitFinal(Number(row.loan.status))) return null;
  const mine = mineGross(row, seller) ?? 0n;
  if (mine === 0n) return null;
  if (row.share === null || row.held === null) return { kind: 'unknown' };
  const fee = treasuryShareBps(row.loan).bps;
  const asset = row.claimAsset;
  if (asset !== null && asset.toLowerCase() !== row.loan.principalAsset.toLowerCase()) return { kind: 'inKind', asset };
  let pool = row.share;
  let paid = 0n;
  let owed = 0n;
  for (const e of row.claims) {
    const net = netOwed(e.grossOwed, fee);
    const pay = net < pool ? net : pool;
    pool -= pay;
    if (e.seller.toLowerCase() === seller.toLowerCase()) {
      paid += pay;
      owed += net;
    }
  }
  return { kind: 'exact', amount: paid, unpaid: owed - paid };
}

/** What waits in the vault, summed per asset (zero rows left out). */
export function heldTotal(row: Pick<SellerRow, 'held'>): bigint | null {
  return row.held === null ? null : row.held.reduce((t, h) => t + h.amount, 0n);
}

/** Whether the row belongs on the seller's list: a claim still open, money
 *  waiting, or a read that failed (said so, never dropped). */
export function sellerRowShown(row: SellerRow, seller: Hex): boolean {
  if (row.loan === null || row.claims === null || row.held === null) return true;
  return (mineGross(row, seller) ?? 0n) > 0n || (heldTotal(row) ?? 0n) > 0n;
}

/**
 * RB-ELIG for `claimAsSeller`, in the order it checks: the protocol pause;
 * then whether anything pays now: money in the vault, or, on an ended loan,
 * the split's part for this seller. The sanctions screen is the dry run's.
 */
export function sellerVerdict(row: SellerRow, seller: Hex, paused: boolean | null, copy: Pick<CopyAccess, 'text'>, readAt: number): Verdict {
  const { text } = copy;
  const refuse = (code: string, reason: string, switchClass: '2' | null = null): Verdict =>
    closed([{ code, reason, reopensAt: null, remedy: null } satisfies Refusal], switchClass, readAt, 'own');
  if (paused === null) return unknownVerdict(text('sellerClaim.unread'));
  if (paused) return refuse('EnforcedPause', text('sellerClaim.paused'), '2');
  if (row.loan === null || row.claims === null || row.held === null) return unknownVerdict(text('sellerClaim.unread'));
  const held = heldTotal(row)!;
  const part = splitPart(row, seller);
  if (held > 0n) return { ...OPEN, readAt, rail: 'own' };
  if (part?.kind === 'unknown') return unknownVerdict(text('sellerClaim.unread'));
  if (part?.kind === 'inKind' || (part?.kind === 'exact' && part.amount > 0n)) return { ...OPEN, readAt, rail: 'own' };
  const status = Number(row.loan.status);
  const mine = mineGross(row, seller)!;
  if (mine === 0n) return refuse('NothingToClaimAsSeller', text('sellerClaim.nothing'));
  if (part?.kind === 'exact') return refuse('NothingToClaimAsSeller', text('sellerClaim.splitNothing'));
  if (status === FALLBACK) return refuse('NothingToClaimAsSeller', text('sellerClaim.fallbackWaits'));
  if (status === ACTIVE) return refuse('NothingToClaimAsSeller', text('sellerClaim.laterInterest'));
  return refuse('NothingToClaimAsSeller', text('sellerClaim.nothing'));
}

/** The whole row as a key: any change to what the review states reopens it. */
export function sellerRowKey(row: SellerRow): string {
  return [
    row.loan ? `${row.loan.status}:${row.loan.principalAsset}:${row.loan.treasuryFeeBpsAtInit}` : 'unread',
    row.claims ? row.claims.map((e) => `${e.seller.toLowerCase()}=${e.grossOwed}`).join(',') : 'unread',
    row.claimAsset ?? '-',
    row.held ? row.held.map((h) => `${h.asset.toLowerCase()}=${h.amount}`).join(',') : 'unread',
    row.share ?? '-',
  ].join('|');
}

/** The protocol pause, which stops `claimAsSeller`; null when unread. */
export async function readPaused(c: PublicClient, diamond: Hex, blockNumber?: bigint): Promise<boolean | null> {
  return answerOrNull(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused', ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<boolean>);
}

// ─── The transaction's own record ─────────────────────────────────────────

type Args = Record<string, unknown>;

export interface SellerClosed {
  netOwed: bigint;
  asset: Hex;
  paid: bigint;
  credited: bigint;
  fullyPaid: boolean;
}

/** What the transaction recorded for `seller` on `loanId`: the claims it
 *  closed at the split, and what it withdrew per asset. */
export function sellerLogs(logs: readonly Log[], diamond: Hex, loanId: bigint, seller: Hex): { closed: SellerClosed[]; withdrawn: SellerHeld[] } {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: SELLER, logs: [...own], strict: false }) as unknown as { eventName: string; args: Args }[];
  const mine = events.filter((e) => BigInt(String(e.args.loanId ?? -1)) === loanId && String(e.args.seller).toLowerCase() === seller.toLowerCase());
  return {
    closed: mine
      .filter((e) => e.eventName === 'SellerInterestClaimClosed')
      .map((e) => ({
        netOwed: BigInt(String(e.args.netOwed)),
        asset: e.args.asset as Hex,
        paid: BigInt(String(e.args.paid)),
        credited: BigInt(String(e.args.credited)),
        fullyPaid: Boolean(e.args.fullyPaid),
      })),
    withdrawn: mine.filter((e) => e.eventName === 'SellerInterestWithdrawn').map((e) => ({ asset: e.args.asset as Hex, amount: BigInt(String(e.args.amount)) })),
  };
}
