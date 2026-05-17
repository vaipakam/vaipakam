import { getDeployment } from '@vaipakam/contracts/deployments';

/**
 * Typed env bindings for the apps/agent Worker.
 *
 * Stage 3 PR4 of the Worker split (see
 * `docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`). Agent inherits
 * the broadest env shape of the three Workers because it owns the
 * most concerns — proactive notifications + cross-chain monitoring +
 * operator services + public Frames + Telegram bot + diagnostics
 * record. What it does NOT own:
 *
 *   - HF watcher loop / autonomous liquidation         → apps/keeper
 *   - chain-event scan / D1 indexer / public read-API  → apps/indexer
 *
 * Bindings:
 *
 *   - `DB`                 — D1 binding (handshake codes,
 *                            thresholds, diagnostics records,
 *                            cross-Worker reads of indexer's loan
 *                            tables for periodic-pre-notify scans).
 *   - `RPC_*`              — per-chain RPC URLs. Buy-watchdog needs
 *                            EVERY chain that has a VPFIBuyAdapter
 *                            deployed (mainnet + testnet) for
 *                            cross-chain reconciliation, so this is
 *                            the broadest RPC set of the three
 *                            Workers (includes POLYGON + POLYGON_AMOY
 *                            + every other chain, including the
 *                            Polygon zkEVM).
 *   - `TG_BOT_*`           — Telegram bot token + username. Powers
 *                            the `/tg/webhook` handshake AND the
 *                            outbound notifications dispatched by
 *                            `periodicPreNotify` and
 *                            `buyWatchdog`.
 *   - `PUSH_CHANNEL_PK`    — Push channel signer. Same usage shape
 *                            — outbound notifications from the
 *                            three crons.
 *   - `ZEROEX_API_KEY` /
 *     `ONEINCH_API_KEY`    — server-side aggregator API keys for
 *                            the public `/quote/*` proxy endpoints.
 *                            Same secrets the keeper uses for
 *                            server-side liquidation quoting.
 *   - `BLOCKAID_API_KEY`   — Blockaid Transaction Scanner API key
 *                            for the `/scan/blockaid` proxy.
 *   - (no signing-key consumer here any more — `KEEPER_PRIVATE_KEY`
 *      moved to apps/keeper alongside `runDailyOracleSnapshot`
 *      in the Stage 3 architectural-rebalance commit. The
 *      least-privilege contract from staging plan §2: agent
 *      holds NEITHER `KEEPER_PRIVATE_KEY` NOR per-chain on-chain
 *      write access. A compromised agent produces stale
 *      notifications but can't move funds.)
 *   - `QUOTE_0X_RATELIMIT`,
 *     `QUOTE_1INCH_RATELIMIT`,
 *     `SCAN_BLOCKAID_RATELIMIT`,
 *     `DIAG_RECORD_RATELIMIT` — Cloudflare built-in rate-limit
 *                            bindings (one per upstream service).
 *                            Configured in wrangler.jsonc.
 *   - `DIAG_SAMPLE_RATE`,
 *     `DIAG_RETENTION_DAYS` — diagnostics record sampling +
 *                            retention.
 *   - `DIAG_WALLET_HMAC_KEY` — T-075 secret keying the per-wallet
 *                            deletion hash. Set via
 *                            `wrangler secret put`. The
 *                            `/diag/legal-hold` endpoint has no
 *                            secret of its own — it authenticates
 *                            the caller by an on-chain `ADMIN_ROLE`
 *                            check (see `diagAdminAuth.ts`).
 *   - `DIAG_LEGAL_DOCS`    — T-075 private R2 bucket storing the
 *                            legal documents uploaded with a hold.
 *                            Configured in wrangler.jsonc.
 *   - `FRONTEND_ORIGIN`    — CSV of allowed CORS origins for the
 *                            frontend-facing endpoints
 *                            (`/thresholds`, `/link/telegram`,
 *                            `/diag/record`). Frames + quote +
 *                            scan endpoints have their own CORS
 *                            policy (open / aggregator-paired).
 *
 * Diamond addresses come from `@vaipakam/contracts/deployments` —
 * the same artifact apps/{indexer,keeper} read.
 */
export interface Env {
  DB: D1Database;

