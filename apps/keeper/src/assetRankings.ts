/**
 * assetRankings.ts — once a UTC day, the top 500 tokens by market-cap rank on
 * each mainnet chain, from two public market-data sources, keyed by contract
 * address (#3446).
 *
 * The app shows each ERC-20 asset's trust tier (blue chip, top 100 … top 500)
 * and warns beyond it. It reads the tier off-chain from `asset_ranking`, which
 * this pass writes. The owner's decision (#3446, 2026-11-09):
 *   - the rank is matched by CONTRACT ADDRESS ON THE CHAIN, never by name or
 *     symbol, so a look-alike token never inherits a listed token's rank;
 *   - two independent sources are kept side by side, so a wrong or spoofed
 *     listing in one shows up as a disagreement instead of a tier;
 *   - display and warning only — nothing on-chain reads these rows.
 * The fetch runs here, on the keeper machine, rather than in the agent Worker
 * (owner decision on the #3446 card): the agent's 10 ms CPU limit cannot parse
 * a 4 MB coin list.
 *
 * ── What one run does ────────────────────────────────────────────────
 *
 * For each source, it fetches the ranked list once, then maps each ranked coin
 * to its contract address on each chain:
 *   - `cg`: the markets list, 250 a page, two pages, ordered by market cap, for
 *     `market_cap_rank`; then `/coins/list?include_platform=true` for every
 *     coin's address per asset platform.
 *   - `cp`: `/v1/tickers` for `rank`; then `/v1/contracts/<platform>` per chain.
 * A source-and-chain pair is due when its last run did not succeed today
 * (UTC). The pass is scheduled hourly, so a failed or missed fetch is retried
 * the next hour, and a pair that succeeded waits for the next UTC day.
 *
 * ── What it writes, and what it never writes ─────────────────────────
 *
 * A good run replaces the pair's rows and upserts its `asset_ranking_run` row
 * (ok = 1) in ONE D1 batch, so a reader sees the old list or the new one,
 * never a half-written one. Every row of one run carries the same
 * `fetched_at`.
 *
 * A failed run writes only the run row: ok = 0, the attempt's time and a short
 * reason. The pair's ranked rows are kept, and `row_count` keeps describing
 * them, so the app can say "last good list from <date>" and why today's
 * failed. A run is REFUSED, and treated as failed, when:
 *   - the ranked list is short (fewer than {@link MIN_RANKED} of the top 500),
 *     which would otherwise replace a full list with a truncated one;
 *   - a chain maps to no addresses at all, which means a wrong platform id or
 *     a changed response shape, not a chain with no tokens. Writing it would
 *     tell the app that every asset on the chain is unranked.
 *
 * Nothing here signs or sends a transaction. The pass reads two public HTTP
 * APIs without a key and writes two shared tables the app reads.
 *
 * Gated by KEEPER_ENABLED + ASSET_RANKINGS_ENABLED. Ships disarmed.
 */
import type { Env } from './env';
import type { PassTick } from './passSchedule';
import { passIsArmed } from './keeper';
import { D1_MAX_BOUND_PARAMETERS } from '@vaipakam/lib/d1Binds';
import { redactedError } from '@vaipakam/lib/errorDescription';

/** Hourly: one attempt a day per pair, and an hour between retries. */
export const PASS_CADENCE_SEC = 60 * 60;

/** How deep the ranking goes. */
export const RANKING_DEPTH = 500;

/** The fewest ranked coins (rank 1..{@link RANKING_DEPTH}) a list must carry
 *  before it may replace the stored one. A full list carries close to 500; a
 *  page that failed silently carries 250 or fewer. */
export const MIN_RANKED = 400;

/** Longest a single response body may be. The coin list is about 4 MB; the
 *  cap only bounds a body that is wrong, on a machine with under 1 GB. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Per-request timeout. */
const FETCH_TIMEOUT_MS = 30_000;

/** Longest stored name and symbol, in characters. */
export const MAX_NAME_CHARS = 100;
export const MAX_SYMBOL_CHARS = 32;

/** Longest stored failure reason. */
const MAX_DETAIL_CHARS = 300;

export type RankingSource = 'cg' | 'cp';
export const RANKING_SOURCES: readonly RankingSource[] = ['cg', 'cp'];

/**
 * The chains ranked, with each source's own id for the chain. Mainnets only:
 * the app shows testnet tokens as test tokens, and neither source ranks them.
 *
 * `cg` ids are CoinGecko asset platform ids (the keys of a coin's
 * `platforms`); `liquidityConfidence.ts` uses the same ids for five of these
 * chains. `cp` ids are CoinPaprika contract platform ids (`/v1/contracts`).
 * A wrong id maps no coin at all, which the run refuses and reports by name
 * rather than writing an empty list.
 */
