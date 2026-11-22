/**
 * The failed transaction record (#3918, TroubleshootingPictureDesign.md §4.3).
 *
 * `POST /internal/failed-tx` is the ONE write the failed-transaction pass may
 * make. The pass runs as a small Worker of its own with no database binding;
 * it reaches this route under its own token (`FAILED_TX_WRITER_TOKEN`, a
 * Worker secret shared by the two Workers and nothing else), and the route
 * accepts three statements and nothing more:
 *
 *   1. `records`  — failed transactions, each with its decoded error and the
 *      stored explanation of the best source the pass had (§4.3's table). A
 *      record already held is replaced only by a better source (a trace or a
 *      matching rebuild over a parent-block replay, a replay over nothing),
 *      never by a worse one, and a replaced mark is never cleared.
 *   2. `cursor`   — the pass's mode and position for a network, with the
 *      checkpoints it left, the ranges it could not scan and the audit
 *      windows it measured.
 *   3. `replaced` — a statement that a block range was replaced. It marks the
 *      records and checkpoints in the range and deletes nothing.
 *
 * Every write names a network the bundle's deployment record knows. The
 * Diamond a record belongs to is stamped here from that record, never taken
 * from the caller, so records of a retired Diamond stay told apart from the
 * fresh one's.
 *
 * `GET /health/failed-tx` states, per network, the pass's mode, cursor and
 * the age of the newest block it finished, the last replacement found, the
 * gaps, the audit's measured miss rate and, in sends-and-audit mode, the
 * share of the day that is watched. Facts only, no verdict.
 */
import { getDeployment } from '@vaipakam/contracts/deployments';
import { redactedError } from '@vaipakam/lib/errorDescription';

// ─── Bounds ──────────────────────────────────────────────────────────────

/** A stored explanation is kept whole up to this size; the pass cuts above it (§4.3). */
export const MAX_EXPLANATION_BYTES = 256 * 1024;
/** Records in one write. */
export const MAX_RECORDS_PER_WRITE = 20;
/** The request body the route reads at most. */
export const MAX_FAILED_TX_BODY = MAX_RECORDS_PER_WRITE * (MAX_EXPLANATION_BYTES + 8 * 1024);
const MAX_CHECKPOINTS = 200;
const MAX_GAPS = 50;
const MAX_AUDITS = 20;
const MAX_TEXT = 2_000;

export const FOUND_BY = ['keeper-send', 'explorer-list', 'audit', 'trace-filter', 'block-scan'] as const;
export const MODES = ['trace-filter', 'list-and-audit', 'sends-and-audit', 'block-scan'] as const;
export const SOURCES = ['trace', 'rebuilt', 'replay', 'none'] as const;
const SOURCE_RANK: Record<(typeof SOURCES)[number], number> = { trace: 3, rebuilt: 3, replay: 2, none: 1 };

// ─── Parsing ─────────────────────────────────────────────────────────────

export interface FailedTxRecord {
  txHash: string;
  blockHash: string;
  blockNumber: number;
  blockTime: number;
  txIndex: number | null;
  sender: string;
  contract: string;
  functionSelector: string | null;
  functionName: string | null;
  loanId: string | null;
  offerId: string | null;
  errorSelector: string | null;
  errorName: string | null;
  /** JSON text of the error's values. */
  errorValues: string | null;
  foundBy: (typeof FOUND_BY)[number];
  mode: (typeof MODES)[number];
  source: (typeof SOURCES)[number];
  /** JSON text of the explainer's output for `source`; null for `none`. */
  explanation: string | null;
  explanationCut: boolean;
  /** JSON text: what this record cannot hold. */
  unavailable: string | null;
  gasUsed: string;
  gasLimit: string;
  usedAllGas: boolean;
  notReproduced: boolean;
  stateUnreachable: boolean;
}

