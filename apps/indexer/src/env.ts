import { getDeployment } from '@vaipakam/contracts/deployments';
import { resolveD1Binding } from '@vaipakam/lib/d1Maintenance';
import { spend, type TickBudget } from './subrequestBudget';

/**
 * This Worker's deployed name, used as the label on a D1 refusal so an
 * operator reading the log knows which deployment refused (#2239). Kept in
 * step with `wrangler.jsonc`'s `name` by hand — a wrong label costs a moment
 * of confusion in a log line, which is why it is not worth a build step.
 */
export const WORKER_NAME = 'vaipakam-indexer';

/**
 * Typed env for the apps/indexer Worker.
 *
 * T-078 — the per-chain RPC URLs moved from per-Worker
 * `wrangler secret put` strings to the account-level Cloudflare
 * Secrets Store (`docs/DesignsAndPlans/SecretsStoreMigration.md`).
 * A Secrets Store binding is read **asynchronously** (`await
 * binding.get()`), so there are now two env shapes:
 *
 *   - `WorkerEnv` — the RAW Cloudflare bindings the Worker handler
 *     receives. `RPC_*` are Secrets Store bindings.
 *   - `Env` — the RESOLVED env passed to every downstream function:
 *     `RPC_*` are plain strings, exactly as before T-078.
 *
 * `resolveEnv()` bridges them. It is called **once** per `fetch` /
 * `scheduled` at the Worker entry point (`index.ts`); all downstream
 * code keeps taking the plain `Env` and stays synchronous. This is
 * the "resolve at the boundary" containment pattern from
 * `SecretsStoreMigration.md` §6 — the async surface is one place.
 *
 * Bindings:
 *   - `DB`                            — D1 binding (this Worker
 *                                       writes the offers / loans /
 *                                       activity tables; keeper +
 *                                       agent read them via the
 *                                       same shared database).
 *   - `RPC_*`                         — per-chain RPC URLs (carry
 *                                       API keys) — Secrets Store
 *                                       bindings, declared in
 *                                       `wrangler.jsonc` →
 *                                       `secrets_store_secrets`.
 *   - `CANCELLED_OFFER_RETENTION_DAYS` — a plain `var` (not a
 *                                       secret); int days, default
 *                                       30 inside the prune helper.
 *
 * What's deliberately NOT here (lives on apps/{keeper,agent}):
 *   - QUOTE_*_RATELIMIT / DIAG_RECORD_RATELIMIT — agent (HTTP
 *     rate-limit buckets). #1651: a `SCAN_BLOCKAID_RATELIMIT` was
 *     listed here; no such binding is declared on any Worker.
 *   - DIAG_SAMPLE_RATE / DIAG_RETENTION_DAYS — agent
 *   - TG_BOT_TOKEN / TG_BOT_USERNAME / PUSH_CHANNEL_PK — keeper +
 *     agent (notification dispatch)
 *   - KEEPER_PRIVATE_KEY / KEEPER_ENABLED — keeper
 *   - ZEROEX_API_KEY / ONEINCH_API_KEY — keeper + agent
 *   - FRONTEND_ORIGIN — indexer routes use OPEN CORS (T-041)
 *
 * Diamond addresses come from `@vaipakam/contracts/deployments`.
 */

/** A Cloudflare Secrets Store secret binding — read with `.get()`. */
export type SecretBinding = { get(): Promise<string> };

/**
 * The RAW Cloudflare bindings the Worker handler receives. `RPC_*`
 * are Secrets Store bindings — resolve via `resolveEnv()` before
 * any downstream use.
 *
 * No `RPC_ZKEVM` — Polygon zkEVM is out of scope (no secret bound);
 * `getChainConfigs` simply skips that chain.
 */
