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
 * `{ kind, startedAt, answeredAt, answered, value }`; `answered` stays undefined while
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
        const entry = { kind: m.kind, startedAt: now(), answeredAt: undefined, answered: undefined, value: undefined, match: m };
        entries.push(entry);
        if (!pending.has(c.id)) pending.set(c.id, []);
        pending.get(c.id).push(entry);
      }
    }
    return pending.size > 0 ? pending : null;
  }

  /** Settle the entries of `pending` from a response body (null = no
   *  usable response: every pending entry is unanswered). */
  function onResponse(pending, bodyText) {
    let responses = [];
    if (bodyText != null) {
      try {
        responses = asList(JSON.parse(bodyText));
      } catch {
        responses = [];
      }
    }
    const byId = new Map(responses.filter((r) => r && 'id' in r).map((r) => [r.id, r]));
    for (const [id, list] of pending) {
      for (const e of list) {
        const a = readAnswer(byId.get(id), e.match);
        e.answered = a.answered;
        e.value = a.value;
        e.answeredAt = now();
      }
    }
  }

  /**
   * Assess the page's `kind` reads STARTED at or after `since` — and, when
   * `until` is given, only the answers that had ARRIVED by then, so a
   * banner observed at `until` is judged against what the page knew when
   * it showed it, not against a later refresh:
   *   - `none`       — the page never started one: the app did not ask;
   *   - `unanswered` — it asked and no answer came back (in flight counts);
   *   - `disagrees`  — the latest answer says the opposite of `expected`;
   *   - `agrees`     — the latest answer says `expected`.
   */
  function judge(kind, since, expected, until = Infinity) {
    const inWindow = entries.filter((e) => e.kind === kind && e.startedAt >= since && e.startedAt <= until);
    if (inWindow.length === 0) return { state: 'none' };
    const answered = inWindow.filter((e) => e.answered === true && e.answeredAt <= until);
    if (answered.length === 0) return { state: 'unanswered', attempts: inWindow.length };
    const latest = answered[answered.length - 1];
    return { state: latest.value === expected ? 'agrees' : 'disagrees', value: latest.value };
  }

  return { entries, onRequest, onResponse, judge };
}

/** Feed `ledger` from everything the page sends: HTTP POSTs and
 *  WebSocket frames.
 *
 *  The WebSocket is also the one door `launch`'s read-only guard does not
 *  cover (it gates the injected wallet and HTTP routes). Every JSON-RPC
 *  method the page SENDS on a socket is checked against `readMethods`, and
 *  one outside it is recorded in the returned `wsViolations` — observed,
 *  not prevented, so the drive must fail on any entry. */
export function attachLedger(page, ledger, readMethods) {
  const wsViolations = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const pending = ledger.onRequest(req.postData());
    if (pending === null) return;
    req
      .response()
      .then(async (res) => {
        if (res === null || res.status() !== 200) return ledger.onResponse(pending, null);
        let text = null;
        try {
          text = await res.text();
        } catch {
          /* unreadable: unanswered */
        }
        ledger.onResponse(pending, text);
      })
      .catch(() => ledger.onResponse(pending, null));
  });
  page.on('websocket', (ws) => {
    const open = new Map(); // JSON-RPC id -> pending, per connection
    ws.on('framesent', (f) => {
      try {
        for (const m of asList(JSON.parse(String(f.payload)))) {
          if (m && typeof m.method === 'string' && !readMethods.has(m.method)) {
            wsViolations.push({ reason: `websocket rpc ${m.method} (not a permitted read)`, url: ws.url() });
          }
        }
      } catch {
        /* not JSON-RPC: nothing to judge */
      }
      const pending = ledger.onRequest(String(f.payload));
      if (pending === null) return;
      for (const [id] of pending) open.set(id, pending);
    });
    ws.on('framereceived', (f) => {
      let msgs;
      try {
        msgs = asList(JSON.parse(String(f.payload)));
      } catch {
        return;
      }
      for (const m of msgs) {
        const pending = m && open.get(m.id);
        if (!pending) continue;
        open.delete(m.id);
        ledger.onResponse(new Map([[m.id, pending.get(m.id)]]), JSON.stringify(m));
      }
    });
    ws.on('close', () => {
      for (const [id, pending] of open) ledger.onResponse(new Map([[id, pending.get(id)]]), null);
      open.clear();
    });
  });
  return { wsViolations };
}