export interface CursorStatement {
  mode: (typeof MODES)[number];
  blockNumber: number;
  blockTime: number;
  watchedShareBps: number | null;
  checkpoints: Array<{ blockNumber: number; blockHash: string }>;
  gaps: Array<{ fromBlock: number; toBlock: number; reason: string }>;
  audits: Array<{ fromBlock: number; toBlock: number; found: number; missed: number }>;
}

export type FailedTxWrite =
  | { kind: 'records'; chainId: number; records: FailedTxRecord[] }
  | { kind: 'cursor'; chainId: number; cursor: CursorStatement }
  | { kind: 'replaced'; chainId: number; fromBlock: number; toBlock: number };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SELECTOR = /^0x[0-9a-f]{8}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

class Refusal extends Error {}
const refuse = (msg: string): never => {
  throw new Refusal(msg);
};

function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) refuse(`${where} must be an object`);
  return v as Record<string, unknown>;
}
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) refuse(`${where}: unknown field ${k}`);
}
function blockNum(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) refuse(`${where} must be a non-negative integer`);
  return v as number;
}
function lowerMatch(v: unknown, re: RegExp, where: string): string {
  if (typeof v !== 'string' || !re.test(v.toLowerCase())) refuse(`${where} is malformed`);
  return (v as string).toLowerCase();
}
function optional<T>(v: unknown, read: (x: unknown) => T): T | null {
  return v === undefined || v === null ? null : read(v);
}
function oneOf<T extends readonly string[]>(v: unknown, set: T, where: string): T[number] {
  if (typeof v !== 'string' || !set.includes(v)) refuse(`${where} must be one of ${set.join(', ')}`);
  return v as T[number];
}
function flag(v: unknown, where: string): boolean {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') refuse(`${where} must be true or false`);
  return v as boolean;
}
function jsonText(v: unknown, max: number, where: string): string | null {
  if (v === undefined || v === null) return null;
  const text = JSON.stringify(v);
  if (new TextEncoder().encode(text).length > max) refuse(`${where} is over ${max} bytes`);
  return text;
}
function text(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_TEXT) refuse(`${where} must be a string of 1 to ${MAX_TEXT} characters`);
  return v as string;
}
function range(o: Record<string, unknown>, where: string): { fromBlock: number; toBlock: number } {
  const fromBlock = blockNum(o.fromBlock, `${where}.fromBlock`);
  const toBlock = blockNum(o.toBlock, `${where}.toBlock`);
  if (toBlock < fromBlock) refuse(`${where}: toBlock is below fromBlock`);
  return { fromBlock, toBlock };
}
function list(v: unknown, max: number, where: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) refuse(`${where} must be a list of at most ${max}`);
  return v as unknown[];
}

const RECORD_FIELDS = [
  'txHash', 'blockHash', 'blockNumber', 'blockTime', 'txIndex', 'sender', 'contract', 'functionSelector',
  'functionName', 'loanId', 'offerId', 'errorSelector', 'errorName', 'errorValues', 'foundBy', 'mode',
  'source', 'explanation', 'explanationCut', 'unavailable', 'gasUsed', 'gasLimit', 'usedAllGas',
  'notReproduced', 'stateUnreachable',
] as const;

