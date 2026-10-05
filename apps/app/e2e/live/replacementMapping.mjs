/**
 * HOW EVERY FIELD OF THE REPLACEMENT LOAN IS CHECKED (#2422 r14, ROOT B).
 *
 * The replacement loan used to be checked field by field at call sites, and
 * each review round could find one more field nobody had looked at (the
 * interest mode, most recently). This module declares, for EVERY field of
 * `LibVaipakam.Loan`, exactly one way the replacement's value is checked:
 *
 *   signed   (a) — equals a term the parties SIGNED: the lender's AcceptTerms
 *                  message, or the request itself;
 *   carried  (b) — equals the old loan's value (carry-over);
 *   config   (c) — equals the reviewed watched-config value (the fee stamps);
 *   accept   (d) — equals a value the accept block determines (its timestamp,
 *                  the new id, Active, the accepting lender, a zero counter);
 *   unchecked(e) — not checked, with the reason; printed under NOT VERIFIED.
 *
 * `evaluateReplacement` runs the whole mapping and returns, per field, how it
 * was checked and what it held; `replacementMapping.test.mjs` fails unless
 * every field of the compiled ABI's Loan is mapped exactly once, and pins
 * the mapping to the real loan 23.
 *
 * ctx: { newLoanId, requestId, acceptor, acceptTs, terms (the signed
 *   AcceptTerms message), request (the request as created), oldLoan (at
 *   the block before the accept), reviewedConfig }
 */

const lc = (v) => String(v).toLowerCase();
/** Equality across the shapes a chain read, a typed-data message (strings)
 *  and a literal take: addresses case-insensitively, booleans as booleans,
 *  numbers as integers. */
export function sameValue(a, b) {
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  const isAddr = (x) => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
  if (isAddr(a) || isAddr(b)) return lc(a) === lc(b);
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return lc(a) === lc(b);
  }
}

const signed = (field, why) => ({ how: 'signed', expect: (c) => c.terms[field], why: why ?? `the AcceptTerms the lender signed (${field})` });
const fromRequest = (field, why) => ({ how: 'signed', expect: (c) => c.request[field], why });
const carried = (why) => ({ how: 'carried', expect: (c, f) => c.oldLoan[f], why });
const atAccept = (expect, why) => ({ how: 'accept', expect, why });
const unchecked = (why) => ({ how: 'unchecked', why });

