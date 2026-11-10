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
  borrowerReserve,
  expectedPayoffPermitTypedData,
  graceSecondsFrom,
  lastFillableMoment,
  lateFeeAt,
  PAYOFF_PERMIT_TYPES,
  PERMIT2_ADDRESS,
  permitDeadlineWindow,
  REQUEST_WINDOW_SEC,
  refinancePlanSteps,
  SET_PAYOFF_PERMIT_SIGNATURE,
  TX_DEADLINE_SEC,
  ZERO_HASH,
} from './refinanceExpected.mjs';
import { createWritePlan } from './writePlan.mjs';
import { createWalletClient, custom, encodeFunctionData, erc20Abi, toFunctionSelector } from 'viem';
// The app's OWN permit builders and constants (#3295): the drive's expected
// objects are held to what the deployed code produces, not to a restatement.
import {
  lastFillableMoment as appLastFillableMoment,
  payoffPermitTypedData,
  setPayoffPermitCall,
} from '../../src/contracts/refinancePayoffPermit';
import { PERMIT2_ADDRESS as APP_PERMIT2_ADDRESS } from '../../src/contracts/usePermit2Signing';
import { TX_DEADLINE_SECONDS } from '@vaipakam/lib/txDeadline';

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
  // Loan 22's legs as checkLiquidity classifies them: the principal liquid,
  // the collateral illiquid.
  illiquidLegs: { lending: false, collateral: true },
};

/** The payoff-permit getters before any of their inputs exist (#3295). */
const NO_PERMIT_YET = {
  permitNeeded: true,
  permit2ShareBounds: () => null,
  borrowerPermit: () => null,
  signedPayoffPermit: () => null,
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

  it('acknowledges only the illiquid leg (#2728)', () => {
    const t = expectedAcceptTerms(TERMS_ARGS);
    expect(t.acknowledgedIlliquidLendingAsset).toBe('0x0000000000000000000000000000000000000000');
    expect(t.acknowledgedIlliquidCollateralAsset).toBe(LOAN.collateralAsset);
    const both = expectedAcceptTerms({ ...TERMS_ARGS, illiquidLegs: { lending: true, collateral: true } });
    expect(both.acknowledgedIlliquidLendingAsset).toBe(LOAN.principalAsset);
    const { illiquidLegs: _omit, ...noLegs } = TERMS_ARGS;
    expect(() => expectedAcceptTerms(noLegs)).toThrow(/illiquidLegs/);
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
    // #3412 — and the transaction deadline, the call's only other argument.
    expect(Object.keys(call.args).sort()).toEqual(fn.inputs.map((i) => i.name).sort());
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
        ...NO_PERMIT_YET,
        borrowerAnchor: () => NOW,
        lenderAnchor: () => NOW,
        illiquidLegs: TERMS_ARGS.illiquidLegs,
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
      {
        from: BORROWER,
        to: DIAMOND,
        data: encodeFunctionData({ abi: ABI, functionName: 'createOffer', args: [params, NOW + TX_DEADLINE_SEC] }),
      },
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
        ...NO_PERMIT_YET,
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
  // confirmed submit. An approve(Permit2, 0) the page fires while loading
  // matches the plan's optional reset step exactly, so only the arming
  // keeps it from being consumed.
  it('refuses an approve(Permit2, 0) requested while the borrower role is closed', () => {
    const planArgs = {
      ...TERMS_ARGS,
      abi: ABI,
      chainId: 84532,
      diamond: DIAMOND,
      ...NO_PERMIT_YET,
      borrowerAnchor: () => NOW,
      lenderAnchor: () => NOW,
      requestId: () => null,
      signedAcceptTerms: () => null,
    };
    const reset = decodeTxForComparison(
      {
        from: BORROWER,
        to: LOAN.principalAsset,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, 0n] }),
      },
      () => erc20Abi,
    );
    const onLoad = createWritePlan(refinancePlanSteps(planArgs));
    const r = onLoad.offer('borrower', 'tx', reset);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/CLOSED/);
    expect(onLoad.steps().find((st) => st.id === 'b-permit2-reset').status).toBe('pending');
    // Latched: the confirmed submit that follows cannot write either.
    onLoad.arm('borrower');
    expect(onLoad.offer('borrower', 'tx', reset).ok).toBe(false);
    // The same request, on a fresh plan armed for the submit, is the reset
    // step it was declared as — so the refusal above was the arming alone.
    const atSubmit = createWritePlan(refinancePlanSteps(planArgs));
    atSubmit.arm('borrower');
    expect(atSubmit.offer('borrower', 'tx', reset).ok).toBe(true);
    expect(atSubmit.steps().find((st) => st.id === 'b-permit2-reset').status).toBe('consumed');
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
// term (interestAccrualStart to the term's end, #3169, and the contract's
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

  it('reserves for the per-second accrual inside the horizon (#3169)', () => {
    // A 3-day loan four days in: past its minimum, interest grows by the
    // second, so the horizon's two hours are reserved too. It is past
    // maturity as well, so the late fee at each moment is part of the share.
    const start = 1_700_000_000n;
    const l = { ...LOAN, interestAccrualStart: start, startTime: start, durationDays: 3n };
    const asOf = start + 4n * DAY - 60n;
    const now = borrowerReserve({ loan: l, viewDue: 0n, asOf, horizonSec: 0n, lifBps: 0n });
    const later = borrowerReserve({ loan: l, viewDue: 0n, asOf, horizonSec: HORIZON, lifBps: 0n });
    const interestFor = (secs) => (l.principal * l.interestRateBps * secs) / (365n * DAY * 10_000n);
    expect(now.interestShare).toBe(interestFor(4n * DAY - 60n) + lateFeeAt(l, asOf));
    expect(later.interestShare).toBe(interestFor(4n * DAY - 60n + HORIZON) + lateFeeAt(l, asOf + HORIZON));
    expect(later.interestShare).toBeGreaterThan(now.interestShare);
  });
});

