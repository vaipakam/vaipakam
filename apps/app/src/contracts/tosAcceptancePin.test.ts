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
  adoptOrderedPin,
  pinAcceptance,
} from './tosAcceptancePin';

const SCOPE = acceptanceScope(84532, '0xAbC0000000000000000000000000000000000001');
const T0 = 1_800_000_000_000;
const HASH = `0x${'cd'.repeat(32)}`;
// The block the pinned acceptance mined in. Ordering runs on this
// (#2004 round 14); the matching predicates below never read it.
const B0 = 4_200_000;

beforeEach(() => {
  __clearAcceptancePins();
});

describe('acceptanceIsPinned', () => {
  it('corrects a lagging read at the version that was accepted', () => {
    pinAcceptance(SCOPE, 2, HASH, B0, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + 1_000)).toBe(true);
  });

  it('expires, so a reorg cannot be papered over indefinitely', () => {
    // Review round 11 P1. An orphaned receipt makes canonical reads
    // report `false` at the same version — indistinguishable from lag,
    // except by how long it lasts. Unbounded, the pin held both gates
    // open on an acceptance that no longer existed for as long as the
    // tab stayed open. Past the bound the chain's answer wins.
    pinAcceptance(SCOPE, 2, HASH, B0, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS + 1)).toBe(false);
  });

  it('does not resurrect an expired pin on a later call', () => {
    // Expiry deletes rather than ignores, so a clock that goes
    // backwards — a wallet switch, a machine sleeping — cannot revive a
    // pin that has already been retired.
    pinAcceptance(SCOPE, 2, HASH, B0, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS + 1)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + 1_000)).toBe(false);
  });

  it('never applies to another version', () => {
    // A governance bump must re-prompt. This is what stops the pin
    // becoming a way to skip terms nobody has seen.
    pinAcceptance(SCOPE, 2, HASH, B0, T0);
    expect(acceptanceIsPinned(SCOPE, 3, HASH, T0 + 1_000)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 1, HASH, T0 + 1_000)).toBe(false);
  });

  it('never applies to another HASH at the same version', () => {
    // #2004 round 4 P1. The version counter is monotonic only within
    // one branch — a reorg can put different text at the same number —
    // and the contract compares version AND hash. So does the pin.
    pinAcceptance(SCOPE, 2, HASH, B0, T0);
    expect(acceptanceIsPinned(SCOPE, 2, `0x${'ee'.repeat(32)}`, T0 + 1_000)).toBe(false);
  });

  it('never applies to another wallet or another chain', () => {
    // Acceptance is recorded per wallet and per network, so an
    // inherited pin would open the gate on an acceptance never made.
    // Narrowed by matching, so there is no revocation path to forget.
    pinAcceptance(SCOPE, 2, HASH, B0, T0);
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
    pinAcceptance(SCOPE, 2, HASH, B0, T0);
    expect(acceptanceIsPinned(lower, 2, HASH, T0 + 1_000)).toBe(true);
  });
});

describe('adoptOrderedPin', () => {
  // #2004 round 14 (unifying rounds 2 and 13): ordering is by the
  // acceptance's MINED BLOCK, `at` breaking ties within one block.
  // Version ordering got a rollback backwards (an orphaned higher
  // version outranked the restored lower one), and wall-stamp
  // ordering did not survive a clock correction; chain height orders
  // acceptances under both.
  const H2 = `0x${'ef'.repeat(32)}`;

  it('adopts a HIGHER-block pin at a LOWER version — the reorged-out branch loses', () => {
    // Round 13 P2's case, now on height: an orphaned v4 pin must not
    // block the restored v3 acceptance mined after the rollback.
    pinAcceptance(SCOPE, 4, HASH, B0, T0);
    expect(adoptOrderedPin(SCOPE, 3, H2, T0 + 30_000, B0 + 2, T0 + 30_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, T0 + 31_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 4, HASH, T0 + 31_000)).toBe(false);
  });

  it('adopts a higher-block pin whose wall stamp is EARLIER — a clock correction cannot reorder', () => {
    // Round 14 P2's case: the incumbent was stamped before a backward
    // clock shift, so the genuinely newer acceptance carries a
    // smaller `at`. Height decides; the stamp does not.
    pinAcceptance(SCOPE, 4, HASH, B0, T0 + 60_000);
    expect(adoptOrderedPin(SCOPE, 3, H2, T0, B0 + 2, T0 + 61_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, T0 + 61_000)).toBe(true);
  });

  it('refuses a LOWER-block pin whatever its version or stamp', () => {
    // Round 2's slow-RPC case: a newer acceptance's pin is already
    // here, and the stale receipt resolving late must not evict it —
    // even arriving with a later wall stamp.
    pinAcceptance(SCOPE, 4, HASH, B0, T0);
    expect(adoptOrderedPin(SCOPE, 3, H2, T0 + 30_000, B0 - 2, T0 + 30_000)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 4, HASH, T0 + 31_000)).toBe(true);
  });

  it('breaks a same-block tie by the later stamp', () => {
    // Two acceptances in one block — a same-version re-acceptance
    // from two tabs. The later stamp anchors the longer window.
    pinAcceptance(SCOPE, 3, HASH, B0, T0);
    expect(adoptOrderedPin(SCOPE, 3, HASH, T0, B0, T0 + 1_000)).toBe(false);
    expect(adoptOrderedPin(SCOPE, 3, HASH, T0 + 5_000, B0, T0 + 6_000)).toBe(true);
  });

  it('discards an expired incumbent before comparing', () => {
    // Round 3 P2: past the bound a pin has no authority left to
    // reject with — even from a higher block.
    pinAcceptance(SCOPE, 4, HASH, B0 + 10, T0);
    const later = T0 + ACCEPTANCE_PIN_TTL_MS + 60_000;
    expect(adoptOrderedPin(SCOPE, 3, H2, later, B0, later)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, later)).toBe(true);
  });
});
