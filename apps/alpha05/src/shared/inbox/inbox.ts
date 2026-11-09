/**
 * The wallet's inbox (#3180 Alerts, ACC-54, RB-INBOX): the free, in-app
 * alerts the protocol's index keeps for a wallet on one network
 * (`GET /notifications/:address?chainId&limit&before`), newest first. The
 * index writes one row per recipient when a loan starts, is repaid in part
 * or in full, defaults or is liquidated, nears its due date, enters or
 * leaves its grace period, or crosses a health band, and when a reward
 * entry nears or reaches its claim deadline. A row is a pointer, never a
 * figure: the page each row opens reads the loan from the chain.
 *
 * Every answer is checked against what was asked (the network and the
 * wallet); a row whose shape cannot be read is counted and the count stated,
 * never dropped in silence. A kind this app has no words for is kept and
 * shown as such.
 */
import { isReconciledNotification } from '@vaipakam/lib/notificationProvenance';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

/** Rows per page; the first page also feeds the header's count. */
export const INBOX_PAGE = 50;

export const INBOX_KINDS = [
  'loan_matched',
  'partial_repay',
  'loan_repaid',
  'loan_defaulted',
  'internal_matched',
  'loan_ended',
  'maturity_7d',
  'maturity_1d',
  'grace_entered',
  'grace_ended',
  'hf_warn',
  'hf_alert',
  'hf_critical',
  'reward_final_notice',
  'reward_expired',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxRow {
  /** The index's row id: assigned in the order rows are written and never
   *  reused, so "newer than the last one seen" is `id > seen`, whatever
   *  block a row is stamped with. */
  id: number;
  /** The kind, or null for a kind this app has no words for (`rawKind` keeps it). */
  kind: InboxKind | null;
  rawKind: string;
  loanId: bigint | null;
  /** Unix seconds the index stamped (the block time for a chain event). */
  createdAt: number;
  /** The reward entry a reward row names. */
  entryId: string | null;
  /** True for a row the index wrote when a check found an outcome no event
   *  had announced: `createdAt` is then when it found out, not when the
   *  outcome happened, and the row says so. */
  reconciled: boolean;
}

export interface InboxPage {
  rows: InboxRow[];
  /** The cursor for the next (older) page; null at the end. */
  nextBefore: string | null;
  /** Rows on this page whose shape could not be read. */
  unreadable: number;
  /** The ids of those unreadable rows whose id itself could be read, so the
   *  page can tell a new row it could not show from one not yet loaded. */
  unreadableIds: number[];
}

const KINDS = new Set<string>(INBOX_KINDS);
const MAX_DATE_SECONDS = 8_640_000_000_000;

function wholeNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** One row, or null when its shape cannot be read. */
export function parseInboxRow(raw: unknown): InboxRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = wholeNumber(r.id);
  const createdAt = wholeNumber(r.createdAt);
  // A time past what a date can hold is no time this row can be shown with.
  if (id === null || createdAt === null || createdAt > MAX_DATE_SECONDS || typeof r.kind !== 'string' || r.kind.length === 0) return null;
  let loanId: bigint | null = null;
  if (r.loanId !== null && r.loanId !== undefined) {
    const n = typeof r.loanId === 'string' && /^\d+$/.test(r.loanId) ? BigInt(r.loanId) : wholeNumber(r.loanId) !== null ? BigInt(r.loanId as number) : null;
    if (n === null) return null;
    loanId = n;
  }
  const kind = KINDS.has(r.kind) ? (r.kind as InboxKind) : null;
  const reward = kind === 'reward_final_notice' || kind === 'reward_expired';
  const data = typeof r.data === 'object' && r.data !== null ? (r.data as Record<string, unknown>) : null;
  const entry = data?.entryId;
  const entryId = typeof entry === 'string' && /^\d+$/.test(entry) ? entry : wholeNumber(entry) !== null ? String(entry) : null;
  // A loan row names its loan and a reward row its entry; one that does not
  // has nothing to point at.
  if (kind !== null && !reward && loanId === null) return null;
  if (reward && entryId === null) return null;
  return { id, kind, rawKind: r.kind, loanId, createdAt, entryId, reconciled: isReconciledNotification(typeof r.eventKind === 'string' ? r.eventKind : null) };
}

