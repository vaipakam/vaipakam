/**
 * THE COMPLETE EXPECTED PAYLOADS FOR SEEDING A REFINANCE-READY LOAN.
 *
 * `live-seed-illiquid-loan.mjs` originates ONE Active loan on Base Sepolia
 * through the deployed app — the fixture `live-refinance.mjs` needs, and
 * which that drive consumes (a successful refinance closes its loan, so
 * every run needs a fresh one). It signs on funded dev wallets, so it uses
 * the same write discipline as the refinance drive: every signing request
 * must equal, field for field, the NEXT step of one ordered plan
 * (`createWritePlan`, writePlan.mjs), whose steps are built here.
 *
 * WHAT IS SEEDED, and why that shape. A BORROW REQUEST, posted by the
 * borrower against ILLIQUID collateral (the faucet's tILQ), funded by a
 * different lender. That is the loan the refinance drive requires — Active,
 * illiquid collateral, both parties' consent, the `borrower` role as its
 * stored borrower, a lender other than the `lender` role — and it reaches
 * it through the app's own flows rather than a script, so every payload
 * signed is one the app itself built: the faucet mint, the borrower's
 * collateral approval and createOffer, the lender's AcceptTerms signature,
 * principal approval and acceptOffer. The lender side is the same
 * borrow-request accept the refinance drive already gates, which is why
 * the generic envelope and accept helpers are reused from
 * refinanceExpected.mjs rather than restated.
 *
 * WHERE THE VALUES COME FROM. The borrower's steps are built from the
 * INTENT — the terms the drive types into the form — through the app's own
 * borrower mapping (offerSchema.ts `toCreateOfferPayload`, stated field by
 * field below). The lender's AcceptTerms are built from the request's
 * STORED record, read at its create block — exactly what the app's
 * `useAcceptTerms` signs — and that record is itself first compared with
 * the intent (`requestRecordMismatches`), so a request the chain stored
 * differently from what was reviewed is caught before the lender is armed.
 *
 * Pure (viem's pure helpers only), so `seedLoanExpected.test.mjs` can pin
 * every shape and refusal without a chain or a browser.
 */
import { encodeAbiParameters, keccak256 } from 'viem';

import { is } from './expectedPayload.mjs';
import {
  ACCEPT_DEADLINE_SEC,
  afterAnchor,
  approvalBetween,
  expectedAcceptOfferCall,
  expectedAcceptTypedData,
  expectedApproveCall,
  expectedTx,
  ZERO_HASH,
} from './refinanceExpected.mjs';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** offerSchema.ts MAX_INTEREST_BPS — the form's rate cap. */
export const MAX_INTEREST_BPS = 10_000n;
/** Faucet.tsx ILLIQUID_UNITS — one press of the tILQ faucet, in whole units. */
export const FAUCET_ILLIQUID_UNITS = 1_000n;

/**
 * `mint(to, amount)` on the faucet token, as Faucet.tsx `mintErc20` sends
 * it: to the connected wallet itself, `ILLIQUID_UNITS` whole tokens at the
 * token's decimals. Anything else — another recipient, another amount — is
 * not the faucet press the plan allows.
 */
export function expectedFaucetMintCall({ to, decimals }) {
  return {
    functionName: 'mint',
    args: { to, amount: FAUCET_ILLIQUID_UNITS * 10n ** BigInt(decimals) },
  };
}

/**
 * The borrow request's `createOffer(params)`, all 26 fields of
 * `CreateOfferParams`, through offerSchema.ts' BORROWER mapping:
 *   - offerType 1; the typed principal as both `amount` and `amountMax`
 *     (single-value: a borrower's direct accept binds `amount`);
 *   - rate FLOOR 0 and CEILING = the typed rate (a borrower accepts any
 *     rate up to the ceiling);
 *   - the typed collateral as both `collateralAmount` and
 *     `collateralAmountMax`, ERC-20, tokenId 0, collateralQuantity 0 (the
 *     form's default — an ERC-20 leg carries no quantity);
 *   - the principal leg ERC-20, tokenId 0, quantity 1;
 *   - the borrower's consent (ticked on the review);
 *   - the form's defaults left untouched: no prepay asset, no partial
 *     repay, full-term interest ON, no cadence, Partial fill, GTC (expiry
 *     0), no prepay listing, no parallel sale, no refinance tag.
 */
