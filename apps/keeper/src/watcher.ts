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

async function watchChain(env: Env, chain: ChainConfig): Promise<void> {
  const users = await listThresholdsForChain(env.DB, chain.id);
  if (users.length === 0) return;

  const client = createPublicClient({
    transport: http(chain.rpc),
  });
  const diamond = chain.diamond as Address;

  for (const user of users) {
    try {
      const active = (await client.readContract({
        address: diamond,
        abi: DIAMOND_LOANS_ABI,
        functionName: 'getUserActiveLoans',
        args: [user.wallet as Address],
      })) as readonly bigint[];

      for (const loanIdBig of active) {
        const loanId = Number(loanIdBig);
        try {
          const hfRaw = (await client.readContract({
            address: diamond,
            abi: DIAMOND_RISK_ABI,
            functionName: 'calculateHealthFactor',
            args: [loanIdBig],
          })) as bigint;
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
        } catch (err) {
          console.error(
            `[watcher] loan=${loanId} chain=${chain.name} err=${String(err).slice(0, 200)}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[watcher] user=${user.wallet} chain=${chain.name} err=${String(err).slice(0, 200)}`,
      );
    }
  }
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