export interface WorkerEnv {
  /**
   * The D1 binding AS DELIVERED — possibly absent, and typed that way (#2239).
   *
   * A maintenance deployment omits `d1_databases` so that no code in the
   * isolate can obtain a database handle while a binding is being moved. That
   * is a real state, so the raw env tells the truth about it, and the compiler
   * then refuses `env.DB.prepare(...)` on a raw env. Every path has to go
   * through `resolveD1Binding` and gets the refusing stub instead of a
   * `Cannot read properties of undefined` — which is the whole point: the
   * chokepoint is enforced by the type checker rather than by remembering.
   *
   * `Env.DB` below is non-optional, so nothing downstream of the seam changes.
   */
  DB?: D1Database;
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
  RPC_POLYGON_AMOY?: SecretBinding;
  CANCELLED_OFFER_RETENTION_DAYS?: string;
  // T-086 step 14 — OpenSea Listings API key for the autonomous
  // republish path (`apps/indexer/src/openseaPublish.ts`). The
  // indexer holds its own key (separate from the agent Worker's)
  // so a key rotation can happen one Worker at a time without
  // dropping coverage.
  OPENSEA_API_KEY?: SecretBinding;
  // #335 — per-IP rate-limit on the new POST endpoint. Resolves
  // through to the `Env` shape verbatim (no .get() async hop).
  OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT?: {
    limit: (args: { key: string }) => Promise<{ success: boolean }>;
  };
  // #1131 Rate Desk phase 3 — per-IP rate-limit on `POST /signed-offers`
  // (the signed-offer book ingest). Same shape + no-op-when-unprovisioned
  // posture as the #335 binding above.
  SIGNED_OFFERS_RATELIMIT?: {
    limit: (args: { key: string }) => Promise<{ success: boolean }>;
  };
  // #757 Phase A — Alchemy webhook HMAC signing key. Read DIRECTLY from this
  // raw `WorkerEnv` in the `/hooks/chain-event` route (which is dispatched
  // BEFORE the global `resolveEnv`, so an unauthenticated POST never triggers
  // the other Secrets-Store fetches). Optional: unset ⇒ the route fails closed
  // (401) and ingest stays cron-paced.
  //
  // PER-CHAIN keys. Alchemy Notify V2 mints a DISTINCT signing key per webhook
  // (there is no team/app-shared key — confirmed against the Notify API via
  // both the CLI and the MCP, and Custom Webhooks are single-network too). The
  // design's "one webhook per chain, target URL pins `?chain=<id>`" model
  // therefore needs one key per chain. The route reads the TRUSTED `?chain=`
  // URL param (operator-configured, not payload-derived) BEFORE verifying, and
  // selects `ALCHEMY_WEBHOOK_SIGNING_KEY_<chainId>`, falling back to the generic
  // key below. A wrong-chain POST just selects a key its HMAC can't match → 401,
  // so the param driving key-selection is safe. Add a binding per active chain.
  ALCHEMY_WEBHOOK_SIGNING_KEY?: SecretBinding;
  ALCHEMY_WEBHOOK_SIGNING_KEY_84532?: SecretBinding; // Base Sepolia (canonical testnet)
  ALCHEMY_WEBHOOK_SIGNING_KEY_421614?: SecretBinding; // Arb Sepolia (mirror testnet)
  ALCHEMY_WEBHOOK_SIGNING_KEY_97?: SecretBinding; // BNB Testnet (key ready; DO scans once 97 is in the bundle)
  // #757 Phase A — per-chain ingest Durable Object namespace. The webhook
  // route and the cron `scheduled()` both resolve `idFromName(String(chainId))`
  // and forward a (chainId, target-block) hint; the DO is the single serialized
  // ingest writer per chain. Optional so a deploy without the DO binding
  // degrades to the legacy inline cron scan.
  CHAIN_INGEST_DO?: DurableObjectNamespace;
  // #757 Phase A — two-step rollout gate. The DO ingest path (cron→DO AND the
  // webhook→DO forward) is active ONLY when this is "true" AND the DO is bound.
  // Default unset ⇒ the cron keeps the legacy inline scan and the webhook
  // 200-no-ops, so merging/deploying the new DO never re-routes live ingest by
  // itself. Plain `var`, read from the raw env (the route runs before
  // `resolveEnv`).
  CHAIN_INGEST_VIA_DO?: string;

