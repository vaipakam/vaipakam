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
 * implement under the DEFAULT FEE POSTURE, and nothing else (#2422 r9 — the
 * set of fee branches has no end, so the model is bounded rather than
 * extended): an ERC-20 loan accepted by the lender through the app (so the
 * LIF's matcher share goes to that lender), settled before maturity, where
 *   - the borrower's initiation fee carries no discount
 *     (`settlementPremises`: the borrower's effective discount is 0 and the
 *     request carries no Full opt-in — Diamond state only), and
 *   - the exiting position holder has no yield-fee discount entitlement (no
 *     VPFI-discount consent and no Full tariff on the loan — the one guard in
 *     front of BOTH the VPFI-paid path and the direct-reduction fallback).
 * Those premises are established BEFORE the first write; when one does not
 * hold the drive states the settlement claim as NOT VERIFIED up front, and
 * when one stops holding by the accept the claim is UNDETERMINED — never a
 * FAIL against a model that did not apply.
 *
 * `txIsolation` bounds the other premise of a block-diff read: that no
 * other transaction in the same block touched the state being diffed.
 *
 * Pure; `refinanceOutcome.test.mjs` pins every helper against the real
 * loan 22 → loan 23 accept on Base Sepolia (block 47711162).
 */

const BPS = 10_000n;
/** LibVaipakam.LEGACY_TREASURY_FEE_BPS — the frozen rate for a loan that
 *  carries no `treasuryFeeBpsAtInit` stamp (pre-#957). */
export const LEGACY_TREASURY_FEE_BPS = 100n;

const lc = (a) => String(a).toLowerCase();

/** LibVaipakam.FeeEntitlementMode.Full. */
export const FEE_MODE_FULL = 2;

// ---------------------------------------------------------------------
// The settlement model's premises (#2422 r9).
// ---------------------------------------------------------------------

/**
 * Whether the default-fee-posture settlement model applies, from reads the
 * drive makes BEFORE the first write (and again at the block before the
 * accept). The conditions are the contract's own, not a re-implementation of
 * the fee maths:
 *
 *   BORROWER — OfferAcceptFeeFacet charges `holdOnlyBorrowerLif(borrower,
 *   principal, isLiquid, fullMode)`, which discounts only when the borrower's
 *   effective discount (the consent-gated, clamped `getEffectiveDiscount`
 *   view) is non-zero, or the request carries a confirmed Full opt-in — and
 *   then only on a Liquid principal. The premise used here is the
 *   liquidity-FREE half (#2422 r11): effective discount 0 AND no Full
 *   opt-in, under which the fee is undiscounted whatever the liquidity.
 *   Liquidity (`checkLiquidity`) reads external oracle and pool state that no
 *   block-isolation check can cover, so the model never depends on it: a
 *   borrower with a non-zero discount is outside the model even if the
 *   principal happens to be illiquid — stated, not guessed.
 *
 *   EXITING LENDER — RefinanceFacet resolves `resolveLenderYieldFeeFor` for
 *   the CURRENT holder of the lender position NFT. Its first guard,
 *   `lenderYieldFeeEligible`, is `vpfiDiscountConsent[holder] ||
 *   feeEntitlement(loan).lenderMode == Full`; when it is false the treasury
 *   share is untouched — neither the VPFI-paid path (`tryApplyYieldFee`) nor
 *   the direct-reduction fallback runs.
 *
 * @param {{ borrowerEffBps: number|bigint, requestCreatorFull: boolean,
 *           holderConsent: boolean, lenderMode: number|bigint }} r
 * @returns {{ holds: boolean, basis: string[],
 *             failures: { party: string, reason: string, coveredBy: string }[] }}
 */
export function settlementPremises(r) {
  const basis = [];
  const failures = [];
  const effBps = Number(r.borrowerEffBps);
  if (effBps === 0 && r.requestCreatorFull !== true) {
    basis.push('borrower LIF undiscounted: effective discount 0 bps (getEffectiveDiscount) and no Full opt-in');
  } else {
    failures.push({
      party: 'borrower',
      reason:
        `the borrower's initiation fee may be discounted — ` +
        (effBps !== 0 ? `the borrower's effective discount is ${effBps} bps` : 'the request carries a Full opt-in') +
        ' (the model does not depend on the principal\u2019s liquidity, which no isolation check covers)',
      coveredBy: 'contracts/test/VPFIDiscountFacetTest.t.sol testAcceptOfferWithVPFIDiscountApplied',
    });
  }
  const lenderEligible = r.holderConsent === true || Number(r.lenderMode) === FEE_MODE_FULL;
  if (!lenderEligible) {
    basis.push('exiting lender has no yield-fee discount entitlement: no VPFI-discount consent, no Full tariff');
  } else {
    failures.push({
      party: 'exiting lender',
      reason:
        'the exiting position holder is eligible for a yield-fee discount (' +
        [r.holderConsent === true ? 'VPFI-discount consent' : null, Number(r.lenderMode) === FEE_MODE_FULL ? 'Full tariff on the loan' : null]
          .filter(Boolean)
          .join(', ') +
        ') — paid in VPFI or as a direct reduction, either way outside the model',
      coveredBy: 'contracts/test/FeeEntitlementFacetTest.t.sol test_1955_refinance_discountKeysOnHolder_notStoredLender',
    });
  }
  return { holds: failures.length === 0, basis, failures };
}

// ---------------------------------------------------------------------
// Transaction scope of a block-diff read (#2422 r9).
// ---------------------------------------------------------------------

const topicAddress = (t) => (typeof t === 'string' && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : null);

/**
 * RULE 2 — a write's outcome is scoped to THAT transaction (#2422 r9, made
 * general in r10). Did any OTHER transaction in the block of `receipt` (any
 * of this run's: createOffer, an approval, the accept) touch what a
 * block-diff read — state at the block minus state at the block before —
 * would attribute to it? Such a diff covers every transaction in the block,
 * so it is the receipt's only when nothing else in the block touched:
 *   - the Diamond (any log it emitted, or a transaction sent to it — its
 *     state is what the views read, the position NFTs included);
 *   - any watched address: a log EMITTED by it (a vault), or a log naming
 *     it in an indexed topic (an ERC-20/721 Transfer or ERC-1155
 *     TransferSingle/Batch with it as from/to — on ANY token, which covers
 *     the principal and collateral tokens and is stricter than them), or a
 *     successful transaction from or to it.
 * The same isolation is what a RECEIPT-MODEL check needs when its inputs are
 * state read at the block before (the fee posture, the NFT holder, the
 * payoff): another transaction ahead of ours in the block could have moved
 * them.
 *
 * `receipts === null` (the block could not be read) is NOT isolation, nor is
 * a list that lacks `receipt` or holds receipts from another block: the
 * caller reports those as UNDETERMINED. Nothing is assumed.
 *
 * `own` lists this run's OTHER plan transactions (an approval mined in the
 * same block as the createOffer or the accept). Each was judged field by
 * field against its expected object before it was signed, and none of them
 * moves a token balance or touches an offer or a loan — an ERC-20 approve
 * sets an allowance, the caps write sets the loan's guardrails — so they
 * are set aside and NAMED (`own`), never silently.
 *
 * @param {{ receipt: { transactionHash: string, blockNumber: bigint|string },
 *           receipts: object[]|null, diamond: string,
 *           watched: Record<string, string>, own?: string[] }} a  watched: label → address
 * @returns {{ known: boolean, isolated: boolean, touching: string[], own: string[] }}
 */
export function txIsolation({ receipt, receipts, diamond, watched, own = [] }) {
  if (!Array.isArray(receipts)) return { known: false, isolated: false, touching: [], own: [] };
  const hash = lc(receipt.transactionHash);
  if (!receipts.some((r) => lc(r.transactionHash) === hash)) {
    return { known: false, isolated: false, touching: [`the block's receipts do not include ${receipt.transactionHash}`], own: [] };
  }
  const block = BigInt(receipt.blockNumber);
  const strays = receipts.filter((r) => r.blockNumber != null && BigInt(r.blockNumber) !== block);
  if (strays.length) {
    return { known: false, isolated: false, touching: [`${strays.length} receipt(s) are from a block other than ${block}`], own: [] };
  }
  const names = new Map(Object.entries(watched).map(([label, a]) => [lc(a), label]));
  const D = lc(diamond);
  const ownSet = new Set(own.map(lc));
  const touching = [];
  const ownSeen = [];
  for (const r of receipts) {
    if (lc(r.transactionHash) === hash) continue;
    if (ownSet.has(lc(r.transactionHash))) {
      ownSeen.push(r.transactionHash);
      continue;
    }
    const why = new Set();
    const ok = r.status === 'success' || r.status === '0x1' || r.status === 1;
    if (ok && lc(r.to) === D) why.add('sent to the Diamond');
    for (const end of ['from', 'to']) {
      if (ok && r[end] && names.has(lc(r[end]))) why.add(`${end} ${names.get(lc(r[end]))}`);
    }
    for (const l of r.logs ?? []) {
      if (lc(l.address) === D) why.add('a Diamond log');
      if (names.has(lc(l.address))) why.add(`a log emitted by ${names.get(lc(l.address))}`);
      for (const t of (l.topics ?? []).slice(1)) {
        const a = topicAddress(t);
        if (a && names.has(a)) why.add(`a ${lc(l.address)} log naming ${names.get(a)}`);
      }
    }
    if (why.size) touching.push(`${r.transactionHash}: ${[...why].join(', ')}`);
  }
  return { known: true, isolated: touching.length === 0, touching, own: ownSeen };
}

/** Why a scope is not isolated, in one sentence, or null when it is. */
export function scopeReason(scope, { what, block, error }) {
  if (!scope.known) {
    return `the receipts of ${what}'s block ${block} could not be established (${(error ?? scope.touching.join('; ')) || 'unreadable'}), so no state difference across that block can be attributed to it`;
  }
  if (scope.isolated) return null;
  return `${scope.touching.length} other transaction(s) in ${what}'s block ${block} touched the Diamond or a participant: ${scope.touching.join(' | ')}`;
}

// ---------------------------------------------------------------------
// Collateral leaving the borrower's vault, from the accept receipt alone.
// ---------------------------------------------------------------------

/** keccak256 of the three token-movement events this drive watches. */
export const TOPIC = {
  /** Transfer(address,address,uint256) — ERC-20 (3 topics) and ERC-721 (4). */
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  /** TransferSingle(address,address,address,uint256,uint256) — ERC-1155. */
  transferSingle: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  /** TransferBatch(address,address,address,uint256[],uint256[]) — ERC-1155. */
  transferBatch: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb',
};

/**
 * Every movement of `token` OUT of `from` in `logs` (one receipt's logs), by
 * the event the asset type emits: ERC-20 (assetType 0) and ERC-721 (1) a
 * `Transfer` with `from` as its first indexed address; ERC-1155 (2) a
 * `TransferSingle` / `TransferBatch` with `from` as its SECOND indexed
 * address (the first is the operator). Returns readable lines; empty ⇔ none.
 */
export function collateralMovedOut({ logs, token, from, assetType }) {
  const type = Number(assetType);
  if (![0, 1, 2].includes(type)) throw new Error(`collateralMovedOut: unknown asset type ${assetType}`);
  const out = [];
  for (const l of logs) {
    if (lc(l.address) !== lc(token)) continue;
    const t0 = lc(l.topics?.[0]);
    if (type !== 2 && t0 === TOPIC.transfer && topicAddress(l.topics[1]) === lc(from)) {
      out.push(`${type === 1 ? 'ERC-721' : 'ERC-20'} Transfer from ${from} to ${topicAddress(l.topics[2])}`);
    }
    if (type === 2 && (t0 === TOPIC.transferSingle || t0 === TOPIC.transferBatch) && topicAddress(l.topics[2]) === lc(from)) {
      out.push(`ERC-1155 ${t0 === TOPIC.transferSingle ? 'TransferSingle' : 'TransferBatch'} from ${from} to ${topicAddress(l.topics[3])}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// One role's nonce reconciliation, recorded only if its own read succeeds.
// ---------------------------------------------------------------------

/**
 * Read `role`'s latest and pending nonces and record `<role>Nonces` against
 * the consumed plan transactions — ONLY when that read succeeds (#2422 r9).
 * A read that throws records nothing: the check stays NOT RUN, so the
 * write-discipline claim cannot print as verified on the other role's
 * evidence alone. Returns what happened, for the transcript.
 */
export async function checkRoleNonces({ role, readNonces, baseline, hashed, allowed, record }) {
  let latest;
  let pending;
  try {
    ({ latest, pending } = await readNonces());
  } catch (e) {
    return { recorded: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 120) };
  }
  const mined = Number(latest) - Number(baseline);
  const queued = Number(pending) - Number(latest);
  const ok = mined === Number(hashed) && Number(hashed) === Number(allowed) && queued === 0;
  const observed = `mined +${mined}, pending +${queued}, allowed ${allowed}, hashed ${hashed}`;
  record(`${role}Nonces`, ok, observed);
  return { recorded: true, ok, observed };
}

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

/**
 * Balance deltas judged per UNIQUE ADDRESS against the sum of every expected
 * leg into or out of it (#2422 r12). Comparing named parties one by one
 * breaks when two names are one address — the old lender's payout vault IS
 * the borrower's or the new lender's vault whenever one of them holds (or,
 * after a holder change, came to hold) the old lender position — because each
 * name then carries only its own legs while the chain shows their sum. Keying
 * by address and summing all legs is right whether or not anything aliases.
 *
 * @param {Array<{ from: string, to: string, value: bigint }>} legs  every expected leg
 * @param {Array<{ label: string, address: string, delta: bigint }>} observed
 * @returns {{ mismatches: string[], rows: string[] }}
 */
export function balanceDeltaMismatches(legs, observed) {
  const byAddr = new Map();
  for (const o of observed) {
    const k = lc(o.address);
    const row = byAddr.get(k) ?? { labels: [], deltas: new Set(), delta: o.delta };
    row.labels.push(o.label);
    row.deltas.add(BigInt(o.delta));
    byAddr.set(k, row);
  }
  const mismatches = [];
  const rows = [];
  for (const [addr, row] of byAddr) {
    let want = 0n;
    for (const l of legs) {
      if (lc(l.to) === addr) want += BigInt(l.value);
      if (lc(l.from) === addr) want -= BigInt(l.value);
    }
    const name = `${row.labels.join(' = ')} (${addr})`;
    if (row.deltas.size !== 1) {
      mismatches.push(`${name}: one address read with ${row.deltas.size} different deltas`);
      continue;
    }
    const got = [...row.deltas][0];
    rows.push(`${name}: ${got} (expected ${want})`);
    if (got !== want) mismatches.push(`${name}: moved ${got}, expected ${want}`);
  }
  return { mismatches, rows };
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

// ---------------------------------------------------------------------
// Who the old lender's payout goes to (#2422 r11).
// ---------------------------------------------------------------------

/**
 * The owner of the vault RefinanceFacet pays the lender due into, derived
 * as the contract derives it: the accept first consolidates the old loan's
 * stored lender to the CURRENT lender-NFT holder (`eagerConsolidateToHolder`,
 * skip-not-block — a sanctioned holder or an excluded state leaves the old
 * address), then deposits into `oldLoan.lender`'s vault. So the owner is the
 * stored lender read AFTER the accept, at the accept block — never the one
 * read before it. The NFT holder at the block before is the cross-check;
 * when the two differ (the consolidation was skipped) the evidence says so.
 *
 * @returns {{ owner: string, consolidated: boolean, evidence: string }}
 */
export function payoutOwnerOf({ storedLenderAtFloor, storedLenderAtPrev, holderAtPrev, floor, prev }) {
  const owner = storedLenderAtFloor;
  const consolidated = lc(owner) === lc(holderAtPrev);
  const evidence =
    `payout owner ${owner} (the old loan's stored lender at block ${floor}, after the accept's consolidation)` +
    (consolidated
      ? `; the lender-NFT holder at block ${prev} is the same` +
        (lc(storedLenderAtPrev) !== lc(owner) ? ` (the stored lender before the accept was ${storedLenderAtPrev})` : '')
      : `; DIFFERS from the lender-NFT holder at block ${prev} (${holderAtPrev}) — the consolidation did not move it`);
  return { owner, consolidated, evidence };
}

/**
 * Why the settlement model may NOT judge this accept, or null when it may
 * (#2422 r9–r12) — one precedence, so no premise can be dropped from one
 * call site. Each reason makes every model check UNDETERMINED, never FAIL:
 *   1. the accept's block is not isolated (its prestate inputs may have
 *      moved under another transaction);
 *   2. the watched config at the accept's prestate differs from the
 *      snapshot the reviews were judged against — the settled fees are not
 *      the reviewed ones, so nothing may be certified;
 *   3. the default fee posture no longer held at the prestate;
 *   4. the receipt carries a discount event the model does not cover;
 *   5. the payoff stepped between the prestate and the accept.
 */
export function settlementBlocker({ prev, isolation, reviewDrift, premisesAtPrev, discountEvents, payoffStep }) {
  if (isolation) {
    return `the receipt model's inputs (fee posture, position holder, payoff — read at block ${prev}) are not isolated from the accept's block: ${isolation}`;
  }
  if (reviewDrift.length) {
    return `config changed between review and accept (block ${prev}): ${reviewDrift.join('; ')} — the settled fees are not the reviewed ones, so nothing is certified`;
  }
  if (!premisesAtPrev.holds) {
    return `the default fee posture no longer held at block ${prev} — ${premisesAtPrev.failures.map((f) => f.reason).join('; ')}`;
  }
  if (discountEvents.length) return `the accept emitted ${discountEvents.join(', ')} — a discount the model does not cover`;
  if (payoffStep) {
    return `the payoff stepped between block ${prev} (ts ${payoffStep.tsPrev}) and the accept block (ts ${payoffStep.tsAccept}), so the view read before the accept is not the figure the accept paid`;
  }
  return null;
}