export interface RankingChain {
  readonly chainId: number;
  readonly name: string;
  readonly cg: string;
  readonly cp: string;
}

export const RANKING_CHAINS: readonly RankingChain[] = [
  { chainId: 1, name: 'Ethereum', cg: 'ethereum', cp: 'eth-ethereum' },
  { chainId: 8453, name: 'Base', cg: 'base', cp: 'base-base' },
  { chainId: 42161, name: 'Arbitrum', cg: 'arbitrum-one', cp: 'arb-arbitrum' },
  { chainId: 137, name: 'Polygon', cg: 'polygon-pos', cp: 'matic-polygon' },
  { chainId: 10, name: 'Optimism', cg: 'optimistic-ethereum', cp: 'op-optimism' },
  { chainId: 56, name: 'BNB Chain', cg: 'binance-smart-chain', cp: 'bnb-binance-coin' },
];

const CG_API = 'https://api.coingecko.com/api/v3';
const CP_API = 'https://api.coinpaprika.com/v1';

/** One coin in a source's ranked list. */
export interface RankedCoin {
  readonly id: string;
  readonly rank: number;
  readonly name: string;
  readonly symbol: string;
}

/** One stored row for one chain. */
export interface RankingRow {
  readonly address: string;
  readonly rank: number;
  readonly name: string;
  readonly symbol: string;
}

/** A run the pass refuses to write as a list. The message is the reason
 *  stored on the run row. */
export class RankingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RankingRefusal';
  }
}

/** A request that did not return a usable body. The message names the path
 *  and the failure (never a header), and is the reason stored on the run row. */
export class SourceFetchError extends Error {
  constructor(path: string, what: string) {
    super(`${what} (${path})`);
    this.name = 'SourceFetchError';
  }
}

// ─── Pure parsing ────────────────────────────────────────────────────

/**
 * Characters never stored in a name or symbol: C0 and C1 controls, and the
 * bidirectional overrides and isolates, which can make one name render as
 * another. Zero-width characters too, for the same reason.
 */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** A name or symbol as stored: unsafe characters removed, trimmed, and capped
 *  at `max` characters (code points). Not escaped: the app escapes on render. */
export function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(UNSAFE_TEXT, '').trim();
  return Array.from(cleaned).slice(0, max).join('');
}

/** A rank in 1..{@link RANKING_DEPTH}, or null. */
function rankOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= RANKING_DEPTH ? raw : null;
}

/** A coin id as the sources write them: short, printable, no spaces. */
function idOf(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(raw) ? raw : null;
}

/**
 * Collect ranked coins, one per id, keeping the lower rank when an id repeats
 * (a coin that moved between two pages fetched a moment apart). Entries
 * without a usable id or a rank in range are skipped.
 */
function collectRanked(
  entries: Iterable<unknown>,
  rankField: 'market_cap_rank' | 'rank',
): RankedCoin[] {
  const byId = new Map<string, RankedCoin>();
  for (const e of entries) {
    if (e === null || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    const id = idOf(rec.id);
    const rank = rankOf(rec[rankField]);
    if (id === null || rank === null) continue;
    const prev = byId.get(id);
    if (prev !== undefined && prev.rank <= rank) continue;
    byId.set(id, {
      id,
      rank,
      name: cleanText(rec.name, MAX_NAME_CHARS),
      symbol: cleanText(rec.symbol, MAX_SYMBOL_CHARS),
    });
  }
  return [...byId.values()].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
}

/** Refuse a ranked list too short to replace a stored one. */
export function requireFullRanking(source: RankingSource, ranked: readonly RankedCoin[]): void {
  if (ranked.length < MIN_RANKED) {
    throw new RankingRefusal(
      `${source} ranked list short: ${ranked.length} coins ranked 1-${RANKING_DEPTH}, need at least ${MIN_RANKED}`,
    );
  }
}

/** The `cg` ranked list from its markets pages (each page an array). */
export function parseCgMarkets(pages: readonly unknown[]): RankedCoin[] {
  const entries: unknown[] = [];
  for (const [i, page] of pages.entries()) {
    if (!Array.isArray(page)) throw new RankingRefusal(`cg markets page ${i + 1} is not a list`);
    entries.push(...page);
  }
  return collectRanked(entries, 'market_cap_rank');
}

/** The `cp` ranked list from `/v1/tickers`. */
export function parseCpTickers(body: unknown): RankedCoin[] {
  if (!Array.isArray(body)) throw new RankingRefusal('cp tickers is not a list');
  return collectRanked(body, 'rank');
}

/** A contract address as stored: lowercase `0x` + 40 hex, never zero. */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const a = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  if (/^0x0{40}$/.test(a)) return null;
  return a;
}

