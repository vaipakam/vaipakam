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
 *   ditto, with hex   InvalidParamsRpcError       code=-32602  client-fault
 *                     `data` carrying hex diagnostics — the code wins
 *                     over the bytes, because nothing executed (r82)
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
 * The JSON-RPC methods that RUN EVM CODE, and therefore the only ones a
 * revert can be a legitimate answer to (round 72 P2).
 *
 * A revert is a statement about execution. `eth_blockNumber`,
 * `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_getLogs` and
 * `eth_chainId` execute nothing, so a revert-shaped error from one of
 * them is not the application-level answer the exemption below exists
 * for — it is a provider response the page could not read.
 *
 * The distinction decides who gets blamed. `classifyRpcResponse` records
 * `ok` for an answered call, which means the response ledger reports no
 * infrastructure failure; the page meanwhile got an error and can render
 * a degraded or missing surface, and the generic page checks then exit 1
 * against the PRODUCT for something the provider did. Blockers outranking
 * inferred conclusions is the whole ordering this drive is built on, and
 * this was a hole in it.
 *
 * `eth_sendRawTransaction` and `eth_sendTransaction` are in the set
 * because several providers pre-simulate and answer a would-be-reverting
 * transaction with the revert itself. This drive is watch-only and sends
 * neither, but the classifier is general and the omission would be a
 * trap for the first caller that does.
 */
export const EXECUTING_METHODS = new Set([
  'eth_call',
  'eth_estimateGas',
  'eth_createAccessList',
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'debug_traceCall',
]);

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
  // An EXPLICIT execution-reverted code is conclusive and comes first.
  if (coded?.code === EXECUTION_REVERTED) return 'answered';
  // ROUND 82 P2 — A MALFORMED-REQUEST CODE OUTRANKS INCIDENTAL HEX DATA.
  //
  // The revert-bytes test used to sit here, justified by "bytes are
  // conclusive whatever code carried them, and some providers label a
  // genuine revert -32000". That argument is about -32000, an unspecified
  // server error; it says nothing about the three codes below, each of
  // which is the server stating it PARSED the request and would not run
  // it. Nothing executed, so nothing can have reverted — and a provider
  // is free to put hex in `data` beside that code.
  //
  // The old order therefore laundered a bad request into an answer, and
  // the cost is worst where the answer is acted on: `probeCloseOut` reads
  // 'answered' as the protocol REFUSING the close-out, so both bracket
  // samples arriving in that shape would let the verdict accuse a ready
  // card of offering a transaction that cannot succeed — a product FAIL
  // manufactured out of this drive's own malformed call. The
  // authority-ranking pre-pass reads the same `false` and would discard a
  // usable target.
  //
  // Under the corrected order those probes classify 'client-fault',
  // `isTransportFailure` already returns false for it (round 33 set that
  // precedence for exactly this reason), and the error is rethrown — the
  // loud failure a defect in this drive should get, instead of a quiet
  // accusation against the product.
  if (JSONRPC_MALFORMED_REQUEST.has(coded?.code)) return 'client-fault';
  // Bytes remain conclusive for every other code, which is what keeps a
  // -32000-labelled revert an answer.
  if (raw !== undefined && REVERT_BYTES.test(raw)) return 'answered';
  return 'unreachable';
}

