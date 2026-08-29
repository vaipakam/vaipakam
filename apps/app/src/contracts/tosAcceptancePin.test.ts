/**
 * The acceptance pin's two safety properties (#1961, review round 11).
 *
 * The pin corrects a lagging read. Both ways of getting it wrong are
 * here: correcting a read that is not lagging at all (the reorg case,
 * where the chain has genuinely un-accepted the wallet), and failing to
 * correct one that is.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_PIN_TTL_MS,
  __clearAcceptancePins,
  acceptanceIsPinned,
  acceptanceScope,
  adoptReceiptPin,
  pinAcceptance,
} from './tosAcceptancePin';

const SCOPE = acceptanceScope(84532, '0xAbC0000000000000000000000000000000000001');
const T0 = 1_800_000_000_000;
const HASH = `0x${'cd'.repeat(32)}`;

beforeEach(() => {
  __clearAcceptancePins();
});

describe('acceptanceIsPinned', () => {
  it('corrects a lagging read at the version that was accepted', () => {
    pinAcceptance(SCOPE, 2, HASH, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + 1_000)).toBe(true);
  });

  it('expires, so a reorg cannot be papered over indefinitely', () => {
    // Review round 11 P1. An orphaned receipt makes canonical reads
    // report `false` at the same version — indistinguishable from lag,
    // except by how long it lasts. Unbounded, the pin held both gates
    // open on an acceptance that no longer existed for as long as the
    // tab stayed open. Past the bound the chain's answer wins.
    pinAcceptance(SCOPE, 2, HASH, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS + 1)).toBe(false);
  });

  it('does not resurrect an expired pin on a later call', () => {
    // Expiry deletes rather than ignores, so a clock that goes
    // backwards — a wallet switch, a machine sleeping — cannot revive a
    // pin that has already been retired.
    pinAcceptance(SCOPE, 2, HASH, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS + 1)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + 1_000)).toBe(false);
  });

  it('never applies to another version', () => {
    // A governance bump must re-prompt. This is what stops the pin
    // becoming a way to skip terms nobody has seen.
    pinAcceptance(SCOPE, 2, HASH, T0);
    expect(acceptanceIsPinned(SCOPE, 3, HASH, T0 + 1_000)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 1, HASH, T0 + 1_000)).toBe(false);
  });

  it('never applies to another HASH at the same version', () => {
    // #2004 round 4 P1. The version counter is monotonic only within
    // one branch — a reorg can put different text at the same number —
    // and the contract compares version AND hash. So does the pin.
    pinAcceptance(SCOPE, 2, HASH, T0);
    expect(acceptanceIsPinned(SCOPE, 2, `0x${'ee'.repeat(32)}`, T0 + 1_000)).toBe(false);
  });

  it('never applies to another wallet or another chain', () => {
    // Acceptance is recorded per wallet and per network, so an
    // inherited pin would open the gate on an acceptance never made.
    // Narrowed by matching, so there is no revocation path to forget.
    pinAcceptance(SCOPE, 2, HASH, T0);
    const otherWallet = acceptanceScope(84532, '0xAbC0000000000000000000000000000000000002');
    const otherChain = acceptanceScope(11155111, '0xAbC0000000000000000000000000000000000001');
    expect(acceptanceIsPinned(otherWallet, 2, HASH, T0 + 1_000)).toBe(false);
    expect(acceptanceIsPinned(otherChain, 2, HASH, T0 + 1_000)).toBe(false);
  });

  it('is unset until an acceptance is actually mined', () => {
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0)).toBe(false);
  });

  it('matches a wallet address whatever its case', () => {
    // The scope is built from a wagmi address in one place and a route
    // or storage value in another; a case difference must not silently
    // drop the pin.
    const lower = acceptanceScope(84532, '0xabc0000000000000000000000000000000000001');
    pinAcceptance(SCOPE, 2, HASH, T0);
    expect(acceptanceIsPinned(lower, 2, HASH, T0 + 1_000)).toBe(true);
  });
});

describe('adoptReceiptPin', () => {
  // #2004 round 13 P2 — the trusted-local path. A mined receipt proves
  // its version was canonical at mine time, so it supersedes any
  // EARLIER pin regardless of version; a LATER incumbent is the newer
  // fact and wins (round 2's slow-RPC case).
  const H2 = `0x${'ef'.repeat(32)}`;

  it('replaces an older HIGHER-version pin — the reorged-out branch loses', () => {
    pinAcceptance(SCOPE, 4, HASH, T0);
    expect(adoptReceiptPin(SCOPE, 3, H2, T0 + 30_000, T0 + 30_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, T0 + 31_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 4, HASH, T0 + 31_000)).toBe(false);
  });

  it('yields to a LATER-stamped incumbent', () => {
    pinAcceptance(SCOPE, 4, HASH, T0 + 60_000);
    expect(adoptReceiptPin(SCOPE, 3, H2, T0, T0 + 61_000)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 4, HASH, T0 + 61_000)).toBe(true);
  });

  it('discards an expired incumbent before comparing', () => {
    pinAcceptance(SCOPE, 4, HASH, T0);
    const later = T0 + ACCEPTANCE_PIN_TTL_MS + 60_000;
    expect(adoptReceiptPin(SCOPE, 3, H2, later, later)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, later)).toBe(true);
  });
});
