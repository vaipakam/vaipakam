/**
 * WHAT A COMPLETED REFINANCE MUST HAVE DONE ON CHAIN — the pure halves of
 * `live-refinance.mjs`'s outcome checks (#2422 r8).
 *
 *   - `scanForReplacement`: the loan opened from this run's request, found
 *     by a state scan — with the scan's limit stated as UNKNOWN, never as
 *     "none".
 *   - `expectedSettlement` + `expectedPrincipalTransfers`: what the accept
 *     transaction moves in the principal token, derived from the contract's
 *     own views read at the block BEFORE the accept (the payoff view
 *     `calculateRepaymentAmount`, the loan's stamped treasury rate, the live
 *     LIF and matcher rates) — so every figure the drive asserts is one the
 *     chain itself states.
 *   - `lienMismatches`: the collateral lien must move from the old loan to
 *     the replacement intact — the carry-over's whole point.
 *
 * The settlement model is the one RefinanceFacet + OfferAcceptFeeFacet
 * implement for THIS drive's scenario: an ERC-20 loan with ILLIQUID
 * collateral (so the borrower's LIF carries no hold-tier discount and no
 * Full tariff), accepted by the lender through the app (so the LIF's matcher
 * share goes to that lender), settled before maturity, with no VPFI
 * yield-fee discount for the exiting lender. A case outside it is not
 * modelled here; the drive states it as NOT VERIFIED rather than judging it
 * against the wrong model.
 *
 * Pure; `refinanceOutcome.test.mjs` pins every helper against the real
 * loan 22 → loan 23 accept on Base Sepolia (block 47711162).
 */

const BPS = 10_000n;
/** LibVaipakam.LEGACY_TREASURY_FEE_BPS — the frozen rate for a loan that
 *  carries no `treasuryFeeBpsAtInit` stamp (pre-#957). */
export const LEGACY_TREASURY_FEE_BPS = 100n;

const lc = (a) => String(a).toLowerCase();

// ---------------------------------------------------------------------
// The replacement loan, by state scan.
// ---------------------------------------------------------------------

/**
 * Scan loan ids upward from `startId` for the loan whose `offerId` is
 * `requestId`. Loan ids are sequential and an unused id reads back with
 * `id == 0`, so reaching that EMPTY ID is the only thing that establishes
 * "no such loan" (returns null).
 *
 * Exhausting `cap` ids without reaching it establishes nothing: the
 * replacement could sit past the cap. That THROWS — the caller reports the
 * entry as UNKNOWN with its event-lookup remedy — rather than returning the
 * same null an honest "none" returns (#2422 r8). Two loans carrying the
 * request also throw.
 *
 * @param {{ readLoan: (id: bigint) => Promise<{ id: bigint, offerId: bigint }>,
 *           startId: bigint, requestId: bigint, cap: number }} a
 */
