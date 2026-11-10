/**
 * #3446 — a token's trust tier, from the public market rankings the keeper
 * stores once a day and the index serves (`GET /assets/rankings`), matched
 * by CONTRACT ADDRESS on the token's own network, never by name or symbol
 * (RB-ASSET-TRUST).
 *
 * The route states facts per source (each list's rank, name and symbol, the
 * time of the list it holds and its last run); the tier rule is here, so a
 * threshold change needs no Worker deploy. It is a display and a warning
 * only: whether the protocol treats a token as liquid stays the protocol's
 * own answer (its price feed and liquidity check), read beside it.
 *
 * The rule, in order:
 *  - A test token the deployment record publishes is a test token.
 *  - With no list stored for the network: a test network says its tokens
 *    have no market value; any other network says no ranking is stored.
 *  - A ranked address takes its best (lowest) rank across the lists. When
 *    another list ranks the same symbol at a different address and does not
 *    rank this one, while this list does not rank that one, the lists
 *    disagree on where the token lives: unverified.
 *  - Otherwise its tier: blue chip within the top {@link BLUE_CHIP_MAX_RANK}
 *    with a price feed the protocol holds for that exact address, then the
 *    top 100, 200, 300 and 500.
 *  - An unranked address whose symbol or name matches a ranked token's is a
 *    possible copy; any other is used at the reader's own risk.
 */
import type { Abi, PublicClient } from 'viem';
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { ORACLE } from './reads';

type Hex = `0x${string}`;

/** The lists the route carries, in display order. */
export const RANKING_SOURCES = ['cg', 'cp'] as const;
export type RankingSource = (typeof RANKING_SOURCES)[number];

/** A blue chip is ranked within this many tokens by market value and is
 *  priced by the protocol. */
export const BLUE_CHIP_MAX_RANK = 20;

/** The rank tiers past blue chip, by the highest rank each admits. */
const TIER_LIMITS = [
  ['top100', 100],
  ['top200', 200],
  ['top300', 300],
  ['top500', 500],
] as const;

export type RankTier = 'blueChip' | (typeof TIER_LIMITS)[number][0];

export interface SourceRank {
  rank: number;
  name: string;
  symbol: string;
}

export interface SourceState {
  /** Unix seconds of the list the index holds; null when it holds none. */
  listFetchedAt: number | null;
  /** The last refresh, good or failed; null before the first. */
  lastRun: { fetchedAt: number; ok: boolean } | null;
}

export interface AssetRankings {
  chainId: number;
  sources: Record<RankingSource, SourceState>;
  /** Lowercase address → each list's view of it. */
  byAddress: ReadonlyMap<string, Partial<Record<RankingSource, SourceRank>>>;
}

function shape(message: string): never {
  throw new IndexerUnavailable('shape', message);
}

const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function sourceState(v: unknown): SourceState {
  const s = v as Record<string, unknown> | null | undefined;
  if (!s || typeof s !== 'object') shape('The rankings did not say which lists the index holds.');
  if (s.listFetchedAt !== null && !isSeconds(s.listFetchedAt)) shape('A ranking list carried no readable date.');
  let lastRun: SourceState['lastRun'] = null;
  if (s.lastRun !== null) {
    const r = s.lastRun as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object' || !isSeconds(r.fetchedAt) || typeof r.ok !== 'boolean') shape('A ranking list carried no readable refresh.');
    lastRun = { fetchedAt: r.fetchedAt as number, ok: r.ok as boolean };
  }
  return { listFetchedAt: s.listFetchedAt as number | null, lastRun };
}

function sourceRank(v: unknown): SourceRank {
  const r = v as Record<string, unknown> | null | undefined;
  if (
    !r ||
    typeof r !== 'object' ||
    !Number.isSafeInteger(r.rank) ||
    (r.rank as number) < 1 ||
    (r.rank as number) > 500 ||
    typeof r.name !== 'string' ||
    typeof r.symbol !== 'string'
  ) {
    shape('A ranked token carried no readable rank, name or symbol.');
  }
  return { rank: r.rank as number, name: r.name as string, symbol: r.symbol as string };
}

/** One network's rankings. Throws the index's own failure, or a shape
 *  failure when the answer is not for the network asked about. */
