/**
 * What the PAGE itself learned about one wallet's sanctions state — a
 * ledger of the app's own reads, observed on the wire (#2439).
 *
 * A live banner verdict is only meaningful against what the page was told.
 * The app fails open (no banner) when its flag read errors, and words the
 * recourse as unknown when an explanation read errors, so a banner that
 * disagrees with the chain may be the page's RPC rather than the app. This
 * ledger is how the drive tells the two apart, by recording for each read
 * of interest:
 *
 *   - WHEN the page started it (a read started before a window opened can
 *     return the old state inside it, so it never counts for that window);
 *   - WHETHER it was answered (a JSON-RPC `result`, no `error`, and for a
 *     read inside a Multicall3 `aggregate3`, that call's own `success`);
 *   - WHAT it answered (the decoded bool), so a stale provider that told the
 *     page the opposite of the chain is reported as such.
 *
 * It sees both transports the app uses: HTTP (viem's JSON-RPC batches) and
 * WebSocket (the `fallback` transport puts a configured WSS URL first). And
 * both call shapes: a plain `eth_call`, and the `aggregate3` wagmi's default
 * `batch.multicall` folds reads into.
 *
 * `judge` is the ONE place a window is assessed, so every verdict in the
 * drive — success path and failure path alike — rests on the same rule.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  multicall3Abi,
  pad,
  toFunctionSelector,
} from 'viem';

import { classifyRpcResponse, createSocketCalls } from './rpc-verdict.mjs';

const lower = (hex) => String(hex ?? '').toLowerCase();

/**
 * A read to watch for: `signature` called with `subject` as its only
 * argument, on `target`.
 */
export function watchedRead(signature, target, subject) {
  return { calldata: lower(toFunctionSelector(signature) + pad(subject).slice(2)), target: lower(target) };
}

/** Decode a bool return, or undefined when it is not one. */
function asBool(returnData) {
  try {
    return decodeAbiParameters([{ type: 'bool' }], returnData)[0];
  } catch {
    return undefined;
  }
}

/** Multicall3's canonical address — the same on every chain viem knows,
 *  Base Sepolia included. Only an `aggregate3` sent HERE is trusted to
 *  have executed its nested calls. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

/**
 * The watched reads one JSON-RPC call carries: `[{ kind, index }]`, where
 * `index` is the position inside an `aggregate3` or null for a plain call.
 */
export function matchCall(call, reads) {
  if (!call || call.method !== 'eth_call') return [];
  const tx = call.params?.[0] ?? {};
  const to = lower(tx.to);
  const data = lower(tx.data ?? tx.input);
  const out = [];
  for (const [kind, r] of Object.entries(reads)) {
    if (to === r.target && data === r.calldata) out.push({ kind, index: null });
  }
  if (out.length > 0) return out;
  // Nested calls count only inside the real Multicall3: the same calldata
  // sent to any other contract proves nothing about what was executed.
  if (to !== MULTICALL3) return [];
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: multicall3Abi, data });
  } catch {
    return [];
  }
  if (decoded.functionName !== 'aggregate3') return [];
  decoded.args[0].forEach((c, index) => {
    for (const [kind, r] of Object.entries(reads)) {
      if (lower(c.target) === r.target && lower(c.callData) === r.calldata) out.push({ kind, index });
    }
  });
  return out;
}

/**
 * What a JSON-RPC response says for one matched read: `{ answered, value }`.
 * Unanswered is a transport/RPC error, or a failed call inside a multicall.
 */
export function readAnswer(response, match) {
  if (!response || response.error !== undefined || response.result === undefined) {
    return { answered: false };
  }
  if (match.index === null) {
    const value = asBool(response.result);
    return value === undefined ? { answered: false } : { answered: true, value };
  }
  try {
    const results = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      data: response.result,
    });
    const r = results[match.index];
    if (!r || !r.success) return { answered: false };
    const value = asBool(r.returnData);
    return value === undefined ? { answered: false } : { answered: true, value };
  } catch {
    return { answered: false };
  }
}