export async function scanForReplacement({ readLoan, startId, requestId, cap }) {
  let match = null;
  let id = startId;
  for (let n = 0; n < cap; n++, id++) {
    const l = await readLoan(id);
    if (l.id === 0n) return match;
    if (l.offerId === requestId) {
      if (match) throw new Error(`two loans (#${match.id}, #${l.id}) carry request #${requestId}`);
      match = l;
    }
  }
  throw new Error(
    `the replacement scan read ${cap} loan ids (#${startId}–#${id - 1n}) without reaching an empty id — ` +
      `a loan carrying request #${requestId} may lie past the cap${match ? ` (one was found at #${match.id}; a second may too)` : ''}`,
  );
}

// ---------------------------------------------------------------------
// The settlement, from the contract's own views.
// ---------------------------------------------------------------------

/**
 * What the accept settles, in the principal token's smallest unit.
 *
 * Inputs, each a view value read at the block before the accept:
 *   repayDue              RepayFacet.calculateRepaymentAmount(oldLoanId) —
 *                         principal + settlement interest + any late fee;
 *   oldPrincipal          the old loan's principal;
 *   treasuryFeeBpsAtInit  the old loan's stamp (0 ⇒ the legacy 100 bps);
 *   newPrincipal          the replacement's principal (the request amount);
 *   lifBps, matcherBps    getProtocolConfigBundle's loanInitiationFeeBps and
 *                         lifMatcherFeeBps.
 *
 * Returns the old-lender side (interest portion, treasury share, lender
 * due — what the old lender's claim and vault receive), the LIF side (fee,
 * matcher cut, treasury cut), and each party's net change.
 */
export function expectedSettlement({ repayDue, oldPrincipal, treasuryFeeBpsAtInit, newPrincipal, lifBps, matcherBps }) {
  const big = (v) => BigInt(v);
  const due = big(repayDue);
  const principal = big(oldPrincipal);
  if (due < principal) throw new Error(`payoff view ${due} is below the principal ${principal} — not an Active loan's payoff`);
  const feeBps = big(treasuryFeeBpsAtInit) === 0n ? LEGACY_TREASURY_FEE_BPS : big(treasuryFeeBpsAtInit);
  const interestPortion = due - principal;
  const treasuryShare = (interestPortion * feeBps) / BPS;
  const lenderDue = due - treasuryShare;
  const np = big(newPrincipal);
  const lif = (np * big(lifBps)) / BPS;
  const matcherCut = (lif * big(matcherBps)) / BPS;
  const treasuryLif = lif - matcherCut;
  return {
    feeBps,
    interestPortion,
    treasuryShare,
    lenderDue,
    lif,
    matcherCut,
    treasuryLif,
    /** The borrower's wallet: the net principal in, the whole payoff out. */
    borrowerWalletDelta: np - lif - due,
    /** The accepting lender's wallet: the principal out, the matcher cut back. */
    lenderWalletDelta: matcherCut - np,
    /** The old lender's vault: the lender due in. */
    oldLenderVaultDelta: lenderDue,
    /** The treasury: its interest share plus its share of the LIF. */
    treasuryDelta: treasuryShare + treasuryLif,
  };
}

/**
 * Every principal-token Transfer the accept transaction must emit, and
 * nothing else: the lender's principal into their vault; out of it the
 * LIF's treasury cut, the matcher cut back to the accepting lender, and the
 * net principal to the borrower; then the borrower's payoff split to the
 * treasury and to the old lender's vault. Zero-value legs the contract
 * skips are omitted.
 */
export function expectedPrincipalTransfers(s, { borrower, lender, lenderVault, treasury, oldLenderVault, newPrincipal }) {
  const np = BigInt(newPrincipal);
  return [
    { from: lender, to: lenderVault, value: np },
    { from: lenderVault, to: treasury, value: s.treasuryLif },
    { from: lenderVault, to: lender, value: s.matcherCut },
    { from: lenderVault, to: borrower, value: np - s.lif },
    { from: borrower, to: treasury, value: s.treasuryShare },
    { from: borrower, to: oldLenderVault, value: s.lenderDue },
  ].filter((t) => t.value > 0n);
}

const transferKey = (t) => `${lc(t.from)}→${lc(t.to)}:${BigInt(t.value)}`;

/**
 * Compare the receipt's principal-token Transfers with the expected set, as
 * multisets (the order of legs is the contract's business; the set is the
 * claim). Returns readable mismatch lines; empty ⇔ exactly the expected
 * transfers, no more and no fewer.
 */
export function transferMismatches(expected, actual) {
  const want = expected.map(transferKey);
  const got = actual.map(transferKey);
  const out = [];
  const remaining = [...got];
  for (const w of want) {
    const i = remaining.indexOf(w);
    if (i === -1) out.push(`missing transfer ${w}`);
    else remaining.splice(i, 1);
  }
  for (const r of remaining) out.push(`unexpected transfer ${r}`);
  return out;
}

// ---------------------------------------------------------------------
// The collateral lien's carry-over.
// ---------------------------------------------------------------------

/**
 * The collateral lien (`getLoanCollateralLien`) must move intact: live on
 * the old loan just before the accept, released and zeroed on it at the
 * accept, and live on the replacement with exactly the borrower, asset,
 * asset type, tokenId and amount.
 *
 * @param {{ oldBefore: object, oldAfter: object, newAfter: object,
 *           expected: { user: string, asset: string, assetType: number|bigint,
 *                       tokenId: bigint, amount: bigint } }} a
 */
export function lienMismatches({ oldBefore, oldAfter, newAfter, expected }) {
  const out = [];
  const live = (where, l) => {
    if (lc(l.user) !== lc(expected.user)) out.push(`${where}: user ${l.user}, expected ${expected.user}`);
    if (lc(l.asset) !== lc(expected.asset)) out.push(`${where}: asset ${l.asset}, expected ${expected.asset}`);
    if (Number(l.assetType) !== Number(expected.assetType)) out.push(`${where}: assetType ${l.assetType}, expected ${expected.assetType}`);
    if (BigInt(l.tokenId) !== BigInt(expected.tokenId)) out.push(`${where}: tokenId ${l.tokenId}, expected ${expected.tokenId}`);
    if (BigInt(l.amount) !== BigInt(expected.amount)) out.push(`${where}: amount ${l.amount}, expected ${expected.amount}`);
    if (l.released !== false) out.push(`${where}: released ${l.released}, expected false (a live lien)`);
  };
  live('old loan lien before the accept', oldBefore);
  if (oldAfter.released !== true) out.push(`old loan lien at the accept: released ${oldAfter.released}, expected true`);
  if (BigInt(oldAfter.amount) !== 0n) out.push(`old loan lien at the accept: amount ${oldAfter.amount}, expected 0`);
  live('replacement lien at the accept', newAfter);
  return out;
}
