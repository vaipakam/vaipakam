/**
 * #3453 — the indexer reads the price guard's and the protocol registry's
 * logs beside the Diamond's.
 *
 * Since #3272 part 2 every pricing setting lives on the standalone price
 * guard, and the guard the Diamond reads is whatever the protocol registry
 * names. Both announce their changes from their own addresses, which the
 * Diamond scan never read, so the config snapshot learned of a feed swap, a
 * new guardian or a repointed guard only on its six-hour backstop, and a
 * change waiting out the guard's delay was never shown at all. That delay is
 * the review window, so a change nobody can see while it waits defeats it.
 *
 * Three jobs live here, each small:
 *
 * 1. **Which contracts to read.** The guard and registry the last config
 *    snapshot read through the Diamond (`getPriceGuard`, `getProtocolRegistry`),
 *    or, before any snapshot names them, the ones the deployment record lists.
 *    They come in on the pass's cursor read, so a pass costs no extra query.
 *    A repointed guard is followed on the pass after the snapshot that reads
 *    the new pointer: the registry's own event triggers that snapshot.
 * 2. **Decoding their logs apart from the Diamond's.** One `eth_getLogs` per
 *    chunk still reads every address, so this costs no extra request; the
 *    guard's and registry's logs are split off by address BEFORE the Diamond
 *    decode, because some of their events share a signature with the
 *    Diamond's (`OwnershipTransferred`) and must never reach its handlers.
 * 3. **The pending changes.** Each `ChangeProposed` (and each
 *    `SecondaryRemovalProposed`) adds a row; the event that executes or
 *    cancels it removes the row. The statements ride the cursor's own batch,
 *    so the list moves exactly as far as the scan, in the same transaction.
 *    Each config refresh then re-reads every listed change from the guard at
 *    the snapshot's block and drops the ones the guard no longer holds, so
 *    the chain stays the authority even if a log was missed.
 *
 * What it cannot know, stated rather than implied: a change proposed before
 * the indexer started reading a guard (the first pass after this shipped, or
 * the pass after a repointing) is not listed. `price_guard_watch.from_block`
 * records where reading began, and `/config` serves it.
 */