const asList = (v) => (Array.isArray(v) ? v : [v]);

/**
 * The ledger. `reads` maps a kind to a `watchedRead`. Entries are
 * `{ kind, startedAt, answeredAt, answered, value, fault, block, match, requestBody }`;
 * `fault` is the classifier's reason when the provider refused the read as
 * malformed; `answered` stays undefined while
 * the read is in flight.
 */
export function createReadLedger(reads, now = () => Date.now()) {
  const entries = [];

  /** Record the watched reads in one request body; returns a resolver for
   *  its response body (an id → entries map). */
  function onRequest(bodyText) {
    let calls;
    try {
      calls = asList(JSON.parse(bodyText ?? 'null'));
    } catch {
      return null;
    }
    const pending = new Map();
    for (const c of calls) {
      for (const m of matchCall(c, reads)) {
        // The block the read was asked at: a hex number for a pinned read
        // (the app's periodic snapshot), a tag (`latest` when none is given)
        // for an unpinned one (its submit-time screen).
        const block = lower(c.params?.[1] ?? 'latest');
        // The request it rode in, so its answer is judged as a PAIR by the
        // shared classifier (#1633 r5).
        const entry = {
          kind: m.kind,
          startedAt: now(),
          answeredAt: undefined,
          answered: undefined,
          value: undefined,
          fault: undefined,
          block,
          match: m,
          requestBody: bodyText,
        };
        entries.push(entry);
        if (!pending.has(c.id)) pending.set(c.id, []);
        pending.get(c.id).push(entry);
      }
    }
    return pending.size > 0 ? pending : null;
  }

  /**
   * Settle the entries of `pending` from a response body (null = no usable
   * response: every pending entry is unanswered).
   *
   * The pair goes through the shared classifier FIRST (#1633 r5), the same
   * rule `watchPageRpc` and the RPC audit's ledger apply, so this ledger
   * cannot call a request the provider refused as malformed (`-32602`, an
   * invalid envelope, a reused batch id) an RPC outage. A `client-fault` is
   * recorded as such — a defect in what the page SENT — and `judge` reports
   * it ahead of every other state. Only an `ok` call is decoded for a value,
   * and only from a 2xx body: the page's transport does not hand a non-2xx
   * body to the app as a result, so the page never learned a value from it.
   *
   * `requestBody` is the request this answer belongs to; a socket passes the
   * one message it answers. Absent, the body the entries rode in is used.
   */
  function onResponse(pending, bodyText, { status = null, requestBody } = {}) {
    const request = requestBody ?? [...pending.values()][0]?.[0]?.requestBody;
    // A socket answer carries no HTTP status; it was delivered.
    const verdicts = bodyText == null ? [] : classifyRpcResponse(status ?? 200, bodyText, request);
    let responses = [];
    const pageSawIt = status === null || (status >= 200 && status < 300);
    if (bodyText != null && pageSawIt) {
      try {
        responses = asList(JSON.parse(bodyText));
      } catch {
        responses = [];
      }
    }
    // Ids compared by VALUE: two parses of an object id never match by
    // identity, and a malformed envelope may carry one (#1633 r3).
    const sameId = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const responseFor = (id) => responses.find((r) => r && 'id' in r && sameId(r.id, id));
    for (const [id, list] of pending) {
      const v = verdicts.find((o) => sameId(o.id, id));
      for (const e of list) {
        // A fault is a fact about the request: no later answer undoes it.
        if (e.fault !== undefined) continue;
        if (v?.verdict === 'client-fault') {
          e.answered = false;
          e.value = undefined;
          e.fault = v.why;
        } else {
          const a = v?.verdict === 'ok' ? readAnswer(responseFor(id), e.match) : { answered: false };
          e.answered = a.answered;
          e.value = a.value;
        }
        e.answeredAt = now();
      }
    }
  }

  /** Every watched read a reachable provider refused as malformed, across
   *  the whole session — a finding whatever window a drive is judging. */
  function faults() {
    return entries.filter((e) => e.fault !== undefined).map((e) => ({ kind: e.kind, why: e.fault }));
  }

  /**
   * Assess the page's `kind` reads STARTED at or after `since` — and, when
   * `until` is given, only the answers that had ARRIVED by then, so a
   * banner observed at `until` is judged against what the page knew when
   * it showed it, not against a later refresh:
   *   - `none`       — the page never started one: the app did not ask;
   *   - `fault`      — a reachable provider refused one as malformed (the
   *                    classifier's `client-fault`), whatever else answered;
   *   - `unanswered` — it asked and no answer came back (in flight counts);
   *   - `disagrees`  — the latest answer says the opposite of `expected`;
   *   - `agrees`     — the latest answer says `expected`.
   */
  function judge(kind, since, expected, until = Infinity) {
    const inWindow = entries.filter((e) => e.kind === kind && e.startedAt >= since && e.startedAt <= until);
    if (inWindow.length === 0) return { state: 'none' };
    // A refused-as-malformed read outranks every other state: it is a
    // defect in the request, and no later answer makes it right.
    const faulted = inWindow.find((e) => e.fault !== undefined && e.answeredAt <= until);
    if (faulted) return { state: 'fault', why: faulted.fault };
    const answered = inWindow.filter((e) => e.answered === true && e.answeredAt <= until);
    if (answered.length === 0) return { state: 'unanswered', attempts: inWindow.length };
    const latest = answered[answered.length - 1];
    return { state: latest.value === expected ? 'agrees' : 'disagrees', value: latest.value };
  }

  return { entries, onRequest, onResponse, judge, faults };
}

