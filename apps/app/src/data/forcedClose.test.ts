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
  assetType: 'erc20',
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

  it('routes an NFT rental to the in-kind path without a liquidity read', () => {
    // A rental never swaps, so the resolver must not stall on
    // `collateralIlliquid` — passing `undefined` here is the point of
    // the case, not an oversight.
    expect(
      decideForcedClose({
        ...base,
        assetType: 'rental',
        collateralIlliquid: undefined,
        ltvCollapsed: undefined,
      }),
    ).toBe('ready-in-kind');
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

  it('refuses every non-ready state', () => {
    for (const s of ['not-yet', 'blocked-sequencer', 'unknown', 'not-applicable'] as const) {
      expect(canSubmitFromApp(s)).toBe(false);
    }
  });
});

describe('shouldRenderForcedClose', () => {
  it('shows the card for states that cannot be acted on yet', () => {
    // Hiding the card until it happens to be actionable is how this
    // whole capability stayed invisible: a lender cannot ask for a
    // route they have never been shown.
    for (const s of ['ready-in-kind', 'ready-needs-route', 'not-yet', 'blocked-sequencer', 'unknown'] as const) {
      expect(shouldRenderForcedClose(s)).toBe(true);
    }
  });

  it('hides it only for a loan that is no longer Active', () => {
    expect(shouldRenderForcedClose('not-applicable')).toBe(false);
  });
});
