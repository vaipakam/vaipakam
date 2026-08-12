/**
 * #1529 review round 21 — the page-RPC failure classifier.
 *
 * Extracted and tested rather than checked by hand, on round 20's
 * lesson: round 19 verified the predicate this replaces with a throwaway
 * script, and three bypasses shipped behind a comment claiming they were
 * covered.
 *
 * The errors here are shaped the way viem delivers them — the provider's
 * code and data on an INNER cause, reachable through `walk` — because
 * testing the top-level object is precisely the mistake round 20 found.
 */
import { describe, expect, it } from 'vitest';
import {
  callsTargetContract,
  classifyRpcFailure,
  classifyRpcResponse,
  recordRpcResponse,
  rpcRequestCalls,
  summariseRpcLedger,
} from './rpc-verdict.mjs';

/** A viem-shaped wrapper: the useful fields sit on a cause, and `walk`
 *  is how viem exposes the chain. */
function viemError({ code, data } = {}) {
  const inner = { code, data };
  const err = new Error('rpc failed');
  err.cause = inner;
  err.walk = (fn) => (fn(err) ? err : fn(inner) ? inner : null);
  return err;
}

describe('classifyRpcFailure', () => {
  it('reads a revert off the error chain, not the top level', () => {
    expect(classifyRpcFailure(viemError({ code: 3 }))).toBe('answered');
  });

  it('accepts revert bytes carried under a provider-specific code', () => {
    // Some providers label a genuine revert -32000; the bytes decide.
    expect(
      classifyRpcFailure(viemError({ code: -32000, data: '0x7e273289' })),
    ).toBe('answered');
  });

  it('does not treat an empty 0x as revert bytes', () => {
    expect(classifyRpcFailure(viemError({ code: -32603, data: '0x' }))).toBe(
      'unreachable',
    );
  });

  it('calls invalid params a client fault, not an unreachable endpoint', () => {
    // The round-21 finding: the provider RECEIVED and rejected the page's
    // request. Filing this as "could not fetch" exits 2 and hides an app
    // defect behind an infrastructure verdict.
    expect(classifyRpcFailure(viemError({ code: -32602 }))).toBe('client-fault');
  });

  it('covers the other two malformed-request codes', () => {
    expect(classifyRpcFailure(viemError({ code: -32700 }))).toBe('client-fault');
    expect(classifyRpcFailure(viemError({ code: -32600 }))).toBe('client-fault');
  });

  it('leaves method-not-found as infrastructure', () => {
    // -32601 describes what the SERVER implements, not whether the
    // request was well formed. A provider lacking a method is a fact
    // about that endpoint, so it must not be blamed on the app.
    expect(classifyRpcFailure(viemError({ code: -32601 }))).toBe('unreachable');
  });

  it.each([
    ['rate limited', -32005],
    ['unavailable', -32002],
    ['internal', -32603],
  ])('keeps %s unreachable', (_label, code) => {
    expect(classifyRpcFailure(viemError({ code }))).toBe('unreachable');
  });

  it('treats a transport failure with no code as unreachable', () => {
    const err = new Error('fetch failed');
    expect(classifyRpcFailure(err)).toBe('unreachable');
  });

  it('survives an error with no walk at all', () => {
    expect(classifyRpcFailure({ code: -32602 })).toBe('client-fault');
    expect(classifyRpcFailure(undefined)).toBe('unreachable');
  });
});

/**
 * #1529 review rounds 22 + 23 — the same question asked of a RESOLVED
 * response, and asked PER CALL.
 *
 * The routed shim serves every page request, and a provider that
 * rate-limits or rejects a call answers over a perfectly ordinary HTTP
 * response. `fetch` resolves, so none of the error-path classification
 * above ever runs.
 */
const rpcReq = (...calls) => JSON.stringify(calls.length === 1 ? calls[0] : calls);
const call = (id, method = 'eth_call', params = []) => ({ jsonrpc: '2.0', id, method, params });
const okBody = (id, result = '0x1') => JSON.stringify({ jsonrpc: '2.0', id, result });
const errBody = (id, error) => JSON.stringify({ jsonrpc: '2.0', id, error });
/** viem only forgives a non-2xx when BOTH fields are present. */
const rpcErr = (code, message = 'nope') => ({ code, message });

const verdicts = (out) => out.map((o) => o.verdict);

