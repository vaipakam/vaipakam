/**
 * `decideForcedClose` — and above all the two orderings that are easy
 * to write the wrong way round and impossible to notice by looking.
 *
 * The suite is deliberately heavy on the NEGATIVE cases. A readiness
 * resolver is trivial to write so that it passes every test while being
 * wrong in production, because the happy path (`everything read, loan
 * overdue, collateral illiquid`) is the one case that survives almost
 * any ordering. So each ordering rule below is tested by the input that
 * DISTINGUISHES it — the one where the wrong order returns a plausible
 * answer rather than an obviously broken one.
 */
import { describe, expect, it } from 'vitest';
import {
  canSubmitFromApp,
  decideForcedClose,
  shouldRenderForcedClose,
  type ForcedCloseInput,
} from './forcedClose';

/** An overdue loan with liquid, non-collapsed ERC-20 collateral and
 *  every read answered — the base the cases below perturb one field at
 *  a time. */
const base: ForcedCloseInput = {
  active: true,
  defaultable: true,
  sequencerHealthy: true,
  paused: false,
  consentFromBoth: true,
  internalMatchCandidate: false,
  assetType: 'erc20',
  collateralIsNft: false,
  collateralIlliquid: false,
  ltvCollapsed: false,
};

describe('decideForcedClose — execution path', () => {
  it('routes liquid, non-collapsed ERC-20 collateral to the swap path', () => {
    expect(decideForcedClose(base)).toBe('ready-needs-route');
  });

  it('routes illiquid collateral to the in-kind path', () => {
    expect(decideForcedClose({ ...base, collateralIlliquid: true })).toBe('ready-in-kind');
  });

  it('routes a >110% LTV collapse to the in-kind path', () => {
    expect(decideForcedClose({ ...base, ltvCollapsed: true })).toBe('ready-in-kind');
  });

  it('routes an NFT rental to its OWN state, without a liquidity read', () => {
    // A rental never swaps, so the resolver must not stall on
    // `collateralIlliquid` — passing `undefined` here is the point of
    // the case, not an oversight.
    expect(
      decideForcedClose({
        ...base,
        assetType: 'rental',
        collateralIsNft: undefined,
        collateralIlliquid: undefined,
        ltvCollapsed: undefined,
        // A rental never enters the consent-gated illiquid branch, so
        // an unread consent flag must not stall it either.
        consentFromBoth: undefined,
      }),
    ).toBe('ready-rental');
  });

  it('routes NFT collateral on an ERC-20 loan to the in-kind path', () => {
    // Round 28 P1. This is the shape that stalled forever: not a
    // rental, so `assetType` stays `erc20`, but the liquidity read is
    // an ERC-20 question that is never issued for an NFT — so
    // `collateralIlliquid` is `undefined` PERMANENTLY, not briefly.
    // Passing it undefined here is what makes the case meaningful.
    expect(
      decideForcedClose({
        ...base,
        collateralIsNft: true,
        collateralIlliquid: undefined,
        ltvCollapsed: undefined,
      }),
    ).toBe('ready-in-kind');
  });
});

describe('decideForcedClose — gates the contract applies before routing', () => {
  it('reports a paused protocol ahead of every other answer', () => {
    // `whenNotPaused` is the first modifier on `triggerDefault`, so no
    // downstream read can make the call succeed. Every other field
    // here says "ready", which is what makes this distinguishing.
    expect(decideForcedClose({ ...base, paused: true, collateralIlliquid: true })).toBe(
      'blocked-paused',
    );
  });

  it('does not guess at an unread pause flag', () => {
    expect(decideForcedClose({ ...base, paused: undefined })).toBe('unknown');
  });

  it('blocks the illiquid in-kind route when consent was never recorded', () => {
    // The contract's illiquid branch is guarded on
    // `riskAndTermsConsentFromBoth` and falls through to
    // `revert LiquidationFailed()` without it.
    expect(
      decideForcedClose({ ...base, collateralIlliquid: true, consentFromBoth: false }),
    ).toBe('blocked-no-consent');
  });

  it('does NOT apply the consent gate to an LTV collapse', () => {
    // The distinguishing case: same missing consent, different arm of
    // the contract's condition. The collapse route stands on the
    // collapse alone, so withholding it here would refuse a close-out
    // that would in fact succeed.
    expect(
      decideForcedClose({ ...base, ltvCollapsed: true, consentFromBoth: false }),
    ).toBe('ready-in-kind');
  });

  it('does not guess at an unread consent flag on the in-kind route', () => {
    expect(
      decideForcedClose({
        ...base,
        collateralIlliquid: true,
        consentFromBoth: undefined,
      }),
    ).toBe('unknown');
  });

  it('never blocks a swap-route loan on consent it does not need', () => {
    expect(decideForcedClose({ ...base, consentFromBoth: false })).toBe(
      'ready-needs-route',
    );
  });
});

