/**
 * RW-77 — the index's snapshot of the protocol's settings (the world rail,
 * RB-RAILS): `GET /config/:chainId`, one row per network that the index
 * re-reads from the chain whenever a governance event or a code change is
 * scanned, and on a schedule besides.
 *
 * This module only reads and checks the answer's shape. Whether the
 * snapshot may be shown is `source.ts`'s decision, made from the facts kept
 * here: when it was recorded, the block it describes, whether the index has
 * marked it behind a governance change, and whether its values carry names.
 */
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { wireWhole } from '../reads/world/wire';

/** A published setting: integers as decimal strings, flags as booleans,
 *  addresses and 32-byte ids as hex text, a fixed list of those, or a list
 *  of records (the grace schedule). */
export type SettingValue = string | boolean | (string | boolean)[] | Record<string, string | boolean>[];

export type SettingValues = Record<string, SettingValue>;

export type ConfigSnapshot =
  /** The index holds no snapshot for this network. */
  | { available: false }
  | {
      available: true;
      /** The labelled values, or null when the index withheld the labels
       *  (it could not tie the names to the code that answered). */
      values: SettingValues | null;
      /** Settings the chain did not answer when the snapshot was taken;
       *  null when the index did not say. */
      unreported: string[] | null;
      /** Why the index could not decode the settings bundle at all. */
      bundleUnreported: string | null;
      /** The block the snapshot describes. */
      sourceBlock: number;
      /** When the index recorded it (unix seconds); 0 once it is known to
       *  be behind a governance change. */
      updatedAt: number;
      /** The index has scanned a governance change this snapshot predates. */
      stale: boolean;
      /** The block of that change, when recorded: a replacement read must
       *  reach it to include the change. */
      staleAtBlock: number | null;
    };

function isScalar(v: unknown): v is string | boolean {
  return typeof v === 'string' || typeof v === 'boolean';
}

function isSettingValue(v: unknown): v is SettingValue {
  if (isScalar(v)) return true;
  if (!Array.isArray(v)) return false;
  return v.every(isScalar) || v.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r) && Object.values(r as object).every(isScalar));
}

/** The index's answer as a snapshot, or a shape failure. */
export function snapshotFrom(body: unknown, chainId: number): ConfigSnapshot {
  const shape = (why: string) => new IndexerUnavailable('shape', `The index’s settings snapshot could not be read: ${why}.`);
  if (typeof body !== 'object' || body === null) throw shape('not an object');
  const b = body as Record<string, unknown>;
  if (b.chainId !== chainId) throw shape('it describes another network');
  if (b.available === false) return { available: false };
  if (b.available !== true) throw shape('it does not say whether a snapshot exists');
  let values: SettingValues | null = null;
  if (b.values !== undefined) {
    if (typeof b.values !== 'object' || b.values === null || Array.isArray(b.values)) throw shape('its values are not a record');
    for (const [k, v] of Object.entries(b.values)) if (!isSettingValue(v)) throw shape(`the value of ${k} is of an unknown kind`);
    values = b.values as SettingValues;
  }
  let unreported: string[] | null = null;
  if (b.unreported !== undefined) {
    if (!Array.isArray(b.unreported) || !b.unreported.every((k) => typeof k === 'string')) throw shape('its list of unanswered settings is malformed');
    unreported = b.unreported as string[];
  }
  try {
    return {
      available: true,
      values,
      unreported,
      bundleUnreported: typeof b.bundleUnreported === 'string' && b.bundleUnreported.length > 0 ? b.bundleUnreported : null,
      sourceBlock: wireWhole(b.sourceBlock),
      updatedAt: wireWhole(b.updatedAt),
      stale: b.stale === true,
      staleAtBlock: b.staleAtBlock === undefined || b.staleAtBlock === null ? null : wireWhole(b.staleAtBlock),
    };
  } catch (e) {
    throw shape((e as Error).message);
  }
}

/** Reads the snapshot for `chainId`; throws {@link IndexerUnavailable}. */
export async function readConfigSnapshot(indexer: IndexerClient, chainId: number): Promise<ConfigSnapshot> {
  return snapshotFrom(await indexer.getJson<unknown>(`/config/${chainId}`), chainId);
}