/** One page of `account`'s inbox on `chainId`, newest first. Throws
 *  {@link IndexerUnavailable} when the index does not answer, or answers for
 *  another network or wallet. */
export async function readInboxPage(indexer: IndexerClient, chainId: number, account: Hex, before: string | null = null, limit = INBOX_PAGE): Promise<InboxPage> {
  const q = new URLSearchParams({ chainId: String(chainId), limit: String(limit) });
  if (before !== null) q.set('before', before);
  const res: { chainId?: unknown; address?: unknown; notifications?: unknown; nextBefore?: unknown } = await indexer.getJson(
    `/notifications/${account.toLowerCase()}?${q.toString()}`,
  );
  if (res.chainId !== chainId || typeof res.address !== 'string' || res.address.toLowerCase() !== account.toLowerCase() || !Array.isArray(res.notifications)) {
    throw new IndexerUnavailable('shape', 'The index answered for another network or wallet.');
  }
  const nextBefore =
    res.nextBefore === null || res.nextBefore === undefined ? null : typeof res.nextBefore === 'string' && /^\d+:\d+:\d+$/.test(res.nextBefore) ? res.nextBefore : undefined;
  if (nextBefore === undefined) throw new IndexerUnavailable('shape', 'The index’s page cursor could not be read.');
  const rows: InboxRow[] = [];
  let unreadable = 0;
  const unreadableIds: number[] = [];
  for (const raw of res.notifications) {
    const row = parseInboxRow(raw);
    if (row !== null) {
      rows.push(row);
      continue;
    }
    unreadable++;
    const id = typeof raw === 'object' && raw !== null ? wholeNumber((raw as Record<string, unknown>).id) : null;
    if (id !== null) unreadableIds.push(id);
  }
  return { rows, nextBefore, unreadable, unreadableIds };
}

export interface InboxNewer {
  /** How many of the wallet's rows have an id above the one asked about. */
  count: number;
  /** True when the index stopped counting at its cap: "at least". */
  capped: boolean;
  /** The wallet's newest row id (0 when it has none). */
  newestId: number;
}

/** How many of `account`'s rows on `chainId` the index wrote after row
 *  `seen`, and its newest id. Counted by the index over every row, not
 *  from a page: ids follow write order and pages follow chain order, so a
 *  row stamped with an older block can be new while sorting below the
 *  first page. Throws {@link IndexerUnavailable} when the index does not
 *  answer, answers for another network or wallet, or leaves the count out
 *  (an index that predates it). */
export async function readInboxNewer(indexer: IndexerClient, chainId: number, account: Hex, seen: number): Promise<InboxNewer> {
  const q = new URLSearchParams({ chainId: String(chainId), limit: '1', newerThan: String(seen) });
  const res: { chainId?: unknown; address?: unknown; newerThan?: unknown } = await indexer.getJson(`/notifications/${account.toLowerCase()}?${q.toString()}`);
  if (res.chainId !== chainId || typeof res.address !== 'string' || res.address.toLowerCase() !== account.toLowerCase()) {
    throw new IndexerUnavailable('shape', 'The index answered for another network or wallet.');
  }
  const n = typeof res.newerThan === 'object' && res.newerThan !== null ? (res.newerThan as Record<string, unknown>) : null;
  const count = wholeNumber(n?.count);
  const newestId = wholeNumber(n?.newestId);
  if (n === null || n.id !== seen || count === null || newestId === null || typeof n.capped !== 'boolean') {
    throw new IndexerUnavailable('shape', 'The index did not count the new alerts.');
  }
  return { count, capped: n.capped, newestId };
}

/** Where a row points: its loan's page, or Claims for a reward entry. */
export function inboxTarget(row: InboxRow): string | null {
  if (row.kind === 'reward_final_notice' || row.kind === 'reward_expired') return '/claims';
  return row.loanId === null ? null : `/positions/${row.loanId.toString()}`;
}