  // Per-chain RPC URLs — buy-watchdog needs every chain with a
  // VPFIBuyAdapter; periodicPreNotify needs every Diamond chain;
  // dailyOracleSnapshot needs every Diamond chain. Most expansive
  // RPC set of the three Workers.
  RPC_BASE?: string;
  RPC_ETH?: string;
  RPC_ARB?: string;
  RPC_OP?: string;
  RPC_ZKEVM?: string;
  RPC_BNB?: string;
  RPC_POLYGON?: string;
  RPC_SEPOLIA?: string;
  RPC_BASE_SEPOLIA?: string;
  RPC_ARB_SEPOLIA?: string;
  RPC_OP_SEPOLIA?: string;
  RPC_POLYGON_AMOY?: string;
  RPC_BNB_TESTNET?: string;

  // Telegram (handshake + outbound notifications).
  TG_BOT_TOKEN?: string;
  TG_BOT_USERNAME?: string;

  // Push Protocol channel signer.
  PUSH_CHANNEL_PK?: string;

  // Aggregator API keys for the public `/quote/*` proxies.
  ZEROEX_API_KEY?: string;
  ONEINCH_API_KEY?: string;

  // Blockaid scan proxy.
  BLOCKAID_API_KEY?: string;

  // (No signing-key field — Stage 3 architectural-rebalance moved
  // `KEEPER_PRIVATE_KEY` + `runDailyOracleSnapshot` to apps/keeper
  // so the only Worker that holds the signer is the keeper.)

  // Cloudflare built-in rate-limit bindings — one per upstream
  // service so a noisy caller on /quote/0x can't drain the
  // /scan/blockaid budget. 60 reqs / 60 seconds per IP by default;
  // configured in wrangler.jsonc.
  QUOTE_0X_RATELIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  QUOTE_1INCH_RATELIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  SCAN_BLOCKAID_RATELIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  DIAG_RECORD_RATELIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };

  // Diagnostics sampling (0.0–1.0; default 1.0 = write every accepted POST).
  // Coerced from string to float at read time. Out-of-range values
  // clamp to [0, 1].
  DIAG_SAMPLE_RATE?: string;

  // Diagnostics retention (days; default 90). Coerced from string
  // to int; values < 1 are clamped up to 1.
  DIAG_RETENTION_DAYS?: string;

  // T-075 — server secret for the per-wallet deletion key.
  // `wallet_hash = HMAC-SHA256(fullWallet, DIAG_WALLET_HMAC_KEY)`.
  // A SECRET (set via `wrangler secret put`), never a `var` — if it
  // leaked, the keyed hash would collapse to a reversible unkeyed
  // hash of a public address. When unset: connected-wallet capture
  // skips the write rather than creating a fresh non-erasable row;
  // not-connected rows may still store NULL `wallet_hash`; and the
  // erasure / status endpoints return 503.
  DIAG_WALLET_HMAC_KEY?: string;

  // T-075 — private R2 bucket holding the legal documents uploaded
  // when a protocol admin places a hold (the e-signed order /
  // scanned letter). Content-addressed by SHA-256. Optional: when
  // the binding is absent the legal-hold endpoint returns 503 for
  // any action that carries a document.
  DIAG_LEGAL_DOCS?: R2Bucket;

  // (T-075 — the `POST /diag/legal-hold` endpoint has NO env secret.
  // It authenticates the caller by recovering the request signature
  // and checking the signer holds the on-chain `ADMIN_ROLE` on the
  // Diamond — see `diagAdminAuth.ts`. The contract's access-control
  // state is the source of truth; there is no admin list or shared
  // token in this Worker's env.)

  // CSV of allowed CORS origins for the frontend-facing endpoints
  // (`/thresholds`, `/link/telegram`, `/diag/record`). Set in
  // wrangler.jsonc:vars.
  FRONTEND_ORIGIN: string;
}

export interface ChainConfig {
  id: number;
  name: string;
  rpc: string;
  diamond: string;
}

/**
 * Resolve chain configs from env + the consolidated deployments
 * JSON. Same shape as apps/{keeper,indexer} versions — the meta
 * table here matches the agent's RPC-set superset (every chain
 * with a Diamond OR a VPFIBuyAdapter).
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
    { id: 137, name: 'Polygon', rpc: env.RPC_POLYGON },
    // Testnets.
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