  /** Cloudflare version-metadata binding — makes "what's actually
   *  deployed?" a one-curl question (surfaced on the stats routes).
   *  Absent in local dev / tests. */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

/**
 * Is the DO ingest path active? THE single definition of the #757 gate.
 *
 * Both halves are required: the `CHAIN_INGEST_VIA_DO` rollout flag AND the
 * `CHAIN_INGEST_DO` binding. Merging or deploying the DO must never re-route
 * live ingest on its own, and flipping the flag on a deployment without the
 * binding must not either — so the cron, the webhook forward and every
 * consumer of the resolved env answer this question the same way.
 *
 * It lives HERE, beside both env shapes, rather than in the module that
 * happened to need it first. `index.ts` owned the only copy while three
 * route modules re-derived a half of it from the one field they could see
 * (#2202); a predicate that two layers must agree on belongs with the types,
 * not with either caller.
 *
 * Callers holding a raw `WorkerEnv` (the cron, the webhook route, the DO)
 * call this directly; everything downstream reads the resolved
 * `Env.doIngestEnabled`, which `resolveEnv` stamps from this.
 */
export function isDoIngestEnabled(raw: WorkerEnv): boolean {
  return raw.CHAIN_INGEST_VIA_DO === 'true' && !!raw.CHAIN_INGEST_DO;
}

/**
 * The resolved env for a route that must SKIP `resolveEnv`.
 *
 * One route does: `/metrics/recycling` bypasses the Secrets Store resolution
 * for latency, because it needs D1, the ingest gate and the deployment
 * artifact — none of which come from Secrets Store — and paying for the
 * secrets binding could push the response past the browser's abort.
 *
 * It exists as a named function because the bare cast that used to do this
 * job got it wrong the moment the gate became a resolved field (#2202 r1):
 * `raw as unknown as Env` type-checks happily and hands the route
 * `doIngestEnabled: undefined`, which reads as "legacy" and is a worse
 * answer than the half-gate it replaced. A double cast defeats the
 * typechecker, so the only defence is that there is one obvious way to do
 * this and it is tested.
 *
 * This is NOT a workaround for a missing binding: the raw env carries both
 * halves, so this performs the same resolution `resolveEnv` does. It simply
 * omits the part that costs latency.
 */
export function earlyRouteEnv(raw: WorkerEnv): Env {
  return {
    ...(raw as unknown as Env),
    // The same maintenance seam `resolveEnv` uses (#2239). The spread above
    // copies `DB` straight off the raw env, so without this line the early
    // routes would be the one lane that reaches an absent binding directly —
    // and they are precisely the lane that skips `resolveEnv`.
    DB: resolveD1Binding(raw.DB, WORKER_NAME),
    doIngestEnabled: isDoIngestEnabled(raw),
  };
}

/**
 * The RESOLVED env passed to all downstream code. `RPC_*` are plain
 * strings; a missing / unconfigured chain is `undefined` and its
 * chain scan is skipped this tick (see `getChainConfigs`).
 */
export interface Env {
  DB: D1Database;

  /**
   * The invocation's COUNTED sender (#2221).
   *
   * An invocation may issue 50 outbound requests; the env is the object every
   * pass already carries, so it is where the counted handles belong. `DB` is
   * metered in place (same type, wrapped); this is the HTTP half, used by any
   * code here that reaches a third party directly rather than through a chain
   * client.
   *
   * Optional and absent by default. A caller outside a counted invocation —
   * the read-API request lane, a unit test — falls back to the global `fetch`
   * and is simply not counted, which is correct: that lane has its own
   * ceiling. Reach for `env.fetchFn ?? fetch` rather than `fetch`, so a
   * request made from a cron pass is counted without the author having to
   * know a budget exists.
   */
  fetchFn?: typeof fetch;

