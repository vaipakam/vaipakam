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
import { classifyRpcFailure, classifyRpcResponse, recordRpcResponse } from './rpc-verdict.mjs';

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
 * #1529 review round 22 — the same question asked of a RESOLVED response.
 *
 * The routed-fetch shim serves every page request, and a provider that
 * rate-limits or rejects a call answers over a perfectly ordinary HTTP
 * response. `fetch` resolves, so none of the error-path classification
 * above ever runs.
 */
const rpcReq = (...calls) =>
  JSON.stringify(
    calls.length === 1 ? calls[0] : calls,
  );
const call = (id, method = 'eth_call') => ({ jsonrpc: '2.0', id, method, params: [] });
const okBody = (id, result = '0x1') => JSON.stringify({ jsonrpc: '2.0', id, result });
const errBody = (id, error) => JSON.stringify({ jsonrpc: '2.0', id, error });

describe('classifyRpcResponse', () => {
  it('ignores traffic that is not JSON-RPC at all', () => {
    // This shim serves the WHOLE site. An HTML document, a JS bundle or
    // the app's own API must not be judged by the RPC verdict — including
    // when they fail, which is somebody else's check.
    expect(classifyRpcResponse(200, '<!doctype html>', undefined)).toEqual([]);
    expect(classifyRpcResponse(500, 'boom', undefined)).toEqual([]);
    expect(classifyRpcResponse(500, '{"detail":"nope"}', '{"notRpc":true}')).toEqual([]);
  });

  it('records nothing for a successful call', () => {
    expect(classifyRpcResponse(200, okBody(1), rpcReq(call(1)))).toEqual([]);
  });

  it('does not treat an ordinary revert as a failure', () => {
    // The load-bearing case. A revert is delivered as an HTTP 200 JSON-RPC
    // error and the app is expected to handle it; recording it would exit
    // non-zero on every healthy run.
    expect(
      classifyRpcResponse(200, errBody(1, { code: 3, message: 'execution reverted' }), rpcReq(call(1))),
    ).toEqual([]);
  });

  it('does not treat a revert carried as -32000 as a failure', () => {
    expect(
      classifyRpcResponse(
        200,
        errBody(1, { code: -32000, message: 'reverted', data: '0x7e273289' }),
        rpcReq(call(1)),
      ),
    ).toEqual([]);
  });

  it('calls a rate-limited read unreachable, naming the method', () => {
    // The reported shape: HTTP 200, fetch resolves, the read never happened.
    const out = classifyRpcResponse(
      200,
      errBody(1, { code: -32005, message: 'rate limited' }),
      rpcReq(call(1, 'eth_getLogs')),
    );
    expect(out).toEqual([{ verdict: 'unreachable', why: 'json-rpc eth_getLogs -32005' }]);
  });

  it('calls malformed params a client fault', () => {
    const out = classifyRpcResponse(
      200,
      errBody(1, { code: -32602, message: 'invalid params' }),
      rpcReq(call(1)),
    );
    expect(out).toEqual([{ verdict: 'client-fault', why: 'json-rpc eth_call -32602' }]);
  });

  it('keeps method-not-found infrastructure on this path too', () => {
    // Same reasoning as the error path: -32601 describes the SERVER.
    const out = classifyRpcResponse(200, errBody(1, { code: -32601 }), rpcReq(call(1)));
    expect(out).toEqual([{ verdict: 'unreachable', why: 'json-rpc eth_call -32601' }]);
  });

  it.each([429, 500, 502, 503])('treats HTTP %i on an RPC call as unreachable', (status) => {
    // The body is plain text here — the response alone could never have
    // revealed this, which is why the REQUEST is the discriminator.
    const out = classifyRpcResponse(status, 'Too Many Requests', rpcReq(call(1)));
    expect(out).toEqual([{ verdict: 'unreachable', why: `HTTP ${status} to json-rpc request` }]);
  });

  it('treats a non-JSON 200 answer to an RPC call as unreachable', () => {
    const out = classifyRpcResponse(200, '<html>gateway</html>', rpcReq(call(1)));
    expect(out).toEqual([
      { verdict: 'unreachable', why: 'non-JSON response (HTTP 200) to json-rpc request' },
    ]);
  });

  it.each([
    ['Buffer', (s) => Buffer.from(s)],
    // A bare Uint8Array is the discriminating case: `JSON.parse` coerces a
    // Buffer to its utf8 text for free, so a Buffer alone would pass even
    // with the decode removed. A Uint8Array stringifies to "123,34,..."
    // and only parses if the decode is actually there.
    ['Uint8Array', (s) => new Uint8Array(Buffer.from(s))],
  ])('decodes a %s body', (_label, wrap) => {
    const out = classifyRpcResponse(200, wrap(errBody(1, { code: -32005 })), rpcReq(call(1)));
    expect(out).toEqual([{ verdict: 'unreachable', why: 'json-rpc eth_call -32005' }]);
  });

  describe('batches', () => {
    it('judges every member, not just the first', () => {
      // Both verdicts are true at once — the app sent something invalid AND
      // the provider is flaky. Recording both lets the exit block's existing
      // ordering put the app defect ahead of the "re-run" verdict, which is
      // exactly why that ordering exists.
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: { code: -32005 } },
          { jsonrpc: '2.0', id: 2, error: { code: -32602 } },
        ]),
        rpcReq(call(1, 'eth_getLogs'), call(2, 'eth_call')),
      );
      expect(out).toContainEqual({ verdict: 'unreachable', why: 'json-rpc eth_getLogs -32005' });
      expect(out).toContainEqual({ verdict: 'client-fault', why: 'json-rpc eth_call -32602' });
    });

    it('does not let a healthy revert in a batch mask a real failure', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } },
          { jsonrpc: '2.0', id: 2, error: { code: -32005 } },
        ]),
        rpcReq(call(1), call(2, 'eth_getBalance')),
      );
      expect(out).toEqual([{ verdict: 'unreachable', why: 'json-rpc eth_getBalance -32005' }]);
    });

    it('groups distinct failures of one verdict into a single entry', () => {
      // A batch is ONE page request, and `routeFailures` counts requests.
      // Two different unreachable codes must not inflate the count to two.
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: { code: -32005 } },
          { jsonrpc: '2.0', id: 2, error: { code: -32603 } },
        ]),
        rpcReq(call(1, 'eth_getLogs'), call(2, 'eth_call')),
      );
      expect(out).toEqual([
        { verdict: 'unreachable', why: 'json-rpc eth_getLogs -32005, eth_call -32603' },
      ]);
    });

    it('does not repeat an identical failure label', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: { code: -32005 } },
          { jsonrpc: '2.0', id: 2, error: { code: -32005 } },
        ]),
        rpcReq(call(1, 'eth_call'), call(2, 'eth_call')),
      );
      expect(out).toEqual([{ verdict: 'unreachable', why: 'json-rpc eth_call -32005' }]);
    });

    it('records nothing when every member succeeded', () => {
      const out = classifyRpcResponse(
        200,
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: '0x1' },
          { jsonrpc: '2.0', id: 2, result: '0x2' },
        ]),
        rpcReq(call(1), call(2)),
      );
      expect(out).toEqual([]);
    });
  });
});

