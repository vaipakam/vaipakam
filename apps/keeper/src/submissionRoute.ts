// apps/keeper/src/submissionRoute.ts
//
// Where the keeper broadcasts its signed transactions, per chain (#3240).
//
// On a chain with a public mempool, a liquidation or a forced sale sent to the
// ordinary RPC can be seen before it lands, and copied or sandwiched. Such a
// chain can be given a PRIVATE submission endpoint (for Ethereum, an endpoint
// like Flashbots Protect) that takes the signed transaction without showing it
// to the public mempool.
//
// The route is per CHAIN, never per pass: every transaction the keeper key
// sends on a chain with a private route goes through it. The key's sends share
// one nonce sequence (`submissionQueue.ts`), and a private endpoint keeps a
// transaction out of the public pending count, so a public send sharing the
// chain would read that count, miss the private one and take its nonce. Only
// the broadcast moves: nonce reads, gas estimates, receipts and every other
// read stay on the chain's ordinary RPC.
//
// Two settings:
//
//  - `PRIVATE_TX_RPCS` (a secret: an endpoint URL can carry an access key):
//    a comma list of `<chainId>=<https URL>` entries. A chain it does not name
//    sends through its ordinary RPC.
//  - `PRIVATE_TX_FALLBACK_CHAIN_IDS` (a plain var): the chains whose private
//    sends may fall back to the ordinary RPC when the private endpoint refuses
//    or does not answer. The fallback sends the SAME signed bytes, so it can
//    never produce a second transaction; it does make that one public. A chain
//    not named here has no fallback: a failed private send is a failed send.
//
// A value that cannot be read sends NOTHING on any chain (each send is refused
// before its nonce is read) and says why. A private route that silently became
// a public one is exactly what the setting exists to prevent, so an unknown
// never reads as "public".
//
// Each tick names every chain's route (`describeSubmissionRoutes`), so the
// run's own log states which route its sends took.

import { parseChainId, parseChainIdList } from './chainIdList';
import type { SecretReadFailed } from './env';
import type { NonceReservations } from './privateNonce';

export const PRIVATE_TX_RPCS_VAR = 'PRIVATE_TX_RPCS';
export const PRIVATE_TX_FALLBACK_VAR = 'PRIVATE_TX_FALLBACK_CHAIN_IDS';

/** How long a nonce remembered after a PRIVATE broadcast outranks the
 *  ordinary RPC's pending count. That count does not see a private
 *  transaction until it is mined, and Flashbots Protect keeps one pending for
 *  up to six minutes; a minute's margin on top. Longer than the public route's
 *  floor, so a slow private send is not overtaken by the next send reusing its
 *  nonce. The cost is the same as the public floor's: if the transaction is
 *  dropped, later sends on the chain wait behind the gap for at most this
 *  long. */
export const PRIVATE_ROUTE_FLOOR_TTL_MS = 7 * 60_000;

/** One chain's route. `host` is the endpoint's provider domain (the last
 *  two labels of its host name, {@link providerDomain}), the only part of
 *  the URL a log line may carry. */
export type SubmissionRoute =
  | { kind: 'public' }
  | { kind: 'private'; url: string; host: string; fallback: boolean };

/** Every chain's route, or why the settings could not be read. */
export type SubmissionRoutes =
  | { routes: ReadonlyMap<number, Extract<SubmissionRoute, { kind: 'private' }>> }
  | { unread: string };

const PUBLIC: SubmissionRoute = { kind: 'public' };

/**
 * The part of an endpoint's host name a log may name: its last two labels
 * (`rpc.flashbots.net` → `flashbots.net`). A provider can put an access key
 * in a subdomain label (`https://<KEY>.rpc.example.org`), which the full host
 * name would leak on every tick (Codex #3275 r3); the provider's own domain
 * is enough to tell which endpoint a chain uses. An IP address, which carries
 * no key, is named whole.
 */
