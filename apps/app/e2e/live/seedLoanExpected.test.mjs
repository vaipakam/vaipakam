/**
 * The expected payloads `live-seed-illiquid-loan.mjs` arms its write gate
 * with. The live seed's happy path cannot exercise a refusal, so the
 * refusals that matter are pinned here — and the borrower's createOffer is
 * pinned to the APP's own mapping (`toCreateOfferPayload`), so the gate
 * cannot drift from what the form actually sends.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, parseUnits } from 'viem';

import { initialOfferForm, toCreateOfferPayload } from '../../src/lib/offerSchema';
import { structMismatches } from './expectedPayload.mjs';
import { acceptTermsTypes, decodeTxForComparison, ZERO_HASH } from './refinanceExpected.mjs';
import {
  expectedFaucetMintCall,
  expectedRequestAcceptTerms,
  requestParams,
  requestRecordMismatches,
  seedPlanSteps,
  ZERO_ADDRESS,
} from './seedLoanExpected.mjs';
import { createWritePlan } from './writePlan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(
  fs.readFileSync(path.join(HERE, '../../../../packages/contracts/src/diamondAbi.json'), 'utf8'),
);
const CHAIN_ID = 84532;
const DIAMOND = '0x2535baC87F3df287268fC697F2f31cf418365303';
const BORROWER = '0xC86BB89f8ddF703c34724Cf11137498bC69F039D';
const LENDER = '0x648897f2c549956eFfF626D57fBc3E39761e6792';
const WETH = '0x4200000000000000000000000000000000000006';
const TILQ = '0xa3beBf673f7b16d88295930193d7dbd80C8f8664';
const NOW = 1_792_000_000n;
const INTENT = {
  principalAsset: WETH,
  principal: parseUnits('0.0001', 18),
  collateralAsset: TILQ,
  collateralAmount: parseUnits('100', 18),
  rateBps: 1000n,
  days: 30n,
};
/** The faucet token is a plain ERC-20 plus Faucet.tsx's `mint(to, amount)`. */
const FAUCET_ABI = [
  ...erc20Abi,
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
];
const abiFor = (to) => (String(to).toLowerCase() === DIAMOND.toLowerCase() ? ABI : FAUCET_ABI);

/** The request as `getOfferDetails` would return it after our createOffer. */
function storedRequest(over = {}) {
  return {
    ...requestParams(INTENT),
    id: 7n,
    creator: BORROWER,
    accepted: false,
    principalLiquidity: 0,
    collateralLiquidity: 1,
    prepayAsset: ZERO_ADDRESS,
    parallelSaleOrderHash: ZERO_HASH,
    creatorFull: false,
    ...over,
  };
}

const tx = (from, to, abi, functionName, args) => ({
  from,
  to,
  data: encodeFunctionData({ abi, functionName, args }),
});

describe('seedLoanExpected — the borrow request is the app’s own payload', () => {
  it('equals toCreateOfferPayload for the borrower form the drive fills in', () => {
    const app = toCreateOfferPayload(
      {
        ...initialOfferForm,
        offerType: 'borrower',
        lendingAsset: WETH,
        amount: '0.0001',
        interestRate: '10',
        collateralAsset: TILQ,
        collateralAmount: '100',
        durationDays: '30',
        riskAndTermsConsent: true,
      },
      { lending: 18, collateral: 18 },
    );
    // Same keys, same values — numbers on the app side are the enum and
    // uint fields the ABI encodes identically.
    const ours = requestParams(INTENT);
    expect(Object.keys(ours).sort()).toEqual(Object.keys(app).sort());
    const norm = (o) =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k, typeof v === 'number' || typeof v === 'bigint' ? BigInt(v) : v]),
      );
    expect(norm(ours)).toEqual(norm(app));
  });

  it('covers every field of CreateOfferParams in the ABI', () => {
    const fn = ABI.find((e) => e.type === 'function' && e.name === 'createOffer');
    const fields = fn.inputs[0].components.map((c) => c.name).sort();
    expect(Object.keys(requestParams(INTENT)).sort()).toEqual(fields);
  });
});