function parseRecord(v: unknown, where: string): FailedTxRecord {
  const o = obj(v, where);
  onlyKeys(o, RECORD_FIELDS, where);
  const source = oneOf(o.source, SOURCES, `${where}.source`);
  const explanation = jsonText(o.explanation, MAX_EXPLANATION_BYTES, `${where}.explanation`);
  if (source === 'none' && explanation !== null) refuse(`${where}: a record with source none carries no explanation`);
  if (source !== 'none' && explanation === null) refuse(`${where}: source ${source} needs its explanation`);
  const stateUnreachable = flag(o.stateUnreachable, `${where}.stateUnreachable`);
  if (stateUnreachable && source !== 'none') refuse(`${where}: state unreachable is only for source none`);
  const notReproduced = flag(o.notReproduced, `${where}.notReproduced`);
  if (notReproduced && source !== 'replay') refuse(`${where}: not reproduced is only for a replay`);
  return {
    txHash: lowerMatch(o.txHash, HASH, `${where}.txHash`),
    blockHash: lowerMatch(o.blockHash, HASH, `${where}.blockHash`),
    blockNumber: blockNum(o.blockNumber, `${where}.blockNumber`),
    blockTime: blockNum(o.blockTime, `${where}.blockTime`),
    txIndex: optional(o.txIndex, (x) => blockNum(x, `${where}.txIndex`)),
    sender: lowerMatch(o.sender, ADDRESS, `${where}.sender`),
    contract: lowerMatch(o.contract, ADDRESS, `${where}.contract`),
    functionSelector: optional(o.functionSelector, (x) => lowerMatch(x, SELECTOR, `${where}.functionSelector`)),
    functionName: optional(o.functionName, (x) => (typeof x === 'string' && IDENT.test(x) ? x : refuse(`${where}.functionName is malformed`))),
    loanId: optional(o.loanId, (x) => (typeof x === 'string' && UINT.test(x) ? x : refuse(`${where}.loanId must be a decimal string`))),
    offerId: optional(o.offerId, (x) => (typeof x === 'string' && UINT.test(x) ? x : refuse(`${where}.offerId must be a decimal string`))),
    errorSelector: optional(o.errorSelector, (x) => lowerMatch(x, SELECTOR, `${where}.errorSelector`)),
    errorName: optional(o.errorName, (x) => (typeof x === 'string' && IDENT.test(x) ? x : refuse(`${where}.errorName is malformed`))),
    errorValues: jsonText(o.errorValues, 16 * 1024, `${where}.errorValues`),
    foundBy: oneOf(o.foundBy, FOUND_BY, `${where}.foundBy`),
    mode: oneOf(o.mode, MODES, `${where}.mode`),
    source,
    explanation,
    explanationCut: flag(o.explanationCut, `${where}.explanationCut`),
    unavailable: jsonText(o.unavailable, 4 * 1024, `${where}.unavailable`),
    gasUsed: typeof o.gasUsed === 'string' && UINT.test(o.gasUsed) ? o.gasUsed : refuse(`${where}.gasUsed must be a decimal string`),
    gasLimit: typeof o.gasLimit === 'string' && UINT.test(o.gasLimit) ? o.gasLimit : refuse(`${where}.gasLimit must be a decimal string`),
    usedAllGas: flag(o.usedAllGas, `${where}.usedAllGas`),
    notReproduced,
    stateUnreachable,
  };
}