/**
 * Is this failure the CHAIN failing to answer, rather than this file
 * being wrong?
 *
 * ROUND 31 P2 — an ALLOWLIST, because the denylist I wrote last round
 * was the same mistake this file argues against thirty lines further
 * down. `classifyRpcFailure`'s note says it outright: a denylist has to
 * enumerate every operational code a provider might return, and the ones
 * it misses are waved through. My `err instanceof ReferenceError ||
 * TypeError` had to enumerate every way this drive can be wrong about
 * itself, and it missed most of them — a malformed `account` surfaces as
 * `ContractFunctionExecutionError`, bad ABI arguments as
 * `AbiEncodingLengthMismatchError`, and neither would have been
 * reported. The inert-ordering failure could have recurred exactly as
 * before, with the same silence.
 *
 * The chain is WALKED rather than the outer error inspected, because
 * viem wraps: `simulateContract` reports a dead endpoint as a
 * `ContractFunctionExecutionError` whose `cause` is the
 * `HttpRequestError`. Testing only the outer name would classify every
 * transport failure as a bug and make the drive throw on a flaky RPC,
 * which is the opposite error and a far noisier one.
 *
 * An undecodable revert counts as transport on purpose. `saleLockedOn`
 * resolves the reverts it recognises and rethrows only what it could not
 * read, and "the EVM answered something I cannot parse" is a failure to
 * determine, not a defect to report.
 *
 * ROUND 33 P2 — AND `classifyRpcFailure` OUTRANKS THE NAME WALK.
 *
 * `RpcRequestError` in the list below was quietly re-opening the
 * laundering the list exists to close. viem builds the specific class
 * from the JSON-RPC code and passes the generic `RpcRequestError` as its
 * `cause`, so EVERY error REPLY carries that name somewhere in its chain
 * — including the ones this drive causes by sending a malformed request.
 * Walking for names therefore matched all of them, and a `-32602 invalid
 * params` from a bad `account` or a wrong argument list was filed as the
 * chain failing to answer. The probe then left the loan ranked usable and
 * said nothing, which is the same silence that let two inert fixes ride
 * for a round each.
 *
 * The fix is a PRECEDENCE rule over the EXISTING classifier, not a second
 * list. `classifyRpcFailure` already decides this question, already reads
 * the CODE off the chain rather than trusting a class name, and already
 * carries the argued line about which codes count — including why
 * `-32601` is NOT a client fault. Restating any of that here would have
 * been a second copy to drift, which is the shape this PR has been caught
 * on twice already.
 *
 * Only `'client-fault'` overrides. `'answered'` deliberately does not: an
 * undecodable revert stays transport for the reason stated above.
 */
export const TRANSPORT_ERROR_NAMES = new Set([
  'HttpRequestError',
  'TimeoutError',
  'WebSocketRequestError',
  'SocketClosedError',
  'LimitExceededRpcError',
  'ResourceUnavailableRpcError',
  'InternalRpcError',
  'UnknownRpcError',
  'RpcRequestError',
]);

export function isTransportFailure(err) {
  // A DEFECTIVE REQUEST OUTRANKS EVERY TRANSPORT NAME IN THE CHAIN: the
  // node answered, and what it answered is that this drive asked wrongly.
  // Decided by the classifier above so there is one rule, one code set,
  // and one place to argue about membership.
  if (classifyRpcFailure(err) === 'client-fault') return false;
  const seen = new Set();
  let cur = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.name === 'string' && TRANSPORT_ERROR_NAMES.has(cur.name)) return true;
    cur = cur.cause;
  }
  return false;
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
      (c.params === undefined || (typeof c.params === 'object' && c.params !== null)) &&
      // ROUND 74 P2 — AND THE ID IS ONE OF THE THREE TYPES THE SPEC
      // ALLOWS. Nothing validated it, so `true`, `[1]` or `{}` passed as
      // well formed. A lenient provider echoing a boolean id then
      // produced an `ok` ledger entry and the malformed request rode
      // through the route gate; an OBJECT id is worse, because two
      // separately parsed objects never match by identity, so the
      // attribution fails and the page's own defect is reported as an
      // infrastructure failure. Absent is fine — that is a
      // notification.
      (!('id' in c) || c.id === null || typeof c.id === 'string' || typeof c.id === 'number'),
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
 * A JSON-RPC QUANTITY, or null if the value is not one.
 *
 * ROUND 50 P2, generalised from the finding's own site. An Ethereum
 * JSON-RPC quantity is hex with an `0x` prefix. `BigInt` is far more
 * willing than that — it accepts `"100000"` and `"-1"` — and three
 * separate readers in this file leaned on it, two of them with a
 * `catch` whose comment already claimed to be rejecting non-hex values.
 *
 * All three consume the same kind of field and all three feed decisions
 * that must not be made on a misread number, so the rule lives in one
 * place rather than being written out three times and drifting. That is
 * the repeated correction on this PR: a fix applied to one of several
 * parallel sites.
 *
 * EXPORTED SINCE ROUND 88, for a fourth consumer with the same problem:
 * the drive's direct page-provider head probe was reading its result with
 * a bare `BigInt`, which is exactly what this exists to stop. It bounds
 * the block a product claim is made against, so it is the last place that
 * should be lenient about what a height looks like.
 *
 * The heights matter most, and specifically when they come out too LOW.
 * The absence gate makes the confirming observer clear the head the PAGE
 * was seen to reach, so an artificially low bound lets the observer
 * settle below what the DOM was showing and report a correctly absent
 * card as a regression — the same false FAIL round 48's head-sampling
 * race produced, by a different road.
 *
 * Unreadable is treated as ABSENT, never guessed at. A missing height is
 * already handled as not-ready, which is the honest outcome.
 *
 * @param {unknown} raw
 * @returns {bigint|null}
 */