describe('seedLoanExpected — the stored record must be the intent', () => {
  it('accepts the record our createOffer produces, with either prepay normalisation', () => {
    expect(requestRecordMismatches(INTENT, storedRequest(), { borrower: BORROWER })).toEqual([]);
    expect(requestRecordMismatches(INTENT, storedRequest({ prepayAsset: WETH }), { borrower: BORROWER })).toEqual([]);
  });

  it('refuses a request whose collateral the chain classified LIQUID — the fixture would be wrong', () => {
    expect(requestRecordMismatches(INTENT, storedRequest({ collateralLiquidity: 0 }), { borrower: BORROWER })).toEqual([
      'collateralLiquidity: stored 0, expected 1 (Illiquid)',
    ]);
  });

  it('refuses another creator, an accepted request, or a foreign prepay asset', () => {
    const got = requestRecordMismatches(
      INTENT,
      storedRequest({ creator: LENDER, accepted: true, prepayAsset: TILQ }),
      { borrower: BORROWER },
    );
    expect(got).toHaveLength(3);
    expect(got[0]).toMatch(/^creator:/);
    expect(got[1]).toMatch(/^accepted:/);
    expect(got[2]).toMatch(/^prepayAsset:/);
  });
});

describe('seedLoanExpected — the AcceptTerms are a borrow request’s', () => {
  it('names every typed field, binding the amount and the CEILING rate', () => {
    const t = expectedRequestAcceptTerms({
      requestId: 7n,
      stored: storedRequest(),
      lender: LENDER,
      riskTermsHash: ZERO_HASH,
      anchor: () => NOW,
    });
    expect(Object.keys(t).sort()).toEqual(acceptTermsTypes(ABI).map((x) => x.name).sort());
    expect(t.amount).toBe(INTENT.principal);
    expect(t.interestRateBps).toBe(INTENT.rateBps);
    expect(t.acknowledgedIlliquidCollateralAsset).toBe(TILQ);
    expect(t.refinanceTargetLoanId).toBe(0n);
  });
});

