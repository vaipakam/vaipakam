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
  blockNumberFromRpcPair,
  CHAIN_ID_CONFLICT,
  blockNumberFromWsFrame,
  chainIdFromRpcPair,
  callsTargetContract,
  classifyRpcFailure,
  classifyRpcResponse,
  isTransportFailure,
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

  // ROUND 74 P2 — a notification asks for nothing, so nothing is missing.
  describe('notifications and response completeness', () => {
    const notify = (method) => ({ jsonrpc: '2.0', method, params: [] });

    it('records nothing for an all-notification batch answered with no body', () => {
      expect(
        classifyRpcResponse(204, '', JSON.stringify([notify('eth_call')])),
      ).toEqual([]);
    });

    it('records nothing for a single notification answered with no body', () => {
      expect(classifyRpcResponse(200, '', JSON.stringify(notify('eth_call')))).toEqual([]);
    });

    it('does not report a notification omitted from a mixed batch', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x1' }]),
        JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, notify('eth_chainId')]),
      );
      expect(verdicts(out)).toEqual(['ok']);
    });

    it('still reports every call when the STATUS failed', () => {
      // A status the page cannot see past means the request never landed,
      // and a notification that never landed was not delivered either.
      const out = classifyRpcResponse(503, 'nope', JSON.stringify([notify('eth_call')]));
      expect(verdicts(out)).toEqual(['unreachable']);
    });
  });

  // ROUND 74 P2 — ids must be one of the three types the spec allows.
  describe('request ids outside the JSON-RPC types', () => {
    for (const [label, id] of [
      ['a boolean', true],
      ['an array', [1]],
      ['an object', { a: 1 }],
    ]) {
      it(`refuses ${label} id as a well-formed request`, () => {
        expect(
          rpcRequestCalls([{ jsonrpc: '2.0', id, method: 'eth_call', params: [] }]),
        ).toBeUndefined();
      });
    }

    it('accepts the three the spec allows, and an absent one', () => {
      for (const c of [
        { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] },
        { jsonrpc: '2.0', id: 'a', method: 'eth_call', params: [] },
        { jsonrpc: '2.0', id: null, method: 'eth_call', params: [] },
        { jsonrpc: '2.0', method: 'eth_call', params: [] },
      ]) {
        expect(rpcRequestCalls([c])).toHaveLength(1);
      }
    });
  });

  // ROUND 73 P2 — ids are how a batch's answers are attributed.
  describe('a batch that reuses a request id', () => {
    it('is a client fault, whatever came back', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x1' }]),
        rpcReq(call(1, 'eth_call'), call(1, 'eth_blockNumber')),
      );
      expect(verdicts(out)).toEqual(['client-fault', 'client-fault']);
      expect(out[0].why).toMatch(/duplicate id/);
    });

    it('is judged before the response, so a healthy body does not excuse it', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 7, result: '0x1' },
          { jsonrpc: '2.0', id: 7, result: '0x2' },
        ]),
        rpcReq(call(7, 'eth_call'), call(7, 'eth_call')),
      );
      expect(verdicts(out)).toEqual(['client-fault', 'client-fault']);
    });

    it('says nothing about a batch with distinct ids', () => {
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

    it('matches a REQUESTED null id normally (round 75)', () => {
      // Round 74 made `"id": null` a present id; this branch still read
      // every null reply as the absent id of a whole-request error, so a
      // mixed batch with one legitimate null-id call reported every
      // sibling unreachable even though all replies arrived.
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: null, result: '0x1' },
          { jsonrpc: '2.0', id: 2, result: '0x2' },
        ]),
        JSON.stringify([
          { jsonrpc: '2.0', id: null, method: 'eth_call', params: [] },
          { jsonrpc: '2.0', id: 2, method: 'eth_chainId', params: [] },
        ]),
      );
      expect(verdicts(out)).toEqual(['ok', 'ok']);
    });

    it('still treats an UNREQUESTED null error as whole-request (round 75)', () => {
      // A parse error carries no id because the server never read them.
      const out = classifyRpcResponse(
        200,
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse' } }),
        rpcReq(call(1, 'eth_call'), call(2, 'eth_chainId')),
      );
      expect(verdicts(out)).toEqual(['client-fault', 'client-fault']);
    });

    it('treats an explicit null id as PRESENT (round 74)', () => {
      // A notification OMITS the member. An explicit null is an id the
      // spec discourages but allows, and the response must echo it — so
      // two of them collide like any other pair.
      const nulled = (method) => ({ jsonrpc: '2.0', id: null, method, params: [] });
      const out = classifyRpcResponse(
        200,
        JSON.stringify([{ jsonrpc: '2.0', id: null, result: '0x1' }]),
        JSON.stringify([nulled('eth_call'), nulled('eth_blockNumber')]),
      );
      expect(verdicts(out)).toEqual(['client-fault', 'client-fault']);
      expect(out[0].why).toMatch(/duplicate id/);
    });

    it('does not treat two ID-LESS notifications as a collision', () => {
      // A notification legitimately carries no id and expects no reply.
      // Reading absent ids as equal would invent a product FAIL out of a
      // shape JSON-RPC allows.
      const notify = (method) => ({ jsonrpc: '2.0', method, params: [] });
      const out = classifyRpcResponse(
        200,
        JSON.stringify([{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'x' } }]),
        JSON.stringify([notify('eth_call'), notify('eth_blockNumber')]),
      );
      expect(out.every((o) => o.verdict !== 'client-fault' || !/duplicate id/.test(o.why))).toBe(
        true,
      );
    });
  });

  // ROUND 72 P2 — a revert answers a CALL, not a head or a receipt.
  describe('the revert exemption is scoped to methods that execute code', () => {
    for (const method of [
      'eth_blockNumber',
      'eth_getBlockByNumber',
      'eth_getTransactionReceipt',
      'eth_getLogs',
      'eth_chainId',
    ]) {
      it(`records a revert-shaped error from ${method} as unreachable`, () => {
        const out = classifyRpcResponse(
          200,
          errBody(1, { code: 3, message: 'reverted' }),
          rpcReq(call(1, method)),
        );
        expect(verdicts(out)).toEqual(['unreachable']);
        expect(out[0].why).toMatch(/executes no code/);
      });
    }

    it('still exempts every method that does execute code', () => {
      for (const method of [
        'eth_call',
        'eth_estimateGas',
        'eth_createAccessList',
        'eth_sendRawTransaction',
        'eth_sendTransaction',
        'debug_traceCall',
      ]) {
        const out = classifyRpcResponse(
          200,
          errBody(1, { code: 3, message: 'reverted' }),
          rpcReq(call(1, method)),
        );
        expect(verdicts(out)).toEqual(['ok']);
      }
    });

    it('decides PER CALL when one whole-request error covers a mixed batch', () => {
      // An error carrying no id attributes to every call, and the calls
      // in a batch need not share a method — so the exemption cannot be
      // resolved once for the response.
      const out = classifyRpcResponse(
        200,
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 3, message: 'reverted' } }),
        rpcReq(call(1, 'eth_call'), call(2, 'eth_blockNumber')),
      );
      expect(verdicts(out)).toEqual(['ok', 'unreachable']);
    });

    it('decides PER MEMBER in an ordinary batch too', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'reverted' } },
          { jsonrpc: '2.0', id: 2, error: { code: 3, message: 'reverted' } },
        ]),
        rpcReq(call(1, 'eth_getLogs'), call(2, 'eth_estimateGas')),
      );
      expect(verdicts(out)).toEqual(['unreachable', 'ok']);
    });

    it('is decided by the method, not by how the revert was labelled', () => {
      // The bytes path reaches `answered` without code 3 at all, and it
      // must be scoped identically or the exemption simply moves.
      const out = classifyRpcResponse(
        200,
        errBody(1, { code: -32000, message: 'reverted', data: '0x7e273289' }),
        rpcReq(call(1, 'eth_getBlockByNumber')),
      );
      expect(verdicts(out)).toEqual(['unreachable']);
    });
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
  const attempt = (status, body, requestBody, url = 'https://rpc.example') => ({
    status,
    body,
    requestBody,
    url,
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

  // ROUND 94 P2 — a LATER POLL is not a retry, and `callKey` cannot tell
  // them apart: it is method plus params, and a page polls the same method
  // and params forever. One poll exhausting every retry — with the card
  // possibly rendering a degraded funds surface from it — was cleared by
  // the next poll's success, and the run passed.
  //
  // Nothing identifies a logical request from outside the page: viem takes
  // a fresh id per attempt, so two retries and two polls differ in no
  // observable way. Time is the discriminator that remains, and these
  // cases pin both of its edges.
  describe('recovery is scoped to the retry window (round 94)', () => {
    const failed = (at) => ({
      key: 'eth_call|[]',
      method: 'eth_call',
      verdict: 'unreachable',
      why: 'HTTP 429',
      url: 'https://rpc.example',
      at,
    });
    const ok = (at) => ({ key: 'eth_call|[]', method: 'eth_call', verdict: 'ok', at });

    it('still clears a failure a retry recovered', () => {
      const out = summariseRpcLedger([failed(1_000), ok(1_650)]);
      expect(out.unreachable).toEqual([]);
    });

    it('does NOT clear it from a poll seconds later', () => {
      const out = summariseRpcLedger([failed(1_000), ok(4_000)]);
      expect(out.unreachable).toEqual([
        { url: 'https://rpc.example', why: 'eth_call — HTTP 429' },
      ]);
    });

    it('leaves a record without timestamps behaving as it did', () => {
      // `undefined` means a shape predating the field, which every rule in
      // this project treats as "keep the old behaviour" rather than as
      // evidence of anything.
      const out = summariseRpcLedger([
        { key: 'eth_call|[]', method: 'eth_call', verdict: 'unreachable', why: 'HTTP 429', url: 'u' },
        { key: 'eth_call|[]', method: 'eth_call', verdict: 'ok' },
      ]);
      expect(out.unreachable).toEqual([]);
    });
  });

  // ROUND 95 P2 — a SIBLING IN THE SAME BATCH is not a retry either, and
  // time cannot say so: both outcomes are decoded from one response body
  // and stamped with one `at`, so the later array slot satisfied every
  // window the round-94 rule could express. The first caller had already
  // consumed its error.
  describe('recovery excludes siblings of the same response (round 95)', () => {
    const batchOfSameCall = (first, second) =>
      ledgerOf(
        attempt(200, `[${first},${second}]`, rpcReq(call(1), call(2))),
      );

    it('does NOT let a batch sibling clear its neighbour', () => {
      const out = summariseRpcLedger(
        batchOfSameCall(errBody(1, rpcErr(-32005, 'limit')), okBody(2)),
      );
      expect(out.unreachable).toEqual([
        { url: 'https://rpc.example', why: 'eth_call — json-rpc -32005' },
      ]);
    });

    it('still clears it when the success is a SEPARATE response in time', () => {
      // The same two outcomes, one per response — which is what a retry
      // actually looks like — recover exactly as they did before.
      const ledger = ledgerOf(
        attempt(200, errBody(1, rpcErr(-32005, 'limit')), rpcReq(call(1))),
        attempt(200, okBody(1), rpcReq(call(1))),
      );
      expect(summariseRpcLedger(ledger)).toEqual({ malformed: [], unreachable: [] });
    });

    it('leaves a record without response ids behaving as it did', () => {
      // `undefined` means a shape predating the field — keep the old
      // behaviour, never read it as evidence.
      const out = summariseRpcLedger([
        { key: 'eth_call|[]', method: 'eth_call', verdict: 'unreachable', why: 'HTTP 429', url: 'u', at: 10 },
        { key: 'eth_call|[]', method: 'eth_call', verdict: 'ok', at: 10 },
      ]);
      expect(out.unreachable).toEqual([]);
    });
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

    it('clears a client fault the same way', () => {
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(400, errBody(1, rpcErr(-32602)), rpcReq(call(1))),
          attempt(200, okBody(1), rpcReq(call(1))),
        ),
      );
      expect(out).toEqual({ malformed: [], unreachable: [] });
    });

    // ROUND 74 P2 — but an ENVELOPE fault is not recoverable, because
    // `callKey` is method plus params and carries no id at all, so the
    // very next refresh of the same read shared its key and erased it.
    it('keeps a duplicate-id fault despite a later success on the same key', () => {
      const out = summariseRpcLedger(
        ledgerOf(
          attempt(
            200,
            JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x1' }]),
            rpcReq(call(1, 'eth_call'), call(1, 'eth_call')),
          ),
          attempt(200, okBody(1), rpcReq(call(1, 'eth_call'))),
        ),
      );
      expect(out.malformed).toHaveLength(1);
      expect(out.malformed[0].why).toMatch(/duplicate id/);
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

describe('blockNumberFromRpcPair — the page disclosing its own head', () => {
  // SHAPED THE WAY VIEM SENDS THEM — `jsonrpc: '2.0'` included. The
  // first version of these fixtures omitted it and every case returned
  // null, because `rpcRequestCalls` validates the envelope before the
  // allowlist. That was the fixtures being unrealistic rather than the
  // parser being wrong, and it is exactly what extracting this made
  // visible: inline in the response listener, nothing would have told
  // me whether the real shape parsed at all.
  const req = (calls) => {
    const envelope = calls.map((c) => ({ jsonrpc: '2.0', ...c }));
    return JSON.stringify(envelope.length === 1 ? envelope[0] : envelope);
  };

  it('reads a single eth_blockNumber exchange', () => {
    expect(
      blockNumberFromRpcPair(req([{ id: 1, method: 'eth_blockNumber' }]), {
        id: 1,
        result: '0x2c7a5f2',
      }),
    ).toBe(0x2c7a5f2n);
  });

  // MATCHED BY ID, NOT POSITION. A batch may be answered in any order,
  // and lining the arrays up would attribute one call's result to a
  // different method — here, a log count read as a block height.
  it('does not attribute another method’s result to eth_blockNumber', () => {
    const body = req([
      { id: 7, method: 'eth_getLogs', params: [] },
      { id: 8, method: 'eth_blockNumber' },
    ]);
    expect(
      blockNumberFromRpcPair(body, [
        { id: 8, result: '0x64' },
        { id: 7, result: '0xdeadbeef' },
      ]),
    ).toBe(0x64n);
  });

  it('takes the highest when a batch asks more than once', () => {
    const body = req([
      { id: 1, method: 'eth_blockNumber' },
      { id: 2, method: 'eth_blockNumber' },
    ]);
    expect(
      blockNumberFromRpcPair(body, [
        { id: 1, result: '0x10' },
        { id: 2, result: '0x12' },
      ]),
    ).toBe(0x12n);
  });

  it('accepts a lone reply whose id does not match', () => {
    // One call asked, one answer came back: there is nothing else the
    // reply could be about, so a rewritten or absent id is not a reason
    // to discard it.
    expect(
      blockNumberFromRpcPair(req([{ id: 1, method: 'eth_blockNumber' }]), {
        result: '0x2a',
      }),
    ).toBe(0x2an);
  });

  it('does NOT apply that leniency inside a batch', () => {
    const body = req([
      { id: 1, method: 'eth_getLogs', params: [] },
      { id: 2, method: 'eth_blockNumber' },
    ]);
    expect(blockNumberFromRpcPair(body, [{ id: 99, result: '0x2a' }])).toBeNull();
  });

  it('ignores an error member where a result was expected', () => {
    expect(
      blockNumberFromRpcPair(req([{ id: 1, method: 'eth_blockNumber' }]), {
        id: 1,
        error: { code: -32005, message: 'rate limited' },
      }),
    ).toBeNull();
  });

  it('returns null for bodies that disclose nothing', () => {
    expect(blockNumberFromRpcPair(req([{ id: 1, method: 'eth_call' }]), { id: 1, result: '0x1' }))
      .toBeNull();
    expect(blockNumberFromRpcPair(undefined, { result: '0x1' })).toBeNull();
    expect(blockNumberFromRpcPair('not json', { result: '0x1' })).toBeNull();
    expect(blockNumberFromRpcPair(req([{ id: 1, method: 'eth_blockNumber' }]), null)).toBeNull();
  });

  it('does not throw on a non-hex result', () => {
    expect(
      blockNumberFromRpcPair(req([{ id: 1, method: 'eth_blockNumber' }]), {
        id: 1,
        result: 'later',
      }),
    ).toBeNull();
  });
});

describe('blockNumberFromRpcPair — envelope strictness', () => {
  it('discloses nothing for a body missing the JSON-RPC envelope', () => {
    // `rpcRequestCalls` validates `jsonrpc: "2.0"` before anything else,
    // and this function inherits that. viem always sets it, so the
    // production path is unaffected — and the failure direction is the
    // safe one: no head observed means the absence gate reports
    // incomplete rather than accusing the app. Pinned because it is a
    // real constraint on what this can read, not an accident.
    expect(
      blockNumberFromRpcPair(JSON.stringify({ id: 1, method: 'eth_blockNumber' }), {
        id: 1,
        result: '0x2a',
      }),
    ).toBeNull();
  });
});

describe('round 50 P2 — a QUANTITY is hex, everywhere it is read', () => {
  // `BigInt` accepts `"100000"` and `"-1"`. The `catch` in
  // `blockNumberFromRpcPair` carried the comment "not a hex quantity"
  // since it was written and checked nothing, and two more readers in
  // this file leaned on the same conversion.
  //
  // TOO LOW is the dangerous direction, by an indirect route: the
  // absence gate makes the confirming observer clear the head the PAGE
  // reached, so an artificially low bound lets it settle below what the
  // DOM was showing and report a correctly absent card as a regression.
  // Request as the JSON viem sends; RESPONSE as the parsed object the
  // caller hands over — the shape the surrounding suites already use.
  const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' });
  const reply = (result) => ({ id: 1, result });

  it('reads a proper hex height', () => {
    expect(blockNumberFromRpcPair(req, reply('0x2c8a1f'))).toBe(0x2c8a1fn);
  });

  it('refuses a DECIMAL height rather than reading it 19x too low', () => {
    expect(blockNumberFromRpcPair(req, reply('100000'))).toBeNull();
  });

  it('refuses a signed value', () => {
    expect(blockNumberFromRpcPair(req, reply('-1'))).toBeNull();
    expect(blockNumberFromRpcPair(req, reply('-0x1'))).toBeNull();
  });

  it('refuses a bare 0x and other near-misses', () => {
    expect(blockNumberFromRpcPair(req, reply('0x'))).toBeNull();
    expect(blockNumberFromRpcPair(req, reply('0X1f'))).toBeNull();
    expect(blockNumberFromRpcPair(req, reply(' 0x1f '))).toBeNull();
    expect(blockNumberFromRpcPair(req, reply('0x1fz'))).toBeNull();
  });

  // THE PARALLEL SITES, which is why the rule was extracted rather than
  // written out at the one place the finding named.
  it('applies the same rule to a newHeads push', () => {
    const push = (number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: { subscription: '0x1', result: { number } },
      });
    expect(blockNumberFromWsFrame(push('0x2c8a1f'))).toBe(0x2c8a1fn);
    expect(blockNumberFromWsFrame(push('100000'))).toBeNull();
    expect(blockNumberFromWsFrame(push('-1'))).toBeNull();
  });

  it('applies it to a chain id, which is a quantity too', () => {
    const idReq = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_chainId' });
    const idReply = (result) => ({ id: 7, result });
    expect(chainIdFromRpcPair(idReq, idReply('0x14a34'))).toBe(84532);
    expect(chainIdFromRpcPair(idReq, idReply('84532'))).toBeNull();
  });
});

describe('round 60 P2 — a reused JSON-RPC id names no call', () => {
  // `wanted` was a Set, so a batch reusing one id for `eth_blockNumber`
  // and something else collapsed the two into a single identity: every
  // member carrying that id became eligible as a head result. A lone
  // `eth_chainId` answer of `0x14a34` was recorded as page block 84532
  // — an artificially LOW absence bound, the direction that lets a
  // correctly absent card be reported as a regression.
  const batch = (...calls) => JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', ...c })));

  it('reads a well-formed batch with distinct ids', () => {
    expect(
      blockNumberFromRpcPair(
        batch({ id: 1, method: 'eth_chainId' }, { id: 2, method: 'eth_blockNumber' }),
        [
          { id: 1, result: '0x14a34' },
          { id: 2, result: '0x2c8a1f' },
        ],
      ),
    ).toBe(0x2c8a1fn);
  });

  it('refuses a height from a REUSED id', () => {
    expect(
      blockNumberFromRpcPair(
        batch({ id: 1, method: 'eth_chainId' }, { id: 1, method: 'eth_blockNumber' }),
        [{ id: 1, result: '0x14a34' }],
      ),
    ).toBeNull();
  });

  // Refused rather than repaired: an id naming two calls names neither,
  // and picking one would be a guess. "No height" is already handled as
  // not-ready.
  it('refuses even when the reused id carries a plausible height', () => {
    expect(
      blockNumberFromRpcPair(
        batch({ id: 7, method: 'eth_getLogs', params: [] }, { id: 7, method: 'eth_blockNumber' }),
        [{ id: 7, result: '0x2c8a1f' }],
      ),
    ).toBeNull();
  });
});

describe('round 52 P2 — an endpoint that answers with two chains', () => {
  // Returning on the FIRST match ignored a batch answering `eth_chainId`
  // twice with different chains, so the endpoint could be admitted as
  // deployment-serving on half of its own answer and its later heights
  // trusted — exactly the endpoint round 51's permanent exclusion is
  // for, reaching the same wrong-chain bound by an earlier door.
  const batch = (...calls) =>
    JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', ...c })));

  it('reads a single consistent answer', () => {
    expect(
      chainIdFromRpcPair(batch({ id: 1, method: 'eth_chainId' }), [{ id: 1, result: '0x14a34' }]),
    ).toBe(84532);
  });

  it('reads agreeing answers as that one chain', () => {
    expect(
      chainIdFromRpcPair(
        batch({ id: 1, method: 'eth_chainId' }, { id: 2, method: 'eth_chainId' }),
        [
          { id: 1, result: '0x14a34' },
          { id: 2, result: '0x14a34' },
        ],
      ),
    ).toBe(84532);
  });

  it('reports a CONFLICT when they disagree', () => {
    expect(
      chainIdFromRpcPair(
        batch({ id: 1, method: 'eth_chainId' }, { id: 2, method: 'eth_chainId' }),
        [
          { id: 1, result: '0x14a34' },
          { id: 2, result: '0x1' },
        ],
      ),
    ).toBe(CHAIN_ID_CONFLICT);
  });

  it('reports it whichever order the replies arrive in', () => {
    // The defect was order-dependent: the expected chain first made the
    // endpoint look fine. Both orders must reach the same answer.
    expect(
      chainIdFromRpcPair(
        batch({ id: 1, method: 'eth_chainId' }, { id: 2, method: 'eth_chainId' }),
        [
          { id: 2, result: '0x1' },
          { id: 1, result: '0x14a34' },
        ],
      ),
    ).toBe(CHAIN_ID_CONFLICT);
  });

  // A CONFLICT is not `null`, and the distinction is the whole fix:
  // `null` means "no chain evidence here", which lets the caller fall
  // through to its address heuristic and ADMIT the endpoint.
  it('is distinguishable from having no evidence at all', () => {
    expect(
      chainIdFromRpcPair(batch({ id: 1, method: 'eth_blockNumber' }), [{ id: 1, result: '0x1' }]),
    ).toBeNull();
    expect(CHAIN_ID_CONFLICT).not.toBeNull();
  });
});

describe('blockNumberFromWsFrame — a newHeads push', () => {
  it('reads the height from an eth_subscription header', () => {
    expect(
      blockNumberFromWsFrame(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_subscription',
          params: { subscription: '0xabc', result: { number: '0x2c7a5f2', hash: '0xdead' } },
        }),
      ),
    ).toBe(0x2c7a5f2n);
  });

  it('ignores a bare id/result reply on the socket', () => {
    // Without the paired request there is nothing to say this result is
    // a height rather than any other read, and guessing is how a log
    // count gets recorded as a block number.
    expect(blockNumberFromWsFrame(JSON.stringify({ id: 1, result: '0x2c7a5f2' }))).toBeNull();
  });

  it('ignores a subscription that carries no header number', () => {
    expect(
      blockNumberFromWsFrame(
        JSON.stringify({ method: 'eth_subscription', params: { result: ['0xlog'] } }),
      ),
    ).toBeNull();
  });

  it('returns null rather than throwing on junk', () => {
    expect(blockNumberFromWsFrame('not json')).toBeNull();
    expect(blockNumberFromWsFrame(undefined)).toBeNull();
    expect(blockNumberFromWsFrame(Buffer.from([1, 2, 3]))).toBeNull();
    expect(
      blockNumberFromWsFrame(
        JSON.stringify({ method: 'eth_subscription', params: { result: { number: 'soon' } } }),
      ),
    ).toBeNull();
  });
});

describe('chainIdFromRpcPair — which chain an endpoint speaks for', () => {
  const req = (calls) => {
    const envelope = calls.map((c) => ({ jsonrpc: '2.0', ...c }));
    return JSON.stringify(envelope.length === 1 ? envelope[0] : envelope);
  };

  it('reads the id from a single exchange', () => {
    expect(
      chainIdFromRpcPair(req([{ id: 1, method: 'eth_chainId' }]), { id: 1, result: '0x14a34' }),
    ).toBe(84532);
  });

  it('matches by id inside a batch rather than by position', () => {
    const body = req([
      { id: 4, method: 'eth_blockNumber' },
      { id: 5, method: 'eth_chainId' },
    ]);
    expect(
      chainIdFromRpcPair(body, [
        { id: 5, result: '0x1' },
        { id: 4, result: '0x2c7a5f2' },
      ]),
    ).toBe(1);
  });

  it('discloses nothing when the endpoint was not asked', () => {
    expect(chainIdFromRpcPair(req([{ id: 1, method: 'eth_call', params: [{}] }]), { id: 1, result: '0x1' }))
      .toBeNull();
  });

  it('returns null rather than throwing on junk', () => {
    expect(chainIdFromRpcPair('not json', { result: '0x1' })).toBeNull();
    expect(chainIdFromRpcPair(req([{ id: 1, method: 'eth_chainId' }]), { id: 1, error: { code: -1 } }))
      .toBeNull();
    expect(chainIdFromRpcPair(req([{ id: 1, method: 'eth_chainId' }]), { id: 1, result: 'soon' }))
      .toBeNull();
  });
});

describe('blockNumberFromRpcPair — a head announced as a BLOCK (round 33 P2)', () => {
  const req = (calls) => {
    const envelope = calls.map((c) => ({ jsonrpc: '2.0', ...c }));
    return JSON.stringify(envelope.length === 1 ? envelope[0] : envelope);
  };

  // The app asks for its head this way far more often than it asks for a
  // number: `getBlock({ blockTag: 'latest' })` is what `loanLive.ts` and
  // every pending-state read use, and viem sends it as
  // `eth_getBlockByNumber`. Reading only `eth_blockNumber` left
  // `pageHeadOf` at zero on those pages, which does not weaken the
  // forced-close absence gate so much as switch it off.
  it('reads the head out of eth_getBlockByNumber(latest)', () => {
    expect(
      blockNumberFromRpcPair(
        req([{ id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }]),
        { id: 1, result: { number: '0x2c7a5f2', hash: '0xabc' } },
      ),
    ).toBe(0x2c7a5f2n);
  });

  it('ignores a HISTORICAL block, whose number is not the head', () => {
    expect(
      blockNumberFromRpcPair(
        req([{ id: 1, method: 'eth_getBlockByNumber', params: ['0x1234', false] }]),
        { id: 1, result: { number: '0x1234' } },
      ),
    ).toBeNull();
  });

  // `pending` is the one that would be WRONG in the dangerous direction:
  // it reports a height above the chain's, for a block nobody has mined,
  // and this value is the lower bound an absence is confirmed against.
  it('ignores a PENDING block, which would overstate the head', () => {
    expect(
      blockNumberFromRpcPair(
        req([{ id: 1, method: 'eth_getBlockByNumber', params: ['pending', false] }]),
        { id: 1, result: { number: '0x2c7a5f3' } },
      ),
    ).toBeNull();
  });

  it('still matches by id inside a batch, and takes the highest', () => {
    const body = req([
      { id: 4, method: 'eth_getLogs', params: [] },
      { id: 5, method: 'eth_getBlockByNumber', params: ['latest', false] },
      { id: 6, method: 'eth_blockNumber' },
    ]);
    expect(
      blockNumberFromRpcPair(body, [
        { id: 4, result: ['0xdeadbeef'] },
        { id: 6, result: '0x10' },
        { id: 5, result: { number: '0x11' } },
      ]),
    ).toBe(0x11n);
  });

  it('reads nothing from a null block or a headerless result', () => {
    const body = req([{ id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }]);
    expect(blockNumberFromRpcPair(body, { id: 1, result: null })).toBeNull();
    expect(blockNumberFromRpcPair(body, { id: 1, result: {} })).toBeNull();
    expect(blockNumberFromRpcPair(body, { id: 1, result: { number: 12345 } })).toBeNull();
    expect(blockNumberFromRpcPair(body, { id: 1, error: { code: -32000 } })).toBeNull();
  });
});

describe('isTransportFailure — an outage, or this drive asking wrongly (round 33 P2)', () => {
  // SHAPED THE WAY VIEM DELIVERS THEM. `buildRequest` maps the JSON-RPC
  // code to a specific class and passes the generic `RpcRequestError` as
  // its `cause`, so the generic name is present in the chain of EVERY
  // error reply — which is what made walking for it accept a malformed
  // request as an outage.
  const err = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });
  const wrap = (outer, cause) => Object.assign(outer, { cause });
  // viem's BaseError exposes `walk`; `classifyRpcFailure` uses it when it
  // is there and falls back to the object itself when it is not.
  const withWalk = (top) => {
    top.walk = (fn) => {
      for (let cur = top; cur; cur = cur.cause) if (fn(cur)) return cur;
      return undefined;
    };
    return top;
  };

  it('calls a dead endpoint a transport failure', () => {
    const e = withWalk(
      wrap(err('ContractFunctionExecutionError'), err('HttpRequestError')),
    );
    expect(isTransportFailure(e)).toBe(true);
  });

  it('calls a rate limit a transport failure', () => {
    expect(isTransportFailure(withWalk(err('LimitExceededRpcError', { code: -32005 })))).toBe(true);
  });

  // THE DEFECT THIS ROUND FIXED. `-32602` is the node telling this file
  // its request was malformed — a bad `account`, a wrong argument list.
  // Classifying it as an outage left the loan ranked usable and said
  // nothing, and silence on a self-inflicted error is how two inert
  // fixes rode for a round each.
  it('does NOT launder a malformed request as an outage', () => {
    const e = withWalk(
      wrap(
        err('InvalidParamsRpcError'),
        wrap(err('RpcRequestError'), { code: -32602, message: 'invalid params' }),
      ),
    );
    expect(isTransportFailure(e)).toBe(false);
  });

  it('does not launder a parse error or an invalid request either', () => {
    for (const code of [-32700, -32600]) {
      const e = withWalk(wrap(err('RpcRequestError'), { code, message: 'bad' }));
      expect(isTransportFailure(e), `code ${code}`).toBe(false);
    }
  });

  // The boundary the existing classifier already argues, kept rather than
  // re-litigated: a method the endpoint does not implement describes the
  // SERVER's capability surface, not a defect in what was asked.
  it('keeps method-not-found on the transport side', () => {
    const e = withWalk(wrap(err('RpcRequestError'), { code: -32601, message: 'no method' }));
    expect(isTransportFailure(e)).toBe(true);
  });

  // Deliberate: `saleLockedOn` rethrows only the reverts it could not
  // read, and "the EVM answered something I cannot parse" is a failure to
  // determine rather than a defect to report.
  it('leaves an undecodable revert classified as transport', () => {
    const e = withWalk(wrap(err('ContractFunctionExecutionError'), err('RpcRequestError', { code: 3, data: '0xdeadbeef' })));
    expect(isTransportFailure(e)).toBe(true);
  });

  it('calls a plain programming error what it is', () => {
    expect(isTransportFailure(new TypeError('saleLockedOn: account is required'))).toBe(false);
    expect(isTransportFailure(new ReferenceError("Cannot access 'observed' before initialization"))).toBe(false);
    expect(isTransportFailure(withWalk(err('AbiEncodingLengthMismatchError')))).toBe(false);
  });

  // NO `withWalk` HERE, and that is the point rather than an omission.
  // The guard under test is this function's OWN `seen` set. Handing the
  // cyclic chain to the `walk` stand-in instead hangs the whole suite —
  // it did, for three runs — because neither that stand-in nor viem's
  // real `BaseError.walk` carries a cycle guard. viem never builds one,
  // so this is a statement about the loop written here, not a claim that
  // the classifier above survives a cycle.
  it('does not loop on a cyclic cause chain', () => {
    const a = err('SomethingElse');
    const b = err('AlsoNotTransport');
    a.cause = b;
    b.cause = a;
    expect(isTransportFailure(a)).toBe(false);
  });
});