/**
 * WalletConnect's relay: a JSON-RPC protocol of its own (`irn_subscribe`,
 * `irn_publish`, …) on WalletConnect's relay hosts. The app opens it on
 * every page load and it carries no chain call, so judging it against the
 * chain read list failed the #2439 live run on traffic the guard is not
 * about. This is the ONE exemption, and it needs both the relay host and
 * the relay namespace; every other method on every other socket is judged
 * against the single read allowlist, as every other door is — a node
 * socket's unlisted method is refused whatever its namespace (`anvil_`,
 * `evm_`, a vendor extension).
 */
const WALLETCONNECT_RELAY_HOST = /^relay\.walletconnect\.(org|com)$/;
const WALLETCONNECT_RELAY_METHOD = /^irn_/;

function isWalletConnectRelay(socketUrl, method) {
  let host;
  try {
    host = new URL(socketUrl).hostname;
  } catch {
    return false;
  }
  return WALLETCONNECT_RELAY_HOST.test(host) && WALLETCONNECT_RELAY_METHOD.test(method);
}

/** Whether a JSON-RPC `method` sent on the socket at `socketUrl` is one
 *  the read-only drive must refuse: anything off `readMethods`, except
 *  WalletConnect's own relay protocol on its relay host. */
export function isRefusedSocketMethod(socketUrl, method, readMethods) {
  if (typeof method !== 'string') return false;
  if (readMethods.has(method)) return false;
  return !isWalletConnectRelay(socketUrl, method);
}

/** Feed `ledger` from everything the page sends: HTTP POSTs and
 *  WebSocket frames.
 *
 *  The ledger is `{ onRequest(bodyText) → pending | null,
 *  onResponse(pending, bodyText | null, { status, requestBody }) }`.
 *  `status` is the HTTP status (null on a socket, or when nothing came
 *  back) and `requestBody` the request the answer belongs to, so a ledger
 *  can judge the pair with the shared classifier (#1633).
 *
 *  The WebSocket is also the one door `launch`'s read-only guard does not
 *  cover (it gates the injected wallet and HTTP routes). Every JSON-RPC
 *  method the page SENDS on a socket is checked against `readMethods`
 *  (`isRefusedSocketMethod`, whose one exemption is WalletConnect's relay),
 *  and one outside it is recorded in the returned `wsViolations` —
 *  observed, not prevented, so the drive must fail on any entry.
 *
 *  `settled(graceMs)` waits, bounded, for the HTTP reads still in flight;
 *  call it before deciding a verdict. */