/** Parse a write. Refuses any shape it does not know, and any network the bundle does not. */
export function parseFailedTxWrite(body: unknown): Parsed<FailedTxWrite> {
  try {
    const o = obj(body, 'body');
    const chainId = blockNum(o.chainId, 'chainId');
    if (!getDeployment(chainId)) refuse(`chain ${chainId} has no deployment record`);
    switch (o.kind) {
      case 'records': {
        onlyKeys(o, ['kind', 'chainId', 'records'], 'body');
        const raw = list(o.records, MAX_RECORDS_PER_WRITE, 'records');
        if (raw.length === 0) refuse('records is empty');
        return { ok: true, value: { kind: 'records', chainId, records: raw.map((r, i) => parseRecord(r, `records[${i}]`)) } };
      }
      case 'cursor': {
        onlyKeys(o, ['kind', 'chainId', 'cursor'], 'body');
        const c = obj(o.cursor, 'cursor');
        onlyKeys(c, ['mode', 'blockNumber', 'blockTime', 'watchedShareBps', 'checkpoints', 'gaps', 'audits'], 'cursor');
        const mode = oneOf(c.mode, MODES, 'cursor.mode');
        const watchedShareBps = optional(c.watchedShareBps, (x) => {
          const n = blockNum(x, 'cursor.watchedShareBps');
          return n <= 10_000 ? n : refuse('cursor.watchedShareBps is above 10000');
        });
        if (watchedShareBps !== null && mode !== 'sends-and-audit') refuse('cursor.watchedShareBps is only for sends-and-audit mode');
        if (watchedShareBps === null && mode === 'sends-and-audit') refuse('sends-and-audit mode must state the watched share');
        const cursor: CursorStatement = {
          mode,
          blockNumber: blockNum(c.blockNumber, 'cursor.blockNumber'),
          blockTime: blockNum(c.blockTime, 'cursor.blockTime'),
          watchedShareBps,
          checkpoints: list(c.checkpoints, MAX_CHECKPOINTS, 'cursor.checkpoints').map((x, i) => {
            const p = obj(x, `cursor.checkpoints[${i}]`);
            onlyKeys(p, ['blockNumber', 'blockHash'], `cursor.checkpoints[${i}]`);
            return { blockNumber: blockNum(p.blockNumber, `cursor.checkpoints[${i}].blockNumber`), blockHash: lowerMatch(p.blockHash, HASH, `cursor.checkpoints[${i}].blockHash`) };
          }),
          gaps: list(c.gaps, MAX_GAPS, 'cursor.gaps').map((x, i) => {
            const g = obj(x, `cursor.gaps[${i}]`);
            onlyKeys(g, ['fromBlock', 'toBlock', 'reason'], `cursor.gaps[${i}]`);
            return { ...range(g, `cursor.gaps[${i}]`), reason: text(g.reason, `cursor.gaps[${i}].reason`) };
          }),
          audits: list(c.audits, MAX_AUDITS, 'cursor.audits').map((x, i) => {
            const a = obj(x, `cursor.audits[${i}]`);
            onlyKeys(a, ['fromBlock', 'toBlock', 'found', 'missed'], `cursor.audits[${i}]`);
            const found = blockNum(a.found, `cursor.audits[${i}].found`);
            const missed = blockNum(a.missed, `cursor.audits[${i}].missed`);
            if (missed > found) refuse(`cursor.audits[${i}]: missed is above found`);
            return { ...range(a, `cursor.audits[${i}]`), found, missed };
          }),
        };
        return { ok: true, value: { kind: 'cursor', chainId, cursor } };
      }
      case 'replaced': {
        onlyKeys(o, ['kind', 'chainId', 'fromBlock', 'toBlock'], 'body');
        return { ok: true, value: { kind: 'replaced', chainId, ...range(o, 'body') } };
      }
      default:
        return refuse('kind must be records, cursor or replaced');
    }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: e.message };
    throw e;
  }
}

// ─── Authentication ──────────────────────────────────────────────────────

/**
 * Whether `Authorization: Bearer <token>` carries the writer's token. An
 * unset token refuses everything. Compared as SHA-256 digests in constant
 * time, so neither the length nor a prefix leaks.
 */
export async function writerAuthorized(header: string | null, token: string | undefined): Promise<boolean> {
  if (!token || !header || !header.startsWith('Bearer ')) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(header.slice('Bearer '.length))),
    crypto.subtle.digest('SHA-256', enc.encode(token)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

// ─── Writing ─────────────────────────────────────────────────────────────

/** The narrow D1 surface the writes use. */
export interface D1Write {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<Array<{ meta?: { changes?: number } }>>;
}
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  first<T = unknown>(): Promise<T | null>;
}

const SOURCE_RANK_SQL = (col: string) => `CASE ${col} WHEN 'trace' THEN 3 WHEN 'rebuilt' THEN 3 WHEN 'replay' THEN 2 ELSE 1 END`;

