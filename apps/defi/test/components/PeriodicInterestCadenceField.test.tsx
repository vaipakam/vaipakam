import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { PeriodicInterestCadenceField } from '../../src/components/createOffer/PeriodicInterestCadenceField';

/*
 * The i18n mock CALLS A REAL HOOK, unlike the plain-function mocks used
 * elsewhere in this suite. That is load-bearing, not decoration.
 *
 * React tolerates a render that calls ZERO hooks: going 2 hooks → 0 and
 * back raises nothing. It only throws when a non-zero count changes —
 * 2 → 1 gives "Rendered fewer hooks than expected", 1 → 2 gives
 * "Rendered more hooks than during the previous render".
 *
 * That is an OBSERVED property of react 19.2.6 (probed directly before
 * these tests were written), not a documented guarantee. If a React
 * upgrade ever makes the zero-hook case throw too, the mock below stops
 * being necessary — but it also does no harm, so the safe reading is
 * that this comment may go stale while the test stays correct. What
 * must not change is that the mock keeps calling a real hook.
 *
 * In production `useTranslation()` runs above the gate and is a real
 * hook, so the buggy component went from "i18n hooks + 2 memos" to
 * "i18n hooks" — a non-zero change, and a genuine crash. Mock it as a
 * plain function and that becomes 2 → 0, which React accepts happily:
 * the test then passes against the very bug it exists to catch.
 *
 * That is not hypothetical. The first version of this file mocked i18n
 * the usual way, and it passed cleanly against the reinstated pre-fix
 * component. Keep a real hook here, or this suite is theatre.
 */
vi.mock('react-i18next', async () => {
  const { useRef } = await import('react');
  return {
    useTranslation: () => {
      useRef(null); // stands in for the real hook's slot in the sequence
      return {
        t: (key: string) => key,
        i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => Promise.resolve() },
      };
    },
  };
});

/**
 * Regression cover for #1521 — the Create Offer hook-order crash.
 *
 * The component hides itself for illiquid offers. It used to do that
 * with an early `return null` placed ABOVE two `useMemo` calls. Because
 * liquidity is derived from props fed by live form state, changing the
 * asset-type dropdown flipped that condition on an ALREADY-MOUNTED
 * instance: the render that returned early called two fewer hooks than
 * the one before it, and React aborts the whole tree rather than
 * reconcile a changed hook count.
 *
 * `rerender` is load-bearing here. It updates props on the same mounted
 * instance, which is what the dropdown does. Mounting two separate
 * components with different props would pass even against the buggy
 * code, because each fresh mount establishes its own hook baseline —
 * so a test written that way would look like cover while proving
 * nothing.
 *
 * Both directions are asserted: dropping hooks raises "Rendered fewer
 * hooks than expected", adding them back raises "Rendered more hooks
 * than during the previous render". Either aborts the page.
 */

/** Both legs ERC20 (0) and Liquid (0) — the control is visible. */
const LIQUID = {
  principalLiquidity: 0 as const,
  collateralLiquidity: 0 as const,
  principalAssetType: 0 as const,
  collateralAssetType: 0 as const,
};

/** Collateral switched to an NFT — Filter 0, the control renders nothing. */
const ILLIQUID = { ...LIQUID, collateralAssetType: 1 as const };

const BASE = {
  value: 0,
  onChange: () => {},
  durationDays: 90,
  periodicInterestEnabled: true,
  threshold1e18: 1_000n * 10n ** 18n,
};

describe('PeriodicInterestCadenceField — hook order across prop changes (#1521)', () => {
  it('survives liquid → illiquid on a mounted instance', () => {
    const { container, rerender } = render(
      <PeriodicInterestCadenceField {...BASE} {...LIQUID} />,
    );
    expect(container.querySelector('select')).not.toBeNull();

    // The transition that crashed: two `useMemo`s disappear if the
    // gate sits above them.
    expect(() =>
      rerender(<PeriodicInterestCadenceField {...BASE} {...ILLIQUID} />),
    ).not.toThrow();

    // And it genuinely hides rather than merely surviving.
    expect(container.querySelector('select')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('survives illiquid → liquid on a mounted instance', () => {
    const { container, rerender } = render(
      <PeriodicInterestCadenceField {...BASE} {...ILLIQUID} />,
    );
    expect(container).toBeEmptyDOMElement();

    expect(() =>
      rerender(<PeriodicInterestCadenceField {...BASE} {...LIQUID} />),
    ).not.toThrow();

    expect(container.querySelector('select')).not.toBeNull();
  });

  it('survives the kill-switch flipping on a mounted instance', () => {
    // The master switch is the other gate below the hooks, and it is
    // read from live config rather than being constant for a mount.
    const { container, rerender } = render(
      <PeriodicInterestCadenceField {...BASE} {...LIQUID} periodicInterestEnabled />,
    );
    expect(container.querySelector('select')).not.toBeNull();

    expect(() =>
      rerender(
        <PeriodicInterestCadenceField
          {...BASE}
          {...LIQUID}
          periodicInterestEnabled={false}
        />,
      ),
    ).not.toThrow();

    expect(container).toBeEmptyDOMElement();
  });

  it('survives repeated toggling', () => {
    const { rerender } = render(<PeriodicInterestCadenceField {...BASE} {...LIQUID} />);
    expect(() => {
      for (let i = 0; i < 5; i++) {
        rerender(<PeriodicInterestCadenceField {...BASE} {...ILLIQUID} />);
        rerender(<PeriodicInterestCadenceField {...BASE} {...LIQUID} />);
      }
    }).not.toThrow();
  });
});
