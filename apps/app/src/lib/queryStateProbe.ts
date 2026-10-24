import type { QueryClient } from "@tanstack/react-query";

/**
 * #1672 — the app's own answer to "was a read left unserved?", for a
 * live-review driver.
 *
 * The live drives watch every RPC attempt the deployed page makes and
 * used to reconstruct from that wire traffic which reads the page never
 * got. That cannot be done soundly: viem gives a retry a fresh JSON-RPC
 * id, two concurrent reads of the same data are byte-identical, and a
 * retry chain's gaps overlap a poll's cadence, so no rule over the wire
 * can tell a recovered retry from a read the page consumed as a failure.
 * The query cache can: it owns the retry policy, and a query that
 * exhausted it settles in error, once, whatever happened on the wire.
 *
 * So the app reports those settlements to a driver that asked for them.
 * INERT unless a function named {@link QUERY_PROBE_BINDING} exists on the
 * page before the app starts (a driver installs it with Playwright's
 * `exposeBinding`, which runs before any page script). In normal use
 * nothing is installed, so nothing is subscribed and nothing is sent.
 *
 * What it sends is a SUMMARY of the page's own failed reads — the query
 * key, how many fetch attempts failed, whether earlier data was still on
 * screen, and the error's cause chain reduced to names, codes, revert
 * data and the short message. A script able to install the function
 * could already watch those reads itself, so the report gives it nothing
 * new; it is read-only and cannot change any query.
 *
 * The short message is the one viem writes for a person (`shortMessage`),
 * never the long one, which for an HTTP failure carries the RPC URL and
 * with it a provider key.
 */

/** The page global a driver installs before load (#1672). */
export const QUERY_PROBE_BINDING = "__vaipakamQueryProbe";

/**
 * The report's shape version. A driver refuses a version it does not
 * know rather than guessing at fields.
 */
export const QUERY_PROBE_VERSION = 1;

/** One link of an error's cause chain, outermost first. */
export interface QueryProbeErrorLink {
  name?: string;
  code?: number;
  /** Revert data or similar, when the link carries it as a string. */
  data?: string;
  message?: string;
}

export type QueryProbeEvent =
  | { v: typeof QUERY_PROBE_VERSION; kind: "armed" }
  | {
      v: typeof QUERY_PROBE_VERSION;
      kind: "settled-error";
      queryHash: string;
      /** The query key as JSON, bigints written as decimal strings. */
      queryKey: string;
      /** Fetch attempts that failed on the way to this settlement. */
      failureCount: number;
      /** Whether data from an earlier fetch was still being shown. */
      hadData: boolean;
      error: QueryProbeErrorLink[];
    };

const MAX_CHAIN = 8;
const MAX_TEXT = 300;
const MAX_DATA = 1_000;

/** An error's cause chain as plain values the driver can classify. */
export function queryProbeErrorChain(err: unknown): QueryProbeErrorLink[] {
  const out: QueryProbeErrorLink[] = [];
  let link: unknown = err;
  while (link !== undefined && link !== null && out.length < MAX_CHAIN) {
    if (typeof link !== "object") {
      out.push({ message: String(link).slice(0, MAX_TEXT) });
      break;
    }
    const e = link as Record<string, unknown>;
    const entry: QueryProbeErrorLink = {};
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
 * Subscribe `client`'s query cache to the driver's report, if a driver
 * installed one. Returns the unsubscribe (a no-op when inert).
 */
export function attachQueryStateProbe(
  client: QueryClient,
  host: object = globalThis,
): () => void {
  const report = (host as Record<string, unknown>)[QUERY_PROBE_BINDING];
  if (typeof report !== "function") return () => {};
  const send = (event: QueryProbeEvent) => {
    try {
      // The binding answers with a promise; a driver gone away must not
      // surface as an unhandled rejection in the app.
      Promise.resolve(report(event)).catch(() => {});
    } catch {
      /* the report is best-effort: the app never depends on it */
    }
  };
  send({ v: QUERY_PROBE_VERSION, kind: "armed" });
  return client.getQueryCache().subscribe((event) => {
    // A settlement in error is dispatched once, after the query's retry
    // policy is spent. A cancellation that reverts dispatches nothing.
    if (event.type !== "updated" || event.action.type !== "error") return;
    const { query } = event;
    send({
      v: QUERY_PROBE_VERSION,
      kind: "settled-error",
      queryHash: query.queryHash,
      queryKey: keyText(query.queryKey),
      failureCount: query.state.fetchFailureCount,
      hadData: query.state.data !== undefined,
      error: queryProbeErrorChain(event.action.error),
    });
  });
}
