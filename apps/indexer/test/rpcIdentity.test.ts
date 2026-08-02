/** #1415 — RPC chain-identity assertion, pinned. The failure it
 *  guards is the SILENT one from the July 2026 outage: a mis-pointed
 *  RPC (wrong network= slug) whose head sits below our cursor reads
 *  as "caught up" — no error, no log, no movement. These tests pin
 *  the loud path, the per-isolate verification cache, the
 *  no-verdict-on-transport-failure rule, and that provider URLs
 *  (which embed API keys) never reach the log line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isRetryableScanSkip,
  verifyRpcChainIdentity,
} from '../src/chainIndexer';

function stubClient(behavior: () => Promise<number>) {
  let calls = 0;
  return {
    calls: () => calls,
    getChainId: () => {
      calls++;
      return behavior();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyRpcChainIdentity', () => {
  it('a matching chain id verifies and CACHES — the probe costs one call per isolate per pair', async () => {
    const c = stubClient(() => Promise.resolve(84532));
    const rpc = 'https://rpc.example/match-cache';
    expect(await verifyRpcChainIdentity(c, 84532, rpc)).toEqual({ ok: true });
    expect(await verifyRpcChainIdentity(c, 84532, rpc)).toEqual({ ok: true });
    expect(c.calls()).toBe(1);
  });

  it('a MISMATCH fails loudly, is NOT cached (re-probed next pass), and logs the host — never the key-bearing URL', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = stubClient(() => Promise.resolve(1));
    const rpc = 'https://lb.drpc.org/ogrpc?network=ethereum&dkey=SECRETKEY';
    expect(await verifyRpcChainIdentity(c, 84532, rpc)).toEqual({
      ok: false,
      reported: 1,
    });
    expect(await verifyRpcChainIdentity(c, 84532, rpc)).toEqual({
      ok: false,
      reported: 1,
    });
    expect(c.calls()).toBe(2); // not cached
    const logged = err.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(logged).toContain('eth_chainId=1');
    expect(logged).toContain('lb.drpc.org');
    expect(logged).not.toContain('SECRETKEY');
  });

  it('a TRANSPORT failure is not an identity verdict: the pass proceeds (ok) and nothing is cached', async () => {
    const c = stubClient(() => Promise.reject(new Error('ECONNRESET')));
    const rpc = 'https://rpc.example/transport-fail';
    expect(await verifyRpcChainIdentity(c, 84532, rpc)).toEqual({ ok: true });
    const healed = stubClient(() => Promise.resolve(84532));
    expect(await verifyRpcChainIdentity(healed, 84532, rpc)).toEqual({
      ok: true,
    });
    expect(healed.calls()).toBe(1); // re-probed after the failure
  });

  it('an unparseable rpc string still logs without throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = stubClient(() => Promise.resolve(97));
    expect(await verifyRpcChainIdentity(c, 84532, 'not a url')).toEqual({
      ok: false,
      reported: 97,
    });
    expect(err.mock.calls.join(' ')).toContain('unparseable-rpc-url');
  });
});

describe('isRetryableScanSkip (shared with the ingest DO)', () => {
  it('rpc-error and rpc-chain-mismatch are retryable failures; caught-up and undefined are not', () => {
    expect(isRetryableScanSkip('rpc-error')).toBe(true);
    expect(isRetryableScanSkip('rpc-chain-mismatch')).toBe(true);
    expect(isRetryableScanSkip('caught-up')).toBe(false);
    expect(isRetryableScanSkip(undefined)).toBe(false);
  });
});
