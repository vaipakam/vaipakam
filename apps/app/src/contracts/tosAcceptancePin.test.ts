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
  MAX_FUTURE_SKEW_MS,
  __clearAcceptancePins,
  acceptanceIsPinned,
  acceptanceScope,
  adoptOrderedPin,
  adoptReceiptPin,
  observePinExpiry,
  pinAcceptance,
  retireSupersededPin,
} from './tosAcceptancePin';

const SCOPE = acceptanceScope(84532, '0xAbC0000000000000000000000000000000000001');
const T0 = 1_800_000_000_000;
const HASH = `0x${'cd'.repeat(32)}`;
// The chain position (block, tx index) the pinned acceptance mined
// at. Frame ordering runs on these (#2004 rounds 14–15); the matching
// predicates below never read them.
const B0 = 4_200_000;
const TX0 = 7;

beforeEach(() => {
  __clearAcceptancePins();
});

describe('acceptanceIsPinned', () => {
  it('corrects a lagging read at the version that was accepted', () => {
    pinAcceptance(SCOPE, 2, HASH, B0, TX0, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + 1_000)).toBe(true);
  });

  it('expires, so a reorg cannot be papered over indefinitely', () => {
    // Review round 11 P1. An orphaned receipt makes canonical reads
    // report `false` at the same version — indistinguishable from lag,
    // except by how long it lasts. Unbounded, the pin held both gates
    // open on an acceptance that no longer existed for as long as the
    // tab stayed open. Past the bound the chain's answer wins.
    pinAcceptance(SCOPE, 2, HASH, B0, TX0, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS + 1)).toBe(false);
  });

  it('does not resurrect an expired pin on a later call', () => {
    // Expiry deletes rather than ignores, so a clock that goes
    // backwards — a wallet switch, a machine sleeping — cannot revive a
    // pin that has already been retired.
    pinAcceptance(SCOPE, 2, HASH, B0, TX0, T0);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + ACCEPTANCE_PIN_TTL_MS + 1)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 2, HASH, T0 + 1_000)).toBe(false);
  });

  it('never applies to another version', () => {
    // A governance bump must re-prompt. This is what stops the pin
    // becoming a way to skip terms nobody has seen.
    pinAcceptance(SCOPE, 2, HASH, B0, TX0, T0);
    expect(acceptanceIsPinned(SCOPE, 3, HASH, T0 + 1_000)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 1, HASH, T0 + 1_000)).toBe(false);
  });

  it('never applies to another HASH at the same version', () => {
    // #2004 round 4 P1. The version counter is monotonic only within
    // one branch — a reorg can put different text at the same number —
    // and the contract compares version AND hash. So does the pin.
    pinAcceptance(SCOPE, 2, HASH, B0, TX0, T0);
    expect(acceptanceIsPinned(SCOPE, 2, `0x${'ee'.repeat(32)}`, T0 + 1_000)).toBe(false);
  });

  it('never applies to another wallet or another chain', () => {
    // Acceptance is recorded per wallet and per network, so an
    // inherited pin would open the gate on an acceptance never made.
    // Narrowed by matching, so there is no revocation path to forget.
    pinAcceptance(SCOPE, 2, HASH, B0, TX0, T0);
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
    pinAcceptance(SCOPE, 2, HASH, B0, TX0, T0);
    expect(acceptanceIsPinned(lower, 2, HASH, T0 + 1_000)).toBe(true);
  });
});

