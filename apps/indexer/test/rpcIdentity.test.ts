/** #1415 — RPC chain-identity assertion, pinned. The failure it
 *  guards is the SILENT one from the July 2026 outage: a mis-pointed
 *  RPC (wrong network= slug) whose head sits below our cursor reads
 *  as "caught up" — no error, no log, no movement. These tests pin
 *  the loud path, the per-isolate verification cache, the
 *  transport-failure-aborts-without-a-verdict rule (Codex #1527 r1
 *  P1 — an unverified endpoint must never advance the cursor), and
 *  that NO fragment of the provider URL — host included, since some
 *  providers embed the credential in the hostname — ever reaches the
 *  log line (Codex #1527 r1 P2).
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

  it('a MISMATCH fails loudly, is NOT cached (re-probed next pass), and logs NO fragment of the URL — host included', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = stubClient(() => Promise.resolve(1));
    // A hostname-embedded credential (some providers generate these) —
    // the strongest shape the redaction must survive.
    const rpc = 'https://SECRETKEY.provider.example/ws?also=SECRETKEY';
    expect(await verifyRpcChainIdentity(c, 84532, rpc)).toEqual({
      ok: false,
      reason: 'mismatch',
      reported: 1,
    });
    expect(await verifyRpcChainIdentity(c, 84532, rpc)).toEqual({
      ok: false,
      reason: 'mismatch',
      reported: 1,
    });
    expect(c.calls()).toBe(2); // not cached
    const logged = err.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(logged).toContain('eth_chainId=1');
    expect(logged).toContain('84532'); // the chain id names the RPC_* secret
    expect(logged).not.toContain('SECRETKEY');
    expect(logged).not.toContain('provider.example');
  });

  it('a TRANSPORT failure aborts the pass (retryable) WITHOUT a cached verdict — an unverified endpoint never scans', async () => {
    const c = stubClient(() => Promise.reject(new Error('ECONNRESET')));
    const rpc = 'https://rpc.example/transport-fail';
    expect(await verifyRpcChainIdentity(c, 84532, rpc)).toEqual({
      ok: false,
      reason: 'transport',
    });
    // The blip heals → the SAME pair verifies on the next pass (no
    // poisoned negative cache) and the probe runs exactly once more.
    const healed = stubClient(() => Promise.resolve(84532));
    expect(await verifyRpcChainIdentity(healed, 84532, rpc)).toEqual({
      ok: true,
    });
    expect(healed.calls()).toBe(1);
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