export const REPLACEMENT_MAPPING = Object.freeze({
  id: atAccept((c) => c.newLoanId, 'the loan id the accept receipt’s OfferAccepted names'),
  offerId: fromRequest('id', 'the request the lender accepted'),
  lender: atAccept((c) => c.acceptor, 'the accepting lender — the AcceptTerms signer'),
  principalLiquidity: unchecked('stamped from checkLiquidity at the accept — external oracle / pool state, which no block isolation covers and the model does not depend on (#2422 r11)'),
  collateralLiquidity: carried('the illiquid collateral carried over (the supported posture requires Illiquid)'),
  status: atAccept(() => 0, 'Active, opened by the accept'),
  assetType: signed('assetType'),
  useFullTermInterest: signed('useFullTermInterest', 'the interest mode the lender signed (AcceptTerms.useFullTermInterest)'),
  riskAndTermsConsentFromBoth: atAccept(
    (c) => c.terms.riskAndTermsConsent === true && c.request.creatorRiskAndTermsConsent === true,
    'both consents: the request’s and the signed AcceptTerms’',
  ),
  collateralAssetType: signed('collateralAssetType'),
  fallbackLenderBonusBpsAtInit: unchecked('a governance stamp used only by a liquidation fallback; shown on neither review and outside the watched snapshot'),
  fallbackTreasuryBpsAtInit: unchecked('a governance stamp used only by a liquidation fallback; shown on neither review and outside the watched snapshot'),
  liquidationLtvBpsAtInit: unchecked('a tier-derived liquidation threshold of a LIQUID loan; not reviewed, and not a refinance term'),
  borrower: carried('the borrower carried over'),
  allowsPartialRepay: signed('allowsPartialRepay'),
  periodicInterestCadence: signed('periodicInterestCadence'),
  lastPeriodicInterestSettledAt: atAccept((c) => c.acceptTs, 'the periodic checkpoint LoanFacet stamps with the accept’s timestamp'),
  lenderTokenId: {
    how: 'accept',
    check: (v, c) => BigInt(v) !== 0n && BigInt(v) !== BigInt(c.oldLoan.lenderTokenId) && BigInt(v) !== BigInt(c.oldLoan.borrowerTokenId),
    expectText: 'a fresh position token minted at the accept (its holder is checked by replacement.positionNfts)',
    why: 'minted at the accept',
  },
  borrowerTokenId: fromRequest('positionTokenId', 'the request’s own position token, which becomes the borrower NFT'),
  principal: signed('amount', 'the amount the lender signed (AcceptTerms.amount)'),
  principalAsset: signed('lendingAsset', 'the lending asset the lender signed'),
  interestRateBps: signed('interestRateBps', 'the rate the lender signed (the request’s ceiling)'),
  startTime: atAccept((c) => c.acceptTs, 'the accept block’s timestamp'),
  interestPaidSinceLastPeriod: atAccept(() => 0n, 'a fresh loan has paid nothing'),
  durationDays: signed('durationDays'),
  collateralAsset: signed('collateralAsset'),
  collateralAmount: signed('collateralAmount'),
  tokenId: signed('tokenId'),
  quantity: signed('quantity'),
  prepayAmount: atAccept(() => 0n, 'rental-only; zero on an ERC-20 loan'),
  bufferAmount: atAccept(() => 0n, 'rental-only; zero on an ERC-20 loan'),
  lastDeductTime: atAccept(() => 0n, 'rental-only; zero on an ERC-20 loan'),
  prepayAsset: signed('prepayAsset'),
  collateralTokenId: signed('collateralTokenId'),
  collateralQuantity: signed('collateralQuantity'),
  lenderDiscountAccAtInit: atAccept(() => 0n, 'dead since T-087 Sub 1.B — nothing writes it'),
  borrowerDiscountAccAtInit: atAccept(() => 0n, 'dead since T-087 Sub 1.B — nothing writes it'),
  matcher: atAccept((c) => c.acceptor, 'a direct accept’s matcher is its caller, the accepting lender (who takes the LIF matcher cut)'),
  lenderNotifBilled: atAccept(() => false, 'a fresh loan has billed no notification'),
  borrowerNotifBilled: atAccept(() => false, 'a fresh loan has billed no notification'),
  allowsPrepayListing: signed('allowsPrepayListing'),
  interestSettled: atAccept(() => 0n, 'a fresh loan has settled no interest'),
  minHealthFactorAtInit: unchecked('a governance HF floor stamped at origination; not a refinance term, not reviewed, outside the watched snapshot'),
  initLtvCapBpsAtInit: unchecked('a tier-derived LTV cap of a LIQUID loan; not a refinance term and not reviewed'),
  interestAccrualStart: atAccept((c) => c.acceptTs, 'the interest clock starts at the accept'),
  interestRemainingDays: signed('durationDays', 'the full signed length remains'),
  treasuryFeeBpsAtInit: { how: 'config', expect: (c) => c.reviewedConfig.treasuryFeeBps, why: 'the treasury fee both reviews quoted' },
  loanInitiationFeeBpsAtInit: { how: 'config', expect: (c) => c.reviewedConfig.lifBps, why: 'the LIF rate the borrower’s review quoted' },
});

export const HOWS = Object.freeze(['signed', 'carried', 'config', 'accept', 'unchecked']);

/** The fields left unchecked, with their reasons (for NOT VERIFIED). */
export const UNCHECKED_FIELDS = Object.freeze(
  Object.entries(REPLACEMENT_MAPPING)
    .filter(([, m]) => m.how === 'unchecked')
    .map(([field, m]) => ({ field, why: m.why })),
);

/**
 * Run the whole mapping against the replacement as read.
 * @returns {{ mismatches: string[], evidence: string[], unchecked: { field: string, why: string }[] }}
 */
export function evaluateReplacement(loan, ctx) {
  const mismatches = [];
  const evidence = [];
  for (const [field, m] of Object.entries(REPLACEMENT_MAPPING)) {
    const v = loan?.[field];
    if (m.how === 'unchecked') {
      evidence.push(`${field}: (e) not checked — ${v}`);
      continue;
    }
    if (v === undefined) {
      mismatches.push(`${field}: missing from the read`);
      continue;
    }
    let ok;
    let want;
    if (m.check) {
      ok = m.check(v, ctx);
      want = m.expectText;
    } else {
      want = m.expect(ctx, field);
      ok = want !== undefined && sameValue(v, want);
    }
    const tag = { signed: '(a) signed', carried: '(b) carried', config: '(c) reviewed config', accept: '(d) accept block' }[m.how];
    evidence.push(`${field}: ${tag} ${ok ? '=' : '≠'} ${want} (${v})`);
    if (!ok) mismatches.push(`${field}: ${v}, expected ${want} — ${m.why}`);
  }
  return { mismatches, evidence, unchecked: UNCHECKED_FIELDS };
}
