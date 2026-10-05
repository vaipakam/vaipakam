/**
 * THE COMPLETE EXPECTED PAYLOADS FOR A LIVE REFINANCE (#2422 r2).
 *
 * `live-refinance.mjs` signs on two funded dev wallets. Its write gate
 * refuses any signing request that is not, field for field, one of the
 * objects built here. Each builder returns the WHOLE payload — every field
 * of every struct — so `structMismatches` (expectedPayload.mjs) can compare
 * closed in both directions: a field missing from the request, a field
 * carrying a different value, or a field these builders do not name is a
 * refusal. Nothing is hand-picked, so nothing can be forgotten.
 *
 * WHERE THE VALUES COME FROM. From the loan being refinanced and the terms
 * the drive types into the form — the INTENT — never from what the page
 * happens to send. Each derivation is stated next to its field. A value the
 * drive can bound but not predict uses a matcher that states its rule (a
 * random nonce, a deadline relative to chain time, an approval capped from
 * above); everything else is exact.
 *
 * Pure (only viem's pure encoding helpers) and parameterised on `nowSec`,
 * so `refinanceExpected.test.mjs` can pin the shapes without a chain.
 */
import { decodeFunctionData, encodeAbiParameters, keccak256, toFunctionSelector } from 'viem';

import { is, optional } from './expectedPayload.mjs';

export const ZERO_HASH = `0x${'0'.repeat(64)}`;
/** RefinanceFlow's REQUEST_WINDOW_DAYS — the request's own expiry window. */
export const REQUEST_WINDOW_SEC = 30n * 86_400n;
/** useAcceptTerms' ACCEPT_DEADLINE_SECONDS — the signed terms' lifetime. */
export const ACCEPT_DEADLINE_SEC = 30n * 60n;
/** Local clock vs block time, in either direction. */
export const CLOCK_SLACK_SEC = 900n;

/** A timestamp within CLOCK_SLACK_SEC of `centre()`, evaluated at check time. */
export function near(desc, centre) {
  return is(`${desc} (±${CLOCK_SLACK_SEC}s)`, (v) => {
    const x = BigInt(v);
    const c = centre();
    return x >= c - CLOCK_SLACK_SEC && x <= c + CLOCK_SLACK_SEC;
  });
}

/** A non-zero approval amount of at most `cap`. */
export function approvalUpTo(cap, why) {
  return is(`0 < amount ≤ ${cap} (${why})`, (v) => {
    const x = BigInt(v);
    return x > 0n && x <= cap;
  });
}

/**
 * Fields of a transaction REQUEST that are not part of what it does.
 * `driver.mjs`'s injected wallet forwards only `to`, `data`, `value` and
 * `gas` (a limit: it can make the call fail, never make it do something
 * else); fee fields, nonce and type are chosen by the wallet itself and
 * ignored if supplied. Named here, rather than ignored implicitly, so any
 * OTHER field a page adds is still refused.
 */
const ENVELOPE_INERT = is('any — the injected wallet does not act on it', () => true);

/**
 * A whole `eth_sendTransaction` request, with `data` replaced by its
 * decoded call (see `decodeTxForComparison`).
 */
export function expectedTx({ from, to, call, chainId }) {
  return {
    from: optional(from), // absent ⇒ the injected wallet signs as itself, which is `from`
    to,
    data: call,
    value: optional(0n),
    chainId: optional(chainId),
    gas: optional(ENVELOPE_INERT),
    gasPrice: optional(ENVELOPE_INERT),
    maxFeePerGas: optional(ENVELOPE_INERT),
    maxPriorityFeePerGas: optional(ENVELOPE_INERT),
    nonce: optional(ENVELOPE_INERT),
    type: optional(ENVELOPE_INERT),
  };
}

/** `{ functionName, args: { <name>: value } }` for calldata against `abi`,
 *  or the raw data string when it decodes to nothing in `abi` (which then
 *  fails any comparison against an expected call object). */
export function namedCall(abi, data) {
  let d;
  try {
    d = decodeFunctionData({ abi, data });
  } catch {
    return data;
  }
  const selector = String(data).slice(0, 10).toLowerCase();
  const item = abi.find(
    (e) => e.type === 'function' && e.name === d.functionName && toFunctionSelector(e) === selector,
  );
  const args = {};
  (item?.inputs ?? []).forEach((input, i) => {
    args[input.name || `arg${i}`] = d.args?.[i];
  });
  return { functionName: d.functionName, args };
}

