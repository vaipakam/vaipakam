import { getDeployment } from './deployments';

export interface Env {
  DB: D1Database;

  // Chain RPC URLs — set each via `wrangler secret put RPC_BASE` etc.
  RPC_BASE?: string;
  RPC_ETH?: string;
  RPC_ARB?: string;
  RPC_OP?: string;
  RPC_ZKEVM?: string;
  RPC_BNB?: string;
  // T-031 Layer 4a — buy-watchdog needs to read source-chain adapters
  // on every chain that has a VPFIBuyAdapter deployed (mainnet +
  // testnet lanes). HF-watcher itself only reads the canonical
  // chains; these extra slots are for reconciliation only.
  RPC_POLYGON?: string;
  RPC_SEPOLIA?: string;
  RPC_ARB_SEPOLIA?: string;
  RPC_OP_SEPOLIA?: string;
  RPC_POLYGON_AMOY?: string;
  RPC_BNB_TESTNET?: string;
  RPC_BASE_SEPOLIA?: string;

  // Diamond addresses per chain are NO LONGER env vars. They come from
  // the consolidated `deployments.json` (sibling file in src/), which
  // is regenerated from `contracts/deployments/<chain-slug>/addresses.json`
  // by `contracts/script/exportFrontendDeployments.sh` after every
  // redeploy. Operator workflow: redeploy contracts → run export
  // script → `cd ops/hf-watcher && wrangler deploy`. No wrangler.jsonc
  // edits needed for an address change.

  // Telegram bot token (secret) — issued by @BotFather when the
  // production bot is created. Powers `sendMessage` calls; without
  // this set, the worker rejects /tg/webhook with 503 and the
  // alert-link issuer returns a null bot_url.
  TG_BOT_TOKEN?: string;
  // Telegram bot username (e.g. `VaipakamBot`) — the @-handle the
  // user sees in the deep link `https://t.me/<TG_BOT_USERNAME>?start=<code>`.
  // SEPARATE from `TG_BOT_TOKEN` and from the operator's personal
  // Telegram handle: a Telegram bot is its own account created via
  // @BotFather and has its own username distinct from any human user.
  // When unset, the worker returns `bot_url: null` and the frontend
  // falls back to copy-the-code UX (no broken deep link).
  TG_BOT_USERNAME?: string;

  // Push Protocol channel private key (secret). The channel signs
  // subscriber notifications; loss = impersonation → keep in
  // Cloudflare secret store, never commit.
  PUSH_CHANNEL_PK?: string;

  // Phase 7a — aggregator API keys (secrets). The frontend never
  // sees these; quotes are fetched server-side and the response is
  // proxied through. Without a key set, the matching `/quote/...`
  // route returns 503 so the frontend's other adapter quotes still
  // populate the failover try-list.
  ZEROEX_API_KEY?: string;
  ONEINCH_API_KEY?: string;

  // Phase 8b.2 — Blockaid Transaction Scanner API key (secret).
  // The frontend never sees this; the `/scan/blockaid` route injects
  // it server-side and pass-throughs the response. Without a key set,
  // the route returns 503 and the frontend's preview UI collapses to
  // a subtle "preview-unavailable" state — fail-soft.
  BLOCKAID_API_KEY?: string;

  // Phase 7a.4 — autonomous keeper. When `KEEPER_ENABLED == 'true'`
  // AND `KEEPER_PRIVATE_KEY` is set, the watcher submits
  // `triggerLiquidation` on any subscribed-user loan whose on-chain
  // HF crosses 1.0. The keeper EOA needs gas pre-funded on every
  // chain it operates against — i.e. every chain with both an
  // `RPC_*` env value and a Diamond address recorded in
  // `deployments.json`. Liquidation is permissionless on-chain —
  // losing the race to another keeper / MEV bot is fine; the diamond
  // reverts the second tx so no double-spend.
  KEEPER_ENABLED?: string;
  KEEPER_PRIVATE_KEY?: string;