export function hexQuantity(raw) {
  if (typeof raw !== 'string') return null;
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    // Unreachable given the shape test, kept as a belt: this value is
    // used to bound a product claim.
    return null;
  }
}

/**
 * The block height a page disclosed in one `eth_blockNumber` exchange.
 *
 * The forced-close absence gate has to know whether THIS observer has
 * caught up with the provider whose DOM it is judging, and the page is
 * the only authority on its own head. It discloses it here.
 *
 * PURE, AND HERE RATHER THAN IN THE DRIVER, because the interesting
 * cases are the ones a live chain will not reliably produce: a batch
 * answered out of order, a batch mixing `eth_blockNumber` with other
 * methods, an error member where a result was expected. Left inline in
 * the response listener, none of those could be exercised — the same
 * argument that moved `visitVerdict` and `forcedCloseCard` out.
 *
 * MATCHED BY JSON-RPC ID, never by position: a batch may be answered in
 * any order, and lining the arrays up would silently attribute one
 * call's result to another method. The single exception is the
 * degenerate one-call/one-reply body, where a provider that echoes no
 * usable id still leaves no ambiguity about what it answered.
 *
 * Returns null rather than throwing for anything it cannot read. A
 * mis-parsed response must never become a finding about the app, and the
 * gate treats "no head observed" as not-ready, so silence is
 * conservative rather than permissive.
 *
 * @param {string|undefined} requestBody   the POST body the page sent
 * @param {unknown} responseBody           the parsed JSON reply
 * @returns {bigint|null} the highest height disclosed, or null
 */
