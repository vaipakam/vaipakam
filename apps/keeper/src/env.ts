import { getDeployment } from '@vaipakam/contracts/deployments';

/**
 * Typed env bindings for the apps/keeper Worker.
 *
 * Slimmed from the ops/hf-watcher monolith env so this Worker only
 * sees what it actually needs. Stage 3 PR2 of the Worker split
 * (see `docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`) splits the
 * keeper-only bindings out from the indexer / agent surfaces:
 *
 *   - `DB`               — D1 binding (thresholds + notify_state +
 *                          handshake codes; the keeper writes
 *                          notify_state and reads thresholds + codes)
 *   - `RPC_*`            — per-chain RPC URLs for HF reads + on-chain
 *                          liquidation submission (canonical chains
 *                          only; Polygon / Polygon-Amoy live on the
 *                          agent worker since they're buy-watchdog-only)
 *   - `TG_BOT_*`         — HF-band-downgrade Telegram alerts
 *   - `PUSH_CHANNEL_PK`  — Push channel signer for HF alerts
 *   - `ZEROEX_API_KEY` /
 *     `ONEINCH_API_KEY`  — server-side liquidation quotes (consumed
 *                          by `serverQuotes.ts` when the keeper packs
 *                          `triggerLiquidation` calls)
 *   - `KEEPER_*`         — autonomous keeper EOA secret + enable flag
 *
 * What's deliberately NOT here (lives on `apps/{indexer,agent}`):
 *   - QUOTE_0X_RATELIMIT / QUOTE_1INCH_RATELIMIT / SCAN_BLOCKAID_RATELIMIT
 *     / DIAG_RECORD_RATELIMIT — agent (HTTP rate-limit buckets)
 *   - DIAG_SAMPLE_RATE / DIAG_RETENTION_DAYS — agent
 *   - CANCELLED_OFFER_RETENTION_DAYS         — indexer
 *   - FRONTEND_ORIGIN                        — keeper has no fetch()
 *                                              handler, no CORS surface
 *   - RPC_POLYGON / RPC_POLYGON_AMOY         — agent (buy-watchdog only)
 *
 * Diamond addresses come from `@vaipakam/contracts/deployments` (the
 * consolidated `deployments.json` exported by
 * `contracts/script/exportFrontendDeployments.sh`). Same artifact the
 * frontend reads — operator workflow stays "redeploy contracts → run
 * export script → wrangler deploy" for the keeper too.
 */
export interface Env {
  DB: D1Database;

  // Per-chain RPC URLs — HF reads + liquidation submission. Each
  // missing URL skips that chain this tick.
  RPC_BASE?: string;
  RPC_ETH?: string;
  RPC_ARB?: string;
  RPC_OP?: string;
  RPC_ZKEVM?: string;
  RPC_BNB?: string;
  RPC_SEPOLIA?: string;
  RPC_BASE_SEPOLIA?: string;
  RPC_ARB_SEPOLIA?: string;
  RPC_OP_SEPOLIA?: string;
  RPC_BNB_TESTNET?: string;

  // Telegram bot (secrets via wrangler). Powers HF-band-downgrade
  // alerts dispatched by watcher.ts. Without TG_BOT_TOKEN the
  // sendMessage helper is a no-op; without TG_BOT_USERNAME the
  // handshake link returns null bot_url.
  TG_BOT_TOKEN?: string;
  TG_BOT_USERNAME?: string;

  // Push Protocol channel signer (secret). Same usage shape as
  // TG_BOT_TOKEN — drives the parallel push-channel alert path.
  PUSH_CHANNEL_PK?: string;

  // Phase 7a — aggregator API keys for server-side liquidation
  // quoting. The keeper bypasses the public quote-proxy and hits
  // 0x / 1inch directly with these keys. Without a key the
  // matching adapter is skipped in the failover try-list.
  ZEROEX_API_KEY?: string;
  ONEINCH_API_KEY?: string;

  // Connected-app origin for deep-links inside push / Telegram
  // notifications (e.g. "View this loan" → `<FRONTEND_ORIGIN>/loans/{id}`).
  // Stage 4 PR3 flattened the connected-app routes to root, so the
  // path inside notifications is `/loans/...` (no `/app/` prefix).
  // Defaults to `https://defi.vaipakam.com` when set in wrangler vars.
  FRONTEND_ORIGIN?: string;

  // Phase 7a.4 — autonomous keeper. When `KEEPER_ENABLED == 'true'`
  // AND `KEEPER_PRIVATE_KEY` is set, the watcher submits
  // `triggerLiquidation` for any subscribed-user loan whose on-chain
  // HF crosses 1.0. The keeper EOA needs gas pre-funded on every
  // chain it operates against — i.e. every chain with both an
  // `RPC_*` env value AND a Diamond address recorded in
  // `deployments.json`. Liquidation is permissionless on-chain —
  // losing the race to another keeper / MEV bot is fine; the diamond
  // reverts the second tx so no double-spend.
  KEEPER_ENABLED?: string;
  KEEPER_PRIVATE_KEY?: string;

