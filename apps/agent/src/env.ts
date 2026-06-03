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
 * T-078 — the secrets (per-chain RPC URLs, the Telegram bot token,
 * the Push channel signer, the aggregator API keys and the T-075
 * wallet-HMAC key) moved from per-Worker
 * `wrangler secret put` strings to the account-level Cloudflare
 * Secrets Store (`docs/DesignsAndPlans/SecretsStoreMigration.md`).
 * A Secrets Store binding is read **asynchronously**
 * (`await binding.get()`), so there are two env shapes:
 *
 *   - `WorkerEnv` — the RAW Cloudflare bindings the Worker handler
 *     receives. The secret fields are Secrets Store bindings; the
 *     D1 / R2 / rate-limit / plain-config fields are passed through.
 *   - `Env` — the RESOLVED env passed to every downstream function:
 *     every secret field is a plain string, exactly as before T-078.
 *
 * `resolveEnv()` bridges them — called **once** at the Worker entry
 * point (`index.ts`), at the top of BOTH `scheduled` and `fetch`;
 * all downstream code keeps taking the plain `Env` and stays
 * synchronous. This is the "resolve at the boundary" containment
 * pattern from `SecretsStoreMigration.md` §6.
 *
 * Bindings:
 *
 *   - `DB`                 — D1 binding (handshake codes,
 *                            thresholds, diagnostics records,
 *                            cross-Worker reads of indexer's loan
 *                            tables for periodic-pre-notify scans).
 *                            Native binding — not a secret.
 *   - `RPC_*`              — per-chain RPC URLs. Buy-watchdog needs
 *                            EVERY chain that has a VPFIBuyAdapter
 *                            deployed (mainnet + testnet) for
 *                            cross-chain reconciliation, so this is
 *                            the broadest RPC set of the three
 *                            Workers (includes POLYGON + POLYGON_AMOY
 *                            — agent-only — plus every other chain).
 *                            Secrets Store bindings (T-078).
 *   - `TG_BOT_TOKEN`       — Telegram bot token. Powers the
 *                            `/tg/webhook` handshake AND the outbound
 *                            notifications dispatched by
 *                            `periodicPreNotify` and `buyWatchdog`.
 *                            Secrets Store binding (T-078).
 *   - `TG_BOT_USERNAME`    — public Telegram bot handle. A plain
 *                            `var` — not a secret.
 *   - `PUSH_CHANNEL_PK`    — Push channel signer. Outbound
 *                            notifications from the crons. Secrets
 *                            Store binding (T-078).
 *   - `ZEROEX_API_KEY` /
 *     `ONEINCH_API_KEY`    — server-side aggregator API keys for the
 *                            public `/quote/*` proxy endpoints.
 *                            Secrets Store bindings (T-078).
 *   - `DIAG_WALLET_HMAC_KEY` — T-075 secret keying the per-wallet
 *                            deletion hash. Secrets Store binding
 *                            (T-078). The `/diag/legal-hold`
 *                            endpoint has no secret of its own — it
 *                            authenticates the caller by an on-chain
 *                            `ADMIN_ROLE` check (see `diagAdminAuth.ts`).
 *   - (no signing-key consumer here any more — `KEEPER_PRIVATE_KEY`
 *      moved to apps/keeper alongside `runDailyOracleSnapshot`
 *      in the Stage 3 architectural-rebalance commit. The
 *      least-privilege contract from staging plan §2: agent
 *      holds NEITHER `KEEPER_PRIVATE_KEY` NOR per-chain on-chain
 *      write access. A compromised agent produces stale
 *      notifications but can't move funds.)
 *   - `QUOTE_0X_RATELIMIT`,
 *     `QUOTE_1INCH_RATELIMIT`,
 *     `DIAG_RECORD_RATELIMIT` — Cloudflare built-in rate-limit
 *                            bindings (one per upstream service).
 *                            Native bindings — not secrets.
 *   - `DIAG_SAMPLE_RATE`,
 *     `DIAG_RETENTION_DAYS` — diagnostics record sampling +
 *                            retention. Plain `var`s.
 *   - `DIAG_LEGAL_DOCS`    — T-075 private R2 bucket storing the
 *                            legal documents uploaded with a hold.
 *                            Native binding — not a secret.
 *   - `FRONTEND_ORIGIN`    — CSV of allowed CORS origins for the
 *                            frontend-facing endpoints. Plain `var`.
 *
 * Diamond addresses come from `@vaipakam/contracts/deployments` —
 * the same artifact apps/{indexer,keeper} read.
 */

/** A Cloudflare Secrets Store secret binding — read with `.get()`. */
export type SecretBinding = { get(): Promise<string> };

/** A Cloudflare built-in rate-limit binding. */
type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

/**
 * The non-secret bindings + plain config — identical shape in both
 * `WorkerEnv` and `Env` (D1 / R2 / rate-limit bindings and plain
 * `var`s need no resolution). Kept in one place so the docs aren't
 * duplicated across the two env interfaces.
 */
interface BaseEnv {
  DB: D1Database;

  // Telegram (public bot handle — used to build the `t.me` deep
  // link; the bot TOKEN is the separate Secrets Store binding).
  TG_BOT_USERNAME?: string;

  // Cloudflare built-in rate-limit bindings — one per upstream
  // service so a noisy caller on /quote/0x can't drain the
  // /quote/1inch budget. Configured in wrangler.jsonc.
  QUOTE_0X_RATELIMIT?: RateLimitBinding;
  QUOTE_1INCH_RATELIMIT?: RateLimitBinding;
  DIAG_RECORD_RATELIMIT?: RateLimitBinding;
  // T-086 step 14 — per-IP gate on `POST /opensea/listing`. The
  // expected call rate is one POST per borrower-driven
  // postPrepayListing / updatePrepayListing tx, so a tight budget
  // is plenty; the binding exists mainly as an abuse safety net.
  OPENSEA_LISTING_RATELIMIT?: RateLimitBinding;
  // T-086 Round-5 Block A (#313) — per-IP rate-limit on the new
  // GET /opensea/collection/{slug} proxy. Without this, anyone
  // can spoof an allowed Origin and iterate slugs/chains to drain
  // the OPENSEA_API_KEY quota. Same Cloudflare built-in binding
  // pattern + key-by-IP as the listing rate-limit.
  OPENSEA_COLLECTION_RATELIMIT?: RateLimitBinding;
  // T-086 Round-5 Block C (#309 Mode B) — rate-limit for the
  // GET /opensea/offers/{chainId}/{contract}/{tokenId} proxy. The
  // dapp polls every ~30s while the loan card is open, so the
  // limit needs headroom (60 req/min/IP starting value).
  OPENSEA_OFFERS_RATELIMIT?: RateLimitBinding;
  // T-086 Round-5 Block C v1.1 (#334) — max pagination depth on
  // the offers proxy. Default 3 pages (≈300 offers per leg at
  // `limit=100`); operators on hyper-active collections can raise
  // via the agent's wrangler.jsonc `vars` block. Worst-case
  // upstream cost per inbound request is `2 × OPENSEA_OFFERS_MAX_PAGES`
  // round-trips (collection + item legs each paginated); paired
  // with the `OPENSEA_OFFERS_RATELIMIT` inbound cap (60/min/IP),
  // total upstream cost stays bounded. String type matches the
  // wrangler-vars JSON convention; coerced to int + clamped to
  // `[1, 25]` at read time so a misconfigured value can't blow
  // the OpenSea API quota.
  OPENSEA_OFFERS_MAX_PAGES?: string;
  // #334 Codex round-1 P2 — global upstream rate-limit keyed by
  // a constant ("upstream") rather than per-IP. Bounds aggregate
  // upstream calls to the shared `OPENSEA_API_KEY` across all
  // caller IPs. Without this binding the per-IP
  // `OPENSEA_OFFERS_RATELIMIT` is the only gate, so two or more
  // distinct caller IPs polling hot tokens at the raised
  // `OPENSEA_OFFERS_MAX_PAGES` ceiling could each individually
  // stay under the per-IP cap while in aggregate exceeding the
  // OpenSea API tier. Optional — when absent the proxy falls
  // back to per-IP-only gating + warns once at startup.
  OPENSEA_OFFERS_UPSTREAM_RATELIMIT?: RateLimitBinding;

  // Diagnostics sampling (0.0–1.0; default 1.0 = write every accepted POST).
  // Coerced from string to float at read time. Out-of-range values
  // clamp to [0, 1].
  DIAG_SAMPLE_RATE?: string;

  // Diagnostics retention (days; default 90). Coerced from string
  // to int; values < 1 are clamped up to 1.
  DIAG_RETENTION_DAYS?: string;

  // T-075 — private R2 bucket holding the legal documents uploaded
  // when a protocol admin places a hold (the e-signed order /
  // scanned letter). Content-addressed by SHA-256. Optional: when
  // the binding is absent the legal-hold endpoint returns 503 for
  // any action that carries a document.
  DIAG_LEGAL_DOCS?: R2Bucket;

  // CSV of allowed CORS origins for the frontend-facing endpoints
  // (`/thresholds`, `/link/telegram`, `/diag/record`). Set in
  // wrangler.jsonc:vars.
  FRONTEND_ORIGIN: string;

  // T-086 Round-5 Block A (#313) — recipient-validating-token
  // allow-list (JSON-encoded). See the `Env` interface comment
  // below for the shape; set in wrangler.jsonc:vars per chain
  // post-deploy.
  RECIPIENT_VALIDATING_TOKENS?: string;
}

/**
 * The RAW Cloudflare bindings the Worker handler receives. The
 * secret fields are Secrets Store bindings (declared in
 * `wrangler.jsonc` → `secrets_store_secrets`) — resolve via
 * `resolveEnv()` before any downstream use.
 *
 * No `RPC_ZKEVM` — Polygon zkEVM is out of scope (no secret bound);
 * `getChainConfigs` simply skips that chain.
 */
export interface WorkerEnv extends BaseEnv {
  // Per-chain RPC URLs — buy-watchdog needs every chain with a
  // VPFIBuyAdapter; periodicPreNotify needs every Diamond chain.
  // Most expansive RPC set of the three Workers.
  RPC_BASE?: SecretBinding;
  RPC_ETH?: SecretBinding;
  RPC_ARB?: SecretBinding;
  RPC_OP?: SecretBinding;
  RPC_BNB?: SecretBinding;
  RPC_POLYGON?: SecretBinding;
  RPC_SEPOLIA?: SecretBinding;
  RPC_BASE_SEPOLIA?: SecretBinding;
  RPC_ARB_SEPOLIA?: SecretBinding;
  RPC_OP_SEPOLIA?: SecretBinding;
  RPC_POLYGON_AMOY?: SecretBinding;
  RPC_BNB_TESTNET?: SecretBinding;

  // Telegram bot token (handshake + outbound notifications).
  TG_BOT_TOKEN?: SecretBinding;
  // Push Protocol channel signer.
  PUSH_CHANNEL_PK?: SecretBinding;
  // Aggregator API keys for the public `/quote/*` proxies.
  ZEROEX_API_KEY?: SecretBinding;
  ONEINCH_API_KEY?: SecretBinding;
  // T-086 step 14 — OpenSea Listings API key for the
  // `POST /opensea/listing` proxy. Used server-side only; the dapp
  // never sees this key.
  OPENSEA_API_KEY?: SecretBinding;
  // T-075 — server secret keying the per-wallet deletion hash.
  DIAG_WALLET_HMAC_KEY?: SecretBinding;
}

/**
 * The RESOLVED env passed to all downstream code. Every secret
 * field is a plain string; a missing / unconfigured chain or secret
 * is `undefined` and the dependent code path skips it.
 */
export interface Env extends BaseEnv {
  // Per-chain RPC URLs — buy-watchdog + periodicPreNotify. Each
  // missing URL skips that chain.
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
  // Push Protocol channel signer.
  PUSH_CHANNEL_PK?: string;
  // Aggregator API keys for the public `/quote/*` proxies.
  ZEROEX_API_KEY?: string;
  ONEINCH_API_KEY?: string;
  // T-086 step 14 — resolved OpenSea Listings API key.
  OPENSEA_API_KEY?: string;

  // T-086 Round-5 Block A (#313) — per-chain allow-list of tokens
  // whose `transfer` can revert based on recipient (USDC OFAC
  // blocklist, ERC777/ERC1363 hook-enabled tokens, etc.). JSON-
  // encoded; keys are `${chainId}:${tokenAddressLower}`. Each entry
  // carries the `balanceSlot` identifier (resolved at config-time
  // per the §14.4 errata recipe) + a `hookEnabled` flag. Unset =
  // pre-flight returns "not_applicable" for every recipient.
  RECIPIENT_VALIDATING_TOKENS?: string;

  // T-075 — server secret for the per-wallet deletion key.
  // `wallet_hash = HMAC-SHA256(fullWallet, DIAG_WALLET_HMAC_KEY)`.
  // When unset: connected-wallet capture skips the write rather than
  // creating a fresh non-erasable row; not-connected rows may still
  // store NULL `wallet_hash`; and the erasure / status endpoints
  // return 503.
  DIAG_WALLET_HMAC_KEY?: string;

  // (No signing-key field — Stage 3 architectural-rebalance moved
  // `KEEPER_PRIVATE_KEY` + `runDailyOracleSnapshot` to apps/keeper
  // so the only Worker that holds the signer is the keeper.)

  // (T-075 — the `POST /diag/legal-hold` endpoint has NO env secret.
  // It authenticates the caller by recovering the request signature
  // and checking the signer holds the on-chain `ADMIN_ROLE` on the
  // Diamond — see `diagAdminAuth.ts`. The contract's access-control
  // state is the source of truth; there is no admin list or shared
  // token in this Worker's env.)
}

/**
 * Read one Secrets Store binding into a plain string.
 *
 * Tolerates BOTH an absent binding (`b` undefined) AND a failing
 * fetch: a rejected `.get()` — a transient Secrets Store outage, or
 * a secret deleted / deactivated after deploy — resolves to
 * `undefined` rather than rejecting. `resolveEnv` fans every secret
 * through `Promise.all`, so without this catch one unavailable
 * secret would abort the whole resolve and take down the entire
 * cron tick / every HTTP route — including paths that never touch
 * that secret. Collapsing to `undefined` keeps the failure scoped to
 * the one dependent feature: every `Env` secret field is optional
 * and downstream code already handles `undefined` (skip that chain /
 * disable that adapter / 503 that one endpoint).
 * (T-078 — PR #36 Codex review.)
 */
async function readSecret(
  b: SecretBinding | undefined,
): Promise<string | undefined> {
  if (!b) return undefined;
  try {
    return await b.get();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[env] Secrets Store fetch failed; treating as unset:', err);
    return undefined;
  }
}

/**
 * Resolve the raw Worker bindings into the plain `Env` that every
 * downstream function expects. All secrets are fetched in parallel.
 * Call this **once** at the Worker entry point — at the top of both
 * `scheduled` and `fetch` — never inside a hot path.
 */
export async function resolveEnv(raw: WorkerEnv): Promise<Env> {
  const [
    base,
    eth,
    arb,
    op,
    bnb,
    polygon,
    sepolia,
    baseSep,
    arbSep,
    opSep,
    polygonAmoy,
    bnbTest,
    tgToken,
    pushPk,
    zeroEx,
    oneInch,
    openSea,
    walletHmac,
  ] = await Promise.all([
    readSecret(raw.RPC_BASE),
    readSecret(raw.RPC_ETH),
    readSecret(raw.RPC_ARB),
    readSecret(raw.RPC_OP),
    readSecret(raw.RPC_BNB),
    readSecret(raw.RPC_POLYGON),
    readSecret(raw.RPC_SEPOLIA),
    readSecret(raw.RPC_BASE_SEPOLIA),
    readSecret(raw.RPC_ARB_SEPOLIA),
    readSecret(raw.RPC_OP_SEPOLIA),
    readSecret(raw.RPC_POLYGON_AMOY),
    readSecret(raw.RPC_BNB_TESTNET),
    readSecret(raw.TG_BOT_TOKEN),
    readSecret(raw.PUSH_CHANNEL_PK),
    readSecret(raw.ZEROEX_API_KEY),
    readSecret(raw.ONEINCH_API_KEY),
    readSecret(raw.OPENSEA_API_KEY),
    readSecret(raw.DIAG_WALLET_HMAC_KEY),
  ]);
  return {
    // Non-secret bindings / config — passed straight through.
    DB: raw.DB,
    TG_BOT_USERNAME: raw.TG_BOT_USERNAME,
    QUOTE_0X_RATELIMIT: raw.QUOTE_0X_RATELIMIT,
    QUOTE_1INCH_RATELIMIT: raw.QUOTE_1INCH_RATELIMIT,
    DIAG_RECORD_RATELIMIT: raw.DIAG_RECORD_RATELIMIT,
    OPENSEA_LISTING_RATELIMIT: raw.OPENSEA_LISTING_RATELIMIT,
    OPENSEA_COLLECTION_RATELIMIT: raw.OPENSEA_COLLECTION_RATELIMIT,
    OPENSEA_OFFERS_RATELIMIT: raw.OPENSEA_OFFERS_RATELIMIT,
    // #334 — preserve the wrangler-vars config so the proxy
    // can read it. Without this copy the proxy's
    // `env.OPENSEA_OFFERS_MAX_PAGES` is always undefined and
    // the configurable behaviour is unreachable.
    OPENSEA_OFFERS_MAX_PAGES: raw.OPENSEA_OFFERS_MAX_PAGES,
    OPENSEA_OFFERS_UPSTREAM_RATELIMIT: raw.OPENSEA_OFFERS_UPSTREAM_RATELIMIT,
    DIAG_SAMPLE_RATE: raw.DIAG_SAMPLE_RATE,
    DIAG_RETENTION_DAYS: raw.DIAG_RETENTION_DAYS,
    DIAG_LEGAL_DOCS: raw.DIAG_LEGAL_DOCS,
    FRONTEND_ORIGIN: raw.FRONTEND_ORIGIN,
    // T-086 Round-5 Block A (#313) — pass through verbatim.
    RECIPIENT_VALIDATING_TOKENS: raw.RECIPIENT_VALIDATING_TOKENS,
    // Resolved secrets.
    RPC_BASE: base,
    RPC_ETH: eth,
    RPC_ARB: arb,
    RPC_OP: op,
    RPC_BNB: bnb,
    RPC_POLYGON: polygon,
    RPC_SEPOLIA: sepolia,
    RPC_BASE_SEPOLIA: baseSep,
    RPC_ARB_SEPOLIA: arbSep,
    RPC_OP_SEPOLIA: opSep,
    RPC_POLYGON_AMOY: polygonAmoy,
    RPC_BNB_TESTNET: bnbTest,
    TG_BOT_TOKEN: tgToken,
    PUSH_CHANNEL_PK: pushPk,
    ZEROEX_API_KEY: zeroEx,
    ONEINCH_API_KEY: oneInch,
    OPENSEA_API_KEY: openSea,
    DIAG_WALLET_HMAC_KEY: walletHmac,
    // RPC_ZKEVM intentionally unset — Polygon zkEVM is out of scope.
  };
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
