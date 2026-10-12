/**
 * #2422 r2 — the complete expected payloads `live-refinance.mjs` arms its
 * write gate with. The live drive's happy path cannot exercise a refusal,
 * so the refusals that matter are pinned here: the Full VPFI tariff on the
 * signed acceptance terms, a field the builders do not name, and an accept
 * call whose terms differ from the ones signed.
 *
 * The fixture is loan 22 → request #45 as it really ran on Base Sepolia on
 * 2026-10-05; the same builders were checked against those transactions'
 * calldata with zero mismatches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { structMismatches } from './expectedPayload.mjs';
import {
  acceptTermsTypes,
  decodeTxForComparison,
  expectedAcceptOfferCall,
  expectedAcceptTerms,
  expectedAcceptTypedData,
  expectedCreateOfferCall,
  expectedTx,
  afterAnchor,
  ANCHOR_LAG_SEC,
  ANCHOR_WINDOW_SEC,
  approvalBetween,
  borrowerReserve,
  graceSecondsFrom,
  payoffApprovalBounds,
  refinancePayoffAt,
  refinancePlanSteps,
  ZERO_HASH,
} from './refinanceExpected.mjs';
import { createWritePlan } from './writePlan.mjs';
import { encodeFunctionData, erc20Abi } from 'viem';

const DAY = 86_400n;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(
  fs.readFileSync(path.join(HERE, '../../../../packages/contracts/src/diamondAbi.json'), 'utf8'),
);
const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const LENDER = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const BORROWER = '0xC86BB89f8ddF703c34724Cf11137498bC69F039D';
const NOW = 1_791_190_612n;
const LOAN = {
  principalAsset: '0x4200000000000000000000000000000000000006',
  collateralAsset: '0xF2c65Cd941FE681B575Adc8DFc155Bf612675037',
  principal: 5_000_000_000_000_000n,
  collateralAmount: 10n ** 20n,
  collateralTokenId: 0n,
  collateralQuantity: 0n,
  collateralAssetType: 0,
  prepayAsset: '0x4200000000000000000000000000000000000006',
  useFullTermInterest: true,
  allowsPartialRepay: false,
  // The interest clock, as loan 22 carried it.
  startTime: 1_790_964_520n,
  durationDays: 29n,
  interestRateBps: 1000n,
  interestAccrualStart: 1_790_964_520n,
  interestRemainingDays: 29,
};
const TERMS_ARGS = {
  loan: LOAN,
  loanId: 22n,
  requestId: 45n,
  lender: LENDER,
  borrower: BORROWER,
  rateBps: 1200n,
  days: 30n,
  riskTermsHash: ZERO_HASH,
  // The accept deadline is anchored to chain time read when the lender's
  // submit starts; NOW − 6 s mirrors the real run (deadline = chainNow + 1800).
  anchor: () => NOW - 6n,
};

/** The acceptance terms request #45 was actually signed with. */
function signedTerms(over = {}) {
  const t = expectedAcceptTerms({ ...TERMS_ARGS, pinned: { nonce: 7n, deadline: NOW + 1_800n } });
  return { ...t, ...over };
}

