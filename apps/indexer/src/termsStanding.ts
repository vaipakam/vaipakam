/**
 * #3734 — where a wallet stands on the Terms of Service, as the indexer reads
 * the on-chain record.
 *
 * Design: docs/DesignsAndPlans/TermsAcceptanceEnforcementDesign.md, sections
 * 3, 5, 7 ("The book") and 8. The contracts hold the rule; this module
 * restates it over the indexed events so the book can mark a commitment its
 * maker cannot fill now, and so a wallet can be told where it stands. The
 * contract preview stays the authority at fill time: a mark is a hint for a
 * list, never a gate.
 *
 * THE RULE, once, here:
 *  - Each network holds a LATEST and a MINIMUM version, folded from the log of
 *    changes ({@link foldTermsRecord}). A publication is in force at once; an
 *    announcement comes into force at its time, and only then; a withdrawal
 *    drops the open announcement. A version that is only announced, or whose
 *    announcement was withdrawn, is never in force and never counts.
 *  - A wallet is CURRENT when it accepted at least one version that is in
 *    force and numbered from the minimum to the latest, both included
 *    ({@link walletStanding}).
 *  - While no version is in force the rule checks nothing, and nobody is
 *    marked.
 *  - Per network only. Nothing here reads another chain's rows.
 *
 * Whose standing marks what: only a commitment that would give its maker a
 * new position is marked (a lending, borrowing or rental offer, an offer to
 * buy a loan, an offset offer, and signed offers of those kinds). A listing
 * that sells the lister's own loan or collateral is NEVER marked by its
 * maker's standing (section 3.2): the buyer is the one checked.
 *
 * Every answer is stated, never guessed: `unknown` when the record cannot be
 * read (a database before migration 0100, a failed read, or a build whose
 * ingest does not decode the Terms events yet), which a reader must treat as
 * closed, not as current.
 */
import type { Env } from './env';
import { chunkD1InList } from '@vaipakam/lib/d1Binds';

/**
 * Whether this build's ingest decodes the Diamond's Terms events into
 * `terms_change` / `terms_acceptance`. Until it does, an empty record means
 * "not read", not "no Terms in force", so every standing reads `unknown`.
 * Set to true in the change that wires the decoders.
 */
export const TERMS_EVENTS_WIRED = false;

// ── The record ────────────────────────────────────────────────────────

export type TermsChangeKind = 'published' | 'announced' | 'withdrawn' | 'in-force';

/** One row of `terms_change`, as the fold reads it. */
export interface TermsChange {
  blockNumber: number;
  logIndex: number;
  kind: TermsChangeKind;
  version: number;
  termsHash: string | null;
  movesMinimum: boolean;
  /** When the change comes into force; for a publication, its block time. */
  inForceAt: number | null;
  blockAt: number;
}

/** An announced change that has not come into force. */
export interface PendingTermsChange {
  version: number;
  inForceAt: number;
  movesMinimum: boolean;
}

/** The network's Terms at one moment. */
export interface TermsRecord {
  /** Every version in force, ascending. Empty = no Terms in force. */
  inForce: number[];
  minimum: number | null;
  latest: number | null;
  pending: PendingTermsChange | null;
}

const byLogOrder = (a: TermsChange, b: TermsChange) =>
  a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex;

/**
 * Fold the log of changes into the record as it stands at `nowSec`.
 *
 * An announcement comes into force at its time, not at an event, so it is
 * applied once `inForceAt` has passed whether or not a coming-into-force
 * event has been read. A coming-into-force event for the open announcement
 * applies it at once (the chain says it happened). One for a version with no
 * open announcement (one this log did not see) is applied as stated, so a
 * missed announcement cannot leave a version that is in force out of the
 * record.
 */
