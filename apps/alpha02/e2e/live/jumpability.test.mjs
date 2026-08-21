import { describe, expect, it } from 'vitest';

import {
  excursionExplains,
  jumpabilityMoved,
  missingSwitchVerdict,
  snapshotCardEligible,
  snapshotJumpable,
} from './jumpability.mjs';

/**
 * Why this file exists, stated plainly because it is the finding:
 *
 * `jumpabilityMoved` went through FOUR review rounds — r8 added it, r9
 * corrected which question it asks, r11 widened its inputs, r12 made it
 * a before/after comparison — and in none of them was it ever executed.
 * The live chain carries no jumpable lender row, so the drive never
 * reaches the branch that calls it. Every "re-ran live, 3/3 clean" this
 * driver reported was true and irrelevant: the verification being cited
 * did not exercise the code being changed.
 *
 * The first run of this file found the function was `async` and its one
 * call site was missing an `await`, which had made the FAIL branch
 * beneath it unreachable since r8. Four rounds of careful reasoning
 * about a branch that could not fire.
 */

/** A healthy, jumpable position: Active, pre-maturity, unlocked, unflagged. */
const OK = Object.freeze({
  active: true,
  matured: false,
  locked: false,
  holder: '0xaa',
  flagged: false,
});

describe('a race the probe must ABSORB — the chain moved under it', () => {
  // Each of these is a real state change between the pre-click snapshot
  // and the post-settle re-read. `buildLenderExitRows` ranks the new
  // unavailability reason above the loading sentence, so the card
  // correctly renders zero jumps — reporting that as a product FAIL
  // would be blaming the app for reacting properly.
  for (const [name, after, reason] of [
    ['loan leaves Active', { active: false }, 'loan left Active during the probe'],
    ['loan crosses maturity', { matured: true }, 'loan reached maturity during the probe'],
    ['position is locked', { locked: true }, 'position became locked during the probe'],
    ['position changes hands', { holder: '0xbb' }, 'position transferred during the probe'],
    ['lender token is burned', { holder: null }, 'lender token burned during the probe'],
    ['holder is flagged', { flagged: true }, 'holder sanctions-flagged during the probe'],
  ]) {
    it(`reports a reason when the ${name}`, () => {
      expect(jumpabilityMoved(OK, { ...OK, ...after })).toBe(reason);
    });
  }

  it('distinguishes a burn from a transfer, because they are not the same event', () => {
    expect(jumpabilityMoved(OK, { ...OK, holder: null })).toContain('burned');
    expect(jumpabilityMoved(OK, { ...OK, holder: '0xbb' })).toContain('transferred');
  });
});

describe('a PRE-EXISTING condition is not a race — this is the r12 bug', () => {
  // The load-bearing half. Before r12 this function read only the state
  // AFTER the click, so a position that was already un-jumpable when
  // the page first rendered got reported as having changed. That
  // direction is the dangerous one: a Basic-mode regression that
  // wrongly offered the switch on such a position would be excused as a
  // race rather than failed on.
  for (const [name, state] of [
    ['already not Active', { active: false }],
    ['already past maturity', { matured: true }],
    ['already locked', { locked: true }],
    ['already flagged', { flagged: true }],
    ['already burned', { holder: null }],
  ]) {
    it(`sees no movement when the position was ${name} the whole time`, () => {
      const s = { ...OK, ...state };
      expect(jumpabilityMoved(s, { ...s })).toBeNull();
    });
  }

  it('sees no movement on an entirely unchanged healthy position', () => {
    expect(jumpabilityMoved(OK, { ...OK })).toBeNull();
  });

  // A condition that CLEARS mid-probe is not a race either, and must
  // not be read as one by an unguarded `!==` on the boolean.
  it('sees no movement when a lock is released during the probe', () => {
    expect(jumpabilityMoved({ ...OK, locked: true }, OK)).toBeNull();
  });
});

describe('a missing snapshot yields no verdict, never a false one', () => {
  // `jumpabilitySnapshot` runs through `discovery()`, so a failed chain
  // read arrives here as null. "We could not look" must fall through to
  // the no-op-switch FAIL, which is the honest report — inventing a
  // race would silently excuse a real contradiction.
  it('returns null when the pre-state is missing', () => {
    expect(jumpabilityMoved(null, OK)).toBeNull();
  });

  it('returns null when the post-state is missing', () => {
    expect(jumpabilityMoved(OK, null)).toBeNull();
  });

  it('returns null when both are missing', () => {
    expect(jumpabilityMoved(null, null)).toBeNull();
  });
});

