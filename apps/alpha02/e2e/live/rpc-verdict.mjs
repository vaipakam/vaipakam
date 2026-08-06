/**
 * How a failed RPC call the PAGE made should be classified by a driver
 * that distinguishes BLOCKED from FAIL.
 *
 * Three outcomes, because the two-way split the drive started with put a
 * real app defect in the same bucket as a flaky network:
 *
 *   'answered'     the EVM ran and rejected the call — a revert. Ordinary
 *                  application-level information; the app is expected to
 *                  handle it and the drive judges the page as normal.
 *   'client-fault' the provider RECEIVED the request and rejected it as
 *                  malformed. That is a positive answer about the
 *                  endpoint — reachable, working — and the fault is the
 *                  PAGE's. It must reach the drive as a product FAIL.
 *   'unreachable'  no answer: rate limited, unavailable, an internal
 *                  provider error, a dead socket. Infrastructure, so the
 *                  drive can conclude nothing about the app.
 *
 * The 'answered' test is an ALLOWLIST on purpose, and the reasoning is
 * the same one `ALLOWED_RPC` is built on: an omission becomes a false
 * BLOCKED, which is loud and harmless, where a denylist's omission
 * becomes a false FAIL blamed on the app. Measured shapes:
 *
 *   revert            RpcRequestError             code=3       answered
 *   revert as -32000  InvalidInputRpcError        code=-32000  answered (bytes)
 *   invalid params    InvalidParamsRpcError       code=-32602  client-fault
 *   rate limited      LimitExceededRpcError       code=-32005  unreachable
 *   unavailable       ResourceUnavailableRpcError code=-32002  unreachable
 *   internal          InternalRpcError            code=-32603  unreachable
 *   unreachable / 503 HttpRequestError            code=absent  unreachable
 *
 * 'client-fault' is the round-21 addition. Before it, a page sending
 * malformed parameters produced `-32602`, was filed as "could not fetch",
 * and the drive exited 2 — reporting an app-generated bad request as an
 * infrastructure problem, and hiding the regression the drive exists to
 * catch.
 *
 * Only the three JSON-RPC codes that mean "your request was malformed"
 * are client faults. `-32601` (method not found) is deliberately NOT one:
 * it describes the SERVER's capability surface, not the request's
 * well-formedness, and a provider that genuinely does not implement a
 * method is an infrastructure fact about that endpoint.
 *
 * Everything is read off the error CHAIN rather than the top-level
 * object, because viem wraps the provider's error and the code and revert
 * data usually sit on an inner cause.
 */

/** EIP-1474 execution error. */
export const EXECUTION_REVERTED = 3;
export const REVERT_BYTES = /^0x([0-9a-fA-F]{2})+$/;

/**
 * JSON-RPC 2.0 codes that mean the server parsed the request and found it
 * malformed. Each is positive evidence that the endpoint answered.
 */
export const JSONRPC_MALFORMED_REQUEST = new Set([
  -32700, // parse error
  -32600, // invalid request
  -32602, // invalid params
]);

/** Walk the viem error chain for the first object carrying a numeric code. */
export function codedError(e) {
  return e?.walk?.((x) => typeof x?.code === 'number') ?? e;
}

/** The first string `data` anywhere on the chain — revert bytes, usually. */
export function revertData(e) {
  const coded = codedError(e);
  return [e?.data, coded?.data, e?.cause?.data].find((d) => typeof d === 'string');
}

/**
 * @returns {'answered' | 'client-fault' | 'unreachable'}
 */
export function classifyRpcFailure(e) {
  const coded = codedError(e);
  const raw = revertData(e);
  // Revert first: bytes are conclusive whatever code carried them, and
  // some providers label a genuine revert -32000.
  if (coded?.code === EXECUTION_REVERTED) return 'answered';
  if (raw !== undefined && REVERT_BYTES.test(raw)) return 'answered';
  if (JSONRPC_MALFORMED_REQUEST.has(coded?.code)) return 'client-fault';
  return 'unreachable';
}

