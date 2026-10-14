// apps/keeper/src/deliveryProof.ts
//
// #1944 consequence 1 + the transport epochs — INDEX and PROVE every reward-
// budget delivery's days on each mirror.
//
// A delivery that lands on a mirror funds the days it lists, but the chain
// learns WHICH days only when somebody supplies the list against the
// commitment the delivery's own ingress stamped (the destination's gas budget
// is spent by the ingress itself, so no per-day write rides the delivery).
// Every route is permissionless and moves no value; nothing calls them by
// itself, so this pass does, on every mirror:
//
//   - a delivery holding a transport EPOCH (a batch) is INDEXED: a flat list
//     page by page (`materializeTransportBatchPage`, the whole list each call,
//     one page written), a rooted (d6) list chunk by chunk
//     (`materializeTransportBatchChunk`, each chunk with its Merkle proof).
//     Until its days are indexed an epoch funds nothing a claim can find;
//   - a delivery holding NO epoch (a pre-activation rooted delivery, a typed
//     or legacy flat one) is PROVEN: `proveDeliveryDayChunk` per chunk, or
//     `proveDeliveryDayList` once for a flat list — the step the #1944
//     delivery gate waits on before a mirror day may be priced.
//
// The flat list comes from the delivery's own `RewardBudgetReceived` event.
// A rooted list is REBUILT from Base, per the runbook's reconstruction rule:
// the reservation's day list (every day the remit closed, a superset) filtered
// to the days actually funded for this chain, chunked and rooted with the
// wire's own rules (`d6Wire.ts`) and checked against BOTH the reservation's and
// the packet's root before any proof is sent. Every write is simulated first.
//
// Gated by KEEPER_ENABLED + REWARD_DELIVERY_PROOF_ENABLED.