/**
 * The WIRING, tested separately from the predicate.
 *
 * Round 19 verified a classifier with a throwaway script and three
 * bypasses shipped anyway. A correct verdict filed into the wrong bucket
 * is the same defect wearing a different hat: `malformed` exits 1 as an
 * app finding, `unreachable` exits 2 as "re-run".
 */
describe('recordRpcResponse', () => {
  const buckets = () => ({ malformed: [], unreachable: [] });

  it('files a client fault as an app finding, not as flaky egress', () => {
    const b = buckets();
    recordRpcResponse(
      { status: 200, body: errBody(1, { code: -32602 }), requestBody: rpcReq(call(1)), url: 'https://rpc.example' },
      b,
    );
    expect(b.malformed).toEqual([{ url: 'https://rpc.example', why: 'json-rpc eth_call -32602' }]);
    expect(b.unreachable).toEqual([]);
  });

  it('files an unreachable provider as BLOCKED, not as an app finding', () => {
    const b = buckets();
    recordRpcResponse(
      { status: 429, body: 'slow down', requestBody: rpcReq(call(1)), url: 'https://rpc.example' },
      b,
    );
    expect(b.unreachable).toEqual([
      { url: 'https://rpc.example', why: 'HTTP 429 to json-rpc request' },
    ]);
    expect(b.malformed).toEqual([]);
  });

  it('splits a mixed batch across both buckets', () => {
    const b = buckets();
    recordRpcResponse(
      {
        status: 200,
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: { code: -32005 } },
          { jsonrpc: '2.0', id: 2, error: { code: -32602 } },
        ]),
        requestBody: rpcReq(call(1, 'eth_getLogs'), call(2, 'eth_call')),
        url: 'https://rpc.example',
      },
      b,
    );
    expect(b.unreachable).toHaveLength(1);
    expect(b.malformed).toHaveLength(1);
  });

  it('records nothing for a healthy response, a revert, or a page asset', () => {
    const b = buckets();
    recordRpcResponse({ status: 200, body: okBody(1), requestBody: rpcReq(call(1)), url: 'u' }, b);
    recordRpcResponse(
      { status: 200, body: errBody(1, { code: 3 }), requestBody: rpcReq(call(1)), url: 'u' },
      b,
    );
    recordRpcResponse({ status: 200, body: '<!doctype html>', requestBody: undefined, url: 'u' }, b);
    expect(b).toEqual({ malformed: [], unreachable: [] });
  });
});
