/**
 * `GET /assets/rankings?chainId=<token chain>` — the public market-cap
 * rankings of tokens on one chain, as the keeper's daily fetch last stored
 * them (#3446).
 *
 * WHAT IT IS FOR. The connected app sorts unfamiliar tokens into trust tiers
 * (blue chip, top 100 / 200 / 300 / 500, unranked) and warns on a name that
 * copies a ranked token's symbol. It cannot fetch the public lists itself:
 * their keys must stay off the client, and one fetch per day serves every
 * user. The keeper's `assetRankings` pass fetches them on the keeper machine
 * and writes migration 0087's two tables; this route only reads them.
 *
 * WHAT IT STATES — facts, never a verdict:
 *  - `assets`: every ranked token on the chain, one entry per address, with
 *    each source's rank, name and symbol kept apart. Two lists can name the
 *    same contract differently; merging them here would hide that.
 *  - `sources`: per source, the time of the list now stored (`listFetchedAt`,
 *    null when no list has ever been stored) and the LAST RUN, good or
 *    failed (`lastRun`, null before the first run). A failed run leaves the
 *    previous list in place, so the app can show "ranked as of <date>" and
 *    say a refresh failed, rather than presenting an old list as current.
 *  - The tier rule is the app's: this route carries ranks, not tiers, so a
 *    threshold change never needs a Worker deploy.
 *
 * `chainId` is the TOKEN's chain (1, 8453, 42161, ...), not a Vaipakam
 * deployment, and is required: there is no default chain for a token, and
 * defaulting would answer a question the caller did not ask.
 *
 * D1 only, dispatched before `resolveEnv` (index.ts) like `/health/ingest`.
 * Tolerates the previous schema: before 0087 is applied the tables do not
 * exist and the route answers 503 `unavailable`, never an empty list, so
 * the app cannot mistake "not stored yet" for "no ranked tokens".
 * Cached for an hour: the lists change once a day.
 */
import { redactedError } from '@vaipakam/lib/errorDescription';

/** The ranking sources migration 0087 admits, in display order. */
export const RANKING_SOURCES = ['cg', 'cp'] as const;
export type RankingSource = (typeof RANKING_SOURCES)[number];

/** The narrow D1 surface this route reads. */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

interface RankingRow {
  address: string;
  source: string;
  rank: number;
  name: string;
  symbol: string;
  fetched_at: number;
}

interface RunRow {
  source: string;
  fetched_at: number;
  row_count: number;
  ok: number;
  detail: string | null;
}

/** One source's view of one token. */
export interface SourceRank {
  rank: number;
  name: string;
  symbol: string;
}

export interface RankedAsset {
  /** Lowercase 0x address on the requested chain. */
  address: string;
  ranks: Partial<Record<RankingSource, SourceRank>>;
}

export interface SourceState {
  /** Unix seconds of the list now stored; null when none has been stored. */
  listFetchedAt: number | null;
  /** The last run, good or failed; null before the first run. */
  lastRun: { fetchedAt: number; ok: boolean; rowCount: number; detail: string | null } | null;
}

export interface AssetRankings {
  chainId: number;
  sources: Record<RankingSource, SourceState>;
  assets: RankedAsset[];
}

const HEADERS: HeadersInit = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
};

/** Largest chain id accepted: EIP-155 ids in use fit well inside this. */
const MAX_CHAIN_ID = 2 ** 53 - 1;

/** Parse the required `chainId` query parameter; null when absent or malformed. */
export function parseTokenChainId(raw: string | null): number | null {
  if (raw === null || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= MAX_CHAIN_ID ? id : null;
}

function isSource(s: string): s is RankingSource {
  return (RANKING_SOURCES as readonly string[]).includes(s);
}

/** Read one chain's rankings. Throws when the tables cannot be read. */
export async function readAssetRankings(db: D1Like, chainId: number): Promise<AssetRankings> {
  const [rows, runs] = await Promise.all([
    db
      .prepare('SELECT address, source, rank, name, symbol, fetched_at FROM asset_ranking WHERE chain_id = ? ORDER BY address, source')
      .bind(chainId)
      .all<RankingRow>(),
    db.prepare('SELECT source, fetched_at, row_count, ok, detail FROM asset_ranking_run WHERE chain_id = ?').bind(chainId).all<RunRow>(),
  ]);

  const sources = Object.fromEntries(RANKING_SOURCES.map((s) => [s, { listFetchedAt: null, lastRun: null } as SourceState])) as Record<
    RankingSource,
    SourceState
  >;
  for (const r of runs.results ?? []) {
    if (!isSource(r.source)) continue;
    sources[r.source].lastRun = { fetchedAt: r.fetched_at, ok: r.ok === 1, rowCount: r.row_count, detail: r.detail };
  }

  const byAddress = new Map<string, RankedAsset>();
  for (const r of rows.results ?? []) {
    if (!isSource(r.source)) continue;
    let asset = byAddress.get(r.address);
    if (!asset) {
      asset = { address: r.address, ranks: {} };
      byAddress.set(r.address, asset);
    }
    asset.ranks[r.source] = { rank: r.rank, name: r.name, symbol: r.symbol };
    // One run writes one source's whole list, so its rows share one time;
    // the latest is taken in case a replacement was ever left part-written.
    const prev = sources[r.source].listFetchedAt;
    if (prev === null || r.fetched_at > prev) sources[r.source].listFetchedAt = r.fetched_at;
  }

  return { chainId, sources, assets: [...byAddress.values()] };
}

/** The route. `db` is the shared D1 binding. */
export async function handleAssetRankings(req: Request, db: D1Like): Promise<Response> {
  const chainId = parseTokenChainId(new URL(req.url).searchParams.get('chainId'));
  if (chainId === null) {
    return new Response(JSON.stringify({ error: 'chainId is required: the token chain id, a positive integer' }), {
      status: 400,
      headers: HEADERS,
    });
  }
  try {
    return new Response(JSON.stringify(await readAssetRankings(db, chainId)), { headers: HEADERS });
  } catch (err) {
    // Before migration 0087 the tables are missing; any other read failure
    // is the same answer to the caller: the rankings cannot be stated now.
    console.error('[indexer] /assets/rankings read failed', redactedError(err));
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { ...HEADERS, 'Cache-Control': 'no-store' },
    });
  }
}
