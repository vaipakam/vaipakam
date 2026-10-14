// apps/keeper/src/remitAck.ts
//
// #1222 M3 B2-d2 — delivered-backing remit-ACK automation (P7).
//
// Base reserves every reward-budget remittance into a `RemitReservation`
// (Pending) and finalizes it only on the mirror's authenticated ack
// (`RewardRemittanceFacet.sendRemitAck`, mirror-side, permissionless +
// re-sendable). Nothing sends that ack by itself — this pass drives it:
//
//   1. On Base: reservations are DENSE (remitId 1..getRemitReservationNonce),
//      so the pass scans from a D1-persisted frontier (all ids below it are
//      terminal) — no event scanning, no unbounded re-reads.
//   2. For each Pending reservation, it checks the destination mirror's
//      receipt record (`getReceivedRemit`) — present means the CCIP delivery
//      landed and the ack is sendable.
//   3. It quotes + sends the ack FROM the mirror (the keeper EOA pays the
//      CCIP fee), with a D1-backed attempt backoff: an ack takes minutes to
//      deliver, so re-sending every tick would burn fees. The mirror send is
//      content-free for the caller (the Diamond echoes its own receipt), and
//      Base finalizes idempotently — a duplicate ack is harmless.
//
// A reservation whose delivery has NOT landed (no receipt) is left Pending —
// the recovery for a stuck CCIP message is re-execution (operator), then the
// receipt appears and this pass acks it. Operator terminals
// (finalize/release valves) are deliberately manual and NOT driven here.
//
// Gated by KEEPER_ENABLED + REWARD_REMIT_ENABLED (the ack completes remits —
// same arming as the remit pass itself).

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import {
  RewardRemittanceFacetABI,
  RewardReporterFacetABI,
  RewardRemittanceLensFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed } from './keeper';
import { batchedRead } from './batchRead';
import {
  getRemitAckScanState,
  putRemitAckScanState,
  getRemitAckAttempts,
  recordRemitAckAttempt,
  markRemitAcked,
} from './db';

// #1660 r9 - quoteRemitAckFee moved to the LENS facet for EIP-170
// headroom on the mutating facet; viem resolves functions from the
// SUPPLIED ABI before any RPC, so the keeper's remit surface must
// combine both facets' ABIs (the Diamond routes either selector).
const REMIT_ABI = [
  ...(RewardRemittanceFacetABI as Abi),
  ...(RewardRemittanceLensFacetABI as Abi),
] as Abi;
const REPORTER_ABI = RewardReporterFacetABI as Abi;

/** Max reservation ids examined per tick (scan stays O(bounded)). */
const MAX_SCAN_PER_TICK = 200;
/** Reservations per `aggregate3`. Matches the other passes' bound (#1946). */
const SCAN_CHUNK = 100;
/** Max ack sends per tick (each is a CCIP fee spend). */
const MAX_ACKS_PER_TICK = 5;
/** Min seconds between ack attempts for one reservation (CCIP delivery
 *  takes minutes; Base finalizes idempotently so overlap is safe, just
 *  wasteful). */
const ACK_RETRY_BACKOFF_SEC = 15 * 60;

interface RemitReservationView {
  dstChainId: number;
  status: number;
  sentAt: bigint;
  ccipMessageId: `0x${string}`;
  total: bigint;
  fresh: bigint;
  recycled: bigint;
  armedFreshFull: bigint;
  recycledFull: bigint;
  dayIds: readonly bigint[];
}

export async function runRemitAck(env: Env): Promise<void> {
  if (!passIsArmed(env, 'remitAck', 'REWARD_REMIT_ENABLED')) return;

  for (const chain of getChainConfigs(env)) {
    try {
      await ackFromBaseLedger(env, chain);
    } catch (err) {
      console.error(`[keeper] remitAck chain=${chain.id} failed:`, err);
    }
  }
}