// #3295 — the borrower's half of the plan on the payoff-permit route
// (#1558 / #3042): the Permit2 approval, createOffer, the payoff permit
// signature and the attach call. The requests are produced by the APP's own
// builders (`payoffPermitTypedData`, `setPayoffPermitCall`) and, for the
// signature, serialised by viem's own wallet client exactly as the injected
// wallet receives it — so a drift between the drive's expected objects and
// what the deployed app sends fails here, not on a funded wallet.
describe('refinanceExpected — the payoff-permit route (#3295)', () => {
  const CHAIN = 84532;
  const ANCHOR = NOW;
  const GRACE_END = LOAN.startTime + LOAN.durationDays * DAY + DAY;
  const REQUEST_ID = 46n;
  // The app's own chain read lands 2 s after the drive's anchor.
  const EXPIRES_AT = ANCHOR + 2n + REQUEST_WINDOW_SEC;
  const DEADLINE = lastFillableMoment(EXPIRES_AT, GRACE_END);
  // The wallet share the contract reports at that deadline (loan 22's
  // interest share plus the 0.2% LIF on the new principal).
  const SHARE = 49_726_027_397_260n;
  const NONCE = 2n ** 200n + 12_345n;
  const SIG = `0x${'cd'.repeat(65)}`;

  const tx = (to, abi, functionName, args) =>
    decodeTxForComparison({ from: BORROWER, to, data: encodeFunctionData({ abi, functionName, args }) }, (a) =>
      a.toLowerCase() === DIAMOND.toLowerCase() ? ABI : erc20Abi,
    );
  const approve = (spender, amount) => tx(LOAN.principalAsset, erc20Abi, 'approve', [spender, amount]);
  const createOffer = () =>
    tx(DIAMOND, ABI, 'createOffer', [
      {
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
        expiresAt: EXPIRES_AT,
        fillMode: 1,
        allowsPrepayListing: false,
        allowsParallelSale: false,
        refinanceTargetLoanId: 22n,
        useFullTermInterest: true,
      },
      // The app's chain read at the send, 2 s after the anchor (#3412).
      ANCHOR + 2n + TX_DEADLINE_SEC,
    ]);

  /** The eth_signTypedData_v4 request viem's wallet client sends for the
   *  app's permit typed data, and the request the gate judges from it. */
  async function permitRequest(over = {}) {
    const calls = [];
    const wallet = createWalletClient({
      account: BORROWER,
      transport: custom({
        async request({ method, params }) {
          calls.push({ method, params });
          return SIG;
        },
      }),
    });
    const data = payoffPermitTypedData({
      chainId: CHAIN,
      diamond: DIAMOND,
      token: LOAN.principalAsset,
      maxAmount: SHARE,
      nonce: NONCE,
      deadline: DEADLINE,
      loanId: 22n,
      offerId: REQUEST_ID,
      ...over,
    });
    await wallet.signTypedData({ account: BORROWER, ...data });
    const call = calls.find((c) => c.method === 'eth_signTypedData_v4');
    return { params: call.params, actual: { signer: call.params[0], typedData: JSON.parse(call.params[1]) } };
  }
  const attach = (over = {}) => {
    const c = setPayoffPermitCall(REQUEST_ID, { maxAmount: SHARE, nonce: NONCE, deadline: DEADLINE, signature: SIG, ...over });
    return tx(DIAMOND, ABI, c.functionName, c.args);
  };

  /** A plan armed for the borrower, with the figures the drive's
   *  `prepareBorrowerPermit` would have read; `known` controls which. */
  function borrowerPlan({ bounds = { floor: SHARE - 10n, cap: SHARE + 10n }, permit = { offerId: REQUEST_ID, deadline: DEADLINE, maxAmount: SHARE }, permitNeeded = true } = {}) {
    let plan = null;
    plan = createWritePlan(
      refinancePlanSteps({
        ...TERMS_ARGS,
        abi: ABI,
        chainId: CHAIN,
        diamond: DIAMOND,
        borrowerAnchor: () => ANCHOR,
        lenderAnchor: () => NOW,
        permitNeeded,
        permit2ShareBounds: () => bounds,
        borrowerPermit: () => permit,
        signedPayoffPermit: () => plan.steps().find((st) => st.id === 'b-permit' && st.status === 'consumed')?.record ?? null,
        requestId: () => null,
        signedAcceptTerms: () => null,
      }),
    );
    plan.arm('borrower');
    return plan;
  }
  /** Offer a request and keep what the drive's gate keeps with the step. */
  function offer(plan, kind, req) {
    const r = plan.offer('borrower', kind, req.actual ?? req);
    if (r.ok) plan.record(r.index, kind === 'typed' ? { params: req.params, signature: SIG } : { call: (req.actual ?? req).data, hash: '0x01' });
    return r;
  }

  it('holds its constants to the app and the contract', () => {
    expect(PERMIT2_ADDRESS).toBe(APP_PERMIT2_ADDRESS);
    const fn = ABI.find((e) => e.type === 'function' && e.name === 'setRefinancePayoffPermit');
    expect(toFunctionSelector(fn)).toBe(toFunctionSelector(SET_PAYOFF_PERMIT_SIGNATURE));
    // The drive's type list IS the app's (which the app's own test holds to
    // the contract's WITNESS_TYPE_STRING).
    const app = payoffPermitTypedData({ chainId: CHAIN, diamond: DIAMOND, token: LOAN.principalAsset, maxAmount: 1n, nonce: 1n, deadline: 1n, loanId: 1n, offerId: 1n });
    expect(PAYOFF_PERMIT_TYPES).toEqual(app.types);
    // And it encodes the contract's witness type string, read from source.
    const sol = fs.readFileSync(path.join(HERE, '../../../../contracts/src/libraries/LibRefinancePayoff.sol'), 'utf8');
    const decl = sol.match(/WITNESS_TYPE_STRING\s*=\s*((?:\s*"[^"]*")+)\s*;/);
    const witness = [...decl[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
    const fields = (t) => PAYOFF_PERMIT_TYPES[t].map((f) => `${f.type} ${f.name}`).join(',');
    // Permit2's fixed stub, then the witness type string the Diamond hands it.
    const stub = 'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,';
    const encoded =
      `PermitWitnessTransferFrom(${fields('PermitWitnessTransferFrom')})` +
      `RefinancePayoff(${fields('RefinancePayoff')})TokenPermissions(${fields('TokenPermissions')})`;
    expect(encoded).toBe(`${stub}${witness}`);
  });

  it('derives the deadline as the app does: the request’s last fillable moment', () => {
    for (const [e, g] of [
      [EXPIRES_AT, GRACE_END], // clamped to the grace end (loan 22)
      [1_000n, 5_000n], // the request ends first
      [5_001n, 5_000n], // expiry − 1 = grace end
      [0n, 5_000n], // no expiry of its own
    ]) {
      expect(lastFillableMoment(e, g)).toBe(appLastFillableMoment(e, g));
    }
    expect(DEADLINE).toBe(GRACE_END);
    const w = permitDeadlineWindow(1_000_000n, 10n ** 12n);
    expect(w.earliest).toBe(1_000_000n - ANCHOR_LAG_SEC + REQUEST_WINDOW_SEC - 1n);
    expect(w.latest).toBe(1_000_000n + ANCHOR_WINDOW_SEC + REQUEST_WINDOW_SEC - 1n);
    expect(permitDeadlineWindow(1_000_000n, 2_000_000n)).toEqual({ earliest: 2_000_000n, latest: 2_000_000n });
    expect(permitDeadlineWindow(null, 1n)).toBeNull();
  });

  it('accepts the app’s whole borrower sequence, in order, once', async () => {
    const plan = borrowerPlan();
    expect(plan.steps().map((st) => `${st.id}${st.optional ? '?' : ''}`)).toEqual([
      'b-caps?',
      'b-permit2-reset?',
      'b-permit2-set?',
      'b-create',
      'b-permit',
      'b-attach',
      'l-sign',
      'l-approve-reset?',
      'l-approve-set?',
      'l-accept',
    ]);
    expect(offer(plan, 'tx', approve(PERMIT2_ADDRESS, 0n)).ok).toBe(true);
    expect(offer(plan, 'tx', approve(PERMIT2_ADDRESS, SHARE)).ok).toBe(true);
    expect(offer(plan, 'tx', createOffer()).ok).toBe(true);
    const permit = await permitRequest();
    expect(structMismatches(plan.steps()[4].expected(), permit.actual)).toEqual([]);
    expect(offer(plan, 'typed', permit).ok).toBe(true);
    expect(offer(plan, 'tx', attach()).ok).toBe(true);
    expect(plan.steps().filter((st) => st.role === 'borrower').map((st) => st.status)).toEqual([
      'skipped',
      'consumed',
      'consumed',
      'consumed',
      'consumed',
      'consumed',
    ]);
    // A second attach is refused: the step is consumed.
    expect(offer(plan, 'tx', attach()).ok).toBe(false);
  });

  it('skips the Permit2 approval when the allowance already covers the share', async () => {
    const plan = borrowerPlan();
    expect(offer(plan, 'tx', createOffer()).ok).toBe(true);
    expect(offer(plan, 'typed', await permitRequest()).ok).toBe(true);
    expect(offer(plan, 'tx', attach()).ok).toBe(true);
  });

  it('refuses the retired approval of the Diamond', () => {
    const r = offer(borrowerPlan(), 'tx', approve(DIAMOND, SHARE));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/spender/);
  });

  it('bounds the Permit2 approval by the share at the earliest and latest deadline', () => {
    const bounds = { floor: SHARE - 10n, cap: SHARE + 10n };
    expect(offer(borrowerPlan({ bounds }), 'tx', approve(PERMIT2_ADDRESS, bounds.floor - 1n)).ok).toBe(false);
    expect(offer(borrowerPlan({ bounds }), 'tx', approve(PERMIT2_ADDRESS, bounds.cap + 1n)).ok).toBe(false);
    expect(offer(borrowerPlan({ bounds }), 'tx', approve(PERMIT2_ADDRESS, bounds.floor)).ok).toBe(true);
    // Unread bounds refuse rather than guess.
    expect(offer(borrowerPlan({ bounds: null }), 'tx', approve(PERMIT2_ADDRESS, SHARE)).ok).toBe(false);
  });

  it('refuses a reset that is not followed by its set', () => {
    const plan = borrowerPlan();
    expect(offer(plan, 'tx', approve(PERMIT2_ADDRESS, 0n)).ok).toBe(true);
    expect(offer(plan, 'tx', createOffer()).ok).toBe(false);
  });

  /** A plan advanced to the permit signature. */
  function atPermit(opts) {
    const plan = borrowerPlan(opts);
    expect(offer(plan, 'tx', createOffer()).ok).toBe(true);
    return plan;
  }

  it('pins the permit to the request, the deadline and the contract’s share, exactly', async () => {
    const wrongRequest = offer(atPermit(), 'typed', await permitRequest({ offerId: 45n }));
    expect(wrongRequest.ok).toBe(false);
    expect(wrongRequest.why).toMatch(/witness\.offerId: "45" \(want 46\)/);
    const short = offer(atPermit(), 'typed', await permitRequest({ maxAmount: SHARE - 1n }));
    expect(short.why).toMatch(/permitted\.amount/);
    const early = offer(atPermit(), 'typed', await permitRequest({ deadline: DEADLINE - 1n }));
    expect(early.why).toMatch(/message\.deadline/);
    const spender = offer(atPermit(), 'typed', await permitRequest({ diamond: LENDER }));
    expect(spender.why).toMatch(/message\.spender/);
    const token = offer(atPermit(), 'typed', await permitRequest({ token: LOAN.collateralAsset }));
    expect(token.why).toMatch(/permitted\.token/);
    const otherLoan = offer(atPermit(), 'typed', await permitRequest({ loanId: 23n }));
    expect(otherLoan.why).toMatch(/witness\.loanId/);
    const chain = offer(atPermit(), 'typed', await permitRequest({ chainId: 1 }));
    expect(chain.why).toMatch(/domain\.chainId/);
  });

  it('refuses the permit while its figures are unknown, and requires it after the request', async () => {
    const r = offer(atPermit({ permit: null }), 'typed', await permitRequest());
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/b-permit cannot be judged yet/);
    // The attach cannot pass over the signature, and the lender cannot pass
    // over either borrower step.
    expect(offer(atPermit(), 'tx', attach()).ok).toBe(false);
    const plan = atPermit();
    plan.arm('lender');
    expect(plan.offer('lender', 'typed', {}).why).toMatch(/b-permit expects borrower typed/);
  });

  it('binds the attach call to exactly the signed permit', async () => {
    const plan = atPermit();
    expect(offer(plan, 'typed', await permitRequest()).ok).toBe(true);
    const r = offer(plan, 'tx', attach({ nonce: NONCE + 1n }));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/data\.args\.nonce/);
    const plan2 = atPermit();
    expect(offer(plan2, 'typed', await permitRequest()).ok).toBe(true);
    expect(offer(plan2, 'tx', attach({ signature: `0x${'ee'.repeat(65)}` })).why).toMatch(/data\.args\.signature/);
  });

  it('carries no Permit2 step when the wallet share is zero, and needs that stated', () => {
    const plan = borrowerPlan({ permitNeeded: false });
    expect(plan.steps().map((st) => st.id)).toEqual(['b-caps', 'b-create', 'l-sign', 'l-approve-reset', 'l-approve-set', 'l-accept']);
    expect(offer(plan, 'tx', approve(PERMIT2_ADDRESS, 1n)).ok).toBe(false);
    const { permitNeeded: _omit, ...args } = { ...TERMS_ARGS, ...NO_PERMIT_YET };
    expect(() =>
      refinancePlanSteps({ ...args, abi: ABI, chainId: CHAIN, diamond: DIAMOND, borrowerAnchor: () => ANCHOR, lenderAnchor: () => NOW, requestId: () => null, signedAcceptTerms: () => null }),
    ).toThrow(/permitNeeded/);
  });

  it('expects the permit’s nonce to be random, any uint256', async () => {
    const exp = expectedPayoffPermitTypedData({ chainId: CHAIN, diamond: DIAMOND, signer: BORROWER, token: LOAN.principalAsset, maxAmount: SHARE, deadline: DEADLINE, loanId: 22n, offerId: REQUEST_ID });
    expect(structMismatches(exp, (await permitRequest({ nonce: 0n })).actual)).toEqual([]);
    expect(structMismatches(exp, (await permitRequest({ nonce: 2n ** 256n - 1n })).actual)).toEqual([]);
  });
});

describe('refinanceExpected — the transaction deadline window (#3412)', () => {
  it('restates the shared window exactly', () => {
    expect(TX_DEADLINE_SEC).toBe(BigInt(TX_DEADLINE_SECONDS));
  });

  it('refuses a createOffer whose deadline is not the app\u2019s chain-time window', () => {
    const call = expectedCreateOfferCall({ loan: LOAN, loanId: 22n, rateBps: 1200n, days: 30n, anchor: () => NOW });
    const params = { ...call.args.params, expiresAt: NOW + REQUEST_WINDOW_SEC };
    const actual = (validUntil) => ({ functionName: 'createOffer', args: { params, validUntil } });
    expect(structMismatches(call, actual(NOW + TX_DEADLINE_SEC))).toEqual([]);
    // A deadline a day out is not the reviewed window.
    expect(structMismatches(call, actual(NOW + DAY))).not.toEqual([]);
    // Nor is a missing one.
    expect(structMismatches(call, { functionName: 'createOffer', args: { params } })).not.toEqual([]);
  });
});
