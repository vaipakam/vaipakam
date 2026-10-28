// apps/keeper/src/eventLedger.ts
//
// The shared indexer's event ledger (`activity_events`), as the passes that
// are nominated by events read it (#2984): the return transport's
// quarantines, repatriations and send notices, the close-out's removed
// destinations. Every
// read is from the active Diamond's deploy block on (`deploymentFloor`), and
// a read that fails returns null, which a pass treats as "not read this run".
// A row only NOMINATES work: every decision is still an on-chain read.

import { deploymentFloor } from './db';

/** One decoded event the indexer recorded. */
export interface LedgerRow {
  kind: string;
  args: Record<string, unknown>;
  /** Unix seconds of its block. */
  blockAt: number;
  block: number;
  log: number;
  /** Its transaction hash. */
  tx: string;
}

/** A position in a chain's ledger: a row's block and log index. */
export interface LedgerPos {
  block: number;
  log: number;
}

/** Every read is from the active Diamond's deploy block on, and null when the
 *  ledger cannot be read. Neither read is bounded by the ledger's length: one
 *  is keyed by the ids a run already holds, the other is a page from a cursor. */
export interface EventLedger {
  /** The rows of `kinds` on `chainId` whose `arg` is one of `values`, oldest first. */
  matching(chainId: number, kinds: readonly string[], arg: string, values: readonly string[]): Promise<LedgerRow[] | null>;
  /** At most `limit` rows of `kinds` on `chainId` after `after` (from the
   *  start when null), oldest first; `more` when rows remain past them. */
  page(chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number): Promise<{ rows: LedgerRow[]; more: boolean } | null>;
}

export const encodePos = (p: LedgerPos) => `${p.block}:${p.log}`;
export function decodePos(raw: string | undefined): LedgerPos | null {
  const m = raw === undefined ? null : /^(\d+):(\d+)$/.exec(raw);
  return m === null ? null : { block: Number(m[1]), log: Number(m[2]) };
}
export const posAfter = (a: LedgerPos, b: LedgerPos) => a.block > b.block || (a.block === b.block && a.log > b.log);

/** Whether a row's event is in the given (finalized) block or below it. A
 *  floor over ledger rows moves past a row only when this holds: a chain read
 *  at a block below the event shows the state before it, which can read as
 *  "nothing to do" and would put the row below the floor for good. */
export const rowFinalized = (row: LedgerPos, block: { number: bigint }) => BigInt(row.block) <= block.number;


/** The shared indexer's event ledger (`activity_events`). */
export function d1EventLedger(db: D1Database): EventLedger {
  type Row = { kind: string; args_json: string; block_at: number; block_number: number; log_index: number; tx_hash: string };
  const decode = (all: readonly Row[]): LedgerRow[] =>
    all.map((r) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(r.args_json) as Record<string, unknown>;
      } catch {
        // An unreadable row nominates nothing, and still holds its place, so
        // a page past it does not stop at it.
      }
      return { kind: r.kind, args, blockAt: Number(r.block_at), block: Number(r.block_number), log: Number(r.log_index), tx: String(r.tx_hash) };
    });
  return {
    async matching(chainId, kinds, arg, values) {
      if (values.length === 0) return [];
      try {
        const k = kinds.map((_, i) => `?${i + 3}`).join(', ');
        const v = values.map((_, i) => `?${i + 3 + kinds.length}`).join(', ');
        const rows = await db
          .prepare(
            `SELECT kind, args_json, block_at, block_number, log_index, tx_hash FROM activity_events
              WHERE chain_id = ?1 AND block_number >= ?2 AND kind IN (${k})
                AND CAST(json_extract(args_json, '$.${arg.replace(/[^A-Za-z0-9_]/g, '')}') AS TEXT) IN (${v})
              ORDER BY block_number ASC, log_index ASC`,
          )
          .bind(chainId, deploymentFloor(chainId), ...kinds, ...values)
          .all<Row>();
        return decode(rows.results ?? []);
      } catch {
        return null;
      }
    },
    async page(chainId, kinds, after, limit) {
      try {
        const k = kinds.map((_, i) => `?${i + 5}`).join(', ');
        const rows = await db
          .prepare(
            `SELECT kind, args_json, block_at, block_number, log_index, tx_hash FROM activity_events
              WHERE chain_id = ?1 AND block_number >= ?2 AND kind IN (${k})
                AND (block_number > ?3 OR (block_number = ?3 AND log_index > ?4))
              ORDER BY block_number ASC, log_index ASC
              LIMIT ${limit + 1}`,
          )
          .bind(chainId, deploymentFloor(chainId), after?.block ?? -1, after?.log ?? -1, ...kinds)
          .all<Row>();
        const all = rows.results ?? [];
        return { rows: decode(all.slice(0, limit)), more: all.length > limit };
      } catch {
        return null;
      }
    },
  };
}