  // Depth-tiered-LTV liquidity-confidence relay (`liquidityConfidence.ts`,
  // §4.4 step 5). The off-chain process knobs — how much aggregator-
  // confirmed evidence must accumulate before the relay promotes an
  // asset's on-chain `keeperTier` one step. Both default conservatively
  // when unset; demotion is always immediate (no window) regardless.
  // The relay only *submits* `setKeeperTier` when the keeper is enabled
  // AND `depthTieredLtvEnabled` is on for the chain — it tracks the
  // confidence counter in D1 either way so it catches up fast once
  // governance flips the switch. (Wiring the Tier-3 "battle-tested on
  // Aave/Compound/Morpho" advisory is a follow-up — until then the relay
  // caps at Tier 2.)
  /** consecutive eligible-to-promote ticks required before a step up (default 5) */
  LIQ_CONFIDENCE_MIN_CHECKS?: string;
  /** wall-clock days that eligible streak must also span (default 3) */
  LIQ_CONFIDENCE_MIN_WINDOW_DAYS?: string;
  // Tier-3 "battle-tested elsewhere" advisory — 2-of-3 ensemble in
  // `liquidityConfidence.ts::battleTestedElsewhere`. The relay promotes
  // an asset to Tier 3 only when ≥ 2 of the 3 signals below pass; the
  // ensemble means no single source can single-handedly gate (or be
  // dependent for) the promotion. All thresholds in plain USD (not the
  // PAD × 1e6 scale the on-chain sizes use). All optional with sensible
  // defaults; setting any to a custom value tunes that threshold.
  /** Signal ① — Minimum USD TVL on at least one of {Aave v3, Compound v3,
   *  Morpho-blue} (per DeFiLlama's `/pools`). Default $10M. */
  LIQ_TIER3_MIN_TVL_USD?: string;
  /** Disable signal ① entirely (`1` / `true`) — for operators who want
   *  zero competitor-lending-platform-data dependence. When disabled
   *  the ensemble becomes 2-of-2 (both CoinGecko signals required) —
   *  stricter, safe. Default off (signal ① active). */
  LIQ_TIER3_DISABLE_DEFI_LISTING?: string;
  /** Signal ② — Minimum USD circulating market cap from CoinGecko's
   *  free `/coins/{platform}/contract/{address}` endpoint. Default $1B. */
  LIQ_TIER3_MIN_MCAP_USD?: string;
  /** Signal ③ — Minimum USD 24-hour trading volume (CoinGecko, same
   *  response as ②). Default $50M/day. */
  LIQ_TIER3_MIN_VOL_USD?: string;
}

export interface ChainConfig {
  id: number;
  name: string;
  rpc: string;
  diamond: string;
}

/**
 * Resolve chain configs from env + the consolidated deployments
 * JSON imported via `@vaipakam/contracts/deployments`. Chains with
 * no RPC configured OR no Diamond deployment recorded are filtered
 * out — the watcher skips them this tick.
 *
 * Adding a chain = one entry here + matching RPC secret +
 * `contracts/deployments/<slug>/addresses.json` regenerated by the
 * post-deploy export script. No JSON schema change.
 */
export function getChainConfigs(env: Env): ChainConfig[] {
  const meta: { id: number; name: string; rpc: string | undefined }[] = [
    // Mainnets — included once both the deployment artifact and the
    // matching RPC secret land.
    { id: 8453, name: 'Base', rpc: env.RPC_BASE },
    { id: 1, name: 'Ethereum', rpc: env.RPC_ETH },
    { id: 42161, name: 'Arbitrum', rpc: env.RPC_ARB },
    { id: 10, name: 'Optimism', rpc: env.RPC_OP },
    { id: 1101, name: 'Polygon zkEVM', rpc: env.RPC_ZKEVM },
    { id: 56, name: 'BNB Chain', rpc: env.RPC_BNB },
    // Testnets — pre-mainnet phase indexes these too.
    { id: 84532, name: 'Base Sepolia', rpc: env.RPC_BASE_SEPOLIA },
    { id: 11155111, name: 'Sepolia', rpc: env.RPC_SEPOLIA },
    { id: 421614, name: 'Arbitrum Sepolia', rpc: env.RPC_ARB_SEPOLIA },
    { id: 11155420, name: 'Optimism Sepolia', rpc: env.RPC_OP_SEPOLIA },
    { id: 97, name: 'BNB Testnet', rpc: env.RPC_BNB_TESTNET },
  ];
  const out: ChainConfig[] = [];
  for (const m of meta) {
    if (!m.rpc) continue;
    const dep = getDeployment(m.id);
    if (!dep) continue;
    out.push({
      id: m.id,
      name: m.name,
      rpc: m.rpc,
      diamond: dep.diamond,
    });
  }
  return out;
}