export async function readAssetRankings(indexer: IndexerClient, chainId: number): Promise<AssetRankings> {
  const body = await indexer.getJson<{ chainId?: unknown; sources?: unknown; assets?: unknown }>(`/assets/rankings?chainId=${chainId}`);
  if (body.chainId !== chainId) shape('The index answered for another network.');
  const src = body.sources as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') shape('The rankings did not say which lists the index holds.');
  const sources = Object.fromEntries(RANKING_SOURCES.map((s) => [s, sourceState(src[s])])) as Record<RankingSource, SourceState>;
  if (!Array.isArray(body.assets)) shape('The rankings carried no token list.');
  const byAddress = new Map<string, Partial<Record<RankingSource, SourceRank>>>();
  for (const raw of body.assets as Record<string, unknown>[]) {
    const address = typeof raw?.address === 'string' ? raw.address.toLowerCase() : '';
    if (!/^0x[0-9a-f]{40}$/.test(address)) shape('A ranked token carried no readable address.');
    const ranks = raw.ranks as Record<string, unknown> | undefined;
    if (!ranks || typeof ranks !== 'object') shape('A ranked token carried no ranks.');
    const entry: Partial<Record<RankingSource, SourceRank>> = {};
    for (const s of RANKING_SOURCES) if (ranks[s] !== undefined) entry[s] = sourceRank(ranks[s]);
    if (Object.keys(entry).length > 0) byAddress.set(address, entry);
  }
  return { chainId, sources, byAddress };
}

/** Whether the protocol holds a price feed for `asset` itself
 *  (`getAssetPriceStatus` answering priced). */
export async function readPriced(client: PublicClient, diamond: Hex, asset: Hex): Promise<boolean> {
  const [status] = (await client.readContract({ address: diamond, abi: ORACLE as Abi, functionName: 'getAssetPriceStatus', args: [asset] })) as readonly [
    number,
    bigint,
    number,
  ];
  return Number(status) === 0;
}

/** A ranked token as one list names it. */
export interface RankedRef {
  address: string;
  source: RankingSource;
  rank: number;
  name: string;
  symbol: string;
}

export type Trust =
  | { kind: 'test' }
  | { kind: 'testNetwork' }
  | { kind: 'noList' }
  | { kind: 'ranked'; tier: RankTier; best: RankedRef }
  | { kind: 'unverified'; best: RankedRef; other: RankedRef }
  | { kind: 'copy'; of: RankedRef }
  | { kind: 'unranked' };

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** The sources whose list the index holds. */
export function storedSources(r: AssetRankings): RankingSource[] {
  return RANKING_SOURCES.filter((s) => r.sources[s].listFetchedAt !== null);
}

/** The best (lowest) rank an address holds, with the list that gives it. */
function bestRank(address: string, entry: Partial<Record<RankingSource, SourceRank>>): RankedRef | null {
  let best: RankedRef | null = null;
  for (const s of RANKING_SOURCES) {
    const v = entry[s];
    if (v && (best === null || v.rank < best.rank)) best = { address, source: s, ...v };
  }
  return best;
}

/** The tier a rank earns; blue chip only with the protocol's own price. */
export function rankTier(rank: number, priced: boolean | null): RankTier {
  if (rank <= BLUE_CHIP_MAX_RANK && priced === true) return 'blueChip';
  for (const [tier, max] of TIER_LIMITS) if (rank <= max) return tier;
  return 'top500';
}

/** Where another list puts this address's symbol instead, when the lists
 *  disagree; null when they agree or only one list knows it. */
function disagreement(r: AssetRankings, address: string, entry: Partial<Record<RankingSource, SourceRank>>): RankedRef | null {
  for (const s of RANKING_SOURCES) {
    const mine = entry[s];
    if (!mine) continue;
    for (const o of storedSources(r)) {
      if (o === s || entry[o]) continue;
      for (const [other, otherEntry] of r.byAddress) {
        const theirs = otherEntry[o];
        if (other !== address && theirs && norm(theirs.symbol) === norm(mine.symbol) && !otherEntry[s]) return { address: other, source: o, ...theirs };
      }
    }
  }
  return null;
}