/** The transaction request with `data` decoded against the ABI of its target. */
export function decodeTxForComparison(tx, abiFor) {
  const abi = abiFor(tx?.to);
  return { ...tx, data: abi ? namedCall(abi, tx.data) : tx?.data };
}

// ---------------------------------------------------------------------
// Borrower — posting the refinance request.
// ---------------------------------------------------------------------

/** `setAutoRefinanceCaps(loanId, enabled, maxRateBps, maxNewExpiry)` as the
 *  form writes it: guardrails ON at the typed ceiling, with an end-date
 *  window of the new length plus the request window from now. */
export function expectedCapsCall({ loanId, rateBps, days, nowSec }) {
  return {
    functionName: 'setAutoRefinanceCaps',
    args: {
      loanId,
      enabled: true,
      maxRateBps: rateBps,
      maxNewExpiry: near('now + new length + 30d', () => nowSec() + days * 86_400n + REQUEST_WINDOW_SEC),
    },
  };
}

/**
 * ERC-20 `approve(spender, amount)`. Two shapes, because the app's
 * `ensureAllowance` sends two: when a NON-ZERO allowance below the needed
 * figure is left over it first resets to exactly 0 (tokens like mainnet
 * USDT revert a non-zero→non-zero approve), then sets the new amount.
 * `reset: true` is that first write; otherwise the amount is bounded.
 */
export function expectedApproveCall({ spender, cap, why, reset = false }) {
  return {
    functionName: 'approve',
    args: { spender, amount: reset ? 0n : approvalUpTo(cap, why) },
  };
}

/**
 * `createOffer(params)` — the refinance request, every one of the 26
 * fields of `CreateOfferParams`:
 *   - the loan's principal asset and amount (amountMax too — a request is
 *     taken whole, fillMode 1 = all-or-nothing);
 *   - the loan's collateral identity verbatim (asset, amount, amountMax,
 *     type, tokenId, quantity) — that is what selects carry-over;
 *   - the loan's prepay asset, partial-repay and interest-mode flags;
 *   - rate FLOOR 0 and CEILING = the typed rate: a borrow request is a
 *     0..ceiling band by design (Offers.tsx), and loan 22's request #45
 *     persisted exactly that;
 *   - the typed length; ERC-20 with tokenId 0 and quantity 1;
 *   - the borrower's consent (ticked in the review); no cadence, prepay
 *     listing or parallel sale; the refinance tag for THIS loan;
 *   - an expiry about the request window out.
 */
export function expectedCreateOfferCall({ loan, loanId, rateBps, days, nowSec }) {
  return {
    functionName: 'createOffer',
    args: {
      params: {
        offerType: 1,
        lendingAsset: loan.principalAsset,
        amount: loan.principal,
        interestRateBps: 0n,
        collateralAsset: loan.collateralAsset,
        collateralAmount: loan.collateralAmount,
        durationDays: days,
        assetType: 0,
        tokenId: 0n,
        quantity: 1n,
        creatorRiskAndTermsConsent: true,
        prepayAsset: loan.prepayAsset,
        collateralAssetType: Number(loan.collateralAssetType),
        collateralTokenId: loan.collateralTokenId,
        collateralQuantity: loan.collateralQuantity,
        allowsPartialRepay: loan.allowsPartialRepay,
        amountMax: loan.principal,
        interestRateBpsMax: rateBps,
        collateralAmountMax: loan.collateralAmount,
        periodicInterestCadence: 0,
        expiresAt: near('now + 30d', () => nowSec() + REQUEST_WINDOW_SEC),
        fillMode: 1,
        allowsPrepayListing: false,
        allowsParallelSale: false,
        refinanceTargetLoanId: loanId,
        useFullTermInterest: loan.useFullTermInterest,
      },
    },
  };
}

// ---------------------------------------------------------------------
// Lender — accepting it.
// ---------------------------------------------------------------------

/** The AcceptTerms EIP-712 field list, read from the compiled ABI's
 *  `acceptOffer` terms struct rather than restated, so the expected type
 *  list cannot drift from the contract's. */