describe('decideForcedClose — the internal-match dispatch', () => {
  it('offers a liquid, non-collapsed loan with a match candidate', () => {
    // Round 31 P2. `triggerDefault` runs
    // `attemptInternalMatchAutoDispatch` BEFORE the DEX branch and
    // returns on success, so the empty try-list never reaches
    // `NoEnabledSwapRoute` — the app CAN close this. `base` is exactly
    // the shape that otherwise resolves `ready-needs-route`, which is
    // what makes this case distinguishing.
    expect(decideForcedClose({ ...base, internalMatchCandidate: true })).toBe(
      'ready-internal-match',
    );
  });

  it('falls back to needs-route when the probe is unread or failed', () => {
    // Deliberately NOT `unknown`. That is the conservative answer — no
    // button is offered — and it keeps the explanation this state
    // exists to give, rather than replacing it with "still checking" on
    // a loan whose route genuinely cannot be built in this app.
    expect(
      decideForcedClose({ ...base, internalMatchCandidate: undefined }),
    ).toBe('ready-needs-route');
  });

  it('does not let a match candidate override an earlier gate', () => {
    // The dispatch happens inside `triggerDefault`, well after the
    // modifiers and the sequencer check — so a candidate must not
    // resurrect a call the chain refuses before it ever routes.
    for (const gate of [
      { paused: true } as const,
      { sequencerHealthy: false } as const,
      { defaultable: false } as const,
    ]) {
      expect(
        decideForcedClose({ ...base, ...gate, internalMatchCandidate: true }),
      ).not.toBe('ready-internal-match');
    }
  });

  it('puts the match AHEAD of every collateral classification', () => {
    // THIS CASE ASSERTED THE OPPOSITE AND WAS WRONG (round 34 P2).
    //
    // I reasoned that an illiquid loan "reaches the in-kind branch and
    // the match probe is irrelevant to it". The contract says
    // otherwise: `attemptInternalMatchAutoDispatch` is called at
    // DefaultedFacet.sol:287 and returns on success — before the
    // liquidity read at 312, the ERC-20 branch at 319 and the collapse
    // calculation at 339 — and `hasInternalMatchCandidate` does not
    // exclude an illiquid or collapsed subject. So a matchable loan
    // settles as a match whatever its collateral looks like, and the
    // in-kind copy would have promised the wrong asset.
    //
    // Kept as one case over both shapes because the defect was the
    // ORDER, not either branch.
    for (const shape of [
      { collateralIlliquid: true } as const,
      { ltvCollapsed: true } as const,
      { collateralIsNft: true, collateralIlliquid: undefined } as const,
    ]) {
      expect(
        decideForcedClose({ ...base, ...shape, internalMatchCandidate: true }),
      ).toBe('ready-internal-match');
    }
  });

  it('leaves each collateral route intact when there is no candidate', () => {
    // The other half: reordering must not swallow the routes it now
    // sits in front of.
    expect(decideForcedClose({ ...base, collateralIlliquid: true })).toBe(
      'ready-in-kind',
    );
    expect(decideForcedClose({ ...base, ltvCollapsed: true })).toBe(
      'ready-in-kind',
    );
    expect(decideForcedClose({ ...base, assetType: 'rental' })).toBe(
      'ready-rental',
    );
  });
});

describe('decideForcedClose — the sequencer ordering trap', () => {
  it('reports blocked-sequencer for LIQUID collateral, not ready-in-kind', () => {
    // THE calibration case for this module.
    //
    // `OracleFacet._checkLiquidity` opens with `if (!_sequencerHealthy())
    // return Illiquid`, so while the sequencer is down every asset reads
    // illiquid — including this one, whose collateral is genuinely
    // liquid. A resolver that consulted liquidity before sequencer
    // health would see `collateralIlliquid: true` and answer
    // `ready-in-kind`: a one-click button that `triggerDefault` refuses
    // at its own `SequencerUnhealthy` check, plus an explanation of an
    // in-kind transfer that will never happen — this loan swaps once the
    // sequencer recovers.
    //
    // Note the input mirrors that reality rather than the loan's true
    // nature: `collateralIlliquid: true` is what the chain WOULD return
    // during an outage. If this assertion is ever relaxed to
    // 'ready-in-kind', the ordering has been inverted.
    expect(
      decideForcedClose({
        ...base,
        sequencerHealthy: false,
        collateralIlliquid: true,
      }),
    ).toBe('blocked-sequencer');
  });

  it('blocks on an unhealthy sequencer even when the loan is overdue', () => {
    expect(decideForcedClose({ ...base, sequencerHealthy: false })).toBe('blocked-sequencer');
  });

  it('reports unknown, not ready, while sequencer health is unread', () => {
    expect(decideForcedClose({ ...base, sequencerHealthy: undefined })).toBe('unknown');
  });
});