export function blockNumberFromRpcPair(requestBody, responseBody) {
  let calls;
  try {
    calls = rpcCallsFromBody(requestBody);
  } catch {
    return null;
  }
  if (!calls) return null;
  // ROUND 33 P2 — `eth_getBlockByNumber('latest')` ANNOUNCES A HEAD TOO,
  // and reading only `eth_blockNumber` threw away the exact one the page
  // had just been told.
  //
  // The app asks for the head as a BLOCK far more often than as a number:
  // `getBlock({ blockTag: 'latest' })` appears throughout the position
  // reads — `loanLive.ts`, `loanSalePending.ts`, and every flow that pins
  // a write to a height — and viem sends each of those as
  // `eth_getBlockByNumber`. On a page whose head arrives that way,
  // `pageHeadOf` stayed at zero or at some older value, and the
  // forced-close absence gate is built on it: at zero the confirmation
  // never runs and a missing card is permanently `incomplete` — the new
  // assertion disabled outright — while a stale value confirms against
  // too low a bound and can blame the product for a card the page was
  // right to have removed.
  //
  // ONLY `'latest'`. A historical `eth_getBlockByNumber('0x…')` returns a
  // number that is not the head, and `'pending'` returns one ABOVE it for
  // a block nobody has mined — recording either would overstate what the
  // page announced, which on this gate is the direction that manufactures
  // accusations. `'safe'` and `'finalized'` lag the head and are excluded
  // for tidiness rather than safety.
  const wantsHead = (c) =>
    c?.method === 'eth_blockNumber' ||
    (c?.method === 'eth_getBlockByNumber' &&
      Array.isArray(c?.params) &&
      c.params[0] === 'latest');
  // ROUND 60 P2 — A REUSED ID IS NOT AN IDENTITY.
  //
  // `wanted` is a Set, so a batch reusing one JSON-RPC id for
  // `eth_blockNumber` and something else collapses the two calls into a
  // single identity: every response member carrying that id becomes
  // eligible as a head result. A lone `eth_chainId` answer of `0x14a34`
  // is then recorded as page block 84532 — an artificially LOW absence
  // bound, which is the direction that lets the confirming observer
  // settle below what the DOM was showing and report a correctly absent
  // card as a regression.
  //
  // Neither existing gate objects: the request is well-formed and the
  // response is present, so the malformed-request and unreachable
  // classifiers both pass it.
  //
  // Refused rather than repaired. An id that names two calls names
  // neither, and picking one would be a guess — the honest answer is
  // that this exchange carried no height, which the caller already
  // handles as not-ready.
  const ids = calls.map((c) => c?.id);
  const duplicated = new Set(ids.filter((id, i) => ids.indexOf(id) !== i));
  const wanted = new Set(
    calls.filter(wantsHead).map((c) => c?.id).filter((id) => !duplicated.has(id)),
  );
  if (wanted.size === 0) return null;
  const items = Array.isArray(responseBody) ? responseBody : [responseBody];
  // The degenerate case: one call asked, one answer came back. There is
  // nothing else the reply could be about, so an absent or rewritten id
  // is not a reason to discard it.
  const lone = calls.length === 1 && items.length === 1;
  // A height can arrive as the whole result (`eth_blockNumber`) or as the
  // `number` field of a block header. Nothing else on a header is read —
  // guessing at another field is how a log count gets recorded as a block
  // number, which `blockNumberFromWsFrame` already says at length.
  const heightOf = (result) => {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && typeof result.number === 'string') {
      return result.number;
    }
    return null; // an error member, a null block, or a shape not read here
  };
  let best = null;
  for (const item of items) {
    if (!lone && !wanted.has(item?.id)) continue;
    const raw = heightOf(item?.result);
    if (raw === null) continue;
    // ROUND 50 P2 — A QUANTITY IS HEX, and `BigInt` is far too willing.
    // The `catch` here used to carry the comment "not a hex quantity"
    // while checking nothing at all; `hexQuantity` is what that comment
    // always claimed.
    const seen = hexQuantity(raw);
    if (seen === null) continue;
    if (best === null || seen > best) best = seen;
  }
  return best;
}

/**
 * Returned by `chainIdFromRpcPair` when one exchange carried MORE THAN
 * ONE chain id (round 52 P2).
 *
 * A distinct value rather than `null`, because the two mean opposite
 * things to the caller. `null` is "no chain evidence here", which lets
 * the endpoint be admitted on other grounds; this is "positive evidence
 * that the endpoint contradicts itself", which must exclude it — the
 * same permanent distrust round 51 established for an endpoint that
 * reports a foreign chain, reached by an earlier door.
 *
 * A symbol so it can never be confused with a chain id, however the
 * caller compares.
 */
export const CHAIN_ID_CONFLICT = Symbol('conflicting chain ids');

/**
 * The chain id an endpoint reported in one `eth_chainId` exchange.
 *
 * THE RIGHT EVIDENCE for scoping observed block heights, because heights
 * are chain-scoped and this is a direct statement of which chain an
 * endpoint speaks for. Attribution by "the page asked this endpoint
 * about the Diamond" is a proxy, and a leaky one: the app resolves ENS
 * names on a mainnet endpoint, and a reverse lookup carries an address
 * in its calldata exactly the way a batched Diamond read does.
 *
 * Same id-matching rule as `blockNumberFromRpcPair`, for the same
 * reason, and the same single-call leniency.
 *
 * @param {string|undefined} requestBody
 * @param {unknown} responseBody
 * @returns {number|null} the chain id, or null when none was disclosed
 */
