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
 *   - `settings_history`: a row per settings change, with the event, its own
 *     values and the transaction, plus the full settings read at the END of
 *     the block (`values_basis`). A reader folds the events' own values in
 *     order (`settingsAt`), which is exact between two changes in one block;
 *     the read covers what no event carries, and in a block with more than
 *     one change every row but the last is marked `unknown_between`.
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
 * Largest JSON payload one statement carries. D1 bounds a bound string at
 * 2 MB; a block's rows are split into statements of at most this size, so a
 * block costs a few statements whatever its log count (Codex #4016 r1: one
 * statement per log or per selector let one large cut outrun a pass's whole
 * D1 allowance, and the first block of a pass has no floor to stop at).
 */
export const HISTORY_PAYLOAD_BYTES = 512_000;

/** Rows as JSON arrays of at most HISTORY_PAYLOAD_BYTES each. */
function payloads(rows: readonly unknown[]): string[] {
  const out: string[] = [];
  let chunk: string[] = [];
  let size = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (chunk.length > 0 && size + text.length + 1 > HISTORY_PAYLOAD_BYTES) {
      out.push(`[${chunk.join(',')}]`);
      chunk = [];
      size = 2;
    }
    chunk.push(text);
    size += text.length + 1;
  }
  if (chunk.length > 0) out.push(`[${chunk.join(',')}]`);
  return out;
}

/**
 * A cut's routing changes, one per selector, each the selector's LAST entry
 * in the cut: the cut is applied entry by entry inside one call, so only its
 * final routing is ever in force (Codex #4016 r1: a cut that removes a
 * selector and adds it again would otherwise keep the removal).
 */
function cutChanges(args: Record<string, unknown>): Array<{ selector: string; action: string; facet: string | null }> {
  const cuts = (args._diamondCut ?? args.diamondCut ?? []) as Array<{
    facetAddress: string;
    action: number;
    functionSelectors: readonly string[];
  }>;
  const last = new Map<string, { selector: string; action: string; facet: string | null }>();
  for (const cut of cuts) {
    const action = DIAMOND_CUT_ACTIONS[Number(cut.action)] ?? `action-${Number(cut.action)}`;
    for (const raw of cut.functionSelectors) {
      const selector = raw.toLowerCase();
      last.delete(selector);
      last.set(selector, { selector, action, facet: action === 'remove' ? null : cut.facetAddress.toLowerCase() });
    }
  }
  return [...last.values()];
}

/**
 * The statements that record one block's logs in the three histories: a few
 * statements per table, each inserting many rows from one JSON payload. The
 * caller runs them in one batch with nothing else, so a block is recorded
 * whole or not at all, and a block recorded twice changes nothing (every row
 * is keyed, INSERT OR IGNORE). `isSettingsEvent` names the settings changes
 * (the protocol config snapshot's list, less `DiamondCut`, which is the facet
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
  const ordered = [...opts.logs].sort((a, b) => a.logIndex - b.logIndex);
  if (ordered.length === 0) return [];
  const blockNumber = Number(ordered[0]!.blockNumber);
  const events: unknown[] = [];
  const facets: unknown[] = [];
  const settings: Array<{ l: number; t: number; h: string; n: string; g: string; u: number }> = [];
  for (const log of ordered) {
    const decoded = decodeWatchedLog(log);
    const address = log.address.toLowerCase();
    const txHash = log.transactionHash.toLowerCase();
    events.push({
      l: log.logIndex,
      t: log.transactionIndex,
      h: txHash,
      a: address,
      z: log.topics[0]?.toLowerCase() ?? null,
      n: decoded?.eventName ?? null,
      g: decoded ? argsJson(decoded.args) : null,
      r: decoded ? null : JSON.stringify({ topics: log.topics, data: log.data }),
    });
    if (!decoded || address !== diamond) continue;
    if (decoded.eventName === 'DiamondCut') {
      for (const c of cutChanges(decoded.args)) {
        facets.push({ l: log.logIndex, t: log.transactionIndex, h: txHash, s: c.selector, x: c.action, f: c.facet });
      }
    } else if (opts.isSettingsEvent(decoded.eventName)) {
      settings.push({ l: log.logIndex, t: log.transactionIndex, h: txHash, n: decoded.eventName, g: argsJson(decoded.args), u: 0 });
    }
  }
  // Every settings row but the block's last carries the block's LAST values
  // in its end-of-block read, not the ones in force between it and the next.
  settings.forEach((row, i) => (row.u = i < settings.length - 1 ? 1 : 0));

  const out: HistoryStatement[] = [];
  for (const json of payloads(events)) {
    out.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO chain_event_log
             (chain_id, block_number, log_index, tx_index, tx_hash, address, topic0, event_name, args_json, raw_json, block_at)
           SELECT ?1, ?2, json_extract(value, '$.l'), json_extract(value, '$.t'), json_extract(value, '$.h'),
                  json_extract(value, '$.a'), json_extract(value, '$.z'), json_extract(value, '$.n'),
                  json_extract(value, '$.g'), json_extract(value, '$.r'), ?3
             FROM json_each(?4)`,
        )
        .bind(chainId, blockNumber, blockAt, json),
    );
  }
  for (const json of payloads(facets)) {
    out.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO facet_history
             (chain_id, block_number, tx_index, log_index, tx_hash, selector, action, facet, block_at)
           SELECT ?1, ?2, json_extract(value, '$.t'), json_extract(value, '$.l'), json_extract(value, '$.h'),
                  json_extract(value, '$.s'), json_extract(value, '$.x'), json_extract(value, '$.f'), ?3
             FROM json_each(?4)`,
        )
        .bind(chainId, blockNumber, blockAt, json),
    );
  }
  for (const json of payloads(settings)) {
    out.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO settings_history
             (chain_id, block_number, tx_index, log_index, tx_hash, event_name, event_args_json, unknown_between, block_at)
           SELECT ?1, ?2, json_extract(value, '$.t'), json_extract(value, '$.l'), json_extract(value, '$.h'),
                  json_extract(value, '$.n'), json_extract(value, '$.g'), json_extract(value, '$.u'), ?3
             FROM json_each(?4)`,
        )
        .bind(chainId, blockNumber, blockAt, json),
    );
  }
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
 * The settings events that name WHICH setting they change in an argument
 * (one event, many settings): each value of that argument is a setting of
 * its own in the event layer.
 */