describe('classifyRpcResponse', () => {
  it('ignores traffic that is not JSON-RPC at all', () => {
    // This shim serves the WHOLE site. An HTML document, a JS bundle or
    // the app's own API must not be judged by the RPC verdict — including
    // when they fail, which is somebody else's check.
    expect(classifyRpcResponse(200, '<!doctype html>', undefined)).toEqual([]);
    expect(classifyRpcResponse(500, 'boom', undefined)).toEqual([]);
    expect(classifyRpcResponse(500, '{"detail":"nope"}', '{"notRpc":true}')).toEqual([]);
  });

  it('reports a successful call as ok', () => {
    expect(verdicts(classifyRpcResponse(200, okBody(1), rpcReq(call(1))))).toEqual(['ok']);
  });

  it('treats an ordinary revert as ok, not a failure', () => {
    // The load-bearing case. A revert is delivered as an HTTP 200 JSON-RPC
    // error and the app is expected to handle it; recording it would exit
    // non-zero on every healthy run.
    const out = classifyRpcResponse(200, errBody(1, { code: 3, message: 'reverted' }), rpcReq(call(1)));
    expect(verdicts(out)).toEqual(['ok']);
  });

  it('treats a revert carried as -32000 as ok', () => {
    const out = classifyRpcResponse(
      200,
      errBody(1, { code: -32000, message: 'reverted', data: '0x7e273289' }),
      rpcReq(call(1)),
    );
    expect(verdicts(out)).toEqual(['ok']);
  });

  it('calls a rate-limited read unreachable, naming the method', () => {
    const out = classifyRpcResponse(200, errBody(1, rpcErr(-32005)), rpcReq(call(1, 'eth_getLogs')));
    expect(out).toEqual([
      { key: 'eth_getLogs|[]', method: 'eth_getLogs', verdict: 'unreachable', why: 'json-rpc -32005' },
    ]);
  });

  it('calls malformed params a client fault', () => {
    const out = classifyRpcResponse(200, errBody(1, rpcErr(-32602)), rpcReq(call(1)));
    expect(verdicts(out)).toEqual(['client-fault']);
  });

  it('keeps method-not-found infrastructure on this path too', () => {
    const out = classifyRpcResponse(200, errBody(1, rpcErr(-32601)), rpcReq(call(1)));
    expect(verdicts(out)).toEqual(['unreachable']);
  });

  it.each([429, 500, 502, 503])('treats a plain-text HTTP %i as unreachable', (status) => {
    // The body says nothing about what was asked, which is why the
    // REQUEST is the discriminator.
    const out = classifyRpcResponse(status, 'Too Many Requests', rpcReq(call(1)));
    expect(out).toEqual([
      { key: 'eth_call|[]', method: 'eth_call', verdict: 'unreachable', why: `HTTP ${status}` },
    ]);
  });

  it('treats a non-JSON 200 answer as unreachable', () => {
    const out = classifyRpcResponse(200, '<html>gateway</html>', rpcReq(call(1)));
    expect(verdicts(out)).toEqual(['unreachable']);
    expect(out[0].why).toMatch(/non-JSON/);
  });

  it.each([
    ['Buffer', (s) => Buffer.from(s)],
    // A bare Uint8Array is the discriminating case: `JSON.parse` coerces a
    // Buffer to its utf8 text for free, so a Buffer alone would pass even
    // with the decode removed.
    ['Uint8Array', (s) => new Uint8Array(Buffer.from(s))],
  ])('decodes a %s body', (_label, wrap) => {
    const out = classifyRpcResponse(200, wrap(errBody(1, rpcErr(-32005))), rpcReq(call(1)));
    expect(verdicts(out)).toEqual(['unreachable']);
  });

  describe('a non-2xx that still carries an answer (round 23)', () => {
    it('calls a 400 with a well-formed -32602 a client fault, not BLOCKED', () => {
      // viem returns the body rather than throwing when it holds a valid
      // JSON-RPC error, so the page really does see a malformed-request
      // error. Filing it as "could not fetch" exits 2 and hides the defect.
      const out = classifyRpcResponse(400, errBody(1, rpcErr(-32602, 'invalid params')), rpcReq(call(1)));
      expect(verdicts(out)).toEqual(['client-fault']);
    });

    it('still calls a 500 carrying -32603 unreachable', () => {
      const out = classifyRpcResponse(500, errBody(1, rpcErr(-32603, 'internal')), rpcReq(call(1)));
      expect(verdicts(out)).toEqual(['unreachable']);
      expect(out[0].why).toBe('json-rpc -32603');
    });

    it('requires a MESSAGE as well as a code, exactly as viem does', () => {
      // viem throws HttpRequestError when either field is missing, so the
      // page sees a transport failure, not a malformed-request error.
      const out = classifyRpcResponse(400, errBody(1, { code: -32602 }), rpcReq(call(1)));
      expect(verdicts(out)).toEqual(['unreachable']);
      expect(out[0].why).toBe('HTTP 400');
    });

    it('never forgives a non-2xx BATCH, because viem cannot see past it', () => {
      // `data.error` is undefined on an array body, so viem throws for the
      // whole batch however well-formed the members look.
      const out = classifyRpcResponse(
        400,
        JSON.stringify([{ jsonrpc: '2.0', id: 1, error: rpcErr(-32602) }]),
        rpcReq(call(1)),
      );
      expect(verdicts(out)).toEqual(['unreachable']);
      expect(out[0].why).toBe('HTTP 400');
    });
  });

  describe('batches', () => {
    it('judges every member independently', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: rpcErr(-32005) },
          { jsonrpc: '2.0', id: 2, error: rpcErr(-32602) },
        ]),
        rpcReq(call(1, 'eth_getLogs'), call(2, 'eth_call')),
      );
      expect(verdicts(out)).toEqual(['unreachable', 'client-fault']);
    });

    it('does not let a healthy revert mask a sibling failure', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'reverted' } },
          { jsonrpc: '2.0', id: 2, error: rpcErr(-32005) },
        ]),
        rpcReq(call(1), call(2, 'eth_getBalance')),
      );
      expect(verdicts(out)).toEqual(['ok', 'unreachable']);
    });

    it('records an OMITTED member as unreachable (round 23)', () => {
      // viem resolves batches positionally, so a dropped member does not
      // merely yield undefined — it can hand one call another's answer.
      const out = classifyRpcResponse(
        200,
        JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x1' }]),
        rpcReq(call(1, 'eth_call'), call(2, 'eth_getBalance')),
      );
      expect(verdicts(out)).toEqual(['ok', 'unreachable']);
      expect(out[1].why).toBe('omitted from batch response');
    });

    it('records every member of a wholly empty batch response', () => {
      const out = classifyRpcResponse(200, '[]', rpcReq(call(1), call(2)));
      expect(verdicts(out)).toEqual(['unreachable', 'unreachable']);
    });

    it('attributes an id-less error to every call, once', () => {
      // A parse error never got as far as reading the ids, so reporting
      // each call as separately "omitted" would tell the same fact twice.
      const out = classifyRpcResponse(
        200,
        JSON.stringify({ jsonrpc: '2.0', id: null, error: rpcErr(-32700, 'parse error') }),
        rpcReq(call(1), call(2)),
      );
      expect(verdicts(out)).toEqual(['client-fault', 'client-fault']);
      expect(out.every((o) => o.why === 'json-rpc -32700')).toBe(true);
    });

    it('reports nothing when every member succeeded', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: '0x1' },
          { jsonrpc: '2.0', id: 2, result: '0x2' },
        ]),
        rpcReq(call(1), call(2)),
      );
      expect(verdicts(out)).toEqual(['ok', 'ok']);
    });
  });
});