async function ackFromBaseLedger(env: Env, chain: ChainConfig): Promise<void> {
  const publicClient = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;

  // The reservation ledger lives on Base only.
  const cfg = (await publicClient.readContract({
    address: diamond,
    abi: REPORTER_ABI,
    functionName: 'getRewardReporterConfig',
  })) as readonly [Address, number, number, boolean, bigint];
  const baseChainId = Number(cfg[1]);
  const isCanonical = cfg[3];
  if (!isCanonical) return;

  const nonce = (await publicClient.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'getRemitReservationNonce',
  })) as bigint;
  if (nonce === 0n) return;

  const { frontier, scanCursor } = await getRemitAckScanState(env.DB, baseChainId, diamond);
  if (BigInt(frontier) > nonce) return;
  // Rotating window (Codex #1426 r1): start from the persisted cursor when
  // it is ahead of the frontier — a stuck early Pending pins the frontier,
  // and without the rotation the bounded window would re-read that range
  // every tick while later reservations went undiscovered. Wrap back to the
  // frontier once the cursor passes the ledger tip.
  let from = BigInt(Math.max(frontier, scanCursor));
  if (from > nonce) from = BigInt(frontier);
  const to = from + BigInt(MAX_SCAN_PER_TICK) < nonce + 1n
    ? from + BigInt(MAX_SCAN_PER_TICK)
    : nonce + 1n;

  // Mirror clients are built lazily, once per destination chain.
  const mirrorConfigs = new Map<number, ChainConfig>();
  for (const c of getChainConfigs(env)) mirrorConfigs.set(c.id, c);
  const mirrorClients = new Map<number, PublicClient>();

  const pendingIds: number[] = [];
  const reservations = new Map<number, RemitReservationView>();
  let contiguousTerminal = frontier;
  // The terminal-prefix frontier may only advance when this window actually
  // starts AT the frontier (a rotated window proves nothing about the ids
  // it skipped).
  let prefixUnbroken = from === BigInt(frontier);

  // BATCHED (#1896). This was one `getRemitReservation` per id in the window —
  // up to MAX_SCAN_PER_TICK subrequests per tick against a 50-per-invocation
  // ceiling, and the per-selector attribution measured 200 of them on a pass
  // whose transaction work is 8% of its traffic. The window, its bounds and the
  // order of processing are unchanged; only the round-trips collapse.
  const windowIds: bigint[] = [];
  for (let id = from; id < to; id++) windowIds.push(id);
  const scanResults: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[] = [];
  for (let i = 0; i < windowIds.length; i += SCAN_CHUNK) {
    const chunk = windowIds.slice(i, i + SCAN_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const part = await batchedRead(
      publicClient as never,
      chunk.map((id) => ({
        address: diamond,
        abi: REMIT_ABI,
        functionName: 'getRemitReservation' as const,
        args: [id] as const,
      })),
      `remitAck getRemitReservation ${i}/${windowIds.length}`,
    );
    scanResults.push(...part);
  }

  for (let idx = 0; idx < windowIds.length; idx++) {
    const id = windowIds[idx];
    const res = scanResults[idx];
    if (!res || res.status !== 'success') {
      // A read failure ABORTS the scan, which is what the sequential version
      // did: the throw unwound to the per-chain catch, so `putRemitAckScanState`
      // never ran and neither the frontier nor the cursor advanced past an id
      // whose status is unknown. Advancing either on an unread reservation is
      // the one outcome worth avoiding here, so the failure is preserved rather
      // than turned into a per-id skip. Ids already processed above keep their
      // (idempotent) acked marks, exactly as before.
      console.warn(
        `[keeper] remitAck scan aborted at remit=${id}: ${String(
          res?.error ?? 'no result',
        ).slice(0, 200)}`,
      );
      return;
    }
    const r = res.result as RemitReservationView;
    if (r.status === 2 || r.status === 3) {
      if (r.status === 2) await markRemitAcked(env.DB, baseChainId, diamond, Number(id));
      if (prefixUnbroken) contiguousTerminal = Number(id) + 1;
      continue;
    }
    prefixUnbroken = false;
    if (r.status === 1) {
      pendingIds.push(Number(id));
      reservations.set(Number(id), r);
    }
    // status 0 past the frontier can only be the tail beyond the nonce —
    // the loop bound already excludes it.
  }
  await putRemitAckScanState(env.DB, baseChainId, diamond, contiguousTerminal, Number(to));
  if (pendingIds.length === 0) return;

  const attempts = await getRemitAckAttempts(env.DB, baseChainId, diamond, pendingIds);
  const now = Math.floor(Date.now() / 1000);
  let acksSent = 0;

  for (const remitId of pendingIds) {
    if (acksSent >= MAX_ACKS_PER_TICK) break;
    const r = reservations.get(remitId);
    if (!r) continue;
    const prior = attempts.get(remitId);
    if (prior && now - prior.lastAttemptAt < ACK_RETRY_BACKOFF_SEC) continue;

    const mirrorCfg = mirrorConfigs.get(r.dstChainId);
    if (!mirrorCfg) {
      console.warn(
        `[keeper] remitAck remit=${remitId} dst=${r.dstChainId} has no configured RPC — cannot drive the ack`,
      );
      continue;
    }
    try {
      const sent = await sendAckFromMirror(env, mirrorCfg, mirrorClients, remitId, diamond);
      if (sent) {
        await recordRemitAckAttempt(env.DB, baseChainId, diamond, remitId, r.dstChainId);
        acksSent++;
      }
    } catch (err) {
      console.log(
        `[keeper] remitAck remit=${remitId} dst=${r.dstChainId} skipped: ${(err as Error).message}`,
      );
    }
  }
}

/** Send one ack from the mirror. Returns false when the delivery has not
 *  landed there yet (no receipt — nothing to ack). */
async function sendAckFromMirror(
  env: Env,
  mirrorCfg: ChainConfig,
  clients: Map<number, PublicClient>,
  remitId: number,
  // r4 — receipts key by (remitter, remitId); the remitter is the Base
  // diamond whose reservation ledger this pass is scanning.
  baseDiamond: Address,
): Promise<boolean> {
  let client = clients.get(mirrorCfg.id);
  if (!client) {
    client = createPublicClient({ transport: http(mirrorCfg.rpc) });
    clients.set(mirrorCfg.id, client);
  }
  const diamond = mirrorCfg.diamond as Address;

  const receipt = (await client.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'getReceivedRemit',
    args: [baseDiamond, BigInt(remitId)],
  })) as { srcChainId: number; receivedAt: bigint; amount: bigint };
  if (receipt.receivedAt === 0n) return false;

  const ctx = buildKeeperContext(env, mirrorCfg, client);
  if (!ctx || !ctx.wallet.account) return false;

  const fee = (await client.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'quoteRemitAckFee',
    args: [BigInt(remitId), baseDiamond],
  })) as bigint;

  const hash = await ctx.wallet.writeContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'sendRemitAck',
    args: [BigInt(remitId), baseDiamond, ctx.wallet.account.address],
    value: fee,
    chain: undefined,
    account: ctx.wallet.account ?? null,
  } as never);
  console.log(
    `[keeper] remitAck remit=${remitId} mirror=${mirrorCfg.id} fee=${fee} tx=${hash}`,
  );
  // No receipt wait: Base finalizes idempotently and the D1 backoff bounds
  // re-sends — a dropped tx simply retries after the backoff window.
  return true;
}
