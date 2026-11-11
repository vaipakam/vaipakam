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
// Three settings:
//
//  - `PRIVATE_TX_RPCS` (a secret: an endpoint URL can carry an access key):
//    a comma list of `<chainId>=<https URL>` entries, or
//    `<chainId>/eth_sendPrivateTransaction=<https URL>` for a provider whose
//    private submission is that JSON-RPC method rather than an ordinary
//    `eth_sendRawTransaction` (#3408: on Ethereum, the private-transaction
//    method of the RPC provider the keeper already uses). A chain may be named
//    more than once: its endpoints are tried in the order written, each with
//    the SAME signed bytes, so a later endpoint is a fallback for an earlier
//    one that refuses or does not answer. A chain it does not name sends
//    through its ordinary RPC.
//  - `PRIVATE_TX_FALLBACK_CHAIN_IDS` (a plain var): the chains whose private
//    sends may fall back to the ordinary RPC. The fallback sends the SAME
//    signed bytes, so it can never produce a second transaction; it does make
//    that one public, and each fallback raises an ops alert. It happens in two
//    cases: every private endpoint refused or did not answer, or a send the
//    private route accepted was still not mined after the stated time below
//    (`privateRebroadcast.ts`). A chain not named here has no fallback: a
//    failed private send is a failed send, and an accepted one waits as long
//    as the private route keeps it.
//  - `PRIVATE_TX_PUBLIC_AFTER_SECONDS` (a plain var): that stated time, from
//    the private route's acceptance, 24 to 300 seconds, default 60. It
//    stays below the private nonce window (seven minutes) with room for a
//    tick, so the public copy goes out while the nonce is
//    still held for it.
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
export const PRIVATE_TX_PUBLIC_AFTER_VAR = 'PRIVATE_TX_PUBLIC_AFTER_SECONDS';

/** How long a nonce remembered after a PRIVATE broadcast outranks the
 *  ordinary RPC's pending count. That count does not see a private
 *  transaction until it is mined, and Flashbots Protect keeps one pending for
 *  up to six minutes; a minute's margin on top. Longer than the public route's
 *  floor, so a slow private send is not overtaken by the next send reusing its
 *  nonce. The cost is the same as the public floor's: if the transaction is
 *  dropped, later sends on the chain wait behind the gap for at most this
 *  long. */
export const PRIVATE_ROUTE_FLOOR_TTL_MS = 7 * 60_000;

/** The bounds and default of {@link PRIVATE_TX_PUBLIC_AFTER_VAR}. The floor is
 *  two Ethereum blocks; the ceiling leaves two minutes of the nonce window for
 *  the tick that sends the public copy. */
export const PUBLIC_AFTER_MIN_SEC = 24;
export const PUBLIC_AFTER_MAX_SEC = 300;
export const PUBLIC_AFTER_DEFAULT_SEC = 60;

/** How long one private endpoint has to answer a broadcast before the next
 *  endpoint (or the public fallback) is tried. No answer is not a refusal:
 *  the endpoint may still relay the bytes, which is why every later attempt
 *  sends the same ones. */
export const PRIVATE_ENDPOINT_ANSWER_TIMEOUT_MS = 8_000;

/** The JSON-RPC methods a private endpoint may be called with. */
export const PRIVATE_METHODS = ['eth_sendRawTransaction', 'eth_sendPrivateTransaction'] as const;
export type PrivateMethod = (typeof PRIVATE_METHODS)[number];

/** One private endpoint. `host` is its provider domain (the last two labels of
 *  its host name, {@link providerDomain}), the only part of the URL a log line
 *  may carry. */
export interface PrivateEndpoint {
  url: string;
  host: string;
  method: PrivateMethod;
}

/** One chain's route. A private route's endpoints are tried in order;
 *  `publicAfterMs` is read only where `fallback` allows the public copy. */
export type SubmissionRoute =
  | { kind: 'public' }
  | { kind: 'private'; endpoints: readonly PrivateEndpoint[]; fallback: boolean; publicAfterMs: number };

export type PrivateRoute = Extract<SubmissionRoute, { kind: 'private' }>;

/** Every chain's route, or why the settings could not be read. */
export type SubmissionRoutes = { routes: ReadonlyMap<number, PrivateRoute> } | { unread: string };

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

/** The seconds `raw` (`PRIVATE_TX_PUBLIC_AFTER_SECONDS`) states, or why it
 *  could not be read. Unset is the default. */
export function readPublicAfterSeconds(raw: string | undefined): { seconds: number } | { unread: string } {
  const text = (raw ?? '').trim();
  if (text === '') return { seconds: PUBLIC_AFTER_DEFAULT_SEC };
  if (!/^\d+$/.test(text)) return { unread: `${PRIVATE_TX_PUBLIC_AFTER_VAR} is not a whole number of seconds` };
  const n = Number(text);
  if (n < PUBLIC_AFTER_MIN_SEC || n > PUBLIC_AFTER_MAX_SEC) {
    return { unread: `${PRIVATE_TX_PUBLIC_AFTER_VAR} is outside ${PUBLIC_AFTER_MIN_SEC}..${PUBLIC_AFTER_MAX_SEC} seconds` };
  }
  return { seconds: n };
}

/** The routes `rpcs` (`PRIVATE_TX_RPCS`), `fallback`
 *  (`PRIVATE_TX_FALLBACK_CHAIN_IDS`) and `publicAfter`
 *  (`PRIVATE_TX_PUBLIC_AFTER_SECONDS`) state. Entries are described by
 *  position, never echoed. */
