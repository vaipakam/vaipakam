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
