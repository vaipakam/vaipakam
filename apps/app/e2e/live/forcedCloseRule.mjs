/**
 * The forced-close card's decision, as this drive re-derives it at the
 * block the card names (#2133).
 *
 * The card publishes the state it resolved (`data-forced-close-state`) and
 * the block its facts came from (`data-forced-close-block`). Until #2133
 * the drive checked that declaration against TWO facts read at that block
 * (the defaultability view and the internal-match probe), so a card that
 * named the wrong refusal passed: the grace window still open, and the
 * card saying the protocol was paused, read the same to a drive that never
 * looked at the pause flag.
 *
 * So the drive now asks the chain the card's own questions. At the named
 * block it issues the page's read plan, maps the answers the way the page
 * does, and runs the page's rule over them. The three pieces are MIRRORS
 * of the app's code:
 *
 *   - `forcedCloseReadPlan` / `forcedCloseFacts` mirror
 *     `src/data/forcedCloseReads.ts` (what is read, and how each answer
 *     becomes a fact);
 *   - `decideForcedClose` mirrors `src/data/forcedClose.ts` (which state
 *     those facts resolve to, in the contract's order).
 *
 * The drive is plain Node and does not load TypeScript at run time, so
 * `forcedCloseRule.test.mjs` imports the app's modules and checks each
 * mirror against them (the `chooserEligibility.mjs` precedent). A gate the
 * page gains and this file lacks fails CI instead of passing a card on a
 * reason nobody checked.
 *
 * `statesReachable` is the one piece the app has no counterpart for. A
 * read the drive could not get is not a value, so it asks which states the
 * rule could resolve to over every value the unread facts could take. One
 * reachable state is a verified decision; the declared state outside that
 * set is a contradiction; anything else is unjudged and says so.
 *
 * Imports nothing.
 */

/** `contracts/loanLive.LOAN_STATUS_ACTIVE`. */
const LOAN_STATUS_ACTIVE = 0;
/** `contracts/preflights.LIQUIDITY_LIQUID`. */
const LIQUIDITY_LIQUID = 0;
/** `lib/types.AssetType.ERC20`. */
const ASSET_ERC20 = 0;

/** `forcedCloseReads.MULTICALL3_BLOCK_NUMBER_ABI`. */
export const MULTICALL3_BLOCK_NUMBER_ABI = [
  {
    type: 'function',
    name: 'getBlockNumber',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'blockNumber', type: 'uint256' }],
  },
];

/**
 * The page's read plan, in its order. `diamondAbi` is passed in so this
 * module stays import-free; the drive passes the same compiled Diamond ABI
 * the page is built with.
 *
 * @param {{ diamond: string, diamondAbi: readonly unknown[], multicall3: string,
 *   loanId: bigint, collateralAsset: string | undefined }} input
 */
export function forcedCloseReadPlan(input) {
  const d = { address: input.diamond, abi: input.diamondAbi };
  const plan = [
    {
      key: 'block',
      contract: { address: input.multicall3, abi: MULTICALL3_BLOCK_NUMBER_ABI, functionName: 'getBlockNumber' },
    },
    { key: 'loan', contract: { ...d, functionName: 'getLoanDetails', args: [input.loanId] } },
    { key: 'defaultable', contract: { ...d, functionName: 'isLoanDefaultable', args: [input.loanId] } },
    { key: 'sequencer', contract: { ...d, functionName: 'sequencerHealthy' } },
    { key: 'paused', contract: { ...d, functionName: 'paused' } },
    { key: 'kyc', contract: { ...d, functionName: 'defaultKycAdmission', args: [input.loanId] } },
    { key: 'match', contract: { ...d, functionName: 'hasInternalMatchCandidate', args: [input.loanId] } },
    { key: 'matchConfig', contract: { ...d, functionName: 'getInternalMatchConfigBundle' } },
  ];
  if (input.collateralAsset !== undefined) {
    plan.push({
      key: 'liquidity',
      contract: { ...d, functionName: 'checkLiquidityOnActiveNetwork', args: [input.collateralAsset] },
    });
  }
  plan.push(
    { key: 'ltv', contract: { ...d, functionName: 'calculateLTV', args: [input.loanId] } },
    { key: 'risk', contract: { ...d, functionName: 'getRiskConfig' } },
  );
  return plan;
}

