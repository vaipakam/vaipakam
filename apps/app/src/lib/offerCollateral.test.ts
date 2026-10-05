/** #2378 r1 — the Offer Book names what an offer's collateral is, never
 *  just a contract address. */
import { describe, expect, it } from 'vitest';
import { offerCollateralText } from './offerCollateral';

const asset = '0x00000000000000000000000000000000000000ab';
const labels = {
  amountLoading: (t: string) => `${t} (amount loading…)`,
  amountRaw: (a: string, t: string) => `${a} base units of ${t} (token details couldn’t be read)`,
  atLeast: (a: string) => `at least ${a}`,
  forFullOffer: (a: string) => `${a} for the full offer (proportionally less for part of it)`,
  range: (c: string, f: string) => `${c} committed (floor ${f})`,
  rangeRemaining: (r: string, u: string) => `${r} still committed (${u} consumed)`,
  remainingBelowFloor: (r: string, u: string, f: string) => `${r} still committed (${u} consumed) — below the ${f} floor`,
  single: (a: string) => `${a} committed`,
};
const base = { asset, amount: '0', tokenId: '0', quantity: '0', meta: undefined, metaFailed: false, labels };

describe('offerCollateralText', () => {
  it('names an ERC-721 by token id', () => {
    expect(offerCollateralText({ ...base, assetType: 1, tokenId: '7' })).toMatch(/^NFT .+ #7$/);
  });
  it('names an ERC-1155 by token id and quantity', () => {
    expect(offerCollateralText({ ...base, assetType: 2, tokenId: '7', quantity: '3' })).toMatch(/^3 × NFT .+ #7$/);
    expect(offerCollateralText({ ...base, assetType: 2, tokenId: '7', quantity: '1' })).toMatch(/^NFT .+ #7$/);
  });
  it('states an ERC-20 amount when its details loaded', () => {
    expect(
      offerCollateralText({ ...base, assetType: 0, amount: '150000000000000000000', meta: { decimals: 18, symbol: 'tLIQ' } }),
    ).toBe('150 tLIQ');
  });
  it('states a borrower offer floor as "at least" (#2378 r2)', () => {
    expect(
      offerCollateralText({
        ...base,
        assetType: 0,
        amount: '150000000000000000000',
        meta: { decimals: 18, symbol: 'tLIQ' },
        floorOnly: true,
      }),
    ).toBe('at least 150 tLIQ');
  });
  describe('#2382 — a borrow request\'s committed range', () => {
    const meta = { decimals: 18, symbol: 'tLIQ' };
    const e = (n: number) => `${n}000000000000000000`;
    const req = { ...base, assetType: 0, amount: e(150), meta, floorOnly: true };
    it('states the WHOLE ceiling as committed, and the floor as the request’s term (#2382 r4)', () => {
      // An unfilled ranged request holds its entire ceiling, so that is the
      // commitment — not a range the reader could take for it.
      expect(offerCollateralText({ ...req, borrowerRange: { ceiling: e(400), filled: '0' } })).toBe(
        '400 tLIQ committed (floor 150 tLIQ)',
      );
    });
    it('states a single-value request by what it commits, through its own label (#2382 r1/r4)', () => {
      expect(offerCollateralText({ ...req, borrowerRange: { ceiling: e(150), filled: '0' } })).toBe(
        '150 tLIQ committed',
      );
    });
    it('states EXACTLY what is still committed after earlier fills — never a range (#2382 r2)', () => {
      expect(offerCollateralText({ ...req, borrowerRange: { ceiling: e(400), filled: e(100) } })).toBe(
        '300 tLIQ still committed (100 tLIQ consumed)',
      );
    });
    it('says a remainder below the floor can be used by no fill (#2382 r2)', () => {
      // 400 − 300 = 100 left, below the 150 every fill of this range locks.
      expect(offerCollateralText({ ...req, borrowerRange: { ceiling: e(400), filled: e(300) } })).toBe(
        '100 tLIQ still committed (300 tLIQ consumed) — below the 150 tLIQ floor',
      );
      // Exactly the floor left is still usable.
      expect(offerCollateralText({ ...req, borrowerRange: { ceiling: e(400), filled: e(250) } })).toBe(
        '150 tLIQ still committed (250 tLIQ consumed)',
      );
    });
    it('keeps "at least" while the ceiling or fills are unread — never assumes', () => {
      for (const r of [{ ceiling: null, filled: null }, { ceiling: e(400), filled: null }, { ceiling: null, filled: '0' }]) {
        expect(offerCollateralText({ ...req, borrowerRange: r })).toBe('at least 150 tLIQ');
      }
    });
    it('keeps the floor wording when token details failed', () => {
      expect(
        offerCollateralText({ ...req, meta: undefined, metaFailed: true, borrowerRange: { ceiling: e(400), filled: '0' } }),
      ).toMatch(/^at least .+ base units of/);
    });
  });
  it('says an ERC-20 amount is loading — never a bare address', () => {
    expect(offerCollateralText({ ...base, assetType: 0, amount: '5' })).toContain('amount loading');
  });
  it('keeps the recorded amount, in raw base units, when token details fail (#2378 r8)', () => {
    const failed = offerCollateralText({ ...base, assetType: 0, amount: '5000', metaFailed: true });
    expect(failed).toMatch(/^5000 base units of .+ \(token details couldn’t be read\)$/);
  });
  it('states a part-takeable lender offer as the full-offer requirement (#2378 r8)', () => {
    const meta = { decimals: 18, symbol: 'tLIQ' };
    const amount = '150000000000000000000';
    expect(offerCollateralText({ ...base, assetType: 0, amount, meta, scalesWithAmount: true })).toBe(
      '150 tLIQ for the full offer (proportionally less for part of it)',
    );
    // An offer that can only be taken whole states the figure as exact.
    expect(offerCollateralText({ ...base, assetType: 0, amount, meta, scalesWithAmount: false })).toBe('150 tLIQ');
  });
});