describe('adoptOrderedPin', () => {
  // #2004 rounds 14–15: remote frames order by the acceptance's chain
  // position — (mined block, transaction index) — with `at` only as
  // the duplicate tiebreak. Version ordering got a rollback backwards
  // (an orphaned higher version outranked the restored lower one),
  // and wall-stamp ordering did not survive a clock correction.
  const H2 = `0x${'ef'.repeat(32)}`;

  it('adopts a HIGHER-block pin at a LOWER version — the reorged-out branch loses', () => {
    // Round 13 P2's case, on height: an orphaned v4 pin must not
    // block the restored v3 acceptance mined after the rollback.
    pinAcceptance(SCOPE, 4, HASH, B0, TX0, T0);
    expect(adoptOrderedPin(SCOPE, 3, H2, T0 + 30_000, B0 + 2, 0, T0 + 30_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, T0 + 31_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 4, HASH, T0 + 31_000)).toBe(false);
  });

  it('adopts a higher-block pin whose wall stamp is EARLIER — a clock correction cannot reorder', () => {
    // Round 14 P2's case: the incumbent was stamped before a backward
    // clock shift, so the genuinely newer acceptance carries a
    // smaller `at`. Chain position decides; the stamp does not.
    pinAcceptance(SCOPE, 4, HASH, B0, TX0, T0 + 60_000);
    expect(adoptOrderedPin(SCOPE, 3, H2, T0, B0 + 2, 0, T0 + 61_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, T0 + 61_000)).toBe(true);
  });

  it('refuses a LOWER-block pin whatever its version or stamp', () => {
    // Round 2's slow-RPC case: a newer acceptance's pin is already
    // here, and a stale frame arriving late must not evict it — even
    // arriving with a later wall stamp.
    pinAcceptance(SCOPE, 4, HASH, B0, TX0, T0);
    expect(adoptOrderedPin(SCOPE, 3, H2, T0 + 30_000, B0 - 2, 20, T0 + 30_000)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 4, HASH, T0 + 31_000)).toBe(true);
  });

  it('orders two same-block acceptances by transaction index, not stamp', () => {
    // Round 15 P2: two acceptances in one block are nonce-ordered on
    // chain and their indices record that order exactly; the earlier
    // wall stamp on the later transaction must not matter.
    pinAcceptance(SCOPE, 3, HASH, B0, 4, T0 + 10_000);
    expect(adoptOrderedPin(SCOPE, 4, H2, T0, B0, 9, T0 + 11_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 4, H2, T0 + 11_000)).toBe(true);
    // And the mirror: a lower index never evicts a higher one.
    expect(adoptOrderedPin(SCOPE, 3, HASH, T0 + 20_000, B0, 4, T0 + 20_000)).toBe(false);
  });

  it('breaks an identical chain position by the later stamp', () => {
    // The same transaction re-broadcast — a duplicate frame. The
    // later stamp anchors the longer window.
    pinAcceptance(SCOPE, 3, HASH, B0, TX0, T0);
    expect(adoptOrderedPin(SCOPE, 3, HASH, T0, B0, TX0, T0 + 1_000)).toBe(false);
    expect(adoptOrderedPin(SCOPE, 3, HASH, T0 + 5_000, B0, TX0, T0 + 6_000)).toBe(true);
  });

  it('refuses a candidate already past its own window', () => {
    // Round 15 P2: a delivery or suspended continuation arriving past
    // the candidate's own TTL applies nothing — the same rule the
    // receiver applies to expired frames.
    const late = T0 + ACCEPTANCE_PIN_TTL_MS + 1;
    expect(adoptOrderedPin(SCOPE, 3, HASH, T0, B0, TX0, late)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 3, HASH, late)).toBe(false);
  });

  it('refuses a candidate dated in the future beyond the skew allowance', () => {
    // Round 16 P1: a future anchor's negative age passes every expiry
    // check until wall time catches up — an unbounded override from
    // one bad timestamp. Within the allowance (a coarse correction
    // mid-write) it still adopts.
    expect(adoptOrderedPin(SCOPE, 3, HASH, T0 + MAX_FUTURE_SKEW_MS + 1_000, B0, TX0, T0)).toBe(
      false,
    );
    expect(acceptanceIsPinned(SCOPE, 3, HASH, T0)).toBe(false);
    expect(adoptOrderedPin(SCOPE, 3, HASH, T0 + MAX_FUTURE_SKEW_MS - 1_000, B0, TX0, T0)).toBe(
      true,
    );
  });

  it('discards an expired incumbent before comparing', () => {
    // Round 3 P2: past the bound a pin has no authority left to
    // reject with — even from a higher block.
    pinAcceptance(SCOPE, 4, HASH, B0 + 10, TX0, T0);
    const later = T0 + ACCEPTANCE_PIN_TTL_MS + 60_000;
    expect(adoptOrderedPin(SCOPE, 3, H2, later, B0, 0, later)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, later)).toBe(true);
  });
});

describe('adoptReceiptPin', () => {
  // #2004 round 15 P2 — the trusted path for the tab's own
  // just-settled receipt, restored without any comparison: every
  // marker tried for ordering receipt against incumbent fell to a
  // case it could not see (version → rollback, wall stamp → clock
  // correction, height → shorter replacement chain). The receipt
  // supersedes; only its own expiry refuses it.
  const H2 = `0x${'ef'.repeat(32)}`;

  it('supersedes a higher-block, later-stamped incumbent', () => {
    // The shorter-replacement-chain reorg: the orphaned pin sits at a
    // HIGHER height and a later stamp than the restored canonical
    // receipt, and must still lose.
    pinAcceptance(SCOPE, 4, HASH, B0 + 10, TX0, T0 + 30_000);
    expect(adoptReceiptPin(SCOPE, 3, H2, T0, B0, 0, T0 + 31_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 3, H2, T0 + 31_000)).toBe(true);
    expect(acceptanceIsPinned(SCOPE, 4, HASH, T0 + 31_000)).toBe(false);
  });

  it('refuses a receipt whose anchor is already past its own window', () => {
    // Round 15 P2: a continuation resuming from a suspension longer
    // than the TTL carries a dead anchor — nothing is adopted, and the
    // caller's reads take the case.
    const late = T0 + ACCEPTANCE_PIN_TTL_MS + 1;
    expect(adoptReceiptPin(SCOPE, 3, H2, T0, B0, 0, late)).toBe(false);
    expect(acceptanceIsPinned(SCOPE, 3, H2, late)).toBe(false);
  });

  it('refuses a receipt anchored in the future beyond the skew allowance', () => {
    // Round 16 P1: the trusted path bypassed the receiver's
    // future-skew guard, so a backward clock correction between
    // submission and settlement produced a pin that could not expire
    // until wall time caught up — correcting canonical reads far past
    // the stated bound if the acceptance was orphaned. The caller
    // clamps its anchor first; this is the module's own backstop.
    expect(adoptReceiptPin(SCOPE, 3, H2, T0 + MAX_FUTURE_SKEW_MS + 1_000, B0, 0, T0)).toBe(
      false,
    );
    expect(acceptanceIsPinned(SCOPE, 3, H2, T0)).toBe(false);
  });
});