import { createPublicClient, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import {
  RewardEpochFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import { batchedRead } from './batchRead';
import { listBudgetDeliveries, listWorkDone, markWorkDone, type BudgetDeliveryRow } from './db';
import { d6Chunk, d6Leaves, d6Proof, d6Root } from './d6Wire';

const ABI = [
  ...(RewardEpochFacetABI as Abi),
  ...(RewardRemittanceLensFacetABI as Abi),
  ...(RewardReporterFacetABI as Abi),
] as Abi;

/** Transactions per chain per tick (each indexes one page or one chunk). */
const MAX_WRITES_PER_TICK = 20;
/** How long one send may take to be mined before this tick's sends stop. */
const RECEIPT_TIMEOUT_MS = 30_000;
/** Reads per `aggregate3` (#1946). */
const READ_CHUNK = 100;
/** This pass's done-set kind (`keeper_work_done.kind`). */
const DONE_KIND = 'delivery_proof' as const;

/** What a packet's ingress recorded, as the pass reads it. */
export interface PacketState {
  kind: number;
  batchId: Hex;
  dayListHash: Hex;
  dayListRoot: Hex;
  chunkCount: number;
  /** Bit `i` set = chunk `i` landed (indexed or proven). */
  chunksIndexed: bigint;
  disposed: bigint;
}

/** A batch's index progress. */
export interface BatchProgress {
  dayCount: number;
  indexedDays: number;
}

export type ProofAction =
  | { kind: 'indexPage'; batchId: Hex; dayIds: bigint[] }
  | { kind: 'indexChunk'; batchId: Hex; chunkIndex: number; dayIds: bigint[]; proof: Hex[] }
  | { kind: 'proveChunk'; packetHash: Hex; chunkIndex: number; dayIds: bigint[]; proof: Hex[] }
  | { kind: 'proveList'; packetHash: Hex; dayIds: bigint[] };

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/**
 * The actions a delivery still needs. Pure: the packet's recorded state, its
 * batch's progress, and its day list in; the calls out — nothing for a
 * disposed packet, a non-budget packet, or one whose list cannot be had.
 * `rootedDays` is the REBUILT rooted list (already checked against the root by
 * the caller); `flatDays` the event's list; `landed` says which flat days the
 * chain already counts as landed, so a whole flat list already proven is not
 * re-proven.
 */
export function planDelivery(args: {
  packetHash: Hex;
  packet: PacketState;
  batch: BatchProgress | null;
  flatDays: bigint[] | null;
  rootedDays: bigint[] | null;
  flatAllLanded: boolean;
}): ProofAction[] {
  const { packetHash, packet, batch } = args;
  if (packet.kind !== 1 || packet.disposed !== 0n) return [];
  const batched = packet.batchId !== ZERO32;
  if (packet.dayListRoot !== ZERO32) {
    const days = args.rootedDays;
    if (!days || days.length === 0) return [];
    const leaves = d6Leaves(days);
    if (leaves.length !== packet.chunkCount) return [];
    const out: ProofAction[] = [];
    for (let c = 0; c < packet.chunkCount; c++) {
      if ((packet.chunksIndexed >> BigInt(c)) & 1n) continue;
      const chunk = d6Chunk(days, c);
      const proof = d6Proof(leaves, c);
      out.push(
        batched
          ? { kind: 'indexChunk', batchId: packet.batchId, chunkIndex: c, dayIds: chunk, proof }
          : { kind: 'proveChunk', packetHash, chunkIndex: c, dayIds: chunk, proof },
      );
    }
    return out;
  }
  if (packet.dayListHash !== ZERO32) {
    const days = args.flatDays;
    if (!days || days.length === 0) return [];
    if (batched) {
      // One page per call; the page writer refuses once the index is whole.
      return batch && batch.indexedDays < batch.dayCount
        ? [{ kind: 'indexPage', batchId: packet.batchId, dayIds: days }]
        : [];
    }
    return args.flatAllLanded ? [] : [{ kind: 'proveList', packetHash, dayIds: days }];
  }
  return []; // a pre-3a packet carries no provable list
}

/**
 * The canonical (Base) chain a mirror's deliveries come from, from
 * `getRewardReporterConfig` — `(rewardMessenger, localChainId, baseChainId,
 * isCanonical, grace)`. Field 2, never field 1: field 1 is the MIRROR's own id,
 * and reading it sent every rooted-list rebuild to the mirror itself, where the
 * reservation reads as empty and no rooted delivery was ever indexed or proven.
 * Null on the canonical chain, which funds itself.
 */
export function canonicalChainOf(cfg: readonly [Address, number, number, boolean, bigint]): number | null {
  if (cfg[3]) return null;
  const base = Number(cfg[2]);
  return base > 0 ? base : null;
}

/** Whether a packet can still need a write — checked BEFORE any read of its
 *  batch or its rooted list, so a finished one costs nothing. A flat list's
 *  answer needs those reads, so a flat packet always "may" — see
 *  {@link deliveryComplete} for the verdict once they are made. */
export function packetMayNeedWork(packet: PacketState): boolean {
  if (packet.kind !== 1 || packet.disposed !== 0n) return false;
  if (packet.dayListRoot !== ZERO32) {
    const all = packet.chunkCount >= 256 ? -1n : (1n << BigInt(packet.chunkCount)) - 1n;
    return packet.chunkCount > 0 && (packet.chunksIndexed & all) !== all;
  }
  return packet.dayListHash !== ZERO32;
}

/**
 * Whether a delivery is FINISHED on chain, so the pass may record it in its
 * done set and never read it again (Codex #2489 r1). Pure; true only on
 * evidence the chain itself gives:
 *   - nothing provable is left: disposed, not a budget packet, no list, or a
 *     rooted list whose every chunk has landed;
 *   - an EPOCH's flat list: the batch's index is whole;
 *   - a no-epoch flat list: every listed day reads as landed.
 * Anything unread (a batch read that failed, a list that could not be had) is
 * NOT finished — it is read again next tick.
 */
export function deliveryComplete(args: {
  packet: PacketState;
  batch: BatchProgress | null;
  flatAllLanded: boolean;
}): boolean {
  const { packet, batch } = args;
  if (!packetMayNeedWork(packet)) return true;
  if (packet.dayListRoot !== ZERO32) return false; // a rooted chunk is still out
  if (packet.batchId !== ZERO32) return batch !== null && batch.dayCount > 0 && batch.indexedDays >= batch.dayCount;
  return args.flatAllLanded;
}

export async function runDeliveryProof(env: Env): Promise<void> {
  if (!passIsArmed(env, 'deliveryProof', 'REWARD_DELIVERY_PROOF_ENABLED')) return;
  const chains = getChainConfigs(env);
  const byId = new Map(chains.map((c) => [c.id, c]));
  for (const chain of chains) {
    try {
      await proveOnMirror(env, chain, byId);
    } catch (err) {
      console.error(`[keeper] deliveryProof chain=${chain.id} failed:`, err);
    }
  }
}

async function proveOnMirror(env: Env, chain: ChainConfig, byId: Map<number, ChainConfig>): Promise<void> {
  const client = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;
  const cfg = (await client.readContract({
    address: diamond,
    abi: ABI,
    functionName: 'getRewardReporterConfig',
  })) as readonly [Address, number, number, boolean, bigint];
  const baseChainId = canonicalChainOf(cfg);
  if (baseChainId === null) return; // the canonical chain funds itself: nothing is delivered to it

  // Every delivery the log holds, less the ones already seen finished: work is
  // dropped only on the chain's word, never by its age.
  const done = await listWorkDone(env.KEEPER_DB, chain.id, diamond, DONE_KIND);
  const rows = (await listBudgetDeliveries(env.DB, chain.id)).filter((r) => !done.has(r.packetHash.toLowerCase()));
  if (rows.length === 0) return;

  const packets = await readPackets(client, diamond, rows.map((r) => r.packetHash as Hex));
  // Packets read as finished are recorded however the tick ends (a failed
  // send, no key to send with), so they are never read again.
  const finished = new Set<string>();
  const base = byId.get(baseChainId);
  const baseClient = base ? createPublicClient({ transport: http(base.rpc) }) : null;
  const ctx = buildKeeperContext(env, chain, client as never);
  const canSend = Boolean(ctx?.wallet.account);
  if (!canSend) console.warn(`[keeper] deliveryProof chain=${chain.id}: no keeper key — nothing sent`);
  const budget = { writes: canSend ? MAX_WRITES_PER_TICK : 0 };
  const seen = new Set<string>();
  try {
    for (const row of rows) {
      const key = row.packetHash.toLowerCase();
      if (seen.has(key)) continue; // one pass per packet, whatever the join returned
      seen.add(key);
      const packet = packets.get(key);
      if (!packet) continue; // unread, or not arrived: read again next tick
      if (!packetMayNeedWork(packet)) {
        finished.add(key);
        continue;
      }
      if (budget.writes <= 0) continue; // the rest wait for a tick with budget
      // One row's failed read (a canonical RPC outage, say) skips that row, never
      // the chain's whole pass.
      let plan: DeliveryPlan;
      try {
        // eslint-disable-next-line no-await-in-loop
        plan = await actionsFor(client, diamond, chain.id, row, packet, base, baseClient);
      } catch (err) {
        console.error(`[keeper] deliveryProof packet=${row.packetHash} read failed: ${shortErr(err)}`);
        continue;
      }
      if (plan.complete) {
        finished.add(key);
        continue;
      }
      for (const a of plan.actions) {
        if (budget.writes <= 0) break;
        // eslint-disable-next-line no-await-in-loop
        await send(ctx!, budget, a);
      }
    }
  } finally {
    await markWorkDone(env.KEEPER_DB, chain.id, diamond, DONE_KIND, [...finished]);
  }
}

/** What one delivery still needs, and whether it is already finished. */
interface DeliveryPlan {
  actions: ProofAction[];
  complete: boolean;
}

async function actionsFor(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  row: BudgetDeliveryRow,
  packet: PacketState,
  base: ChainConfig | undefined,
  baseClient: PublicClient | null,
): Promise<DeliveryPlan> {
  const packetHash = row.packetHash as Hex;
  let batch: BatchProgress | null = null;
  if (packet.batchId !== ZERO32) {
    const b = (await client.readContract({
      address: diamond,
      abi: ABI,
      functionName: 'getTransportBatch',
      args: [packet.batchId],
    })) as readonly [Hex, bigint, bigint, number, number, boolean];
    batch = { dayCount: Number(b[3]), indexedDays: Number(b[4]) };
  }
  let rootedDays: bigint[] | null = null;
  if (packet.dayListRoot !== ZERO32) {
    if (!base || !baseClient) {
      console.warn(`[keeper] deliveryProof packet=${packetHash}: no RPC for the canonical chain — cannot rebuild its list`);
      return { actions: [], complete: false };
    }
    rootedDays = await rebuildRootedList(baseClient, base.diamond as Address, chainId, BigInt(row.remitId), packet.dayListRoot);
    if (!rootedDays) return { actions: [], complete: false };
  }
  const flatDays = row.flatDayIds ? row.flatDayIds.map((d) => BigInt(d)) : null;
  let flatAllLanded = false;
  if (flatDays && packet.batchId === ZERO32 && packet.dayListRoot === ZERO32) {
    flatAllLanded = await allLanded(client, diamond, flatDays);
  }
  if (deliveryComplete({ packet, batch, flatAllLanded })) return { actions: [], complete: true };
  return { actions: planDelivery({ packetHash, packet, batch, flatDays, rootedDays, flatAllLanded }), complete: false };
}

/**
 * The runbook's reconstruction rule: Base's reservation lists every day the
 * remit CLOSED; the wire lists only the days FUNDED for this chain, in order.
 * Filter, chunk, root — and refuse unless the rebuilt root equals the
 * reservation's AND the packet's, so a wrong list is never submitted.
 */
async function rebuildRootedList(
  baseClient: PublicClient,
  baseDiamond: Address,
  chainId: number,
  remitId: bigint,
  packetRoot: Hex,
): Promise<bigint[] | null> {
  if (remitId === 0n) return null;
  const r = (await baseClient.readContract({
    address: baseDiamond,
    abi: ABI,
    functionName: 'getRemitReservation',
    args: [remitId],
  })) as { dayIds: readonly bigint[]; dayListRoot: Hex; dstChainId: number };
  if (Number(r.dstChainId) !== chainId) {
    console.warn(`[keeper] deliveryProof remit=${remitId}: the reservation names chain ${r.dstChainId}, not ${chainId} — skipped`);
    return null;
  }
  const remitted = await batchedRead(
    baseClient as never,
    r.dayIds.map((d) => ({
      address: baseDiamond,
      abi: ABI,
      functionName: 'getRewardBudgetRemitted' as const,
      args: [chainId, d] as const,
    })),
    `deliveryProof remitted remit=${remitId}`,
  );
  const funded: bigint[] = [];
  for (let i = 0; i < r.dayIds.length; i++) {
    const res = remitted[i];
    if (!res || res.status !== 'success') return null; // never guess a list
    if ((res.result as bigint) !== 0n) funded.push(r.dayIds[i]);
  }
  if (funded.length === 0) return null;
  const root = d6Root(d6Leaves(funded));
  if (root.toLowerCase() !== r.dayListRoot.toLowerCase() || root.toLowerCase() !== packetRoot.toLowerCase()) {
    console.warn(`[keeper] deliveryProof remit=${remitId}: rebuilt root ${root} disagrees with the reservation or the packet — skipped`);
    return null;
  }
  return funded;
}

async function allLanded(client: PublicClient, diamond: Address, days: bigint[]): Promise<boolean> {
  for (let i = 0; i < days.length; i += READ_CHUNK) {
    const chunk = days.slice(i, i + READ_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const res = await batchedRead(
      client as never,
      chunk.map((d) => ({ address: diamond, abi: ABI, functionName: 'getDayDeliveryState' as const, args: [d] as const })),
      'deliveryProof landed',
    );
    for (const r of res) {
      if (!r || r.status !== 'success') return false;
      const t = r.result as readonly unknown[];
      if (t[3] !== true) return false; // `landed`
    }
  }
  return true;
}

async function readPackets(client: PublicClient, diamond: Address, hashes: Hex[]): Promise<Map<string, PacketState>> {
  const out = new Map<string, PacketState>();
  for (let i = 0; i < hashes.length; i += READ_CHUNK) {
    const chunk = hashes.slice(i, i + READ_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const res = await batchedRead(
      client as never,
      chunk.map((h) => ({ address: diamond, abi: ABI, functionName: 'getIngressPacket' as const, args: [h] as const })),
      'deliveryProof packets',
    );
    res.forEach((r, j) => {
      if (!r || r.status !== 'success') return;
      const p = r.result as {
        kind: number;
        batchId: Hex;
        dayListHash: Hex;
        dayListRoot: Hex;
        chunkCount: number;
        chunksIndexed: bigint;
        disposed: bigint;
        arrivedAt: bigint;
      };
      if (!p.arrivedAt) return;
      out.set(chunk[j].toLowerCase(), {
        kind: Number(p.kind),
        batchId: p.batchId,
        dayListHash: p.dayListHash,
        dayListRoot: p.dayListRoot,
        chunkCount: Number(p.chunkCount),
        chunksIndexed: BigInt(p.chunksIndexed),
        disposed: BigInt(p.disposed),
      });
    });
  }
  return out;
}

async function send(ctx: KeeperContext, budget: { writes: number }, a: ProofAction): Promise<void> {
  const call =
    a.kind === 'indexPage'
      ? { functionName: 'materializeTransportBatchPage', args: [a.batchId, a.dayIds] }
      : a.kind === 'indexChunk'
        ? { functionName: 'materializeTransportBatchChunk', args: [a.batchId, BigInt(a.chunkIndex), a.dayIds, a.proof, [], []] }
        : a.kind === 'proveChunk'
          ? { functionName: 'proveDeliveryDayChunk', args: [a.packetHash, BigInt(a.chunkIndex), a.dayIds, a.proof] }
          : { functionName: 'proveDeliveryDayList', args: [a.packetHash, a.dayIds] };
  try {
    await ctx.client.simulateContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: call.functionName,
      args: call.args as never,
      account: ctx.wallet.account!,
    });
  } catch (err) {
    console.log(`[keeper] deliveryProof ${call.functionName} skipped: ${shortErr(err)}`);
    return;
  }
  try {
    const hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: call.functionName,
      args: call.args,
      chain: undefined,
      account: ctx.wallet.account ?? null,
    } as never);
    budget.writes -= 1;
    console.log(`[keeper] deliveryProof ${call.functionName} chain=${ctx.chainId} tx=${hash}`);
    // Wait for inclusion before the next send (the matcher's pattern): the
    // liquidator and matcher sign from the same account, so a burst of
    // unmined sends would race them for nonces. Every step here is
    // idempotent; one that does not land in time ends this pass's sends for
    // the tick and the next tick re-reads the packet.
    const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') {
      console.error(`[keeper] deliveryProof ${call.functionName} reverted on chain: tx=${hash}`);
    }
  } catch (err) {
    console.error(`[keeper] deliveryProof ${call.functionName} send failed: ${shortErr(err)}`);
    budget.writes = 0;
  }
}

function shortErr(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return String(e?.shortMessage ?? e?.message ?? err).slice(0, 200);
}

