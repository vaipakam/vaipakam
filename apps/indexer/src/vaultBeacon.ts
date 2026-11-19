/**
 * #3281 / #3422 — the chain's VaultBeacon events: what the indexer reads,
 * stores and serves.
 *
 * Every user vault is a beacon proxy (#3204). The beacon announces a coming
 * code change (`CurrentVaultVersionProposed`, `VaultRevokeProposed`), its
 * execution or cancel, an emergency revoke, and each vault's pin requests,
 * pins, unpins and pin-delay changes. The scan reads the beacon's logs in the
 * SAME `eth_getLogs` as the Diamond's (no extra request), decodes them with
 * the beacon's own ABI by ADDRESS (the beacon's `OwnershipTransferred` has the
 * Diamond's signature, so decoding by topic alone would misfile it), and
 * writes them per block beside the block's other rows (`vault_beacon_events`,
 * migration 0108).
 *
 * The rows are the chain's statements as decoded. The route serves them with
 * the block they run through; it derives no "pending" state, because the
 * beacon is the source of truth for that and the app reads it there.
 */
import { decodeEventLog, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { VaultBeaconABI } from '@vaipakam/contracts/abis';
import { DEPLOYMENTS } from '@vaipakam/contracts/deployments';
import { redactedError } from '@vaipakam/lib/errorDescription';
import type { Env } from './env';
import { chainNotServed, requestedChainId } from './servedChain';

/** The beacon events the indexer keeps: every one but the EIP-712 domain
 *  notice, which says nothing about any vault's code. */
export const BEACON_EVENTS: readonly AbiEvent[] = (VaultBeaconABI as Abi).filter(
  (i): i is AbiEvent => i.type === 'event' && i.name !== 'EIP712DomainChanged',
);
export const BEACON_EVENT_NAMES: ReadonlySet<string> = new Set(BEACON_EVENTS.map((e) => e.name));

/** The beacon of the chain whose Diamond is `diamond`; null when its record
 *  names none (a deployment that predates #3204). */
export function vaultBeaconForDiamond(diamond: string): Address | null {
  const want = diamond.toLowerCase();
  for (const d of Object.values(DEPLOYMENTS)) {
    if (d?.diamond?.toLowerCase() === want) return (d.vaultBeacon as Address | undefined) ?? null;
  }
  return null;
}

/** One decoded beacon log. */
export interface BeaconLog {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  eventName: string;
  args: Record<string, unknown>;
}

interface RawLog {
  address?: string;
  topics: readonly Hex[];
  data: Hex;
  blockNumber?: bigint | null;
  logIndex?: number | null;
  transactionHash?: string | null;
}

/** Whether a raw log came from `beacon`. */
export function isFromBeacon(raw: RawLog, beacon: Address | null): boolean {
  return beacon !== null && typeof raw.address === 'string' && raw.address.toLowerCase() === beacon.toLowerCase();
}

/** Decode the beacon's raw logs with the beacon's ABI; a log it does not
 *  declare is skipped. */
export function decodeBeaconLogs(raws: readonly RawLog[]): BeaconLog[] {
  const out: BeaconLog[] = [];
  for (const raw of raws) {
    if (raw.blockNumber == null || raw.logIndex == null || !raw.transactionHash) continue;
    try {
      const d = decodeEventLog({ abi: BEACON_EVENTS, topics: raw.topics as [Hex, ...Hex[]], data: raw.data }) as {
        eventName: string;
        args: Record<string, unknown>;
      };
      out.push({ blockNumber: raw.blockNumber, logIndex: raw.logIndex, transactionHash: raw.transactionHash, eventName: d.eventName, args: d.args });
    } catch {
      continue;
    }
  }
  return out;
}

const text = (v: unknown): string | null => (typeof v === 'bigint' ? v.toString() : typeof v === 'number' ? String(v) : null);
const lowerAddr = (v: unknown): string | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);

/** The indexed columns of one beacon event. */
export function beaconColumns(log: Pick<BeaconLog, 'eventName' | 'args'>): {
  vault: string | null;
  versionId: string | null;
  executableAt: number | null;
} {
  const a = log.args;
  // The version an event is about: `id` for the code events, `newId` for an
  // execution, `target` for a pin request or cancel.
  const versionId = text(a.id ?? a.newId ?? a.target);
  const at = text(a.executableAt);
  return { vault: lowerAddr(a.vault), versionId, executableAt: at === null ? null : Number(at) };
}

