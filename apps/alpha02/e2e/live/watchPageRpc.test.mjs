// Regression tests for `watchPageRpc` (driver.mjs).
//
// Three drives now read their BLOCKED-vs-FAIL verdict from this helper, and
// its behaviour was wrong three times before this file existed — each time
// in a way that reads as correct:
//
//   1. Session-wide counting. The page-load reads satisfy it immediately, so
//      an endpoint that answered on load and then died exactly when the
//      assertion's reads went out still reported FAIL.
//   2. Counting only JSON-RPC `result`. A revert-driven assertion answers
//      200 with an `error`, so the one call the verdict rests on never
//      counted in either direction.
//   3. Set-based window membership. Clearing the tally on reset does nothing
//      about a stale request whose response arrives later and increments it
//      again — and a WeakSet cannot be cleared, so the approach was quietly
//      unfixable.
//
// Each case below pins one of those. Following the precedent redact.test.mjs
// set: driver logic worth trusting belongs in the suite, not in a scratch
// script.
import { describe, expect, it } from 'vitest';
import { watchPageRpc } from './driver.mjs';

/** Minimal stand-in for a Playwright Page's event surface. */
class FakePage {
  constructor() {
    this.handlers = {};
  }
  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
  }
  emit(event, arg) {
    for (const fn of this.handlers[event] ?? []) fn(arg);
  }
}

const request = (method = 'POST') => ({ method: () => method });
const response = (req, status, body) => ({
  request: () => req,
  status: () => status,
  text: async () => JSON.stringify(body),
});

describe('watchPageRpc', () => {
  it('ignores a request that started before the window, however late it answers', async () => {
    const page = new FakePage();
    const rpc = watchPageRpc(page);
    const stale = request();
    page.emit('request', stale); // in flight before the window opens
    rpc.reset();
    page.emit('response', response(stale, 200, { jsonrpc: '2.0', result: '0x1' }));
    // Counting this would make a total outage during the assertion look
    // like a live endpoint — FAIL where BLOCKED is right.
    expect(await rpc.settled()).toBe(0);
  });

  it('counts a 200 carrying a JSON-RPC error as answered', async () => {
    const page = new FakePage();
    const rpc = watchPageRpc(page);
    rpc.reset();
    const req = request();
    page.emit('request', req);
    page.emit(
      'response',
      response(req, 200, { jsonrpc: '2.0', error: { code: 3, message: 'execution reverted' } }),
    );
    // The endpoint answered. For a revert-driven assertion this IS the
    // expected result.
    expect(await rpc.settled()).toBe(1);
  });

  it('counts each envelope of a batch response', async () => {
    const page = new FakePage();
    const rpc = watchPageRpc(page);
    rpc.reset();
    const req = request();
    page.emit('request', req);
    page.emit(
      'response',
      response(req, 200, [
        { jsonrpc: '2.0', result: '0x1' },
        { jsonrpc: '2.0', result: '0x2' },
      ]),
    );
    expect(await rpc.settled()).toBe(2);
  });

  it('ignores non-200 responses and non-POST requests', async () => {
    const page = new FakePage();
    const rpc = watchPageRpc(page);
    rpc.reset();
    const failed = request();
    page.emit('request', failed);
    page.emit('response', response(failed, 503, { jsonrpc: '2.0', result: '0x1' }));
    const get = request('GET');
    page.emit('request', get);
    page.emit('response', response(get, 200, { jsonrpc: '2.0', result: '0x1' }));
    expect(await rpc.settled()).toBe(0);
  });

  it('does not carry answers from a previous window into a fresh one', async () => {
    const page = new FakePage();
    const rpc = watchPageRpc(page);
    rpc.reset();
    const first = request();
    page.emit('request', first);
    page.emit('response', response(first, 200, { jsonrpc: '2.0', result: '0x1' }));
    expect(await rpc.settled()).toBe(1);

    rpc.reset(); // second window — the endpoint is dead from here on
    expect(await rpc.settled()).toBe(0);
  });

  it('ignores a body that is not JSON-RPC rather than throwing', async () => {
    const page = new FakePage();
    const rpc = watchPageRpc(page);
    rpc.reset();
    const req = request();
    page.emit('request', req);
    page.emit('response', { request: () => req, status: () => 200, text: async () => 'not json' });
    expect(await rpc.settled()).toBe(0);
  });
});