  // Phase 7a polish — Cloudflare Workers built-in rate-limit
  // bindings (one per upstream aggregator). Default config:
  // 60 reqs / 60 seconds per IP. Configured in wrangler.jsonc;
  // injected as bindings on the env object.
  QUOTE_0X_RATELIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  QUOTE_1INCH_RATELIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  // Phase 8b.2 — separate rate-limit bucket for the Blockaid scan
  // proxy so a noisy /scan/* caller can't drain the /quote/* budget.
  SCAN_BLOCKAID_RATELIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };

  // 2026-05-01 — diagnostics error capture endpoint (POST /diag/record).
  // Per-IP rate-limit binding; same shape as the quote-proxy buckets
  // above. Defaults to 60 req/min per IP — see wrangler.jsonc.
  DIAG_RECORD_RATELIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };

  // 2026-05-01 — diagnostics sample rate (0.0-1.0). When 1.0 (default)
  // the worker writes every accepted POST. Set to e.g. 0.1 to write
  // 10% of accepted POSTs (random sampling) when error volume spikes
  // and you want to keep storage in check without losing all
  // visibility. Coerced from string to float at read time. Out-of-
  // range values clamp to [0, 1].
  DIAG_SAMPLE_RATE?: string;

  // 2026-05-01 — diagnostics retention in days. Cron-driven prune
  // deletes rows older than this many days. Default 90. Coerced from
  // string to int; values < 1 are clamped up to 1.
  DIAG_RETENTION_DAYS?: string;

  // CORS origin the HTTP endpoints will accept. Set to the frontend
  // origin(s); defaults to the vars entry in wrangler.jsonc.
  FRONTEND_ORIGIN: string;
}

export interface ChainConfig {
  id: number;
  name: string;
  rpc: string;
  diamond: string;
}

/** Resolve chain configs from env + the consolidated deployments JSON.
 *  Chains with no RPC configured OR no Diamond deployment recorded are
 *  filtered out — the watcher skips them this tick. The Diamond address
 *  comes from `deployments.json` (auto-populated post-deploy); the RPC
 *  URL stays env-driven because it carries an operator-specific API key
 *  that must remain a Worker secret. */
export function getChainConfigs(env: Env): ChainConfig[] {
  // Static chain metadata — chainId + display name are stable across
  // deploys, so they live alongside the env-key mapping rather than in
  // the deployments JSON. Adding a chain = one entry here, no JSON
  // schema change.
  const meta: { id: number; name: string; rpc: string | undefined }[] = [
    // Mainnets — included once deployments + RPC envs are configured.
    { id: 8453, name: 'Base', rpc: env.RPC_BASE },
    { id: 1, name: 'Ethereum', rpc: env.RPC_ETH },
    { id: 42161, name: 'Arbitrum', rpc: env.RPC_ARB },
    { id: 10, name: 'Optimism', rpc: env.RPC_OP },
    { id: 1101, name: 'Polygon zkEVM', rpc: env.RPC_ZKEVM },
    { id: 56, name: 'BNB Chain', rpc: env.RPC_BNB },
    // Testnets — pre-mainnet phase indexes these too. `getDeployment`
    // filters out any chain without a deployments.json entry, so adding
    // a testnet here is free until both the deployment artifact and the
    // matching RPC secret land.
    { id: 84532, name: 'Base Sepolia', rpc: env.RPC_BASE_SEPOLIA },
    { id: 11155111, name: 'Sepolia', rpc: env.RPC_SEPOLIA },
    { id: 421614, name: 'Arbitrum Sepolia', rpc: env.RPC_ARB_SEPOLIA },
    { id: 11155420, name: 'Optimism Sepolia', rpc: env.RPC_OP_SEPOLIA },
    { id: 80002, name: 'Polygon Amoy', rpc: env.RPC_POLYGON_AMOY },
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