export function providerDomain(hostname: string): string {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[')) return hostname;
  const labels = hostname.split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

/** The routes `rpcs` (`PRIVATE_TX_RPCS`) and `fallback`
 *  (`PRIVATE_TX_FALLBACK_CHAIN_IDS`) state. Entries are described by
 *  position, never echoed. */
export function readSubmissionRoutes(rpcs: string | SecretReadFailed | undefined, fallback: string | undefined): SubmissionRoutes {
  // A secret that is set but could not be fetched is not an empty one: it
  // may name private routes, so nothing is sent (Codex #3275 r1).
  if (typeof rpcs === 'object') return { unread: `${PRIVATE_TX_RPCS_VAR} is set but could not be read` };
  const fallbackRead = parseChainIdList(PRIVATE_TX_FALLBACK_VAR, fallback);
  if ('unread' in fallbackRead) return fallbackRead;
  const routes = new Map<number, Extract<SubmissionRoute, { kind: 'private' }>>();
  const text = (rpcs ?? '').trim();
  if (text !== '') {
    const parts = text.split(',');
    for (let i = 0; i < parts.length; i += 1) {
      const where = `${PRIVATE_TX_RPCS_VAR} entry ${i + 1} of ${parts.length}`;
      const eq = parts[i].indexOf('=');
      if (eq < 0) return { unread: `${where} is not <chainId>=<URL>` };
      const id = parseChainId(parts[i].slice(0, eq));
      if (id === null) return { unread: `${where} does not start with a chain id` };
      if (routes.has(id)) return { unread: `${PRIVATE_TX_RPCS_VAR} names chain ${id} twice` };
      let url: URL;
      try {
        url = new URL(parts[i].slice(eq + 1).trim());
      } catch {
        return { unread: `${where} (chain ${id}) is not a URL` };
      }
      if (url.protocol !== 'https:') return { unread: `${where} (chain ${id}) is not an https URL` };
      routes.set(id, { kind: 'private', url: url.toString(), host: providerDomain(url.hostname), fallback: fallbackRead.chains.has(id) });
    }
  }
  for (const id of fallbackRead.chains) {
    if (!routes.has(id)) {
      return { unread: `${PRIVATE_TX_FALLBACK_VAR} names chain ${id}, which has no private route in ${PRIVATE_TX_RPCS_VAR}` };
    }
  }
  return { routes };
}

/** `chainId`'s route under `routes`, or why none can be given. */
export function submissionRouteFor(routes: SubmissionRoutes, chainId: number): SubmissionRoute | { unread: string } {
  if ('unread' in routes) return routes;
  return routes.routes.get(chainId) ?? PUBLIC;
}

/** How one route reads in a log line. */
export function describeRoute(route: SubmissionRoute | { unread: string }): string {
  if ('unread' in route) return `nothing is sent (${route.unread})`;
  if (route.kind === 'public') return 'public RPC';
  return `private via ${route.host}, ${route.fallback ? 'falling back to the public RPC when it fails' : 'no fallback'}`;
}

/** The tick's line: each served chain's route, and any private route for a
 *  chain the keeper does not serve this tick. */
export function describeSubmissionRoutes(routes: SubmissionRoutes, chains: readonly { id: number; name: string }[]): string {
  if ('unread' in routes) return `nothing is sent on any chain: ${routes.unread}`;
  const served = new Set(chains.map((c) => c.id));
  const lines = chains.map((c) => `${c.name}(${c.id}) ${describeRoute(submissionRouteFor(routes, c.id))}`);
  const idle = [...routes.routes.keys()].filter((id) => !served.has(id)).sort((a, b) => a - b);
  if (idle.length > 0) lines.push(`a private route is set for chain${idle.length === 1 ? '' : 's'} ${idle.join(', ')}, which this tick does not serve`);
  return lines.join('; ') || 'no chain served';
}

// The process's routes and nonce records. Armed once per tick, before any
// pass launches (`tick.ts`), from the same resolved settings the tick runs
// with. Never armed (a test, a script) reads as no private route anywhere. A
// private route armed without a nonce record sends nothing on that chain.
let armed: SubmissionRoutes = { routes: new Map() };
let armedReservations: NonceReservations | null = null;

/** Arm `routes`, and the nonce records private sends keep, for every send
 *  this process makes from now on. */
export function armSubmissionRoutes(routes: SubmissionRoutes, reservations: NonceReservations | null = null): void {
  armed = routes;
  armedReservations = reservations;
}

/** The armed route for `chainId`. */
export function armedSubmissionRoute(chainId: number): SubmissionRoute | { unread: string } {
  return submissionRouteFor(armed, chainId);
}

/** The armed nonce records, or null when none is armed. */
export function armedNonceReservations(): NonceReservations | null {
  return armedReservations;
}

/** Test seam: back to no private route anywhere. */
export function resetSubmissionRoutes(): void {
  armed = { routes: new Map() };
  armedReservations = null;
}
