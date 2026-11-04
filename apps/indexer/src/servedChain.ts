/**
 * #1140 — which chain a request names, and whether this Worker serves it.
 *
 * ONE rule for every chain-keyed route on the loan, offer and signed-offer
 * surfaces: a request for a chain this Worker is not indexing gets a 503
 * `chain-not-configured`, never an empty or stale 200. An empty 200 reads as
 * "nothing here" — no fills, no live markets, no loans — and a consumer
 * honouring the tri-state convention renders that as an honest empty state,
 * or caches it and never falls back to the chain. The truth is "this chain
 * is not being served here", which the consumer renders as unavailable.
 *
 * "Served" is `getChainConfigs(env)` membership, NOT just a deployment
 * artifact: the scanner runs a chain only when it has BOTH a deployment AND
 * an RPC secret bound, so a deployed-but-disabled chain, an RPC or Secrets
 * Store outage, or a stray local 31337 artifact is excluded (Codex #768).
 * `env` must therefore be the RESOLVED env (the dispatcher calls
 * `resolveEnv` before these routes), so the RPC bindings are populated.
 *
 * Before this module the predicate and the parser were written out per route
 * module (three copies of the guard, five of the parser) and applied by hand
 * per handler; eight read routes had been missed. A structural test
 * (`servedChain.test.ts`) now requires every handler on those surfaces that
 * reads a chain id to ask `chainNotServed`, so a new route cannot miss it.
 *
 * `/config/:chainId` follows the same rule (its last row for a chain no
 * longer indexed would otherwise be served as a live snapshot).
 *
 * The two reward metrics follow it too (#2654), so a figure for a chain
 * nobody is indexing is never served as current:
 *  - `/metrics/loop-closure` runs after `resolveEnv` and asks
 *    `chainNotServed`, like every route above.
 *  - `/metrics/recycling` is dispatched BEFORE `resolveEnv` (it must not
 *    wait on the Secrets Store), so it cannot ask whether the RPC secret
 *    resolves. It asks `chainNotConfigured` instead: the chain has a
 *    deployment artifact and its RPC binding is present
 *    (`configuredScanChains`, read without resolving any secret). That
 *    refuses a retired chain or one never set up. A configured chain whose
 *    secret fails still answers from its stored series; `/health/ingest`
 *    is what reports that stall, and the series' own day coverage says
 *    where its record ends.
 */
import { configuredScanChains, type Env, getChainConfigs } from './env';

/** The chain a route assumes when the request names none. Kept as it has
 *  always been on these routes, so a client omitting `chainId` sees no
 *  change in which chain it asked for. */
export const DEFAULT_CHAIN_ID = 8453;

/** A positive decimal chain id, or null when absent or malformed. */
export function parseChainId(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The chain a GET names in its `chainId` query, or the default. A
 *  malformed value falls back to the default, as it always has. */
export function requestedChainId(url: URL): number {
  return parseChainId(url.searchParams.get('chainId')) ?? DEFAULT_CHAIN_ID;
}

/** Whether this Worker indexes `chainId` — see the module header. A throw
 *  from the config read counts as not served (fail closed). */
export function chainServed(env: Env, chainId: number): boolean {
  try {
    return getChainConfigs(env).some((c) => c.id === chainId);
  } catch {
    return false;
  }
}

/**
 * The 503 a route returns for a chain it does not serve, or null when it
 * does. Call it after the route's own parameter validation (a malformed
 * request is a 400 whatever the chain) and before any D1 read.
 */
export function chainNotServed(env: Env, chainId: number): Response | null {
  return chainServed(env, chainId) ? null : chainUnavailable();
}

/**
 * The same 503 for a route dispatched BEFORE `resolveEnv`: refused unless
 * the chain is configured to be scanned (a deployment artifact and a present
 * RPC binding), read from the raw env without resolving any secret. See the
 * module header for what that does and does not establish.
 */
export function chainNotConfigured(raw: object, chainId: number): Response | null {
  return configuredScanChains(raw).includes(chainId) ? null : chainUnavailable();
}

/** The one response both guards return. */
function chainUnavailable(): Response {
  return new Response(JSON.stringify({ error: 'chain-not-configured' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=10',
    },
  });
}