export function chainIdFromRpcPair(requestBody, responseBody) {
  let calls;
  try {
    calls = rpcCallsFromBody(requestBody);
  } catch {
    return null;
  }
  if (!calls) return null;
  // ROUND 63 P2 — A REUSED ID IS NOT AN IDENTITY HERE EITHER.
  //
  // Round 60 refused duplicated ids in `blockNumberFromRpcPair` and left
  // this sibling collapsing them, which is the same defect by the door
  // that matters MORE: a batch reusing one id for `eth_chainId` and
  // something else makes any member carrying that id eligible as the
  // chain answer, so an `eth_blockNumber` result of `0x14a34` reads as
  // "this endpoint speaks for Base Sepolia". `markDiamond` then ADMITS
  // the endpoint and trusts every later height it reports — including
  // heights from whatever chain it is actually on — which is exactly the
  // wrong-chain bound the exclusion rules exist to keep out.
  //
  // Round 60's own note said "same id-matching rule as
  // `blockNumberFromRpcPair`, for the same reason"; the comment stayed
  // true and the code stopped being. Tenth instance on this PR of a fix
  // applied to one of several parallel sites, and the second where the
  // fixed site's own prose pointed at the one still broken.
  //
  // Refused rather than repaired, for round 60's reason: an id that
  // names two calls names neither, and the caller already handles "no
  // chain evidence here" by leaving the endpoint unadmitted.
  const ids = calls.map((c) => c?.id);
  const duplicated = new Set(ids.filter((id, i) => ids.indexOf(id) !== i));
  const wanted = new Set(
    calls
      .filter((c) => c?.method === 'eth_chainId')
      .map((c) => c?.id)
      .filter((id) => !duplicated.has(id)),
  );
  if (wanted.size === 0) return null;
  const items = Array.isArray(responseBody) ? responseBody : [responseBody];
  const lone = calls.length === 1 && items.length === 1;
  // ROUND 52 P2 — EVERY ANSWER, not the first one.
  //
  // Returning on the first match ignored a batch that answers
  // `eth_chainId` twice with DIFFERENT chains. The endpoint is then
  // admitted as deployment-serving on the strength of one of its two
  // replies, and its later heights are trusted — which is exactly the
  // endpoint round 51's permanent exclusion exists to distrust, reaching
  // the same wrong-chain bound by an earlier door.
  //
  // A contradiction is reported as `'conflict'` rather than as `null`,
  // and the distinction is the whole fix: `null` means "this exchange
  // carried no chain evidence", which lets the caller fall through to
  // its address heuristic and ADMIT the endpoint. An endpoint that gave
  // two answers has given positive evidence — that it cannot be relied
  // on for either — and the caller must be able to act on it.
  const seen = new Set();
  for (const item of items) {
    if (!lone && !wanted.has(item?.id)) continue;
    // A CHAIN ID IS A QUANTITY TOO (round 50 P2, the same rule one
    // function over). A decimal id read as hex attributes an endpoint to
    // the wrong chain, which either admits a foreign chain's height or
    // excludes the endpoint actually serving the Diamond.
    const id = hexQuantity(item?.result);
    if (id === null) continue;
    const n = Number(id);
    if (Number.isSafeInteger(n)) seen.add(n);
  }
  if (seen.size === 0) return null;
  if (seen.size > 1) return CHAIN_ID_CONFLICT;
  return [...seen][0];
}

/**
 * The block height a `newHeads` push disclosed, or null.
 *
 * ROUND 16 P2 — THE HTTP SNIFFER IS HALF THE PICTURE. `wagmi.ts` wraps
 * the chain reads in `fallback([webSocket, http])`, so on a healthy
 * network the page can learn about a new block over a SOCKET and never
 * issue the `eth_blockNumber` an HTTP-only listener depends on. Its
 * announced head then lags its real one, and the absence gate compares
 * against a bound that stopped moving.
 *
 * Only the `eth_subscription` notification is read, and only its header
 * `number`. A bare `{id, result}` reply on a socket is deliberately NOT
 * used: without the paired request there is nothing to say the result is
 * a height rather than any other read, and guessing is how a log count
 * gets recorded as a block number.
 *
 * @param {unknown} payload  one received WebSocket frame
 * @returns {bigint|null}
 */
