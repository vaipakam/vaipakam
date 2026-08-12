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
 * Is `parsed` a well-formed JSON-RPC request envelope, and if so what are
 * its calls?
 *
 * Shared by the route gate (which decides whether a mutating POST may ride
 * through) and the response classifier below, so the two cannot disagree
 * about what counts as RPC. While they did, two app-generated malformed
 * requests were misreported (#1529 review round 24):
 *
 *   - An EMPTY batch satisfies `every()` VACUOUSLY, so the gate allowed it
 *     through; the response side then declined to judge it, and an invalid
 *     request the page itself made vanished from the run entirely.
 *   - A member whose `method` is missing or not a string failed the
 *     allowlist lookup like any unsanctioned method, so a malformed
 *     product request was filed as a gap in OUR allowlist (exit 2) rather
 *     than as the page defect it is.
 *
 * Being strict here is safe in the direction that matters: the gate's
 * default is to REFUSE and name what it refused, so a shape wrongly judged
 * malformed is loud, where one wrongly waved through is silent.
 *
 * Two of its own checks were too loose to keep that promise, and round 25
 * found both. `typeof c.jsonrpc === 'string'` accepts `"1.0"`, and
 * `typeof c.params === 'object'` accepts `null` — so a regressed client
 * emitting either still counted as well formed, a lenient provider
 * answered it, and the run passed. Version and parameter shape are now
 * held to what JSON-RPC 2.0 actually says: the version is exactly `"2.0"`,
 * and `params`, when present, is a structured value — an array or a
 * non-null object.
 *
 * @returns {Array|undefined} the calls, or undefined if this is not a
 *          well-formed JSON-RPC request.
 */
export function rpcRequestCalls(parsed) {
  if (parsed === undefined || parsed === null) return undefined;
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (!calls.length) return undefined;
  const wellFormed = calls.every(
    (c) =>
      c &&
      typeof c === 'object' &&
      !Array.isArray(c) &&
      c.jsonrpc === '2.0' &&
      typeof c.method === 'string' &&
      c.method.length > 0 &&
      (c.params === undefined || (typeof c.params === 'object' && c.params !== null)),
  );
  return wellFormed ? calls : undefined;
}

/**
 * Where each RPC method carries the contract address it is aimed at.
 *
 * Only the read shapes the app actually uses against the Diamond. An
 * omission here costs a chain check that would not have run before at all,
 * so the list may grow; it may not be replaced by a guess that some
 * unlisted method is "probably" ours.
 */
const CONTRACT_PARAM = new Map([
  ['eth_call', (p) => [p?.[0]?.to]],
  ['eth_estimateGas', (p) => [p?.[0]?.to]],
  ['eth_getCode', (p) => [p?.[0]]],
  [
    'eth_getLogs',
    (p) => (Array.isArray(p?.[0]?.address) ? p[0].address : [p?.[0]?.address]),
  ],
]);

/**
 * Is any of these calls addressed to `address`?
 *
 * Used to tell an endpoint serving the DEPLOYMENT chain apart from one the
 * page uses for something else, which the chain check has to know and
 * cannot get from the URL (#1529 review round 25).
 *
 * The page talks to more than one network on purpose: `wagmi.ts` registers
 * an explicit chain-1 transport so ENS reverse lookups resolve, and
 * `AddressName` fires one for every counterparty on a connected page. Those
 * endpoints answer `eth_chainId` with 1 — correctly — so a check that
 * asserts CHAIN_ID against every endpoint the page touches declares a
 * healthy site to be built for the wrong network.
 *
 * Attribution is by POSITIVE evidence rather than by excluding known ENS
 * URLs: the ENS endpoint comes from the deployed bundle's own env and this
 * driver cannot enumerate it, so an exclusion list would be a guess that
 * silently stops matching. A call addressed to the Diamond, by contrast, is
 * proof that the endpoint carrying it is the one serving the app's
 * deployment reads.
 */
export function callsTargetContract(calls, address) {
  if (typeof address !== 'string' || !address) return false;
  const want = address.toLowerCase();
  return (calls ?? []).some((c) => {
    const pick = CONTRACT_PARAM.get(c?.method);
    return pick
      ? pick(c.params).some((a) => typeof a === 'string' && a.toLowerCase() === want)
      : false;
  });
}

/**
 * Is this request BODY JSON-RPC? The discriminator for the whole
 * response-side check, and it has to be the REQUEST rather than the
 * response: a rate-limited provider answers `429 Too Many Requests` with
 * a plain-text body, so the response alone cannot tell us an RPC call
 * just failed.
 */
export function rpcCallsFromBody(requestBody) {
  return rpcRequestCalls(parseJson(requestBody));
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
 * The same positional resolution makes two further shapes unsafe, both
 * added in round 24: a SURPLUS or duplicate member shifts every answer
 * along by one even though each requested id is present, and a member
 * carrying neither a `result` nor a usable `error` is not a success just
 * because it has no error to report.
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
  const calls = rpcCallsFromBody(requestBody);
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

  // What one member says about its call. An `error` decides on its own;
  // otherwise the member has to actually CARRY a result.
  const memberOutcome = (c, member) => {
    const err = member?.error;
    if (err !== null && err !== undefined) {
      // Present but not a JSON-RPC error object. viem reads `code` and
      // `message` off it, so there is nothing here the page can act on and
      // nothing we can classify.
      if (typeof err.code !== 'number') return out(c, 'unreachable', 'malformed json-rpc error');
      const verdict = classifyRpcFailure(err);
      return out(c, verdict === 'answered' ? 'ok' : verdict, `json-rpc ${err.code}`);
    }
    // Neither a result nor a usable error — `{"jsonrpc":"2.0","id":1}`, or
    // a member whose only error field is `null`. Absence of an error is
    // NOT success: viem destructures `result` off the member and hands the
    // page `undefined`, so the read fails or renders degraded state while
    // this ledger contributes no verdict at all (#1529 review round 24).
    if (!member || !Object.prototype.hasOwnProperty.call(member, 'result')) {
      return out(c, 'unreachable', 'neither result nor error');
    }
    return out(c, 'ok');
  };

  // A non-array response answers ONE call. viem hands `data` straight back
  // without consulting the id, so the id is not load-bearing here — but a
  // BATCH answered this way lost every member but one.
  if (!Array.isArray(parsed)) {
    if (calls.length === 1) return [memberOutcome(calls[0], members[0])];
    return calls.map((c) => out(c, 'unreachable', 'batch answered with a single response'));
  }

  const wanted = new Set(calls.map((c) => c.id));
  const byId = new Map();
  let unattributable = false;
  for (const m of members) {
    const id = m?.id;
    if (id === null || id === undefined || !wanted.has(id) || byId.has(id)) {
      unattributable = true;
      continue;
    }
    byId.set(id, m);
  }

  // A surplus or duplicate member poisons the WHOLE batch, not just its
  // own call. viem SORTS the returned members and resolves them
  // POSITIONALLY, so an extra member shifts every answer along by one: ask
  // for ids 10 and 11, get back 9, 10 and 11, and the first call is handed
  // the id-9 result while both requested ids are present and look fine.
  // That is the difference from an OMISSION, which costs exactly one call
  // and is still reported per call below — here there is no member left we
  // can trust, so nothing may be recorded as ok (#1529 review round 24).
  if (unattributable) {
    return calls.map((c) =>
      out(c, 'unreachable', 'unexpected or duplicate member in batch response'),
    );
  }

  return calls.map((c) => {
    const member = byId.get(c.id);
    // Nothing came back for this call. On a 200 that is a batch that
    // dropped a member — the read fails in the page, silently.
    if (member === undefined) return out(c, 'unreachable', 'omitted from batch response');
    return memberOutcome(c, member);
  });
}

/**
 * Append a routed response's per-call outcomes to the run's ledger.
 *
 * A LEDGER rather than the two verdict buckets directly, because a single
 * attempt cannot decide the question: see `callKey`. The buckets are
 * filled once, at the end, by `summariseRpcLedger`.
 *
 * Each entry is STAMPED with an arrival time. Attempt order alone cannot
 * say whether two attempts belong to one logical operation, but elapsed
 * time bounds it: one operation's retries are seconds apart at most, while
 * an independent poll of the same read is a poll interval away. See
 * `OPERATION_GAP_MS`.
 *
 * @param {{status: number, body: Buffer|string|undefined,
 *          requestBody: string|undefined, url: string, at?: number}} response
 * @param {Array} ledger
 */
export function recordRpcResponse(
  { status, body, requestBody, url, at },
  ledger,
) {
  const t = at ?? Date.now();
  for (const outcome of classifyRpcResponse(status, body, requestBody)) {
    ledger.push({ ...outcome, url, t });
  }
}

/**
 * viem's default `retryCount`, and the most HTTP attempts ONE logical
 * operation can therefore spend on a single endpoint: the first try plus
 * three retries.
 *
 * `fallback` sets `retryCount: 0` on its children and does the retrying
 * itself, so a fallback operation spends up to this many PASSES over its
 * endpoint list rather than this many attempts in total — which is why
 * the budget below scales with the number of endpoints observed rather
 * than being a flat constant.
 */
const VIEM_RETRY_COUNT = 3;
const ATTEMPTS_PER_ENDPOINT = VIEM_RETRY_COUNT + 1;

/**
 * The query layer retries on top of the transport (Codex #1583 r1): the
 * shared `QueryClient` in `apps/alpha02/src/main.tsx` sets `retry: 1`, and
 * wagmi read hooks execute through it. So ONE page read can spend the
 * transport's whole allowance twice over, and a ceiling that counted only
 * transport attempts reported a spurious failure on any read that
 * exhausted viem and then succeeded on the query-layer retry.
 */
const QUERY_LAYER_ATTEMPTS = 2;

/**
 * How far apart two attempts can be and still plausibly belong to the same
 * logical operation.
 *
 * This is the discriminator the earlier revision lacked (Codex #1583 r1).
 * Bounding absorption by a COUNT alone is unsound in both directions: an
 * independent later invocation of the same read inflated the allowance and
 * cleared a chain that had genuinely exhausted, while a wide-enough ceiling
 * to cover the query-layer retry stops discriminating at all. Elapsed time
 * does discriminate, because the two cases live on different scales —
 * viem's retry backoff and the query layer's retry delay put one
 * operation's attempts a few seconds apart at most, while the app's polls
 * of the same read are 30-60s apart (see `KEY_MAP` in
 * `src/chain/IndexerPushSync.tsx` for the poll cadence). 15s sits between
 * the two with room on both sides.
 *
 * Attempts are therefore grouped into per-operation CLUSTERS, and a
 * success may only forgive failures inside its own cluster.
 */
const OPERATION_GAP_MS = 15_000;

/**
 * How many consecutive failures a later success is allowed to explain.
 *
 * One successful operation emits at most `ATTEMPTS_PER_ENDPOINT` attempts
 * per endpoint it touched, twice over if the query layer retried, the last
 * of which is the success.
 *
 * The endpoint count is taken from the CLUSTER (the distinct URLs in the
 * failure streak, plus the URL that answered) rather than from a constant,
 * so the budget widens exactly when a fallback really is in play —
 * `wagmi.ts` wraps the mainnet reads in `fallback([http, http])`.
 *
 * This count is only meaningful because the caller has already bounded the
 * window by time: a per-key count over a whole RUN could be inflated by any
 * independent invocation that happened to answer on another endpoint
 * (Codex #1583 r1), which is exactly the unsoundness `OPERATION_GAP_MS`
 * removes. Do not reintroduce a run-wide count here.
 */
function absorbableBefore(run, answeringUrl) {
  const urls = new Set(run.map((e) => e.url));
  urls.add(answeringUrl);
  return ATTEMPTS_PER_ENDPOINT * QUERY_LAYER_ATTEMPTS * urls.size - 1;
}

/**
 * Split one key's attempts, in arrival order, into per-operation clusters:
 * a gap wider than `OPERATION_GAP_MS` starts a new one.
 *
 * @param {Array} entries
 * @returns {Array<Array>}
 */
function clusterByGap(entries) {
  const clusters = [];
  let current = null;
  for (const e of entries) {
    if (current && e.t - current[current.length - 1].t <= OPERATION_GAP_MS) {
      current.push(e);
    } else {
      current = [e];
      clusters.push(current);
    }
  }
  return clusters;
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
 * A later success also clears only failures it could have shared an
 * OPERATION with (#1583). `key` is `method|params`, which carries no
 * invocation identity — the page polls `eth_blockNumber|[]` for the whole
 * run, so an unrelated later poll used to clear a chain that had genuinely
 * exhausted, letting an incompletely served run exit 0. Identity is not
 * recoverable from the wire (viem takes a fresh JSON-RPC id per attempt,
 * each retry is its own Playwright request, and concurrent duplicate reads
 * are identical byte for byte), so attempts are grouped into clusters by
 * ARRIVAL TIME (`OPERATION_GAP_MS`) and a success settles only its own
 * cluster. Within a cluster the count is bounded too: more failures than
 * one operation could spend proves a chain ran out of retries.
 *
 * A count alone is NOT enough, and an earlier revision of this that used
 * one was wrong in both directions (Codex #1583 r1) — inflated by
 * independent invocations answering on another endpoint, yet too tight to
 * cover the query layer's own retry. Time is what separates the two cases.
 *
 * Where a cluster genuinely cannot be decomposed — concurrent duplicate
 * reads are indistinguishable on the wire — this FORGIVES rather than
 * retains. For a driver that gates releases a false BLOCKED that cries
 * wolf is worse than a missed degradation, and the case that actually
 * proves an incompletely served run (a cluster that never succeeded at
 * all) is caught without needing to decompose anything.
 *
 * The wallet path deliberately has no equivalent. There `pub.request` is
 * our own viem client, which exhausts its retries internally and throws
 * once — so what that path records is already a final answer.
 *
 * @returns {{malformed: Array<{url: string, why: string}>,
 *            unreachable: Array<{url: string, why: string}>}}
 */
export function summariseRpcLedger(ledger) {
  // Per key, in arrival order: a failure streak is only interpretable
  // against the other attempts of the SAME logical call.
  const byKey = new Map();
  ledger.forEach((e, i) => {
    const entry = { ...e, i };
    const prior = byKey.get(e.key);
    if (prior) prior.push(entry);
    else byKey.set(e.key, [entry]);
  });

  const surviving = [];
  for (const entries of byKey.values()) {
    // Per operation-cluster, not per key: a success may only forgive
    // failures it could actually have shared an operation with.
    for (const cluster of clusterByGap(entries)) {
      let run = [];
      // `answeringUrl === undefined` means the cluster ended with no
      // success, so nothing can be absorbed and every failure stands.
      const settle = (answeringUrl) => {
        const absorbable =
          answeringUrl === undefined ? 0 : absorbableBefore(run, answeringUrl);
        // Only the LAST `absorbable` failures can belong to the chain that
        // went on to succeed. Anything earlier outlived its own retries.
        const cut = Math.max(0, run.length - absorbable);
        run.forEach((e, idx) => {
          if (idx < cut) surviving.push(e);
        });
        run = [];
      };
      for (const e of cluster) {
        if (e.verdict === 'ok') settle(e.url);
        else run.push(e);
      }
      settle(undefined);
    }
  }

  const malformed = [];
  const unreachable = [];
  const seen = new Set();
  // Back into ledger order — grouping above is an implementation detail,
  // and a report that reads in the order the run experienced things is
  // easier to act on.
  surviving.sort((a, b) => a.i - b.i);
  for (const e of surviving) {
    // One entry per (verdict, call, reason): a read retried three times
    // and still dead is one problem, not three.
    const dedupe = `${e.verdict}|${e.key}|${e.why}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    (e.verdict === 'client-fault' ? malformed : unreachable).push({
      url: e.url,
      why: `${e.method} — ${e.why}`,
    });
  }
  return { malformed, unreachable };
}
