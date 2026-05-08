/**
 * dailyOracleSnapshot.ts — captures the on-chain
 * `OracleFacet.captureDailyPriceSnapshot` once per UTC day per
 * tracked chain. AnalyticalGettersDesign §3.4 D9–D10.
 *
 * Why this lives here, not as a one-shot deploy: the ring-buffer's
 * `s.assetPriceSnapshots[asset][dayIndex]` writes are
 * permissionless on the contract side; the Worker is the
 * scheduling glue. Without a daily caller every UTC midnight the
 * frontend's historical-TVL chart shows holes — which defeats the
 * whole Bucket-C → Bucket-A move §3.4 promised.
 *
 * The on-chain function silently skips already-captured assets per
 * day, so over-firing is harmless. Under-firing leaves a gap
 * that ANY subsequent caller can fill before the day rolls — the
 * keeper isn't a single-point-of-failure, it's the predictable-
 * cadence default.
 */
import {
  http,
  createPublicClient,
  createWalletClient,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { Env, ChainConfig } from './env';
import { getChainConfigs } from './env';

const CAPTURE_ABI = [
  {
    type: 'function',
    name: 'captureDailyPriceSnapshot',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'assets', type: 'address[]' }],
    outputs: [],
  },
] as const;

/**
 * Pull the unique set of `lending_asset` ∪ `collateral_asset`
 * addresses for a given chain from the watcher's D1 indexer.
 * Skips the zero address (NFT loans whose lending_asset isn't a
 * priceable ERC-20).
 */
async function fetchTrackedAssets(env: Env, chainId: number): Promise<Address[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT asset FROM (
       SELECT lending_asset    AS asset FROM loans  WHERE chain_id = ?1
       UNION
       SELECT collateral_asset AS asset FROM loans  WHERE chain_id = ?1
       UNION
       SELECT lending_asset    AS asset FROM offers WHERE chain_id = ?1
       UNION
       SELECT collateral_asset AS asset FROM offers WHERE chain_id = ?1
     )
     WHERE asset != '0x0000000000000000000000000000000000000000'
       AND asset != ''`,
  )
    .bind(chainId)
    .all<{ asset: string }>();
  if (!rows.results) return [];
  return rows.results.map((r) => r.asset.toLowerCase() as Address);
}

/**
 * Read the last day index this chain successfully captured. We
 * track this in a tiny key-value table to avoid hammering the
 * chain with submit attempts every cron tick. The on-chain side
 * would silently skip, but this saves an RPC + signing roundtrip.
 */
async function getLastCaptureDay(env: Env, chainId: number): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT day_index FROM oracle_snapshot_state WHERE chain_id = ?1`,
  )
    .bind(chainId)
    .first<{ day_index: number }>();
  return row?.day_index ?? null;
}

async function setLastCaptureDay(env: Env, chainId: number, dayIndex: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oracle_snapshot_state (chain_id, day_index, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(chain_id) DO UPDATE SET day_index = excluded.day_index, updated_at = excluded.updated_at`,
  )
    .bind(chainId, dayIndex, Date.now())
    .run();
}

async function captureForChain(env: Env, chain: ChainConfig): Promise<void> {
  const todayIndex = Math.floor(Date.now() / 1000 / 86400);
  const lastCapturedDay = await getLastCaptureDay(env, chain.id);
  if (lastCapturedDay === todayIndex) return;

  if (!env.KEEPER_PRIVATE_KEY) {
    // Without a keeper key the worker can't sign — skip silently.
    // A community caller can still fire `captureDailyPriceSnapshot`
    // permissionlessly via Etherscan if they want the day captured.
    return;
  }

  const assets = await fetchTrackedAssets(env, chain.id);
  if (assets.length === 0) return;

  let pk = env.KEEPER_PRIVATE_KEY.trim();
  if (!pk.startsWith('0x')) pk = `0x${pk}`;
  if (pk.length !== 66) {
    console.error('[dailyOracle] KEEPER_PRIVATE_KEY malformed length');
    return;
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const wallet = createWalletClient({ account, transport: http(chain.rpc) });
  const publicClient = createPublicClient({ transport: http(chain.rpc) });

  try {
    const hash = await wallet.writeContract({
      address: chain.diamond as `0x${string}`,
      abi: CAPTURE_ABI,
      functionName: 'captureDailyPriceSnapshot',
      args: [assets],
      account,
      chain: undefined,
    });
    // Wait for inclusion before recording — a stuck or reorg'd tx
    // shouldn't bump the day-state and skip a future retry.
    await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    await setLastCaptureDay(env, chain.id, todayIndex);
    console.log(
      `[dailyOracle] chain=${chain.name} day=${todayIndex} assets=${assets.length} tx=${hash}`,
    );
  } catch (err) {
    console.error(
      `[dailyOracle] chain=${chain.name} err=${String(err).slice(0, 250)}`,
    );
  }
}

/**
 * Top-level entry — invoked from `index.ts:scheduled`. Runs the
 * capture for every tracked chain in parallel; failures are
 * isolated per-chain so one chain's stuck RPC doesn't wedge the
 * rest of the worker tick.
 */
export async function runDailyOracleSnapshot(env: Env): Promise<void> {
  // Tight pre-check: only fire inside the daily-cadence window.
  // The Worker cron runs every minute; we attempt at most ~10
  // ticks per day per chain (00:00–00:09 UTC). After 00:10 we
  // fall through and any community caller can still fire on-chain
  // permissionlessly. The D1-backed `lastCapturedDay` guard means
  // even within the 10-minute window we only submit once.
  const minutesIntoDay = Math.floor((Date.now() / 1000) % 86400 / 60);
  if (minutesIntoDay >= 10) return;

  const chains = getChainConfigs(env);
  await Promise.all(chains.map((chain) => captureForChain(env, chain)));
}
