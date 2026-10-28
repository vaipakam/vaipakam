/**
 * #2437 — the contract figures section on /analytics.
 *
 * Pins: the block and its age are stated beside the figures; a view that
 * could not be read says so and is never zero; a mirror chain shows its own
 * supply and names where the cap and minter live instead of showing zeros;
 * the held balance appears only when the contract is the treasury, with
 * what it leaves out; every reason a fee figure can understate is stated;
 * amounts truncate and a positive dust amount is labelled, not zeroed; the
 * anchors resolve in every state.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { copy } from '../../content/copy';
import type { OnChainTransparency } from '../../data/onChainTransparency';
import { ChainFiguresView, formatFeeValue, type ChainFiguresState } from './ChainFigures';
import { renderMarkup } from './staticMarkup';

const E18 = 10n ** 18n;
const C = copy.chainFigures;
const TOKEN = '0x00000000000000000000000000000000000000A1' as Address;
const MINTER = '0x00000000000000000000000000000000000000b2' as Address;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Address;
const EXTERNAL = '0x00000000000000000000000000000000000000c3' as Address;
const EXPLORER = 'https://sepolia.basescan.org';
const NOW = 1_800_000_100;

const data = (over: Partial<OnChainTransparency> = {}): OnChainTransparency => ({
  blockNumber: 48_000_000n,
  blockTimestamp: 1_800_000_000,
  vpfi: { kind: 'canonical', token: TOKEN, totalSupply: 40n * E18, cap: 100n * E18, headroom: 60n * E18, minter: MINTER },
  fees: { kind: 'read', total: 1234n * E18 + 567n * 10n ** 15n, last24h: E18, last7d: 7n * E18, held: 50n * E18 },
  treasury: { kind: 'external', address: EXTERNAL },
  numeraire: { symbol: 'USD', isDefault: true },
  ...over,
});

const render = (state: ChainFiguresState) =>
  renderMarkup(createElement(ChainFiguresView, { state, locale: 'en', nowSec: NOW, explorer: EXPLORER }));
const ready = (over: Partial<OnChainTransparency> = {}) => render({ status: 'ready', data: data(over) });

describe('ChainFigures — the reading is stated', () => {
  it('names the block, its age and the views read', () => {
    const r = ready();
    expect(r.textOf('cf-block')).toBe('48,000,000');
    expect(r.textOf('cf-age')).toBe(copy.analytics.ageMinutes(2));
    expect(r.text).toContain('getVPFISnapshot, getTreasuryMetrics, getTreasury, getNumeraireSymbol');
  });

  it('keeps every anchor in every state', () => {
    for (const state of [{ status: 'loading' }, { status: 'unavailable' }] as ChainFiguresState[]) {
      const r = render(state);
      expect(['contract-figures', 'vpfi-token', 'treasury-fees'].every((id) => r.hasId(id))).toBe(true);
    }
    expect(ready().hasId('vpfi-token')).toBe(true);
  });

  it('an unreachable contract shows no figure at all', () => {
    const r = render({ status: 'unavailable' });
    expect(r.text).toContain(C.unreachable);
    expect(r.has('cf-supply') || r.has('cf-fees-total') || r.has('cf-block')).toBe(false);
  });
});

describe('ChainFigures — VPFI token', () => {
  it('on the issuing chain shows supply, cap, what can still be minted, and the minter', () => {
    const r = ready();
    expect(r.textOf('cf-supply')).toBe('40 VPFI');
    expect(r.textOf('cf-cap')).toBe('100 VPFI');
    expect(r.textOf('cf-headroom')).toBe('60 VPFI');
    expect(r.attr('cf-minter', 'href')).toBe(`${EXPLORER}/address/${MINTER}`);
    expect(r.attr('cf-token-address', 'href')).toBe(`${EXPLORER}/address/${TOKEN}`);
    expect(r.text).toContain(C.canonicalNote);
  });

  it('says when no minter is set, rather than linking the zero address', () => {
    const r = ready({ vpfi: { kind: 'canonical', token: TOKEN, totalSupply: 1n, cap: 2n, headroom: 1n, minter: null } });
    expect(r.textOf('cf-minter-none')).toBe(C.noMinter);
    expect(r.has('cf-minter')).toBe(false);
  });

  it('on a bridged chain shows only its own supply and says where the cap and minter live', () => {
    const r = ready({ vpfi: { kind: 'mirror', token: TOKEN, totalSupply: 5n * E18 } });
    expect(r.textOf('cf-supply')).toBe('5 VPFI');
    expect(r.has('cf-cap') || r.has('cf-headroom') || r.has('cf-minter')).toBe(false);
    expect(r.text).toContain(C.mirrorNote);
  });

  it("keeps the chain's 'no token' apart from a failed read", () => {
    expect(ready({ vpfi: { kind: 'unbound' } }).textOf('cf-token-unbound')).toBe(C.unbound);
    const r = ready({ vpfi: { kind: 'unread' } });
    expect(r.textOf('cf-token-unread')).toBe(C.tokenUnread);
    expect(r.has('cf-supply')).toBe(false);
  });

  it('labels a positive dust supply instead of showing 0', () => {
    const r = ready({ vpfi: { kind: 'mirror', token: TOKEN, totalSupply: 1n } });
    expect(r.textOf('cf-supply')).not.toMatch(/^0 VPFI$/);
  });
});

describe('ChainFigures — fees and treasury', () => {
  it('shows the three windows in the reference currency, truncated, with every caveat', () => {
    const r = ready();
    expect(r.textOf('cf-fees-total')).toBe('1,234.56 USD');
    expect(r.textOf('cf-fees-24h')).toBe('1 USD');
    expect(r.textOf('cf-fees-7d')).toBe('7 USD');
    expect(r.text).toContain(C.feesUnit('USD'));
    expect(r.text).toContain(C.feesLowerBound);
  });

  it('with no readable currency shows no unit, and says why', () => {
    const r = ready({ numeraire: null });
    expect(r.textOf('cf-fees-24h')).toBe('1');
    expect(r.text).toContain(C.feesUnitUnknown);
  });

  it('an unread fee view is said, never zeros', () => {
    const r = ready({ fees: { kind: 'unread' } });
    expect(r.textOf('cf-fees-unread')).toBe(C.feesUnread);
    expect(r.has('cf-fees-total') || r.has('cf-held')).toBe(false);
  });

  it('an external treasury is named and linked, with no balance invented for it', () => {
    const r = ready();
    expect(r.attr('cf-treasury-address', 'href')).toBe(`${EXPLORER}/address/${EXTERNAL}`);
    expect(r.has('cf-held')).toBe(false);
    expect(r.text).toContain(C.treasuryExternal);
  });

  it('when the contract is the treasury, shows what it holds and what that leaves out', () => {
    const r = ready({ treasury: { kind: 'diamond', address: DIAMOND } });
    expect(r.textOf('cf-held')).toBe('50 USD');
    expect(r.text).toContain(C.treasuryDiamond);
    expect(r.text).toContain(C.heldNote);
  });

  it('an unset or unread treasury is said as such', () => {
    expect(ready({ treasury: { kind: 'unset' } }).textOf('cf-treasury-unset')).toContain(C.treasuryUnset);
    const r = ready({ treasury: { kind: 'unread' } });
    expect(r.textOf('cf-treasury-unread')).toContain(C.treasuryUnread);
    expect(r.has('cf-held')).toBe(false);
  });
});

describe('formatFeeValue', () => {
  it('truncates to two digits and never shows a positive amount as 0', () => {
    expect(formatFeeValue(0n, 'en')).toBe('0');
    expect(formatFeeValue(E18 + 999n * 10n ** 13n, 'en')).toBe('1');
    expect(formatFeeValue(E18 + 10n ** 16n, 'en')).toBe('1.01');
    expect(formatFeeValue(10n ** 16n - 1n, 'en')).toBe(C.belowPrecision('0.01'));
  });
});
