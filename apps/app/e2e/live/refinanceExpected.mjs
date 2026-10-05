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
 * Pure (only viem's pure encoding helpers) and parameterised on the anchors,
 * so `refinanceExpected.test.mjs` can pin the shapes without a chain.
 */
import { decodeFunctionData, encodeAbiParameters, keccak256, toFunctionSelector } from 'viem';

import { is, optional } from './expectedPayload.mjs';

export const ZERO_HASH = `0x${'0'.repeat(64)}`;
/** RefinanceFlow's REQUEST_WINDOW_DAYS — the request's own expiry window. */
export const REQUEST_WINDOW_SEC = 30n * 86_400n;
/** useAcceptTerms' ACCEPT_DEADLINE_SECONDS — the signed terms' lifetime. */
export const ACCEPT_DEADLINE_SEC = 30n * 60n;
/**
 * TIME WINDOWS ARE ANCHORED TO CHAIN TIME, NOT THE LOCAL CLOCK (#2422 r4).
 *
 * The app stamps every time-relative field from a CHAIN timestamp it reads
 * inside its own submit flow (`latestBlock.timestamp` in RefinanceFlow, and
 * `chainNow` in useAcceptTerms). The drive reads the chain's latest block
 * timestamp itself the moment it starts that flow (just before the click)
 * and calls that the ANCHOR. The app's own read happens AFTER the anchor,
 * so each stamped field must lie in
 *
 *     [anchor + offset − ANCHOR_LAG_SEC,  anchor + offset + ANCHOR_WINDOW_SEC]
 *
 *   - ANCHOR_LAG_SEC (5 min) allows the app's RPC node to sit a little
 *     BEHIND the node the drive read the anchor from;
 *   - ANCHOR_WINDOW_SEC (45 min) covers the drive's documented worst case
 *     between the anchor and the app's read — about 35 minutes end to end
 *     (Offer Book wait, posting, review and consent polls, receipt waits) —
 *     plus a 10-minute margin. It is deliberately the WHOLE drive's worst
 *     case: a sequence that takes longer than that is not the one reviewed.
 *
 * The anchor is a getter: until the drive has read it, the field cannot be
 * judged, and the request is refused rather than compared with a guess.
 */
export const ANCHOR_LAG_SEC = 5n * 60n;
export const ANCHOR_WINDOW_SEC = 45n * 60n;

/** A timestamp stamped by the app from chain time, `offset` after the anchor. */
export function afterAnchor(desc, anchor, offset) {
  return is(`${desc}: anchor + ${offset}s, −${ANCHOR_LAG_SEC}s … +${ANCHOR_WINDOW_SEC}s`, (v) => {
    const a = anchor();
    if (a == null) return false;
    const x = BigInt(v);
    return x >= a + offset - ANCHOR_LAG_SEC && x <= a + offset + ANCHOR_WINDOW_SEC;
  });
}

/**
 * An approval that COVERS the pull it exists for and goes no further
 * (#2422 r4 P2): `min ≤ amount ≤ max`, where `min` may be a getter for a
 * floor that depends on the anchor. An undersized approve — `approve(1)` —
 * is refused, because a request the payoff cannot actually be pulled for is
 * not the request that was reviewed.
 */
export function approvalBetween(min, max, why) {
  return is(`covers ${why}: floor ≤ amount ≤ ${max}`, (v) => {
    const floor = typeof min === 'function' ? min() : min;
    if (floor == null) return false;
    const x = BigInt(v);
    return x >= floor && x <= max && x > 0n;
  });
}

// ---------------------------------------------------------------------
// The payoff the borrower's approval must cover — a MIRROR of the app's own
// computation (apps/app/src/contracts/loanLive.ts), so the bound is what
// the reviewed flow requires, not a guess.
// ---------------------------------------------------------------------
const DAY = 86_400n;
const loanEndOf = (l) => l.startTime + l.durationDays * DAY;

/** `lateFeeAt`: 0 at/before maturity, then 1% + 0.5% per whole day late, ≤ 5%. */
export function lateFeeAt(l, ts) {
  const end = loanEndOf(l);
  if (ts <= end) return 0n;
  let bps = 100n + ((ts - end) / DAY) * 50n;
  if (bps > 500n) bps = 500n;
  return (l.principal * bps) / 10_000n;
}

/** `refinancePayoffOf`: principal + interest for max(elapsed whole days,
 *  remaining committed days) + the grace-window late fee. */
export function refinancePayoffAt(l, asOf) {
  const start = l.interestAccrualStart !== 0n ? l.interestAccrualStart : l.startTime;
  const elapsed = asOf > start ? (asOf - start) / DAY : 0n;
  const floorDays = l.interestAccrualStart !== 0n ? BigInt(l.interestRemainingDays) : l.durationDays;
  const days = elapsed > floorDays ? elapsed : floorDays;
  return l.principal + (l.principal * l.interestRateBps * days) / (365n * 10_000n) + lateFeeAt(l, asOf);
}

/** `defaultGraceSeconds` (apps/app/src/lib/grace.ts) — the table the app
 *  falls back to when the Diamond publishes no grace buckets, as Base
 *  Sepolia does today. */
export function defaultGraceSeconds(durationDays) {
  const d = BigInt(durationDays);
  if (d < 7n) return 3_600n;
  if (d < 30n) return DAY;
  if (d < 90n) return 3n * DAY;
  if (d < 180n) return 7n * DAY;
  if (d < 365n) return 14n * DAY;
  return 30n * DAY;
}

/** `readGraceSecondsLive`: the first matching `getGraceBuckets()` entry (a
 *  `maxDurationDays` of 0 is the catch-all; no match falls back to the last
 *  entry, as the contract does), or `defaultGraceSeconds` when the Diamond
 *  publishes no buckets at all. */
export function graceSecondsFrom(buckets, durationDays) {
  if (!Array.isArray(buckets) || buckets.length === 0) return defaultGraceSeconds(durationDays);
  for (const b of buckets) {
    if (b.maxDurationDays === 0n) return b.graceSeconds;
    if (BigInt(durationDays) < b.maxDurationDays) return b.graceSeconds;
  }
  return buckets[buckets.length - 1].graceSeconds;
}

/**
 * The borrower's payoff-approval bounds. The app approves
 * `refinanceApprovalOf` = the payoff at the request's last fillable moment:
 * min(expiresAt − 1, grace end), with expiresAt = its submit-time chain
 * time + REQUEST_WINDOW. Payoff only grows with time, so:
 *   - FLOOR: the payoff at min(anchor − LAG + REQUEST_WINDOW − 1, grace end)
 *     — the earliest the app's own clock could have put that moment;
 *   - CAP:   the payoff at the grace end — no request can be filled later.
 */
export function payoffApprovalBounds(l, graceSeconds, anchor) {
  const graceEnd = loanEndOf(l) + graceSeconds;
  return {
    floor: () => {
      const a = anchor();
      if (a == null) return null;
      const lastFillable = a - ANCHOR_LAG_SEC + REQUEST_WINDOW_SEC - 1n;
      return refinancePayoffAt(l, lastFillable < graceEnd ? lastFillable : graceEnd);
    },
    cap: refinancePayoffAt(l, graceEnd),
  };
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
export function expectedCapsCall({ loanId, rateBps, days, anchor }) {
  return {
    functionName: 'setAutoRefinanceCaps',
    args: {
      loanId,
      enabled: true,
      maxRateBps: rateBps,
      maxNewExpiry: afterAnchor('new length + 30d', anchor, days * 86_400n + REQUEST_WINDOW_SEC),
    },
  };
}

/**
 * ERC-20 `approve(spender, amount)`. Two shapes, because the app's
 * `ensureAllowance` sends two: when a NON-ZERO allowance below the needed
 * figure is left over it first resets to exactly 0 (tokens like mainnet
 * USDT revert a non-zero→non-zero approve), then sets the new amount.
 * `reset: true` is that first write; otherwise the amount must cover the
 * pull (`min`) without exceeding `max`.
 */
export function expectedApproveCall({ spender, min, max, why, reset = false }) {
  return {
    functionName: 'approve',
    args: { spender, amount: reset ? 0n : approvalBetween(min, max, why) },
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
export function expectedCreateOfferCall({ loan, loanId, rateBps, days, anchor }) {
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
        expiresAt: afterAnchor('request window', anchor, REQUEST_WINDOW_SEC),
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
  anchor,
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
      : afterAnchor('accept deadline', anchor, ACCEPT_DEADLINE_SEC),
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
  graceSeconds,
  borrowerAnchor,
  lenderAnchor,
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
    anchor: lenderAnchor,
    pinned,
  });
  const payoff = payoffApprovalBounds(loan, graceSeconds, borrowerAnchor);
  const approvePair = (role, who, min, max, why) => [
    {
      id: `${role[0]}-approve-reset`,
      role,
      kind: 'tx',
      optional: true,
      // A reset must be followed by its set: once the allowance has been
      // zeroed, nothing else may be signed until it is set again.
      requires: `${role[0]}-approve-set`,
      purpose: 'approve(Diamond, 0) — reset of a leftover allowance',
      expected: tx(who, loan.principalAsset, expectedApproveCall({ spender: diamond, why, reset: true })),
    },
    {
      id: `${role[0]}-approve-set`,
      role,
      kind: 'tx',
      optional: true,
      purpose: `approve(Diamond, covering ${why}, ≤ ${max})`,
      expected: tx(who, loan.principalAsset, expectedApproveCall({ spender: diamond, min, max, why })),
    },
  ];
  return [
    {
      id: 'b-caps',
      role: 'borrower',
      kind: 'tx',
      optional: true,
      purpose: `setAutoRefinanceCaps(${loanId}, on, ${rateBps} bps)`,
      expected: tx(borrower, diamond, expectedCapsCall({ loanId, rateBps, days, anchor: borrowerAnchor })),
    },
    ...approvePair('borrower', borrower, payoff.floor, payoff.cap, 'the payoff'),
    {
      id: 'b-create',
      role: 'borrower',
      kind: 'tx',
      purpose: `createOffer(refinance of loan ${loanId})`,
      expected: tx(borrower, diamond, expectedCreateOfferCall({ loan, loanId, rateBps, days, anchor: borrowerAnchor })),
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
    // The lender's pull is exactly the principal, so floor = cap = principal.
    ...approvePair('lender', lender, loan.principal, loan.principal, 'the principal'),
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