const INSERT_RECORD = `
INSERT INTO failed_tx (
  chain_id, tx_hash, block_hash, block_number, block_time, tx_index, diamond, sender, contract,
  function_selector, function_name, loan_id, offer_id, error_selector, error_name, error_values,
  found_by, mode, source, explanation, explanation_cut, unavailable, gas_used, gas_limit,
  used_all_gas, not_reproduced, state_unreachable, replaced_at, recorded_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, NULL, ?28)
ON CONFLICT (chain_id, tx_hash, block_hash) DO UPDATE SET
  error_selector = excluded.error_selector,
  error_name = excluded.error_name,
  error_values = excluded.error_values,
  source = excluded.source,
  explanation = excluded.explanation,
  explanation_cut = excluded.explanation_cut,
  unavailable = excluded.unavailable,
  not_reproduced = excluded.not_reproduced,
  state_unreachable = excluded.state_unreachable,
  recorded_at = excluded.recorded_at
WHERE ${SOURCE_RANK_SQL('excluded.source')} > ${SOURCE_RANK_SQL('failed_tx.source')}`;

/** Apply a parsed write. Returns how many rows it wrote or marked. */
export async function applyFailedTxWrite(db: D1Write, w: FailedTxWrite, now: number): Promise<number> {
  const dep = getDeployment(w.chainId);
  if (!dep) throw new Error(`chain ${w.chainId} has no deployment record`);
  const stmts: D1Stmt[] = [];
  switch (w.kind) {
    case 'records':
      for (const r of w.records) {
        stmts.push(
          db.prepare(INSERT_RECORD).bind(
            w.chainId, r.txHash, r.blockHash, r.blockNumber, r.blockTime, r.txIndex, dep.diamond.toLowerCase(), r.sender, r.contract,
            r.functionSelector, r.functionName, r.loanId, r.offerId, r.errorSelector, r.errorName, r.errorValues,
            r.foundBy, r.mode, r.source, r.explanation, r.explanationCut ? 1 : 0, r.unavailable, r.gasUsed, r.gasLimit,
            r.usedAllGas ? 1 : 0, r.notReproduced ? 1 : 0, r.stateUnreachable ? 1 : 0, now,
          ),
        );
      }
      break;
    case 'cursor': {
      const c = w.cursor;
      stmts.push(
        db
          .prepare(
            `INSERT INTO failed_tx_cursor (chain_id, mode, block_number, block_time, watched_share_bps, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (chain_id) DO UPDATE SET mode = excluded.mode, block_number = excluded.block_number,
               block_time = excluded.block_time, watched_share_bps = excluded.watched_share_bps, updated_at = excluded.updated_at`,
          )
          .bind(w.chainId, c.mode, c.blockNumber, c.blockTime, c.watchedShareBps, now),
      );
      for (const p of c.checkpoints) {
        // A rescanned height takes the new hash and is live again.
        stmts.push(
          db
            .prepare(
              `INSERT INTO failed_tx_range (chain_id, kind, from_block, to_block, block_hash, recorded_at)
               VALUES (?1, 'checkpoint', ?2, ?2, ?3, ?4)
               ON CONFLICT (chain_id, kind, from_block, to_block) DO UPDATE SET block_hash = excluded.block_hash,
                 recorded_at = excluded.recorded_at, replaced_at = NULL`,
            )
            .bind(w.chainId, p.blockNumber, p.blockHash, now),
        );
      }
      for (const g of c.gaps) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO failed_tx_range (chain_id, kind, from_block, to_block, reason, recorded_at)
               VALUES (?1, 'gap', ?2, ?3, ?4, ?5)
               ON CONFLICT (chain_id, kind, from_block, to_block) DO UPDATE SET reason = excluded.reason, recorded_at = excluded.recorded_at`,
            )
            .bind(w.chainId, g.fromBlock, g.toBlock, g.reason, now),
        );
      }
      for (const a of c.audits) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO failed_tx_range (chain_id, kind, from_block, to_block, found, missed, recorded_at)
               VALUES (?1, 'audit', ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT (chain_id, kind, from_block, to_block) DO UPDATE SET found = excluded.found,
                 missed = excluded.missed, recorded_at = excluded.recorded_at`,
            )
            .bind(w.chainId, a.fromBlock, a.toBlock, a.found, a.missed, now),
        );
      }
      break;
    }
    case 'replaced': {
      const marked = await db
        .prepare(`SELECT COUNT(*) AS n FROM failed_tx WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3 AND replaced_at IS NULL`)
        .bind(w.chainId, w.fromBlock, w.toBlock)
        .first<{ n: number }>();
      stmts.push(
        db
          .prepare(`UPDATE failed_tx SET replaced_at = ?4 WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3 AND replaced_at IS NULL`)
          .bind(w.chainId, w.fromBlock, w.toBlock, now),
        db
          .prepare(
            `UPDATE failed_tx_range SET replaced_at = ?4
             WHERE chain_id = ?1 AND kind = 'checkpoint' AND from_block BETWEEN ?2 AND ?3 AND replaced_at IS NULL`,
          )
          .bind(w.chainId, w.fromBlock, w.toBlock, now),
        db
          .prepare(
            `INSERT INTO failed_tx_range (chain_id, kind, from_block, to_block, marked, recorded_at)
             VALUES (?1, 'replaced', ?2, ?3, ?4, ?5)
             ON CONFLICT (chain_id, kind, from_block, to_block) DO UPDATE SET marked = failed_tx_range.marked + excluded.marked,
               recorded_at = excluded.recorded_at`,
          )
          .bind(w.chainId, w.fromBlock, w.toBlock, marked?.n ?? 0, now),
      );
      break;
    }
  }
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

