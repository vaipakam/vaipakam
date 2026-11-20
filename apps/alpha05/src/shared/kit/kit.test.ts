import { describe, expect, it } from 'vitest';
import { kitLink, type BorrowRequest, type KitRequest, type LendRequest, type RentRequest } from '@vaipakam/lend-kit';
import { buildAcceptTerms } from '../offers/acceptTerms';
import { kitRoute, kitSeed, type KitSeed, readIntegratorEntry, readIntegratorShare, readKitLink, shareApplies } from './kit';

const A = '0x1111111111111111111111111111111111111111' as const;
const I = '0x2222222222222222222222222222222222222222' as const;
const D = '0x3333333333333333333333333333333333333333' as const;

const query = (link: string) => new URL(link).searchParams;

describe('readKitLink', () => {
  it('reads a link the kit built', () => {
    const r = readKitLink(query(kitLink('https://alpha05.vaipakam.com', { action: 'lend', chainId: 84532, asset: A, amount: 5n, integrator: I })));
    expect(r).toEqual({ ok: true, request: { action: 'lend', chainId: 84532, asset: A, amount: 5n, integrator: I } });
  });
  it("refuses what the kit's parser refuses, with its reason", () => {
    const r = readKitLink(new URLSearchParams('v=1&action=rent&chain=84532&asset=' + A));
    expect(r).toEqual({ ok: false, reason: 'tokenId is required' });
  });
  it('refuses another link version', () => {
    expect(readKitLink(new URLSearchParams('v=2')).ok).toBe(false);
  });
});

describe('kitRoute', () => {
  it('continues each action on its own page', () => {
    expect(kitRoute({ action: 'borrow', chainId: 1, asset: A })).toBe('/borrow');
    expect(kitRoute({ action: 'lend', chainId: 1, asset: A, amount: 1n })).toBe('/lend');
    expect(kitRoute({ action: 'rent', chainId: 1, asset: A, tokenId: 0n })).toBe('/rent');
  });
});

describe('the registry reads', () => {
  const client = (answer: unknown) => ({ readContract: async () => answer });
  it('states each status, and no name for an unregistered entry', async () => {
    expect(await readIntegratorEntry(client({ status: 1, name: 'Wallet X' }), D, I)).toEqual({ status: 'active', name: 'Wallet X' });
    expect(await readIntegratorEntry(client({ status: 2, name: 'Wallet X' }), D, I)).toEqual({ status: 'suspended', name: 'Wallet X' });
    expect(await readIntegratorEntry(client({ status: 0, name: 'stale' }), D, I)).toEqual({ status: 'none', name: '' });
  });
  it('refuses a status it does not know rather than guessing', async () => {
    await expect(readIntegratorEntry(client({ status: 9, name: '' }), D, I)).rejects.toThrow('unknown status');
  });
  it("reads the protocol's rate or its reason for paying nothing", async () => {
    expect(await readIntegratorShare(client([1000n, 0]), D, I, A)).toEqual({ rateBps: 1000n, refusal: 'none' });
    expect(await readIntegratorShare(client([0n, 3]), D, I, A)).toEqual({ rateBps: 0n, refusal: 'suspended' });
    expect(await readIntegratorShare(client([0n, 5]), D, I, A)).toEqual({ rateBps: 0n, refusal: 'borrower-is-integrator' });
    await expect(readIntegratorShare(client([0n, 6]), D, I, A)).rejects.toThrow('unknown refusal');
  });
});

describe('shareApplies', () => {
  const active = { status: 'active', name: 'X' } as const;
  it('is only ever true on a borrow naming an active entry', () => {
    expect(shareApplies({ action: 'borrow', chainId: 1, asset: A, integrator: I }, active)).toBe(true);
    expect(shareApplies({ action: 'borrow', chainId: 1, asset: A, integrator: I }, { status: 'suspended', name: 'X' })).toBe(false);
    expect(shareApplies({ action: 'borrow', chainId: 1, asset: A, integrator: I }, null)).toBeNull();
    expect(shareApplies({ action: 'lend', chainId: 1, asset: A, amount: 1n, integrator: I }, active)).toBe(false);
    expect(shareApplies({ action: 'rent', chainId: 1, asset: A, tokenId: 1n, integrator: I }, active)).toBe(false);
  });
});