export function foldTermsRecord(changes: readonly TermsChange[], nowSec: number): TermsRecord {
  const inForce = new Set<number>();
  let minimum: number | null = null;
  let latest: number | null = null;
  let pending: PendingTermsChange | null = null;

  const bringIntoForce = (version: number, movesMinimum: boolean) => {
    inForce.add(version);
    if (latest === null || version > latest) latest = version;
    // The first version on a network sets the minimum, whatever it says.
    if (movesMinimum || minimum === null) minimum = version;
  };
  const matureBy = (t: number) => {
    if (pending !== null && pending.inForceAt <= t) {
      bringIntoForce(pending.version, pending.movesMinimum);
      pending = null;
    }
  };

  for (const c of [...changes].sort(byLogOrder)) {
    matureBy(c.blockAt);
    switch (c.kind) {
      case 'published':
        bringIntoForce(c.version, c.movesMinimum);
        break;
      case 'announced':
        pending = {
          version: c.version,
          inForceAt: c.inForceAt ?? c.blockAt,
          movesMinimum: c.movesMinimum,
        };
        break;
      case 'withdrawn':
        // Withdrawing a raise of the minimum to the already-latest version
        // drops only the raise: that version stays in force and counts.
        if (pending !== null && pending.version === c.version) pending = null;
        break;
      case 'in-force':
        if (pending !== null && pending.version === c.version) {
          bringIntoForce(pending.version, pending.movesMinimum);
          pending = null;
        } else {
          bringIntoForce(c.version, c.movesMinimum);
        }
        break;
    }
  }
  matureBy(nowSec);

  return { inForce: [...inForce].sort((a, b) => a - b), minimum, latest, pending };
}

/** The record once the open announcement has come into force. */
function afterPending(record: TermsRecord): TermsRecord | null {
  const p = record.pending;
  if (p === null) return null;
  const inForce = record.inForce.includes(p.version)
    ? record.inForce
    : [...record.inForce, p.version].sort((a, b) => a - b);
  return {
    inForce,
    latest: record.latest === null ? p.version : Math.max(record.latest, p.version),
    minimum: p.movesMinimum || record.minimum === null ? p.version : record.minimum,
    pending: null,
  };
}

// ── A wallet's standing ───────────────────────────────────────────────

/** Why a wallet is not current. */
export type NotCurrentReason =
  /** It has accepted no version on this network. */
  | 'no-acceptance'
  /** Its acceptances are all below the minimum. */
  | 'below-minimum'
  /** It accepted only a version that is not in force (still announced, or withdrawn). */
  | 'accepted-version-not-in-force';

export type TermsStanding =
  | { state: 'unknown' }
  | { state: 'no-terms-in-force' }
  | {
      state: 'current';
      minimumVersion: number;
      latestVersion: number;
      /** The highest version it accepted that counts. */
      acceptedVersion: number;
      /** When an announced change will stop it counting as current, if one will. */
      stopsBeingCurrentAt: number | null;
    }
  | {
      state: 'not-current';
      reason: NotCurrentReason;
      minimumVersion: number;
      latestVersion: number;
    };

