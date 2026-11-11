// apps/keeper/src/privateRebroadcast.ts
//
// #3408 — the inclusion fallback of the private submission route.
//
// A private endpoint that ACCEPTS a transaction has not mined it. It may keep
// it pending for minutes (Flashbots Protect waits up to 25 blocks), or a
// builder may never include it. For a protective transaction (a Telegram
// LOCK, a forced sale) that wait is the risk the route exists to reduce, so on
// a chain the operator allows a public fallback (`PRIVATE_TX_FALLBACK_CHAIN_IDS`)
// every accepted private send is recorded, and each tick sends the SAME signed
// bytes through the chain's ordinary RPC once the send has been unmined for
// `PRIVATE_TX_PUBLIC_AFTER_SECONDS`. The same bytes can never make a second
// transaction; they do make this one public, so each copy sent raises an ops
// alert.
//
// "Unmined" is read from the account's mined nonce count: once it passes the
// send's nonce, either this transaction or another at its nonce has landed,
// and a copy would only be refused. A copy goes out only while the send is
// inside the private nonce window (`PRIVATE_ROUTE_FLOOR_TTL_MS`), measured
// from when its nonce was RESERVED (the reservation expires on that clock, not
// on the acceptance), and never in the window's last minute
// (`PUBLIC_COPY_CUTOFF_MS`), because past the window the keeper may give the
// nonce to a later send. A send that reaches the cutoff unmined and uncopied
// is stated in the log and the alert, never dropped silently: a row leaves
// the record only once it is mined, reported, or copied and past its window.
//
// The records live in the keeper's private database (migration 0008), keyed
// by network like the nonce record, so a fresh Diamond's epoch reset leaves
// them alone. Nothing here signs: the sweep only re-sends bytes the keeper
// already signed and broadcast, so it takes no submission slot.

import type { Address, Hex } from 'viem';
import { describeFailure, summarizeFailure } from '@vaipakam/lib/errorDescription';
import type { KeeperD1 } from './env';
import {
  PRIVATE_ROUTE_FLOOR_TTL_MS,
  PRIVATE_TX_FALLBACK_VAR,
  type AcceptedPrivateSend,
  type SubmissionRoutes,
} from './submissionRoute';

/** The latest a public copy may go out, measured from the nonce's
 *  reservation: one minute inside the private nonce window, so a copy that is
 *  slow to reach the node (an 8 s answer timeout, the tick's own run) still
 *  lands while no later send can hold its nonce. */
export const PUBLIC_COPY_CUTOFF_MS = PRIVATE_ROUTE_FLOOR_TTL_MS - 60_000;

/** One recorded private send. `publicAtMs` is when a copy went public. */
export interface PrivateSendRow extends AcceptedPrivateSend {
  publicAtMs: number | null;
}

/** Where the records live. */
export interface PrivateSendRecords {
  /** Record an accepted private send (a repeat of the same hash keeps the
   *  first time, so a re-accept cannot postpone its fallback). */
  write(send: AcceptedPrivateSend): Promise<void>;
  /** The network's sends with no public copy yet, accepted at or before
   *  `acceptedBy`. */
  due(networkId: number, acceptedBy: number): Promise<PrivateSendRow[]>;
  /** Note that a copy of `hash` went public at `atMs`. */
  markPublic(networkId: number, hash: Hex, atMs: number): Promise<void>;
  /** Forget `hash` (it is mined, its nonce is, or it is reported lapsed). */
  remove(networkId: number, hash: Hex): Promise<void>;
  /** Drop the network's rows ALREADY COPIED publicly whose nonce was reserved
   *  before `beforeMs` (housekeeping). A row with no copy is never pruned: it
   *  leaves only through the sweep, which reports its outcome. */
  pruneCopied(networkId: number, beforeMs: number): Promise<void>;
}

interface D1Row {
  network_id: number;
  address: string;
  nonce: number;
  tx_hash: string;
  raw_tx: string;
  sent_at_ms: number;
  reserved_at_ms: number;
  public_at_ms: number | null;
}