/** The facts the rule takes, in `ForcedCloseFacts` order. */
export const FORCED_CLOSE_FACTS = Object.freeze([
  'active',
  'consentFromBoth',
  'assetType',
  'collateralIsNft',
  'defaultable',
  'sequencerHealthy',
  'paused',
  'lenderKycAdmitted',
  'internalMatchCandidate',
  'collateralIlliquid',
  'ltvCollapsed',
]);

/** Facts the page reads for a DISCLOSURE, not for the decision (#2082):
 *  `internalMatchEnabled` picks the card's match-race sentence and never
 *  moves the state, so it is mapped here and kept out of the rule's inputs
 *  (and out of `statesReachable`'s enumeration). */
export const DISCLOSURE_FACTS = Object.freeze(['internalMatchEnabled']);

/**
 * `forcedCloseReads.forcedCloseFacts`: each multicall slot to a fact,
 * `undefined` where the slot failed or did not decode. No block, no facts,
 * exactly as the page treats it.
 *
 * @param {ReadonlyArray<{key: string, contract: {args?: readonly unknown[]}}>} plan
 * @param {ReadonlyArray<{status: 'success'|'failure', result?: unknown}>} slots
 */
export function forcedCloseFacts(plan, slots) {
  if (slots.length !== plan.length) {
    throw new Error(`forced-close aggregate returned ${slots.length} slot(s) for a plan of ${plan.length}`);
  }
  const ok = new Map();
  plan.forEach((entry, i) => {
    if (slots[i].status === 'success') ok.set(entry.key, slots[i].result);
  });
  const blockRaw = ok.get('block');
  if (typeof blockRaw !== 'bigint') {
    return {
      block: undefined,
      ...Object.fromEntries([...FORCED_CLOSE_FACTS, ...DISCLOSURE_FACTS].map((k) => [k, undefined])),
    };
  }
  const bool = (key) => (ok.has(key) ? Boolean(ok.get(key)) : undefined);
  const loanRaw = ok.get('loan');
  const kycRaw = ok.get('kyc');
  const matchRaw = ok.get('match');
  const matchConfigRaw = ok.get('matchConfig');
  const liquidityRaw = ok.get('liquidity');
  const ltvRaw = ok.get('ltv');
  const riskRaw = ok.get('risk');
  const loan = loanRaw !== null && typeof loanRaw === 'object' ? loanRaw : undefined;
  const enumField = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined);
  const status = enumField(loan?.status);
  const principalType = enumField(loan?.assetType);
  const collateralType = enumField(loan?.collateralAssetType);
  const askedAsset = plan.find((e) => e.key === 'liquidity')?.contract.args?.[0];
  const structAsset = loan?.collateralAsset;
  const liquidityAboutThisLoan =
    typeof askedAsset === 'string' &&
    typeof structAsset === 'string' &&
    askedAsset.toLowerCase() === structAsset.toLowerCase();
  return {
    block: blockRaw,
    active: status === undefined ? undefined : status === LOAN_STATUS_ACTIVE,
    consentFromBoth:
      typeof loan?.riskAndTermsConsentFromBoth === 'boolean' ? loan.riskAndTermsConsentFromBoth : undefined,
    assetType: principalType === undefined ? undefined : principalType === ASSET_ERC20 ? 'erc20' : 'rental',
    collateralIsNft: collateralType === undefined ? undefined : collateralType !== ASSET_ERC20,
    defaultable: bool('defaultable'),
    sequencerHealthy: bool('sequencer'),
    paused: bool('paused'),
    lenderKycAdmitted: Array.isArray(kycRaw) && typeof kycRaw[0] === 'boolean' ? kycRaw[0] : undefined,
    internalMatchCandidate: Array.isArray(matchRaw) ? Boolean(matchRaw[0]) : undefined,
    internalMatchEnabled:
      Array.isArray(matchConfigRaw) && typeof matchConfigRaw[0] === 'boolean' ? matchConfigRaw[0] : undefined,
    collateralIlliquid:
      liquidityRaw === undefined || !liquidityAboutThisLoan ? undefined : Number(liquidityRaw) !== LIQUIDITY_LIQUID,
    ltvCollapsed:
      typeof ltvRaw === 'bigint' && Array.isArray(riskRaw) && typeof riskRaw[0] === 'bigint'
        ? ltvRaw > riskRaw[0]
        : undefined,
  };
}