export function acceptTermsTypes(abi) {
  const fn = abi.find(
    (e) => e.type === 'function' && e.name === 'acceptOffer' && e.inputs?.[1]?.name === 'terms',
  );
  const components = fn?.inputs?.[1]?.components;
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('acceptOffer(…, terms, …) not found in the Diamond ABI');
  }
  return components.map((c) => ({ name: c.name, type: c.type }));
}

/**
 * The complete AcceptTerms a lender signs for THIS request, every field:
 *   - acceptor = the accepting lender; offerCreator = the borrower;
 *   - offerKey = keccak256(abi.encode(requestId)) — a direct accept's key;
 *   - the request's own terms as posted (see `expectedCreateOfferCall`),
 *     with the RATE at the ceiling — a lender accepting an ERC-20 borrow
 *     request binds `interestRateBpsMax`, and the amount at `amount`;
 *   - no sale/offset link (linkedLoanId 0, zero parallel-sale hash);
 *   - the lender's consent, acknowledging BOTH legs as possibly illiquid
 *     (the app acknowledges both by design);
 *   - riskTermsHash = the Diamond's current one (read before any write);
 *   - the Full VPFI tariff OFF: acceptorFull false, ceiling 0, no
 *     downgrade — the review's opt-in is left untouched, so anything else
 *     means the page signed a tariff the drive did not choose;
 *   - nonce: random by design, so any non-zero uint256; deadline: about
 *     30 minutes past chain time.
 * `pinned` replaces the nonce and deadline matchers with exact values —
 * used for the accept CALL, whose terms must be exactly the ones signed.
 */
export function expectedAcceptTerms({
  loan,
  loanId,
  requestId,
  lender,
  borrower,
  rateBps,
  days,
  riskTermsHash,
  nowSec,
  pinned,
}) {
  return {
    acceptor: lender,
    offerCreator: borrower,
    offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [requestId])),
    offerType: 1,
    lendingAsset: loan.principalAsset,
    collateralAsset: loan.collateralAsset,
    amount: loan.principal,
    collateralAmount: loan.collateralAmount,
    interestRateBps: rateBps,
    durationDays: days,
    tokenId: 0n,
    collateralTokenId: loan.collateralTokenId,
    quantity: 1n,
    collateralQuantity: loan.collateralQuantity,
    assetType: 0,
    collateralAssetType: Number(loan.collateralAssetType),
    prepayAsset: loan.prepayAsset,
    useFullTermInterest: loan.useFullTermInterest,
    allowsPartialRepay: loan.allowsPartialRepay,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: loanId,
    linkedLoanId: 0n,
    parallelSaleOrderHash: ZERO_HASH,
    periodicInterestCadence: 0,
    riskAndTermsConsent: true,
    acknowledgedIlliquidLendingAsset: loan.principalAsset,
    acknowledgedIlliquidCollateralAsset: loan.collateralAsset,
    nonce: pinned
      ? pinned.nonce
      : is('a non-zero uint256 (drawn at random by the app)', (v) => BigInt(v) > 0n),
    deadline: pinned
      ? pinned.deadline
      : near('chain time + 30 min', () => nowSec() + ACCEPT_DEADLINE_SEC),
    riskTermsHash,
    acceptorFull: false,
    acceptorMaxCStar: 0n,
    acceptorAllowFullDowngrade: false,
  };
}

/** The whole `eth_signTypedData_v4` request: signer + the typed data. */
export function expectedAcceptTypedData({ abi, chainId, diamond, signer, terms }) {
  return {
    signer,
    typedData: {
      domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId, verifyingContract: diamond },
      types: {
        EIP712Domain: optional([
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ]),
        AcceptTerms: acceptTermsTypes(abi),
      },
      primaryType: 'AcceptTerms',
      message: terms,
    },
  };
}

/** `acceptOffer(offerId, terms, signature)` carrying exactly what was signed. */
export function expectedAcceptOfferCall({ requestId, terms, signature }) {
  return { functionName: 'acceptOffer', args: { offerId: requestId, terms, signature } };
}

// ---------------------------------------------------------------------
// The whole drive's write plan, in order (#2422 r3).
// ---------------------------------------------------------------------