describe('seedLoanExpected — the whole plan, in order', () => {
  function planFor({ needsMint }) {
    let requestId = null;
    let stored = null;
    let plan;
    const steps = seedPlanSteps({
      abi: ABI,
      chainId: CHAIN_ID,
      diamond: DIAMOND,
      intent: INTENT,
      collateralDecimals: 18,
      needsMint,
      borrower: BORROWER,
      lender: LENDER,
      riskTermsHash: ZERO_HASH,
      lenderAnchor: () => NOW,
      requestId: () => requestId,
      storedRequest: () => stored,
      signedAcceptTerms: () =>
        plan.steps().find((s) => s.id === 'l-sign' && s.status === 'consumed')?.record ?? null,
    });
    plan = createWritePlan(steps);
    return {
      plan,
      pin: (id) => {
        requestId = id;
        stored = storedRequest({ id });
      },
    };
  }
  const signedTerms = (nonce) =>
    expectedRequestAcceptTerms({
      requestId: 7n,
      stored: storedRequest(),
      lender: LENDER,
      riskTermsHash: ZERO_HASH,
      pinned: { nonce, deadline: NOW + 1_800n },
    });
  const typedParams = (terms) => [
    LENDER,
    JSON.stringify(
      {
        domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: CHAIN_ID, verifyingContract: DIAMOND },
        types: { AcceptTerms: acceptTermsTypes(ABI) },
        primaryType: 'AcceptTerms',
        message: terms,
      },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ),
  ];
  const typedActual = (params) => ({ signer: params[0], typedData: JSON.parse(params[1]) });
  const send = (t) => decodeTxForComparison(t, abiFor);

  it('allows mint → approve → create → sign → approve → accept, and nothing after', () => {
    const { plan, pin } = planFor({ needsMint: true });
    plan.arm('borrower');
    const mintTx = send(tx(BORROWER, TILQ, FAUCET_ABI, 'mint', [BORROWER, 1000n * 10n ** 18n]));
    expect(structMismatches(expectedFaucetMintCall({ to: BORROWER, decimals: 18 }), mintTx.data)).toEqual([]);
    expect(plan.offer('borrower', 'tx', mintTx).ok).toBe(true);
    expect(plan.offer('borrower', 'tx', send(tx(BORROWER, TILQ, erc20Abi, 'approve', [DIAMOND, INTENT.collateralAmount]))).ok).toBe(true);
    const params = requestParams(INTENT);
    expect(plan.offer('borrower', 'tx', send(tx(BORROWER, DIAMOND, ABI, 'createOffer', [params]))).ok).toBe(true);
    plan.close();

    // The lender cannot sign before the request is pinned.
    pin(7n);
    plan.arm('lender');
    const sigParams = typedParams(signedTerms(42n));
    const r = plan.offer('lender', 'typed', typedActual(sigParams));
    expect(r.ok).toBe(true);
    plan.record(r.index, { params: sigParams, signature: `0x${'ab'.repeat(65)}` });
    expect(plan.offer('lender', 'tx', send(tx(LENDER, WETH, erc20Abi, 'approve', [DIAMOND, INTENT.principal]))).ok).toBe(true);
    expect(
      plan.offer('lender', 'tx', send(tx(LENDER, DIAMOND, ABI, 'acceptOffer', [7n, signedTerms(42n), `0x${'ab'.repeat(65)}`]))).ok,
    ).toBe(true);
    expect(plan.complete()).toBe(true);
    // A second accept after the plan is complete is refused and latches.
    expect(plan.offer('lender', 'tx', {}).ok).toBe(false);
  });

  it('leaves the faucet step out when the borrower already holds the collateral', () => {
    const { plan } = planFor({ needsMint: false });
    expect(plan.steps().map((s) => s.id)).toEqual([
      'b-approve-reset',
      'b-approve-set',
      'b-create',
      'l-sign',
      'l-approve-reset',
      'l-approve-set',
      'l-accept',
    ]);
  });

  it('refuses an approval that is not EXACTLY the pull, and an accept on terms other than the signed ones', () => {
    const { plan } = planFor({ needsMint: false });
    plan.arm('borrower');
    // Twice the collateral: refused, and the plan latches.
    const over = plan.offer('borrower', 'tx', send(tx(BORROWER, TILQ, erc20Abi, 'approve', [DIAMOND, 2n * INTENT.collateralAmount])));
    expect(over.ok).toBe(false);

    const second = planFor({ needsMint: false });
    second.plan.arm('borrower');
    expect(second.plan.offer('borrower', 'tx', send(tx(BORROWER, DIAMOND, ABI, 'createOffer', [requestParams(INTENT)]))).ok).toBe(true);
    second.plan.close();
    second.pin(7n);
    second.plan.arm('lender');
    const sigParams = typedParams(signedTerms(42n));
    const r = second.plan.offer('lender', 'typed', typedActual(sigParams));
    second.plan.record(r.index, { params: sigParams, signature: `0x${'ab'.repeat(65)}` });
    // The accept carries a DIFFERENT nonce than the one signed.
    const bad = second.plan.offer(
      'lender',
      'tx',
      send(tx(LENDER, DIAMOND, ABI, 'acceptOffer', [7n, signedTerms(43n), `0x${'ab'.repeat(65)}`])),
    );
    expect(bad.ok).toBe(false);
    expect(bad.why).toMatch(/nonce/);
  });

  it('refuses a createOffer the form did not build (partial repay switched on)', () => {
    const { plan } = planFor({ needsMint: false });
    plan.arm('borrower');
    const r = plan.offer(
      'borrower',
      'tx',
      send(tx(BORROWER, DIAMOND, ABI, 'createOffer', [{ ...requestParams(INTENT), allowsPartialRepay: true }])),
    );
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/allowsPartialRepay/);
  });
});
