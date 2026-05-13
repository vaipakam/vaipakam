/**
 * apps/keeper — autonomous liquidator pass.
 *
 * Splits the liquidation responsibility out of `runWatcher` (which is
 * now subscription-driven notifications only) into its own
 * comprehensive scan: every cron tick, per chain, **iterate ALL active
 * loans** — not just the subscribed-user subset the notification pass
 * walks — and submit `triggerLiquidation` for every one whose HF has
 * crossed 1.0. Pre-split (before this file), the keeper only ever
 * liquidated loans owned by users who had set up Telegram/Push
 * thresholds; a loan whose owner hadn't subscribed never got an HF
 * check and never got an autonomous liquidation attempt, relying on
 * third-party MEV bots to take the loss-share. That's a real gap as
 * the depth-tiered-LTV ramp raises borrow ceilings — a thinner
 * cushion at liquidation means the Vaipakam keeper needs to be the
 * one that catches every loan, not occasionally.
 *
 * Per tick, per chain:
 *   1. `getActiveLoansCount` (O(1)); short-circuit when zero.
 *   2. Page `getActiveLoansPaginated` for the full loan id list.
 *   3. **Batch-read `calculateHealthFactor` via Multicall3** — one
 *      eth_call per page of ids instead of N sequential eth_calls.
 *      Cuts the per-chain HF scan from `N × RPC_RTT` to one or two
 *      RPC roundtrips even on busy chains.
 *   4. Filter loans with `hf < 1e18` (autonomously liquidatable),
 *      sort ascending by HF — the most at-risk goes first when the
 *      per-tick submit cap is hit, so a thinner cushion still gets
 *      first claim on the keeper's gas budget.
 *   5. Attempt `triggerLiquidation` (via `maybeAutonomousLiquidate`)
 *      up to `MAX_LIQUIDATIONS_PER_TICK`. Losing the race to another
 *      keeper / MEV bot reverts the second tx — fine; the loan is
 *      liquidated either way.
 *
 * Gating: `isKeeperEnabled` only — same as the matcher / liquidity-
 * confidence relay. The watcher's notification pass stays unconditional.
 */

import { createPublicClient, http, type Abi, type Address } from 'viem';
import { MetricsFacetABI, RiskFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { isKeeperEnabled, maybeAutonomousLiquidate, resetKeeperDedupe } from './keeper';

const METRICS_ABI: Abi = MetricsFacetABI as Abi;
const RISK_ABI: Abi = RiskFacetABI as Abi;

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;
/** Multicall batch size for `calculateHealthFactor` reads — keeps each
 *  HTTP body bounded while still folding a busy book into a handful of
 *  RPC roundtrips. */
const HF_MULTICALL_CHUNK = 100;
/** Hard cap on `triggerLiquidation` submissions per tick per chain —
 *  bounds the keeper EOA's gas budget so a sudden cluster of underwater
 *  loans can't burn the whole allowance in one cron pass. */
const MAX_LIQUIDATIONS_PER_TICK = 12;
/** HF below which the loan is autonomously liquidatable on-chain. */
const HF_LIQUIDATION_THRESHOLD = 10n ** 18n;

export async function runLiquidator(env: Env): Promise<void> {
  if (!isKeeperEnabled(env)) return;
  // Reset the in-isolate dedupe set so a previously-attempted loan can
  // be retried this tick. Lived in `runWatcher` pre-split; lives here
  // now because this pass owns the liquidation surface.
  resetKeeperDedupe();
  for (const chain of getChainConfigs(env)) {
    try {
      await liquidatePassForChain(env, chain);
    } catch (err) {
      console.error(
        `[keeper] runLiquidator chain=${chain.name} err=${String(err).slice(0, 250)}`,
      );
    }
  }
}

async function liquidatePassForChain(env: Env, chain: ChainConfig): Promise<void> {
  const client = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;

  let total: bigint;
  try {
    total = (await client.readContract({
      address: diamond,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansCount',
    })) as bigint;
  } catch (err) {
    console.error(
      `[keeper] liquidator chain=${chain.name} getActiveLoansCount failed: ${String(err).slice(0, 200)}`,
    );
    return;
  }
  if (total === 0n) return;

  // Page the loan-id list.
  const ids: bigint[] = [];
  for (let off = 0n; off < total; off += SCAN_PAGE) {
    let page: readonly bigint[];
    try {
      page = (await client.readContract({
        address: diamond,
        abi: METRICS_ABI,
        functionName: 'getActiveLoansPaginated',
        args: [off, SCAN_PAGE],
      })) as readonly bigint[];
    } catch (err) {
      console.error(
        `[keeper] liquidator chain=${chain.name} page off=${off} failed: ${String(err).slice(0, 200)}`,
      );
      break;
    }
    if (page.length === 0) break;
    ids.push(...page);
  }
  if (ids.length === 0) return;

  // Batch-read HF via Multicall3 (deployed at the canonical address on
  // every viem-known chain). Falls back to a serial read if multicall
  // errors so a chain without Multicall3 (rare on production EVM) still
  // gets scanned, just slower.
  const atRisk: { id: bigint; hf: bigint }[] = [];
  for (let i = 0; i < ids.length; i += HF_MULTICALL_CHUNK) {
    const chunk = ids.slice(i, i + HF_MULTICALL_CHUNK);
    const contracts = chunk.map((id) => ({
      address: diamond,
      abi: RISK_ABI,
      functionName: 'calculateHealthFactor' as const,
      args: [id] as const,
    }));
    let results: { status: 'success' | 'failure'; result?: unknown; error?: Error }[];
    try {
      results = (await client.multicall({ contracts, allowFailure: true })) as typeof results;
    } catch (err) {
      console.error(
        `[keeper] liquidator chain=${chain.name} multicall chunk ${i}/${ids.length} failed: ${String(err).slice(0, 200)}`,
      );
      // Fallback: serial reads for this chunk only.
      results = [];
      for (const id of chunk) {
        try {
          const hf = (await client.readContract({
            address: diamond,
            abi: RISK_ABI,
            functionName: 'calculateHealthFactor',
            args: [id],
          })) as bigint;
          results.push({ status: 'success', result: hf });
        } catch (subErr) {
          results.push({ status: 'failure', error: subErr as Error });
        }
      }
    }
    for (let j = 0; j < chunk.length; j++) {
      const r = results[j];
      if (r.status !== 'success' || typeof r.result !== 'bigint') continue;
      const hf = r.result as bigint;
      if (hf < HF_LIQUIDATION_THRESHOLD) atRisk.push({ id: chunk[j], hf });
    }
  }

  if (atRisk.length === 0) return;
  // Lowest HF first — the keeper's gas budget goes to the most-at-risk
  // loans first when the submit cap is hit.
  atRisk.sort((a, b) => (a.hf < b.hf ? -1 : 1));

  let submits = 0;
  for (const r of atRisk) {
    if (submits >= MAX_LIQUIDATIONS_PER_TICK) {
      console.log(
        `[keeper] liquidator chain=${chain.name} submit cap reached (${MAX_LIQUIDATIONS_PER_TICK})`,
      );
      break;
    }
    const submitted = await maybeAutonomousLiquidate(env, chain, r.id, r.hf, client);
    if (submitted) submits += 1;
  }
}