/** The records in the keeper's private database. */
export function d1PrivateSendRecords(db: KeeperD1): PrivateSendRecords {
  return {
    async write(s) {
      await db
        .prepare(
          `INSERT INTO keeper_private_send (network_id, address, nonce, tx_hash, raw_tx, sent_at_ms, reserved_at_ms, public_at_ms)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
           ON CONFLICT(network_id, tx_hash) DO NOTHING`,
        )
        .bind(s.chainId, s.address.toLowerCase(), s.nonce, s.hash.toLowerCase(), s.serialized, s.atMs, s.reservedAtMs)
        .run();
    },
    async due(networkId, acceptedBy) {
      const { results } = await db
        .prepare(
          `SELECT network_id, address, nonce, tx_hash, raw_tx, sent_at_ms, reserved_at_ms, public_at_ms FROM keeper_private_send
           WHERE network_id = ?1 AND public_at_ms IS NULL AND sent_at_ms <= ?2
           ORDER BY sent_at_ms`,
        )
        .bind(networkId, acceptedBy)
        .all<D1Row>();
      return (results ?? []).map((r) => ({
        chainId: Number(r.network_id),
        address: r.address as Address,
        nonce: Number(r.nonce),
        hash: r.tx_hash as Hex,
        serialized: r.raw_tx as Hex,
        atMs: Number(r.sent_at_ms),
        reservedAtMs: Number(r.reserved_at_ms),
        publicAtMs: r.public_at_ms === null ? null : Number(r.public_at_ms),
      }));
    },
    async markPublic(networkId, hash, atMs) {
      await db
        .prepare('UPDATE keeper_private_send SET public_at_ms = ?3 WHERE network_id = ?1 AND tx_hash = ?2')
        .bind(networkId, hash.toLowerCase(), atMs)
        .run();
    },
    async remove(networkId, hash) {
      await db
        .prepare('DELETE FROM keeper_private_send WHERE network_id = ?1 AND tx_hash = ?2')
        .bind(networkId, hash.toLowerCase())
        .run();
    },
    async pruneCopied(networkId, beforeMs) {
      await db
        .prepare('DELETE FROM keeper_private_send WHERE network_id = ?1 AND public_at_ms IS NOT NULL AND reserved_at_ms < ?2')
        .bind(networkId, beforeMs)
        .run();
    },
  };
}

/** Records held in memory: tests, and nothing else. */
export function memoryPrivateSendRecords(): PrivateSendRecords & { rows: Map<string, PrivateSendRow> } {
  const rows = new Map<string, PrivateSendRow>();
  const key = (n: number, h: string) => `${n}:${h.toLowerCase()}`;
  return {
    rows,
    async write(s) {
      if (!rows.has(key(s.chainId, s.hash))) rows.set(key(s.chainId, s.hash), { ...s, publicAtMs: null });
    },
    async due(n, by) {
      return [...rows.values()].filter((r) => r.chainId === n && r.publicAtMs === null && r.atMs <= by).sort((a, b) => a.atMs - b.atMs);
    },
    async markPublic(n, h, at) {
      const r = rows.get(key(n, h));
      if (r) r.publicAtMs = at;
    },
    async remove(n, h) {
      rows.delete(key(n, h));
    },
    async pruneCopied(n, before) {
      for (const [k, r] of rows) if (r.chainId === n && r.publicAtMs !== null && r.reservedAtMs < before) rows.delete(k);
    },
  };
}

/** What the sweep reads and sends through. */
export interface RebroadcastDeps {
  records: PrivateSendRecords;
  /** The account's MINED transaction count on the chain's ordinary RPC. */
  minedCount(chainId: number, address: Address): Promise<number>;
  /** Broadcast `serialized` through the chain's ordinary RPC. */
  sendPublic(chainId: number, serialized: Hex): Promise<Hex>;
  /** Tell the operator: `public` when a copy went out, `lapsed` when a send
   *  left its nonce window unmined and uncopied (its own alert key, so a
   *  recent fallback alert cannot hold it back). Never throws. */
  alert(chainId: number, kind: 'public' | 'lapsed', line: string): Promise<void>;
  now(): number;
}

/** A broadcast answer that says the node already holds these bytes. */
const ALREADY_KNOWN = /already known|known transaction/i;
/** A broadcast answer that says the nonce is already mined. */
const NONCE_MINED = /nonce too low/i;

/**
 * Send a public copy of every recorded private send that has been unmined for
 * its chain's stated time, on every served chain whose route allows it.
 * Returns one log line per chain that had anything due. Never throws for one
 * row: a row that fails is retried next tick while its window lasts.
 */
