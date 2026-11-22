/**
 * The failed transaction record (#3918, TroubleshootingPictureDesign.md §4.3).
 *
 * `POST /internal/failed-tx` is the ONE write the failed-transaction pass may
 * make. The pass runs as a service of its own on the keeper machine, with no
 * database binding; it reaches this route under its own token
 * (`FAILED_TX_WRITER_TOKEN`, a secret it shares with the indexer and nothing
 * else), and the route
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
 *   3. `replaced` — a statement that a block range was replaced, naming the
 *      checkpoint the chain no longer agrees with. It marks the records and
 *      checkpoints in the range and deletes nothing, and it applies only while
 *      that checkpoint is live, so it applies once.
 *
 * Every write names a network the bundle's deployment record knows and the
 * Diamond it scanned under, which must be the bundle's: a write made under
 * another deployment is refused with 409 (`deployment mismatch`), as is a
 * record from a block before the Diamond's deploy block. The Diamond a record
 * belongs to is stamped from the bundle's record, so records of a retired
 * Diamond stay told apart from the fresh one's.
 *
 * `GET /health/failed-tx` states, per network, the pass's mode, cursor and
 * the age of the newest block it finished, the last replacement found, the
 * gaps, the audit's measured miss rate and, in sends-and-audit mode, the
 * share of the day that is watched. Facts only, no verdict.
 */
import { getDeployment } from '@vaipakam/contracts/deployments';
import { redactedError } from '@vaipakam/lib/errorDescription';
import {
  MAX_ERROR_VALUES_BYTES,
  MAX_EXPLANATION_BYTES,
  MAX_FAILED_TX_BODY,
  MAX_RECORDS_PER_WRITE,
  MAX_UNAVAILABLE_BYTES,
} from '@vaipakam/lib/failedTxBounds';

// ─── Bounds ──────────────────────────────────────────────────────────────

// The record bounds are shared with the pass, which cuts to them before it
// writes (@vaipakam/lib/failedTxBounds).
export { MAX_EXPLANATION_BYTES, MAX_FAILED_TX_BODY, MAX_RECORDS_PER_WRITE };
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
  /** List and audit mode: the block the hourly explorer list is read to. */
  slowBlockNumber: number | null;
  /** List and audit mode: the first block of the lists' present unbroken coverage. */
  listFromBlock: number | null;
  /** The audit window being scanned: a UTC day and its block range. */
  auditPlan: { day: string; fromBlock: number; toBlock: number } | null;
  checkpoints: Array<{ blockNumber: number; blockHash: string }>;
  gaps: Array<{ fromBlock: number; toBlock: number; reason: string }>;
  /** `missed` null: the slice lies where the list was never asked, so nothing was measured. */
  audits: Array<{ fromBlock: number; toBlock: number; found: number; missed: number | null }>;
  /**
   * The records found in the blocks this cursor covers, stored in the same
   * statement as the cursor and its checkpoint: a record is never live
   * without the checkpoint that lets a later run find its block replaced.
   */
  records: FailedTxRecord[];
}

export type FailedTxWrite =
  | { kind: 'records'; chainId: number; records: FailedTxRecord[] }
  | { kind: 'cursor'; chainId: number; cursor: CursorStatement }
  | { kind: 'replaced'; chainId: number; fromBlock: number; toBlock: number; staleCheckpoint: { blockNumber: number; blockHash: string } };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SELECTOR = /^0x[0-9a-f]{8}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