/**
 * `cg`'s address pairs per platform, from `/coins/list?include_platform=true`,
 * for the ranked coins only: `platform → [coinId, address][]`.
 */
export function parseCgPlatforms(
  body: unknown,
  rankedIds: ReadonlySet<string>,
  platforms: readonly string[],
): Map<string, [string, string][]> {
  if (!Array.isArray(body)) throw new RankingRefusal('cg coin list is not a list');
  const wanted = new Set(platforms);
  const out = new Map<string, [string, string][]>(platforms.map((p) => [p, []]));
  for (const e of body) {
    if (e === null || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    const id = idOf(rec.id);
    if (id === null || !rankedIds.has(id)) continue;
    const plats = rec.platforms;
    if (plats === null || typeof plats !== 'object') continue;
    for (const [platform, raw] of Object.entries(plats as Record<string, unknown>)) {
      if (!wanted.has(platform)) continue;
      const address = normalizeAddress(raw);
      if (address !== null) out.get(platform)!.push([id, address]);
    }
  }
  return out;
}

/** `cp`'s address pairs for one platform, from `/v1/contracts/<platform>`,
 *  for the ranked coins only. An entry marked inactive is skipped. */
export function parseCpContracts(body: unknown, rankedIds: ReadonlySet<string>): [string, string][] {
  if (!Array.isArray(body)) throw new RankingRefusal('cp contracts is not a list');
  const out: [string, string][] = [];
  for (const e of body) {
    if (e === null || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    if (rec.active === false) continue;
    const id = idOf(rec.id);
    if (id === null || !rankedIds.has(id)) continue;
    const address = normalizeAddress(rec.address);
    if (address !== null) out.push([id, address]);
  }
  return out;
}

/**
 * One chain's rows: each address with its coin's rank, name and symbol. An
 * address claimed by two ranked coins keeps the lower rank (ties: the lower
 * coin id, so the choice does not depend on response order). A chain with no
 * address at all is refused (see the header).
 */
export function buildChainRows(
  source: RankingSource,
  chain: RankingChain,
  ranked: readonly RankedCoin[],
  pairs: readonly (readonly [string, string])[],
): RankingRow[] {
  const coins = new Map(ranked.map((c) => [c.id, c]));
  const best = new Map<string, RankedCoin>();
  for (const [id, address] of pairs) {
    const coin = coins.get(id);
    if (coin === undefined) continue;
    const prev = best.get(address);
    if (prev !== undefined && (prev.rank < coin.rank || (prev.rank === coin.rank && prev.id <= coin.id))) continue;
    best.set(address, coin);
  }
  if (best.size === 0) {
    const platform = source === 'cg' ? chain.cg : chain.cp;
    throw new RankingRefusal(`${source} mapped no ranked coin to an address on ${chain.name} (platform ${platform})`);
  }
  return [...best.entries()]
    .map(([address, c]) => ({ address, rank: c.rank, name: c.name, symbol: c.symbol }))
    .sort((a, b) => a.rank - b.rank || (a.address < b.address ? -1 : 1));
}

// ─── Due rule ────────────────────────────────────────────────────────

/** The stored run row of one pair, as the due rule reads it. */
export interface RunState {
  readonly source: string;
  readonly chainId: number;
  readonly fetchedAt: number;
  readonly ok: number;
}

const DAY_SEC = 86_400;

/** Whether a pair is due at `nowSec`: due unless its last run succeeded in the
 *  same UTC day. */
export function isPairDue(state: RunState | undefined, nowSec: number): boolean {
  if (state === undefined || state.ok !== 1) return true;
  return Math.floor(state.fetchedAt / DAY_SEC) !== Math.floor(nowSec / DAY_SEC);
}

// ─── HTTP ────────────────────────────────────────────────────────────

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * GET a JSON body with a timeout and a size cap. The body is read as a stream
 * so a wrong, oversized answer is cut off at the cap rather than held whole.
 * Errors name the HTTP status or the failure, never a header.
 */
export async function fetchJson(fetchFn: FetchFn, url: string, deadlineMs: number): Promise<unknown> {
  const path = new URL(url).pathname;
  const fail = (what: string): SourceFetchError => new SourceFetchError(path, what);
  const budget = Math.min(FETCH_TIMEOUT_MS, deadlineMs - Date.now());
  if (budget <= 0) throw fail('out of time before the request');
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(budget),
    });
  } catch (err) {
    throw fail(`request failed: ${redactedError(err, { stack: false }).slice(0, 120)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw fail(`HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw fail(`body of ${declared} bytes exceeds the ${MAX_BODY_BYTES}-byte cap`);
  }
  if (res.body === null) throw fail('empty body');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw fail(`body exceeds the ${MAX_BODY_BYTES}-byte cap`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof SourceFetchError) throw err;
    throw fail(`body read failed: ${redactedError(err, { stack: false }).slice(0, 120)}`);
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw fail('body is not JSON');
  }
}

