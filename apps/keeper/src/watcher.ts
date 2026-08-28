/**
 * Core watch loop: for each chain with RPC + Diamond configured, iterate
 * every user with thresholds, read HF for each of their active loans,
 * compare to thresholds, dispatch alerts on band-downgrade.
 *
 * Designed to be idempotent — re-running against the same on-chain state
 * (e.g. a cron over-fire or manual debug run) does NOT re-send alerts.
 * Alert fires only when `band < last_band` (user is in a worse state than
 * they were last tick). Recovery transitions are no-ops by default.
 *
 * Scope: subscription-driven NOTIFICATIONS only. The autonomous-
 * liquidation pass moved out into `liquidator.ts` so it can scan
 * **every** active loan on-chain (not just the subscribed-user subset
 * this pass walks) and batch-read HF via Multicall3 — a real coverage
 * + speed win the higher-LTV regime needs. See that file's header.
 */

import { createPublicClient, http, type Address } from 'viem';
import { MetricsFacetABI, RiskFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig } from './env';
import type { Env } from './env';
import { getChainConfigs } from './env';
import { MULTICALL3_ADDRESS } from './multicall3';
import {
  type Band,
  type UserThresholds,
  getNotifyState,
  listThresholdsForChain,
  putNotifyState,
  sweepExpiredLinks,
} from './db';
import { sendMessage } from './telegram';
import { sendPush } from './push';
import { formatAlert, pushTitle } from './i18n';

// Diamond ABIs sourced from `@vaipakam/contracts/abis` — same per-facet
// JSONs the indexer Worker imports. Drops the hand-typed parseAbi
// strings whose `getActiveLoansByUser` typo (the actual selector is
// `getUserActiveLoans` on MetricsFacet) silently reverted every
// watcher tick before this sync. The compiled-bytecode ABI makes a
// future typo a compile-time failure.
const DIAMOND_LOANS_ABI = MetricsFacetABI;
const DIAMOND_RISK_ABI = RiskFacetABI;

function classifyBand(hf: number, t: UserThresholds): Band {
  if (hf <= t.critical_hf) return 'critical';
  if (hf <= t.alert_hf) return 'alert';
  if (hf <= t.warn_hf) return 'warn';
  return 'healthy';
}

const BAND_RANK: Record<Band, number> = {
  healthy: 0,
  warn: 1,
  alert: 2,
  critical: 3,
};

export async function runWatcher(env: Env): Promise<void> {
  // Sweep expired handshake codes first so the table stays bounded.
  await sweepExpiredLinks(env.DB);

  const chains = getChainConfigs(env);
  if (chains.length === 0) {
    console.log('[watcher] no chains configured — nothing to do');
    return;
  }

  for (const chain of chains) {
    try {
      await watchChain(env, chain);
    } catch (err) {
      // Keep the loop going — one bad RPC shouldn't kill the whole tick.
      console.error(
        `[watcher] chain=${chain.name} id=${chain.id} err=${String(err).slice(0, 300)}`,
      );
    }
  }
}

/** Loans per `aggregate3`. Matches the liquidator's bound (#1946). */
const HF_MULTICALL_CHUNK = 100;