describe('refinanceExpected — complete payloads, closed in both directions', () => {
  it('reads the AcceptTerms field list from the ABI, Full-tariff trio last', () => {
    const types = acceptTermsTypes(ABI);
    expect(types).toHaveLength(34);
    const names = types.map((t) => t.name);
    expect([names.at(-3), names.at(-2), names.at(-1)]).toEqual([
      'acceptorFull',
      'acceptorMaxCStar',
      'acceptorAllowFullDowngrade',
    ]);
    // Every expected-terms field is a typed field and vice versa.
    expect(Object.keys(expectedAcceptTerms(TERMS_ARGS)).sort()).toEqual(types.map((t) => t.name).sort());
  });

  it('accepts the genuine signed terms and refuses a Full-tariff opt-in', () => {
    const expected = expectedAcceptTerms(TERMS_ARGS);
    expect(structMismatches(expected, signedTerms())).toEqual([]);
    expect(
      structMismatches(expected, signedTerms({ acceptorFull: true, acceptorMaxCStar: 10n, acceptorAllowFullDowngrade: true })),
    ).toEqual([
      'acceptorFull: true (want false)',
      'acceptorMaxCStar: 10n (want 0)',
      'acceptorAllowFullDowngrade: true (want false)',
    ]);
  });

  it('refuses typed data carrying a field the terms do not define', () => {
    const exp = expectedAcceptTypedData({ abi: ABI, chainId: 84532, diamond: DIAMOND, signer: LENDER, terms: expectedAcceptTerms(TERMS_ARGS) });
    const typedData = {
      domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: 84532, verifyingContract: DIAMOND },
      types: { AcceptTerms: acceptTermsTypes(ABI) },
      primaryType: 'AcceptTerms',
      message: { ...signedTerms(), extra: '1' },
    };
    expect(structMismatches(exp, { signer: LENDER, typedData })).toEqual(['typedData.message.extra: unexpected field "1"']);
  });

  it('binds the accept CALL to exactly the signed terms and signature', () => {
    const signed = signedTerms();
    const sig = `0x${'ab'.repeat(65)}`;
    const exp = expectedTx({
      from: LENDER,
      to: DIAMOND,
      call: expectedAcceptOfferCall({ requestId: 45n, terms: signed, signature: sig }),
      chainId: 84532,
    });
    const encode = (terms, signature) => ({
      from: LENDER,
      to: DIAMOND,
      data: encodeFunctionData({ abi: ABI, functionName: 'acceptOffer', args: [45n, terms, signature] }),
    });
    const abiFor = () => ABI;
    expect(structMismatches(exp, decodeTxForComparison(encode(signed, sig), abiFor))).toEqual([]);
    expect(
      structMismatches(exp, decodeTxForComparison(encode({ ...signed, nonce: 8n }, sig), abiFor)),
    ).toEqual(['data.args.terms.nonce: 8n (want 7)']);
    // An envelope field the expected request does not name is refused too.
    expect(
      structMismatches(exp, { ...decodeTxForComparison(encode(signed, sig), abiFor), accessList: [] }),
    ).toEqual(['accessList: unexpected field []']);
  });

  it('builds the createOffer request over all 26 params, with the 0..ceiling band', () => {
    const call = expectedCreateOfferCall({ loan: LOAN, loanId: 22n, rateBps: 1200n, days: 30n, anchor: () => NOW });
    const fn = ABI.find((e) => e.type === 'function' && e.name === 'createOffer');
    expect(Object.keys(call.args.params).sort()).toEqual(fn.inputs[0].components.map((c) => c.name).sort());
    expect(call.args.params.interestRateBps).toBe(0n);
    expect(call.args.params.interestRateBpsMax).toBe(1200n);
  });

  it('the whole-drive plan accepts the posting once and refuses a duplicated createOffer', () => {
    let requestId = null;
    const plan = createWritePlan(
      refinancePlanSteps({
        abi: ABI,
        chainId: 84532,
        diamond: DIAMOND,
        loan: LOAN,
        loanId: 22n,
        borrower: BORROWER,
        lender: LENDER,
        rateBps: 1200n,
        days: 30n,
        riskTermsHash: ZERO_HASH,
        graceSeconds: 86_400n,
        borrowerAnchor: () => NOW,
        lenderAnchor: () => NOW,
        requestId: () => requestId,
        signedAcceptTerms: () => null,
      }),
    );
    const params = {
      offerType: 1,
      lendingAsset: LOAN.principalAsset,
      amount: LOAN.principal,
      interestRateBps: 0n,
      collateralAsset: LOAN.collateralAsset,
      collateralAmount: LOAN.collateralAmount,
      durationDays: 30n,
      assetType: 0,
      tokenId: 0n,
      quantity: 1n,
      creatorRiskAndTermsConsent: true,
      prepayAsset: LOAN.prepayAsset,
      collateralAssetType: 0,
      collateralTokenId: 0n,
      collateralQuantity: 0n,
      allowsPartialRepay: false,
      amountMax: LOAN.principal,
      interestRateBpsMax: 1200n,
      collateralAmountMax: LOAN.collateralAmount,
      periodicInterestCadence: 0,
      expiresAt: NOW + 30n * 86_400n,
      fillMode: 1,
      allowsPrepayListing: false,
      allowsParallelSale: false,
      refinanceTargetLoanId: 22n,
      useFullTermInterest: true,
    };
    const createReq = decodeTxForComparison(
      { from: BORROWER, to: DIAMOND, data: encodeFunctionData({ abi: ABI, functionName: 'createOffer', args: [params] }) },
      () => ABI,
    );
    // Caps and both approvals are optional — the app may skip them.
    plan.arm('borrower');
    expect(plan.offer('borrower', 'tx', createReq).ok).toBe(true);
    // The identical request again is refused: the step is consumed.
    expect(plan.offer('borrower', 'tx', createReq).ok).toBe(false);
    // And the lender's steps cannot even be judged before the request id
    // is pinned — but the plan has latched anyway.
    requestId = 45n;
    expect(plan.offer('lender', 'typed', {}).why).toMatch(/already refused/);
  });

  it('refuses a lender signature before the request id is pinned', () => {
    const plan = createWritePlan(
      refinancePlanSteps({
        ...TERMS_ARGS,
        abi: ABI,
        chainId: 84532,
        diamond: DIAMOND,
        graceSeconds: 86_400n,
        borrowerAnchor: () => NOW,
        lenderAnchor: () => null,
        requestId: () => null,
        signedAcceptTerms: () => null,
      }),
    );
    // Every borrower step is optional except createOffer, which a lender
    // request cannot pass over.
    plan.arm('lender');
    const r = plan.offer('lender', 'typed', {});
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/b-create expects borrower tx/);
  });

  // #2422 r8 — the borrower role stays CLOSED through the position page's
  // load, the card checks and the review checks; it is armed only for the
  // confirmed submit. An approve(Diamond, 0) the page fires while loading
  // matches the plan's optional reset step exactly, so only the arming
  // keeps it from being consumed.
  it('refuses an approve(Diamond, 0) requested while the borrower role is closed', () => {
    const planArgs = {
      ...TERMS_ARGS,
      abi: ABI,
      chainId: 84532,
      diamond: DIAMOND,
      graceSeconds: 86_400n,
      borrowerAnchor: () => NOW,
      lenderAnchor: () => NOW,
      requestId: () => null,
      signedAcceptTerms: () => null,
    };
    const reset = decodeTxForComparison(
      {
        from: BORROWER,
        to: LOAN.principalAsset,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DIAMOND, 0n] }),
      },
      () => erc20Abi,
    );
    const onLoad = createWritePlan(refinancePlanSteps(planArgs));
    const r = onLoad.offer('borrower', 'tx', reset);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/CLOSED/);
    expect(onLoad.steps().find((st) => st.id === 'b-approve-reset').status).toBe('pending');
    // Latched: the confirmed submit that follows cannot write either.
    onLoad.arm('borrower');
    expect(onLoad.offer('borrower', 'tx', reset).ok).toBe(false);
    // The same request, on a fresh plan armed for the submit, is the reset
    // step it was declared as — so the refusal above was the arming alone.
    const atSubmit = createWritePlan(refinancePlanSteps(planArgs));
    atSubmit.arm('borrower');
    expect(atSubmit.offer('borrower', 'tx', reset).ok).toBe(true);
    expect(atSubmit.steps().find((st) => st.id === 'b-approve-reset').status).toBe('consumed');
  });

  it('bounds the payoff approval with the app\u2019s own formula — loan 22 to the wei', () => {
    // Loan 22 refinanced on 2026-10-05: grace 1 day (no buckets → the default
    // table for 29 days), the borrower's submit anchored at chain time
    // 1791190252, and the app approved exactly 5116095890410958 wei.
    expect(graceSecondsFrom([], 29n)).toBe(86_400n);
    const b = payoffApprovalBounds(LOAN, 86_400n, () => 1_791_190_252n);
    expect(b.floor()).toBe(5_116_095_890_410_958n);
    // Loan 22's grace end came before the request's expiry, so both bounds
    // clamp to it and coincide.
    expect(b.cap()).toBe(5_116_095_890_410_958n);
    // An undersized approve is refused; the real one passes.
    const m = approvalBetween(b.floor, b.cap, 'the payoff');
    expect(structMismatches({ amount: m }, { amount: 1n })).toHaveLength(1);
    expect(structMismatches({ amount: m }, { amount: 5_116_095_890_410_958n })).toEqual([]);
    // No anchor yet → the floor is unknown → refused, never guessed.
    expect(structMismatches({ amount: approvalBetween(() => null, b.cap, 'x') }, { amount: b.cap() })).toHaveLength(1);
    expect(payoffApprovalBounds(LOAN, 86_400n, () => null).cap()).toBeNull();
  });

  // #2422 r9: the cap is the payoff at min(anchor + ANCHOR_WINDOW_SEC +
  // REQUEST_WINDOW_SEC − 1, grace end) — when the grace end lies past the
  // request's expiry, an approval sized for the grace end is refused.
  it('caps the payoff approval at the request\u2019s last fillable moment when the grace end is later', () => {
    const anchor = 1_800_000_000n;
    // A one-year loan that started a day before the anchor: its grace end
    // is ~a year out, far past the request's 30-day window.
    const long = { ...LOAN, startTime: anchor - DAY, interestAccrualStart: anchor - DAY, durationDays: 365n, interestRemainingDays: 365, useFullTermInterest: false };
    // Accrual past the floor: make interest grow with elapsed days by
    // setting the remaining-term floor to 0 days.
    const growing = { ...long, interestRemainingDays: 0 };
    const grace = 30n * DAY;
    const graceEnd = growing.startTime + growing.durationDays * DAY + grace;
    const lastFillable = anchor + ANCHOR_WINDOW_SEC + 30n * DAY - 1n;
    expect(lastFillable < graceEnd).toBe(true);
    const b = payoffApprovalBounds(growing, grace, () => anchor);
    expect(b.cap()).toBe(refinancePayoffAt(growing, lastFillable));
    expect(b.cap()).toBeLessThan(refinancePayoffAt(growing, graceEnd));
    const m = approvalBetween(b.floor, b.cap, 'the payoff');
    expect(structMismatches({ amount: m }, { amount: refinancePayoffAt(growing, graceEnd) })).toHaveLength(1);
    expect(structMismatches({ amount: m }, { amount: b.cap() })).toEqual([]);
    expect(structMismatches({ amount: m }, { amount: b.floor() })).toEqual([]);
  });

  it('judges stamped times against the chain anchor, not the local clock', () => {
    const exp = afterAnchor('x', () => 1_000_000n, 1_800n);
    expect(structMismatches({ t: exp }, { t: 1_000_000n + 1_800n + 40n * 60n })).toEqual([]); // inside +45 min
    expect(structMismatches({ t: exp }, { t: 1_000_000n + 1_800n + ANCHOR_WINDOW_SEC + 1n })).toHaveLength(1);
    expect(structMismatches({ t: exp }, { t: 1_000_000n + 1_800n - ANCHOR_LAG_SEC - 1n })).toHaveLength(1);
    expect(structMismatches({ t: afterAnchor('x', () => null, 0n) }, { t: 1n })).toHaveLength(1);
  });

  it('mirrors the app\u2019s default grace table and bucket walk', () => {
    expect([1n, 7n, 30n, 90n, 180n, 365n].map((d) => graceSecondsFrom([], d))).toEqual([
      3_600n, 86_400n, 259_200n, 604_800n, 1_209_600n, 2_592_000n,
    ]);
    const buckets = [
      { maxDurationDays: 10n, graceSeconds: 5n },
      { maxDurationDays: 0n, graceSeconds: 9n },
    ];
    expect(graceSecondsFrom(buckets, 3n)).toBe(5n);
    expect(graceSecondsFrom(buckets, 40n)).toBe(9n);
  });
});

