/**
 * Types for the keeper private D1 cutover rules (plain .mjs so the node
 * scripts run it without a TS loader; this declaration is what lets the
 * machine host and the tests import it type-checked, #2497).
 */
export type Fingerprint = { n: number; at: number };
/** A table's fingerprint, `'absent'` when the table does not exist, `null` when unread. */
export type TableFingerprint = Fingerprint | 'absent' | null;
export type Fingerprints = Record<string, TableFingerprint>;
export type Marker = { completedAt: number; fingerprint: Record<string, Fingerprint> } | 'none' | null;
/** The result rows of `sql`, or `null` when the call failed. Never `[]` for a failure. */
export type StatementRunner = (sql: string) => Promise<Array<Record<string, unknown>> | null>;
export type Verdict = { ok: true } | { ok: false; why: string };

export const PRIVATE_DB: string;
export const PRIVATE_DB_ID: string;
export const SHARED_DB: string;
export const CUTOVER_TABLES: ReadonlyArray<{ table: string; at: string }>;
export function fingerprintSql(t: { table: string; at: string }): string;
export function query(db: string, sql: string): Array<Record<string, unknown>> | null;
export function parseFingerprint(rows: unknown): Fingerprint | null;
export function readFingerprintsWith(run: StatementRunner): Promise<Fingerprints>;
export function readMarkerWith(run: StatementRunner): Promise<Marker>;
export function readFingerprints(db: string): Promise<Fingerprints>;
export function readMarker(db?: string): Promise<Marker>;
export function cutoverVerdict(shared: Fingerprints | null | undefined, marker: Marker): Verdict;
export function copyVerdict(shared: Fingerprints | null | undefined, priv: Fingerprints | null | undefined): Verdict;
