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
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, isKeeperEnabled } from './keeper';
import {
  getRemitAckFrontier,
  putRemitAckFrontier,
  getRemitAckAttempts,
  recordRemitAckAttempt,
  markRemitAcked,
} from './db';

const REMIT_ABI = RewardRemittanceFacetABI as Abi;
const REPORTER_ABI = RewardReporterFacetABI as Abi;

/** Max reservation ids examined per tick (scan stays O(bounded)). */
const MAX_SCAN_PER_TICK = 200;
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

function flagOn(env: Env, key: string): boolean {
  const v = (env as unknown as Record<string, string | undefined>)[key];
  return v === 'true' || v === '1';
}

export async function runRemitAck(env: Env): Promise<void> {
  if (!isKeeperEnabled(env)) return;
  if (!flagOn(env, 'REWARD_REMIT_ENABLED')) return;

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

  const frontier = await getRemitAckFrontier(env.DB, baseChainId);
  const from = BigInt(frontier);
  if (from > nonce) return;
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
  let prefixUnbroken = true;

  for (let id = from; id < to; id++) {
    const r = (await publicClient.readContract({
      address: diamond,
      abi: REMIT_ABI,
      functionName: 'getRemitReservation',
      args: [id],
    })) as RemitReservationView;
    if (r.status === 2 || r.status === 3) {
      if (r.status === 2) await markRemitAcked(env.DB, baseChainId, Number(id));
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
  if (contiguousTerminal > frontier) {
    await putRemitAckFrontier(env.DB, baseChainId, contiguousTerminal);
  }
  if (pendingIds.length === 0) return;

  const attempts = await getRemitAckAttempts(env.DB, baseChainId, pendingIds);
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
      const sent = await sendAckFromMirror(env, mirrorCfg, mirrorClients, remitId);
      if (sent) {
        await recordRemitAckAttempt(env.DB, baseChainId, remitId, r.dstChainId);
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
    args: [BigInt(remitId)],
  })) as { srcChainId: number; receivedAt: bigint; amount: bigint };
  if (receipt.receivedAt === 0n) return false;

  const ctx = buildKeeperContext(env, mirrorCfg, client);
  if (!ctx || !ctx.wallet.account) return false;

  const fee = (await client.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'quoteRemitAckFee',
    args: [BigInt(remitId)],
  })) as bigint;

  const hash = await ctx.wallet.writeContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'sendRemitAck',
    args: [BigInt(remitId), ctx.wallet.account.address],
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
