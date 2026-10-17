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
}
export type FingerprintRead = Fingerprint | 'absent' | null;
export type Marker = { completedAt: number; fingerprint: Record<string, Fingerprint> } | 'none' | null;
export const PRIVATE_DB: string;
export const SHARED_DB: string;
export const CUTOVER_TABLES: readonly CutoverTable[];
export function fingerprintSql(t: CutoverTable): string;
export function parseFingerprint(rows: unknown): { n: number; at: number } | null;
export function rowsSql(t: CutoverTable): string;
export function rowDigest(rows: readonly Record<string, unknown>[]): string;
export function fingerprintFromReads(countRows: unknown, rows: unknown): Fingerprint | null;
export function cutoverVerdict(
  shared: Record<string, FingerprintRead>,
  marker: Marker,
): { ok: true } | { ok: false; why: string };
