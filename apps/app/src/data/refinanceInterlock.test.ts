/** #2406 r3 — the one derivation every refinance-touching surface reads:
 *  which request the page names, whether it blocks, and whether the page
 *  knows. */
import { describe, expect, it } from 'vitest';
import type { RefinanceDiscovery } from './refinanceDiscovery';
import {
  liveRefinanceVerdict,
  refinanceInterlock,
  resolveNamedRequest,
} from './refinanceInterlock';

const HOLDER = '0x00000000000000000000000000000000000000Aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const open = (id: string): RefinanceDiscovery => ({ kind: 'found', offerId: id, open: true });
const expired = (id: string): RefinanceDiscovery => ({ kind: 'found', offerId: id, open: false });
const none: RefinanceDiscovery = { kind: 'none' };
const failed: RefinanceDiscovery = { kind: 'unknown', reason: 'failed' };
const capped: RefinanceDiscovery = { kind: 'unknown', reason: 'capped' };

describe('resolveNamedRequest', () => {
  it("names the viewer's own request when they are not the holder (r3: cleanup after a transfer)", () => {
    expect(
      resolveNamedRequest({ holderScan: open('9'), ownScan: expired('4'), markerId: null }),
    ).toEqual({ offerId: '4', fromOwnScan: true });
  });
  it("an open holder request beats this device's marker, which beats an expired one", () => {
    expect(resolveNamedRequest({ holderScan: open('9'), ownScan: undefined, markerId: '7' }).offerId).toBe('9');
    expect(resolveNamedRequest({ holderScan: expired('9'), ownScan: undefined, markerId: '7' }).offerId).toBe('7');
    expect(resolveNamedRequest({ holderScan: expired('9'), ownScan: none, markerId: null })).toEqual({
      offerId: '9',
      fromOwnScan: false,
    });
  });
});

describe('refinanceInterlock — blocking', () => {
  const base = {
    fromOwnScan: false,
    holder: HOLDER as string | 'burned' | undefined,
    holderReadFailed: false,
  };
  const facts = (over: Partial<{ creator: string; expired: boolean; pastGrace: boolean }> = {}) => ({
    creator: HOLDER,
    expired: false,
    pastGrace: false,
    ...over,
  });
  it('an open request by the holder blocks; an EXPIRED one does not (r3)', () => {
    expect(
      refinanceInterlock({ ...base, offerId: '9', state: facts(), holderScan: open('9') }).blocking,
    ).toBe(true);
    expect(
      refinanceInterlock({
        ...base,
        offerId: '9',
        state: facts({ expired: true }),
        holderScan: expired('9'),
      }),
    ).toEqual({ blocking: false, check: 'settled' });
  });
  it('a request whose creator no longer holds the position cannot be filled, so does not block', () => {
    expect(
      refinanceInterlock({ ...base, offerId: '9', state: facts({ creator: OTHER }), holderScan: none })
        .blocking,
    ).toBe(false);
  });
  it('a request still verifying blocks — unless it is the viewer\'s own, on a position they no longer hold', () => {
    expect(
      refinanceInterlock({ ...base, offerId: '9', state: undefined, holderScan: none }).blocking,
    ).toBe(true);
    expect(
      refinanceInterlock({
        ...base,
        fromOwnScan: true,
        offerId: '4',
        state: undefined,
        holderScan: none,
      }).blocking,
    ).toBe(false);
  });
  it("the holder's open request still blocks when the viewer's own request is the one named", () => {
    expect(
      refinanceInterlock({
        ...base,
        fromOwnScan: true,
        offerId: '4',
        state: facts({ creator: OTHER }),
        holderScan: open('9'),
      }).blocking,
    ).toBe(true);
  });
  it('an unknown holder cannot rule the creator out, so a verified request keeps blocking', () => {
    expect(
      refinanceInterlock({
        ...base,
        holder: undefined,
        offerId: '9',
        state: facts({ creator: OTHER }),
        holderScan: undefined,
      }).blocking,
    ).toBe(true);
  });
});

describe('refinanceInterlock — check', () => {
  const base = { fromOwnScan: false, holder: HOLDER, holderReadFailed: false, offerId: null, state: undefined };
  it('is settled only on a resolved scan or a blocking request', () => {
    expect(refinanceInterlock({ ...base, holderScan: none }).check).toBe('settled');
    expect(refinanceInterlock({ ...base, holderScan: expired('4') }).check).toBe('settled');
    expect(
      refinanceInterlock({ ...base, offerId: '9', holderScan: failed }).check,
    ).toBe('settled');
  });
  it('stays unchecked on a failed scan even when a non-blocking (expired) marker exists (r2)', () => {
    expect(
      refinanceInterlock({
        ...base,
        offerId: '7',
        state: { creator: HOLDER, expired: true, pastGrace: false },
        holderScan: failed,
      }).check,
    ).toBe('unchecked');
  });
  it('tells a cap overrun apart from a failed read (r3) — a retry will not help', () => {
    expect(refinanceInterlock({ ...base, holderScan: capped }).check).toBe('capped');
    expect(refinanceInterlock({ ...base, holderScan: failed }).check).toBe('unchecked');
  });
  it('is unchecked when the holder read failed, and checking while loading', () => {
    expect(
      refinanceInterlock({ ...base, holder: undefined, holderReadFailed: true, holderScan: undefined })
        .check,
    ).toBe('unchecked');
    expect(refinanceInterlock({ ...base, holderScan: undefined }).check).toBe('checking');
  });
});

describe('liveRefinanceVerdict', () => {
  it('maps a fresh scan to the pre-send verdict', () => {
    expect(liveRefinanceVerdict(open('1'))).toBe('open');
    expect(liveRefinanceVerdict(expired('1'))).toBe('clear');
    expect(liveRefinanceVerdict(none)).toBe('clear');
    expect(liveRefinanceVerdict(failed)).toBe('unchecked');
    expect(liveRefinanceVerdict(capped)).toBe('capped');
  });
});