export function expectedRequestCreateOfferCall(intent) {
  return { functionName: 'createOffer', args: { params: requestParams(intent) } };
}

/** The CreateOfferParams the intent maps to — shared by the createOffer
 *  call and the stored-record comparison, so the two cannot disagree. */
export function requestParams(intent) {
  return {
    offerType: 1,
    lendingAsset: intent.principalAsset,
    amount: intent.principal,
    interestRateBps: 0n,
    collateralAsset: intent.collateralAsset,
    collateralAmount: intent.collateralAmount,
    durationDays: intent.days,
    assetType: 0,
    tokenId: 0n,
    quantity: 1n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: ZERO_ADDRESS,
    collateralAssetType: 0,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: false,
    amountMax: intent.principal,
    interestRateBpsMax: intent.rateBps,
    collateralAmountMax: intent.collateralAmount,
    periodicInterestCadence: 0,
    expiresAt: 0n,
    fillMode: 0,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: true,
  };
}

const eqAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The request as the chain STORED it (`getOfferDetails` at its create
 * block) against the intent, for every field the createOffer set plus the
 * ones the protocol derives that this fixture depends on: the creator, an
 * open (unaccepted) request, and the collateral leg classified ILLIQUID —
 * the whole point of the fixture.
 *
 * `prepayAsset` is the one field the protocol may normalise: an ERC-20
 * request posted with no prepay asset is stored either with none or with
 * its own lending asset. Both are stated and accepted; anything else is a
 * mismatch.
 *
 * Returns a list of mismatch strings; empty means the record is the intent.
 */
export function requestRecordMismatches(intent, stored, { borrower }) {
  const out = [];
  const want = (name, ok, got, exp) => {
    if (!ok) out.push(`${name}: stored ${String(got)}, expected ${String(exp)}`);
  };
  const p = requestParams(intent);
  want('creator', eqAddr(stored.creator, borrower), stored.creator, borrower);
  want('accepted', stored.accepted === false, stored.accepted, false);
  want('collateralLiquidity', Number(stored.collateralLiquidity) === 1, stored.collateralLiquidity, '1 (Illiquid)');
  for (const k of [
    'offerType',
    'assetType',
    'collateralAssetType',
    'periodicInterestCadence',
    'fillMode',
  ]) {
    want(k, Number(stored[k]) === Number(p[k]), stored[k], p[k]);
  }
  for (const k of [
    'amount',
    'amountMax',
    'interestRateBps',
    'interestRateBpsMax',
    'collateralAmount',
    'collateralAmountMax',
    'durationDays',
    'tokenId',
    'quantity',
    'collateralTokenId',
    'collateralQuantity',
    'expiresAt',
    'refinanceTargetLoanId',
  ]) {
    want(k, BigInt(stored[k]) === BigInt(p[k]), stored[k], p[k]);
  }
  for (const k of [
    'creatorRiskAndTermsConsent',
    'allowsPartialRepay',
    'allowsPrepayListing',
    'allowsParallelSale',
    'useFullTermInterest',
  ]) {
    want(k, Boolean(stored[k]) === Boolean(p[k]), stored[k], p[k]);
  }
  for (const k of ['lendingAsset', 'collateralAsset']) {
    want(k, eqAddr(stored[k], p[k]), stored[k], p[k]);
  }
  want(
    'prepayAsset',
    eqAddr(stored.prepayAsset, ZERO_ADDRESS) || eqAddr(stored.prepayAsset, p.lendingAsset),
    stored.prepayAsset,
    `none or the lending asset ${p.lendingAsset}`,
  );
  // The fixture is ERC-20 → ERC-20 and posted with no tariff opt-in.
  want('creatorFull', Boolean(stored.creatorFull) === false, stored.creatorFull, false);
  return out;
}

