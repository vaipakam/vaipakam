/** Fail chosen contract reads the PAGE makes, and pass every other call
 *  through untouched (#2089).
 *
 *  Some card states exist only while one read is failing: the forced
 *  close-out stays on screen, unsubmittable, while its sale-hold check is
 *  unanswered. On a healthy chain that read never fails, so the state is
 *  unreachable without making it fail — and failing the whole RPC would
 *  test a different thing (every read unread), not this one.
 *
 *  A read reaches the node in one of two shapes, and the fault handles both:
 *
 *  - **On its own**, as an `eth_call` whose calldata is the read. It is
 *    answered with a JSON-RPC error under its own id. The app's HTTP
 *    transport batches same-tick calls into one JSON-RPC array, so the
 *    other calls in that array are forwarded to the node as their own batch.
 *  - **Folded into a Multicall3 `aggregate3`**, which is what wagmi's client
 *    does by default with same-tick `readContract`s (`batch.multicall`).
 *    The first version of this fault matched only the first shape, saw the
 *    read go past inside an aggregate, and failed nothing. Here the matching
 *    calls inside the aggregate are pointed at a selector the Diamond does
 *    not route, so the node runs the aggregate with exactly those calls
 *    reverting and every other call answered as usual. The app's batch
 *    scheduler then fails that one read and no other.
 *
 *  A revert and a provider error differ to some readers; for the reads this
 *  is used on (a capability probe whose every failure means "not answered")
 *  they are the same, and the spec says which read it fails.
 *
 *  Only the page's traffic is affected: the spec's own `pub` client talks to
 *  the node directly.
 */
import type { Page, Route } from '@playwright/test';
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { ANVIL_URL } from './anvil';

export interface RpcCall {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown[];
}

/** A read's calldata: starts with `selector` and contains every one of
 *  `includes` (hex, no 0x; compared lower-case). */
export function callDataMatching(selector: `0x${string}`, includes: string[] = []) {
  const sel = selector.toLowerCase();
  return (data: string): boolean => {
    const d = data.toLowerCase();
    return d.startsWith(sel) && includes.every((part) => d.includes(part.toLowerCase()));
  };
}

const AGGREGATE3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])',
]);
const AGGREGATE3_SELECTOR = '0x82ad56cb';
/** No facet routes it, so the Diamond's fallback reverts the call. */
const UNROUTED_CALLDATA: Hex = '0xdeadbeef';

function callData(call: RpcCall): string | null {
  if (call.method !== 'eth_call') return null;
  const tx = call.params?.[0] as { data?: string; input?: string } | undefined;
  return tx?.data ?? tx?.input ?? null;
}

/** Install the fault on `page`. Returns how many reads it has failed so
 *  far, so a spec can prove the fault was actually exercised, and a
 *  remover. */
export async function failRpcCalls(
  page: Page,
  matches: (data: string) => boolean,
): Promise<{ failed: () => number; remove: () => Promise<void> }> {
  let failed = 0;
  const pattern = (u: URL) => u.origin === new URL(ANVIL_URL).origin;

  /** `call` with any matching read inside an aggregate made to revert, or
   *  null when it carries none. */
  const withInnerFaults = (call: RpcCall): RpcCall | null => {
    const data = callData(call);
    if (!data || !data.toLowerCase().startsWith(AGGREGATE3_SELECTOR)) return null;
    const { args } = decodeFunctionData({ abi: AGGREGATE3_ABI, data: data as Hex });
    let hits = 0;
    const calls = args[0].map((c) => {
      if (!matches(c.callData)) return c;
      hits += 1;
      return { ...c, callData: UNROUTED_CALLDATA };
    });
    if (hits === 0) return null;
    failed += hits;
    const tx = call.params![0] as Record<string, unknown>;
    const rewritten = encodeFunctionData({
      abi: AGGREGATE3_ABI,
      functionName: 'aggregate3',
      args: [calls],
    });
    const { input: _input, ...rest } = tx;
    return {
      ...call,
      params: [{ ...rest, data: rewritten }, ...call.params!.slice(1)],
    };
  };

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
    const direct = calls.map((c) => {
      const data = callData(c);
      return data !== null && matches(data);
    });
    const forwarded = calls.map((c, i) => (direct[i] ? null : (withInnerFaults(c) ?? c)));
    const touched = direct.some(Boolean) || forwarded.some((c, i) => c !== calls[i] && c !== null);
    if (!touched) return route.fallback();
    failed += direct.filter(Boolean).length;
    const errorFor = (c: RpcCall) => ({
      jsonrpc: '2.0',
      id: c.id ?? null,
      error: { code: -32603, message: 'injected by the e2e fault (#2089)' },
    });
    const pass = forwarded.filter((c): c is RpcCall => c !== null);
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
    const out = calls.map((c, i) => (direct[i] ? errorFor(c) : byId.get(c.id)));
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
