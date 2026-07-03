import { getDeployment } from '@vaipakam/contracts/deployments';

/**
 * Typed env for the apps/keeper Worker.
 *
 * T-078 — the secrets (per-chain RPC URLs, the Telegram bot token,
 * the Push channel signer, the aggregator API keys, and the keeper
 * signing key) moved from per-Worker `wrangler secret put` strings
 * to the account-level Cloudflare Secrets Store
 * (`docs/DesignsAndPlans/SecretsStoreMigration.md`). A Secrets Store
 * binding is read **asynchronously** (`await binding.get()`), so
 * there are two env shapes:
 *
 *   - `WorkerEnv` — the RAW Cloudflare bindings the Worker handler
 *     receives. The secret fields are Secrets Store bindings; the
 *     non-secret config fields are plain strings.
 *   - `Env` — the RESOLVED env passed to every downstream function:
 *     every field is a plain string, exactly as before T-078.
 *
 * `resolveEnv()` bridges them — called **once** per `scheduled` tick
 * at the Worker entry point (`index.ts`); all downstream code keeps
 * taking the plain `Env` and stays synchronous. This is the
 * "resolve at the boundary" containment pattern from
 * `SecretsStoreMigration.md` §6.
 *
 * Non-secret config (`TG_BOT_USERNAME`, `FRONTEND_ORIGIN`,
 * `KEEPER_ENABLED`, the `LIQ_*` / `SPLIT_*` / `PARTIAL_LIQ_*` knobs)
 * stays a plain `var` — NOT migrated to the Secrets Store.
 *
 * Diamond addresses come from `@vaipakam/contracts/deployments`.
 */

/** A Cloudflare Secrets Store secret binding — read with `.get()`. */
export type SecretBinding = { get(): Promise<string> };

/**
 * `DB` + the non-secret config knobs — identical shape in both
 * `WorkerEnv` and `Env` (these are plain `var`s, not secrets, so
 * they need no resolution). Kept in one place so the knob docs
 * aren't duplicated across the two env interfaces.
 */
interface BaseEnv {
  DB: D1Database;

  // Public Telegram bot handle (the @-name from BotFather). A plain
  // var; without it the handshake link returns a null bot_url.
  TG_BOT_USERNAME?: string;

  // Connected-app origin for deep-links inside push / Telegram
  // notifications (e.g. "View this loan" → `<FRONTEND_ORIGIN>/loans/{id}`).
  // Defaults to `https://defi.vaipakam.com` when unset.
  FRONTEND_ORIGIN?: string;

  // Phase 7a.4 — autonomous-keeper enable flag. When
  // `KEEPER_ENABLED == 'true'` AND `KEEPER_PRIVATE_KEY` is set, the
  // liquidator / matcher / liquidity-confidence passes arm their
  // on-chain submit paths. A plain var (not a secret).
  KEEPER_ENABLED?: string;

  // #925 — reward-budget remittance pass knobs (plain vars, not secrets).
  /** 'true' arms the reward-budget remit pass (in addition to KEEPER_ENABLED). */
  REWARD_REMIT_ENABLED?: string;
  /** recent-day window re-scanned for un-remitted budget each tick (default 45). */
  REWARD_REMIT_LOOKBACK_DAYS?: string;
  /** per-send VPFI ceiling in wei — perRemittanceCap + batch bound (default 50000e18, matches the on-chain lane default). */
  REWARD_REMIT_LANE_CAP?: string;

  // Depth-tiered-LTV liquidity-confidence relay knobs
  // (`liquidityConfidence.ts`, §4.4 step 5). Both default
  // conservatively when unset; demotion is always immediate.
  /** consecutive eligible-to-promote ticks required before a step up (default 5) */
  LIQ_CONFIDENCE_MIN_CHECKS?: string;
  /** wall-clock days that eligible streak must also span (default 3) */
  LIQ_CONFIDENCE_MIN_WINDOW_DAYS?: string;
  // Tier-3 "battle-tested elsewhere" advisory — 2-of-3 ensemble in
  // `liquidityConfidence.ts::battleTestedElsewhere`. All thresholds
  // in plain USD; all optional with sensible defaults.
  /** Signal ① — min USD TVL on one of {Aave v3, Compound v3, Morpho-blue}.
   *  Default $10M. */
  LIQ_TIER3_MIN_TVL_USD?: string;
  /** Disable signal ① entirely (`1` / `true`). When disabled the
   *  ensemble becomes 2-of-2 (stricter). Default off. */
  LIQ_TIER3_DISABLE_DEFI_LISTING?: string;
  /** Signal ② — min USD circulating market cap (CoinGecko). Default $1B. */
  LIQ_TIER3_MIN_MCAP_USD?: string;
  /** Signal ③ — min USD 24h trading volume (CoinGecko). Default $50M/day. */
  LIQ_TIER3_MIN_VOL_USD?: string;

  /** Liquidator-hardening — minimum bps improvement (split-sum vs
   *  failover-top-1) required before the keeper submits
   *  `triggerLiquidationSplit` over the default failover path.
   *  Default 100 (1%). */
  SPLIT_MIN_IMPROVEMENT_BPS?: string;

