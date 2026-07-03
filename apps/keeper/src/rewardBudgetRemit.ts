// apps/keeper/src/rewardBudgetRemit.ts
//
// #925 — reward-budget remittance automation.
//
// The #776 bridge lets Base fund each mirror's interaction-reward VPFI on
// demand (`RewardRemittanceFacet.remitRewardBudget`, which is `onlyCanonical`
// — it runs ON Base and sends TO a mirror `dstChainId`). Without this pass an
// operator must hand-remit; this drives it on the cron tick so mirrors stay
// funded ahead of their claim frontier (remit-before-broadcast, IncidentRunbook
// §2b).
//
// Discovery is cursor-free by design: `quoteRewardBudget` returns 0 for any
// non-finalized / already-remitted / no-slice day, so re-scanning a bounded
// recent window each tick is harmless and needs no persisted state. Sends are
// idempotent on-chain (already-sent days are skipped), so a retry is always
// safe.
//
// Gated twice: the global `KEEPER_ENABLED` AND an explicit `REWARD_REMIT_ENABLED`
// so the path stays dark until the operator has also authorized the keeper EOA
// on-chain (`setRewardRemittanceKeeper`, or ADMIN).

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import {
  RewardRemittanceFacetABI,
  RewardReporterFacetABI,
  InteractionRewardsFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, isKeeperEnabled, type KeeperContext } from './keeper';

const REMIT_ABI = RewardRemittanceFacetABI as Abi;
const REPORTER_ABI = RewardReporterFacetABI as Abi;
const INTERACTION_ABI = InteractionRewardsFacetABI as Abi;

/** How many recent days to re-scan for un-remitted budget each tick. */
const DEFAULT_LOOKBACK_DAYS = 45;
/**
 * Per-send VPFI ceiling (the `perRemittanceCap` arg + the greedy batch bound).
 * Must not exceed the provisioned reward-budget CCIP lane bucket, and the lane
 * must clear the largest single-day slice (#918). 100k VPFI is above the
 * ~2×halfPoolForDay(1) worst-case day slice.
 */
const DEFAULT_LANE_CAP = 100_000n * 10n ** 18n;

function flagOn(env: Env, key: string): boolean {
  const v = (env as unknown as Record<string, string | undefined>)[key];
  return v === 'true' || v === '1';
}

function readNumber(env: Env, key: string, fallback: number): number {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readBigint(env: Env, key: string, fallback: bigint): bigint {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  if (!raw) return fallback;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function runRewardBudgetRemit(env: Env): Promise<void> {
  if (!isKeeperEnabled(env)) return;
  if (!flagOn(env, 'REWARD_REMIT_ENABLED')) return;

  for (const chain of getChainConfigs(env)) {
    try {
      await remitFromCanonical(env, chain);
    } catch (err) {
      console.error(`[keeper] rewardBudgetRemit chain=${chain.id} failed:`, err);
    }
  }
}

async function remitFromCanonical(env: Env, chain: ChainConfig): Promise<void> {
  const publicClient = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;

  // `remitRewardBudget` is Base-only; find the canonical chain and remit from it.
  const cfg = (await publicClient.readContract({
    address: diamond,
    abi: REPORTER_ABI,
    functionName: 'getRewardReporterConfig',
  })) as readonly [Address, number, number, boolean, bigint];
  const isCanonical = cfg[3];
  if (!isCanonical) return;

  const [currentDay, active] = (await publicClient.readContract({
    address: diamond,
    abi: INTERACTION_ABI,
    functionName: 'getInteractionCurrentDay',
  })) as readonly [bigint, boolean];
  if (!active || currentDay <= 1n) return; // no finalized (day < currentDay) yet

  const ctx = buildKeeperContext(env, chain, publicClient);
  if (!ctx || !ctx.wallet.account) return;

  // Base funds every OTHER configured chain.
  const mirrors = getChainConfigs(env).filter((c) => c.id !== chain.id);
  const lookback = readNumber(env, 'REWARD_REMIT_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS);
  const laneCap = readBigint(env, 'REWARD_REMIT_LANE_CAP', DEFAULT_LANE_CAP);

  for (const mirror of mirrors) {
    try {
      await remitToMirror(publicClient, ctx, diamond, mirror.id, currentDay, lookback, laneCap);
    } catch (err) {
      // Benign reverts (RewardPoolCapExceeded near exhaustion, NotRewardRemitter
      // if the keeper isn't authorized yet, etc.) — log at info and continue.
      console.log(
        `[keeper] rewardBudgetRemit skipped Base->${mirror.id}: ${(err as Error).message}`,
      );
    }
  }
}

async function remitToMirror(
  publicClient: PublicClient,
  ctx: KeeperContext,
  diamond: Address,
  mirrorId: number,
  currentDay: bigint,
  lookback: number,
  laneCap: bigint,
): Promise<void> {
  // Candidate window of recent finalized days (strictly < currentDay).
  const from = currentDay > BigInt(lookback) ? currentDay - BigInt(lookback) : 1n;
  const window: bigint[] = [];
  for (let d = from; d < currentDay; d++) window.push(d);
  if (window.length === 0) return;

  const [, perDay] = (await publicClient.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'quoteRewardBudget',
    args: [mirrorId, window],
  })) as readonly [bigint, readonly bigint[]];

  // Greedily batch the un-remitted days, keeping the total under the lane cap.
  const batch: bigint[] = [];
  let total = 0n;
  for (let i = 0; i < window.length; i++) {
    const slice = perDay[i] ?? 0n;
    if (slice === 0n) continue;
    if (slice > laneCap) {
      // A single day exceeds the lane bucket — remit sends a day atomically, so
      // this day is unfundable until the operator raises the lane capacity (#918).
      console.warn(
        `[keeper] rewardBudgetRemit day=${window[i]} slice=${slice} > laneCap=${laneCap} mirror=${mirrorId} — raise the reward-budget CCIP lane capacity (#918); day skipped`,
      );
      continue;
    }
    if (total + slice > laneCap) break; // fill the rest on a later tick
    batch.push(window[i]);
    total += slice;
  }
  if (batch.length === 0) return;

  // Exact CCIP fee for THIS batch (the keeper EOA can't call the messenger's
  // quote directly — only the Diamond handler can; that's what this view wraps).
  const [fee] = (await publicClient.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'quoteRemittanceFee',
    args: [mirrorId, batch],
  })) as readonly [bigint, bigint];

  const hash = await ctx.wallet.writeContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'remitRewardBudget',
    args: [mirrorId, batch, laneCap],
    value: fee,
    chain: undefined,
    account: ctx.wallet.account ?? null,
  } as never);
  console.log(
    `[keeper] rewardBudgetRemit Base->${mirrorId} days=${batch.length} total=${total} fee=${fee} tx=${hash}`,
  );
}
