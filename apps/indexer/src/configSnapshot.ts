/**
 * RPC read-diet PR B (Alpha02RpcReadDietDesign §4.2.1) — protocol-config
 * snapshot: refresh half + the public GET /config/:chainId route.
 *
 * Protocol config (the `getProtocolConfigBundle` tuple + the range/
 * partial master flags) is chain-only for the apps today: every browser
 * re-reads it on 5–10 min caches even though it changes only on rare
 * governance action. The indexer already scans every Diamond event, so
 * it maintains ONE row per chain here and the apps' DISPLAY surfaces
 * read it with zero per-user RPC. Boundary (design §2, L51–52): pre-sign
 * paths keep reading the Diamond live — the snapshot is display-only.
 *
 * Refresh triggers, both fail-open (a refresh failure never blocks or
 * aborts ingest — the apps fall back to their chain read):
 *   - a scanned log whose event name matches the config-setter shape
 *     (every ConfigFacet/AdminFacet governance event ends in
 *     `...Set` / `...Updated` / `...Bumped`; a false positive costs one
 *     redundant eth_call, a miss costs only the backstop delay);
 *   - a time backstop, so a chain whose config predates this table (or
 *     an event class the suffix rule somehow misses) still converges.
 */

import type { Address, PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { Env } from './env';
import { jsonResponse } from './offerRoutes';

/** Suffixes every governance setter event carries (verified against the
 *  full ConfigFacet/AdminFacet event list at authoring time — see the
 *  unit test pinning representative names). */
const CONFIG_EVENT_SUFFIX = /(Set|Updated|Bumped)$/;

/** Backstop refresh age: config flips are event-driven within one scan
 *  (~60s); the backstop only covers bootstrap + suffix-rule misses. */
const BACKSTOP_SECONDS = 6 * 3600;

export function isConfigEventName(name: string): boolean {
  return CONFIG_EVENT_SUFFIX.test(name);
}

/** Decide whether this scan needs a snapshot refresh. Pure, for tests. */
export function shouldRefreshConfig(opts: {
  sawConfigEvent: boolean;
  rowUpdatedAt: number | null; // null = no row yet
  nowSec: number;
}): boolean {
  if (opts.sawConfigEvent) return true;
  if (opts.rowUpdatedAt === null) return true;
  return opts.nowSec - opts.rowUpdatedAt > BACKSTOP_SECONDS;
}

/** JSON-serialize a tuple with bigints as decimal strings. */
function serializeTuple(values: readonly unknown[]): string {
  return JSON.stringify(
    values.map((v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

/**
 * Refresh the snapshot row for one chain if warranted. Called at the
 * end of a successful scan, AFTER the cursor advance — a failure here
 * logs and returns (fail-open; the row simply stays at its previous
 * state and the apps' chain fallback covers display).
 */
export async function maybeRefreshProtocolConfig(opts: {
  env: Env;
  chainId: number;
  client: PublicClient;
  diamond: Address;
  scannedEventNames: Iterable<string>;
  /** Block to pin the reads to — the scan's upper bound, so the row
   *  can never be AHEAD of what the ingest pass processed. */
  blockNumber: bigint;
}): Promise<void> {
  try {
    let saw = false;
    for (const n of opts.scannedEventNames) {
      if (isConfigEventName(n)) {
        saw = true;
        break;
      }
    }
    const row = await opts.env.DB.prepare(
      `SELECT updated_at FROM protocol_config WHERE chain_id = ?`,
    )
      .bind(opts.chainId)
      .first<{ updated_at: number }>();
    const now = Math.floor(Date.now() / 1000);
    if (
      !shouldRefreshConfig({
        sawConfigEvent: saw,
        rowUpdatedAt: row?.updated_at ?? null,
        nowSec: now,
      })
    ) {
      return;
    }

    const [bundle, flags] = await Promise.all([
      opts.client.readContract({
        address: opts.diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getProtocolConfigBundle',
        blockNumber: opts.blockNumber,
      }) as Promise<readonly unknown[]>,
      opts.client.readContract({
        address: opts.diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getMasterFlags',
        blockNumber: opts.blockNumber,
      }) as Promise<readonly [boolean, boolean, boolean]>,
    ]);

    await opts.env.DB.prepare(
      `INSERT INTO protocol_config
         (chain_id, bundle_json, master_flags_json, source_block, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chain_id) DO UPDATE SET
         bundle_json = excluded.bundle_json,
         master_flags_json = excluded.master_flags_json,
         source_block = excluded.source_block,
         updated_at = excluded.updated_at`,
    )
      .bind(
        opts.chainId,
        serializeTuple(bundle),
        JSON.stringify([flags[0], flags[1], flags[2]]),
        Number(opts.blockNumber),
        now,
      )
      .run();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[configSnapshot] refresh failed for chain ${opts.chainId} (fail-open)`,
      err,
    );
  }
}

/** GET /config/:chainId — the display snapshot. `available: false` when
 *  the chain has no row yet (apps fall back to their chain read). */
export async function handleConfigSnapshot(
  chainId: number,
  env: Env,
): Promise<Response> {
  try {
    const row = await env.DB.prepare(
      `SELECT bundle_json, master_flags_json, source_block, updated_at
       FROM protocol_config WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{
        bundle_json: string;
        master_flags_json: string;
        source_block: number;
        updated_at: number;
      }>();
    if (!row) return jsonResponse({ chainId, available: false });
    return jsonResponse({
      chainId,
      available: true,
      bundle: JSON.parse(row.bundle_json) as unknown[],
      masterFlags: JSON.parse(row.master_flags_json) as boolean[],
      sourceBlock: row.source_block,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[configSnapshot] route failed', err);
    return jsonResponse({ error: 'config-failed' }, 500);
  }
}