describe('ordering is deliberate when several inputs move at once', () => {
  // Status first: it is the most decisive and the most legible reason,
  // and a loan that left Active has usually dragged the others with it.
  it('names the status change ahead of maturity and lock', () => {
    const after = { ...OK, active: false, matured: true, locked: true };
    expect(jumpabilityMoved(OK, after)).toBe('loan left Active during the probe');
  });

  it('names maturity ahead of a lock taken in the same interval', () => {
    const after = { ...OK, matured: true, locked: true };
    expect(jumpabilityMoved(OK, after)).toBe('loan reached maturity during the probe');
  });
});

describe('the function is not a Promise', () => {
  /**
   * The regression this extraction exists to prevent. Declared `async`
   * while awaiting nothing, its call site dropped the `await` and every
   * caller got a truthy Promise — which reads as "a race happened" at
   * every single call, making the FAIL branch dead code. A synchronous
   * function cannot be mis-awaited, and this pins that.
   */
  it('returns a value directly, not a thenable', () => {
    const out = jumpabilityMoved(OK, { ...OK, active: false });
    expect(out).not.toBeInstanceOf(Promise);
    expect(typeof out).toBe('string');
  });

  it('returns a real null rather than a Promise resolving to null', () => {
    const out = jumpabilityMoved(OK, { ...OK });
    expect(out).not.toBeInstanceOf(Promise);
    expect(out).toBeNull();
  });
});

describe('snapshotJumpable — could a sale row have been offered on this state?', () => {
  it('says yes for a healthy in-term position', () => {
    expect(snapshotJumpable(OK)).toBe(true);
  });

  // Each of the five is independently disqualifying, because each one
  // independently closes both sale entry points.
  for (const [name, state] of [
    ['not Active', { active: false }],
    ['past maturity', { matured: true }],
    ['locked', { locked: true }],
    ['burned', { holder: null }],
    ['sanctions-flagged', { flagged: true }],
  ]) {
    it(`says no when the position is ${name}`, () => {
      expect(snapshotJumpable({ ...OK, ...state })).toBe(false);
    });
  }

  it('returns null rather than false when there is no snapshot', () => {
    // Load-bearing: the caller conditions the FAIL on `=== false`, so a
    // failed chain read must not read as "was already unjumpable" and
    // silently convert a genuine no-op-switch regression into BLOCKED.
    expect(snapshotJumpable(null)).toBeNull();
    expect(snapshotJumpable(undefined)).toBeNull();
  });

  it('is a different question from jumpabilityMoved, on the same inputs', () => {
    // An already-locked position never moved — and was never jumpable.
    // Both answers are needed: the first says the card is not to blame
    // for a race, the second says it is not to blame for a stale render.
    const locked = { ...OK, locked: true };
    expect(jumpabilityMoved(locked, { ...locked })).toBeNull();
    expect(snapshotJumpable(locked)).toBe(false);
  });
});

const ME = '0xAA';

describe('snapshotJumpable — the holder must be the wallet we are observing', () => {
  // `holder !== null` was the old test and it is the wrong question
  // (r15). The card requires the holder to equal the CONNECTED address
  // and refetches ownership only every 60s, so a transfer to a third
  // party leaves both snapshots holding the same new, non-null address:
  // nothing moved, the token still exists, and the stale card's jumps
  // vanish on the next refetch — reported as a product FAIL.
  it('says no when the position moved to somebody else', () => {
    expect(snapshotJumpable({ ...OK, holder: '0xbb' }, ME)).toBe(false);
  });

  it('says yes when the observed wallet still holds it', () => {
    expect(snapshotJumpable(OK, ME)).toBe(true);
  });

  it('compares case-insensitively, since one side is checksummed', () => {
    expect(snapshotJumpable({ ...OK, holder: '0xaa' }, '0xAa')).toBe(true);
  });

  it('does not invent a mismatch when there is no wallet to compare', () => {
    // Suppressing real findings because the caller had nobody to check
    // against would be the worse direction.
    expect(snapshotJumpable(OK, undefined)).toBe(true);
  });
});

