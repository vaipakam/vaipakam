import type { QueryClient } from "@tanstack/react-query";
import type { Transport } from "viem";

/**
 * #1672 — the app's own answer to "was a read left unserved?", for a
 * live-review driver.
 *
 * The live drives watch every RPC attempt the deployed page makes and
 * used to reconstruct from that wire traffic which reads the page never
 * got. That cannot be done soundly: viem retries a failed request, gives
 * the retry a fresh JSON-RPC id and may move it to a fallback endpoint,
 * so no rule over the attempts can tell a recovered retry from a read the
 * page went without.
 *
 * The app can say, from three places, and reports all of them:
 *
 *   - ITS RPC TRANSPORT ({@link probeTransport}). Every chain read the app
 *     makes goes through the transports `chain/wagmi.ts` builds, and the
 *     transport's `request` resolves or rejects once, after viem's own
 *     retries and fallbacks. So each request's FINAL outcome is known
 *     there, with its method — including a read a hook then degrades into
 *     a value (`null` for "unavailable"), which the query cache records as
 *     a success and could never report.
 *   - ITS QUERY CACHE ({@link attachReadProbe}). A query that fails for a
 *     reason that is not an RPC failure (a decode error, an exception in
 *     its own code) settles in error there, once its retries are spent.
 *     The cache also says when a query is WAITING to retry, so a driver
 *     can wait for that to settle instead of mistaking it for a served
 *     read.
 *   - ITS INDEXER FETCH ({@link probeIndexerRead}, #2784). Every indexer
 *     read goes through `getJson` in `data/indexer.ts`, which turns any
 *     failure into `null` and the page into an "unavailable" state. A
 *     hook's `null` is a success to the query cache, so only the fetch
 *     itself can say the read went unserved, and why.
 *
 * INERT unless a function named {@link READ_PROBE_BINDING} exists on the
 * page before the app starts (a driver installs it with Playwright's
 * `exposeBinding`, which runs before any page script). In normal use
 * nothing is installed: the transports are returned unwrapped and the
 * cache is not subscribed.
 *
 * What it sends is a SUMMARY: an RPC request's method and outcome, a
 * query's key and outcome, an indexer read's route and outcome, and an
 * error's cause chain reduced to names, codes, revert data and the short
 * message. Never a request's parameters or a response's result: an
 * indexer route keeps its path words and query names, and every value
 * (an address, an id, a query value) is replaced (see {@link indexerRoute}). A script able to install the function could
 * already watch these reads itself, so the report gives it nothing new;
 * it is read-only and cannot change any read.
 *
 * The short message is the one viem writes for a person (`shortMessage`),
 * never the long one, which for an HTTP failure carries the RPC URL and
 * with it a provider key.
 */

/** The page global a driver installs before load (#1672). */
export const READ_PROBE_BINDING = "__vaipakamReadProbe";

/**
 * The report's shape version. A driver refuses a version it does not
 * know rather than guessing at fields.
 */
export const READ_PROBE_VERSION = 2;

/** One link of an error's cause chain, outermost first. */
export interface ReadProbeErrorLink {
  name?: string;
  code?: number;
  /** Revert data or similar, when the link carries it as a string. */
  data?: string;
  message?: string;
}

type V = typeof READ_PROBE_VERSION;

export type ReadProbeEvent =
  | { v: V; kind: "armed" }
  /** An RPC request left the app's transport. */
  | { v: V; kind: "rpc-start"; seq: number; chainId: number; method: string }
  /** …and came back, once, after viem's retries and fallbacks. */
  | {
      v: V;
      kind: "rpc-settled";
      seq: number;
      chainId: number;
      method: string;
      ok: boolean;
      error?: ReadProbeErrorLink[];
    }
  /** An indexer read left the app's `getJson`. */
  | { v: V; kind: "indexer-start"; seq: number; route: string; chainId?: number }
  /** …and came back, once. `failure` says why a read was not served. */
  | {
      v: V;
      kind: "indexer-settled";
      seq: number;
      route: string;
      chainId?: number;
      ok: boolean;
      failure?: IndexerReadFailure;
      /** The HTTP status, for `failure: "http"`. */
      status?: number;
    }
  /** A query's fetch failed and it will try again. */
  | {
      v: V;
      kind: "query-retrying";
      queryHash: string;
      queryKey: string;
      /** The chain the query's key names, when it names exactly one. */
      chainId?: number;
      failureCount: number;
    }
  /**
   * A query reached an outcome. `error` is sent for every query that
   * settles in error. `ok` and `cancelled` are sent only for a query this
   * report earlier said was retrying, to close that report.
   */
  | {
      v: V;
      kind: "query-settled";
      queryHash: string;
      queryKey: string;
      /** The chain the query's key names, when it names exactly one. */
      chainId?: number;
      outcome: "ok" | "error" | "cancelled";
      failureCount: number;
      /** Whether data from an earlier fetch was still being shown. */
      hadData: boolean;
      error?: ReadProbeErrorLink[];
    };

