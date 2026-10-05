/**
 * THE SUPPORTED LOAN POSTURE (#2422 r13) — the loan-side twin of
 * watchedConfig.mjs.
 *
 * The drive's expected builders (refinanceExpected.mjs), its settlement
 * model (refinanceOutcome.mjs) and the payoff mirror they share were written
 * for ONE kind of loan. Review rounds kept finding a loan mode the mirror did
 * not model (a pro-rata loan, a periodic one, a re-anchored clock). Modelling
 * each mode in turn has no end; instead this module DECLARES, once, every
 * field of `LibVaipakam.Loan` and either
 *   - the value or range the model supports (`SUPPORTED`), each with the
 *     reason — a loan outside it is BLOCKED before the first write, naming
 *     the field; the mode is never modelled; or
 *   - why the field does not affect the model (`NOT_AFFECTING`).
 * `supportedPosture.test.mjs` requires every Loan field in the compiled ABI
 * to be in exactly one of the two, and every Loan field the builders or the
 * driver read to be among them — so a new read cannot slip past the gate.
 *
 * The contract rules mirrored (LibEntitlement): `settlementInterest` floors
 * the interest days at the remaining term ONLY when `useFullTermInterest`;
 * `settlementInterestNet` subtracts `interestSettled`; the accrual clock is
 * `interestAccrualStart` (else `startTime`) and the remaining term
 * `interestRemainingDays` (else `durationDays`) — both forms mirrored.
 */

const ACTIVE = 0;
const ERC20 = 0;
const ILLIQUID = 1;

/** Fields whose value the model depends on, with the value it supports. */
export const SUPPORTED = Object.freeze({
  status: {
    ok: (v) => Number(v) === ACTIVE,
    want: 'Active (0)',
    why: 'only an Active loan can be refinanced; the payoff view returns 0 once it is not',
  },
  assetType: {
    ok: (v) => Number(v) === ERC20,
    want: 'ERC-20 (0)',
    why: 'the createOffer builder, the payoff mirror and the settlement legs are ERC-20 only; a rental settles on prepay, not principal + interest',
  },
  collateralAssetType: {
    ok: (v) => Number(v) === ERC20,
    want: 'ERC-20 (0)',
    why: 'the collateral wallet / vault balance checks read an ERC-20 balance',
  },
  useFullTermInterest: {
    ok: (v) => v === true,
    want: 'true (full-term interest)',
    why: 'the payoff mirror floors interest at the full remaining term; a pro-rata loan (false) settles elapsed days only — a different payoff, not modelled',
  },
  periodicInterestCadence: {
    ok: (v) => Number(v) === 0,
    want: 'None (0)',
    why: 'a periodic loan forwards interest mid-term and has a settle-first guard on refinance; not modelled',
  },
  interestSettled: {
    ok: (v) => BigInt(v) === 0n,
    want: '0',
    why: 'settlementInterestNet credits interestSettled against the payoff; the mirror does not',
  },
  collateralLiquidity: {
    ok: (v) => Number(v) === ILLIQUID,
    want: 'Illiquid (1)',
    why: 'this drive is the illiquid-collateral refinance; a liquid one passes the HF/LTV gates, which it does not assert',
  },
  riskAndTermsConsentFromBoth: {
    ok: (v) => v === true,
    want: 'true',
    why: 'an illiquid loan requires both parties’ consent; the replacement must carry it over',
  },
  principal: { ok: (v) => BigInt(v) > 0n, want: '> 0', why: 'the payoff, LIF and settlement legs scale with it' },
  interestRateBps: { ok: (v) => BigInt(v) >= 0n, want: '≥ 0', why: 'read by the payoff mirror; every rate is modelled' },
  startTime: { ok: (v) => BigInt(v) > 0n, want: '> 0', why: 'the maturity, grace end and request-expiry clamp are anchored to it' },
  durationDays: { ok: (v) => BigInt(v) > 0n, want: '> 0', why: 'the maturity, the grace window and the legacy remaining term derive from it' },
  interestAccrualStart: {
    ok: () => true,
    want: 'any (0 = a pre-#641 loan, mirrored as startTime)',
    why: 'both clock forms are mirrored, re-anchored by a partial repayment included',
  },
  interestRemainingDays: {
    ok: (v, l) => BigInt(l.interestAccrualStart) === 0n || BigInt(v) <= BigInt(l.durationDays),
    want: '≤ durationDays when the clock is stamped',
    why: 'the remaining term the mirror floors interest at; one longer than the loan is not a state the contract produces',
  },
  treasuryFeeBpsAtInit: {
    ok: () => true,
    want: 'any (0 = the frozen legacy 100 bps)',
    why: 'the settlement model reads it, both the stamped and the legacy form',
  },
});