/** A refusal of the write's shape. Its text is our own, carried as `reason`. */
class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly status = 400,
  ) {
    super(reason);
  }
}
const refuse = (msg: string): never => {
  throw new Refusal(msg);
};
/** The error a write made under another deployment is refused with (HTTP 409). */
export const DEPLOYMENT_MISMATCH = 'deployment mismatch';

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
    errorValues: jsonText(o.errorValues, MAX_ERROR_VALUES_BYTES, `${where}.errorValues`),
    foundBy: oneOf(o.foundBy, FOUND_BY, `${where}.foundBy`),
    mode: oneOf(o.mode, MODES, `${where}.mode`),
    source,
    explanation,
    explanationCut: flag(o.explanationCut, `${where}.explanationCut`),
    unavailable: jsonText(o.unavailable, MAX_UNAVAILABLE_BYTES, `${where}.unavailable`),
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
    const dep = getDeployment(chainId);
    if (!dep) return refuse(`chain ${chainId} has no deployment record`);
    // Every write names the Diamond the writer scanned under, and it must be
    // the one this indexer has adopted: a writer and an indexer on different
    // bundles across a fresh deploy would otherwise attribute one
    // deployment's failures, position and ranges to the other.
    const diamond = lowerMatch(o.diamond, ADDRESS, 'diamond');
    if (diamond !== dep.diamond.toLowerCase()) {
      throw new Refusal(`${DEPLOYMENT_MISMATCH}: the write names Diamond ${diamond}, and this indexer's deployment record for chain ${chainId} names ${dep.diamond.toLowerCase()}`, 409);
    }
    switch (o.kind) {
      case 'records': {
        onlyKeys(o, ['kind', 'chainId', 'diamond', 'records'], 'body');
        const raw = list(o.records, MAX_RECORDS_PER_WRITE, 'records');
        if (raw.length === 0) refuse('records is empty');
        const records = raw.map((r, i) => parseRecord(r, `records[${i}]`));
        // A block before this Diamond's deploy block belongs to a retired
        // deployment, whose Diamond this record cannot be stamped with.
        const early = records.find((r) => r.blockNumber < dep.deployBlock);
        if (early) {
          throw new Refusal(`${DEPLOYMENT_MISMATCH}: block ${early.blockNumber} is before this Diamond's deploy block ${dep.deployBlock}`, 409);
        }
        return { ok: true, value: { kind: 'records', chainId, records } };
      }
      case 'cursor': {
        onlyKeys(o, ['kind', 'chainId', 'diamond', 'cursor'], 'body');
        const c = obj(o.cursor, 'cursor');
        onlyKeys(c, ['mode', 'blockNumber', 'blockTime', 'watchedShareBps', 'slowBlockNumber', 'listFromBlock', 'auditPlan', 'checkpoints', 'gaps', 'audits', 'records'], 'cursor');
        const mode = oneOf(c.mode, MODES, 'cursor.mode');
        const watchedShareBps = optional(c.watchedShareBps, (x) => {
          const n = blockNum(x, 'cursor.watchedShareBps');
          return n <= 10_000 ? n : refuse('cursor.watchedShareBps is above 10000');
        });
        if (watchedShareBps !== null && mode !== 'sends-and-audit') refuse('cursor.watchedShareBps is only for sends-and-audit mode');
        if (watchedShareBps === null && mode === 'sends-and-audit') refuse('sends-and-audit mode must state the watched share');
        const slowBlockNumber = optional(c.slowBlockNumber, (x) => blockNum(x, 'cursor.slowBlockNumber'));
        if (slowBlockNumber !== null && mode !== 'list-and-audit') refuse('cursor.slowBlockNumber is only for list-and-audit mode');
        const listFromBlock = optional(c.listFromBlock, (x) => blockNum(x, 'cursor.listFromBlock'));
        if (listFromBlock !== null && mode !== 'list-and-audit') refuse('cursor.listFromBlock is only for list-and-audit mode');
        const records = c.records === undefined ? [] : list(c.records, MAX_RECORDS_PER_WRITE, 'cursor.records').map((r, i) => parseRecord(r, `cursor.records[${i}]`));
        const blockNumber = blockNum(c.blockNumber, 'cursor.blockNumber');
        const outside = records.find((r) => r.blockNumber > blockNumber);
        if (outside) refuse(`cursor.records: block ${outside.blockNumber} is above the cursor`);
        const early = records.find((r) => r.blockNumber < dep.deployBlock);
        if (early) {
          throw new Refusal(`${DEPLOYMENT_MISMATCH}: block ${early.blockNumber} is before this Diamond's deploy block ${dep.deployBlock}`, 409);
        }
        const auditPlan = optional(c.auditPlan, (x) => {
          const a = obj(x, 'cursor.auditPlan');
          onlyKeys(a, ['day', 'fromBlock', 'toBlock'], 'cursor.auditPlan');
          if (typeof a.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.day)) refuse('cursor.auditPlan.day must be YYYY-MM-DD');
          return { day: a.day as string, ...range(a, 'cursor.auditPlan') };
        });
        if (auditPlan !== null && mode === 'trace-filter') refuse('cursor.auditPlan is not for trace-filter mode');
        const cursor: CursorStatement = {
          mode,
          blockNumber,
          blockTime: blockNum(c.blockTime, 'cursor.blockTime'),
          watchedShareBps,
          slowBlockNumber,
          listFromBlock,
          auditPlan,
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
            const missed = optional(a.missed, (x) => blockNum(x, `cursor.audits[${i}].missed`));
            if (missed !== null && missed > found) refuse(`cursor.audits[${i}]: missed is above found`);
            return { ...range(a, `cursor.audits[${i}]`), found, missed };
          }),
          records,
        };
        return { ok: true, value: { kind: 'cursor', chainId, cursor } };
      }
      case 'replaced': {
        onlyKeys(o, ['kind', 'chainId', 'diamond', 'fromBlock', 'toBlock', 'staleCheckpoint'], 'body');
        const r = range(o, 'body');
        // The checkpoint the chain no longer agrees with is the replacement's
        // identity: it is applied only while that checkpoint is live, so a
        // delayed duplicate never marks what a rescan has written since.
        const cp = obj(o.staleCheckpoint, 'staleCheckpoint');
        onlyKeys(cp, ['blockNumber', 'blockHash'], 'staleCheckpoint');
        const staleCheckpoint = { blockNumber: blockNum(cp.blockNumber, 'staleCheckpoint.blockNumber'), blockHash: lowerMatch(cp.blockHash, HASH, 'staleCheckpoint.blockHash') };
        if (staleCheckpoint.blockNumber < r.fromBlock || staleCheckpoint.blockNumber > r.toBlock) refuse('staleCheckpoint must lie inside the replaced range');
        return { ok: true, value: { kind: 'replaced', chainId, ...r, staleCheckpoint } };
      }
      default:
        return refuse('kind must be records, cursor or replaced');
    }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: e.reason, status: e.status };
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
  run(): Promise<unknown>;
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
  const insertRecord = (r: FailedTxRecord) =>
    db.prepare(INSERT_RECORD).bind(
      w.chainId, r.txHash, r.blockHash, r.blockNumber, r.blockTime, r.txIndex, dep.diamond.toLowerCase(), r.sender, r.contract,
      r.functionSelector, r.functionName, r.loanId, r.offerId, r.errorSelector, r.errorName, r.errorValues,
      r.foundBy, r.mode, r.source, r.explanation, r.explanationCut ? 1 : 0, r.unavailable, r.gasUsed, r.gasLimit,
      r.usedAllGas ? 1 : 0, r.notReproduced ? 1 : 0, r.stateUnreachable ? 1 : 0, now,
    );
  switch (w.kind) {
    case 'records':
      for (const r of w.records) stmts.push(insertRecord(r));
      break;
    case 'cursor': {
      const c = w.cursor;
      // The records first, then the cursor and its checkpoint, in one batch.
      for (const r of c.records) stmts.push(insertRecord(r));
      stmts.push(
        db
          .prepare(
            `INSERT INTO failed_tx_cursor (chain_id, diamond, mode, block_number, block_time, watched_share_bps, slow_block_number,
               list_from_block, audit_day, audit_from, audit_to, updated_at)
             VALUES (?1, ?11, ?2, ?3, ?4, ?5, ?6, ?12, ?7, ?8, ?9, ?10)
             ON CONFLICT (chain_id) DO UPDATE SET diamond = excluded.diamond, mode = excluded.mode, block_number = excluded.block_number,
               block_time = excluded.block_time, watched_share_bps = excluded.watched_share_bps,
               slow_block_number = excluded.slow_block_number, list_from_block = excluded.list_from_block, audit_day = excluded.audit_day,
               audit_from = excluded.audit_from, audit_to = excluded.audit_to, updated_at = excluded.updated_at`,
          )
          .bind(
            w.chainId, c.mode, c.blockNumber, c.blockTime, c.watchedShareBps, c.slowBlockNumber,
            c.auditPlan?.day ?? null, c.auditPlan?.fromBlock ?? null, c.auditPlan?.toBlock ?? null, now, dep.diamond.toLowerCase(),
            c.listFromBlock,
          ),
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
      // Every statement runs only while the stale checkpoint is live, and the
      // checkpoint marking runs last and marks it, so the replacement applies
      // once. A delayed duplicate, or one sent after a rescan wrote the new
      // hash at that height, finds no live stale checkpoint and changes
      // nothing. The count is taken inside the batch, just before the
      // marking, so it is exactly the rows this batch marks.
      // Each statement spells the guard out (no interpolation) so the SQL-vs-schema guard checks it.
      const binds = [w.chainId, w.fromBlock, w.toBlock, now, w.staleCheckpoint.blockNumber, w.staleCheckpoint.blockHash] as const;
      stmts.push(
        db
          .prepare(
            `INSERT INTO failed_tx_range (chain_id, kind, from_block, to_block, marked, recorded_at)
             SELECT ?1, 'replaced', ?2, ?3,
               (SELECT COUNT(*) FROM failed_tx WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3 AND replaced_at IS NULL), ?4
             WHERE EXISTS (SELECT 1 FROM failed_tx_range WHERE chain_id = ?1 AND kind = 'checkpoint'
               AND from_block = ?5 AND to_block = ?5 AND block_hash = ?6 AND replaced_at IS NULL)
             ON CONFLICT (chain_id, kind, from_block, to_block) DO UPDATE SET marked = failed_tx_range.marked + excluded.marked,
               recorded_at = excluded.recorded_at`,
          )
          .bind(...binds),
        db
          .prepare(
            `UPDATE failed_tx SET replaced_at = ?4 WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3 AND replaced_at IS NULL
             AND EXISTS (SELECT 1 FROM failed_tx_range WHERE chain_id = ?1 AND kind = 'checkpoint'
               AND from_block = ?5 AND to_block = ?5 AND block_hash = ?6 AND replaced_at IS NULL)`,
          )
          .bind(...binds),
        db
          .prepare(
            `UPDATE failed_tx_range SET replaced_at = ?4
             WHERE chain_id = ?1 AND kind = 'checkpoint' AND from_block BETWEEN ?2 AND ?3 AND replaced_at IS NULL
             AND EXISTS (SELECT 1 FROM failed_tx_range WHERE chain_id = ?1 AND kind = 'checkpoint'
               AND from_block = ?5 AND to_block = ?5 AND block_hash = ?6 AND replaced_at IS NULL)`,
          )
          .bind(...binds),
      );
      break;
    }
  }
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

// ─── Retention ───────────────────────────────────────────────────────────

/** How long the record is kept (TroubleshootingPictureDesign.md §3, Default 400 days). */
export const FAILED_TX_RETENTION_DAYS = 400;

/**
 * Drops records whose block is older than the retention, and the pass's range
 * statements recorded before it. The pass itself never deletes; this is the
 * indexer's own scheduled prune, on the cron like the other retention prunes.
 */
export async function pruneOldFailedTx(db: { prepare(sql: string): D1Stmt }, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  const cutoff = now - FAILED_TX_RETENTION_DAYS * 86_400;
  await db.prepare('DELETE FROM failed_tx WHERE block_time < ?1').bind(cutoff).run();
  await db.prepare('DELETE FROM failed_tx_range WHERE recorded_at < ?1').bind(cutoff).run();
}

// ─── The route ───────────────────────────────────────────────────────────

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * `POST /internal/failed-tx`. Authenticates from the header before reading
 * the body, caps the body, parses strictly, writes. No CORS: the caller is
 * the pass, never a browser.
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
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  try {
    const written = await applyFailedTxWrite(db, parsed.value, now());
    return json({ ok: true, written }, 200);
  } catch (e) {
    // The detail stays in the Worker's log; the caller gets a fixed answer.
    console.error('[failedTx] write failed', redactedError(e));
    return json({ error: 'write failed; retry later' }, 503);
  }
}

