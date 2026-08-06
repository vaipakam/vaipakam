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
 * Identity of a LOGICAL read: the same call retried on the same endpoint,
 * or re-sent to a fallback endpoint, carries the same key.
 *
 * This is what makes a verdict survivable. The shim sees individual HTTP
 * ATTEMPTS, and viem's default `retryCount` is 3 — plus `wagmi.ts` wraps
 * the mainnet reads in `fallback([...])` and the chain reads in
 * `fallback([webSocket, http])`. So a transient 429 that viem then
 * retries successfully looks, at this layer, exactly like a permanent
 * failure. Judging each attempt on its own made the drive exit 2 BLOCKED
 * on a page that rendered perfectly (#1529 review round 23).
 */
function callKey(call) {
  let params;
  try {
    params = JSON.stringify(call?.params ?? []);
  } catch {
    params = '?'; // circular / unserialisable — never match, never crash
  }
  return `${call?.method ?? '?'}|${params}`;
}

/**
 * Does this error body still count as the provider ANSWERING, even though
 * the HTTP status says otherwise?
 *
 * Mirrors viem's own test in `utils/rpc/http.js`, deliberately field for
 * field, because what matters is what the PAGE experiences:
 *
 *   if (!response.ok) {
 *     if (typeof data.error?.code === 'number' &&
 *         typeof data.error?.message === 'string') return data
 *     throw new HttpRequestError(...)
 *   }
 *
 * Both fields are required, and `data` is the whole body — so a BATCH
 * response never qualifies and always becomes a transport error however
 * healthy its members look, because an array parsed from JSON has no
 * `.error` of its own.
 *
 * The `Array.isArray` guard is therefore belt-and-braces rather than
 * load-bearing: the `.error` lookup alone already rejects every array.
 * It is kept because it states the rule the batch case turns on, but do
 * not mistake it for the thing doing the work — the batch test below
 * pins the BEHAVIOUR, and passes with this clause removed.
 */
function answersDespiteStatus(parsed) {
  return (
    !Array.isArray(parsed) &&
    typeof parsed?.error?.code === 'number' &&
    typeof parsed?.error?.message === 'string'
  );
}

/**
 * Classify a JSON-RPC response the routed-fetch shim is handing back to
 * the page, ONE OUTCOME PER CALL in the request.
 *
 * `classifyRpcFailure` above covers the calls the page makes through the
 * injected wallet, which surface as THROWN errors. The app's wagmi HTTP
 * transport is a second door onto the same question and it does not
 * throw: the provider answers, `fetch` resolves, and a JSON-RPC error
 * body or a 429 rides back as an ordinary response. Handed on unjudged,
 * that made a failed REQUIRED read look like a missing surface (a product
 * FAIL) and let a failed OPTIONAL read pass at exit 0 (#1529 round 22).
 *
 * Per CALL rather than per response, because three separate things go
 * wrong when the HTTP envelope is treated as the unit (#1529 round 23):
 *
 *   - A non-2xx is not automatically "no answer". A provider returning
 *     400 with a well-formed `-32602` has RECEIVED and rejected the
 *     page's request, and viem passes that straight through to the app —
 *     so it is a client fault, not a BLOCKED. Only a status the page
 *     itself cannot see past ends the question.
 *   - A batch response that OMITS a member answers every call but one.
 *     viem resolves batches POSITIONALLY (`resolve([data[i], data])`
 *     after sorting by id), so a dropped member does not merely yield
 *     `undefined` — it can hand one call another call's answer. Either
 *     way that read failed in the page and nothing recorded it.
 *   - Two calls in one batch can deserve different verdicts.
 *
 * What this must NOT do, and a naive "an error body means failure" rule
 * gets both wrong: the shim serves the WHOLE site, so only traffic whose
 * REQUEST is JSON-RPC is judged here; and an ordinary REVERT arrives as
 * an HTTP 200 carrying a JSON-RPC error, so it is an 'ok' outcome — the
 * app is expected to handle it, and recording it would exit non-zero on
 * every healthy run.
 *
 * @param {number} status HTTP status of the provider's response.
 * @param {Buffer|string|undefined} body Response body.
 * @param {string|undefined} requestBody The page's request body.
 * @returns {Array<{key: string, method: string,
 *                  verdict: 'ok' | 'client-fault' | 'unreachable',
 *                  why?: string}>}
 */
export function classifyRpcResponse(status, body, requestBody) {
  const calls = rpcCalls(requestBody);
  if (!calls) return [];

  const parsed = parseJson(body);
  const statusOk = status >= 200 && status < 300;
  const out = (c, verdict, why) => ({ key: callKey(c), method: String(c.method), verdict, why });

  // A status the page cannot see past: every call in the request failed,
  // whatever the body happens to contain. This is the plain-text 429 /
  // 5xx shape, and — per `answersDespiteStatus` — every non-2xx batch.
  if (!statusOk && !answersDespiteStatus(parsed)) {
    return calls.map((c) => out(c, 'unreachable', `HTTP ${status}`));
  }
  if (parsed === undefined) {
    return calls.map((c) => out(c, 'unreachable', `non-JSON response (HTTP ${status})`));
  }

  const members = Array.isArray(parsed) ? parsed : [parsed];

  // An error carrying no id answers the request AS A WHOLE — a parse
  // error is the canonical case, since the server never got far enough to
  // read the ids. Attributing it to every call beats also reporting each
  // one as "omitted", which would be the same fact told twice.
  const whole = members.find((m) => m?.error && (m.id === null || m.id === undefined));
  if (whole) {
    const verdict = classifyRpcFailure(whole.error);
    return calls.map((c) =>
      out(c, verdict === 'answered' ? 'ok' : verdict, `json-rpc ${whole.error?.code}`),
    );
  }

  const byId = new Map(
    members.filter((m) => m && m.id !== null && m.id !== undefined).map((m) => [m.id, m]),
  );

  return calls.map((c) => {
    const member = byId.get(c.id);
    // Nothing came back for this call. On a 200 that is a batch that
    // dropped a member — the read fails in the page, silently.
    if (member === undefined) return out(c, 'unreachable', 'omitted from batch response');
    if (!member.error) return out(c, 'ok');
    const verdict = classifyRpcFailure(member.error);
    return out(c, verdict === 'answered' ? 'ok' : verdict, `json-rpc ${member.error?.code}`);
  });
}

/**
 * Append a routed response's per-call outcomes to the run's ledger.
 *
 * A LEDGER rather than the two verdict buckets directly, because a single
 * attempt cannot decide the question: see `callKey`. The buckets are
 * filled once, at the end, by `summariseRpcLedger`.
 *
 * @param {{status: number, body: Buffer|string|undefined,
 *          requestBody: string|undefined, url: string}} response
 * @param {Array} ledger
 */
export function recordRpcResponse({ status, body, requestBody, url }, ledger) {
  for (const outcome of classifyRpcResponse(status, body, requestBody)) {
    ledger.push({ ...outcome, url });
  }
}

/**
 * Turn the attempt ledger into the two verdict buckets.
 *
 * A failed attempt is only a real failure if the same logical call did
 * not go on to succeed. viem retries (`retryCount: 3`) and falls back to
 * a second endpoint, and the page is unharmed when one of those works —
 * reporting the first attempt would exit 2 BLOCKED on a page that
 * rendered correctly.
 *
 * Only a LATER success clears a failure. An earlier one must not: a call
 * that worked at first and then failed for good is a genuine failure, and
 * letting the early success cancel it would hide exactly the kind of
 * mid-run degradation this drive is meant to notice.
 *
 * The wallet path deliberately has no equivalent. There `pub.request` is
 * our own viem client, which exhausts its retries internally and throws
 * once — so what that path records is already a final answer.
 *
 * @returns {{malformed: Array<{url: string, why: string}>,
 *            unreachable: Array<{url: string, why: string}>}}
 */
export function summariseRpcLedger(ledger) {
  const lastOk = new Map();
  ledger.forEach((e, i) => {
    if (e.verdict === 'ok') lastOk.set(e.key, i);
  });

  const malformed = [];
  const unreachable = [];
  const seen = new Set();
  ledger.forEach((e, i) => {
    if (e.verdict === 'ok') return;
    if ((lastOk.get(e.key) ?? -1) > i) return; // recovered on a later attempt
    // One entry per (verdict, call, reason): a read retried three times
    // and still dead is one problem, not three.
    const dedupe = `${e.verdict}|${e.key}|${e.why}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    (e.verdict === 'client-fault' ? malformed : unreachable).push({
      url: e.url,
      why: `${e.method} — ${e.why}`,
    });
  });
  return { malformed, unreachable };
}