describe('decideForcedClose — unread reads never become verdicts', () => {
  it('reports unknown rather than not-yet while defaultability is unread', () => {
    // The opposite errors this type exists to keep apart: `not-yet`
    // tells a lender the position is not closable, which for an unread
    // loan may be false and may have been false for weeks.
    expect(decideForcedClose({ ...base, defaultable: undefined })).toBe('unknown');
  });

  it('reports not-yet when the CHAIN says the loan is still in grace', () => {
    expect(decideForcedClose({ ...base, defaultable: false })).toBe('not-yet');
  });

  it('reports unknown while the asset type is unread', () => {
    expect(decideForcedClose({ ...base, assetType: undefined })).toBe('unknown');
  });

  it('reports unknown while the liquidity read is outstanding', () => {
    expect(decideForcedClose({ ...base, collateralIlliquid: undefined })).toBe('unknown');
  });

  it('reports unknown while the LTV read is outstanding', () => {
    expect(decideForcedClose({ ...base, ltvCollapsed: undefined })).toBe('unknown');
  });

  it('does not let an unread LTV downgrade an illiquid loan', () => {
    // `calculateLTV` reverts `IlliquidLoanNoRiskMath` on illiquid
    // collateral, so that read legitimately never answers for these
    // loans. Stalling on it would make every illiquid position — the
    // ones where a one-click close genuinely works — permanently
    // unknown.
    expect(
      decideForcedClose({ ...base, collateralIlliquid: true, ltvCollapsed: undefined }),
    ).toBe('ready-in-kind');
  });
});

describe('decideForcedClose — terminal loans', () => {
  it('is not-applicable once the loan leaves Active', () => {
    expect(decideForcedClose({ ...base, active: false })).toBe('not-applicable');
  });

  it('stays not-applicable even when every other read says ready', () => {
    // Ordering check: status is judged before anything else, so a
    // repaid loan cannot surface a close-out button on the strength of
    // stale liquidity data.
    expect(
      decideForcedClose({ ...base, active: false, collateralIlliquid: true }),
    ).toBe('not-applicable');
  });
});

describe('canSubmitFromApp', () => {
  it('permits only the in-kind path', () => {
    expect(canSubmitFromApp('ready-in-kind')).toBe(true);
  });

  it('refuses the swap path, which the app cannot build a try-list for', () => {
    // `ready-needs-route` is genuinely eligible on-chain — this is not
    // "not ready yet". The app simply cannot produce the
    // `AdapterCall[]` the contract requires, and an empty array reverts
    // `NoEnabledSwapRoute`. A submit button here would be a paid revert.
    expect(canSubmitFromApp('ready-needs-route')).toBe(false);
  });

  it('accepts the internal-match route too', () => {
    // Not an in-kind close — the lender is repaid in the lent asset —
    // but it shares the property that decides this predicate: the
    // empty try-list succeeds.
    expect(canSubmitFromApp('ready-internal-match')).toBe(true);
  });

  it('accepts the rental route', () => {
    expect(canSubmitFromApp('ready-rental')).toBe(true);
  });

  it('refuses every non-ready state', () => {
    for (const s of [
      'not-yet',
      'blocked-sequencer',
      'blocked-paused',
      'blocked-no-consent',
      'unknown',
      'not-applicable',
    ] as const) {
      expect(canSubmitFromApp(s)).toBe(false);
    }
  });
});

describe('shouldRenderForcedClose', () => {
  it('shows the card for states that cannot be acted on yet', () => {
    // Hiding the card until it happens to be actionable is how this
    // whole capability stayed invisible: a lender cannot ask for a
    // route they have never been shown.
    for (const s of [
      'ready-in-kind',
      'ready-needs-route',
      'ready-internal-match',
      'ready-rental',
      'not-yet',
      'blocked-sequencer',
      'blocked-paused',
      'blocked-no-consent',
      'unknown',
    ] as const) {
      expect(shouldRenderForcedClose(s)).toBe(true);
    }
  });

  it('hides it only for a loan that is no longer Active', () => {
    expect(shouldRenderForcedClose('not-applicable')).toBe(false);
  });
});