/**
 * #1529 review round 24 — more ways a response can look answered without
 * having answered, all of which used to record `ok`.
 */
describe('classifyRpcResponse — responses that only look answered', () => {
  it('does not call a member with neither result nor error a success', () => {
    // `{"jsonrpc":"2.0","id":1}` has no error to report, but viem reads
    // `result` off it and hands the page `undefined`.
    const out = classifyRpcResponse(200, JSON.stringify({ jsonrpc: '2.0', id: 1 }), rpcReq(call(1)));
    expect(out).toEqual([
      {
        key: 'eth_call|[]',
        method: 'eth_call',
        verdict: 'unreachable',
        why: 'neither result nor error',
      },
    ]);
  });

  it('treats an explicit null error with no result the same way', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: null });
    expect(verdicts(classifyRpcResponse(200, body, rpcReq(call(1))))).toEqual(['unreachable']);
  });

  it('still accepts a null error alongside a real result', () => {
    // Belt-and-braces providers send both; the result is what matters.
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: null, result: '0x1' });
    expect(verdicts(classifyRpcResponse(200, body, rpcReq(call(1))))).toEqual(['ok']);
  });

  it('accepts a null result — that is an answer, not an absence', () => {
    // `eth_getTransactionReceipt` for an unmined hash answers with null.
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: null });
    expect(verdicts(classifyRpcResponse(200, body, rpcReq(call(1))))).toEqual(['ok']);
  });

  it('rejects an error member that is not a JSON-RPC error object', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: 'kaboom' });
    expect(verdicts(classifyRpcResponse(200, body, rpcReq(call(1))))).toEqual(['unreachable']);
  });

  it('rejects a batch with a SURPLUS member, even when every id asked for is present', () => {
    // viem sorts the members and resolves them positionally, so the extra
    // id-9 member is handed to the call that asked for id 10, and id 10's
    // answer goes to id 11. Both requested ids are present, and both used
    // to record ok.
    const out = classifyRpcResponse(
      200,
      JSON.stringify([
        { jsonrpc: '2.0', id: 9, result: '0x9' },
        { jsonrpc: '2.0', id: 10, result: '0xa' },
        { jsonrpc: '2.0', id: 11, result: '0xb' },
      ]),
      rpcReq(call(10), call(11)),
    );
    expect(verdicts(out)).toEqual(['unreachable', 'unreachable']);
    expect(out[0].why).toMatch(/unexpected or duplicate member/);
  });

  it('rejects a batch carrying a DUPLICATE member', () => {
    const out = classifyRpcResponse(
      200,
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: '0x1' },
        { jsonrpc: '2.0', id: 1, result: '0x2' },
      ]),
      rpcReq(call(1), call(2)),
    );
    expect(verdicts(out)).toEqual(['unreachable', 'unreachable']);
  });

  it('still reports an OMISSION per call rather than poisoning the batch', () => {
    // The distinction that keeps the surplus rule from swallowing round
    // 23's finding: an omission costs exactly one call, and the members
    // that did come back are still trustworthy.
    const out = classifyRpcResponse(
      200,
      JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x1' }]),
      rpcReq(call(1), call(2)),
    );
    expect(verdicts(out)).toEqual(['ok', 'unreachable']);
    expect(out[1].why).toBe('omitted from batch response');
  });

  it('calls a batch answered with a single response unreachable for every call', () => {
    const out = classifyRpcResponse(200, okBody(1), rpcReq(call(1), call(2)));
    expect(verdicts(out)).toEqual(['unreachable', 'unreachable']);
  });
});