/** `forcedClose.decideForcedClose`: same gates, same order. */
export function decideForcedClose(input) {
  if (input.active === undefined) return 'unknown';
  if (!input.active) return 'not-applicable';
  if (input.paused === true) return 'blocked-paused';
  if (input.paused === undefined) return 'unknown';
  if (input.lenderKycAdmitted === false) return 'blocked-kyc';
  if (input.lenderKycAdmitted === undefined) return 'unknown';
  if (input.defaultable === undefined) return 'unknown';
  if (!input.defaultable) return 'not-yet';
  if (input.sequencerHealthy === false) return 'blocked-sequencer';
  if (input.sequencerHealthy === undefined) return 'unknown';
  if (input.internalMatchCandidate === undefined) return 'unknown';
  if (input.internalMatchCandidate) return 'ready-internal-match';
  if (input.assetType === undefined) return 'unknown';
  if (input.assetType === 'rental') return 'ready-rental';
  if (input.collateralIsNft === undefined) return 'unknown';
  if (input.collateralIsNft) return inKindIfConsented(input.consentFromBoth);
  if (input.collateralIlliquid === undefined) return 'unknown';
  if (input.collateralIlliquid) return inKindIfConsented(input.consentFromBoth);
  if (input.ltvCollapsed === undefined) return 'unknown';
  if (input.ltvCollapsed) return 'ready-in-kind';
  return 'ready-needs-route';
}

function inKindIfConsented(consentFromBoth) {
  if (consentFromBoth === undefined) return 'unknown';
  return consentFromBoth ? 'ready-in-kind' : 'blocked-no-consent';
}

/** The values a fact can take on chain. `assetType` is the one non-boolean. */
const DOMAIN = Object.freeze({ assetType: ['erc20', 'rental'] });
const domainOf = (k) => DOMAIN[k] ?? [false, true];

/**
 * Every state the rule can resolve to, given the facts that WERE read and
 * any value for the ones that were not. Read facts are held fixed; an
 * unread one ranges over its whole domain. `unknown` is therefore never
 * reachable: it is the page's answer to an unread fact, and the chain
 * always holds a value.
 *
 * @param {Record<string, unknown> | undefined} facts
 * @returns {Set<string>}
 */
export function statesReachable(facts) {
  const unread = FORCED_CLOSE_FACTS.filter((k) => facts?.[k] === undefined);
  const out = new Set();
  const walk = (i, input) => {
    if (i === unread.length) {
      out.add(decideForcedClose(input));
      return;
    }
    for (const v of domainOf(unread[i])) walk(i + 1, { ...input, [unread[i]]: v });
  };
  walk(0, { ...Object.fromEntries(FORCED_CLOSE_FACTS.map((k) => [k, facts?.[k]])) });
  return out;
}

/**
 * The facts the drive could not read at a block, by the view behind each,
 * so an unjudged comparison can say what it lacked.
 */
const VIEW_OF = Object.freeze({
  active: 'getLoanDetails',
  consentFromBoth: 'getLoanDetails',
  assetType: 'getLoanDetails',
  collateralIsNft: 'getLoanDetails',
  defaultable: 'isLoanDefaultable',
  sequencerHealthy: 'sequencerHealthy',
  paused: 'paused',
  lenderKycAdmitted: 'defaultKycAdmission',
  internalMatchCandidate: 'hasInternalMatchCandidate',
  collateralIlliquid: 'checkLiquidityOnActiveNetwork',
  ltvCollapsed: 'calculateLTV / getRiskConfig',
});

/** The views behind the unread facts, de-duplicated, in plan order. */
export function unreadViews(facts) {
  return [...new Set(FORCED_CLOSE_FACTS.filter((k) => facts?.[k] === undefined).map((k) => VIEW_OF[k]))];
}
