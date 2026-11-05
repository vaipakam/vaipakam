// Which first-party POSTs are the read-only RPC proxy (#1724).
//
// The read-only route guard in `driver.mjs` refuses every non-GET request
// aimed at one of our own surfaces, because our Workers are what a request
// from this app can actually mutate, and a JSON-RPC-shaped body bolted onto
// a POST is not proof of a read (Codex #1894 r7). That rule predates the
// proxy. Since 2026-11-04 the connected app's production build reads every
// chain through `rpc.vaipakam.com`, which is ours, so a read-only drive
// refused each page read as an "unknown mutating request" before ever
// looking at its methods, and every read-only drive on a proxied build
// reported FAIL with no write attempted.
//
// The proxy is a JSON-RPC endpoint and nothing else. It answers
// `POST /rpc/<chainId>` and forwards only a fixed list of reads. So it is
// treated as an RPC endpoint and goes through the SAME method check as a
// third-party provider: a write still fails as `json-rpc
// eth_sendTransaction`, and a method outside READ_METHODS still fails.
// What is exempted is one host AND that one path shape, not the host:
// any other path on it, a query string, or another scheme stays a
// first-party mutating request.
//
//   import { makeIsRpcProxyEndpoint } from './rpcProxyRoute.mjs';
//   const isRpcProxyEndpoint = makeIsRpcProxyEndpoint(process.env.RPC_PROXY_ORIGIN);

/** The proxy the production build reads through (`VITE_RPC_PROXY_ORIGIN`). */
export const DEFAULT_RPC_PROXY_ORIGIN = 'https://rpc.vaipakam.com';

const RPC_PATH = /^\/rpc\/[0-9]+$/;

/**
 * @param {string | undefined} origin - `RPC_PROXY_ORIGIN`, or unset for the
 *   production proxy. An origin that does not parse, or carries a path, a
 *   query or credentials, exempts nothing: a drive pointed at the wrong
 *   proxy then refuses its reads loudly instead of trusting another host.
 * @returns {(rawUrl: string) => boolean}
 */
export function makeIsRpcProxyEndpoint(origin) {
  const raw = origin === undefined || origin === '' ? DEFAULT_RPC_PROXY_ORIGIN : origin;
  let proxy;
  try {
    proxy = new URL(raw);
  } catch {
    return () => false;
  }
  if (
    proxy.protocol !== 'https:' ||
    proxy.pathname !== '/' ||
    proxy.search ||
    proxy.hash ||
    proxy.username ||
    proxy.password
  ) {
    return () => false;
  }
  // Same normalisation as the guard's `hostOf`: lower case, root dot off.
  const host = proxy.host.toLowerCase().replace(/\.$/, '');
  return function isRpcProxyEndpoint(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password || u.search || u.hash) return false;
    if (u.host.toLowerCase().replace(/\.$/, '') !== host) return false;
    return RPC_PATH.test(u.pathname);
  };
}