describe('rpcRequestCalls', () => {
  it('refuses an empty batch instead of passing it vacuously', () => {
    // `[].every(...)` is true, which is how an app-generated invalid
    // request rode through the route gate and then went unjudged.
    expect(rpcRequestCalls([])).toBeUndefined();
  });

  it('refuses a member whose method is missing or not a string', () => {
    expect(rpcRequestCalls({ jsonrpc: '2.0', id: 1 })).toBeUndefined();
    expect(rpcRequestCalls({ jsonrpc: '2.0', id: 1, method: 42 })).toBeUndefined();
    expect(rpcRequestCalls({ jsonrpc: '2.0', id: 1, method: '' })).toBeUndefined();
  });

  it('refuses a non-object member and a non-RPC body', () => {
    expect(rpcRequestCalls(['eth_call'])).toBeUndefined();
    expect(rpcRequestCalls({ notRpc: true })).toBeUndefined();
    expect(rpcRequestCalls(null)).toBeUndefined();
  });

  it('accepts the shapes viem actually sends', () => {
    expect(rpcRequestCalls({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] })).toHaveLength(
      1,
    );
    expect(rpcRequestCalls({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' })).toHaveLength(1);
    expect(rpcRequestCalls([call(1), call(2)])).toHaveLength(2);
  });

  // Round 25: the predicate's own two loose clauses. Both let a malformed
  // app request count as well formed, and a lenient provider answering it
  // then produced a clean run.
  it('refuses a version that is not exactly 2.0', () => {
    expect(rpcRequestCalls({ jsonrpc: '1.0', id: 1, method: 'eth_call', params: [] })).toBeUndefined();
    expect(rpcRequestCalls({ jsonrpc: '2', id: 1, method: 'eth_call', params: [] })).toBeUndefined();
    expect(rpcRequestCalls({ id: 1, method: 'eth_call', params: [] })).toBeUndefined();
  });

  it('refuses null params, which typeof calls an object', () => {
    expect(
      rpcRequestCalls({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: null }),
    ).toBeUndefined();
  });

  it('still accepts both structured params shapes the spec allows', () => {
    // An ARRAY is what viem sends; a by-name object is legal JSON-RPC and
    // must not be swept up by the null fix.
    expect(
      rpcRequestCalls({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x1' }] }),
    ).toHaveLength(1);
    expect(
      rpcRequestCalls({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: { to: '0x1' } }),
    ).toHaveLength(1);
  });
});

/**
 * Round 25: which endpoint is serving the DEPLOYMENT.
 *
 * The chain check needs this because the page uses more than one network
 * on purpose — an explicit chain-1 transport backs ENS reverse lookups —
 * and asserting the review's chain against every endpoint the page touches
 * reported a healthy site as built for the wrong network.
 */
describe('callsTargetContract', () => {
  const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
  const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });

  it('matches an eth_call addressed to the contract, whatever the case', () => {
    expect(callsTargetContract([rpc('eth_call', [{ to: DIAMOND.toLowerCase() }, 'latest'])], DIAMOND)).toBe(
      true,
    );
    expect(callsTargetContract([rpc('eth_call', [{ to: DIAMOND.toUpperCase() }])], DIAMOND)).toBe(
      true,
    );
  });

  it('matches eth_getLogs whether address is one or many', () => {
    expect(callsTargetContract([rpc('eth_getLogs', [{ address: DIAMOND }])], DIAMOND)).toBe(true);
    expect(
      callsTargetContract([rpc('eth_getLogs', [{ address: ['0xdead', DIAMOND] }])], DIAMOND),
    ).toBe(true);
  });

  it('finds the contract anywhere in a batch, not only first', () => {
    expect(
      callsTargetContract(
        [rpc('eth_blockNumber', []), rpc('eth_call', [{ to: DIAMOND }])],
        DIAMOND,
      ),
    ).toBe(true);
  });

  // The whole point: an ENS lookup is an eth_call to a DIFFERENT contract
  // on chain 1, and must not mark its endpoint as serving our deployment.
  it('does not match another contract on another chain', () => {
    expect(
      callsTargetContract(
        [rpc('eth_call', [{ to: '0xce01f8eee7E479C928F8919abD53E553a36CeF67' }, 'latest'])],
        DIAMOND,
      ),
    ).toBe(false);
  });

  it('does not match chain-agnostic traffic', () => {
    expect(callsTargetContract([rpc('eth_blockNumber', []), rpc('eth_chainId', [])], DIAMOND)).toBe(
      false,
    );
  });

  it('is false rather than throwing on missing pieces', () => {
    expect(callsTargetContract([rpc('eth_call', [])], DIAMOND)).toBe(false);
    expect(callsTargetContract([rpc('eth_call')], DIAMOND)).toBe(false);
    expect(callsTargetContract(undefined, DIAMOND)).toBe(false);
    expect(callsTargetContract([rpc('eth_call', [{ to: DIAMOND }])], undefined)).toBe(false);
  });
});

/**
 * The LEDGER, tested separately from the predicate.
 *
 * Round 19 verified a classifier with a throwaway script and three
 * bypasses shipped anyway. A correct verdict filed into the wrong bucket
 * is the same defect in a different coat: `malformed` exits 1 as an app
 * finding, `unreachable` exits 2 as "re-run".
 */
describe('recordRpcResponse + summariseRpcLedger', () => {
  const ledgerOf = (...responses) => {
    const l = [];
    for (const r of responses) recordRpcResponse(r, l);
    return l;
  };
  // `at` is the arrival stamp the ledger clusters on. Default all attempts
  // to ONE instant so the existing cases read as a single operation; the
  // cluster-boundary cases pass it explicitly.
  const attempt = (
    status,
    body,
    requestBody,
    url = 'https://rpc.example',
    at = 1_000,
  ) => ({
    status,
    body,
    requestBody,
    url,
    at,
  });

  it('files a client fault as an app finding, not as flaky egress', () => {
    const out = summariseRpcLedger(
      ledgerOf(attempt(200, errBody(1, rpcErr(-32602)), rpcReq(call(1)))),
    );
    expect(out.malformed).toEqual([
      { url: 'https://rpc.example', why: 'eth_call — json-rpc -32602' },
    ]);
    expect(out.unreachable).toEqual([]);
  });

  it('files an unreachable provider as BLOCKED, not as an app finding', () => {
    const out = summariseRpcLedger(ledgerOf(attempt(429, 'slow down', rpcReq(call(1)))));
    expect(out.unreachable).toEqual([
      { url: 'https://rpc.example', why: 'eth_call — HTTP 429' },
    ]);
    expect(out.malformed).toEqual([]);
  });

  it('records nothing for a healthy response, a revert, or a page asset', () => {
    const out = summariseRpcLedger(
      ledgerOf(
        attempt(200, okBody(1), rpcReq(call(1))),
        attempt(200, errBody(1, { code: 3, message: 'reverted' }), rpcReq(call(1))),
        attempt(200, '<!doctype html>', undefined),
      ),
    );
    expect(out).toEqual({ malformed: [], unreachable: [] });
  });

  describe('reconciliation across attempts (round 23)', () => {
    it('clears a failure that a LATER attempt recovered', () => {
      // viem retries, and wagmi wraps these transports in fallback([...]).
      // The page got its answer, so the drive must not exit 2.
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(429, 'slow down', rpcReq(call(1, 'eth_getLogs'))),
          attempt(200, okBody(1), rpcReq(call(1, 'eth_getLogs')), 'https://backup.example'),
        ),
      );
      expect(out).toEqual({ malformed: [], unreachable: [] });
    });

    it('clears a client fault a DIFFERENT endpoint then answered', () => {
      // The fallback case. viem's `shouldRetry` is false for a well-formed
      // JSON-RPC error, so this is never a retry — but `fallback` does move
      // to its next endpoint on one, and that is a real recovery.
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(400, errBody(1, rpcErr(-32602)), rpcReq(call(1))),
          attempt(200, okBody(1), rpcReq(call(1)), 'https://backup.example'),
        ),
      );
      expect(out).toEqual({ malformed: [], unreachable: [] });
    });

    it('keeps a client fault the page hit again much LATER (#1583)', () => {
      // A success a poll interval away is the page asking again, not this
      // operation recovering — so the fault stands. This is the sound form
      // of the retired same-endpoint rule (Codex #1583 r1): what makes the
      // later success unrelated is the GAP, not the endpoint it landed on.
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(400, errBody(1, rpcErr(-32602)), rpcReq(call(1))),
          attempt(200, okBody(1), rpcReq(call(1)), 'https://rpc.example', 61_000),
        ),
      );
      expect(out.malformed).toEqual([
        { url: 'https://rpc.example', why: 'eth_call — json-rpc -32602' },
      ]);
      expect(out.unreachable).toEqual([]);
    });

    it('forgives a fault the SAME endpoint answered in one operation', () => {
      // `fallback` walks its endpoint list and can revisit an endpoint on a
      // later pass, so a same-endpoint success moments later CAN be the same
      // operation (Codex #1583 r1). Retaining it reported a product FAIL on
      // a page that got its data.
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(400, errBody(1, rpcErr(-32602)), rpcReq(call(1))),
          attempt(200, okBody(1), rpcReq(call(1)), 'https://rpc.example', 1_400),
        ),
      );
      expect(out).toEqual({ malformed: [], unreachable: [] });
    });

    it('does NOT let an earlier success clear a later failure', () => {
      // A read that worked and then died for good is a real failure;
      // cancelling it would hide exactly the mid-run degradation this
      // drive exists to notice.
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(200, okBody(1), rpcReq(call(1, 'eth_getLogs'))),
          attempt(429, 'slow down', rpcReq(call(1, 'eth_getLogs'))),
        ),
      );
      expect(out.unreachable).toHaveLength(1);
    });

    it('only clears the SAME logical call', () => {
      // A different read succeeding says nothing about this one.
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(429, 'slow down', rpcReq(call(1, 'eth_getLogs'))),
          attempt(200, okBody(2), rpcReq(call(2, 'eth_getBalance'))),
        ),
      );
      expect(out.unreachable).toHaveLength(1);
      expect(out.unreachable[0].why).toContain('eth_getLogs');
    });

    it('distinguishes the same method on different params', () => {
      const a = rpcReq(call(1, 'eth_call', ['0xAAA']));
      const b = rpcReq(call(2, 'eth_call', ['0xBBB']));
      const out = summariseRpcLedger(
        ledgerOf(attempt(429, 'slow down', a), attempt(200, okBody(2), b)),
      );
      expect(out.unreachable).toHaveLength(1);
    });

    it('collapses a read retried to death into one entry', () => {
      const req = rpcReq(call(1, 'eth_getLogs'));
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(429, 'slow down', req),
          attempt(429, 'slow down', req),
          attempt(429, 'slow down', req),
        ),
      );
      expect(out.unreachable).toHaveLength(1);
    });

    describe('bounded absorption (#1583)', () => {
      // `key` is method|params, so a continuously polled read shares one key
      // for the whole run. Absorption is bounded twice over: a success only
      // settles its own time CLUSTER, and within a cluster only as many
      // failures as one operation could have spent — viem's 4 attempts per
      // endpoint, doubled because main.tsx sets the query layer's retry: 1.
      const poll = rpcReq(call(1, 'eth_blockNumber', []));
      const dead = (at) => attempt(429, 'slow down', poll, 'https://rpc.example', at);

      it('forgives a streak within one operation budget', () => {
        const out = summariseRpcLedger(
          ledgerOf(dead(), dead(), dead(), attempt(200, okBody(1), poll)),
        );
        expect(out).toEqual({ malformed: [], unreachable: [] });
      });

      it('forgives a streak that only the query-layer retry explains', () => {
        // Four transport attempts exhausted, then the query layer retried
        // and got an answer. The page has its data, so this must not report
        // (Codex #1583 r1) — the old transport-only ceiling of 3 did.
        const out = summariseRpcLedger(
          ledgerOf(
            dead(), dead(), dead(), dead(), dead(), dead(), dead(),
            attempt(200, okBody(1), poll),
          ),
        );
        expect(out).toEqual({ malformed: [], unreachable: [] });
      });

      it('reports a streak that no single operation could have spent', () => {
        const out = summariseRpcLedger(
          ledgerOf(
            dead(), dead(), dead(), dead(), dead(), dead(), dead(), dead(),
            attempt(200, okBody(1), poll),
          ),
        );
        expect(out.unreachable).toHaveLength(1);
        expect(out.unreachable[0].why).toContain('eth_blockNumber');
      });

      it('does NOT let an independent later poll widen the budget', () => {
        // The #1583 bug in its purest form, and the case a count-only
        // ceiling could not catch (Codex #1583 r1): a chain exhausts on one
        // endpoint, then an unrelated poll a minute later answers on the
        // OTHER endpoint. Distinct URLs in the ledger do not mean one
        // fallback operation traversed them, and the gap proves they did
        // not, so the exhausted chain still stands.
        const out = summariseRpcLedger(
          ledgerOf(
            dead(), dead(), dead(), dead(), dead(), dead(), dead(), dead(),
            attempt(200, okBody(1), poll, 'https://backup.example', 61_000),
          ),
        );
        expect(out.unreachable).toHaveLength(1);
      });

      it('widens the budget when a fallback really is in play', () => {
        // fallback([http, http]) sets retryCount 0 on its children and
        // retries itself, so one operation can spend its passes across both
        // endpoints — within one cluster that is still one operation.
        const other = () => attempt(429, 'slow down', poll, 'https://backup.example');
        const out = summariseRpcLedger(
          ledgerOf(
            dead(), other(), dead(), other(), dead(), other(), dead(), other(),
            dead(), other(), dead(), other(), dead(), other(), dead(),
            attempt(200, okBody(1), poll, 'https://backup.example'),
          ),
        );
        expect(out).toEqual({ malformed: [], unreachable: [] });
      });

      it('still reports the excess beyond even the widened budget', () => {
        const other = () => attempt(429, 'slow down', poll, 'https://backup.example');
        const out = summariseRpcLedger(
          ledgerOf(
            dead(), other(), dead(), other(), dead(), other(), dead(), other(),
            dead(), other(), dead(), other(), dead(), other(), dead(), other(),
            attempt(200, okBody(1), poll, 'https://backup.example'),
          ),
        );
        expect(out.unreachable).toHaveLength(1);
      });
    });

    it('reports a batch sibling that never recovered while clearing one that did', () => {
      const batch = rpcReq(call(1, 'eth_call'), call(2, 'eth_getLogs'));
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(200, JSON.stringify([
            { jsonrpc: '2.0', id: 1, error: rpcErr(-32005) },
            { jsonrpc: '2.0', id: 2, error: rpcErr(-32005) },
          ]), batch),
          attempt(200, okBody(1), rpcReq(call(1, 'eth_call'))),
        ),
      );
      expect(out.unreachable).toHaveLength(1);
      expect(out.unreachable[0].why).toContain('eth_getLogs');
    });
  });
});