/**
 * The complete AcceptTerms the lender signs for THIS request, every field,
 * mirroring useAcceptTerms.ts for a direct accept of an ERC-20 borrow
 * request (it builds them from the stored record `o`):
 *   - acceptor = the lender; offerCreator = the stored creator;
 *   - offerKey = keccak256(abi.encode(requestId)) — a direct accept's key;
 *   - the BORROWER-role endpoints: amount = `o.amount`, rate =
 *     `o.interestRateBpsMax` (the ceiling) — OfferAcceptFacet's
 *     `_bindTermsToOffer` reads those for an ERC-20 borrow request;
 *   - every other term verbatim from the stored record;
 *   - no sale/offset link (linkedLoanId 0); the stored parallel-sale hash;
 *   - consent, acknowledging BOTH legs as possibly illiquid (the app
 *     acknowledges both by design);
 *   - riskTermsHash = the Diamond's current one (read before any write);
 *   - the Full VPFI tariff OFF: the review's opt-in is left untouched;
 *   - nonce random (any non-zero uint256); deadline about 30 minutes past
 *     chain time at the lender's submit (`anchor`).
 * `pinned` replaces the nonce/deadline matchers with exact values — for the
 * accept CALL, whose terms must be exactly the ones signed.
 */
export function expectedRequestAcceptTerms({ requestId, stored, lender, riskTermsHash, anchor, pinned }) {
  return {
    acceptor: lender,
    offerCreator: stored.creator,
    offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [requestId])),
    offerType: Number(stored.offerType),
    lendingAsset: stored.lendingAsset,
    collateralAsset: stored.collateralAsset,
    amount: BigInt(stored.amount),
    collateralAmount: BigInt(stored.collateralAmount),
    interestRateBps: BigInt(stored.interestRateBpsMax),
    durationDays: BigInt(stored.durationDays),
    tokenId: BigInt(stored.tokenId),
    collateralTokenId: BigInt(stored.collateralTokenId),
    quantity: BigInt(stored.quantity),
    collateralQuantity: BigInt(stored.collateralQuantity),
    assetType: Number(stored.assetType),
    collateralAssetType: Number(stored.collateralAssetType),
    prepayAsset: stored.prepayAsset,
    useFullTermInterest: Boolean(stored.useFullTermInterest),
    allowsPartialRepay: Boolean(stored.allowsPartialRepay),
    allowsPrepayListing: Boolean(stored.allowsPrepayListing),
    allowsParallelSale: Boolean(stored.allowsParallelSale),
    refinanceTargetLoanId: BigInt(stored.refinanceTargetLoanId),
    linkedLoanId: 0n,
    parallelSaleOrderHash: stored.parallelSaleOrderHash ?? ZERO_HASH,
    periodicInterestCadence: Number(stored.periodicInterestCadence),
    riskAndTermsConsent: true,
    acknowledgedIlliquidLendingAsset: stored.lendingAsset,
    acknowledgedIlliquidCollateralAsset: stored.collateralAsset,
    nonce: pinned
      ? pinned.nonce
      : is('a non-zero uint256 (drawn at random by the app)', (v) => BigInt(v) > 0n),
    deadline: pinned
      ? pinned.deadline
      : afterAnchor('accept deadline', anchor, ACCEPT_DEADLINE_SEC),
    riskTermsHash,
    acceptorFull: false,
    acceptorMaxCStar: 0n,
    acceptorAllowFullDowngrade: false,
  };
}

