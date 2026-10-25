/**
 * THE ONE WATCHED-CONFIG SNAPSHOT (#2422 r12).
 *
 * Every mutable GOVERNANCE value the refinance drive reads — for an
 * expected payload, a review or a precondition — is defined here, once. It
 * guards WRITES only (#2431 re-cut): the preflight reads it, and every
 * observation that precedes a write (the posture banner, both reviews, the
 * moment before the lender is armed) is raced against the WHOLE snapshot
 * (observation.mjs), so a write never goes ahead on config that moved.
 * Review rounds 10–12 each found one more governance value read
 * outside the snapshot (fees, grace, the risk-terms epoch, asset pauses);
 * the list is the structural answer, and `watchedConfig.test.mjs` fails on
 * any Diamond read in the driver that is neither listed here nor classified
 * as per-loan / per-user / per-offer STATE below — so a new read cannot
 * silently bypass it.
 *
 * Each entry: `key` (the snapshot field), `fn` (the Diamond getter), `args`
 * (from a context of the loan's assets), `pick` (a field of a tuple result).
 * Getters sharing (fn, args) are read once per snapshot.
 *
 * A field of the configuration bundle is picked BY NAME (`bundleField`), its
 * position looked up in the compiled ABI, never written as a number: #2812
 * took two flags out of the middle of the bundle and moved
 * `maxOfferDurationDays` from position 14 to 12. The answer itself is
 * decoded only at the shape this build's ABI describes: `read` goes through
 * the driver's `livePublicClient`, which applies the app's answer-shape rule
 * (`@vaipakam/lib/staticReturn`) and ends the run BLOCKED when a Diamond's
 * ConfigFacet answers in another shape (#2841), so a name never picks a
 * neighbouring field out of a different build's answer.
 */
import configFacetAbi from '@vaipakam/contracts/abis/ConfigFacet.json' with { type: 'json' };

/** A picker for one named output of `getProtocolConfigBundle`, by its
 *  position in the compiled ABI. Throws at load when the ABI names no such
 *  output, so a renamed field fails the drive instead of reading another. */
export function bundleField(name) {
  const entry = (Array.isArray(configFacetAbi) ? configFacetAbi : configFacetAbi.abi).find(
    (e) => e.type === 'function' && e.name === 'getProtocolConfigBundle',
  );
  const index = entry?.outputs?.findIndex((o) => o.name === name) ?? -1;
  if (index < 0) throw new Error(`watchedConfig: getProtocolConfigBundle has no output named ${name}`);
  return (r) => r[index];
}

/**
 * @typedef {{ principalAsset: string, collateralAsset: string,
 *   participants?: Record<string, string>,
 *   readOracle?: (oracle: string, who: string, blockNumber?: bigint) => Promise<boolean> }} WatchedContext
 * `participants` (label → address) are SCREENED as part of the snapshot
 * (#2422 r14): each one's tri-state sanctions result is a snapshot field
 * `screen:<label>`, so the race helper and the post-write classifier compare
 * it like any other governance value. `readOracle` asks the oracle directly
 * (ISanctionsList.isSanctioned), as the Diamond does without its fail-open
 * try/catch.
 */

export const WATCHED_CONFIG = Object.freeze([
  // The auto-match posture the banners disclose.
  { key: 'paused', fn: 'paused' },
  { key: 'autoRefinance', fn: 'getAutoRefinanceEnabled' },
  // The matching kill-switch, from its own getter (#2812 retired the
  // `getMasterFlags` tuple it used to be read from).
  { key: 'partialFill', fn: 'getPartialFillEnabled' },
  // The fees both reviews quote (and the borrower's reserve is sized with).
  { key: 'treasuryFeeBps', fn: 'getFeesConfig', pick: (r) => r[0] },
  { key: 'lifBps', fn: 'getLoanInitiationFeeBps' },
  // The grace window the reviews show and the payoff approval is sized to.
  { key: 'graceBuckets', fn: 'getGraceBuckets' },
  // The risk-terms epoch the lender's AcceptTerms is anchored to.
  { key: 'riskTermsHash', fn: 'getCurrentRiskTermsHash' },
  // Per-asset pauses (RefinanceFlow's assertAssetNotPausedLive, both legs).
  { key: 'principalPaused', fn: 'isAssetPaused', args: (c) => [c.principalAsset] },
  { key: 'collateralPaused', fn: 'isAssetPaused', args: (c) => [c.collateralAsset] },
  // The form's upper bound on the new length.
  { key: 'maxOfferDurationDays', fn: 'getProtocolConfigBundle', pick: bundleField('maxOfferDurationDays') },
  // Preconditions that change what an accept requires.
  { key: 'riskAccessGate', fn: 'getRiskAccessGateEnabled' },
  { key: 'sanctionsOracle', fn: 'getSanctionsOracle' },
]);

/** The Diamond getter the per-participant screening reads (with the oracle). */
export const SCREEN_GETTER = 'isSanctionedAddress';

/**
 * One participant's sanctions screening, TRI-STATE — the rule the preflight
 * has used since #2422 r3/r4, now part of the snapshot:
 *   oracle unset → `unset` (it screened nobody — stated, never "clean");
 *   oracle set   → asked DIRECTLY; `flagged` if it or the Diamond says so,
 *                  `clean` only if it ANSWERED not-flagged and the Diamond
 *                  agrees; a failed oracle call is `unavailable`.
 * Error text is left out on purpose: the snapshot is compared field by
 * field, and the wording of one RPC failure must not read as a change.
 */
export async function screenParticipant({ read, readOracle, who, oracle, blockNumber }) {
  const diamondSays = await read(SCREEN_GETTER, [who], blockNumber);
  if (/^0x0{40}$/i.test(String(oracle))) return { state: 'unset', diamondSays };
  try {
    const oracleSays = await readOracle(oracle, who, blockNumber);
    return { state: oracleSays || diamondSays ? 'flagged' : 'clean', oracleSays, diamondSays };
  } catch {
    return { state: 'unavailable', diamondSays };
  }
}

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
  getAutoRefinanceCaps: 'one loan’s caps',
  calculateRepaymentAmount: 'one loan’s payoff',
  getLoanCollateralLien: 'one loan’s lien',
  ownerOf: 'one position NFT’s holder',
  getUserVaultAddress: 'one user’s vault',
  hasAcceptedCurrentTerms: 'one user’s terms acceptance',
  checkLiquidity: 'external oracle / pool state — a precondition on the collateral only, never a model input',
  checkRefinanceRequest: 'one refinance request’s standing against its loan (reverts when it cannot be taken)',
  getRefinanceRequest: 'one loan’s recorded refinance request',
});

/** The Diamond getters the snapshot reads (the screening's included). */
export const WATCHED_GETTERS = Object.freeze([...new Set([...WATCHED_CONFIG.map((e) => e.fn), SCREEN_GETTER])]);

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
  for (const [label, who] of Object.entries(ctx.participants ?? {})) {
    out[`screen:${label}`] = await screenParticipant({ read, readOracle: ctx.readOracle, who, oracle: out.sanctionsOracle, blockNumber });
  }
  return out;
}
