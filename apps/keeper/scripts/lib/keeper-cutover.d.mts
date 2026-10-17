/** Types for the pure parts of keeper-cutover.mjs that the machine host
 *  reuses (host/privateDbGate.ts). The rule stays defined once, in the .mjs. */
export interface CutoverTable {
  table: string;
  at: string;
}
export interface Fingerprint {
  n: number;
  at: number;
}
export type FingerprintRead = Fingerprint | 'absent' | null;
export type Marker = { completedAt: number; fingerprint: Record<string, Fingerprint> } | 'none' | null;
export const PRIVATE_DB: string;
export const SHARED_DB: string;
export const CUTOVER_TABLES: readonly CutoverTable[];
export function fingerprintSql(t: CutoverTable): string;
export function parseFingerprint(rows: unknown): Fingerprint | null;
export function cutoverVerdict(
  shared: Record<string, FingerprintRead>,
  marker: Marker,
): { ok: true } | { ok: false; why: string };