  /**
   * The #757 rollout gate, ALREADY RESOLVED — is the DO ingest path actually
   * active? Consumers report the ingest mode's expected scan cadence from
   * this (DO path = every chain pinged each minute; legacy inline
   * round-robin = unknown → reported as null so clients fail safe to their
   * polling posture).
   *
   * This carries the ANSWER rather than the flag, and that is the fix for
   * #2202. The field used to be `CHAIN_INGEST_VIA_DO?: string` — half of a
   * two-part gate — and its own comment claimed to "pass the rollout gate
   * through". It did not: the gate is the flag AND the DO binding, the
   * binding is deliberately not on the resolved env (a route has no business
   * holding a namespace), so every consumer here could only ever test the
   * half it could see. Three of them did, and all three reported the DO
   * cadence on a deployment running the legacy path.
   *
   * A boolean nobody can half-read makes that unrepresentable, which is
   * better than three corrected call sites: the next consumer gets the whole
   * answer by default instead of the visible fragment.
   */
  doIngestEnabled: boolean;

  /** Cloudflare version-metadata binding — makes "what's actually
   *  deployed?" a one-curl question (surfaced on the stats routes).
   *  Absent in local dev / tests. */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };

  // Per-chain RPC URLs — chain-event scan + live-ownership multicalls.
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
  RPC_POLYGON_AMOY?: string;

  // 2026-05-08 — cancelled-offer retention in days. Default 30.
  // String → int coerce + clamp at >= 1 inside the prune helper.
  CANCELLED_OFFER_RETENTION_DAYS?: string;

  // T-086 step 14 — resolved OpenSea Listings API key.
  OPENSEA_API_KEY?: string;

  // #335 — per-IP rate-limit binding for the one POST surface
  // this Worker exposes (`POST /loans/:loanId/prepay-listing/
  // match-source`). Cloudflare's built-in `ratelimit` binding,
  // keyed by `CF-Connecting-IP` at request time. When absent
  // (operator hasn't deployed the wrangler.jsonc binding yet)
  // the rate-limit is a no-op; the strict hex validation + the
  // INSERT OR REPLACE conflict policy keep the endpoint
  // defensible without it, but provisioning it is the
  // expected operator action post-merge.
  OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT?: {
    limit: (args: { key: string }) => Promise<{ success: boolean }>;
  };