export const KEYED_SETTINGS_EVENTS: Readonly<Record<string, string>> = {
  KeeperTierSet: 'asset',
  AssetMinPartialBpsUpdated: 'asset',
  RewardReporterConfigUpdated: 'key',
  SwapAdapterDisabledSet: 'adapter',
};

/**
 * The settings events that say a setting changed without carrying its new
 * value (a count, or one entry of a list): the event layer records the
 * change, and the value is only in the end-of-block read.
 */
export const VALUE_NOT_CARRIED_EVENTS: ReadonlySet<string> = new Set([
  'SwapAdapterAdded',
  'SwapAdapterRemoved',
  'TreasuryConvertTargetsSet',
  'PaaAssetsSet',
  // Carries only the bucket count, not the thresholds or grace periods.
  'GraceBucketsUpdated',
  // Carries only the new version number, not the tier table.
  'TierTableVersionBumped',
]);

/** One setting as the events up to a point describe it. */
export interface EventSetting {
  /** The event that last changed it, and where. */
  eventName: string;
  args: Record<string, unknown>;
  block: number;
  txIndex: number;
  logIndex: number;
  /** False when the event says the setting changed but not to what. */
  carriesValue: boolean;
}

/** The key a settings event is folded under in the event layer. */
export function eventSettingKey(eventName: string, args: Record<string, unknown>): string {
  const keyArg = KEYED_SETTINGS_EVENTS[eventName];
  if (!keyArg) return eventName;
  const v = args[keyArg];
  return `${eventName}(${typeof v === 'string' ? v.toLowerCase() : String(v)})`;
}

/**
 * The settings in force at a point, in two layers (TroubleshootingPictureDesign
 * §4.5):
 *
 *   - `fromEvents`: every setting as the events before the point carry it,
 *     each event's own values applied over the one before. Exact for a
 *     transaction between two changes in one block, and kept even when the
 *     block's state cannot be read.
 *   - `inForce`: the last change before the point, with the full settings
 *     read at the END of its block (`values_basis`). That read covers what
 *     no event carries; `unknown_between` says a later change in the same
 *     block is folded into it, so for the stretch between the two only the
 *     event layer is exact.
 *
 * `inBlock` lists the changes made inside the point's block from the point
 * on. `historyFrom` is the first block on record (null: none yet); a point
 * below it, or a setting never changed since it, is not described by the
 * event layer.
 */
export async function settingsAt(
  db: HistoryDb,
  chainId: number,
  at: ChainPoint,
): Promise<{
  historyFrom: number | null;
  fromEvents: Record<string, EventSetting>;
  inForce: SettingsRow | null;
  inBlock: SettingsRow[];
}> {
  const tx = at.txIndex ?? 0;
  // The first block on record. Nothing is recorded below it, so a reader is
  // told where the record begins rather than shown an empty past as a quiet
  // one (an indexer that took this build on mid-chain has no history below
  // it; a new Diamond's record begins with its deploy cut).
  const coverage = await db
    .prepare(`SELECT MIN(block_number) AS from_block FROM chain_event_log WHERE chain_id = ?1`)
    .bind(chainId)
    .first<{ from_block: number | null }>();
  const before = await db
    .prepare(
      `SELECT block_number, tx_index, log_index, tx_hash, event_name, event_args_json, values_basis, values_json, unknown_between, read_error, block_at
         FROM settings_history
        WHERE chain_id = ?1 AND (block_number < ?2 OR (block_number = ?2 AND tx_index < ?3))
        ORDER BY block_number, tx_index, log_index`,
    )
    .bind(chainId, at.block, tx)
    .all<SettingsRow>();
  const fromEvents: Record<string, EventSetting> = {};
  for (const row of before.results) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(row.event_args_json) as Record<string, unknown>;
    } catch {
      // a row this build wrote always parses; anything else is skipped
    }
    fromEvents[eventSettingKey(row.event_name, args)] = {
      eventName: row.event_name,
      args,
      block: row.block_number,
      txIndex: row.tx_index,
      logIndex: row.log_index,
      carriesValue: !VALUE_NOT_CARRIED_EVENTS.has(row.event_name),
    };
  }
  const inBlock = await db
    .prepare(
      `SELECT block_number, tx_index, log_index, tx_hash, event_name, event_args_json, values_basis, values_json, unknown_between, read_error, block_at
         FROM settings_history
        WHERE chain_id = ?1 AND block_number = ?2 AND tx_index >= ?3
        ORDER BY tx_index, log_index`,
    )
    .bind(chainId, at.block, tx)
    .all<SettingsRow>();
  return {
    historyFrom: coverage?.from_block ?? null,
    fromEvents,
    inForce: before.results.at(-1) ?? null,
    inBlock: inBlock.results,
  };
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
