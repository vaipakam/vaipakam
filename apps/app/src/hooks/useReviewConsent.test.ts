// @vitest-environment jsdom
/**
 * The review-consent rule (#1696), driven through React so the property
 * that matters is checked where it lives: no COMMITTED render ever pairs a
 * changed review with a tick given against the old one.
 */
import { act, useLayoutEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook } from '../test/renderHook';
import { consentFingerprint, useReviewConsent, type ReviewConsent } from './useReviewConsent';

/** Every committed (fingerprint, consent) pair, in order. */
function mount(initial: string) {
  const commits: Array<{ fingerprint: string; given: boolean }> = [];
  return renderHook(
    ({ fingerprint }: { fingerprint: string }) => {
      const consent = useReviewConsent([fingerprint]);
      useLayoutEffect(() => {
        commits.push({ fingerprint, given: consent.given });
      });
      return consent;
    },
    { initialProps: { fingerprint: initial } },
  ).then((hook) => ({ hook, commits }));
}

const tick = (c: { current: ReviewConsent }, checked = true) =>
  act(async () => c.current.set(checked));

describe('useReviewConsent', () => {
  it('starts unticked and takes the user’s tick', async () => {
    const { hook } = await mount('A');
    expect(hook.result.current.given).toBe(false);
    await tick(hook.result);
    expect(hook.result.current.given).toBe(true);
    await tick(hook.result, false);
    expect(hook.result.current.given).toBe(false);
  });

  it('clears in the SAME commit the reviewed values change', async () => {
    const { hook, commits } = await mount('A');
    await tick(hook.result);
    await hook.rerender({ fingerprint: 'B' });
    expect(hook.result.current.given).toBe(false);
    // No commit ever paired B with a tick.
    expect(commits.filter((c) => c.fingerprint === 'B' && c.given)).toEqual([]);
    expect(commits.at(-1)).toEqual({ fingerprint: 'B', given: false });
  });

  it('says why when it withdrew a tick, until the user ticks again', async () => {
    const { hook } = await mount('A');
    await hook.rerender({ fingerprint: 'B' });
    // Nothing was ticked, so nothing was withdrawn.
    expect(hook.result.current.withdrawnByChange).toBe(false);
    await tick(hook.result);
    await hook.rerender({ fingerprint: 'C' });
    expect(hook.result.current.withdrawnByChange).toBe(true);
    // A further change keeps the explanation up.
    await hook.rerender({ fingerprint: 'D' });
    expect(hook.result.current.withdrawnByChange).toBe(true);
    await tick(hook.result);
    expect(hook.result.current).toMatchObject({ given: true, withdrawnByChange: false });
  });

  it('does not restore consent when the review returns to what was ticked', async () => {
    const { hook } = await mount('A');
    await tick(hook.result);
    await hook.rerender({ fingerprint: 'B' });
    await hook.rerender({ fingerprint: 'A' });
    expect(hook.result.current.given).toBe(false);
  });

  it('keeps a tick across renders that change nothing reviewed', async () => {
    const { hook } = await mount('A');
    await tick(hook.result);
    await hook.rerender({ fingerprint: 'A' });
    expect(hook.result.current.given).toBe(true);
  });

  it('clear() withdraws consent without reading as a change', async () => {
    const { hook } = await mount('A');
    await tick(hook.result);
    await act(async () => hook.result.current.clear());
    expect(hook.result.current).toMatchObject({ given: false, withdrawnByChange: false });
  });
});

describe('consentFingerprint', () => {
  it('tells apart values that print alike', () => {
    expect(consentFingerprint(1n)).not.toBe(consentFingerprint('1'));
    expect(consentFingerprint(1n)).not.toBe(consentFingerprint(1));
    expect(consentFingerprint(undefined)).not.toBe(consentFingerprint(null));
    expect(consentFingerprint('a|b', 'c')).not.toBe(consentFingerprint('a', 'b|c'));
  });
  it('is stable for equal values', () => {
    expect(consentFingerprint(10n ** 18n, { a: [1, 'x'] }, false)).toBe(
      consentFingerprint(10n ** 18n, { a: [1, 'x'] }, false),
    );
  });
});