async function watchChain(env: Env, chain: ChainConfig): Promise<void> {
  const users = await listThresholdsForChain(env.DB, chain.id);
  if (users.length === 0) return;

  const client = createPublicClient({
    transport: http(chain.rpc),
  });
  const diamond = chain.diamond as Address;

  // BATCHED, not per-user and per-loan (#1896). This loop used to issue one
  // `getUserActiveLoans` per subscriber and then one `calculateHealthFactor`
  // per loan, sequentially: with 20 subscribers holding 25 loans each, that is
  // 20 + 500 = 520 subrequests PER CHAIN, against a 50-per-invocation ceiling
  // and a 10 ms CPU budget. The #1945 harness measured it as the single largest
  // consumer in the pass table, and the arithmetic is the same shape the
  // liquidator had before #1946 — except the liquidator at least intended to
  // batch. This one never did.
  //
  // Two multicalls replace both loops: one for the loan lists, then chunked
  // ones for every health factor across every user. 520 calls become ~7.
  const listResults = await batchedRead(
    client,
    users.map((u) => ({
      address: diamond,
      abi: DIAMOND_LOANS_ABI,
      functionName: 'getUserActiveLoans' as const,
      args: [u.wallet as Address] as const,
    })),
    `${chain.name} getUserActiveLoans`,
  );

  // Flatten to (user, loanId) pairs, preserving per-user failure isolation:
  // a user whose list read failed is logged and skipped, exactly as the old
  // per-user catch did, rather than aborting the chain.
  const pairs: { user: UserThresholds; loanId: bigint }[] = [];
  users.forEach((user, i) => {
    const r = listResults[i];
    if (!r || r.status !== 'success') {
      console.error(
        `[watcher] user=${user.wallet} chain=${chain.name} list read failed: ${String(
          r?.error ?? 'no result',
        ).slice(0, 200)}`,
      );
      return;
    }
    for (const loanIdBig of (r.result ?? []) as readonly bigint[]) {
      pairs.push({ user, loanId: loanIdBig });
    }
  });
  if (pairs.length === 0) return;

  const hfResults: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[] = [];
  for (let i = 0; i < pairs.length; i += HF_MULTICALL_CHUNK) {
    const chunk = pairs.slice(i, i + HF_MULTICALL_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const part = await batchedRead(
      client,
      chunk.map((p) => ({
        address: diamond,
        abi: DIAMOND_RISK_ABI,
        functionName: 'calculateHealthFactor' as const,
        args: [p.loanId] as const,
      })),
      `${chain.name} calculateHealthFactor ${i}/${pairs.length}`,
    );
    hfResults.push(...part);
  }

  for (let i = 0; i < pairs.length; i += 1) {
    const { user, loanId: loanIdBig } = pairs[i];
    const loanId = Number(loanIdBig);
    {
      try {
        const hfRes = hfResults[i];
        if (!hfRes || hfRes.status !== 'success') {
          throw new Error(String(hfRes?.error ?? 'no result'));
        }
        {
          const hfRaw = hfRes.result as bigint;
          const hf = Number(hfRaw) / 1e18;
          const band = classifyBand(hf, user);
          const prev = await getNotifyState(env.DB, user.wallet, chain.id, loanId);

          // Alert only on transition to a worse band. Hysteresis is
          // built-in: recovering to healthy updates last_band but does
          // NOT alert, so toggling around a threshold doesn't storm.
          if (BAND_RANK[band] > BAND_RANK[prev.last_band]) {
            await dispatchAlert(env, user, chain, loanId, hf, band);
          }

          // (Autonomous liquidation moved to `runLiquidator` — its
          // own cron pass that scans ALL active loans on-chain, not
          // just this subscribed-user subset.)

          await putNotifyState(env.DB, {
            wallet: user.wallet,
            chain_id: chain.id,
            loan_id: loanId,
            last_band: band,
            last_hf_milli: Math.round(hf * 1000),
            last_sent_ts: Math.floor(Date.now() / 1000),
          });
        }
      } catch (err) {
        console.error(
          `[watcher] loan=${loanId} chain=${chain.name} err=${String(err).slice(0, 200)}`,
        );
      }
    }
  }
}

/**
 * One `aggregate3` for a set of reads, falling back to serial reads per entry.
 *
 * The fallback is the dangerous part and the reason this is a named helper
 * rather than an inline try/catch: a chainless client makes `multicall()` throw
 * LOCALLY, every time, so a swallowed error means the batching silently never
 * happens and the pass still completes normally. That is exactly how the
 * liquidator's batching went unnoticed until #1946. `multicallAddress` is what
 * prevents it; the fallback exists only for a chain genuinely missing
 * Multicall3.
 */
async function batchedRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
  label: string,
): Promise<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }[]> {
  if (contracts.length === 0) return [];
  try {
    const results = (await client.multicall({
      contracts: contracts as never,
      allowFailure: true,
      // REQUIRED — see src/multicall3.ts (#1946).
      multicallAddress: MULTICALL3_ADDRESS,
      // Disable viem's byte-size re-split (1024 B default), which would turn
      // one bounded chunk back into several requests (#1965 r2).
      batchSize: 0,
    })) as { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];

    // A REJECTED aggregate3 does not throw. With `allowFailure: true` viem
    // catches the chunk-level RPC error and hands back one `failure` per
    // contract carrying the SAME error object — so the `catch` below never
    // runs and every entry silently reads as unevaluated. Verified against the
    // installed viem: a chunk-level error returns `["failure"]`, it does not
    // throw. This is the liquidator's #1965 finding, and the watcher's
    // fallback would have been dead code without it.
    //
    // `batchSize: 0` means one batch per call, so "every result failed AND
    // they share one error object identity" is exactly the aggregate-level
    // case; per-entry reverts carry their own decoded errors.
    const aggregateFailed =
      results.length > 0 &&
      results.every(
        (r) => r.status === 'failure' && r.error === results[0].error && r.error !== undefined,
      );
    if (aggregateFailed) {
      console.error(
        `[watcher] ${label} aggregate3 rejected: ${String(results[0].error).slice(0, 200)} — retrying serially`,
      );
      return serialRead(client, contracts);
    }
    return results;
  } catch (err) {
    console.error(
      `[watcher] ${label} multicall failed, falling back to serial: ${String(err).slice(0, 200)}`,
    );
    return serialRead(client, contracts);
  }
}

/** One read per contract — the degraded path, kept out of `batchedRead` so both entries share it. */
async function serialRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
): Promise<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }[]> {
  const out: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[] = [];
  for (const c of contracts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      out.push({ status: 'success', result: await client.readContract(c as never) });
    } catch (e) {
      out.push({ status: 'failure', error: e });
    }
  }
  return out;
}

async function dispatchAlert(
  env: Env,
  user: UserThresholds,
  chain: ChainConfig,
  loanId: number,
  hf: number,
  band: Band,
): Promise<void> {
  if (band === 'healthy') return;

  // Stage 4 PR3 flattened the connected-app routes to root, so
  // notification deep links use `/loans/{id}` (no `/app/` prefix).
  // FRONTEND_ORIGIN is optional in this slim env — default to empty
  // when unset so the alert text still renders (same fallback the
  // ops/hf-watcher monolith used implicitly via its `string` typing).
  const frontendOrigin = env.FRONTEND_ORIGIN ?? '';

  const text = formatAlert(band, user.locale, {
    chainName: chain.name,
    loanId,
    hf,
    frontendOrigin,
  });

  if (user.tg_chat_id && env.TG_BOT_TOKEN) {
    await sendMessage(env.TG_BOT_TOKEN, user.tg_chat_id, text);
  }
  if (user.push_channel) {
    await sendPush(env.PUSH_CHANNEL_PK, {
      subscriber: user.wallet,
      title: pushTitle(band, user.locale),
      body: text,
      deepLinkUrl: `${frontendOrigin}/loans/${loanId}`,
    });
  }
}