describe('snapshotCardEligible — the LOOSEST of the three questions', () => {
  // Conflating this with jumpability is not a subtle cost. The card
  // stays mounted past maturity, so a strict gate here would suppress
  // the card assertions on every past-due position — which is currently
  // every lender position on the live chain. The drive's headline check
  // would stop checking on exactly the data it runs against.
  it('keeps the card mounted past maturity, where a sale row is gone', () => {
    const matured = { ...OK, matured: true };
    expect(snapshotJumpable(matured, ME)).toBe(false);
    expect(snapshotCardEligible(matured, ME)).toBe(true);
  });

  it('keeps the card mounted on a locked position too', () => {
    expect(snapshotCardEligible({ ...OK, locked: true }, ME)).toBe(true);
  });

  it('keeps the card mounted on a FallbackPending loan', () => {
    // The card exists to EXPLAIN that state, so unmounting it there
    // would lose the explanation exactly when it becomes true.
    const fb = { ...OK, active: false, fallbackPending: true };
    expect(snapshotCardEligible(fb, ME)).toBe(true);
    expect(snapshotJumpable(fb, ME)).toBe(false);
  });

  for (const [name, state] of [
    ['the loan is terminal', { active: false, fallbackPending: false }],
    ['the position was transferred away', { holder: '0xbb' }],
    ['the lender token was burned', { holder: null }],
    ['the holder is sanctions-flagged', { flagged: true }],
  ]) {
    it(`says no when ${name}`, () => {
      expect(snapshotCardEligible({ ...OK, ...state }, ME)).toBe(false);
    });
  }

  it('returns null rather than false with no snapshot', () => {
    // The caller tests `=== false` before suppressing card assertions;
    // a failed chain read must not silently discard real findings.
    expect(snapshotCardEligible(null, ME)).toBeNull();
  });
});

describe('excursionExplains — which results a mid-probe race accounts for', () => {
  const MOVED = 'status left Active';

  it('explains the no-op-switch FAIL', () => {
    // `advancedJumps: 0` — the switch was clicked and revealed nothing.
    // An excursion turns that from a product FAIL into an ambiguity.
    expect(excursionExplains({ advancedJumps: 0 }, MOVED)).toBe(true);
  });

  it('explains a route that never reached a jump count at all', () => {
    // The finding that prompted the extraction (Codex #1853 r27): the
    // switch never appeared, the wait hit its deadline, and this route
    // returned `no jumpable row` — `advancedJumps: null`, unblocked —
    // without ever consulting the excursion it had already recorded.
    expect(excursionExplains({ advancedJumps: null }, MOVED)).toBe(true);
    expect(excursionExplains({}, MOVED)).toBe(true);
  });

  it('leaves a SUCCESSFUL audit alone', () => {
    // Positive jumps are a positive observation. Whatever moved
    // mid-probe demonstrably did not stop the audit, so calling it
    // ambiguous would discard a good result.
    expect(excursionExplains({ advancedJumps: 2 }, MOVED)).toBe(false);
  });

  it('does not overwrite an already-blocked reason', () => {
    // Precedence, and it is the same rule the stale-owner verdict
    // beside it uses: a blocked result already carries a more specific
    // finding, and replacing it with this one loses the better answer.
    expect(
      excursionExplains({ advancedBlocked: true, advancedJumps: null }, MOVED),
    ).toBe(false);
  });

  it('is false when nothing moved', () => {
    expect(excursionExplains({ advancedJumps: 0 }, null)).toBe(false);
    expect(excursionExplains({ advancedJumps: 0 }, undefined)).toBe(false);
    expect(excursionExplains({ advancedJumps: 0 }, '')).toBe(false);
  });

  it('survives a missing result rather than throwing', () => {
    // The wrapper runs this on whatever the probe returned; a driver
    // that crashes here reports nothing at all about the page.
    expect(excursionExplains(undefined, MOVED)).toBe(true);
    expect(excursionExplains(null, null)).toBe(false);
  });
});

