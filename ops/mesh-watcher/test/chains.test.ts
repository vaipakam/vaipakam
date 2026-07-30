/**
 * Unit tests for chain resolution and endpoint identity verification.
 *
 * Same discipline as `invariants.test.ts`: the baseline is the HEALTHY
 * case and asserts the absence of a gap, every failure test changes
 * exactly one thing off it, and each test names the mutation it kills.
 *
 * The specific trap this file exists for (#1445) is that a wrong-network
 * endpoint is INDISTINGUISHABLE from a correct one unless something asks.
 * A test that only checked "mismatch produces a gap" would pass against
 * an implementation that gapped unconditionally, so the first test pins
 * the negative: a matching endpoint must produce NO gap at all.
 */

import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { verifyChainIdentity, type ChainTarget } from '../src/chains';

/**
 * A target whose client answers `eth_chainId` with `reports`, or throws
 * `throws` if given. Only `getChainId` is exercised, so the rest of the
 * viem surface is deliberately absent rather than stubbed — a test that
 * needed more would fail loudly instead of silently exercising a mock.
 */
function targetReporting(
  configuredId: number,
  outcome: { reports: number } | { throws: unknown },
): ChainTarget {
  return {
    chainId: configuredId,
    slug: `chain-${configuredId}`,
    diamond: '0x00000000000000000000000000000000000000d1' as Address,
    client: {
      getChainId: async () => {
        if ('throws' in outcome) throw outcome.throws;
        return outcome.reports;
      },
    } as unknown as PublicClient,
  };
}

describe('verifyChainIdentity (#1445)', () => {
  it('BASELINE: an endpoint that confirms its configured id produces no gap', async () => {
    // Pins the negative. Without this, an implementation that returned a
    // gap unconditionally would satisfy every other test in this file.
    const gap = await verifyChainIdentity(
      targetReporting(84532, { reports: 84532 }),
      'own-ledger',
    );
    expect(gap).toBeNull();
  });

  it('reports a chain-mismatch gap when the endpoint is a different network', async () => {
    const gap = await verifyChainIdentity(
      targetReporting(84532, { reports: 421614 }),
      'own-ledger',
    );
    expect(gap).not.toBeNull();
    expect(gap!.reason).toBe('chain-mismatch');
    expect(gap!.chainId).toBe(84532);
    expect(gap!.source).toBe('own-ledger');
  });

  it('names BOTH the configured and the observed chain in the detail', async () => {
    // The whole value of this check is telling an operator which secret
    // is wrong and what it actually points at. A gap that said only
    // "wrong chain" would be a correct detection and a useless alert, so
    // the detail is asserted rather than assumed.
    const gap = await verifyChainIdentity(
      targetReporting(84532, { reports: 421614 }),
      'own-ledger',
    );
    expect(gap!.detail).toContain('84532');
    expect(gap!.detail).toContain('421614');
    expect(gap!.detail).toContain('RPC_84532');
  });

  it('distinguishes a mismatch from unreachability — reason is NOT no-rpc', async () => {
    // The distinction is the point: `no-rpc` sends an operator to the
    // provider, and here the provider is fine. Collapsing the two would
    // also collide on the dedup key, so one detail would be discarded.
    const mismatch = await verifyChainIdentity(
      targetReporting(84532, { reports: 421614 }),
      'own-ledger',
    );
    const unreachable = await verifyChainIdentity(
      targetReporting(84532, { throws: new Error('fetch failed') }),
      'own-ledger',
    );
    expect(mismatch!.reason).toBe('chain-mismatch');
    expect(unreachable!.reason).toBe('no-rpc');
    expect(mismatch!.reason).not.toBe(unreachable!.reason);
  });

  it('classifies an eth_chainId failure instead of forwarding it', async () => {
    // viem puts the request URL in its error text and provider URLs
    // carry the API key in the path or query, so a forwarded message
    // leaks a credential into a Telegram alert. Asserts the secret is
    // ABSENT from the detail, not merely that some detail exists.
    const leaky = new Error(
      'HTTP request failed. URL: https://base-sepolia.example.com/v2/SUPERSECRETKEY123',
    );
    const gap = await verifyChainIdentity(
      targetReporting(84532, { throws: leaky }),
      'own-ledger',
    );
    expect(gap!.detail).not.toContain('SUPERSECRETKEY123');
    expect(gap!.detail).not.toContain('base-sepolia.example.com');
  });

  it('carries the caller-supplied source so two reads on one chain do not collide', async () => {
    // A chain can fail identity on both its Base-side and own-ledger
    // paths; `reason` alone would dedup them onto one key and drop a
    // detail (the #1443 r7 collision, in a new place).
    const base = await verifyChainIdentity(
      targetReporting(84532, { reports: 1 }),
      'base-books',
    );
    const own = await verifyChainIdentity(
      targetReporting(84532, { reports: 1 }),
      'own-ledger',
    );
    expect(base!.source).toBe('base-books');
    expect(own!.source).toBe('own-ledger');
  });

  it('never throws, whatever the endpoint does', async () => {
    // One misconfigured mirror must not abort the tick — that would let
    // a single bad secret blind the watcher to every other chain.
    await expect(
      verifyChainIdentity(
        targetReporting(84532, { throws: 'not even an Error' }),
        'own-ledger',
      ),
    ).resolves.toBeTruthy();
  });
});