/**
 * Why an indexer read was not served:
 *   - `unconfigured`: the build names no indexer origin, so nothing was sent;
 *   - `timeout`: no answer within the app's limit;
 *   - `network`: the request did not complete (offline, DNS, CORS, TLS);
 *   - `http`: the indexer answered with a non-2xx status;
 *   - `body`: a 2xx whose body was not JSON.
 */
export type IndexerReadFailure = "unconfigured" | "timeout" | "network" | "http" | "body";

/** One indexer read's outcome, as `data/indexer.ts` observes it. */
export type IndexerReadOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; failure: IndexerReadFailure; status?: number };

const MAX_CHAIN = 8;
const MAX_TEXT = 300;
const MAX_DATA = 1_000;

/** An error's cause chain as plain values the driver can classify. */
export function readProbeErrorChain(err: unknown): ReadProbeErrorLink[] {
  const out: ReadProbeErrorLink[] = [];
  let link: unknown = err;
  while (link !== undefined && link !== null && out.length < MAX_CHAIN) {
    if (typeof link !== "object") {
      out.push({ message: String(link).slice(0, MAX_TEXT) });
      break;
    }
    const e = link as Record<string, unknown>;
    const entry: ReadProbeErrorLink = {};
    if (typeof e.name === "string") entry.name = e.name;
    if (typeof e.code === "number") entry.code = e.code;
    if (typeof e.data === "string") entry.data = e.data.slice(0, MAX_DATA);
    const message =
      typeof e.shortMessage === "string" ? e.shortMessage : undefined;
    if (message !== undefined) entry.message = message.slice(0, MAX_TEXT);
    out.push(entry);
    if (e.cause === link) break;
    link = e.cause;
  }
  return out;
}

/** The key as JSON; a key this cannot write is named as such. */
function keyText(key: unknown): string {
  try {
    return JSON.stringify(key, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } catch {
    return "(unserialisable query key)";
  }
}

/**
 * The chain a query reads, as its key states it: wagmi puts the options
 * object, `chainId` included, in the key, and the app's own keys do the
 * same. A key that names no chain, or more than one, gives `undefined`, and
 * the driver then judges the query against the chain it observes. The
 * chain is never guessed from the query's position or name.
 */
export function queryChainOf(key: unknown): number | undefined {
  if (!Array.isArray(key)) return undefined;
  const named = new Set<number>();
  for (const part of key) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
    const id = (part as Record<string, unknown>).chainId;
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) named.add(id);
  }
  return named.size === 1 ? [...named][0] : undefined;
}

const chainField = (key: unknown): { chainId?: number } => {
  const chainId = queryChainOf(key);
  return chainId === undefined ? {} : { chainId };
};

/**
 * The driver's report function, wrapped so the app never depends on it,
 * or `null` when no driver installed one.
 */
function reporterOf(host: object): ((event: ReadProbeEvent) => void) | null {
  const report = (host as Record<string, unknown>)[READ_PROBE_BINDING];
  if (typeof report !== "function") return null;
  return (event) => {
    try {
      // The binding answers with a promise; a driver gone away must not
      // surface as an unhandled rejection in the app.
      Promise.resolve(report(event)).catch(() => {});
    } catch {
      /* the report is best-effort: the app never depends on it */
    }
  };
}

// One sequence for every transport on the page, so a request is named
// once whichever chain's transport carried it.
let rpcSeq = 0;

/**
 * `transport`, reporting each request's final outcome to the driver, or
 * `transport` itself when no driver is installed.
 *
 * Wraps the transport's own `request`, which viem builds with its retry
 * policy inside, so what is reported is the outcome the app's code saw,
 * not each attempt on the wire.
 */
export function probeTransport(
  transport: Transport,
  chainId: number,
  host: object = globalThis,
): Transport {
  const send = reporterOf(host);
  if (!send) return transport;
  const probed: Transport = (config) => {
    const inner = transport(config);
    // Cast: the wrapper returns whatever the inner request resolves to, so
    // its schema-derived return type is the inner one's.
    const request = (async (
      args: Parameters<typeof inner.request>[0],
      options?: Parameters<typeof inner.request>[1],
    ) => {
      const seq = ++rpcSeq;
      const method = String(args.method);
      send({ v: READ_PROBE_VERSION, kind: "rpc-start", seq, chainId, method });
      try {
        const result = await inner.request(args, options);
        send({ v: READ_PROBE_VERSION, kind: "rpc-settled", seq, chainId, method, ok: true });
        return result;
      } catch (err) {
        send({
          v: READ_PROBE_VERSION,
          kind: "rpc-settled",
          seq,
          chainId,
          method,
          ok: false,
          error: readProbeErrorChain(err),
        });
        throw err;
      }
    }) as typeof inner.request;
    return { ...inner, request };
  };
  return probed;
}