export function attachLedger(page, ledger, readMethods) {
  const wsViolations = [];
  // Each HTTP read still waiting for its answer, so `settled` can let it
  // land before a drive decides (#1633 r5).
  const inFlight = new Set();
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const pending = ledger.onRequest(req.postData());
    if (pending === null) return;
    const settling = req
      .response()
      .then(async (res) => {
        if (res === null) return ledger.onResponse(pending, null, { status: null });
        let text = null;
        try {
          text = await res.text();
        } catch {
          /* unreadable: unanswered */
        }
        // Every status, with the request it answers: whether a non-2xx body
        // still answered is the ledger's question, decided by the shared
        // classifier, not this observer's (#1633). A provider that parsed a
        // malformed request and said so at 400 has answered.
        ledger.onResponse(pending, text, { status: res.status(), requestBody: req.postData() ?? undefined });
      })
      .catch(() => ledger.onResponse(pending, null, { status: null }))
      .finally(() => inFlight.delete(settling));
    inFlight.add(settling);
  });
  page.on('websocket', (ws) => {
    // The calls outstanding on this connection, matched by id. A reused id
    // comes back from `send` as a collision, settled at once against a
    // request holding every colliding call, so the ledger's classifier
    // judges it as the duplicate id it is (`createSocketCalls`, #1633 r1).
    const calls = createSocketCalls();
    ws.on('framesent', (f) => {
      try {
        for (const m of asList(JSON.parse(String(f.payload)))) {
          if (m && isRefusedSocketMethod(ws.url(), m.method, readMethods)) {
            wsViolations.push({ reason: `websocket rpc ${m.method} (not a permitted read)`, url: ws.url() });
          }
        }
      } catch {
        /* not JSON-RPC: nothing to judge */
      }
      // Each message is recorded on its OWN, at the moment the correlator
      // takes it, so its tag is its own ledger entries and a settlement can
      // only ever touch the message it belongs to (#1633 r7). Recording the
      // whole frame keyed by id let a malformed message and a well-formed one
      // reusing its id share one entry list, and the later reply overwrote
      // the fault. A well-formed notification (no id) expects no answer and
      // is not recorded.
      const tagFor = (m) => ledger.onRequest(JSON.stringify(m));
      // A malformed envelope or an id collision: settled now, from the request.
      for (const { entries, requestBody } of calls.send(f.payload, tagFor)) {
        for (const { tag } of entries) ledger.onResponse(tag, '[]', { status: null, requestBody });
      }
    });
    ws.on('framereceived', (f) => {
      // A socket has no HTTP status: a delivered message is the answer, and
      // each is classified against its own call's message.
      for (const { tag, reply, requestBody } of calls.receive(f.payload)) {
        ledger.onResponse(tag, reply, { status: null, requestBody });
      }
    });
    ws.on('close', () => {
      for (const { tag } of calls.close()) {
        ledger.onResponse(tag, null, { status: null });
      }
    });
  });
  /** Wait, at most `graceMs`, for the HTTP reads still in flight, so a
   *  verdict decided next sees what they carry — a malformed read the
   *  provider is still refusing outranks the BLOCKED exit a drive is about
   *  to take. A read still pending at the deadline simply did not land. */
  const settled = async (graceMs = 5_000) => {
    if (inFlight.size === 0) return;
    let timer;
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((r) => {
        timer = setTimeout(r, graceMs);
      }),
    ]);
    clearTimeout(timer);
  };
  return { wsViolations, settled };
}
