import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, keccak256, encodeAbiParameters, type Abi, type AbiFunction } from 'viem';
import { OfferAcceptFacetABI } from '@vaipakam/contracts/abis';
import { ACCEPT_TERMS_TYPES, OFFER_BORROWER, ZERO_ADDRESS, acceptTermsTypeString, buildAcceptTerms, directOfferKey, freshNonce, roleTerms } from './acceptTerms';

import { BORROWER, LENDER, TLIQ, offer } from './testOffer';

type Hex = `0x${string}`;

/** The type string as the contract's `ACCEPT_TERMS_TYPEHASH` spells it. */
function contractTypeString(): string {
  const sol = readFileSync(new URL('../../../../../contracts/src/libraries/LibAcceptTerms.sol', import.meta.url), 'utf8');
  const start = sol.indexOf('"AcceptTerms("');
  const end = sol.indexOf(';', start);
  return [...sol.slice(start, end).matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
}

describe('the signed accept terms', () => {
  it('encode exactly the type the contract hashes', () => {
    const want = contractTypeString();
    expect(want.startsWith('AcceptTerms(address acceptor,')).toBe(true);
    expect(acceptTermsTypeString()).toBe(want);
  });

  it('carry the same fields, in order, as the acceptOffer argument', () => {
    const fn = (OfferAcceptFacetABI as Abi).find((x): x is AbiFunction => x.type === 'function' && x.name === 'acceptOffer');
    const tuple = fn?.inputs[1] as { components?: readonly { name?: string; type: string }[] } | undefined;
    expect(tuple?.components?.map((c) => `${c.type} ${c.name}`)).toEqual(ACCEPT_TERMS_TYPES.AcceptTerms.map((f) => `${f.type} ${f.name}`));
  });

  it('key a direct offer by its id, hashed', () => {
    const k = directOfferKey(7n);
    expect(k).toBe(keccak256(encodeAbiParameters([{ type: 'uint256' }], [7n])));
    expect(decodeAbiParameters([{ type: 'uint256' }], encodeAbiParameters([{ type: 'uint256' }], [7n]))[0]).toBe(7n);
  });

  it('bind the lender offer at its upper amount and its floor rate', () => {
    expect(roleTerms(offer())).toEqual({ amount: 2n * 10n ** 18n, rateBps: 500n });
    expect(roleTerms(offer({ offerType: OFFER_BORROWER }))).toEqual({ amount: 1n * 10n ** 18n, rateBps: 900n });
  });

  it('copy every stored field and name an illiquid leg only when the review showed it', () => {
    const ctx = {
      acceptor: BORROWER,
      linkedLoanId: 0n,
      riskTermsHash: `0x${'ab'.repeat(32)}` as Hex,
      nonce: 9n,
      deadline: 100n,
      illiquidLending: false,
      illiquidCollateral: false,
    };
    const m = buildAcceptTerms(offer(), ctx);
    expect(m).toMatchObject({
      acceptor: BORROWER,
      offerCreator: LENDER,
      offerKey: directOfferKey(7n),
      amount: 2n * 10n ** 18n,
      interestRateBps: 500n,
      collateralAmount: 5000n * 10n ** 18n,
      durationDays: 30n,
      allowsPartialRepay: true,
      riskAndTermsConsent: true,
      acknowledgedIlliquidLendingAsset: ZERO_ADDRESS,
      acknowledgedIlliquidCollateralAsset: ZERO_ADDRESS,
      acceptorFull: false,
      acceptorMaxCStar: 0n,
    });
    expect(Object.keys(m).sort()).toEqual(ACCEPT_TERMS_TYPES.AcceptTerms.map((f) => f.name).sort());
    const shown = buildAcceptTerms(offer(), { ...ctx, illiquidCollateral: true });
    expect(shown.acknowledgedIlliquidCollateralAsset).toBe(TLIQ);
    expect(shown.acknowledgedIlliquidLendingAsset).toBe(ZERO_ADDRESS);
  });

  it('draw a 128-bit nonce from the random source', () => {
    expect(freshNonce((b) => b.fill(0xff))).toBe(2n ** 128n - 1n);
    expect(freshNonce((b) => b.fill(0))).toBe(0n);
  });
});