// ─── The route ───────────────────────────────────────────────────────────

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * `POST /internal/failed-tx`. Authenticates from the header before reading
 * the body, caps the body, parses strictly, writes. No CORS: the caller is
 * the pass's Worker, never a browser.
 */
export async function handleFailedTxWrite(
  req: Request,
  db: D1Write,
  token: string | undefined,
  readBody: (req: Request, max: number) => Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }>,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Response> {
  if (!(await writerAuthorized(req.headers.get('authorization'), token))) return json({ error: 'unauthorized' }, 401);
  const read = await readBody(req, MAX_FAILED_TX_BODY);
  if (!read.ok) return json({ error: read.error }, read.status);
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return json({ error: 'body is not JSON' }, 400);
  }
  const parsed = parseFailedTxWrite(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  try {
    const written = await applyFailedTxWrite(db, parsed.value, now());
    return json({ ok: true, written }, 200);
  } catch (e) {
    return json({ error: `write failed: ${redactedError(e)}` }, 503);
  }
}

// ─── Health ──────────────────────────────────────────────────────────────

export interface FailedTxChainHealth {
  chainId: number;
  mode: string | null;
  /** The highest block the pass finished, and when that block was made. */
  cursor: { blockNumber: number; blockTime: number; ageSeconds: number; updatedAt: number } | null;
  /** In sends-and-audit mode, the share of the day failures by others are watched (bps); the rest is not watched. */
  watchedShareBps: number | null;
  newestCheckpoint: { blockNumber: number; blockHash: string } | null;
  lastReplacement: { fromBlock: number; toBlock: number; foundAt: number; marked: number } | null;
  gaps: { count: number; latest: { fromBlock: number; toBlock: number; reason: string } | null };
  /** The audit's measured miss rate so far: missed of found, over every window. */
  audit: { windows: number; found: number; missed: number; missRateBps: number | null };
  recordsLast24h: number;
}

