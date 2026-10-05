/**
 * #2422 r14 ROOT B — every field of the replacement loan is mapped to
 * exactly one way of checking it, and the mapping holds on the real loan 23.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { evaluateReplacement, HOWS, REPLACEMENT_MAPPING, sameValue, UNCHECKED_FIELDS } from './replacementMapping.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(fs.readFileSync(path.join(HERE, '../../../../packages/contracts/src/diamondAbi.json'), 'utf8'));
const LOAN_FIELDS = ABI.find((e) => e.name === 'getLoanDetails').outputs[0].components.map((c) => c.name);

const BORROWER = '0xC86BB89f8ddF703c34724Cf11137498bC69F039D';
const LENDER = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const WETH = '0x4200000000000000000000000000000000000006';
const TCOL = '0xF2c65Cd941FE681B575Adc8DFc155Bf612675037';
// getLoanDetails(23) at the accept block 47711162 (2026-10-05).
const LOAN23 = {
  id: 23n, offerId: 45n, lender: LENDER, principalLiquidity: 0, collateralLiquidity: 1, status: 0, assetType: 0,
  useFullTermInterest: true, riskAndTermsConsentFromBoth: true, collateralAssetType: 0, fallbackLenderBonusBpsAtInit: 300,
  fallbackTreasuryBpsAtInit: 200, liquidationLtvBpsAtInit: 0, borrower: BORROWER, allowsPartialRepay: false,
  periodicInterestCadence: 0, lastPeriodicInterestSettledAt: 1_791_190_612n, lenderTokenId: 71n, borrowerTokenId: 70n,
  principal: 5_000_000_000_000_000n, principalAsset: WETH, interestRateBps: 1200n, startTime: 1_791_190_612n,
  interestPaidSinceLastPeriod: 0n, durationDays: 30n, collateralAsset: TCOL, collateralAmount: 100n * 10n ** 18n, tokenId: 0n,
  quantity: 1n, prepayAmount: 0n, bufferAmount: 0n, lastDeductTime: 0n, prepayAsset: WETH, collateralTokenId: 0n,
  collateralQuantity: 0n, lenderDiscountAccAtInit: 0n, borrowerDiscountAccAtInit: 0n, matcher: LENDER,
  lenderNotifBilled: false, borrowerNotifBilled: false, allowsPrepayListing: false, interestSettled: 0n,
  minHealthFactorAtInit: 1_500_000_000_000_000_000n, initLtvCapBpsAtInit: 0, interestAccrualStart: 1_791_190_612n,
  interestRemainingDays: 30, treasuryFeeBpsAtInit: 200, loanInitiationFeeBpsAtInit: 20,
};
// The real context: the signed AcceptTerms message (typed-data strings), the
// request #45 as created, loan 22 at block 47711161, the reviewed config.
const CTX = {
  newLoanId: 23n,
  requestId: 45n,
  acceptor: LENDER,
  acceptTs: 1_791_190_612n,
  terms: {
    amount: '5000000000000000', lendingAsset: WETH, collateralAsset: TCOL, collateralAmount: '100000000000000000000',
    interestRateBps: '1200', durationDays: '30', tokenId: '0', collateralTokenId: '0', quantity: '1', collateralQuantity: '0',
    assetType: 0, collateralAssetType: 0, prepayAsset: WETH, useFullTermInterest: true, allowsPartialRepay: false,
    allowsPrepayListing: false, periodicInterestCadence: 0, riskAndTermsConsent: true,
  },
  request: { id: 45n, positionTokenId: 70n, creatorRiskAndTermsConsent: true },
  oldLoan: { borrower: BORROWER, collateralLiquidity: 1, lenderTokenId: 20n, borrowerTokenId: 68n },
  reviewedConfig: { treasuryFeeBps: 200n, lifBps: 20n },
};

describe('replacementMapping — complete', () => {
  it('every Loan field of the compiled ABI is mapped exactly once, with a valid way and a reason', () => {
    expect(LOAN_FIELDS.length).toBeGreaterThan(40);
    expect(LOAN_FIELDS.filter((f) => !Object.hasOwn(REPLACEMENT_MAPPING, f)), 'map it').toEqual([]);
    expect(Object.keys(REPLACEMENT_MAPPING).filter((f) => !LOAN_FIELDS.includes(f)), 'not a Loan field').toEqual([]);
    for (const [f, m] of Object.entries(REPLACEMENT_MAPPING)) {
      expect(HOWS, f).toContain(m.how);
      expect(typeof m.why === 'string' && m.why.length > 10, f).toBe(true);
      if (m.how !== 'unchecked') expect(typeof m.expect === 'function' || typeof m.check === 'function', f).toBe(true);
    }
  });

  it('the interest mode is a SIGNED term (P1 :2703), and every unchecked field is listed for NOT VERIFIED', () => {
    expect(REPLACEMENT_MAPPING.useFullTermInterest.how).toBe('signed');
    expect(UNCHECKED_FIELDS.map((u) => u.field).sort()).toEqual(
      Object.entries(REPLACEMENT_MAPPING).filter(([, m]) => m.how === 'unchecked').map(([f]) => f).sort(),
    );
  });
});

describe('replacementMapping — evaluated', () => {
  it('holds on the real loan 23, with evidence for every field', () => {
    const r = evaluateReplacement(LOAN23, CTX);
    expect(r.mismatches).toEqual([]);
    expect(r.evidence).toHaveLength(LOAN_FIELDS.length);
    expect(r.evidence.find((l) => l.startsWith('useFullTermInterest:'))).toBe('useFullTermInterest: (a) signed = true (true)');
    expect(r.evidence.find((l) => l.startsWith('principalLiquidity:'))).toMatch(/\(e\) not checked/);
  });

  it('a replacement whose interest mode differs from the signed one is a mismatch', () => {
    const r = evaluateReplacement({ ...LOAN23, useFullTermInterest: false }, CTX);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toMatch(/^useFullTermInterest: false, expected true/);
  });

  it('each kind catches its own drift', () => {
    expect(evaluateReplacement({ ...LOAN23, interestRateBps: 1100n }, CTX).mismatches[0]).toMatch(/^interestRateBps/);
    expect(evaluateReplacement({ ...LOAN23, borrower: LENDER }, CTX).mismatches[0]).toMatch(/^borrower/);
    expect(evaluateReplacement({ ...LOAN23, treasuryFeeBpsAtInit: 100 }, CTX).mismatches[0]).toMatch(/^treasuryFeeBpsAtInit/);
    expect(evaluateReplacement({ ...LOAN23, startTime: 1n }, CTX).mismatches[0]).toMatch(/^startTime/);
    expect(evaluateReplacement({ ...LOAN23, lenderTokenId: 20n }, CTX).mismatches[0]).toMatch(/^lenderTokenId/);
    // An unchecked field is never a mismatch, whatever it holds.
    expect(evaluateReplacement({ ...LOAN23, minHealthFactorAtInit: 1n }, CTX).mismatches).toEqual([]);
    // A field missing from the read is a mismatch, never assumed.
    const { durationDays: _d, ...partial } = LOAN23;
    expect(evaluateReplacement(partial, CTX).mismatches).toEqual(['durationDays: missing from the read']);
  });

  it('compares a chain value with a typed-data string, an address case-insensitively, a boolean strictly', () => {
    expect(sameValue(1200n, '1200')).toBe(true);
    expect(sameValue(WETH.toLowerCase(), WETH)).toBe(true);
    expect(sameValue(true, 'true')).toBe(true);
    expect(sameValue(false, true)).toBe(false);
    expect(sameValue(0, 1)).toBe(false);
  });
});
