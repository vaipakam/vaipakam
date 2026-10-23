// The shared final exit of a drive that attaches `watchPageRpc` (#1633 r6).
// A drive's own fault snapshot can be taken before the close's last drain,
// so a malformed-request refusal still parsing then landed AFTER the drive
// decided PASS. `exitWithVerdict` drains once more and applies the
// FAIL-over-everything rule itself. Its own file: the fault record is
// module state, so it needs a fresh module.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitWithVerdict, watchPageRpc } from './driver.mjs';
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

describe('exitWithVerdict', () => {
  it('passes the drive\'s own code through while no fault is recorded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await exitCode(() => exitWithVerdict(0))).toBe(0);
    expect(await exitCode(() => exitWithVerdict(2))).toBe(2);
    expect(await exitCode(() => exitWithVerdict(1))).toBe(1);
  });

  it('counts a refusal that lands only during its own drain, and FAILs a PASS or BLOCKED code', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = new FakePage();
    const rpc = watchPageRpc(page);
    const req = {
      method: () => 'POST',
      postData: () => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }),
    };
    page.emit('request', req);
    // The body arrives 300 ms after the response: the drive's snapshot,
    // taken now, is still empty.
    page.emit('response', {
      request: () => req,
      status: () => 400,
      text: () =>
        new Promise((r) =>
          setTimeout(() => r(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } })), 300),
        ),
    });
    expect(rpc.sessionFaults()).toEqual([]);
    expect(await exitCode(() => exitWithVerdict(0))).toBe(1);
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toContain('eth_call: json-rpc -32602');
    expect(await exitCode(() => exitWithVerdict(2))).toBe(1);
    expect(await exitCode(() => exitWithVerdict(1))).toBe(1);
  });
});
