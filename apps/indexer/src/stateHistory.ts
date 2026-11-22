/**
 * The indexer's event history and the state at a block (#3921,
 * TroubleshootingPictureDesign.md §4.5 and §4.6).
 *
 * Three histories, written by the scan in the same pass as the block they
 * come from (migration 0125):
 *
 *   - `chain_event_log`: every log the platform's contracts emit, decoded
 *     where one of the platform's ABIs describes it and kept raw where none
 *     does. The users' feed (`activity_events`) is unchanged; this is the full
 *     record an operator reads, informational events included.
 *   - `settings_history`: a row per settings change, with the event and the
 *     transaction. Its values are read at the END of the block, and the row
 *     says so (`values_basis`): today's settings events do not all carry the
 *     whole new value, so the row never claims more than the read gives. In a
 *     block with more than one change, every row but the last is marked
 *     `unknown_between`.
 *   - `facet_history`: every change to the Diamond's routing, from its
 *     `DiamondCut` event, one row per function.
 *
 * "What was true" is asked for a transaction (block and its place in the
 * block) and answered by the last row placed before it. Asked for a block
 * alone, it is answered for the start of the block, with the changes made
 * inside the block listed beside it.
 */
import { decodeEventLog, toEventSelector, toEventSignature, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import * as ABIS from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { watchedAddresses } from '@vaipakam/lib/watchedContracts';
import { describeFailure } from '@vaipakam/lib/errorDescription';

/** A log as `eth_getLogs` returns it, the fields the histories read. */
export interface RawLog {
  address: string;
  blockNumber: bigint;
  logIndex: number;
  transactionIndex: number;
  transactionHash: string;
  topics: readonly Hex[];
  data: Hex;
}

/** The D1 surface this module uses. */
export interface HistoryDb {
  prepare(sql: string): {
    bind(...args: unknown[]): HistoryStatement;
  };
  batch(statements: HistoryStatement[]): Promise<unknown>;
}
export interface HistoryStatement {
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

// ─── Decoding ────────────────────────────────────────────────────────────

/**
 * Every event any of the platform's exported ABIs declares, by topic0. One
 * topic0 can name more than one declaration (an ERC-20 and an ERC-721
 * `Transfer` differ only in which arguments are indexed), so each topic0 keeps
 * every distinct declaration and a log is decoded by the first that fits it
 * exactly.
 */
const EVENTS_BY_TOPIC: ReadonlyMap<string, readonly AbiEvent[]> = (() => {
  const byTopic = new Map<string, AbiEvent[]>();
  const seen = new Set<string>();
  for (const abi of Object.values(ABIS)) {
    if (!Array.isArray(abi)) continue;
    for (const item of abi as Abi) {
      if (item.type !== 'event' || (item as AbiEvent).anonymous) continue;
      const ev = item as AbiEvent;
      let topic: string;
      let shape: string;
      try {
        topic = toEventSelector(toEventSignature(ev)).toLowerCase();
        shape = `${topic}:${ev.inputs.map((i) => (i.indexed ? 'i' : 'd')).join('')}`;
      } catch {
        continue;
      }
      if (seen.has(shape)) continue;
      seen.add(shape);
      const list = byTopic.get(topic);
      if (list) list.push(ev);
      else byTopic.set(topic, [ev]);
    }
  }
  return byTopic;
})();

/** The log decoded by the first declaration that fits it exactly, or null when none does. */
export function decodeWatchedLog(log: { topics: readonly Hex[]; data: Hex }): { eventName: string; args: Record<string, unknown> } | null {
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return null;
  for (const ev of EVENTS_BY_TOPIC.get(topic0) ?? []) {
    try {
      const d = decodeEventLog({ abi: [ev], topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      return { eventName: d.eventName as string, args: (d.args ?? {}) as Record<string, unknown> };
    } catch {
      // not this declaration
    }
  }
  return null;
}

/**
 * The addresses whose logs the event history keeps on a network: the scan's
 * own (the Diamond and its position token) and every other platform contract
 * in the deployment record, without the testnet's mock assets.
 */
export function historyAddresses(chainId: number, scanned: readonly string[]): Address[] {
  const dep = getDeployment(chainId) as unknown as Record<string, unknown> | undefined;
  const all = new Set(scanned.map((a) => a.toLowerCase()));
  if (dep) for (const a of watchedAddresses(dep, { includeTestnetMocks: false })) all.add(a);
  return [...all] as Address[];
}

export function argsJson(args: unknown): string {
  return JSON.stringify(args, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

// ─── Writing, per block ──────────────────────────────────────────────────

const DIAMOND_CUT_ACTIONS = ['add', 'replace', 'remove'] as const;

/**
 * The statements that record one block's logs in the three histories. The
 * caller runs them in one batch with nothing else, so a block is recorded
 * whole or not at all. `isSettingsEvent` names the settings changes (the
 * protocol config snapshot's list, less `DiamondCut`, which is the facet
 * history's).
 */
export function historyStatements(opts: {
  db: HistoryDb;
  chainId: number;
  diamond: string;
  blockAt: number;
  logs: readonly RawLog[];
  isSettingsEvent: (eventName: string) => boolean;
}): HistoryStatement[] {
  const { db, chainId, blockAt } = opts;
  const diamond = opts.diamond.toLowerCase();
  const out: HistoryStatement[] = [];
  const settings: Array<{ log: RawLog; eventName: string; args: Record<string, unknown> }> = [];
  const ordered = [...opts.logs].sort((a, b) => a.logIndex - b.logIndex);
  for (const log of ordered) {
    const decoded = decodeWatchedLog(log);
    const address = log.address.toLowerCase();
    out.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO chain_event_log
             (chain_id, block_number, log_index, tx_index, tx_hash, address, topic0, event_name, args_json, raw_json, block_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .bind(
          chainId,
          Number(log.blockNumber),
          log.logIndex,
          log.transactionIndex,
          log.transactionHash.toLowerCase(),
          address,
          log.topics[0]?.toLowerCase() ?? null,
          decoded?.eventName ?? null,
          decoded ? argsJson(decoded.args) : null,
          decoded ? null : JSON.stringify({ topics: log.topics, data: log.data }),
          blockAt,
        ),
    );
    if (!decoded || address !== diamond) continue;
    if (decoded.eventName === 'DiamondCut') {
      const cuts = (decoded.args._diamondCut ?? decoded.args.diamondCut ?? []) as Array<{
        facetAddress: string;
        action: number;
        functionSelectors: readonly string[];
      }>;
      for (const cut of cuts) {
        const action = DIAMOND_CUT_ACTIONS[Number(cut.action)] ?? `action-${Number(cut.action)}`;
        for (const selector of cut.functionSelectors) {
          out.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO facet_history
                   (chain_id, block_number, tx_index, log_index, tx_hash, selector, action, facet, block_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
              )
              .bind(
                chainId,
                Number(log.blockNumber),
                log.transactionIndex,
                log.logIndex,
                log.transactionHash.toLowerCase(),
                selector.toLowerCase(),
                action,
                action === 'remove' ? null : cut.facetAddress.toLowerCase(),
                blockAt,
              ),
          );
        }
      }
    } else if (opts.isSettingsEvent(decoded.eventName)) {
      settings.push({ log, eventName: decoded.eventName, args: decoded.args });
    }
  }
  settings.forEach(({ log, eventName, args }, i) => {
    out.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO settings_history
             (chain_id, block_number, tx_index, log_index, tx_hash, event_name, event_args_json, unknown_between, block_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          chainId,
          Number(log.blockNumber),
          log.transactionIndex,
          log.logIndex,
          log.transactionHash.toLowerCase(),
          eventName,
          argsJson(args),
          i < settings.length - 1 ? 1 : 0,
          blockAt,
        ),
    );
  });
  return out;
}

// ─── Filling the settings rows' values ───────────────────────────────────

/** A settings read that never answers for a block is given up after this many tries. */
export const SETTINGS_READ_ATTEMPTS = 3;

/**
 * Reads the settings at the end of the oldest blocks whose rows are still
 * pending, at most `maxBlocks` per call, and stores them on every row of that
 * block. `read` is the protocol config read pinned to a block; a failure
 * counts an attempt, and after SETTINGS_READ_ATTEMPTS the rows are marked
 * 'unreadable' with the reason (a node that no longer holds that block's
 * state), never filled with another block's values.
 */
export async function fillSettingsHistory(opts: {
  db: HistoryDb;
  chainId: number;
  /** Only blocks at or below this (the scan's cursor) are read. */
  throughBlock: number;
  maxBlocks: number;
  /** May another block be read in this pass? Asked before each. */
  canRead: () => boolean;
  read: (blockNumber: bigint) => Promise<unknown>;
}): Promise<number> {
  const { db, chainId } = opts;
  const blocks = await db
    .prepare(
      `SELECT DISTINCT block_number FROM settings_history
        WHERE chain_id = ?1 AND values_basis = 'pending' AND block_number <= ?2
        ORDER BY block_number LIMIT ?3`,
    )
    .bind(chainId, opts.throughBlock, opts.maxBlocks)
    .all<{ block_number: number }>();
  let filled = 0;
  for (const { block_number } of blocks.results) {
    if (!opts.canRead()) break;
    try {
      const values = await opts.read(BigInt(block_number));
      await db
        .prepare(
          `UPDATE settings_history SET values_basis = 'end-of-block', values_json = ?3, read_error = NULL
            WHERE chain_id = ?1 AND block_number = ?2 AND values_basis = 'pending'`,
        )
        .bind(chainId, block_number, argsJson(values))
        .run();
      filled++;
    } catch (e) {
      await db
        .prepare(
          `UPDATE settings_history
              SET read_attempts = read_attempts + 1, read_error = ?3,
                  values_basis = CASE WHEN read_attempts + 1 >= ?4 THEN 'unreadable' ELSE 'pending' END
            WHERE chain_id = ?1 AND block_number = ?2 AND values_basis = 'pending'`,
        )
        .bind(chainId, block_number, describeFailure(e), SETTINGS_READ_ATTEMPTS)
        .run();
    }
  }
  return filled;
}

// ─── Asking what was true ────────────────────────────────────────────────

/** A point in the chain: a block, and optionally a transaction's place in it. */
export interface ChainPoint {
  block: number;
  /** The transaction's place in the block. Absent: the start of the block. */
  txIndex?: number;
}

export interface SettingsRow {
  block_number: number;
  tx_index: number;
  log_index: number;
  tx_hash: string;
  event_name: string;
  event_args_json: string;
  values_basis: string;
  values_json: string | null;
  unknown_between: number;
  read_error: string | null;
  block_at: number;
}

/**
 * The settings in force at a point: the last change placed before it, and the
 * changes made inside the point's block (all of them when asked for a block,
 * those from the transaction on when asked for a transaction). `inForce` is
 * null when no change has been recorded before the point.
 */
export async function settingsAt(db: HistoryDb, chainId: number, at: ChainPoint): Promise<{ inForce: SettingsRow | null; inBlock: SettingsRow[] }> {
  const tx = at.txIndex ?? 0;
  const inForce = await db
    .prepare(
      `SELECT block_number, tx_index, log_index, tx_hash, event_name, event_args_json, values_basis, values_json, unknown_between, read_error, block_at
         FROM settings_history
        WHERE chain_id = ?1 AND (block_number < ?2 OR (block_number = ?2 AND tx_index < ?3))
        ORDER BY block_number DESC, tx_index DESC, log_index DESC LIMIT 1`,
    )
    .bind(chainId, at.block, tx)
    .first<SettingsRow>();
  const inBlock = await db
    .prepare(
      `SELECT block_number, tx_index, log_index, tx_hash, event_name, event_args_json, values_basis, values_json, unknown_between, read_error, block_at
         FROM settings_history
        WHERE chain_id = ?1 AND block_number = ?2 AND tx_index >= ?3
        ORDER BY tx_index, log_index`,
    )
    .bind(chainId, at.block, tx)
    .all<SettingsRow>();
  return { inForce, inBlock: inBlock.results };
}

export interface FacetRow {
  block_number: number;
  tx_index: number;
  log_index: number;
  tx_hash: string;
  selector: string;
  action: string;
  facet: string | null;
}

/**
 * The code serving `selector` at a point: the last routing change for it
 * placed before the point (null `facet` after a removal; `lastChange` null
 * when the history records none), and the changes to it inside the block.
 */
export async function facetAt(
  db: HistoryDb,
  chainId: number,
  selector: string,
  at: ChainPoint,
): Promise<{ lastChange: FacetRow | null; inBlock: FacetRow[] }> {
  const tx = at.txIndex ?? 0;
  const sel = selector.toLowerCase();
  const lastChange = await db
    .prepare(
      `SELECT block_number, tx_index, log_index, tx_hash, selector, action, facet
         FROM facet_history
        WHERE chain_id = ?1 AND selector = ?2 AND (block_number < ?3 OR (block_number = ?3 AND tx_index < ?4))
        ORDER BY block_number DESC, tx_index DESC, log_index DESC LIMIT 1`,
    )
    .bind(chainId, sel, at.block, tx)
    .first<FacetRow>();
  const inBlock = await db
    .prepare(
      `SELECT block_number, tx_index, log_index, tx_hash, selector, action, facet
         FROM facet_history
        WHERE chain_id = ?1 AND selector = ?2 AND block_number = ?3 AND tx_index >= ?4
        ORDER BY tx_index, log_index`,
    )
    .bind(chainId, sel, at.block, tx)
    .all<FacetRow>();
  return { lastChange, inBlock: inBlock.results };
}