/**
 * Every signing step the refinance drive may take, in the order the app
 * takes them, each with its complete expected object. Consumed by
 * `createWritePlan` (writePlan.mjs), which allows a request only if it
 * matches the NEXT unconsumed step.
 *
 * The order is the app's, read from its source and confirmed by the
 * 2026-10-05 run on loan 22:
 *   borrower (RefinanceFlow.submit): setAutoRefinanceCaps — OPTIONAL, the
 *     form skips it when the loan's caps already cover the reviewed terms;
 *     then `ensureAllowance` — an OPTIONAL reset to 0 (only when a non-zero
 *     allowance below the payoff bound is left over) and an OPTIONAL set
 *     (skipped when the allowance already covers it); then createOffer.
 *   lender (OfferFlow accept): the AcceptTerms signature FIRST (the review
 *     lists "Sign the terms" before "Approve"), then the same optional
 *     reset / set pair for the principal, then acceptOffer.
 *
 * `requestId()` returns the request's id once phase 2 has pinned it (null
 * before, which refuses the lender's steps); `signedAcceptTerms()` returns
 * the consumed AcceptTerms step's record `{ params, signature }` once the
 * signature is back (null before, which refuses the accept call). The
 * accept CALL is then pinned to exactly the signed terms and signature.
 */
export function refinancePlanSteps({
  abi,
  chainId,
  diamond,
  loan,
  loanId,
  borrower,
  lender,
  rateBps,
  days,
  riskTermsHash,
  payoffApprovalCap,
  nowSec,
  requestId,
  signedAcceptTerms,
}) {
  const tx = (from, to, call) => expectedTx({ from, to, call, chainId });
  const termsArgs = (rid, pinned) => ({
    loan,
    loanId,
    requestId: rid,
    lender,
    borrower,
    rateBps,
    days,
    riskTermsHash,
    nowSec,
    pinned,
  });
  const approvePair = (role, who, cap, why) => [
    {
      id: `${role[0]}-approve-reset`,
      role,
      kind: 'tx',
      optional: true,
      purpose: 'approve(Diamond, 0) — reset of a leftover allowance',
      expected: tx(who, loan.principalAsset, expectedApproveCall({ spender: diamond, cap, why, reset: true })),
    },
    {
      id: `${role[0]}-approve-set`,
      role,
      kind: 'tx',
      optional: true,
      purpose: `approve(Diamond, ≤ ${cap}) — ${why}`,
      expected: tx(who, loan.principalAsset, expectedApproveCall({ spender: diamond, cap, why })),
    },
  ];
  return [
    {
      id: 'b-caps',
      role: 'borrower',
      kind: 'tx',
      optional: true,
      purpose: `setAutoRefinanceCaps(${loanId}, on, ${rateBps} bps)`,
      expected: tx(borrower, diamond, expectedCapsCall({ loanId, rateBps, days, nowSec })),
    },
    ...approvePair('borrower', borrower, payoffApprovalCap, 'the payoff bound'),
    {
      id: 'b-create',
      role: 'borrower',
      kind: 'tx',
      purpose: `createOffer(refinance of loan ${loanId})`,
      expected: tx(borrower, diamond, expectedCreateOfferCall({ loan, loanId, rateBps, days, nowSec })),
    },
    {
      id: 'l-sign',
      role: 'lender',
      kind: 'typed',
      purpose: 'sign AcceptTerms for the request',
      expected: () => {
        const rid = requestId();
        if (rid == null) return null;
        return expectedAcceptTypedData({ abi, chainId, diamond, signer: lender, terms: expectedAcceptTerms(termsArgs(rid)) });
      },
    },
    ...approvePair('lender', lender, loan.principal, 'the principal'),
    {
      id: 'l-accept',
      role: 'lender',
      kind: 'tx',
      purpose: 'acceptOffer(the request) with exactly the signed terms',
      expected: () => {
        const rid = requestId();
        const signed = signedAcceptTerms();
        if (rid == null || !signed?.signature || !signed?.params) return null;
        const message = JSON.parse(signed.params[1]).message;
        const terms = expectedAcceptTerms(
          termsArgs(rid, { nonce: BigInt(message.nonce), deadline: BigInt(message.deadline) }),
        );
        return tx(lender, diamond, expectedAcceptOfferCall({ requestId: rid, terms, signature: signed.signature }));
      },
    },
  ];
}