/** Parse, tolerating a Buffer, a string, or nothing at all. */
function parseJson(body) {
  if (body === undefined || body === null) return undefined;
  try {
    return JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Is this request body JSON-RPC? The discriminator for the whole
 * response-side check, and it has to be the REQUEST rather than the
 * response: a rate-limited provider answers `429 Too Many Requests` with
 * a plain-text body, so the response alone cannot tell us an RPC call
 * just failed.
 */
function rpcCalls(requestBody) {
  const parsed = parseJson(requestBody);
  if (parsed === undefined) return undefined;
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (!calls.length) return undefined;
  return calls.every((c) => c && typeof c.jsonrpc === 'string') ? calls : undefined;
}

/**
 * Classify a JSON-RPC response the routed-fetch shim is about to hand
 * back to the page.
 *
 * `classifyRpcFailure` above covers the calls the page makes through the
 * injected wallet, which surface as THROWN errors. The app's wagmi HTTP
 * transport is a second door onto the same question and it does not
 * throw: the provider answers, `fetch` resolves, and a JSON-RPC error
 * body or a 429 rides back to the page as an ordinary response. Fulfilled
 * without a verdict, that made a rate-limited required read look like a
 * missing chooser (a product FAIL, exit 1) and let a rate-limited
 * OPTIONAL read pass silently at exit 0 — the two outcomes the BLOCKED
 * verdict exists to prevent (#1529 review round 22).
 *
 * Two things this must NOT do, both of which a naive "an error body means
 * failure" rule gets wrong:
 *
 *   - This shim serves the WHOLE site — HTML, JS, assets, the app's own
 *     API. Only traffic whose REQUEST is JSON-RPC is judged here;
 *     everything else is somebody else's verdict.
 *   - An ordinary REVERT is delivered as an HTTP 200 carrying a JSON-RPC
 *     error, and the app is expected to handle it. Treating those as
 *     failures would exit non-zero on every healthy run, so the same
 *     three-way `classifyRpcFailure` decides here and 'answered' is
 *     recorded as nothing at all.
 *
 * One entry per verdict per response, not per batch member: `routeFailures`
 * counts page REQUESTS, and a batch is one request.
 *
 * @param {number} status HTTP status of the provider's response.
 * @param {Buffer|string|undefined} body Response body.
 * @param {string|undefined} requestBody The page's request body.
 * @returns {Array<{verdict: 'client-fault' | 'unreachable', why: string}>}
 */
export function classifyRpcResponse(status, body, requestBody) {
  const calls = rpcCalls(requestBody);
  if (!calls) return [];

  // A non-2xx ends it: whatever the body says, the endpoint did not
  // answer the call. This is the 429 / 503 shape, and the one the
  // response body alone could never have revealed.
  if (status < 200 || status >= 300) {
    return [{ verdict: 'unreachable', why: `HTTP ${status} to json-rpc request` }];
  }

  const parsed = parseJson(body);
  if (parsed === undefined) {
    return [
      { verdict: 'unreachable', why: `non-JSON response (HTTP ${status}) to json-rpc request` },
    ];
  }

  // Name the method that failed, not just its code — in a batch the code
  // alone does not say which call it belongs to.
  const methodById = new Map(calls.map((c) => [c.id, c.method]));
  const byVerdict = new Map();
  for (const member of Array.isArray(parsed) ? parsed : [parsed]) {
    const err = member?.error;
    if (!err || typeof err.code !== 'number') continue;
    const verdict = classifyRpcFailure(err);
    if (verdict === 'answered') continue;
    const method = methodById.get(member?.id);
    const label = `${method ? `${method} ` : ''}${err.code}`;
    if (!byVerdict.has(verdict)) byVerdict.set(verdict, new Set());
    byVerdict.get(verdict).add(label);
  }

  return [...byVerdict].map(([verdict, labels]) => ({
    verdict,
    why: `json-rpc ${[...labels].join(', ')}`,
  }));
}

/**
 * File a routed response's verdicts into the driver's two buckets.
 *
 * This exists as a tested function rather than four lines inline at the
 * call site on round 20's lesson: the predicate being right is not the
 * same as it being WIRED right, and sending a client fault to the
 * unreachable bucket would silently restore the exact bug round 22 fixed
 * — an app defect reported as "re-run, the network was flaky".
 *
 * @param {{status: number, body: Buffer|string|undefined,
 *          requestBody: string|undefined, url: string}} response
 * @param {{malformed: Array, unreachable: Array}} buckets
 */
export function recordRpcResponse({ status, body, requestBody, url }, { malformed, unreachable }) {
  for (const v of classifyRpcResponse(status, body, requestBody)) {
    (v.verdict === 'client-fault' ? malformed : unreachable).push({ url, why: v.why });
  }
}