/**
 * Every signing step the seed may take, in the app's order, each with its
 * complete expected object:
 *
 *   borrower, faucet   b-mint?            — skipped when the borrower
 *                                            already holds the collateral
 *                                            (the drive then never presses
 *                                            the faucet; `needsMint` false
 *                                            leaves the step out entirely)
 *   borrower, post     b-approve-reset? → b-approve-set? → b-create
 *   lender, fund       l-sign → l-approve-reset? → l-approve-set? → l-accept
 *
 * The approval pairs mirror erc20.ts `ensureAllowance`: nothing when the
 * allowance already covers the pull, a reset to 0 only for a leftover
 * non-zero allowance below it, then EXACTLY the pull — the collateral for
 * the borrower (createOffer escrows it), the principal for the lender. A
 * reset must be followed by its set (`requires`).
 *
 * `requestId()` / `storedRequest()` return the request's id and stored
 * record once the create step has been pinned (null before, which refuses
 * every lender step); `signedAcceptTerms()` returns the consumed l-sign
 * record `{ params, signature }` (null before, which refuses the accept) —
 * the same convention as refinanceExpected.mjs `refinancePlanSteps`.
 */
export function seedPlanSteps({
  abi,
  chainId,
  diamond,
  intent,
  collateralDecimals,
  needsMint,
  borrower,
  lender,
  riskTermsHash,
  lenderAnchor,
  requestId,
  storedRequest,
  signedAcceptTerms,
}) {
  const tx = (from, to, call) => expectedTx({ from, to, call, chainId });
  const approvePair = (prefix, role, who, token, amount, why) => [
    {
      id: `${prefix}-approve-reset`,
      role,
      kind: 'tx',
      optional: true,
      requires: `${prefix}-approve-set`,
      purpose: `approve(Diamond, 0) on ${why} — reset of a leftover allowance`,
      expected: tx(who, token, expectedApproveCall({ spender: diamond, why, reset: true })),
    },
    {
      id: `${prefix}-approve-set`,
      role,
      kind: 'tx',
      optional: true,
      purpose: `approve(Diamond, exactly ${amount}) on ${why}`,
      expected: tx(who, token, {
        functionName: 'approve',
        args: { spender: diamond, amount: approvalBetween(amount, amount, why) },
      }),
    },
  ];
  const termsFor = (pinned) => {
    const rid = requestId();
    const stored = storedRequest();
    if (rid == null || stored == null) return null;
    return expectedRequestAcceptTerms({
      requestId: rid,
      stored,
      lender,
      riskTermsHash,
      anchor: lenderAnchor,
      pinned,
    });
  };
  return [
    ...(needsMint
      ? [
          {
            id: 'b-mint',
            role: 'borrower',
            kind: 'tx',
            purpose: `faucet mint(${FAUCET_ILLIQUID_UNITS} tILQ) to the borrower`,
            expected: tx(borrower, intent.collateralAsset, expectedFaucetMintCall({ to: borrower, decimals: collateralDecimals })),
          },
        ]
      : []),
    ...approvePair('b', 'borrower', borrower, intent.collateralAsset, intent.collateralAmount, 'the collateral'),
    {
      id: 'b-create',
      role: 'borrower',
      kind: 'tx',
      purpose: 'createOffer(borrow request, illiquid collateral)',
      expected: tx(borrower, diamond, expectedRequestCreateOfferCall(intent)),
    },
    {
      id: 'l-sign',
      role: 'lender',
      kind: 'typed',
      purpose: 'sign AcceptTerms for the borrow request',
      expected: () => {
        const terms = termsFor(null);
        return terms && expectedAcceptTypedData({ abi, chainId, diamond, signer: lender, terms });
      },
    },
    ...approvePair('l', 'lender', lender, intent.principalAsset, intent.principal, 'the principal'),
    {
      id: 'l-accept',
      role: 'lender',
      kind: 'tx',
      purpose: 'acceptOffer(borrow request) with exactly the signed terms',
      expected: () => {
        const signed = signedAcceptTerms();
        const rid = requestId();
        if (rid == null || !signed?.signature || !signed?.params) return null;
        const message = JSON.parse(signed.params[1]).message;
        const terms = termsFor({ nonce: BigInt(message.nonce), deadline: BigInt(message.deadline) });
        return terms && tx(lender, diamond, expectedAcceptOfferCall({ requestId: rid, terms, signature: signed.signature }));
      },
    },
  ];
}