export function blockNumberFromWsFrame(payload) {
  const parsed = parseJson(typeof payload === 'string' ? payload : undefined);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.method !== 'eth_subscription') return null;
  const header = parsed.params?.result;
  if (!header || typeof header !== 'object') return null;
  // ROUND 50 P2 — the SOCKET half of the same rule. A `newHeads` push
  // carrying a decimal `number` fed the identical too-low head bound,
  // and this reader is the one that fires on a healthy network.
  return hexQuantity(header.number);
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
  // `recoverable: false` marks a fault in the request ENVELOPE rather
  // than in the call — see `summariseRpcLedger`, which must not let a
  // later success for the same method and params erase it.
  const out = (c, verdict, why, recoverable = true) => ({
    key: callKey(c),
    method: String(c.method),
    verdict,
    why,
    // Carried ONLY when false, so every other outcome keeps the shape it
    // has always had and nothing downstream has to learn a new field.
    ...(recoverable ? {} : { recoverable: false }),
  });

  // ROUND 73 P2 — A BATCH THAT REUSES A REQUEST ID IS MALFORMED, and
  // judged before the response is looked at, because this is a fact about
  // what the PAGE ASKED.
  //
  // Ids are how a batch's answers are attributed. Reuse one and a single
  // member satisfies two calls: `wanted` collapses the duplicates into
  // one entry, `byId` holds one member, and both calls read `ok` off it.
  // viem meanwhile resolves batches POSITIONALLY, so what the page
  // actually received is one call's answer handed to another, or nothing
  // — a read that failed or rendered the wrong value, with the ledger
  // recording two clean fetches.
  //
  // `client-fault`, not `unreachable`, and round 21 settled which: a
  // malformed request the page GENERATED is a working endpoint reporting
  // an app defect, and filing it as "could not fetch" exits 2 on
  // infrastructure while hiding the regression class this drive exists to
  // catch.
  //
  // ONLY IDS THAT ARE PRESENT. A JSON-RPC notification legitimately
  // carries none and expects no reply, so two of them are not a
  // collision; treating absent ids as equal would invent a product FAIL
  // out of a shape the spec allows.
  //
  // ROUND 74 P2 — AND `"id": null` IS PRESENT. A notification OMITS the
  // member; an explicit null is an id the spec discourages but allows,
  // and the response must echo it. The first version of this test read
  // `c.id === undefined || c.id === null`, which conflated the two: two
  // calls both carrying `"id": null` escaped the duplicate check
  // entirely, and their replies were then filed as unattributable
  // INFRASTRUCTURE failures rather than as the malformed request the page
  // generated. `in` is what tells them apart.
  //
  // ROUND 74 P2 — AND A NOTIFICATION IS EXCLUDED FROM EVERY COMPLETENESS
  // CHECK BELOW, not just this one. It expects no response member, so
  // "omitted from the batch" and "no JSON came back" are the CORRECT
  // outcomes for it, and recording either as `unreachable` exits 2 on a
  // standards-compliant page.
  const isNotification = (c) => !('id' in c);
  const answerable = calls.filter((c) => !isNotification(c));

  const seenIds = new Set();
  const reusedId = answerable.some((c) => {
    if (seenIds.has(c.id)) return true;
    seenIds.add(c.id);
    return false;
  });
  if (reusedId) {
    return answerable.map((c) =>
      out(c, 'client-fault', 'duplicate id in the request batch', false),
    );
  }

  // A status the page cannot see past: every call in the request failed,
  // whatever the body happens to contain. This is the plain-text 429 /
  // 5xx shape, and — per `answersDespiteStatus` — every non-2xx batch.
  if (!statusOk && !answersDespiteStatus(parsed)) {
    // Notifications INCLUDED here, deliberately: a status the page cannot
    // see past means the request never landed, and a notification that
    // never landed was not delivered either. What follows is different —
    // there the response arrived and simply carries nothing for a call
    // that asked for nothing.
    return calls.map((c) => out(c, 'unreachable', `HTTP ${status}`));
  }
  if (parsed === undefined) {
    // An all-notification batch is answered with an empty body, commonly
    // a 204. Nothing was asked for, so nothing is missing.
    return answerable.map((c) => out(c, 'unreachable', `non-JSON response (HTTP ${status})`));
  }

  const members = Array.isArray(parsed) ? parsed : [parsed];

  // An error carrying no id answers the request AS A WHOLE — a parse
  // error is the canonical case, since the server never got far enough to
  // read the ids. Attributing it to every call beats also reporting each
  // one as "omitted", which would be the same fact told twice.
  // ROUND 72 P2 — an `answered` verdict is an EVM answer, so it only
  // exempts a method that runs EVM code. Per call, not per response: one
  // whole-request error attributes to every call in the batch, and those
  // calls need not share a method.
  const answeredOutcome = (c, code) =>
    EXECUTING_METHODS.has(String(c.method))
      ? out(c, 'ok', `json-rpc ${code}`)
      : out(
          c,
          'unreachable',
          `json-rpc ${code} — a revert-shaped error from ${c.method}, which executes no code`,
        );

  // ROUND 75 P2 — a null id is only a WHOLE-REQUEST error when no call
  // asked under that id.
  //
  // Round 74 taught `rpcRequestCalls` to accept an explicit `"id": null`
  // as the present id the spec says it is, and left this test reading it
  // as the absent id of a parse error. So a mixed batch carrying one
  // legitimate null-id call had its ordinary reply treated as a failure
  // of the entire request, and every sibling was reported with it.
  //
  // `wanted` is the set of ids actually requested, so the question is
  // whether this null was asked for. A null nobody asked for is still the
  // canonical whole-request shape: the server never got far enough to
  // read the ids.
  const nullRequested = answerable.some((c) => c.id === null);
  const whole = members.find(
    (m) =>
      m?.error &&
      (m.id === undefined || (m.id === null && !nullRequested)),
  );
  if (whole) {
    const verdict = classifyRpcFailure(whole.error);
    return answerable.map((c) =>
      verdict === 'answered'
        ? answeredOutcome(c, whole.error?.code)
        : out(c, verdict, `json-rpc ${whole.error?.code}`),
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
      return verdict === 'answered'
        ? answeredOutcome(c, err.code)
        : out(c, verdict, `json-rpc ${err.code}`);
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
    if (answerable.length === 0) return [];
    if (answerable.length === 1) return [memberOutcome(answerable[0], members[0])];
    return answerable.map((c) => out(c, 'unreachable', 'batch answered with a single response'));
  }

  const wanted = new Set(answerable.map((c) => c.id));
  const byId = new Map();
  let unattributable = false;
  for (const m of members) {
    const id = m?.id;
    // ROUND 75 P2 — and a REQUESTED null matches normally here too.
    // Reading every null as unattributable marked the whole batch
    // unreachable because one call legitimately used that id, reporting
    // siblings whose replies had all arrived as infrastructure failures.
    if (id === undefined || !wanted.has(id) || byId.has(id)) {
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
    return answerable.map((c) =>
      out(c, 'unreachable', 'unexpected or duplicate member in batch response'),
    );
  }

  return answerable.map((c) => {
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
 * @param {{status: number, body: Buffer|string|undefined,
 *          requestBody: string|undefined, url: string}} response
 * @param {Array} ledger
 */
export function recordRpcResponse({ status, body, requestBody, url }, ledger) {
  // WHEN, as well as what (round 94 P2). Recovery is scoped by time
  // because nothing else can scope it — see `RETRY_RECOVERY_WINDOW_MS`.
  const at = Date.now();
  // ROUND 95 P2 — AND *WHICH RESPONSE*, because time alone cannot separate
  // a retry from a SIBLING. A JSON-RPC batch is one request carrying many
  // calls, and viem's batch scheduler will happily put two reads of the
  // same method and params into it — which is one `callKey`. Both outcomes
  // are then classified out of the same response body and stamped with the
  // same `at`, so an error in the earlier array slot and an `ok` in the
  // later one satisfied the recovery predicate exactly: later index, zero
  // elapsed. Nothing had retried anything. The first caller consumed its
  // error, the card may have rendered a degraded funds surface from it,
  // and the ledger came out clean.
  //
  // A retry is by definition a SECOND response. So an outcome may only
  // clear a failure it did not arrive with, and this id — monotonic,
  // per-response, never reused — is what says so.
  const response = ++responseSeq;
  for (const outcome of classifyRpcResponse(status, body, requestBody)) {
    ledger.push({ ...outcome, url, at, response });
  }
}

/** Per-response identity for {@link recordRpcResponse}; see its round-95 note. */
let responseSeq = 0;

/**
 * How long after a failed attempt a success may still be one of its
 * RETRIES rather than a separate poll.
 *
 * ROUND 94 P2 — because `callKey` is method plus params, and a page polls
 * the same method and params forever. A success from a LATER POLL was
 * clearing a failure the page had already consumed: one poll exhausted
 * every retry, the card may have rendered a degraded funds surface from
 * it, and the next poll's success wiped the record clean.
 *
 * NOTHING IDENTIFIES A LOGICAL REQUEST FROM OUTSIDE THE PAGE, and that is
 * measured rather than assumed: viem's `buildRequest` wraps the transport
 * in `withRetry`, and the HTTP transport takes `body.id ?? idCache.take()`
 * per call — so every attempt carries a FRESH id and two retries differ
 * from two polls in no observable way. Grouping by request identity is
 * therefore not available; time is what is left.
 *
 * One thing IS observable, and round 95 P2 found it by finding where its
 * absence hurt: two outcomes decoded from the SAME response are certainly
 * not a retry of one another, whatever their timestamps say. That test
 * lives in `recoveredAfter` and runs before this window, which cannot
 * express it — siblings are zero milliseconds apart.
 *
 * The ladder this has to cover is viem's default: `retryCount: 3` with
 * `retryDelay: 150` backing off exponentially, so ~150 + 300 + 600 ms
 * plus the transport time of each attempt. 1.5s covers that and stays
 * below any poll cadence the app can produce — its reads refetch on new
 * blocks, and the deployment's chain is on two-second blocks.
 *
 * THE RESIDUAL, and its direction. A provider slower than this window
 * means a genuine retry-recovery is not credited, so the run exits 2
 * BLOCKED on a page that recovered — loud and re-runnable, which is the
 * direction round 23 chose this rule's existence to avoid and the one
 * this file takes when it must pick. A page polling faster than 1.5s
 * would mis-scope the other way; none does.
 */
const RETRY_RECOVERY_WINDOW_MS = 1_500;

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
  // Every success per call, with when it happened — a single "last one"
  // cannot answer a question that is now about proximity rather than
  // order (round 94).
  const oks = new Map();
  ledger.forEach((e, i) => {
    if (e.verdict !== 'ok') return;
    const list = oks.get(e.key);
    const ok = { i, at: e.at, response: e.response };
    if (list) list.push(ok);
    else oks.set(e.key, [ok]);
  });
  /** Did a LATER success plausibly belong to the same logical request? */
  const recoveredAfter = (e, i) => {
    const list = oks.get(e.key);
    if (!list) return false;
    return list.some(({ i: j, at, response }) => {
      if (j <= i) return false;
      // A SIBLING IN THE SAME RESPONSE IS NOT A RETRY (round 95 P2), and
      // this is checked before the window rather than inside it: siblings
      // are zero milliseconds apart, so every time-based test passes them.
      // Same `undefined`-means-older rule as the timestamps below — a
      // record written before responses were identified is judged the way
      // it always was.
      if (
        typeof response === 'number' &&
        typeof e.response === 'number' &&
        response === e.response
      ) {
        return false;
      }
      // A record predating the timestamps cannot be scoped by them, and
      // must keep behaving as it did — the `undefined`-means-older rule
      // every field in this project follows.
      if (typeof at !== 'number' || typeof e.at !== 'number') return true;
      return at - e.at <= RETRY_RECOVERY_WINDOW_MS;
    });
  };

  const malformed = [];
  const unreachable = [];
  const seen = new Set();
  ledger.forEach((e, i) => {
    if (e.verdict === 'ok') return;
    // ROUND 74 P2 — A FAULT IN THE REQUEST ENVELOPE IS NOT RECOVERABLE.
    //
    // The round-23 rule exists for viem's retries and endpoint fallback,
    // and it is sound for a fault that is a property of the CALL: a
    // `callKey` is method plus params, so the same method and params
    // succeeding later proves the earlier `-32602` was the provider being
    // wrong rather than the page being malformed. That test stays green
    // and stays right.
    //
    // A DUPLICATE ID is a property of the BATCH ENVELOPE, which no
    // `callKey` carries — ids are deliberately excluded from it. So the
    // very next refresh of the same read cleared the finding, and the
    // drive exited 0 having watched the page consume ambiguously
    // attributed answers. The finding as reported said "only
    // `unreachable` is recoverable", which would have taken round 23's
    // case with it; what actually distinguishes them is what the fault is
    // a property of, so that is what is recorded.
    if (e.recoverable !== false && recoveredAfter(e, i)) return;
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
