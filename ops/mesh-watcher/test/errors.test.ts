/**
 * Tests for the failure classifier's pass-through carrier.
 *
 * `classify` works by substring-matching error text. That is right for
 * provider and platform errors and actively wrong for our OWN messages: a
 * hand-built, already-safe detail gets re-interpreted by whichever marker
 * its wording happens to contain, and a specific diagnosis is replaced by
 * a generic one.
 *
 * The test that matters here is the last one — it feeds the REAL #1445
 * mismatch detail through the real classifier, so it fails if either the
 * carrier or the wording regresses. A test built on invented text would
 * pass while the actual alert stayed broken.
 */

import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import {
  PreclassifiedFailure,
  classify,
  describeFailure,
} from '../src/errors';
import { verifyChainIdentity, type ChainTarget } from '../src/chains';

describe('PreclassifiedFailure (#1464 r1)', () => {
  it('BASELINE: an ordinary error is still classified by its markers', () => {
    // Pins the negative — the carrier must not disable classification for
    // everything, or every provider error would arrive unclassified.
    expect(classify(new Error('fetch failed')).kind).toBe('network');
    expect(classify(new Error('execution reverted')).kind).toBe(
      'contract-revert',
    );
  });

  it('returns a pre-classified failure verbatim', () => {
    const failure = { kind: 'config' as const, summary: 'a safe summary' };
    expect(classify(new PreclassifiedFailure(failure))).toEqual(failure);
  });

  it('does NOT prefix a pre-classified summary with the call context', () => {
    // The summary is already complete and operator-facing. Prefixing it
    // would produce "own-ledger read on chain 1: RPC_1 points at the
    // WRONG NETWORK…", implying a read failed when none did.
    const out = classify(
      new PreclassifiedFailure({ kind: 'config', summary: 'complete text' }),
      'some context',
    );
    expect(out.summary).toBe('complete text');
  });

  it('survives a summary that CONTAINS a marker word', () => {
    // The precise defect: "network" is a `network` marker, so a safe
    // summary mentioning it was rewritten as "the endpoint could not be
    // reached" — losing the diagnosis and telling the operator to check
    // the wrong thing.
    const failure = {
      kind: 'config' as const,
      summary: 'RPC_84532 points at the WRONG NETWORK — reports chain 421614',
    };
    const out = classify(new PreclassifiedFailure(failure));
    expect(out.kind).toBe('config');
    expect(out.kind).not.toBe('network');
    expect(out.summary).toContain('421614');
    expect(out.summary).not.toContain('could not be reached');
  });

  it('carries the REAL #1445 canonical mismatch detail through intact', async () => {
    // End to end against the actual detail builder, so this test fails if
    // either side regresses — a hand-written summary would not catch a
    // re-worded detail that reintroduces a marker collision.
    const target: ChainTarget = {
      chainId: 84532,
      slug: 'base-sepolia',
      diamond: '0x00000000000000000000000000000000000000d1' as Address,
      client: { getChainId: async () => 421614 } as unknown as PublicClient,
    };
    const gap = await verifyChainIdentity(target, 'base-books');
    expect(gap).not.toBeNull();

    const rendered = describeFailure(
      classify(
        new PreclassifiedFailure({ kind: 'config', summary: gap!.detail }),
        'canonical identity',
      ),
    );
    // Both chain ids and the actionable instruction must reach the operator.
    expect(rendered).toContain('84532');
    expect(rendered).toContain('421614');
    expect(rendered).toContain('RPC_84532');
    expect(rendered).not.toContain('could not be reached');
  });

  it('a bare Error carrying the same detail WOULD have been mangled', () => {
    // Proves the carrier is what fixes it, not the wording — i.e. this
    // file is not green by accident. This is the pre-fix behaviour.
    const detail =
      'RPC_84532 points at the WRONG NETWORK — reports chain 421614';
    const mangled = classify(new Error(detail), 'canonical identity');
    expect(mangled.kind).toBe('network');
    expect(mangled.summary).toContain('could not be reached');
    expect(mangled.summary).not.toContain('421614');
  });
});
