export interface Env {
  DB: D1Database;

  // Chain RPC URLs — set each via `wrangler secret put RPC_BASE` etc.
  RPC_BASE?: string;
  RPC_ETH?: string;
  RPC_ARB?: string;
  RPC_OP?: string;
  RPC_ZKEVM?: string;
  RPC_BNB?: string;

  // Diamond addresses per chain (vars, not secrets — public info).
  DIAMOND_ADDR_BASE: string;
  DIAMOND_ADDR_ETH: string;
  DIAMOND_ADDR_ARB: string;
  DIAMOND_ADDR_OP: string;
  DIAMOND_ADDR_ZKEVM: string;
  DIAMOND_ADDR_BNB: string;

  // Telegram bot token (secret).
  TG_BOT_TOKEN?: string;

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
  // chain it operates against (`RPC_*` configured + `DIAMOND_ADDR_*`
  // populated). Liquidation is permissionless on-chain — losing the
  // race to another keeper / MEV bot is fine; the diamond reverts
  // the second tx so no double-spend.
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

/** Resolve chain configs from env. Chains with no RPC configured are
 *  filtered out — the watcher skips them this tick. */
export function getChainConfigs(env: Env): ChainConfig[] {
  const all: ChainConfig[] = [
    {
      id: 8453,
      name: 'Base',
      rpc: env.RPC_BASE ?? '',
      diamond: env.DIAMOND_ADDR_BASE,
    },
    {
      id: 1,
      name: 'Ethereum',
      rpc: env.RPC_ETH ?? '',
      diamond: env.DIAMOND_ADDR_ETH,
    },
    {
      id: 42161,
      name: 'Arbitrum',
      rpc: env.RPC_ARB ?? '',
      diamond: env.DIAMOND_ADDR_ARB,
    },
    {
      id: 10,
      name: 'Optimism',
      rpc: env.RPC_OP ?? '',
      diamond: env.DIAMOND_ADDR_OP,
    },
    {
      id: 1101,
      name: 'Polygon zkEVM',
      rpc: env.RPC_ZKEVM ?? '',
      diamond: env.DIAMOND_ADDR_ZKEVM,
    },
    {
      id: 56,
      name: 'BNB Chain',
      rpc: env.RPC_BNB ?? '',
      diamond: env.DIAMOND_ADDR_BNB,
    },
  ];
  return all.filter((c) => c.rpc && c.diamond);
}