function countingVersion(record: TermsRecord, accepted: readonly number[]): number | null {
  if (record.minimum === null || record.latest === null) return null;
  const min = record.minimum;
  const max = record.latest;
  let best: number | null = null;
  for (const v of accepted) {
    if (v >= min && v <= max && record.inForce.includes(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/** THE rule: where a wallet with these accepted versions stands. */
export function walletStanding(record: TermsRecord, accepted: readonly number[]): TermsStanding {
  if (record.inForce.length === 0 || record.minimum === null || record.latest === null) {
    return { state: 'no-terms-in-force' };
  }
  const counting = countingVersion(record, accepted);
  if (counting !== null) {
    const next = afterPending(record);
    const stops = next !== null && countingVersion(next, accepted) === null;
    return {
      state: 'current',
      minimumVersion: record.minimum,
      latestVersion: record.latest,
      acceptedVersion: counting,
      stopsBeingCurrentAt: stops ? record.pending!.inForceAt : null,
    };
  }
  let reason: NotCurrentReason;
  if (accepted.length === 0) reason = 'no-acceptance';
  else if (accepted.some((v) => !record.inForce.includes(v))) reason = 'accepted-version-not-in-force';
  else reason = 'below-minimum';
  return { state: 'not-current', reason, minimumVersion: record.minimum, latestVersion: record.latest };
}

/**
 * The standing an offer's maker carries on a list. A listing that sells the
 * lister's own loan or collateral is `exempt`: its maker's standing never
 * marks it (section 3.2).
 */
export type MakerTermsJson = TermsStanding | { state: 'exempt' };

// ── Reads ─────────────────────────────────────────────────────────────

/** `wired` overrides {@link TERMS_EVENTS_WIRED}; tests only. */
export interface ReadOpts {
  wired?: boolean;
}

const isMissingTable = (err: unknown) => /no such table/i.test(String((err as Error)?.message ?? err));

interface TermsChangeRow {
  block_number: number;
  log_index: number;
  kind: TermsChangeKind;
  version: number;
  terms_hash: string | null;
  moves_minimum: number;
  in_force_at: number | null;
  block_at: number;
}

/**
 * The network's record now. `null` = unknown: the ingest does not decode the
 * Terms events yet, the database predates migration 0100, or the read failed.
 */
export async function readTermsRecord(
  env: Env,
  chainId: number,
  nowSec: number,
  opts: ReadOpts = {},
): Promise<TermsRecord | null> {
  if (!(opts.wired ?? TERMS_EVENTS_WIRED)) return null;
  try {
    const rows = await env.DB.prepare(
      `SELECT block_number, log_index, kind, version, terms_hash, moves_minimum, in_force_at, block_at
         FROM terms_change WHERE chain_id = ? ORDER BY block_number, log_index`,
    )
      .bind(chainId)
      .all<TermsChangeRow>();
    return foldTermsRecord(
      (rows.results ?? []).map((r) => ({
        blockNumber: r.block_number,
        logIndex: r.log_index,
        kind: r.kind,
        version: r.version,
        termsHash: r.terms_hash,
        movesMinimum: r.moves_minimum === 1,
        inForceAt: r.in_force_at,
        blockAt: r.block_at,
      })),
      nowSec,
    );
  } catch (err) {
    if (!isMissingTable(err)) console.error('[termsStanding] record read failed', String(err));
    return null;
  }
}

/** Accepted versions per wallet (lowercased), one batched read. `null` = unreadable. */
async function acceptedVersions(
  env: Env,
  chainId: number,
  wallets: readonly string[],
): Promise<Map<string, number[]> | null> {
  const out = new Map<string, number[]>();
  const unique = [...new Set(wallets.map((w) => w.toLowerCase()))];
  for (const w of unique) out.set(w, []);
  if (unique.length === 0) return out;
  try {
    const chunks = chunkD1InList(unique, { before: [chainId] });
    const parts = await env.DB.batch<{ wallet: string; version: number }>(
      chunks.map((c) =>
        env.DB.prepare(
          `SELECT wallet, version FROM terms_acceptance
            WHERE chain_id = ? AND wallet IN (${c.placeholders})`,
        ).bind(...c.binds),
      ),
    );
    for (const part of parts) {
      for (const r of part.results ?? []) out.get(r.wallet)?.push(r.version);
    }
    return out;
  } catch (err) {
    if (!isMissingTable(err)) console.error('[termsStanding] acceptance read failed', String(err));
    return null;
  }
}

/**
 * Each maker's standing on one network, keyed by lowercased wallet. Every
 * maker is present; each reads `unknown` when the record cannot be read.
 */
export async function makerStandings(
  env: Env,
  chainId: number,
  makers: readonly string[],
  nowSec: number = Math.floor(Date.now() / 1000),
  opts: ReadOpts = {},
): Promise<Map<string, TermsStanding>> {
  const out = new Map<string, TermsStanding>();
  const keys = [...new Set(makers.map((m) => m.toLowerCase()))];
  const unknown = () => {
    for (const k of keys) out.set(k, { state: 'unknown' });
    return out;
  };
  if (keys.length === 0) return out;
  const record = await readTermsRecord(env, chainId, nowSec, opts);
  if (record === null) return unknown();
  if (record.inForce.length === 0) {
    for (const k of keys) out.set(k, { state: 'no-terms-in-force' });
    return out;
  }
  const accepted = await acceptedVersions(env, chainId, keys);
  if (accepted === null) return unknown();
  for (const k of keys) out.set(k, walletStanding(record, accepted.get(k) ?? []));
  return out;
}

/** One acceptance as the wallet read reports it. */
export interface AcceptanceJson {
  version: number;
  termsHash: string | null;
  acceptedAt: number;
  blockNumber: number;
  txHash: string;
}

export interface WalletTermsJson {
  chainId: number;
  wallet: string;
  standing: TermsStanding;
  /** Every version this wallet accepted on this network; null when unreadable. */
  accepted: AcceptanceJson[] | null;
  /** The network's record; null when unreadable. */
  record: TermsRecord | null;
}

/** Where one wallet stands on one network, with its acceptances. */
export async function walletTerms(
  env: Env,
  chainId: number,
  wallet: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  opts: ReadOpts = {},
): Promise<WalletTermsJson> {
  const w = wallet.toLowerCase();
  const unknown: WalletTermsJson = { chainId, wallet: w, standing: { state: 'unknown' }, accepted: null, record: null };
  const record = await readTermsRecord(env, chainId, nowSec, opts);
  if (record === null) return unknown;
  let accepted: AcceptanceJson[];
  try {
    const rows = await env.DB.prepare(
      `SELECT version, terms_hash, accepted_at, block_number, tx_hash
         FROM terms_acceptance WHERE chain_id = ? AND wallet = ? ORDER BY version`,
    )
      .bind(chainId, w)
      .all<{ version: number; terms_hash: string | null; accepted_at: number; block_number: number; tx_hash: string }>();
    accepted = (rows.results ?? []).map((r) => ({
      version: r.version,
      termsHash: r.terms_hash,
      acceptedAt: r.accepted_at,
      blockNumber: r.block_number,
      txHash: r.tx_hash,
    }));
  } catch (err) {
    if (!isMissingTable(err)) console.error('[termsStanding] wallet read failed', String(err));
    return unknown;
  }
  return {
    chainId,
    wallet: w,
    standing: walletStanding(
      record,
      accepted.map((a) => a.version),
    ),
    accepted,
    record,
  };
}

// ── Writes (the ingest) ───────────────────────────────────────────────

/** A decoded Terms change, ready to store. */
export interface TermsChangeInput extends TermsChange {
  txHash: string;
}

/** A decoded acceptance, ready to store. */
export interface TermsAcceptanceInput {
  wallet: string;
  version: number;
  termsHash: string | null;
  acceptedAt: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
}

/** Store one change. Replaying the same log is a no-op. */
export function termsChangeStatement(db: D1Database, chainId: number, c: TermsChangeInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO terms_change
         (chain_id, block_number, log_index, tx_hash, kind, version, terms_hash, moves_minimum, in_force_at, block_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      chainId,
      c.blockNumber,
      c.logIndex,
      c.txHash.toLowerCase(),
      c.kind,
      c.version,
      c.termsHash === null ? null : c.termsHash.toLowerCase(),
      c.movesMinimum ? 1 : 0,
      c.inForceAt,
      c.blockAt,
    );
}

/** Store one acceptance. A repeated acceptance of the same version keeps the first record. */
export function termsAcceptanceStatement(
  db: D1Database,
  chainId: number,
  a: TermsAcceptanceInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO terms_acceptance
         (chain_id, wallet, version, terms_hash, accepted_at, block_number, log_index, tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      chainId,
      a.wallet.toLowerCase(),
      a.version,
      a.termsHash === null ? null : a.termsHash.toLowerCase(),
      a.acceptedAt,
      a.blockNumber,
      a.logIndex,
      a.txHash.toLowerCase(),
    );
}