function argsJson(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** The statements storing one block's beacon logs. Idempotent: a re-scan of
 *  the block writes the same keys. */
export function beaconRowStatements(db: D1Database, chainId: number, logs: readonly BeaconLog[], blockAt: number): D1PreparedStatement[] {
  return logs.map((log) => {
    const c = beaconColumns(log);
    return db
      .prepare(
        `INSERT OR IGNORE INTO vault_beacon_events
           (chain_id, block_number, log_index, tx_hash, kind, vault, version_id, executable_at, args_json, block_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        chainId,
        Number(log.blockNumber),
        log.logIndex,
        log.transactionHash.toLowerCase(),
        log.eventName,
        c.vault,
        c.versionId,
        c.executableAt,
        argsJson(log.args),
        blockAt,
      );
  });
}

// ── GET /vault-beacon/events ─────────────────────────────────────────────

/** The narrow D1 surface the route reads. */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

interface BeaconRow {
  block_number: number;
  log_index: number;
  tx_hash: string;
  kind: string;
  vault: string | null;
  version_id: string | null;
  executable_at: number | null;
  args_json: string;
  block_at: number;
}

export interface BeaconEventJson {
  blockNumber: number;
  logIndex: number;
  txHash: string;
  kind: string;
  vault: string | null;
  versionId: string | null;
  executableAt: number | null;
  args: Record<string, unknown> | string;
  blockAt: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Parsed query, or an error code for a 400. */
export function parseBeaconQuery(params: URLSearchParams):
  | { ok: true; vault: string | null; kinds: string[]; limit: number; before: { block: number; logIndex: number } | null }
  | { ok: false; error: string } {
  const vaultRaw = params.get('vault');
  if (vaultRaw !== null && !/^0x[0-9a-fA-F]{40}$/.test(vaultRaw)) return { ok: false, error: 'bad-vault' };
  const kindRaw = params.get('kind');
  const kinds = kindRaw ? kindRaw.split(',') : [];
  if (kinds.some((k) => !BEACON_EVENT_NAMES.has(k))) return { ok: false, error: 'bad-kind' };
  const limitRaw = params.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    if (!/^[1-9]\d{0,3}$/.test(limitRaw)) return { ok: false, error: 'bad-limit' };
    limit = Math.min(Number(limitRaw), MAX_LIMIT);
  }
  const beforeRaw = params.get('before');
  let before: { block: number; logIndex: number } | null = null;
  if (beforeRaw !== null) {
    const m = beforeRaw.match(/^(\d{1,15}):(\d{1,9})$/);
    if (!m) return { ok: false, error: 'bad-before' };
    before = { block: Number(m[1]), logIndex: Number(m[2]) };
  }
  return { ok: true, vault: vaultRaw?.toLowerCase() ?? null, kinds, limit, before };
}

function rowToJson(r: BeaconRow): BeaconEventJson {
  let args: Record<string, unknown> | string;
  try {
    args = JSON.parse(r.args_json) as Record<string, unknown>;
  } catch {
    args = r.args_json;
  }
  return {
    blockNumber: r.block_number,
    logIndex: r.log_index,
    txHash: r.tx_hash,
    kind: r.kind,
    vault: r.vault,
    versionId: r.version_id,
    executableAt: r.executable_at,
    args,
    blockAt: r.block_at,
  };
}

/**
 * One page of a chain's beacon events, newest first.
 *
 * `vault=` keeps the events about that vault AND every chain-wide code event
 * (a proposal, execution, cancel or revoke reaches every vault), so a vault
 * page and its alerts read one stream. `throughBlock` is the block the
 * indexer has read the chain through (null before its first pass): an event
 * above it is not yet known here, and the current state is the beacon's own
 * to state, which the app reads from the beacon.
 */
export async function readBeaconEvents(
  db: D1Like,
  chainId: number,
  q: { vault: string | null; kinds: string[]; limit: number; before: { block: number; logIndex: number } | null },
): Promise<{ chainId: number; throughBlock: number | null; events: BeaconEventJson[]; nextBefore: string | null }> {
  const where = ['chain_id = ?'];
  const binds: unknown[] = [chainId];
  if (q.vault) {
    where.push('(vault = ? OR vault IS NULL)');
    binds.push(q.vault);
  }
  if (q.kinds.length > 0) {
    where.push(`kind IN (${q.kinds.map(() => '?').join(', ')})`);
    binds.push(...q.kinds);
  }
  if (q.before) {
    where.push('(block_number, log_index) < (?, ?)');
    binds.push(q.before.block, q.before.logIndex);
  }
  const [rows, cursor] = await Promise.all([
    db
      .prepare(
        `SELECT block_number, log_index, tx_hash, kind, vault, version_id, executable_at, args_json, block_at
           FROM vault_beacon_events WHERE ${where.join(' AND ')}
          ORDER BY block_number DESC, log_index DESC LIMIT ?`,
      )
      .bind(...binds, q.limit)
      .all<BeaconRow>(),
    db.prepare(`SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = 'diamond'`).bind(chainId).first<{ last_block: number }>(),
  ]);
  const events = (rows.results ?? []).map(rowToJson);
  const last = events.length === q.limit ? events[events.length - 1] : null;
  return {
    chainId,
    throughBlock: cursor?.last_block ?? null,
    events,
    nextBefore: last ? `${last.blockNumber}:${last.logIndex}` : null,
  };
}

/** The route. `env` is the resolved env; the chain must be one this Worker indexes. */
export async function handleVaultBeaconEvents(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const headers: HeadersInit = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=10' };
  const chainId = requestedChainId(url);
  const q = parseBeaconQuery(url.searchParams);
  if (!q.ok) return new Response(JSON.stringify({ error: q.error }), { status: 400, headers });
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    return new Response(JSON.stringify(await readBeaconEvents(env.DB as unknown as D1Like, chainId, q)), { headers });
  } catch (err) {
    // Before migration 0108 the table is missing; any read failure is the
    // same answer: the events cannot be stated now, never "none".
    console.error('[indexer] /vault-beacon/events read failed', redactedError(err));
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
}