// #2422 r8 — the borrower's top-up reserve comes from the LIVE remaining
// term (interestAccrualStart / interestRemainingDays, and the contract's
// payoff view), never from the loan's original durationDays.
describe('refinanceExpected — the borrower reserve', () => {
  const DAY = 86_400n;
  const HORIZON = 2n * 3_600n;

  it('loan 22: the reserve is exactly what the real accept took from the borrower wallet', () => {
    // calculateRepaymentAmount(22) at the pinned block, LIF 20 bps live.
    const r = borrowerReserve({ loan: LOAN, viewDue: 5_039_726_027_397_260n, asOf: NOW, horizonSec: HORIZON, lifBps: 20n });
    expect(r.payoff).toBe(5_039_726_027_397_260n);
    expect(r.lif).toBe(10_000_000_000_000n);
    // The borrower wallet's real delta across the accept was −49726027397260.
    expect(r.reserve).toBe(49_726_027_397_260n);
  });

  it('a partially repaid, re-anchored loan reserves its REMAINING term, not durationDays', () => {
    const t0 = 1_700_000_000n;
    const reanchored = {
      principal: 10n ** 18n,
      startTime: t0,
      durationDays: 60n,
      interestRateBps: 1000n,
      // A partial repayment on day 50 re-anchored the clock: 10 days left.
      interestAccrualStart: t0 + 50n * DAY,
      interestRemainingDays: 10,
    };
    const tenDays = (10n ** 18n * 1000n * 10n) / (365n * 10_000n);
    const sixtyDays = (10n ** 18n * 1000n * 60n) / (365n * 10_000n);
    const r = borrowerReserve({
      loan: reanchored,
      viewDue: 10n ** 18n + tenDays,
      asOf: t0 + 50n * DAY + 3_600n,
      horizonSec: HORIZON,
      lifBps: 20n,
    });
    expect(r.interestShare).toBe(tenDays);
    expect(r.reserve).toBe(tenDays + 2_000_000_000_000_000n);
    // The retired durationDays figure would have demanded 6× the interest.
    expect(r.reserve).toBeLessThan(sixtyDays);
  });

  it('takes the contract view when it is the larger figure', () => {
    const r = borrowerReserve({ loan: LOAN, viewDue: 5_100_000_000_000_000n, asOf: NOW, horizonSec: HORIZON, lifBps: 20n });
    expect(r.payoff).toBe(5_100_000_000_000_000n);
  });

  it('reserves for a whole-day accrual step inside the horizon', () => {
    // A loan whose elapsed days already equal its remaining floor: one more
    // day of interest accrues if the accept lands after the next day mark.
    const start = 1_700_000_000n;
    const l = { ...LOAN, interestAccrualStart: start, startTime: start, interestRemainingDays: 3, durationDays: 30n };
    const asOf = start + 4n * DAY - 60n; // one minute before day 4 begins
    const now = borrowerReserve({ loan: l, viewDue: 0n, asOf, horizonSec: 0n, lifBps: 0n });
    const later = borrowerReserve({ loan: l, viewDue: 0n, asOf, horizonSec: HORIZON, lifBps: 0n });
    const interestFor = (days) => (l.principal * l.interestRateBps * days) / (365n * 10_000n);
    expect(now.interestShare).toBe(interestFor(3n));
    expect(later.interestShare).toBe(interestFor(4n));
  });
});