// ─── The pass's own state ────────────────────────────────────────────────

/** Unmarked checkpoints the state read returns, newest first: the replacement walk's reach. */
export const STATE_CHECKPOINTS = 100;
/** The widest block range the state read lists recorded transactions for (an audit slice). */
export const STATE_RECORDED_RANGE = 20_000;

export interface FailedTxPassState {
  cursor: {
    mode: string;
    blockNumber: number;
    blockTime: number;
    watchedShareBps: number | null;
    slowBlockNumber: number | null;
    listFromBlock: number | null;
    auditPlan: { day: string; fromBlock: number; toBlock: number } | null;
  } | null;
  /** Unmarked checkpoints, newest first. */
  checkpoints: Array<{ blockNumber: number; blockHash: string }>;
  /** The highest block of the planned audit window already audited, or null. */
  auditedTo: number | null;
  /** Live records in the asked block range, by transaction hash (lowercase). */
  recorded: string[] | null;
  /**
   * The same, less those the audit itself found: what the other sources
   * covered. The audit compares with this, so a slice read again after an
   * interrupted run cannot count its own earlier finds as covered.
   */
  recordedByOthers: string[] | null;
}

/**
 * `GET /internal/failed-tx/state?chainId=N[&from=A&to=B]`: what the pass
 * itself wrote, read back, under the same token. The pass has no database of
 * its own, so its cursor, its checkpoints and its audit progress live in its
 * tables and come back through here. It reads only those three tables.
 */