/** `GET /health/failed-tx`. Null tables (before migration 0123) answer 503. */
export async function handleFailedTxHealth(db: { prepare(sql: string): D1Stmt }, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<Response> {
  try {
    const t = now();
    const q = async <T>(sql: string, ...binds: unknown[]) => ((await db.prepare(sql).bind(...binds).all<T>()).results ?? []) as T[];
    const cursors = await q<{ chain_id: number; mode: string; block_number: number; block_time: number; watched_share_bps: number | null; updated_at: number }>(
      'SELECT chain_id, mode, block_number, block_time, watched_share_bps, updated_at FROM failed_tx_cursor',
    );
    const checkpoints = await q<{ chain_id: number; block_number: number; block_hash: string }>(
      `SELECT c.chain_id, c.from_block AS block_number, c.block_hash FROM failed_tx_range c
       WHERE c.kind = 'checkpoint' AND c.replaced_at IS NULL AND c.from_block = (
         SELECT MAX(from_block) FROM failed_tx_range d WHERE d.chain_id = c.chain_id AND d.kind = 'checkpoint' AND d.replaced_at IS NULL)`,
    );
    const replaced = await q<{ chain_id: number; from_block: number; to_block: number; found_at: number; marked: number }>(
      `SELECT r.chain_id, r.from_block, r.to_block, r.recorded_at AS found_at, r.marked FROM failed_tx_range r
       WHERE r.kind = 'replaced' AND r.recorded_at = (
         SELECT MAX(recorded_at) FROM failed_tx_range s WHERE s.chain_id = r.chain_id AND s.kind = 'replaced')`,
    );
    const gaps = await q<{ chain_id: number; n: number; from_block: number; to_block: number; reason: string }>(
      `SELECT g.chain_id, (SELECT COUNT(*) FROM failed_tx_range h WHERE h.chain_id = g.chain_id AND h.kind = 'gap') AS n,
         g.from_block, g.to_block, g.reason
       FROM failed_tx_range g WHERE g.kind = 'gap' AND g.recorded_at = (
         SELECT MAX(recorded_at) FROM failed_tx_range h WHERE h.chain_id = g.chain_id AND h.kind = 'gap')`,
    );
    const audits = await q<{ chain_id: number; windows: number; found: number; missed: number }>(
      `SELECT chain_id, COUNT(*) AS windows, SUM(found) AS found, SUM(missed) AS missed
       FROM failed_tx_range WHERE kind = 'audit' GROUP BY chain_id`,
    );
    const recent = await q<{ chain_id: number; n: number }>(
      'SELECT chain_id, COUNT(*) AS n FROM failed_tx WHERE recorded_at >= ?1 GROUP BY chain_id',
      t - 86_400,
    );
    const chains = new Set<number>([...cursors, ...checkpoints, ...replaced, ...gaps, ...audits, ...recent].map((r) => r.chain_id));
    const out: FailedTxChainHealth[] = [...chains].sort((a, b) => a - b).map((chainId) => {
      const c = cursors.find((r) => r.chain_id === chainId);
      const p = checkpoints.find((r) => r.chain_id === chainId);
      const r = replaced.find((x) => x.chain_id === chainId);
      const g = gaps.find((x) => x.chain_id === chainId);
      const a = audits.find((x) => x.chain_id === chainId);
      return {
        chainId,
        mode: c?.mode ?? null,
        cursor: c ? { blockNumber: c.block_number, blockTime: c.block_time, ageSeconds: Math.max(0, t - c.block_time), updatedAt: c.updated_at } : null,
        watchedShareBps: c?.watched_share_bps ?? null,
        newestCheckpoint: p ? { blockNumber: p.block_number, blockHash: p.block_hash } : null,
        lastReplacement: r ? { fromBlock: r.from_block, toBlock: r.to_block, foundAt: r.found_at, marked: r.marked } : null,
        gaps: { count: g?.n ?? 0, latest: g ? { fromBlock: g.from_block, toBlock: g.to_block, reason: g.reason } : null },
        audit: {
          windows: a?.windows ?? 0,
          found: a?.found ?? 0,
          missed: a?.missed ?? 0,
          missRateBps: a && a.found > 0 ? Math.round((a.missed * 10_000) / a.found) : null,
        },
        recordsLast24h: recent.find((x) => x.chain_id === chainId)?.n ?? 0,
      };
    });
    return json({ chains: out }, 200);
  } catch (e) {
    return json({ error: 'unavailable', detail: redactedError(e) }, 503);
  }
}
