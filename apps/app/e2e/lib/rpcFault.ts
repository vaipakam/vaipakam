/** Fail chosen JSON-RPC calls the PAGE makes, and pass every other call
 *  through untouched (#2089).
 *
 *  Some card states exist only while one read is failing: the forced
 *  close-out stays on screen, unsubmittable, while its sale-hold check is
 *  unanswered. On a healthy chain that read never fails, so the state is
 *  unreachable without making it fail — and failing the whole RPC would
 *  test a different thing (every read unread), not this one.
 *
 *  The app's HTTP transport batches same-tick calls into one JSON-RPC array,
 *  so a matching call can arrive beside calls that must still succeed. The
 *  handler forwards the non-matching calls to the node as their own batch
 *  and splices an error response in for each matching one, under its own
 *  id, so the page sees exactly one failed call.
 *
 *  Only the page's traffic is affected: the spec's own `pub` client talks to
 *  the node directly.
 */
import type { Page, Route } from '@playwright/test';
import { ANVIL_URL } from './anvil';

export interface RpcCall {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown[];
}

/** An `eth_call` whose calldata starts with `selector` and contains every
 *  one of `includes` (lower-case hex, no 0x). */
export function ethCallMatching(selector: `0x${string}`, includes: string[] = []) {
  const sel = selector.toLowerCase();
  return (call: RpcCall): boolean => {
    if (call.method !== 'eth_call') return false;
    const tx = call.params?.[0] as { data?: string; input?: string } | undefined;
    const data = (tx?.data ?? tx?.input ?? '').toLowerCase();
    return data.startsWith(sel) && includes.every((part) => data.includes(part.toLowerCase()));
  };
}

/** Install the fault on `page`. Returns how many calls it has failed so
 *  far, so a spec can prove the fault was actually exercised, and a
 *  remover. */
export async function failRpcCalls(
  page: Page,
  matches: (call: RpcCall) => boolean,
): Promise<{ failed: () => number; remove: () => Promise<void> }> {
  let failed = 0;
  const pattern = (u: URL) => u.origin === new URL(ANVIL_URL).origin;
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    let body: RpcCall | RpcCall[];
    try {
      body = JSON.parse(req.postData() ?? '');
    } catch {
      return route.fallback();
    }
    const calls = Array.isArray(body) ? body : [body];
    const hit = calls.map(matches);
    if (!hit.some(Boolean)) return route.fallback();
    failed += hit.filter(Boolean).length;
    const errorFor = (c: RpcCall) => ({
      jsonrpc: '2.0',
      id: c.id ?? null,
      error: { code: -32603, message: 'injected by the e2e fault (#2089)' },
    });
    const pass = calls.filter((_, i) => !hit[i]);
    let passed: RpcCall[] = [];
    if (pass.length > 0) {
      const res = await fetch(ANVIL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pass),
      });
      passed = (await res.json()) as RpcCall[];
    }
    const byId = new Map(passed.map((r) => [r.id, r]));
    const out = calls.map((c, i) => (hit[i] ? errorFor(c) : byId.get(c.id)));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      // The app is served from another origin than the node, so the
      // browser drops a fulfilled response that does not allow it.
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(Array.isArray(body) ? out : out[0]),
    });
  };
  // Matched by origin rather than by path: the transport posts to the bare
  // URL, and a trailing-slash difference must not let a call slip past.
  await page.route(pattern, handler);
  return {
    failed: () => failed,
    remove: () => page.unroute(pattern, handler),
  };
}