export function readSubmissionRoutes(
  rpcs: string | SecretReadFailed | undefined,
  fallback: string | undefined,
  publicAfter?: string,
): SubmissionRoutes {
  // A secret that is set but could not be fetched is not an empty one: it
  // may name private routes, so nothing is sent (Codex #3275 r1).
  if (typeof rpcs === 'object') return { unread: `${PRIVATE_TX_RPCS_VAR} is set but could not be read` };
  const fallbackRead = parseChainIdList(PRIVATE_TX_FALLBACK_VAR, fallback);
  if ('unread' in fallbackRead) return fallbackRead;
  const after = readPublicAfterSeconds(publicAfter);
  if ('unread' in after) return after;
  const endpoints = new Map<number, PrivateEndpoint[]>();
  const text = (rpcs ?? '').trim();
  if (text !== '') {
    const parts = text.split(',');
    for (let i = 0; i < parts.length; i += 1) {
      const where = `${PRIVATE_TX_RPCS_VAR} entry ${i + 1} of ${parts.length}`;
      const eq = parts[i].indexOf('=');
      if (eq < 0) return { unread: `${where} is not <chainId>=<URL>` };
      const head = parts[i].slice(0, eq);
      const slash = head.indexOf('/');
      const id = parseChainId(slash < 0 ? head : head.slice(0, slash));
      if (id === null) return { unread: `${where} does not start with a chain id` };
      const methodText = slash < 0 ? 'eth_sendRawTransaction' : head.slice(slash + 1).trim();
      const method = PRIVATE_METHODS.find((m) => m === methodText);
      if (!method) return { unread: `${where} (chain ${id}) names a method other than ${PRIVATE_METHODS.join(' or ')}` };
      let url: URL;
      try {
        url = new URL(parts[i].slice(eq + 1).trim());
      } catch {
        return { unread: `${where} (chain ${id}) is not a URL` };
      }
      if (url.protocol !== 'https:') return { unread: `${where} (chain ${id}) is not an https URL` };
      const list = endpoints.get(id) ?? [];
      if (list.some((e) => e.url === url.toString())) {
        return { unread: `${PRIVATE_TX_RPCS_VAR} names one endpoint twice for chain ${id}` };
      }
      list.push({ url: url.toString(), host: providerDomain(url.hostname), method });
      endpoints.set(id, list);
    }
  }
  for (const id of fallbackRead.chains) {
    if (!endpoints.has(id)) {
      return { unread: `${PRIVATE_TX_FALLBACK_VAR} names chain ${id}, which has no private route in ${PRIVATE_TX_RPCS_VAR}` };
    }
  }
  const routes = new Map<number, PrivateRoute>();
  for (const [id, list] of endpoints) {
    routes.set(id, { kind: 'private', endpoints: list, fallback: fallbackRead.chains.has(id), publicAfterMs: after.seconds * 1000 });
  }
  return { routes };
}

/** `chainId`'s route under `routes`, or why none can be given. */
export function submissionRouteFor(routes: SubmissionRoutes, chainId: number): SubmissionRoute | { unread: string } {
  if ('unread' in routes) return routes;
  return routes.routes.get(chainId) ?? PUBLIC;
}

/** How one endpoint reads in a log line: its provider domain, and the method
 *  where it is not the ordinary one. */
export function describeEndpoint(e: PrivateEndpoint): string {
  return e.method === 'eth_sendRawTransaction' ? e.host : `${e.host} (${e.method})`;
}

/** How one route reads in a log line. */
export function describeRoute(route: SubmissionRoute | { unread: string }): string {
  if ('unread' in route) return `nothing is sent (${route.unread})`;
  if (route.kind === 'public') return 'public RPC';
  const via = route.endpoints.map(describeEndpoint).join(', then ');
  return route.fallback
    ? `private via ${via}, falling back to the public RPC when every private endpoint fails or ${route.publicAfterMs / 1000} s after an accepted send is still unmined`
    : `private via ${via}, no fallback`;
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

/** A private send the route ACCEPTED, as the inclusion fallback records it
 *  (`privateRebroadcast.ts`). */
export interface AcceptedPrivateSend {
  chainId: number;
  address: `0x${string}`;
  nonce: number;
  hash: `0x${string}`;
  serialized: `0x${string}`;
  atMs: number;
}

/** What a private broadcast reports to the rest of the keeper (#3408). Both
 *  are armed with the routes and absent in a test or a script. */
export interface SubmissionRouteEvents {
  /** Record an accepted private send on a chain with a fallback, so a copy
   *  can go public if it is still unmined after the stated time. Awaited:
   *  a failure is the caller's to log, never a failed send. */
  privateAccepted(send: AcceptedPrivateSend): Promise<void>;
  /** Tell the operator that a send went public. Not awaited by the send. */
  publicFallback(chainId: number, line: string): Promise<void>;
}

// The process's routes and nonce records. Armed once per tick, before any
// pass launches (`tick.ts`), from the same resolved settings the tick runs
// with. Never armed (a test, a script) reads as no private route anywhere. A
// private route armed without a nonce record sends nothing on that chain.
let armed: SubmissionRoutes = { routes: new Map() };
let armedReservations: NonceReservations | null = null;
let armedEvents: SubmissionRouteEvents | null = null;

/** Arm `routes`, the nonce records private sends keep, and where a private
 *  broadcast reports (#3408), for every send this process makes from now on. */
export function armSubmissionRoutes(
  routes: SubmissionRoutes,
  reservations: NonceReservations | null = null,
  events: SubmissionRouteEvents | null = null,
): void {
  armed = routes;
  armedReservations = reservations;
  armedEvents = events;
}

/** The armed routes, whole: the inclusion fallback walks them. */
export function armedSubmissionRoutes(): SubmissionRoutes {
  return armed;
}

/** Where a private broadcast reports, or null when nothing is armed. */
export function armedRouteEvents(): SubmissionRouteEvents | null {
  return armedEvents;
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
  armedEvents = null;
}