describe('retireSupersededPin', () => {
  // #2004 round 17 P1: the adoption guards stop a stale pin ARRIVING;
  // this stops one SURVIVING a node-confirmed read that supersedes it.
  const H2 = `0x${'ef'.repeat(32)}`;

  it('retires a pin once a read reports a HIGHER version', () => {
    // With the v3 pin left in place, a later refetch through an RPC
    // still serving v3 would convert its truthful `false` into a
    // fresh `accepted: true` under terms a v4 read just proved are no
    // longer in force.
    pinAcceptance(SCOPE, 3, HASH, B0, TX0, T0);
    retireSupersededPin(SCOPE, 4, H2);
    expect(acceptanceIsPinned(SCOPE, 3, HASH, T0 + 1_000)).toBe(false);
  });

  it('retires a pin whose hash a same-version read contradicts', () => {
    // The reorged-text case: the fresh read is the better witness to
    // which text stands at the shared number.
    pinAcceptance(SCOPE, 3, HASH, B0, TX0, T0);
    retireSupersededPin(SCOPE, 3, H2);
    expect(acceptanceIsPinned(SCOPE, 3, HASH, T0 + 1_000)).toBe(false);
  });

  it('does NOT retire on a LOWER-version read — that is the lag the pin corrects', () => {
    pinAcceptance(SCOPE, 4, HASH, B0, TX0, T0);
    retireSupersededPin(SCOPE, 3, H2);
    expect(acceptanceIsPinned(SCOPE, 4, HASH, T0 + 1_000)).toBe(true);
  });

  it('does not retire on a matching read, and tolerates no pin at all', () => {
    retireSupersededPin(SCOPE, 3, HASH);
    pinAcceptance(SCOPE, 3, HASH, B0, TX0, T0);
    retireSupersededPin(SCOPE, 3, HASH);
    expect(acceptanceIsPinned(SCOPE, 3, HASH, T0 + 1_000)).toBe(true);
  });
});

describe('observePinExpiry', () => {
  // #2004 round 18 P1: the expiry timer's observation of death must
  // BE the retirement — a dead pin left in the map was resurrected by
  // a backward clock correction after the timer, the only thing that
  // would have aged its product, had terminated.
  const H2 = `0x${'ef'.repeat(32)}`;

  it('reports a live pin with its remaining life', () => {
    pinAcceptance(SCOPE, 3, HASH, B0, TX0, T0);
    expect(observePinExpiry(SCOPE, 3, HASH, T0 + 30_000)).toEqual({
      state: 'live',
      remainingMs: ACCEPTANCE_PIN_TTL_MS - 30_000,
    });
  });

  it('retires an expired pin, so a backward clock cannot resurrect it', () => {
    pinAcceptance(SCOPE, 3, HASH, B0, TX0, T0);
    expect(observePinExpiry(SCOPE, 3, HASH, T0 + ACCEPTANCE_PIN_TTL_MS + 1)).toEqual({
      state: 'expired',
    });
    // The clock is corrected back inside the original window: with the
    // corpse retained this reported true, reopening both gates with no
    // timer left to age the verdict it manufactures.
    expect(acceptanceIsPinned(SCOPE, 3, HASH, T0 + 1_000)).toBe(false);
  });

  it('reports superseded — and retires nothing — when a different pin holds the scope', () => {
    pinAcceptance(SCOPE, 4, H2, B0 + 2, 0, T0);
    expect(observePinExpiry(SCOPE, 3, HASH, T0 + 1_000)).toEqual({ state: 'superseded' });
    expect(acceptanceIsPinned(SCOPE, 4, H2, T0 + 1_000)).toBe(true);
    __clearAcceptancePins();
    expect(observePinExpiry(SCOPE, 3, HASH, T0)).toEqual({ state: 'superseded' });
  });
});