export async function rebroadcastStalePrivateSends(
  routes: SubmissionRoutes,
  chains: readonly { id: number; name: string }[],
  deps: RebroadcastDeps,
  notAfterMs: number,
): Promise<string[]> {
  if ('unread' in routes) return [];
  const lines: string[] = [];
  for (const chain of chains) {
    const route = routes.routes.get(chain.id);
    if (!route || !route.fallback) continue;
    const t = deps.now();
    const due = await deps.records.due(chain.id, t - route.publicAfterMs);
    const sent: Hex[] = [];
    const lapsed: Hex[] = [];
    let mined = 0;
    let failed = 0;
    const minedBy = new Map<string, number>();
    for (const row of due) {
      if (deps.now() >= notAfterMs) break;
      try {
        const who = row.address.toLowerCase();
        let count = minedBy.get(who);
        if (count === undefined) {
          count = await deps.minedCount(chain.id, row.address);
          minedBy.set(who, count);
        }
        if (count > row.nonce) {
          await deps.records.remove(chain.id, row.hash);
          mined += 1;
          continue;
        }
        if (deps.now() - row.reservedAtMs >= PUBLIC_COPY_CUTOFF_MS) {
          // At the cutoff: past the window a later send may hold this nonce,
          // so a copy could replace it. Stated below, then forgotten.
          lapsed.push(row.hash);
          await deps.records.remove(chain.id, row.hash);
          continue;
        }
        // The mined-count read can be slow, so the run's deadline is checked
        // again here, with nothing awaited between it, the cutoff above and
        // the send. A row left now is seen again next tick.
        if (deps.now() >= notAfterMs) break;
        try {
          await deps.sendPublic(chain.id, row.serialized);
        } catch (err) {
          if (NONCE_MINED.test((err as Error).message ?? '')) {
            await deps.records.remove(chain.id, row.hash);
            mined += 1;
            continue;
          }
          if (!ALREADY_KNOWN.test((err as Error).message ?? '')) throw err;
          // The public node already holds these bytes: the copy is out.
        }
        // The bytes are public now, whatever the record says next: reported
        // as sent before the record is touched.
        sent.push(row.hash);
        try {
          await deps.records.markPublic(chain.id, row.hash, deps.now());
        } catch (err) {
          console.warn(
            `[privateRebroadcast] ${chain.name}(${chain.id}) sent a public copy of ${row.hash} but could not record it (${describeFailure(err)}); the next tick may send the same bytes again, which the node answers as already known`,
          );
        }
      } catch (err) {
        failed += 1;
        console.warn(`[privateRebroadcast] ${chain.name}(${chain.id}) could not send a public copy of ${row.hash} (${summarizeFailure(err)}); retried next tick until the cutoff`);
      }
    }
    await deps.records.pruneCopied(chain.id, t - PRIVATE_ROUTE_FLOOR_TTL_MS).catch((err: unknown) => {
      console.warn(`[privateRebroadcast] ${chain.name}(${chain.id}) could not prune old records (${describeFailure(err)})`);
    });
    if (due.length === 0) continue;
    const secs = route.publicAfterMs / 1000;
    if (sent.length > 0) {
      await deps.alert(
        chain.id,
        'public',
        `${sent.length} keeper transaction${sent.length === 1 ? ' was' : 's were'} still unmined at least ${secs} s after the private route accepted ${sent.length === 1 ? 'it' : 'them'}, so the same signed bytes went to the public RPC, as ${PRIVATE_TX_FALLBACK_VAR} allows: ${sent.join(', ')}. ${sent.length === 1 ? 'It is' : 'They are'} now visible in the public mempool.`,
      );
    }
    if (lapsed.length > 0) {
      await deps.alert(
        chain.id,
        'lapsed',
        `${lapsed.length} keeper transaction${lapsed.length === 1 ? '' : 's'} sent privately ${lapsed.length === 1 ? 'was' : 'were'} neither mined nor sent publicly by the last minute of the private nonce window, so no public copy was sent and later sends may reuse the nonce: ${lapsed.join(', ')}. Whether ${lapsed.length === 1 ? 'it' : 'they'} will still land is unknown.`,
      );
    }
    lines.push(
      `${chain.name}(${chain.id}): ${due.length} private send(s) unmined after ${secs} s; ${sent.length} sent publicly, ${mined} found mined, ${lapsed.length} past the nonce window, ${failed} failed (retried next tick)`,
    );
  }
  return lines;
}