  /** Liquidator-hardening — minimum HF (in BPS, 10_000 = HF_SCALE)
   *  at which the keeper prefers `triggerPartialLiquidation` (50%
   *  sweep) over a full liquidation. Default 9500 = 0.95. Below this
   *  floor a 50% partial can't restore HF >= 1.0 (the on-chain
   *  {PartialMustRestoreHF} gate would revert) so the keeper falls
   *  back to the full path. Set to 10_000 to disable the partial
   *  path. Tighten (e.g. 9700) for a more conservative regime. */
  PARTIAL_LIQ_MIN_HF_BPS?: string;
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
  // Per-chain RPC URLs — HF reads + liquidation submission.
  RPC_BASE?: SecretBinding;
  RPC_ETH?: SecretBinding;
  RPC_ARB?: SecretBinding;
  RPC_OP?: SecretBinding;
  RPC_BNB?: SecretBinding;
  RPC_SEPOLIA?: SecretBinding;
  RPC_BASE_SEPOLIA?: SecretBinding;
  RPC_ARB_SEPOLIA?: SecretBinding;
  RPC_OP_SEPOLIA?: SecretBinding;
  RPC_BNB_TESTNET?: SecretBinding;

  // Telegram bot token — HF-band-downgrade alerts (watcher.ts).
  TG_BOT_TOKEN?: SecretBinding;
  // Push Protocol channel signer — parallel push-channel alert path.
  PUSH_CHANNEL_PK?: SecretBinding;
  // Aggregator API keys — server-side liquidation quoting.
  ZEROEX_API_KEY?: SecretBinding;
  ONEINCH_API_KEY?: SecretBinding;
  // Autonomous-keeper EOA signing key. The ONLY Worker that holds a
  // signing key (staging plan §2 least-privilege contract).
  KEEPER_PRIVATE_KEY?: SecretBinding;
}

/**
 * The RESOLVED env passed to all downstream code. Every field is a
 * plain string; a missing / unconfigured chain or secret is
 * `undefined` and the dependent pass skips it this tick.
 */
export interface Env extends BaseEnv {
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

  TG_BOT_TOKEN?: string;
  PUSH_CHANNEL_PK?: string;
  ZEROEX_API_KEY?: string;
  ONEINCH_API_KEY?: string;
  KEEPER_PRIVATE_KEY?: string;
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
 * cron tick — including passes that never touch that secret.
 * Collapsing to `undefined` keeps the failure scoped to the one
 * dependent feature: every `Env` secret field is optional and
 * downstream code already handles `undefined` (skip that chain /
 * disable that adapter). (T-078 — PR #36 Codex review.)
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
 * Call this **once** per cron tick, at the Worker entry point —
 * never inside a hot path.
 */
export async function resolveEnv(raw: WorkerEnv): Promise<Env> {
  const [
    base,
    eth,
    arb,
    op,
    bnb,
    sepolia,
    baseSep,
    arbSep,
    opSep,
    bnbTest,
    tgToken,
    pushPk,
    zeroEx,
    oneInch,
    keeperKey,
  ] = await Promise.all([
    readSecret(raw.RPC_BASE),
    readSecret(raw.RPC_ETH),
    readSecret(raw.RPC_ARB),
    readSecret(raw.RPC_OP),
    readSecret(raw.RPC_BNB),
    readSecret(raw.RPC_SEPOLIA),
    readSecret(raw.RPC_BASE_SEPOLIA),
    readSecret(raw.RPC_ARB_SEPOLIA),
    readSecret(raw.RPC_OP_SEPOLIA),
    readSecret(raw.RPC_BNB_TESTNET),
    readSecret(raw.TG_BOT_TOKEN),
    readSecret(raw.PUSH_CHANNEL_PK),
    readSecret(raw.ZEROEX_API_KEY),
    readSecret(raw.ONEINCH_API_KEY),
    readSecret(raw.KEEPER_PRIVATE_KEY),
  ]);
  return {
    // Non-secret config — passed straight through.
    DB: raw.DB,
    TG_BOT_USERNAME: raw.TG_BOT_USERNAME,
    FRONTEND_ORIGIN: raw.FRONTEND_ORIGIN,
    KEEPER_ENABLED: raw.KEEPER_ENABLED,
    REWARD_REMIT_ENABLED: raw.REWARD_REMIT_ENABLED,
    REWARD_REMIT_LOOKBACK_DAYS: raw.REWARD_REMIT_LOOKBACK_DAYS,
    REWARD_REMIT_LANE_CAP: raw.REWARD_REMIT_LANE_CAP,
    LIQ_CONFIDENCE_MIN_CHECKS: raw.LIQ_CONFIDENCE_MIN_CHECKS,
    LIQ_CONFIDENCE_MIN_WINDOW_DAYS: raw.LIQ_CONFIDENCE_MIN_WINDOW_DAYS,
    LIQ_TIER3_MIN_TVL_USD: raw.LIQ_TIER3_MIN_TVL_USD,
    LIQ_TIER3_DISABLE_DEFI_LISTING: raw.LIQ_TIER3_DISABLE_DEFI_LISTING,
    LIQ_TIER3_MIN_MCAP_USD: raw.LIQ_TIER3_MIN_MCAP_USD,
    LIQ_TIER3_MIN_VOL_USD: raw.LIQ_TIER3_MIN_VOL_USD,
    SPLIT_MIN_IMPROVEMENT_BPS: raw.SPLIT_MIN_IMPROVEMENT_BPS,
    PARTIAL_LIQ_MIN_HF_BPS: raw.PARTIAL_LIQ_MIN_HF_BPS,
    // Resolved secrets.
    RPC_BASE: base,
    RPC_ETH: eth,
    RPC_ARB: arb,
    RPC_OP: op,
    RPC_BNB: bnb,
    RPC_SEPOLIA: sepolia,
    RPC_BASE_SEPOLIA: baseSep,
    RPC_ARB_SEPOLIA: arbSep,
    RPC_OP_SEPOLIA: opSep,
    RPC_BNB_TESTNET: bnbTest,
    TG_BOT_TOKEN: tgToken,
    PUSH_CHANNEL_PK: pushPk,
    ZEROEX_API_KEY: zeroEx,
    ONEINCH_API_KEY: oneInch,
    KEEPER_PRIVATE_KEY: keeperKey,
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
