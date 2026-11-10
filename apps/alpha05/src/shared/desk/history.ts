/**
 * OFF-76 — the connected wallet's desk history, from the index (the world
 * rail, RB-RAILS): every token loan against token collateral the wallet has
 * ever held a side of, any status, newest participation first.
 *
 * The index keeps an append-only record of who held each side of a loan
 * (written when the loan opens and on every position transfer, never
 * deleted), so a loan the wallet lent, was repaid on and collected from
 * still appears here after its position is gone. The desk scope leaves out
 * NFT legs and the bookkeeping loan a lender's sale opens; this reader
 * checks every row against that scope again and counts a row outside it as
 * unread instead of showing it.
 *
 * The status is the index's record, which can trail the chain: each row
 * opens its loan, whose page reads the chain before it states or offers
 * anything.
 */
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { wireBig, wireWhole } from '../reads/world/wire';

type Hex = `0x${string}`;
type Json = Record<string, unknown>;

/** How many loans one page of history reads. */
export const HISTORY_PAGE = 20;

/** The loan statuses the index records, in the words the desk uses for
 *  them; any other value reads as `unknown`. */
export const HISTORY_STATUSES = ['active', 'repaid', 'defaulted', 'liquidated', 'settled', 'internal_matched', 'fallback_pending'] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number] | 'unknown';

export interface HistoryRow {
  loanId: bigint;
  lending: Hex;
  collateral: Hex;
  /** The term the loan was agreed at, in days, which names its market:
   *  the index's `marketDurationDays`, set only when the chain's own record
   *  backs the opening terms. Null when it does not, so the loan belongs to
   *  no market here. Never the live term, which an extension rewrites. */
  marketDays: number | null;
  /** The sides the wallet has held on this loan. */
  lent: boolean;
  borrowed: boolean;
  status: HistoryStatus;
  /** When the index last saw the wallet take a side of this loan, Unix
   *  seconds. */
  participatedAt: number;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Rows the index returned that could not be read here, or that are not
   *  desk loans. */
  unread: number;
  /** The cursor for the next older page; null when the index returned no
   *  row past this page, so there is none. */
  next: string | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Reads one history row, or throws when it is not a desk loan the wallet
 *  held a side of. */
export function historyRowFrom(o: Json): HistoryRow {
  if (o.assetType !== 0 || o.collateralAssetType !== 0) throw new Error('not a token loan against token collateral');
  if (o.isSaleVehicle !== false) throw new Error('a sale vehicle');
  const lending = String(o.lendingAsset);
  const collateral = String(o.collateralAsset);
  if (!ADDRESS.test(lending) || !ADDRESS.test(collateral)) throw new Error('no market');
  const marketDays = o.marketDurationDays === null ? null : wireWhole(o.marketDurationDays);
  if (marketDays !== null && marketDays < 1) throw new Error('no term');
  const roles = Array.isArray(o.roles) ? o.roles : [];
  const lent = roles.includes('lender');
  const borrowed = roles.includes('borrower');
  if (!lent && !borrowed) throw new Error('no side held');
  const raw = String(o.status);
  const status = (HISTORY_STATUSES as readonly string[]).includes(raw) ? (raw as HistoryStatus) : 'unknown';
  return {
    loanId: wireBig(o.loanId),
    lending: lending.toLowerCase() as Hex,
    collateral: collateral.toLowerCase() as Hex,
    marketDays,
    lent,
    borrowed,
    status,
    participatedAt: wireWhole(o.participatedAt),
  };
}

/** One page of the wallet's desk history, newest participation first,
 *  starting below `before` (a cursor this reader returned). It asks for one
 *  row past the page: only a row the index actually returns proves an older
 *  page exists, and the cursor to it is the last shown row's. Throws the
 *  index's own failure, or a shape failure. */
export async function readHistoryPage(indexer: IndexerClient, chainId: number, wallet: Hex, before: string | null): Promise<HistoryPage> {
  const q = new URLSearchParams({ chainId: String(chainId), wallet: wallet.toLowerCase(), scope: 'desk', limit: String(HISTORY_PAGE + 1) });
  if (before !== null) q.set('before', before);
  const body = await indexer.getJson<{ wallet?: unknown; loans?: unknown }>(`/loans/by-participant?${q.toString()}`);
  if (!Array.isArray(body.loans) || String(body.wallet).toLowerCase() !== wallet.toLowerCase()) {
    throw new IndexerUnavailable('shape', 'The index did not read this wallet’s loans.');
  }
  const page = body.loans.slice(0, HISTORY_PAGE) as Json[];
  const rows: HistoryRow[] = [];
  let unread = 0;
  for (const raw of page) {
    try {
      rows.push(historyRowFrom(raw));
    } catch {
      unread += 1;
    }
  }
  let next: string | null = null;
  if (body.loans.length > HISTORY_PAGE) {
    // The index's cursor is the last row's participation time and loan id;
    // the next page starts strictly below it.
    const last = page[page.length - 1]!;
    try {
      next = `${wireWhole(last.participatedAt)}_${wireBig(last.loanId)}`;
    } catch {
      throw new IndexerUnavailable('shape', 'The index answered without a place to read older loans from.');
    }
  }
  return { rows, unread, next };
}
