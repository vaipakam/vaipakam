/**
 * THE ONE WATCHED-CONFIG SNAPSHOT (#2422 r12).
 *
 * Every mutable GOVERNANCE value the refinance drive reads — for an
 * expectation, a review, a precondition or the settlement model — is defined
 * here, once. Rule 1 (observation.mjs) races every observation against the
 * WHOLE snapshot; the settlement model is computed from the snapshot read at
 * the accept's prestate and must equal the snapshot the reviews were judged
 * against. Review rounds 10–12 each found one more governance value read
 * outside the snapshot (fees, grace, the risk-terms epoch, asset pauses);
 * the list is the structural answer, and `watchedConfig.test.mjs` fails on
 * any Diamond read in the driver that is neither listed here nor classified
 * as per-loan / per-user / per-offer STATE below — so a new read cannot
 * silently bypass it.
 *
 * Each entry: `key` (the snapshot field), `fn` (the Diamond getter), `args`
 * (from a context of the loan's assets), `pick` (a field of a tuple result).
 * Getters sharing (fn, args) are read once per snapshot.
 */

/** @typedef {{ principalAsset: string, collateralAsset: string }} WatchedContext */

export const WATCHED_CONFIG = Object.freeze([
  // The auto-match posture the banners disclose.
  { key: 'paused', fn: 'paused' },
  { key: 'autoRefinance', fn: 'getAutoRefinanceEnabled' },
  { key: 'partialFill', fn: 'getMasterFlags', pick: (r) => r[2] },
  // The fees both reviews quote and the settlement charges.
  { key: 'treasuryFeeBps', fn: 'getFeesConfig', pick: (r) => r[0] },
  { key: 'lifBps', fn: 'getLoanInitiationFeeBps' },
  { key: 'lifMatcherFeeBps', fn: 'getLifMatcherFeeBps' },
  { key: 'treasury', fn: 'getTreasury' },
  // The grace window the reviews show and the payoff approval is sized to.
  { key: 'graceBuckets', fn: 'getGraceBuckets' },
  // The risk-terms epoch the lender's AcceptTerms is anchored to.
  { key: 'riskTermsHash', fn: 'getCurrentRiskTermsHash' },
  // Per-asset pauses (RefinanceFlow's assertAssetNotPausedLive, both legs).
  { key: 'principalPaused', fn: 'isAssetPaused', args: (c) => [c.principalAsset] },
  { key: 'collateralPaused', fn: 'isAssetPaused', args: (c) => [c.collateralAsset] },
  // The form's upper bound on the new length.
  { key: 'maxOfferDurationDays', fn: 'getProtocolConfigBundle', pick: (r) => r[14] },
  // Preconditions that change what an accept requires.
  { key: 'riskAccessGate', fn: 'getRiskAccessGateEnabled' },
  { key: 'sanctionsOracle', fn: 'getSanctionsOracle' },
]);

/**
 * Diamond reads the driver makes that are NOT governance config: state of a
 * particular loan, offer, user, vault or position — or, for `checkLiquidity`,
 * external oracle and pool state the model no longer depends on (#2422 r11).
 * Each is classified with its reason; a read in neither list fails the test.
 */
export const STATE_READS = Object.freeze({
  getLoanDetails: 'one loan’s state',
  getOfferDetails: 'one offer’s state',
  isOfferCancelled: 'one offer’s state',
  getUserOffersPaginated: 'one user’s offer index',
  getUserActiveLoans: 'one user’s loan index',
  getAutoRefinanceCaps: 'one loan’s caps',
  getClaimable: 'one loan’s claim',
  calculateRepaymentAmount: 'one loan’s payoff',
  getLoanCollateralLien: 'one loan’s lien',
  ownerOf: 'one position NFT’s holder',
  getUserVaultAddress: 'one user’s vault',
  getVPFIDiscountConsent: 'one user’s consent',
  getEffectiveDiscount: 'one user’s discount',
  getFeeEntitlement: 'one loan’s fee entitlement',
  hasAcceptedCurrentTerms: 'one user’s terms acceptance',
  isSanctionedAddress: 'one user’s screening result',
  checkLiquidity: 'external oracle / pool state — a precondition on the collateral only, never a model input',
});

/** The Diamond getters the snapshot reads. */
export const WATCHED_GETTERS = Object.freeze([...new Set(WATCHED_CONFIG.map((e) => e.fn))]);

/**
 * Read the whole snapshot at `blockNumber` (undefined ⇒ latest) through
 * `read(fn, args, blockNumber)`. Returns `{ key: value }` for every entry.
 *
 * @param {(fn: string, args: any[], blockNumber?: bigint) => Promise<any>} read
 * @param {WatchedContext} ctx
 */
export async function readWatchedConfig(read, ctx, blockNumber) {
  const calls = new Map();
  for (const e of WATCHED_CONFIG) {
    const args = e.args ? e.args(ctx) : [];
    const id = `${e.fn}(${args.join(',')})`;
    if (!calls.has(id)) calls.set(id, read(e.fn, args, blockNumber));
  }
  const results = new Map();
  await Promise.all([...calls.entries()].map(async ([id, p]) => results.set(id, await p)));
  const out = {};
  for (const e of WATCHED_CONFIG) {
    const args = e.args ? e.args(ctx) : [];
    const r = results.get(`${e.fn}(${args.join(',')})`);
    out[e.key] = e.pick ? e.pick(r) : r;
  }
  return out;
}
