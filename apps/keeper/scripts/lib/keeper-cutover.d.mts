/** Types for the pure parts of keeper-cutover.mjs that the machine host
 *  reuses (host/privateDbGate.ts). The rule stays defined once, in the .mjs. */
export interface CutoverTable {
  table: string;
  at: string;
}
export interface Fingerprint {
  n: number;
  at: number;
  /** SHA-256 over the rows in canonical form (#2497 r1). */
  digest: string;
  /** One SHA-256 per row, sorted (#2497 r10). */
  rows: string[];
  /** The chains the rows are keyed by; empty for a Diamond-keyed table, and
   *  absent on a fingerprint read back from the cutover record (#2569 r1). */
  chains?: number[];
}
export type FingerprintRead = Fingerprint | 'absent' | null;
export type Marker = { completedAt: number; fingerprint: Record<string, Fingerprint> } | 'none' | null;
export const PRIVATE_DB: string;
export const PRIVATE_DB_ID: string;
export const SHARED_DB: string;
export const CUTOVER_TABLES: readonly CutoverTable[];
export function fingerprintSql(t: CutoverTable): string;
export function parseFingerprint(rows: unknown): { n: number; at: number } | null;
export function rowsSql(t: CutoverTable): string;
export function rowDigest(rows: readonly Record<string, unknown>[]): string;
export function rowDigests(rows: readonly Record<string, unknown>[]): string[];
export const MARKER_SQL: string;
export const MARKER_ROWS_SQL: string;
export function markerFromReads(markerRows: unknown, digestRows: unknown): Marker;
export function chainIds(rows: readonly unknown[]): number[];
export function seedVerdict(
  fingerprints: Record<string, Fingerprint>,
  indexerRows: unknown,
): { ok: true; deployments: { chain_id: number; diamond: string }[] } | { ok: false; why: string };
export function adoptionsDiffer(a: unknown, b: unknown): boolean;
export function recordSql(
  fingerprints: Record<string, Fingerprint>,
  deployments: readonly { chain_id: number; diamond: string }[],
  nowSec: number,
): string;
export function fingerprintFromReads(countRows: unknown, rows: unknown): Fingerprint | null;
export function cutoverVerdict(
  shared: Record<string, FingerprintRead>,
  marker: Marker,
): { ok: true } | { ok: false; why: string };
