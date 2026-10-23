// FAIL outranks BLOCKED (#1633 r2). A malformed chain request the page
// already sent is a finding, so the shared BLOCKED exits turn into FAIL
// once any `watchPageRpc` has recorded one. Decided in driver.mjs, once,
// because a guard per drive branch was missed on the first branch reviewed.
// Its own file: the record is module state, so this needs a fresh module.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blocked, blockedSync, watchPageRpc } from './driver.mjs';
import { FakePage } from './fakePage.mjs';

class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}
const exitCode = async (fn) => {
  const spy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Exit(code);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await fn();
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  } finally {
    spy.mockRestore();
  }
  return undefined;
};

afterEach(() => vi.restoreAllMocks());

describe('BLOCKED exits and recorded page RPC faults', () => {
  it('exit BLOCKED while no malformed request has been seen', async () => {
    expect(await exitCode(() => blockedSync('fixture missing'))).toBe(2);
    expect(await exitCode(() => blocked('rpc silent'))).toBe(2);
  });

  it('exit FAIL once a watcher has recorded one, naming it', async () => {
    const page = new FakePage();
    watchPageRpc(page);
    const req = {
      method: () => 'POST',
      postData: () => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }),
    };
    page.emit('request', req);
    page.emit('response', {
      request: () => req,
      status: () => 400,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } }),
    });
    await new Promise((r) => setTimeout(r, 0));
    const errors = [];
    const run = async (fn) => {
      const code = await exitCode(fn);
      errors.push(...console.error.mock.calls.map((c) => String(c[0])));
      return code;
    };
    expect(await run(() => blockedSync('fixture missing'))).toBe(1);
    expect(await run(() => blocked('rpc silent'))).toBe(1);
    expect(errors.join('\n')).toContain('eth_call: json-rpc -32602');
    expect(errors.join('\n')).toContain('the drive then stopped BLOCKED: fixture missing');
  });

  it('a watcher whose page closed is not waited on (#1633 r5)', async () => {
    const page = new FakePage();
    watchPageRpc(page);
    // a request that will never answer, then the page closes
    page.emit('request', {
      method: () => 'POST',
      postData: () => JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'eth_blockNumber', params: [] }),
    });
    page.emit('close');
    const started = Date.now();
    await exitCode(() => blocked('rpc silent'));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