describe('missingSwitchVerdict — what a missing switch means', () => {
  it('FAILS the settled-and-jumpable contradiction', () => {
    // The finding (Codex #1853 r28), and the reason #1855 exists: the
    // card says the question has settled and the answer is yes, and
    // there is no switch to act on it. That is a Basic-mode
    // regression the card is reporting about itself, and the drive
    // used to record it as an ordinary unavailable row and exit 0.
    expect(missingSwitchVerdict({ ready: 'ready', jumpable: 'yes' })).toBe('claims-jumpable');
  });

  it('accepts the settled-and-not-jumpable absence', () => {
    // The one case where a missing switch is the honest outcome.
    expect(missingSwitchVerdict({ ready: 'ready', jumpable: 'no' })).toBe('claims-unjumpable');
  });

  it('blocks rather than passes while the card is still deciding', () => {
    // The ambiguity the 45-second deadline could never resolve: a
    // pending card and a genuinely unjumpable one look identical from
    // the DOM, and only one of them is a clean review.
    expect(missingSwitchVerdict({ ready: 'pending', jumpable: 'no' })).toBe('blocked-pending');
    expect(missingSwitchVerdict({ ready: 'pending', jumpable: 'yes' })).toBe('blocked-pending');
  });

  it('blocks when a read the card needs could not answer', () => {
    // Distinct from pending: nothing further is coming, but the
    // missing switch is unexplained rather than correct — so it must
    // not read as a clean negative either.
    expect(missingSwitchVerdict({ ready: 'failed', jumpable: 'no' })).toBe('blocked-failed');
  });

  it('says nothing about a bundle that publishes no attributes', () => {
    // An older deployed bundle has NEITHER attribute. Reporting that
    // as a product defect would fail the drive on its own deployment
    // lag, so the caller keeps its pre-#1855 verdict. Silence only —
    // a card that says half the contract is the case below.
    expect(missingSwitchVerdict(null)).toBe('unknown');
    expect(missingSwitchVerdict({ ready: null, jumpable: null })).toBe('unknown');
    expect(missingSwitchVerdict({})).toBe('unknown');
  });

  it('blocks a PARTIAL contract rather than treating it as silence', () => {
    // Round 29 tightened the `jumpable` side and left this one loose
    // (Codex #1853 r30): one attribute present, or a misspelt `ready`,
    // fell into the legacy path — wait out the deadline, then accept
    // the missing switch as clean. That is a broken observability
    // contract hiding the regression the attributes exist to expose,
    // which is precisely what the round before had closed on the
    // other half. `unknown` now means silence and nothing else.
    expect(missingSwitchVerdict({ ready: null, jumpable: 'yes' })).toBe('blocked-malformed');
    expect(missingSwitchVerdict({ ready: null, jumpable: 'no' })).toBe('blocked-malformed');
    expect(missingSwitchVerdict({ ready: 'raedy', jumpable: 'yes' })).toBe('blocked-malformed');
    expect(missingSwitchVerdict({ ready: 'something-new', jumpable: 'yes' })).toBe('blocked-malformed');
  });

  it('blocks a card that publishes readiness and botches jumpable', () => {
    // The distinction from `unknown` above (Codex #1853 r29). Nothing
    // published is a deployment gap; a `ready` with no recognised
    // second attribute is the contract itself broken, and the first
    // version handed that the clean `claims-unjumpable` — so a regression in the
    // observability hook would have ended the review with a pass.
    // Only an explicit `no` buys the clean answer.
    expect(missingSwitchVerdict({ ready: 'ready', jumpable: null })).toBe('blocked-malformed');
    expect(missingSwitchVerdict({ ready: 'ready', jumpable: '' })).toBe('blocked-malformed');
    expect(missingSwitchVerdict({ ready: 'ready', jumpable: 'No' })).toBe('blocked-malformed');
    expect(missingSwitchVerdict({ ready: 'ready', jumpable: 'maybe' })).toBe('blocked-malformed');
  });

  it('does not read jumpable without ready', () => {
    // `jumpable` alone is a snapshot of an unsettled computation, so
    // it never earns a verdict on its own — and since round 30 it does
    // not earn the legacy path either: a card publishing one half of
    // the contract is broken, not old.
    expect(missingSwitchVerdict({ ready: null, jumpable: 'yes' })).toBe('blocked-malformed');
  });

  it('never returns an outcome outside its documented set (#1869)', () => {
    // The rename that named these for the CARD'S ANSWER rather than the
    // caller's verdict was mechanical, and a mechanical rename is
    // exactly the change that leaves one string behind. This sweeps the
    // whole input space the attributes can take — including the shapes
    // a broken observability contract would produce — and pins every
    // result against the `@returns` union, so a future outcome added to
    // the code without the doc, or a name changed in one arm only,
    // fails here rather than in a live run six weeks later.
    const OUTCOMES = new Set([
      'claims-jumpable',
      'claims-unjumpable',
      'blocked-pending',
      'blocked-failed',
      'blocked-malformed',
      'unknown',
    ]);
    const READY = [null, undefined, '', 'ready', 'pending', 'failed', 'raedy', 'Ready'];
    const JUMPABLE = [null, undefined, '', 'yes', 'no', 'Yes', 'maybe'];
    const seen = new Set();
    for (const ready of READY) {
      for (const jumpable of JUMPABLE) {
        const got = missingSwitchVerdict({ ready, jumpable });
        expect(OUTCOMES.has(got), `${ready}/${jumpable} → ${got}`).toBe(true);
        seen.add(got);
      }
    }
    expect(missingSwitchVerdict(null)).toBe('unknown');
    // And every documented outcome is REACHABLE — a union member no
    // input can produce is either dead or a typo, and both are worth
    // knowing about.
    expect([...OUTCOMES].filter((o) => !seen.has(o))).toEqual([]);
  });
});