  // #1131 Rate Desk phase 3 — per-IP rate-limit binding for
  // `POST /signed-offers` (signed-offer book ingest). No-op when the
  // operator hasn't provisioned the wrangler.jsonc binding yet; the
  // strict field validation + local EIP-712 signature verification
  // keep the endpoint defensible without it, but provisioning it is
  // the expected operator action post-merge.
  SIGNED_OFFERS_RATELIMIT?: {
    limit: (args: { key: string }) => Promise<{ success: boolean }>;
  };
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
 * and downstream code already handles `undefined` (skip that chain).
 * (T-078 — PR #36 Codex review.)
 */
export async function readSecret(
  b: SecretBinding | undefined,
  budget?: TickBudget,
): Promise<string | undefined> {
  if (!b) return undefined;
  try {
    // COUNTED WHERE IT HAPPENS (#2221). A Secrets Store read is a binding
    // call, the same class of outbound request as a D1 call, and this Worker
    // makes up to a dozen of them at the top of every cron tick — a material
    // slice of a 50-request allowance, and the slice a pass-scoped counter
    // would never see. Counted here because this is the only line that knows
    // whether a binding was actually present to read.
    //
    // Conservative by intent: if a cached read turns out not to be billed as
    // a subrequest, this counter is high by at most the number of secrets,
    // and a ceiling guard that errs high refuses work it could have done,
    // where one that errs low freezes a chain.
    if (budget) spend(budget);
    return await b.get();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[env] Secrets Store fetch failed; treating as unset:', err);
    return undefined;
  }
}

/**
 * Resolve the raw Worker bindings into the plain `Env` that every
 * downstream function expects. All RPC secrets are fetched in
 * parallel. Call this **once** per request / cron tick, at the
 * Worker entry point — never inside a hot path.
 */
export async function resolveEnv(
  raw: WorkerEnv,
  budget?: TickBudget,
): Promise<Env> {
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
    polyAmoy,
    openSea,
  ] = await Promise.all([
    readSecret(raw.RPC_BASE, budget),
    readSecret(raw.RPC_ETH, budget),
    readSecret(raw.RPC_ARB, budget),
    readSecret(raw.RPC_OP, budget),
    readSecret(raw.RPC_BNB, budget),
    readSecret(raw.RPC_SEPOLIA, budget),
    readSecret(raw.RPC_BASE_SEPOLIA, budget),
    readSecret(raw.RPC_ARB_SEPOLIA, budget),
    readSecret(raw.RPC_OP_SEPOLIA, budget),
    readSecret(raw.RPC_BNB_TESTNET, budget),
    readSecret(raw.RPC_POLYGON_AMOY, budget),
    readSecret(raw.OPENSEA_API_KEY, budget),
  ]);
  return {
    // Through the maintenance seam: the real binding untouched on every
    // ordinary deploy, a refusing stub when it is absent (#2239).
    DB: resolveD1Binding(raw.DB, WORKER_NAME),
    // Resolved HERE because this is the only layer that can see both
    // halves — see the `doIngestEnabled` field doc.
    doIngestEnabled: isDoIngestEnabled(raw),
    CF_VERSION_METADATA: raw.CF_VERSION_METADATA,
    CANCELLED_OFFER_RETENTION_DAYS: raw.CANCELLED_OFFER_RETENTION_DAYS,
    OPENSEA_API_KEY: openSea,
    // #335 — pass through the rate-limit binding from the raw
    // env. Without this the resolved Env never sees the binding
    // even when operators provision it in wrangler.jsonc.
    OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT:
      raw.OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT,
    // #1131 — pass through the signed-offer book rate-limit binding.
    SIGNED_OFFERS_RATELIMIT: raw.SIGNED_OFFERS_RATELIMIT,
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
    RPC_POLYGON_AMOY: polyAmoy,
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
 * out — the indexer's chain scan skips them this tick.
 *
 * Adding a chain = one entry here + matching RPC secret +
 * `contracts/deployments/<slug>/addresses.json` regenerated by the
 * post-deploy export script. No JSON schema change.
 *
 * Polygon Amoy is included here (loanRoutes /loans/by-* paths
 * consult the chain-id → RPC mapping for live-ownership reads).
 * Polygon mainnet stays absent — no Diamond there in Phase 1.
 */
/**
 * Every chain this build KNOWS ABOUT, independent of which RPC secrets
 * happen to resolve on a given tick.
 *
 * `getChainConfigs` filters by secret availability, which is correct for
 * "what can I scan right now" and wrong for anything that must stay
 * stable across a transient Secrets Store failure — such as the
 * round-robin cadence a stored snapshot was captured under. A count taken
 * during an outage is smaller than the rotation that will actually run
 * once secrets recover.
 */
export function getDeployedChainCount(): number {
  return CHAIN_META_IDS.filter((id) => !!getDeployment(id)).length;
}

const CHAIN_META_IDS = [
  8453, 1, 42161, 10, 1101, 56, 84532, 11155111, 421614, 11155420, 80002, 97,
];

/**
 * Every chain id this Worker could ever hold a per-chain Durable Object for.
 *
 * `getChainConfigs` needs the RESOLVED env, because it filters on whether each
 * chain's RPC secret and deployment exist. This list needs neither: it is the
 * superset of `idFromName` keys, and it is what the maintenance path uses to
 * reach DOs without resolving any secrets (#2252 r10).
 *
 * A stale entry here is harmless — addressing a DO that never existed creates
 * an empty one that closes no sockets and does nothing. A MISSING entry is not
 * harmless: that chain's DO would keep its inherited sockets open through a
 * maintenance window, which is the defect the wake exists to prevent. So keep
 * it a superset of `getChainConfigs`'s `meta` ids and err towards including.
 */
export const ALL_CHAIN_IDS: readonly number[] = [
  8453, 1, 42161, 10, 1101, 56,
  84532, 11155111, 421614, 11155420, 80002, 97,
];

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