describe('the integrator in the signed terms', () => {
  const offer = {
    id: 7n,
    creator: A,
    offerType: 0,
    lendingAsset: A,
    collateralAsset: D,
    amount: 1n,
    amountMax: 1n,
    collateralAmount: 1n,
    interestRateBps: 1n,
    interestRateBpsMax: 1n,
    durationDays: 1n,
    tokenId: 0n,
    collateralTokenId: 0n,
    quantity: 0n,
    collateralQuantity: 0n,
    assetType: 0,
    collateralAssetType: 0,
    prepayAsset: A,
    useFullTermInterest: false,
    allowsPartialRepay: false,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    parallelSaleOrderHash: '0x' as const,
    periodicInterestCadence: 0,
  };
  const ctx = { acceptor: A, linkedLoanId: 0n, riskTermsHash: '0x' as const, nonce: 1n, deadline: 1n, illiquidLending: false, illiquidCollateral: false };
  it('names none unless the reader kept one', () => {
    expect(buildAcceptTerms(offer as never, ctx).integrator).toBe('0x0000000000000000000000000000000000000000');
    expect(buildAcceptTerms(offer as never, { ...ctx, integrator: I }).integrator).toBe(I);
  });
});

describe('kitSeed (#3773)', () => {
  const B = '0x4444444444444444444444444444444444444444' as const;
  const base = { lending: B, collateral: B };
  it('carries an NFT link’s token id and quantity into a fresh borrow form, on its pair', () => {
    const s = kitSeed({ action: 'borrow', chainId: 1, asset: A, tokenId: 42n, quantity: 3n, lendingAsset: D }, null);
    if (s.action !== 'borrow') throw new Error('borrow seed');
    expect(s.request).toMatchObject({ tokenId: '42', collateral: '3' });
    expect(s.pair(base)).toEqual({ lending: D, collateral: A });
    const plain = kitSeed({ action: 'borrow', chainId: 1, asset: A }, null);
    if (plain.action !== 'borrow') throw new Error('borrow seed');
    expect(plain.request).toMatchObject({ tokenId: '', collateral: '' });
    expect(plain.pair(base)).toEqual({ lending: B, collateral: A });
  });
  it('types a lend link’s amount into both lending forms in the token’s own units', () => {
    const s = kitSeed({ action: 'lend', chainId: 1, asset: A, amount: 5_250_000n }, 6);
    if (s.action !== 'lend') throw new Error('lend seed');
    expect(s.amountFilled).toBe(true);
    expect(s.offer.amount).toBe('5.25');
    expect(s.autoLend.amount).toBe('5.25');
    expect(s.pair(base)).toEqual({ lending: A, collateral: B });
  });
  it('leaves the amount blank, and says so, while the decimals are unread', () => {
    const s = kitSeed({ action: 'lend', chainId: 1, asset: A, amount: 1n }, null);
    if (s.action !== 'lend') throw new Error('lend seed');
    expect(s.amountFilled).toBe(false);
    expect(s.offer.amount).toBe('');
  });
  it('opens a rent link on its token', () => {
    expect(kitSeed({ action: 'rent', chainId: 1, asset: A, tokenId: 7n }, null)).toEqual({ action: 'rent', token: { asset: A, tokenId: 7n } });
  });
});

/**
 * The class guard: every field a kit link carries reaches what the app fills
 * in. Each sample is `Required<…>`, so a field added to the kit's request
 * types fails to compile here until it is listed, and the loop then requires
 * kitSeed to read it. The chain and the integrator are carried by the hand-off
 * itself (`useKitUse` applies the link on its own chain only, and the
 * integrator is the reader's choice), so they are named as such.
 */
describe('kitSeed reads every field a kit link carries', () => {
  const ALT = '0x5555555555555555555555555555555555555555' as const;
  const HANDOFF_FIELDS = new Set(['action', 'chainId', 'integrator']);
  const view = (s: KitSeed) => {
    const probe = { lending: null, collateral: null };
    return JSON.stringify(
      s.action === 'rent' ? s.token : { ...s, pair: s.pair(probe) },
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
  };
  const borrow: Required<BorrowRequest> = { action: 'borrow', chainId: 1, asset: A, tokenId: 1n, quantity: 2n, lendingAsset: D, integrator: I };
  const lend: Required<LendRequest> = { action: 'lend', chainId: 1, asset: A, amount: 1_000_000n, integrator: I };
  const rent: Required<RentRequest> = { action: 'rent', chainId: 1, asset: A, tokenId: 1n, integrator: I };
  const changed = (v: unknown): unknown => (typeof v === 'bigint' ? v + 1n : typeof v === 'string' ? ALT : v);
  for (const sample of [borrow, lend, rent] as KitRequest[]) {
    for (const key of Object.keys(sample).filter((k) => !HANDOFF_FIELDS.has(k))) {
      it(`${sample.action}: ${key}`, () => {
        const other = { ...sample, [key]: changed((sample as unknown as Record<string, unknown>)[key]) } as KitRequest;
        expect(view(kitSeed(other, 6))).not.toBe(view(kitSeed(sample, 6)));
      });
    }
  }
});