describe('round 63 P2 — the chain-id reader refuses a reused id too', () => {
  // ROUND 60 closed this in `blockNumberFromRpcPair` and left the
  // sibling reader collapsing duplicates. This is the same defect by the
  // door that matters MORE: a chain id is what ADMITS an endpoint, so a
  // wrong one buys trust in every height that endpoint reports
  // afterwards, not just the one exchange.
  //
  // Round 60's own note said "same id-matching rule as
  // `blockNumberFromRpcPair`, for the same reason" — the comment stayed
  // true and the code stopped being.
  const batch = (...calls) => JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', ...c })));

  it('reads a well-formed batch with distinct ids', () => {
    expect(
      chainIdFromRpcPair(
        batch({ id: 1, method: 'eth_blockNumber' }, { id: 2, method: 'eth_chainId' }),
        [
          { id: 1, result: '0x2c8a1f' },
          { id: 2, result: '0x14a34' },
        ],
      ),
    ).toBe(84532);
  });

  it('refuses a chain id from a REUSED id', () => {
    // The exact shape from the finding: a height answer of `0x14a34`
    // reading as "this endpoint speaks for Base Sepolia".
    expect(
      chainIdFromRpcPair(
        batch({ id: 1, method: 'eth_chainId' }, { id: 1, method: 'eth_blockNumber' }),
        [{ id: 1, result: '0x14a34' }],
      ),
    ).toBeNull();
  });

  it('keeps an unambiguous chain call when a DIFFERENT pair collides', () => {
    // Refusing the whole exchange because two unrelated calls collided
    // would be the over-correction: the `eth_chainId` id here names
    // exactly one call and is still good evidence.
    expect(
      chainIdFromRpcPair(
        batch(
          { id: 7, method: 'eth_chainId' },
          { id: 9, method: 'eth_call' },
          { id: 9, method: 'eth_getLogs' },
        ),
        [
          { id: 7, result: '0x14a34' },
          { id: 9, result: '0x' },
        ],
      ),
    ).toBe(84532);
  });

  it('still allows the single-call leniency', () => {
    // One call, one answer: there is nothing else the reply could be
    // about, so a rewritten or absent id is not a reason to discard it.
    expect(
      chainIdFromRpcPair(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
        { id: 99, result: '0x14a34' },
      ),
    ).toBe(84532);
  });
});