export async function handleFailedTxState(
  req: Request,
  db: { prepare(sql: string): D1Stmt },
  token: string | undefined,
): Promise<Response> {
  if (!(await writerAuthorized(req.headers.get('authorization'), token))) return json({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const chainId = Number(url.searchParams.get('chainId'));
  const dep = Number.isSafeInteger(chainId) && chainId > 0 ? getDeployment(chainId) : undefined;
  if (!dep) return json({ error: 'chainId must name a deployed network' }, 400);
  // The pass names the Diamond it scans under, as on every write: a pass and
  // an indexer on different deployment records stop here rather than one
  // resuming from the other's position.
  const current = dep.diamond.toLowerCase();
  const diamond = (url.searchParams.get('diamond') ?? '').toLowerCase();
  if (diamond !== current) {
    return json({ error: `${DEPLOYMENT_MISMATCH}: the read names Diamond ${diamond || '(none)'}, and this indexer's deployment record for chain ${chainId} names ${current}` }, 409);
  }
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  let span: { from: number; to: number } | null = null;
  if (fromRaw !== null || toRaw !== null) {
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from >= STATE_RECORDED_RANGE) {
      return json({ error: `from and to must be a block range of at most ${STATE_RECORDED_RANGE} blocks` }, 400);
    }
    span = { from, to };
  }
  try {
    // A position written under a retired Diamond is not resumed from: the
    // pass starts this deployment afresh from its own deploy block.
    const c = await db
      .prepare(
        `SELECT mode, block_number, block_time, watched_share_bps, slow_block_number, list_from_block, audit_day, audit_from, audit_to
         FROM failed_tx_cursor WHERE chain_id = ?1 AND diamond = ?2`,
      )
      .bind(chainId, current)
      .first<{
        mode: string; block_number: number; block_time: number; watched_share_bps: number | null; slow_block_number: number | null;
        list_from_block: number | null; audit_day: string | null; audit_from: number | null; audit_to: number | null;
      }>();
    const checkpoints = (
      (
        await db
          .prepare(
            `SELECT from_block, block_hash FROM failed_tx_range
             WHERE chain_id = ?1 AND kind = 'checkpoint' AND replaced_at IS NULL ORDER BY from_block DESC LIMIT ?2`,
          )
          .bind(chainId, STATE_CHECKPOINTS)
          .all<{ from_block: number; block_hash: string }>()
      ).results ?? []
    ).map((r) => ({ blockNumber: r.from_block, blockHash: r.block_hash }));
    const plan = c && c.audit_day !== null && c.audit_from !== null && c.audit_to !== null ? { day: c.audit_day, fromBlock: c.audit_from, toBlock: c.audit_to } : null;
    let auditedTo: number | null = null;
    if (plan) {
      const a = await db
        .prepare(`SELECT MAX(to_block) AS t FROM failed_tx_range WHERE chain_id = ?1 AND kind = 'audit' AND from_block >= ?2 AND to_block <= ?3`)
        .bind(chainId, plan.fromBlock, plan.toBlock)
        .first<{ t: number | null }>();
      auditedTo = a?.t ?? null;
    }
    let recorded: string[] | null = null;
    let recordedByOthers: string[] | null = null;
    if (span) {
      const rows =
        (
          await db
            .prepare(`SELECT tx_hash, found_by FROM failed_tx WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3 AND replaced_at IS NULL`)
            .bind(chainId, span.from, span.to)
            .all<{ tx_hash: string; found_by: string }>()
        ).results ?? [];
      recorded = [...new Set(rows.map((r) => r.tx_hash))];
      recordedByOthers = [...new Set(rows.filter((r) => r.found_by !== 'audit').map((r) => r.tx_hash))];
    }
    const state: FailedTxPassState = {
      cursor: c
        ? {
            mode: c.mode,
            blockNumber: c.block_number,
            blockTime: c.block_time,
            watchedShareBps: c.watched_share_bps,
            slowBlockNumber: c.slow_block_number,
            listFromBlock: c.list_from_block,
            auditPlan: plan,
          }
        : null,
      checkpoints,
      auditedTo,
      recorded,
      recordedByOthers,
    };
    return json(state, 200);
  } catch (e) {
    // The detail stays in the Worker's log; the caller gets a fixed answer.
    console.error('[failedTx] state read failed', redactedError(e));
    return json({ error: 'unavailable' }, 503);
  }
}

// ─── Health ──────────────────────────────────────────────────────────────

export interface FailedTxChainHealth {
  chainId: number;
  mode: string | null;
  /** The highest block the pass finished, and when that block was made. */
  /** `diamond` is the Diamond the position was written under; `current` says whether it is the bundle's. */
  cursor: { blockNumber: number; blockTime: number; ageSeconds: number; updatedAt: number; diamond: string; current: boolean } | null;
  /** In sends-and-audit mode, the share of the day failures by others are watched (bps); the rest is not watched. */
  watchedShareBps: number | null;
  newestCheckpoint: { blockNumber: number; blockHash: string } | null;
  lastReplacement: { fromBlock: number; toBlock: number; foundAt: number; marked: number } | null;
  gaps: { count: number; latest: { fromBlock: number; toBlock: number; reason: string } | null };
  /**
   * The audit's measured miss rate so far: missed of found, over every slice
   * the list had been asked about. `unmeasured` counts slices read where the
   * list was never asked (before its coverage began), whose finds are
   * recorded but are not misses.
   */
  audit: { windows: number; found: number; missed: number; missRateBps: number | null; unmeasured: number };
  recordsLast24h: number;
}

/** `GET /health/failed-tx`. Null tables (before migration 0123) answer 503. */
export async function handleFailedTxHealth(db: { prepare(sql: string): D1Stmt }, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<Response> {
  try {
    const t = now();
    const q = async <T>(sql: string, ...binds: unknown[]) => ((await db.prepare(sql).bind(...binds).all<T>()).results ?? []) as T[];
    const cursors = await q<{ chain_id: number; diamond: string; mode: string; block_number: number; block_time: number; watched_share_bps: number | null; updated_at: number }>(
      'SELECT chain_id, diamond, mode, block_number, block_time, watched_share_bps, updated_at FROM failed_tx_cursor',
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
    const audits = await q<{ chain_id: number; windows: number; found: number | null; missed: number | null; unmeasured: number }>(
      `SELECT chain_id, COUNT(missed) AS windows, SUM(CASE WHEN missed IS NOT NULL THEN found END) AS found, SUM(missed) AS missed,
         SUM(CASE WHEN missed IS NULL THEN 1 ELSE 0 END) AS unmeasured
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
        cursor: c
          ? {
              blockNumber: c.block_number,
              blockTime: c.block_time,
              ageSeconds: Math.max(0, t - c.block_time),
              updatedAt: c.updated_at,
              diamond: c.diamond,
              current: c.diamond === getDeployment(c.chain_id)?.diamond.toLowerCase(),
            }
          : null,
        watchedShareBps: c?.watched_share_bps ?? null,
        newestCheckpoint: p ? { blockNumber: p.block_number, blockHash: p.block_hash } : null,
        lastReplacement: r ? { fromBlock: r.from_block, toBlock: r.to_block, foundAt: r.found_at, marked: r.marked } : null,
        gaps: { count: g?.n ?? 0, latest: g ? { fromBlock: g.from_block, toBlock: g.to_block, reason: g.reason } : null },
        audit: {
          windows: a?.windows ?? 0,
          found: a?.found ?? 0,
          missed: a?.missed ?? 0,
          missRateBps: a && (a.found ?? 0) > 0 ? Math.round(((a.missed ?? 0) * 10_000) / a.found!) : null,
          unmeasured: a?.unmeasured ?? 0,
        },
        recordsLast24h: recent.find((x) => x.chain_id === chainId)?.n ?? 0,
      };
    });
    return json({ chains: out }, 200);
  } catch (e) {
    // A public route: the detail stays in the Worker's log.
    console.error('[failedTx] health read failed', redactedError(e));
    return json({ error: 'unavailable' }, 503);
  }
}