/** Fields that do not affect the model, each with the reason. */
export const NOT_AFFECTING = Object.freeze({
  id: 'an identifier',
  offerId: 'an identifier (the replacement’s is asserted to be the request)',
  lender: 'compared as a party; the payout owner is the stored lender after the accept (payoutOwnerOf)',
  borrower: 'compared as a party (must be the borrower role)',
  principalLiquidity: 'the LIF discount does not depend on it once the borrower premise is discount 0 (#2422 r11)',
  fallbackLenderBonusBpsAtInit: 'used only on a liquidation fallback, not on a refinance',
  fallbackTreasuryBpsAtInit: 'used only on a liquidation fallback, not on a refinance',
  liquidationLtvBpsAtInit: 'a liquidation parameter, not read by a refinance of an illiquid loan',
  allowsPartialRepay: 'copied verbatim into the request; partial-repay STATE is the clock fields above',
  lenderTokenId: 'the position NFT whose holder is read',
  borrowerTokenId: 'the position NFT whose holder is read',
  principalAsset: 'the token every principal figure is read in',
  collateralAsset: 'carried over verbatim; asserted equal on the replacement',
  collateralAmount: 'carried over verbatim; asserted equal on the replacement',
  collateralTokenId: 'carried over verbatim (0 for an ERC-20 collateral)',
  collateralQuantity: 'carried over verbatim (0 for an ERC-20 collateral)',
  tokenId: 'NFT-rental only; the loan is ERC-20',
  quantity: 'NFT-rental only; the loan is ERC-20',
  prepayAmount: 'NFT-rental only; the loan is ERC-20',
  bufferAmount: 'NFT-rental only; the loan is ERC-20',
  lastDeductTime: 'NFT-rental only; the loan is ERC-20',
  prepayAsset: 'copied verbatim into the request',
  lenderDiscountAccAtInit: 'dead since T-087 Sub 1.B (CLAUDE.md) — nothing writes or reads it',
  borrowerDiscountAccAtInit: 'dead since T-087 Sub 1.B (CLAUDE.md) — nothing writes or reads it',
  matcher: 'the old loan’s matcher; the new LIF’s matcher cut goes to the accepting lender',
  lenderNotifBilled: 'notification billing, not settlement',
  borrowerNotifBilled: 'notification billing, not settlement',
  allowsPrepayListing: 'a listing permission, not settlement',
  // Periodic-interest bookkeeping. LoanFacet stamps the checkpoint with the
  // loan's start time for EVERY loan (loan 22 carries it), and the payoff,
  // the refinance's settle-first guard and settlementInterestNet consult
  // these only through a non-zero cadence — which SUPPORTED excludes.
  interestPaidSinceLastPeriod: 'periodic bookkeeping, read only under a periodic cadence (excluded above)',
  lastPeriodicInterestSettledAt: 'periodic checkpoint, stamped at origination for every loan; read only under a periodic cadence (excluded above)',
  minHealthFactorAtInit: 'an HF gate parameter, not read for an illiquid refinance',
  initLtvCapBpsAtInit: 'an LTV gate parameter, not read for an illiquid refinance',
  loanInitiationFeeBpsAtInit: 'the OLD loan’s stamp is not read; the replacement’s is asserted against the review',
});

/**
 * Every supported field the loan is OUTSIDE of, as `{ field, value, want,
 * why }`. Empty ⇔ the loan is inside the posture the model supports. A
 * field missing from the loan is reported as outside it.
 */
export function postureMisses(loan) {
  const out = [];
  for (const [field, d] of Object.entries(SUPPORTED)) {
    const v = loan?.[field];
    let ok = false;
    try {
      ok = v !== undefined && d.ok(v, loan);
    } catch {
      ok = false;
    }
    if (!ok) out.push({ field, value: v === undefined ? 'missing' : String(v), want: d.want, why: d.why });
  }
  return out;
}