import { decodeEventLog, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { PriceGuardABI, ProtocolRegistryABI } from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import {
  PRICE_GUARD_CONFIG_EVENTS,
  PRICE_GUARD_KIND_KNOB,
  PRICE_GUARD_KIND_NAMES,
  SECONDARY_REMOVAL_KIND,
  priceGuardKindName,
  type PendingPriceGuardChange,
} from '@vaipakam/lib/priceGuardChanges';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { MULTICALL3_ADDRESS } from '@vaipakam/lib/multicall';
import type { Env } from './env';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_WORD = `0x${'0'.repeat(64)}` as Hex;
/** `Kind.Delay` and `Kind.PriceFloor`: executed with their own events
 *  (`DelaySet`, `PriceFloorRaised` / `PriceFloorLapsed`), not `ConfigSet`. */
const KIND_DELAY = PRICE_GUARD_KIND_NAMES.indexOf('Delay');
const KIND_PRICE_FLOOR = PRICE_GUARD_KIND_NAMES.indexOf('PriceFloor');

/** The guard and registry a pass reads, lower-case. Either may be absent. */
export interface GovernanceWatch {
  guard: Address | null;
  registry: Address | null;
  /** True when the stored watch row already names this guard and registry,
   *  so a pass with no guard log writes nothing (a batch is metered by its
   *  length, #2221). */
  recorded: boolean;
}

function asAddress(v: unknown): Address | null {
  if (typeof v !== 'string' || !ADDRESS.test(v) || BigInt(v) === 0n) return null;
  return v.toLowerCase() as Address;
}

/**
 * The contracts this pass reads besides the Diamond: the guard and registry
 * the stored snapshot names, else the deployment record's. Built from the
 * columns the pass's cursor read already carries (chainIndexer joins them
 * in), so it costs no D1 query of its own. `row` is null on a cold start.
 */
export function governanceWatchFrom(
  chainId: number,
  row: {
    snapshot_guard: unknown;
    snapshot_registry: unknown;
    watched_guard: string | null;
    watched_registry: string | null;
  } | null,
): GovernanceWatch {
  const dep = getDeployment(chainId);
  const guard = asAddress(row?.snapshot_guard) ?? asAddress(dep?.priceGuard);
  const registry = asAddress(row?.snapshot_registry) ?? asAddress(dep?.protocolRegistry);
  return {
    guard,
    registry,
    recorded: guard !== null && row?.watched_guard === guard && (row?.watched_registry ?? null) === registry,
  };
}

/** The extra addresses a scan reads, never one it already reads. */
export function governanceAddresses(watch: GovernanceWatch, scanned: readonly Address[]): Address[] {
  const seen = new Set(scanned.map((a) => a.toLowerCase()));
  const out: Address[] = [];
  for (const a of [watch.guard, watch.registry]) {
    if (a && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

/** A decoded guard or registry log. */
export interface GovernanceLog {
  source: 'guard' | 'registry';
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
}

type RawLog = { address: string; topics: readonly Hex[]; data: Hex; blockNumber: bigint | null; logIndex: number | null };

/**
 * Split a chunk's raw logs: the guard's and registry's decoded against their
 * own ABIs, everything else returned untouched for the Diamond decode. A log
 * from either that its ABI does not describe is dropped.
 */
export function splitGovernanceLogs<T extends RawLog>(
  raw: readonly T[],
  watch: GovernanceWatch,
): { rest: T[]; governance: GovernanceLog[] } {
  const rest: T[] = [];
  const governance: GovernanceLog[] = [];
  for (const log of raw) {
    const addr = log.address.toLowerCase();
    const source = addr === watch.guard ? 'guard' : addr === watch.registry ? 'registry' : null;
    if (source === null) {
      rest.push(log);
      continue;
    }
    if (log.blockNumber === null || log.logIndex === null) continue;
    try {
      const decoded = decodeEventLog({
        abi: (source === 'guard' ? PriceGuardABI : ProtocolRegistryABI) as Abi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      }) as unknown as { eventName: string; args: Record<string, unknown> };
      governance.push({
        source,
        eventName: decoded.eventName,
        args: decoded.args,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      });
    } catch {
      /* not an event this build knows; nothing to act on */
    }
  }
  return { rest, governance };
}

/** Whether these logs change anything the config snapshot shows: any
 *  registry event, or a guard settings event. */
export function governanceChangesConfig(logs: readonly GovernanceLog[]): boolean {
  return logs.some((l) => l.source === 'registry' || PRICE_GUARD_CONFIG_EVENTS.has(l.eventName));
}

function word(v: unknown): Hex {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase() as Hex;
  if (typeof v === 'bigint' || typeof v === 'number') {
    return `0x${BigInt(v).toString(16).padStart(64, '0')}` as Hex;
  }
  throw new Error('price guard log carries a word this build cannot read');
}

/**
 * The D1 statements that apply one pass's guard logs, in chain order, to the
 * pending-change list and the watch row. They join the cursor's batch, so
 * they land exactly when the cursor does. `logs` must already be limited to
 * the blocks the pass finished.
 */
export function governanceStatements(
  db: D1Database,
  opts: { chainId: number; watch: GovernanceWatch; logs: readonly GovernanceLog[]; scanFrom: bigint },
): D1PreparedStatement[] {
  const guard = opts.watch.guard;
  if (!guard) return [];
  const out: D1PreparedStatement[] = [];
  if (!opts.watch.recorded) {
    // A new guard starts its own record; the same guard keeps where it began.
    out.push(db
      .prepare(
        `INSERT INTO price_guard_watch (chain_id, guard, registry, from_block) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (chain_id) DO UPDATE SET
           registry = excluded.registry,
           from_block = CASE WHEN price_guard_watch.guard = excluded.guard
             THEN price_guard_watch.from_block ELSE excluded.from_block END,
           guard = excluded.guard`,
      )
      .bind(opts.chainId, guard, opts.watch.registry, Number(opts.scanFrom)));
  }
  const upsert = (kind: number, subject: Hex, value: Hex, executableAt: bigint, block: bigint) =>
    db
      .prepare(
        `INSERT INTO price_guard_pending_changes
           (chain_id, guard, kind, subject, value, executable_at, proposed_block)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (chain_id, guard, kind, subject) DO UPDATE SET
           value = excluded.value,
           executable_at = excluded.executable_at,
           proposed_block = excluded.proposed_block`,
      )
      .bind(opts.chainId, guard, kind, subject, value, Number(executableAt), Number(block));
  const remove = (kind: number, subject: Hex | null) =>
    subject === null
      ? db
          .prepare(`DELETE FROM price_guard_pending_changes WHERE chain_id = ?1 AND guard = ?2 AND kind = ?3`)
          .bind(opts.chainId, guard, kind)
      : db
          .prepare(
            `DELETE FROM price_guard_pending_changes
             WHERE chain_id = ?1 AND guard = ?2 AND kind = ?3 AND subject = ?4`,
          )
          .bind(opts.chainId, guard, kind, subject);
  const ordered = [...opts.logs]
    .filter((l) => l.source === 'guard')
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  for (const l of ordered) {
    const a = l.args;
    switch (l.eventName) {
      case 'ChangeProposed':
        out.push(upsert(Number(a.kind), word(a.subject), word(a.value), BigInt(a.executableAt as bigint), l.blockNumber));
        break;
      case 'ChangeCancelled':
      case 'ConfigSet':
        out.push(remove(Number(a.kind), word(a.subject)));
        break;
      case 'DelaySet':
        out.push(remove(KIND_DELAY, null));
        break;
      case 'PriceFloorRaised':
      case 'PriceFloorLapsed':
        out.push(remove(KIND_PRICE_FLOOR, null));
        break;
      case 'SecondaryRemovalProposed':
        out.push(upsert(SECONDARY_REMOVAL_KIND, word(a.source), ZERO_WORD, BigInt(a.executableAt as bigint), l.blockNumber));
        break;
      case 'SecondaryRemovalCancelled':
      case 'SecondaryRemoved':
        out.push(remove(SECONDARY_REMOVAL_KIND, word(a.source)));
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Re-read every listed change from `guard` at `blockNumber` and keep only
 * what the guard still holds; drop the rows of any other guard. Called by
 * the config refresh with the guard that refresh read. Fail-open: a failed
 * read leaves the rows as the events left them.
 */
export async function reconcilePendingGuardChanges(opts: {
  env: Env;
  chainId: number;
  client: PublicClient;
  guard: Address;
  blockNumber: bigint;
}): Promise<void> {
  const guard = opts.guard.toLowerCase();
  try {
    // One query: drop any other guard's rows and list this guard's.
    const [, listed] = await opts.env.DB.batch([
      opts.env.DB.prepare(`DELETE FROM price_guard_pending_changes WHERE chain_id = ? AND guard != ?`).bind(
        opts.chainId,
        guard,
      ),
      opts.env.DB.prepare(
        `SELECT kind, subject, proposed_block FROM price_guard_pending_changes
         WHERE chain_id = ? AND guard = ? ORDER BY kind, subject LIMIT 200`,
      ).bind(opts.chainId, guard),
    ]);
    const results = listed.results as { kind: number; subject: Hex; proposed_block: number }[];
    // A row proposed above the read block is newer than the read; leave it.
    const rows = results.filter((r) => BigInt(r.proposed_block) <= opts.blockNumber);
    if (rows.length === 0) return;
    const answers = await opts.client.multicall({
      contracts: rows.map((r) =>
        r.kind === SECONDARY_REMOVAL_KIND
          ? {
              address: guard as Address,
              abi: PriceGuardABI as Abi,
              functionName: 'secondaryRemovalAt',
              args: [Number(BigInt(r.subject))],
            }
          : {
              address: guard as Address,
              abi: PriceGuardABI as Abi,
              functionName: 'pendingChange',
              args: [r.kind, r.subject],
            },
      ),
      allowFailure: true,
      blockNumber: opts.blockNumber,
      multicallAddress: MULTICALL3_ADDRESS,
    });
    const statements: D1PreparedStatement[] = [];
    rows.forEach((r, i) => {
      const a = answers[i];
      if (!a || a.status !== 'success') return;
      let value: Hex = ZERO_WORD;
      let at: bigint;
      if (r.kind === SECONDARY_REMOVAL_KIND) {
        at = BigInt(a.result as bigint);
      } else {
        const [v, e] = a.result as readonly [Hex, bigint];
        value = word(v);
        at = BigInt(e);
      }
      statements.push(
        at === 0n
          ? opts.env.DB.prepare(
              `DELETE FROM price_guard_pending_changes
               WHERE chain_id = ?1 AND guard = ?2 AND kind = ?3 AND subject = ?4 AND proposed_block <= ?5`,
            ).bind(opts.chainId, guard, r.kind, r.subject, Number(opts.blockNumber))
          : opts.env.DB.prepare(
              `UPDATE price_guard_pending_changes SET value = ?5, executable_at = ?6
               WHERE chain_id = ?1 AND guard = ?2 AND kind = ?3 AND subject = ?4 AND proposed_block <= ?7`,
            ).bind(opts.chainId, guard, r.kind, r.subject, value, Number(at), Number(opts.blockNumber)),
      );
    });
    if (statements.length > 0) await opts.env.DB.batch(statements);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[priceGuardWatch] pending-change re-read failed for chain ${opts.chainId} (kept as the events left them): ${describeFailure(err)}`,
    );
  }
}

/** What `/config/:chainId` serves about the guard's pending changes. */
export interface PendingGuardChangesView {
  guard: string;
  /** The first block whose guard logs the indexer read. */
  listedFromBlock: number;
  /** True when reading began at or before the chain's deployment, so every
   *  change proposed to this guard since is listed. */
  sinceDeploy: boolean;
  changes: PendingPriceGuardChange[];
}

/**
 * The pending changes of the guard the stored snapshot names, for the route.
 * Null when that cannot be stated: no guard named, the guard not yet read,
 * or the tables not yet migrated (the route must tolerate the previous
 * schema). Never an empty list standing in for "unknown".
 */
export async function readPendingGuardChanges(
  env: Env,
  chainId: number,
  snapshotGuard: unknown,
): Promise<PendingGuardChangesView | null> {
  const guard = asAddress(snapshotGuard);
  if (!guard) return null;
  try {
    const [watch, rows] = await env.DB.batch([
      env.DB.prepare(`SELECT guard, from_block FROM price_guard_watch WHERE chain_id = ?`).bind(chainId),
      env.DB.prepare(
        `SELECT kind, subject, value, executable_at, proposed_block FROM price_guard_pending_changes
         WHERE chain_id = ? AND guard = ? ORDER BY executable_at, kind, subject LIMIT 200`,
      ).bind(chainId, guard),
    ]);
    const w = (watch.results as { guard: string; from_block: number }[])[0];
    if (!w || w.guard !== guard) return null;
    const deployBlock = getDeployment(chainId)?.deployBlock;
    return {
      guard,
      listedFromBlock: w.from_block,
      sinceDeploy: typeof deployBlock === 'number' && w.from_block <= deployBlock,
      changes: (
        rows.results as { kind: number; subject: Hex; value: Hex; executable_at: number; proposed_block: number }[]
      ).map((r) => {
        const kindName = priceGuardKindName(r.kind);
        const knobKey = kindName !== null && kindName !== 'SecondaryRemoval' ? PRICE_GUARD_KIND_KNOB[kindName] : undefined;
        return {
          kind: r.kind,
          kindName,
          subject: r.subject,
          value: r.value,
          executableAt: r.executable_at,
          proposedBlock: r.proposed_block,
          ...(knobKey ? { knobKey } : {}),
        };
      }),
    };
  } catch (err) {
    if (/no such table/i.test(String(err))) return null;
    throw err;
  }
}
