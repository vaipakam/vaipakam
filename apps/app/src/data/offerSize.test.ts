import { describe, expect, it } from 'vitest';
import { AssetType } from '../lib/types';
import type { AssetPricing } from './offerLtv';
import {
  compareBySizeDesc,
  keepsAtMinSize,
  offerSize,
  offerSizeAmount,
  type OfferSize,
} from './offerSize';

const TOKEN = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';

/** $1 per token, 8-decimal feed, 18-decimal token. */
const dollar: AssetPricing = { kind: 'priced', price: 100_000_000n, feedDecimals: 8, tokenDecimals: 18 };
const pricing = new Map<string, AssetPricing>([
  [TOKEN, dollar],
  [OTHER, { kind: 'illiquid' }],
]);

function offer(over: Partial<Parameters<typeof offerSize>[0]> = {}) {
  return {
    offerType: 0,
    assetType: AssetType.ERC20,
    lendingAsset: TOKEN,
    amount: '1000000000000000000',
    amountMax: '50000000000000000000',
    amountFilled: '0',
    ...over,
  };
}

describe('offerSizeAmount', () => {
  it('sizes a lend offer by what is still on offer', () => {
    expect(offerSizeAmount(offer({ amountFilled: '20000000000000000000' }))).toBe(30n * 10n ** 18n);
  });
  it('sizes a borrow request by the amount it asks for', () => {
    expect(offerSizeAmount(offer({ offerType: 1, amount: '7000000000000000000' }))).toBe(7n * 10n ** 18n);
  });
  it('has no size for an NFT row or a sale vehicle', () => {
    expect(offerSizeAmount(offer({ assetType: AssetType.ERC721 }))).toBeNull();
    expect(offerSizeAmount(offer({ isSaleVehicle: true }))).toBeNull();
  });
});

describe('offerSize', () => {
  it('values a priced row at the oracle price', () => {
    expect(offerSize(offer(), pricing)).toEqual({ kind: 'value', value: 50n * 10n ** 18n });
  });
  it('reads an illiquid or failed price as unpriced, never as small', () => {
    expect(offerSize(offer({ lendingAsset: OTHER }), pricing)).toEqual({ kind: 'unpriced' });
    expect(offerSize(offer(), null)).toEqual({ kind: 'unpriced' });
  });
  it('is loading until the pricing answers', () => {
    expect(offerSize(offer(), undefined)).toEqual({ kind: 'loading' });
  });
});

describe('keepsAtMinSize', () => {
  const v = (n: bigint): OfferSize => ({ kind: 'value', value: n * 10n ** 18n });
  it('hides only a measured size below the minimum', () => {
    expect(keepsAtMinSize(v(9n), 10)).toBe(false);
    expect(keepsAtMinSize(v(10n), 10)).toBe(true);
    expect(keepsAtMinSize(v(0n), 0)).toBe(true);
  });
  it('never hides a row whose size is unknown', () => {
    for (const s of [{ kind: 'unpriced' }, { kind: 'loading' }, { kind: 'none' }] as OfferSize[]) {
      expect(keepsAtMinSize(s, 10_000)).toBe(true);
    }
  });
});

describe('compareBySizeDesc', () => {
  it('ranks sized rows largest first and every unsized row after them, keeping ties', () => {
    const rows: { id: number; size: OfferSize }[] = [
      { id: 1, size: { kind: 'unpriced' } },
      { id: 2, size: { kind: 'value', value: 5n } },
      { id: 3, size: { kind: 'none' } },
      { id: 4, size: { kind: 'value', value: 50n } },
      { id: 5, size: { kind: 'value', value: 5n } },
    ];
    expect([...rows].sort((a, b) => compareBySizeDesc(a.size, b.size)).map((r) => r.id)).toEqual([
      4, 2, 5, 1, 3,
    ]);
  });
});