/** The best-ranked token whose symbol or name `symbol` / `name` matches. */
function copied(r: AssetRankings, symbol: string | null, name: string | null): RankedRef | null {
  const sym = norm(symbol);
  const nm = norm(name);
  if (sym === '' && nm === '') return null;
  let best: RankedRef | null = null;
  for (const [address, entry] of r.byAddress) {
    for (const s of RANKING_SOURCES) {
      const v = entry[s];
      if (!v) continue;
      const hit = (sym !== '' && (norm(v.symbol) === sym || norm(v.name) === sym)) || (nm !== '' && (norm(v.name) === nm || norm(v.symbol) === nm));
      if (hit && (best === null || v.rank < best.rank)) best = { address, source: s, ...v };
    }
  }
  return best;
}

export function classifyAsset(input: {
  address: string;
  rankings: AssetRankings;
  testnet: boolean;
  /** A test token the deployment record publishes. */
  testToken: boolean;
  /** Whether the protocol prices this address; null when unread. */
  priced: boolean | null;
  symbol: string | null;
  name: string | null;
}): Trust {
  const { rankings: r } = input;
  if (input.testToken) return { kind: 'test' };
  if (storedSources(r).length === 0) return input.testnet ? { kind: 'testNetwork' } : { kind: 'noList' };
  const address = input.address.toLowerCase();
  const entry = r.byAddress.get(address);
  const best = entry ? bestRank(address, entry) : null;
  if (entry && best) {
    const other = disagreement(r, address, entry);
    if (other) return { kind: 'unverified', best, other };
    return { kind: 'ranked', tier: rankTier(best.rank, input.priced), best };
  }
  const of = copied(r, input.symbol, input.name);
  return of ? { kind: 'copy', of } : { kind: 'unranked' };
}

/** The date of the list a statement rests on, and a later failed refresh
 *  when there is one, so an old list is never presented as current. */
export function listAge(r: AssetRankings, source: RankingSource): { asOf: number; failedAt: number | null } | null {
  const s = r.sources[source];
  if (s.listFetchedAt === null) return null;
  const failedAt = s.lastRun && !s.lastRun.ok && s.lastRun.fetchedAt > s.listFetchedAt ? s.lastRun.fetchedAt : null;
  return { asOf: s.listFetchedAt, failedAt };
}

/** What the reader is told about one list a verdict rests on: the date
 *  of the stored list with any later failed refresh, or, for a list the
 *  index has never stored, the failed fetch that left it out. */
export type ListStatus =
  | { source: RankingSource; kind: 'stored'; asOf: number; failedAt: number | null }
  | { source: RankingSource; kind: 'unread'; failedAt: number };

/** Every list a verdict rests on, in list order. Every verdict but a test
 *  token's reads every stored list (the best rank, the agreement check and
 *  the copy match all look across both), so each one's date and any failed
 *  refresh is stated; a list never stored whose fetch failed is named as
 *  left out, so a verdict from one list does not read as from two. */
export function listStatuses(r: AssetRankings): ListStatus[] {
  const out: ListStatus[] = [];
  for (const source of RANKING_SOURCES) {
    const age = listAge(r, source);
    if (age) out.push({ source, kind: 'stored', ...age });
    else {
      const run = r.sources[source].lastRun;
      if (run && !run.ok) out.push({ source, kind: 'unread', failedAt: run.fetchedAt });
    }
  }
  return out;
}

/** A search hit: one ranked token, with its tier before the price is read. */
export interface SearchHit {
  address: string;
  best: RankedRef;
}

/** Ranked tokens whose symbol or name contains `query`, best rank first;
 *  an exact symbol match leads at the same rank. Matching by name is for
 *  finding, never for trusting: each hit shows its full address. */
export function searchRanked(r: AssetRankings, query: string, limit = 8): SearchHit[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const hits: (SearchHit & { exact: boolean })[] = [];
  for (const [address, entry] of r.byAddress) {
    const names = RANKING_SOURCES.flatMap((s) => (entry[s] ? [norm(entry[s].symbol), norm(entry[s].name)] : []));
    if (!names.some((n) => n.includes(q))) continue;
    const best = bestRank(address, entry);
    if (best) hits.push({ address, best, exact: names.includes(q) });
  }
  hits.sort((a, b) => a.best.rank - b.best.rank || Number(b.exact) - Number(a.exact) || a.address.localeCompare(b.address));
  return hits.slice(0, limit).map(({ address, best }) => ({ address, best }));
}