// ─── D1 ──────────────────────────────────────────────────────────────

/** Columns bound per ranking row. */
const ROW_BINDS = 7;
/** Rows per INSERT, under D1's bound-parameter cap. */
export const ROWS_PER_INSERT = Math.floor(D1_MAX_BOUND_PARAMETERS / ROW_BINDS);

/** Every stored run row. */
export async function readRunStates(db: D1Database): Promise<RunState[]> {
  const res = await db
    .prepare('SELECT source, chain_id, fetched_at, ok FROM asset_ranking_run')
    .all<{ source: string; chain_id: number; fetched_at: number; ok: number }>();
  return (res.results ?? []).map((r) => ({
    source: r.source,
    chainId: Number(r.chain_id),
    fetchedAt: Number(r.fetched_at),
    ok: Number(r.ok),
  }));
}

/**
 * Replace one pair's rows and record a good run, in one batch: the delete,
 * the inserts and the run row commit together or not at all.
 */
export async function writeGoodRun(
  db: D1Database,
  source: RankingSource,
  chainId: number,
  rows: readonly RankingRow[],
  fetchedAtSec: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM asset_ranking WHERE chain_id = ? AND source = ?').bind(chainId, source),
  ];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const binds = chunk.flatMap((r) => [chainId, r.address, source, r.rank, r.name, r.symbol, fetchedAtSec]);
    statements.push(
      db
        .prepare(
          `INSERT INTO asset_ranking (chain_id, address, source, rank, name, symbol, fetched_at) VALUES ${values}`,
        )
        .bind(...binds),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO asset_ranking_run (source, chain_id, fetched_at, row_count, ok, detail)
         VALUES (?, ?, ?, ?, 1, NULL)
         ON CONFLICT (source, chain_id) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           row_count = excluded.row_count,
           ok = 1,
           detail = NULL`,
      )
      .bind(source, chainId, fetchedAtSec, rows.length),
  );
  await db.batch(statements);
}

/**
 * Record a failed run. The pair's rows are untouched and `row_count` keeps
 * counting them (zero only for a pair that never succeeded).
 */
export async function writeFailedRun(
  db: D1Database,
  source: RankingSource,
  chainId: number,
  reason: string,
  attemptedAtSec: number,
): Promise<void> {
  const detail = Array.from(reason).slice(0, MAX_DETAIL_CHARS).join('');
  await db
    .prepare(
      `INSERT INTO asset_ranking_run (source, chain_id, fetched_at, row_count, ok, detail)
       VALUES (?, ?, ?, 0, 0, ?)
       ON CONFLICT (source, chain_id) DO UPDATE SET
         fetched_at = excluded.fetched_at,
         ok = 0,
         detail = excluded.detail`,
    )
    .bind(source, chainId, attemptedAtSec, detail)
    .run();
}

// ─── One source ──────────────────────────────────────────────────────

/** The outcome of one pair, for the run line. */
export interface PairOutcome {
  readonly source: RankingSource;
  readonly chainId: number;
  readonly result: 'written' | 'failed' | 'not due' | 'out of time';
  readonly rows?: number;
  readonly reason?: string;
}

/** Why a step failed, bounded and without a stack. */
function reasonOf(err: unknown): string {
  if (err instanceof RankingRefusal || err instanceof SourceFetchError) return err.message;
  return redactedError(err, { stack: false }).slice(0, MAX_DETAIL_CHARS);
}

interface SourceDeps {
  readonly db: D1Database;
  readonly fetchFn: FetchFn;
  readonly deadlineMs: number;
  readonly nowSec: () => number;
}

/**
 * Fetch one source's ranked list (once), then map and write each due chain.
 * A failure of the shared fetch fails every due chain of the source; a failure
 * of one chain's step fails that chain only.
 */
export async function runSource(
  deps: SourceDeps,
  source: RankingSource,
  dueChains: readonly RankingChain[],
): Promise<PairOutcome[]> {
  const out: PairOutcome[] = [];
  const fail = async (chain: RankingChain, reason: string): Promise<void> => {
    await writeFailedRun(deps.db, source, chain.chainId, reason, deps.nowSec());
    out.push({ source, chainId: chain.chainId, result: 'failed', reason });
  };
  const outOfTime = (chains: readonly RankingChain[]): void => {
    for (const c of chains) out.push({ source, chainId: c.chainId, result: 'out of time' });
  };

  let ranked: RankedCoin[];
  let cgPairs: Map<string, [string, string][]> | undefined;
  try {
    if (source === 'cg') {
      const pages: unknown[] = [];
      for (let page = 1; page <= Math.ceil(RANKING_DEPTH / 250); page++) {
        pages.push(
          await fetchJson(
            deps.fetchFn,
            `${CG_API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`,
            deps.deadlineMs,
          ),
        );
      }
      ranked = parseCgMarkets(pages);
      requireFullRanking(source, ranked);
      const list = await fetchJson(deps.fetchFn, `${CG_API}/coins/list?include_platform=true`, deps.deadlineMs);
      cgPairs = parseCgPlatforms(list, new Set(ranked.map((c) => c.id)), dueChains.map((c) => c.cg));
    } else {
      ranked = parseCpTickers(await fetchJson(deps.fetchFn, `${CP_API}/tickers`, deps.deadlineMs));
      requireFullRanking(source, ranked);
    }
  } catch (err) {
    if (Date.now() >= deps.deadlineMs) {
      outOfTime(dueChains);
      return out;
    }
    const reason = reasonOf(err);
    for (const chain of dueChains) await fail(chain, reason);
    return out;
  }

  const rankedIds = new Set(ranked.map((c) => c.id));
  for (const [i, chain] of dueChains.entries()) {
    if (Date.now() >= deps.deadlineMs) {
      outOfTime(dueChains.slice(i));
      break;
    }
    try {
      const pairs =
        source === 'cg'
          ? (cgPairs!.get(chain.cg) ?? [])
          : parseCpContracts(await fetchJson(deps.fetchFn, `${CP_API}/contracts/${chain.cp}`, deps.deadlineMs), rankedIds);
      const rows = buildChainRows(source, chain, ranked, pairs);
      await writeGoodRun(deps.db, source, chain.chainId, rows, deps.nowSec());
      out.push({ source, chainId: chain.chainId, result: 'written', rows: rows.length });
    } catch (err) {
      await fail(chain, reasonOf(err));
    }
  }
  return out;
}

// ─── The pass ────────────────────────────────────────────────────────

/** One line for the whole run. */
export function describeOutcomes(outcomes: readonly PairOutcome[]): string {
  if (outcomes.length === 0) return 'nothing due';
  return outcomes
    .map((o) => {
      const tag = `${o.source}/${o.chainId}`;
      if (o.result === 'written') return `${tag} wrote ${o.rows}`;
      if (o.result === 'failed') return `${tag} failed (${o.reason})`;
      return `${tag} ${o.result}`;
    })
    .join('; ');
}

/** The pass body, with its inputs injected. Runs every due pair. */
export async function runAssetRankingsWith(deps: SourceDeps): Promise<PairOutcome[]> {
  const states = new Map(
    (await readRunStates(deps.db)).map((s) => [`${s.source}:${s.chainId}`, s] as const),
  );
  const now = deps.nowSec();
  const outcomes: PairOutcome[] = [];
  for (const source of RANKING_SOURCES) {
    const due = RANKING_CHAINS.filter((c) => isPairDue(states.get(`${source}:${c.chainId}`), now));
    if (due.length === 0) continue;
    if (Date.now() >= deps.deadlineMs) {
      for (const c of due) outcomes.push({ source, chainId: c.chainId, result: 'out of time' });
      continue;
    }
    outcomes.push(...(await runSource(deps, source, due)));
  }
  return outcomes;
}

export async function runAssetRankings(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'assetRankings', 'ASSET_RANKINGS_ENABLED')) return;
  const outcomes = await runAssetRankingsWith({
    db: env.DB,
    fetchFn: (input, init) => fetch(input, init),
    deadlineMs: tick.deadlineMs,
    nowSec: () => Math.floor(Date.now() / 1000),
  });
  console.log(`[keeper] assetRankings: ${describeOutcomes(outcomes)}`);
}