/** A path word: letters, then letters, digits or dashes. */
const ROUTE_WORD = /^[a-z][a-z0-9-]*$/i;

/**
 * An indexer path as a route: its path words and query names, with every
 * value replaced, so the report names WHICH read failed without carrying
 * an address, an id or a cursor. `/loans/7?chainId=84532&owner=0xab…`
 * becomes `/loans/:v?chainId=&owner=`.
 */
export function indexerRoute(path: string): string {
  const [pathname = "", query] = path.split("?", 2);
  const words = pathname
    .split("/")
    .map((seg) => (seg === "" || ROUTE_WORD.test(seg) ? seg : ":v"))
    .join("/");
  if (query === undefined) return words;
  const names = query
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => `${pair.split("=", 1)[0]}=`);
  return `${words}?${names.join("&")}`;
}

/** The chain an indexer path names in its `chainId` query, if one. */
function indexerChainOf(path: string): { chainId?: number } {
  const query = path.split("?", 2)[1];
  if (query === undefined) return {};
  const id = Number(new URLSearchParams(query).get("chainId"));
  return Number.isSafeInteger(id) && id > 0 ? { chainId: id } : {};
}

let indexerSeq = 0;

/**
 * Run one indexer read and report its outcome to the driver, if one is
 * installed. `read` is the fetch itself; what it resolves to is returned
 * unchanged, so the probe can never change a read.
 */
export async function probeIndexerRead<T>(
  path: string,
  read: () => Promise<IndexerReadOutcome<T>>,
  host: object = globalThis,
): Promise<IndexerReadOutcome<T>> {
  // Looked up per read (one property read): a driver installs its binding
  // before any page script runs, and nothing is cached that could outlive it.
  const send = reporterOf(host);
  if (!send) return read();
  const seq = ++indexerSeq;
  const route = indexerRoute(path);
  const chain = indexerChainOf(path);
  send({ v: READ_PROBE_VERSION, kind: "indexer-start", seq, route, ...chain });
  const outcome = await read();
  send({
    v: READ_PROBE_VERSION,
    kind: "indexer-settled",
    seq,
    route,
    ...chain,
    ok: outcome.ok,
    ...(outcome.ok
      ? {}
      : { failure: outcome.failure, ...(outcome.status !== undefined ? { status: outcome.status } : {}) }),
  });
  return outcome;
}

/**
 * Subscribe `client`'s query cache to the driver's report, if a driver
 * installed one, and announce that this page reports. Returns the
 * unsubscribe (a no-op when inert).
 */
export function attachReadProbe(
  client: QueryClient,
  host: object = globalThis,
): () => void {
  const send = reporterOf(host);
  if (!send) return () => {};
  send({ v: READ_PROBE_VERSION, kind: "armed" });
  const retrying = new Set<string>();
  return client.getQueryCache().subscribe((event) => {
    const { query } = event;
    const settle = (outcome: "ok" | "error" | "cancelled", error?: unknown) => {
      retrying.delete(query.queryHash);
      send({
        v: READ_PROBE_VERSION,
        kind: "query-settled",
        queryHash: query.queryHash,
        queryKey: keyText(query.queryKey),
        ...chainField(query.queryKey),
        outcome,
        failureCount: query.state.fetchFailureCount,
        hadData: query.state.data !== undefined,
        ...(outcome === "error" ? { error: readProbeErrorChain(error) } : {}),
      });
    };
    // A query dropped from the cache mid-retry will not settle.
    if (event.type === "removed") {
      if (retrying.has(query.queryHash)) settle("cancelled");
      return;
    }
    if (event.type !== "updated") return;
    const { action } = event;
    // `failed` is dispatched for an attempt that will be retried, `error`
    // once the retry policy is spent.
    if (action.type === "failed") {
      retrying.add(query.queryHash);
      send({
        v: READ_PROBE_VERSION,
        kind: "query-retrying",
        queryHash: query.queryHash,
        queryKey: keyText(query.queryKey),
        ...chainField(query.queryKey),
        failureCount: action.failureCount,
      });
      return;
    }
    if (action.type === "error") {
      settle("error", action.error);
      return;
    }
    // A retrying query that went idle any other way: it succeeded, or a
    // cancellation reverted it (which dispatches no `error`).
    if (retrying.has(query.queryHash) && query.state.fetchStatus === "idle") {
      settle(action.type === "success" ? "ok" : "cancelled");
    }
  });
}
