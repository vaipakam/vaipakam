/**
 * Core watch loop: for each chain with RPC + Diamond configured, iterate
 * every user with thresholds, read HF for each of their active loans,
 * compare to thresholds, dispatch alerts on band-downgrade.
 *
 * Designed to be idempotent — re-running against the same on-chain state
 * (e.g. a cron over-fire or manual debug run) does NOT re-send alerts.
 * Alert fires only when `band < last_band` (user is in a worse state than
 * they were last tick). Recovery transitions are no-ops by default.
 */

import { createPublicClient, http, parseAbi, type Address } from 'viem';
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
import { formatAlert, sendMessage } from './telegram';
import { sendPush } from './push';

// ABI stubs — just enough to read the loan list + HF. Narrow slice keeps
// the worker bundle small.
const DIAMOND_READ_ABI = parseAbi([
  'function getActiveLoansByUser(address user) view returns (uint256[] memory)',
  'function calculateHealthFactor(uint256 loanId) view returns (uint256)',
]);

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
        abi: DIAMOND_READ_ABI,
        functionName: 'getActiveLoansByUser',
        args: [user.wallet as Address],
      })) as readonly bigint[];

      for (const loanIdBig of active) {
        const loanId = Number(loanIdBig);
        try {
          const hfRaw = (await client.readContract({
            address: diamond,
            abi: DIAMOND_READ_ABI,
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

  const text = formatAlert(band, {
    chainName: chain.name,
    loanId,
    hf,
    frontendOrigin: env.FRONTEND_ORIGIN,
  });

  if (user.tg_chat_id && env.TG_BOT_TOKEN) {
    await sendMessage(env.TG_BOT_TOKEN, user.tg_chat_id, text);
  }
  if (user.push_channel) {
    await sendPush(env.PUSH_CHANNEL_PK, {
      subscriber: user.wallet,
      title: band === 'critical' ? 'Vaipakam liquidation imminent' : 'Vaipakam HF alert',
      body: text,
      deepLinkUrl: `${env.FRONTEND_ORIGIN}/app/loans/${loanId}`,
    });
  }
}
