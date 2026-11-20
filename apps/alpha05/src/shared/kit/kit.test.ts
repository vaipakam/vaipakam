import { describe, expect, it } from 'vitest';
import { kitLink } from '@vaipakam/lend-kit';
import { buildAcceptTerms } from '../offers/acceptTerms';
import { kitLendInputs, kitRequestInput, kitRoute, readIntegratorEntry, readIntegratorShare, readKitLink, shareApplies } from './kit';

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

describe('kitRequestInput (#3773)', () => {
  it('carries an NFT link’s token id and quantity into a fresh borrow form', () => {
    expect(kitRequestInput({ action: 'borrow', chainId: 1, asset: A, tokenId: 42n, quantity: 3n })).toMatchObject({ tokenId: '42', collateral: '3' });
    const plain = kitRequestInput({ action: 'borrow', chainId: 1, asset: A });
    expect(plain).toMatchObject({ tokenId: '', collateral: '' });
  });
  it('leaves other actions’ forms alone', () => {
    expect(kitRequestInput({ action: 'rent', chainId: 1, asset: A, tokenId: 1n })).toBeNull();
  });
});

describe('kitLendInputs (#3773)', () => {
  it('types a lend link’s amount into both lending forms in the token’s own units', () => {
    const r = kitLendInputs({ action: 'lend', chainId: 1, asset: A, amount: 5_250_000n }, 6);
    expect(r?.amountFilled).toBe(true);
    expect(r?.offer.amount).toBe('5.25');
    expect(r?.autoLend.amount).toBe('5.25');
  });
  it('leaves the amount blank, and says so, while the decimals are unread', () => {
    const r = kitLendInputs({ action: 'lend', chainId: 1, asset: A, amount: 1n }, null);
    expect(r?.amountFilled).toBe(false);
    expect(r?.offer.amount).toBe('');
  });
  it('opens no lending form for any other action', () => {
    expect(kitLendInputs({ action: 'borrow', chainId: 1, asset: A }, 6)).toBeNull();
  });
});
