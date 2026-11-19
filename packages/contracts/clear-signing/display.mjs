/**
 * @file What a wallet shows for each Diamond call and typed message a person
 *       signs (#3348, #3718 step 1). scripts/build-clear-signing.mjs turns
 *       this file, the exported ABIs and the Solidity sources into ERC-7730
 *       descriptors under clear-signing/descriptors/.
 *
 * Every input of every `user` function in scope.json must resolve to a field
 * rule, in this order (the first that matches wins):
 *   1. CALLS[<Facet.fn>].fields[<path>]  — this call only
 *   2. STRUCTS[<struct type>][<member>]  — the member of that struct, anywhere
 *   3. LEAVES[<name>]                    — any input or member with that name
 * A leaf that matches none fails the build. Hiding a field takes a stated
 * reason (`hide(...)`); there is no silent default.
 *
 * Copy rules: plain words, no promise of a return, no "safe". An amount the
 * call does not tie to a token is labelled as smallest units of the asset it
 * belongs to, never formatted as if the wallet knew the token.
 */

// ── Field rule helpers ──────────────────────────────────────────────────
// A string starting with `~` in a path parameter names a SIBLING of the field
// (same struct, same array element); the generator resolves it.

/** Any value shown as it is. */
export const raw = (label) => ({ label, format: 'raw' });
/** A field shown only when it is not one of `values`. */
export const unless = (rule, values) => ({ ...rule, visible: { ifNotIn: values } });
/** An amount of the token at the sibling address field `token`. */
export const tokenAmount = (label, token) => ({ label, format: 'tokenAmount', params: { tokenPath: `~${token}` } });
/** An amount the call does not tie to a token address: stated as base units. */
export const baseUnits = (label) => raw(`${label} (smallest units)`);
/** Basis points shown as a percentage. */
export const percent = (label) => ({ label, format: 'unit', params: { base: '%', decimals: 2 } });
/** A 1e18-scaled health factor. */
export const healthFactor = (label) => ({ label, format: 'unit', params: { base: '', decimals: 18 } });
/** A VPFI amount (18 decimals). The token address differs per chain. */
export const vpfi = (label) => ({ label, format: 'unit', params: { base: 'VPFI', decimals: 18 } });
/** A unix timestamp. */
export const date = (label) => ({ label, format: 'date', params: { encoding: 'timestamp' } });
/** A number of seconds. */
export const seconds = (label) => ({ label, format: 'duration' });
/** An address shown by name where the wallet knows one. */
export const address = (label, types) => ({ label, format: 'addressName', params: { types } });
export const asset = (label) => address(label, ['token', 'collection']);
export const account = (label) => address(label, ['eoa', 'wallet', 'contract']);
/** An enum declared in Solidity (`Lib.Name` or a file-level `Name`). */
export const solEnum = (label, name, labels) => ({ label, format: 'enum', enum: { solidity: name, labels } });
/** uint constants sharing a prefix in a contract or library, read from source. */
export const constEnum = (label, of, prefix, labels, except = []) => ({
  label,
  format: 'enum',
  enum: { constants: { of, prefix, labels, except } },
});
/** A bit-flag set built from uint constants: every combination is named. */
export const flagSet = (label, of, prefix, labels, { except = [], none } = {}) => ({
  label,
  format: 'enum',
  enum: { flags: { of, prefix, labels, except, none } },
});
/** Values documented only in prose (`where` names the comment). */
export const literalEnum = (label, name, values, where) => ({ label, format: 'enum', enum: { literal: { name, values, where } } });
/** An address the wallet must find equal to this chain's Diamond; never shown. */
export const mustBeDiamond = () => ({ mustMatchDiamond: true });
/** Never shown. `why` says why the signer has nothing to decide there. */
export const hide = (why) => ({ hide: why });

const ZERO = '0x0000000000000000000000000000000000000000';
const optionalAddress = (rule) => unless(rule, [ZERO]);

// ── Shared reasons ──────────────────────────────────────────────────────
const SIG = 'a signature; it carries nothing to read, the contract checks it';
const SALT = 'a random value that keeps the order unique';
const PROOF = 'a Merkle proof the contract checks against the signed set';
const COMMIT = 'a hash of terms shown elsewhere on this screen; the contract checks it';
const NONCE = 'a replay counter; the contract checks it';
const ROUTE = 'swap route data the app builds; the call bounds the result by the amounts shown';

// ── Metadata ────────────────────────────────────────────────────────────
export const META = {
  owner: 'Vaipakam',
  url: 'https://vaipakam.com',
};

// ── Global leaf rules ───────────────────────────────────────────────────
export const LEAVES = {
  loanId: raw('Loan ID'),
  originalLoanId: raw('Loan ID'),
  offerId: raw('Offer ID'),
  borrowerOfferId: raw('Borrower offer ID'),
  buyOfferId: raw('Buy offer ID'),
  streamId: raw('Stream ID'),
  perkId: raw('Perk ID'),
  validUntil: date('Valid until'),
  deadline: date('Deadline'),
  expiresAt: unless(date('Offer expires'), [0]),
  nonce: hide(NONCE),
  signature: hide(SIG),
  sig: hide(SIG),
  acceptSig: hide(SIG),
  acceptSignature: hide(SIG),
  coSignature: hide(SIG),
  permitSig: hide(SIG),
  permitSignature: hide(SIG),
  salt: hide(SALT),
  newSalt: hide(SALT),
  proof: hide(PROOF),
  criteriaProof: hide(PROOF),
  conduitKey: raw('Seaport conduit'),
  newConduitKey: raw('Seaport conduit'),
  slot: raw('Auto-lend slot'),
  lendingAsset: asset('Lending asset'),
  collateralAsset: asset('Collateral asset'),
  prepayAsset: optionalAddress(asset('Rental fee asset')),
  asset: asset('Asset'),
  account: account('Account'),
  user: account('Account'),
  keeper: account('Keeper'),
  integrator: optionalAddress(account('Integrator')),
  enabled: raw('Turn on'),
  on: raw('Turn on'),
  riskAndTermsConsent: raw('Risk terms accepted'),
  creatorRiskAndTermsConsent: raw('Risk terms accepted'),
  interestRateBps: percent('Interest rate (yearly)'),
  interestRateBpsMax: percent('Max interest rate'),
  durationDays: raw('Term (days)'),
  tokenId: raw('Token ID (NFT only)'),
  quantity: raw('Quantity (ERC-1155 only)'),
  collateralTokenId: raw('Collateral token ID'),
  collateralQuantity: raw('Collateral quantity'),
  allowsPartialRepay: raw('Partial repay allowed'),
  allowsPrepayListing: raw('Collateral sale listing allowed'),
  allowsParallelSale: raw('Parallel sale allowed'),
  useFullTermInterest: raw('Full-term interest'),
  refinanceTargetLoanId: unless(raw('Refinances loan'), [0]),
  periodicInterestCadence: solEnum('Interest paid', 'LibVaipakam.PeriodicInterestCadence', {
    None: 'At the end',
    Monthly: 'Monthly',
    Quarterly: 'Quarterly',
    SemiAnnual: 'Every six months',
    Annual: 'Yearly',
  }),
  offerType: solEnum('Offer side', 'LibVaipakam.OfferType', { Lender: 'Lend', Borrower: 'Borrow' }),
  assetType: solEnum('Lending asset type', 'LibVaipakam.AssetType', ASSET_TYPE_LABELS()),
  collateralAssetType: solEnum('Collateral type', 'LibVaipakam.AssetType', ASSET_TYPE_LABELS()),
  fillMode: solEnum('Fill', 'LibVaipakam.FillMode', {
    Partial: 'Partial fills allowed',
    Aon: 'All or nothing',
    Ioc: 'Fill now or cancel',
  }),
  lifecycleFlex: flagSet(
    'May differ on fill',
    'LibVaipakam',
    'LIFECYCLE_FLEX_',
    {
      LIFECYCLE_FLEX_PARTIAL_REPAY: 'Partial repay option',
      LIFECYCLE_FLEX_PREPAY_LISTING: 'Sale listing option',
    },
    { except: ['LIFECYCLE_FLEX_MASK'], none: 'Nothing; both options as offered' },
  ),
  actions: flagSet(
    'Allowed actions',
    'LibVaipakam',
    'KEEPER_ACTION_',
    {
      KEEPER_ACTION_COMPLETE_LOAN_SALE: 'Complete loan sale',
      KEEPER_ACTION_COMPLETE_OFFSET: 'Complete offset',
      KEEPER_ACTION_INIT_EARLY_WITHDRAW: 'Start loan sale',
      KEEPER_ACTION_INIT_PRECLOSE: 'Start early repay',
      KEEPER_ACTION_EXTEND: 'Extend loan',
      KEEPER_ACTION_SIGNED_FILL: 'Fill your Auto-lend',
      KEEPER_ACTION_AUTO_ROLL: 'Relend repaid funds',
      KEEPER_ACTION_LOCK_VAULT: 'Lock your account',
    },
    { except: ['KEEPER_ACTION_ALL'], none: 'None' },
  ),
  amountMax: raw('Max amount'),
  collateralAmountMax: raw('Max collateral'),
  deliverTo: solEnum('Deliver to', 'LibVaipakam.RewardDelivery', {
    Default: 'Your saved choice',
    Wallet: 'Wallet',
    Vault: 'Vault',
    SanctionsHeld: 'Held',
  }),
  kind: solEnum('Asset kind', 'VaultOutflowTypes.AssetKind', ASSET_TYPE_LABELS()),
  level: solEnum('Asset access', 'LibVaipakam.RiskAccessLevel', {
    BlueChipOnly: 'Blue-chip only',
    BroadLiquid: 'Broad liquid',
    IlliquidCustom: 'Illiquid, custom',
  }),
  recipient: account('Recipient'),
  adapterIdx: raw('Swap route'),
  data: hide(ROUTE),
};

/** The asset-type labels, shared by every AssetType field. */
function ASSET_TYPE_LABELS() {
  return { ERC20: 'Token (ERC-20)', ERC721: 'NFT (ERC-721)', ERC1155: 'NFT (ERC-1155)' };
}

// ── Struct rules ────────────────────────────────────────────────────────
// Keyed by the Solidity struct name as the ABI's internalType states it.
const CREATE_OFFER_PARAMS = {
  amount: tokenAmount('Amount or rental fee', 'lendingAsset'),
  amountMax: tokenAmount('Max amount', 'lendingAsset'),
  collateralAmount: tokenAmount('Collateral', 'collateralAsset'),
  collateralAmountMax: tokenAmount('Max collateral', 'collateralAsset'),
};

const ACCEPT_TERMS = {
  acceptor: account('You (acceptor)'),
  offerCreator: account('Offer by'),
  offerKey: hide(COMMIT),
  amount: tokenAmount('Amount or rental fee', 'lendingAsset'),
  collateralAmount: tokenAmount('Collateral', 'collateralAsset'),
  linkedLoanId: unless(raw('Linked loan'), [0]),
  parallelSaleOrderHash: hide(COMMIT),
  acknowledgedIlliquidLendingAsset: optionalAddress(asset('Illiquid asset acknowledged')),
  acknowledgedIlliquidCollateralAsset: optionalAddress(asset('Illiquid collateral acknowledged')),
  deadline: date('Acceptance valid until'),
  riskTermsHash: hide(COMMIT),
  acceptorFull: raw('Pay your fee in VPFI'),
  acceptorMaxCStar: vpfi('Max VPFI fee'),
  acceptorAllowFullDowngrade: raw('Fall back if VPFI fee too high'),
};

const SIGNED_OFFER = {
  amount: tokenAmount('Amount or rental fee', 'lendingAsset'),
  amountMax: tokenAmount('Max amount', 'lendingAsset'),
  collateralAmount: tokenAmount('Collateral', 'collateralAsset'),
  collateralAmountMax: tokenAmount('Max collateral', 'collateralAsset'),
  creatorFull: raw('Maker pays fee in VPFI'),
  creatorMaxCStar: vpfi('Maker max VPFI fee'),
  creatorAllowFullDowngrade: raw('Maker falls back if VPFI fee too high'),
  maxTreasuryFeeBps: percent('Max treasury fee'),
  maxLoanInitiationFeeBps: percent('Max initiation fee'),
  allowedTaker: optionalAddress(account('Only this taker')),
  coSigner: optionalAddress(account('Co-signer')),
  signer: account('Signed by'),
  deadline: date('Signature valid until'),
  setKind: solEnum('Collateral set', 'LibVaipakam.CollateralSetKind', {
    None: 'One collateral',
    Collection: 'Any token of a collection',
    Range: 'A token ID range',
    Listed: 'Listed token IDs',
  }),
  setLow: raw('Token IDs from'),
  setHigh: raw('Token IDs to'),
  setRoot: hide(COMMIT),
  setListCount: raw('Listed token count'),
  setListHash: hide(COMMIT),
  exclusionsHash: hide(COMMIT),
  loans: raw('Number of loans'),
  startTime: unless(date('Opens at'), [0]),
};

export const STRUCTS = {
  'LibVaipakam.CreateOfferParams': CREATE_OFFER_PARAMS,
  'LibVaipakam.OfferModifyParams': {
    amount: baseUnits('Amount'),
    amountMax: baseUnits('Max amount'),
    collateralAmount: baseUnits('Collateral'),
    collateralAmountMax: baseUnits('Max collateral'),
  },
  'LibAcceptTerms.AcceptTerms': ACCEPT_TERMS,
  'LibSignedOffer.SignedOffer': SIGNED_OFFER,
  'LibSignedOffer.OfferSet': {
    others: hide('the other offers signed in the same set; the contract checks the set signature'),
    index: hide('this offer\'s place in the signed set'),
  },
  'LibSignedOffer.FillAuth': {
    validUntil: date('Co-signature valid until'),
  },
  'LibCollateralSet.SetInput': {
    kind: solEnum('Collateral set', 'LibVaipakam.CollateralSetKind', {
      None: 'One collateral',
      Collection: 'Any token of a collection',
      Range: 'A token ID range',
      Listed: 'Listed token IDs',
    }),
    low: raw('Token IDs from'),
    high: raw('Token IDs to'),
    root: hide(COMMIT),
    listCount: raw('Listed token count'),
    listHash: hide(COMMIT),
    label: raw('Set name'),
    exclusions: raw('Excluded token IDs'),
  },
  'CollectionOfferFacet.SignedTake': {
    tokenId: raw('Your collateral token ID'),
    exclusions: hide('the excluded token IDs the signed offer already commits to'),
  },
  'InstantMarketFacet.InstantBorrowRequest': {
    amountWanted: tokenAmount('Borrow', 'lendingAsset'),
    collateralOffered: tokenAmount('Collateral', 'collateralAsset'),
    kind: constEnum('Rate', 'InstantMarketFacet', 'KIND_', { KIND_FIXED: 'Fixed' }),
    termDays: raw('Term (days)'),
    maxRateBps: percent('Max interest rate'),
    minTotal: tokenAmount('Least to borrow', 'lendingAsset'),
    rateFarFromAverageAcknowledged: raw('Rate far from recent average: acknowledged'),
  },
  'InstantFillFacet.InstantSource': {
    kind: literalEnum('Source', 'InstantSourceKind', { 0: 'Auto-lend slot', 1: 'Standing lender offer' }, 'InstantFillFacet.InstantSource @dev'),
    owner: account('Lender'),
    offerId: unless(raw('Offer ID'), [0]),
  },
  'MulticallFacet.Call': {
    callData: { label: 'Call', format: 'calldata', params: { calleePath: '@.to' } },
    allowFailure: raw('Continue if this call fails'),
  },
  FeeLeg: {
    recipient: account('Fee to'),
    startAmount: baseUnits('Fee at start'),
    endAmount: baseUnits('Fee at end'),
  },
  BidderOrder: {
    signature: hide(SIG),
    extraData: hide('Seaport data for the bidder\'s order; the contract checks it'),
  },
  OrderComponents: {
    offerer: account('Bidder'),
    zone: hide('the bidder order\'s Seaport zone; the contract checks it'),
    orderType: hide('the bidder order\'s Seaport order type; the contract checks it'),
    startTime: hide('the bidder order\'s own start time'),
    endTime: date('Bid valid until'),
    zoneHash: hide(COMMIT),
    counter: hide(NONCE),
  },
  OfferItem: {
    itemType: hide('the Seaport item type of the bid; the contract refuses anything but the loan\'s asset'),
    token: asset('Bid asset'),
    identifierOrCriteria: hide('unused for a token bid'),
    startAmount: tokenAmount('Bid', 'token'),
    endAmount: hide('equal to the bid for the fixed bids the contract accepts'),
  },
  ConsiderationItem: {
    itemType: hide('what the bidder receives (the collateral NFT); the contract checks it against the loan'),
    token: hide('what the bidder receives (the collateral NFT); the contract checks it against the loan'),
    identifierOrCriteria: hide('what the bidder receives (the collateral NFT); the contract checks it against the loan'),
    startAmount: hide('what the bidder receives (the collateral NFT); the contract checks it against the loan'),
    endAmount: hide('what the bidder receives (the collateral NFT); the contract checks it against the loan'),
    recipient: hide('what the bidder receives (the collateral NFT); the contract checks it against the loan'),
  },
  CriteriaResolver: {
    orderIndex: hide('Seaport criteria resolution; the contract checks it'),
    side: hide('Seaport criteria resolution; the contract checks it'),
    index: hide('Seaport criteria resolution; the contract checks it'),
    identifier: hide('Seaport criteria resolution; the contract checks it'),
  },
  'ISignatureTransfer.PermitTransferFrom': {
    deadline: date('Permit valid until'),
  },
  'ISignatureTransfer.TokenPermissions': {
    token: asset('Permit token'),
    amount: tokenAmount('Permit amount', 'token'),
  },
  'LibRiskAccess.PairId': {
    lendAsset: asset('Lending asset'),
    lendType: solEnum('Lending asset type', 'LibVaipakam.AssetType', ASSET_TYPE_LABELS()),
    lendTokenId: raw('Lending token ID'),
    collAsset: asset('Collateral asset'),
    collType: solEnum('Collateral type', 'LibVaipakam.AssetType', ASSET_TYPE_LABELS()),
    collTokenId: raw('Collateral token ID'),
  },
  'LibServiceCapacity.ArmingBind': {
    maxFee: vpfi('Max fee'),
    minCapacityAfter: raw('Least capacity after'),
    expectedRotationEpoch: hide('the quote this deposit was reviewed under; a change refuses it'),
    expectedCurveEpoch: hide('the quote this deposit was reviewed under; a change refuses it'),
  },
  'LibVaipakam.StandingInstructionConfig': {
    triggerMinHf: healthFactor('Lowest top-up trigger'),
    triggerMaxHf: healthFactor('Highest top-up trigger'),
    targetMaxHf: healthFactor('Highest top-up target'),
    minMarginHf: healthFactor('Least trigger-to-target gap'),
    topUpIntervalSeconds: seconds('Time between top-ups'),
  },
  'StandingInstructionFacet.InstructionInput': {
    topUpTriggerHf: unless(healthFactor('Top up collateral below'), [0]),
    topUpTargetHf: healthFactor('Top up to'),
    payInterest: raw('Pay interest from reserve'),
    repayAtDue: raw('Repay at due date from reserve'),
    repayLeadSeconds: seconds('Repay this long before due'),
  },
  'SwapToRepayIntentFacet.FusionOrderParams': {
    takerAmount: baseUnits('Repay amount asked'),
    deadline: date('Order ends'),
    makerTraits: hide('1inch order flags the app builds; the contract checks them against the deadline'),
    extension: hide('1inch order extension the app builds; the contract checks it'),
  },
  'LibSwap.AdapterCall': {},
  'VaultOutflowTypes.ClawbackAsset': {},
};

// ── Per-call intents and overrides ──────────────────────────────────────
// `intent` is required for every user function. `fields` overrides any rule
// above for that call's paths.
export const CALLS = {
  'AccessControlFacet.renounceRole': {
    intent: 'Give up a role',
    fields: { role: raw('Role'), callerConfirmation: account('Your address') },
  },
  'AddCollateralFacet.addCollateral': {
    intent: 'Add collateral to a loan',
    fields: { amount: baseUnits('Collateral to add') },
  },
  'AggregatorAdapterFactoryFacet.upgradeAggregatorAdapter': {
    intent: 'Upgrade a lending adapter',
    fields: { adapter: account('Adapter') },
  },
  'AutoLifecycleSettingsFacet.setAutoExtendBorrowerCaps': {
    intent: 'Set auto-extend limits (borrower)',
    fields: {
      enabled: raw('Auto-extend on'),
      minRateBps: percent('Least new rate'),
      maxRateBps: percent('Most new rate'),
      maxNewExpiry: date('Latest new due date'),
      maxExtensionFee: baseUnits('Most extension fee'),
    },
  },
  'AutoLifecycleSettingsFacet.setAutoExtendLenderCaps': {
    intent: 'Set auto-extend limits (lender)',
    fields: {
      enabled: raw('Auto-extend on'),
      minRateBps: percent('Least new rate'),
      maxRateBps: percent('Most new rate'),
      maxNewExpiry: date('Latest new due date'),
    },
  },
  'AutoLifecycleSettingsFacet.setAutoLendConsent': {
    intent: 'Set auto-lend consent',
    fields: { enabled: raw('Allow auto-lend') },
  },
  'AutoLifecycleSettingsFacet.setAutoOptInOnNewLoan': {
    intent: 'Set auto options on new loans',
    fields: { enabled: raw('Opt new loans in') },
  },
  'AutoLifecycleSettingsFacet.setAutoRefinanceCaps': {
    intent: 'Set auto-refinance limits',
    fields: {
      enabled: raw('Auto-refinance on'),
      maxRateBps: percent('Most new rate'),
      maxNewExpiry: date('Latest new due date'),
    },
  },
  'AutoLifecycleSettingsFacet.setDefaultAutoRefinanceCaps': {
    intent: 'Set default auto-refinance limits',
    fields: {
      enabled: raw('Auto-refinance on'),
      maxRateBps: percent('Most new rate'),
      maxNewExpiry: date('Latest new due date'),
    },
  },
  'BackstopFacet.setOfferBackstopEligible': {
    intent: 'Let the backstop fill your offer',
    fields: { eligibleAfter: date('From') },
  },
  'ClaimFacet.claimAsBorrower': { intent: 'Claim as borrower' },
  'ClaimFacet.claimAsLender': { intent: 'Claim as lender' },
  'ClaimFacet.claimAsLenderViaBackstop': { intent: 'Claim as lender through the backstop' },
  'ClaimFacet.claimAsLenderWithRetry': { intent: 'Claim as lender, retrying the sale' },
  'ClaimFacet.claimHeldForBorrower': { intent: 'Claim held funds (borrower)' },
  'ClaimFacet.claimHeldForLender': { intent: 'Claim held funds (lender)' },
  'ClaimFacet.setLenderBackstopOptIn': {
    intent: 'Set backstop choice for a loan',
    fields: { optIn: raw('Use the backstop') },
  },
  'CollectionOfferFacet.createCollectionOffer': {
    intent: 'Create a collection offer',
    fields: {
      loans: raw('Number of loans'),
      publishedIds: raw('Listed token IDs'),
      validUntil: date('Valid until'),
    },
  },
  'CollectionOfferFacet.fillCollectionOffer': {
    intent: 'Borrow against a collection offer',
    fields: { tokenId: raw('Your collateral token ID') },
  },
  'CollectionOfferFacet.fillSignedCollectionOffer': { intent: 'Borrow against a signed collection offer' },
  'CollectionOfferFacet.reduceCollectionLoans': {
    intent: 'Reduce a collection offer',
    fields: { loansLeft: raw('Loans left') },
  },
  'ConsolidationFacet.consolidateCollateralToHolder': { intent: 'Move collateral to the position holder' },
  'ConsolidationFacet.consolidatePrincipalToHolder': { intent: 'Move principal to the position holder' },
  'EarlyWithdrawalDirectFacet.sellLoanViaBuyOffer': {
    intent: 'Sell your loan to a buy offer',
    fields: {
      reviewedMinSellerNet: baseUnits('Least you receive'),
      reviewedMaxHeld: baseUnits('Most held back'),
    },
  },
  'EarlyWithdrawalFacet.completeLoanSale': { intent: 'Complete a loan sale' },
  'EarlyWithdrawalFacet.createLoanSaleOffer': {
    intent: 'List your loan for sale',
    fields: {
      interestRateBps: percent('Buyer\'s interest rate'),
      listingSeconds: seconds('Listed for'),
      reviewedMinSellerNet: baseUnits('Least you receive'),
      reviewedMaxHeld: baseUnits('Most held back'),
    },
  },
  'InstantMarketFacet.borrowInstant': {
    intent: 'Borrow now',
    fields: { 'req.allowsPartialRepay': raw('Partial repay allowed') },
  },
  'InstantMarketFacet.setInstantSlot': {
    intent: 'Set an Auto-lend slot for borrow now',
    fields: {
      fills: raw('Fill borrow-now requests'),
      renewal: raw('Renew at due date'),
      takeover: raw('Allow takeover'),
    },
  },
  'InstantTakeoverFacet.takeoverInstant': {
    intent: 'Take over a borrow-now loan',
    fields: { incoming: account('New lender') },
  },
  'IntegratorFacet.nameLenderIntentIntegrator': {
    intent: 'Name the integrator of an Auto-lend slot',
    fields: { owner: account('Slot owner'), integrator: account('Integrator') },
  },
  'LegalFacet.acceptTerms': {
    intent: 'Accept the Terms of Use',
    fields: { version: raw('Terms version'), hash: hide('the hash of the Terms text shown in the app; the contract checks it') },
  },
  'LenderIntentFacet.cancelLenderIntent': { intent: 'Cancel an Auto-lend slot' },
  'LenderIntentFacet.fundLenderIntent': {
    intent: 'Add funds to an Auto-lend slot',
    fields: { amount: tokenAmount('Amount', 'lendingAsset') },
  },
  'LenderIntentFacet.setLenderIntent': {
    intent: 'Set an Auto-lend slot',
    fields: {
      maxExposure: tokenAmount('Most lent at once', 'lendingAsset'),
      minRateBps: percent('Least interest rate'),
      maxInitLtvBps: percent('Most loan-to-value'),
      maxDurationDays: raw('Longest term (days)'),
      minFillAmount: tokenAmount('Smallest loan', 'lendingAsset'),
      requiresKeeperAuth: raw('Keeper approval needed'),
      lendUntil: unless(date('Lend until'), [0]),
      acceptsProRata: raw('Accept shared fills'),
    },
  },
  'LenderIntentFacet.setLenderIntentPriority': {
    intent: 'Set Auto-lend slot priority',
    fields: { enabled: raw('Priority on') },
  },
  'LenderIntentFacet.withdrawLenderIntentCapital': {
    intent: 'Withdraw Auto-lend funds',
    fields: { amount: tokenAmount('Amount', 'lendingAsset') },
  },
  'MarketLedgerFacet.rollMarketLedger': {
    intent: 'Update the market record',
    fields: { maxDays: raw('Days to roll') },
  },
  'MulticallFacet.multicall': { intent: 'Run several actions' },
  'NFTPrepayDutchListingFacet.postPrepayDutchListing': {
    intent: 'List collateral for sale (falling price)',
    fields: {
      startAskPrice: baseUnits('Start price'),
      endAskPrice: baseUnits('End price'),
      auctionEndTime: date('Price stops falling at'),
    },
  },
  'NFTPrepayDutchListingFacet.updatePrepayDutchListing': {
    intent: 'Change a falling-price listing',
    fields: {
      newStartAskPrice: baseUnits('Start price'),
      newEndAskPrice: baseUnits('End price'),
      newAuctionEndTime: date('Price stops falling at'),
    },
  },
  'NFTPrepayListingAtomicFacet.matchOpenSeaOffer': {
    intent: 'Sell collateral to an OpenSea bid',
    fields: { expectedBidderOrderHash: hide(COMMIT) },
  },
  'NFTPrepayListingFacet.cancelPrepayListing': { intent: 'Cancel a collateral listing' },
  'NFTPrepayListingFacet.clearAutoListOptOut': { intent: 'Allow automatic listing again' },
  'NFTPrepayListingFacet.postPrepayListing': {
    intent: 'List collateral for sale',
    fields: { askPrice: baseUnits('Price') },
  },
  'NFTPrepayListingFacet.updatePrepayListing': {
    intent: 'Change a collateral listing',
    fields: { newAskPrice: baseUnits('Price') },
  },
  'NotificationFeeFacet.setNotificationFeeConsent': {
    intent: 'Set notification fee limit',
    fields: { maxFeePerLoanSide: baseUnits('Most fee per loan') },
  },
  'OfferAcceptFacet.acceptOffer': { intent: 'Accept an offer' },
  'OfferAcceptFacet.acceptOfferWithPermit': { intent: 'Accept an offer' },
  'OfferCancelFacet.cancelOffer': { intent: 'Cancel an offer' },
  'OfferCreateFacet.createOffer': { intent: 'Create an offer' },
  'OfferCreateFacet.createOfferWithPermit': { intent: 'Create an offer' },
  'OfferCreateFacet.getUserVault': { intent: 'Open your vault' },
  'OfferMutateFacet.modifyOffer': { intent: 'Change an offer' },
  'OfferMutateFacet.setOfferAmount': {
    intent: 'Change an offer\'s amount',
    fields: { newAmount: baseUnits('Amount'), newAmountMax: baseUnits('Max amount') },
  },
  'OfferMutateFacet.setOfferCollateral': {
    intent: 'Change an offer\'s collateral',
    fields: { newCollateralAmount: baseUnits('Collateral'), newCollateralAmountMax: baseUnits('Max collateral') },
  },
  'OfferMutateFacet.setOfferRate': {
    intent: 'Change an offer\'s rate',
    fields: { newRateBps: percent('Interest rate (yearly)'), newRateBpsMax: percent('Max interest rate') },
  },
  'OfferParallelSaleFacet.postParallelSaleListing': {
    intent: 'List an offer\'s collateral for sale',
    fields: { askPrice: baseUnits('Price') },
  },
  'OfferParallelSaleFacet.releaseParallelSaleLock': { intent: 'Release a sale listing lock' },
  'OfferPriceGuardFacet.armOfferPriceGuard': {
    intent: 'Set a price-move guard for your next offer',
    fields: { maxMoveBps: percent('Most price move') },
  },
  'OfferPriceGuardFacet.setIntentCalmCheck': {
    intent: 'Set the calm-price check for an Auto-lend slot',
    fields: { on: raw('Check on') },
  },
  'OfferPriceGuardFacet.setOfferPriceGuard': {
    intent: 'Set an offer\'s price-move guard',
    fields: { maxMoveBps: percent('Most price move') },
  },
  'PartialWithdrawalFacet.partialWithdrawCollateral': {
    intent: 'Withdraw spare collateral',
    fields: { amount: baseUnits('Collateral to withdraw') },
  },
  'PayrollFacet.withdrawSalary': { intent: 'Withdraw salary' },
  'PerkFacet.purchasePerk': {
    intent: 'Buy a perk with VPFI',
    fields: {
      units: raw('Units'),
      maxTotalVpfi: vpfi('Most VPFI'),
      expectedDurationSeconds: seconds('Lasts'),
    },
  },
  'PrecloseFacet.precloseDirect': { intent: 'Repay a loan early' },
  'PrecloseFacet.transferObligationViaOffer': { intent: 'Hand your loan to a new borrower' },
  'PrecloseOffsetFacet.completeOffset': { intent: 'Complete an offset close' },
  'PrecloseOffsetFacet.offsetWithNewOffer': {
    intent: 'Close a loan by a new offer',
    fields: { collateralAmount: tokenAmount('Collateral', 'collateralAsset') },
  },
  'ProfileFacet.approveKeeper': { intent: 'Approve a keeper' },
  'ProfileFacet.revokeKeeper': { intent: 'Remove a keeper' },
  'ProfileFacet.setKeeperAccess': {
    intent: 'Set keeper access',
    fields: { enabled: raw('Keepers allowed') },
  },
  'ProfileFacet.setKeeperActions': { intent: 'Change a keeper\'s actions' },
  'ProfileFacet.setLoanKeeperEnabled': {
    intent: 'Set a keeper for a loan',
    fields: { enabled: raw('Keeper on') },
  },
  'ProfileFacet.setOfferCreatorFullTariff': {
    intent: 'Set VPFI fee choice for an offer',
    fields: {
      creatorFull: raw('Pay your fee in VPFI'),
      maxCStar: vpfi('Max VPFI fee'),
      allowDowngrade: raw('Fall back if VPFI fee too high'),
    },
  },
  'ProfileFacet.setOfferKeeperEnabled': {
    intent: 'Set a keeper for an offer',
    fields: { enabled: raw('Keeper on') },
  },
  'ProfileFacet.setUserCountry': {
    intent: 'Set your country',
    fields: { country: raw('Country') },
  },
  'ProtectedAccountFacet.applyProtection': { intent: 'Apply protected mode' },
  'ProtectedAccountFacet.cancelSettingChange': {
    intent: 'Cancel a pending setting change',
    fields: {
      kind: constEnum('Change', 'ProtectedAccountFacet', 'CHANGE_', {
        CHANGE_COSIGN_OFF: 'Co-sign switch-off',
        CHANGE_UNPIN: 'Vault version pin change',
      }),
    },
  },
  'ProtectedAccountFacet.lockPositionNfts': { intent: 'Lock your position NFTs' },
  'ProtectedAccountFacet.setRequireCosign': {
    intent: 'Set co-sign for payouts',
    fields: { on: raw('Co-sign required') },
  },
  'ProtocolBroadcastFacet.topUpBroadcastBudget': {
    intent: 'Add to the broadcast budget',
    fields: { '@.value': { label: 'Amount', format: 'amount' } },
  },
  'ReadyBalanceFacet.cancelReadyTopUp': { intent: 'Cancel a Ready balance top-up' },
  'ReadyBalanceFacet.depositToReady': {
    intent: 'Add to your Ready balance',
    fields: { amount: tokenAmount('Amount', 'asset') },
  },
  'ReadyBalanceFacet.extendReadyUntil': {
    intent: 'Keep your Ready balance longer',
    fields: { until: date('Ready until') },
  },
  'ReadyBalanceFacet.releaseReady': {
    intent: 'Release your Ready balance',
    fields: { amount: tokenAmount('Amount', 'asset') },
  },
  'ReadyBalanceFacet.requestReadyTopUp': {
    intent: 'Ask to top up your Ready balance',
    fields: { amount: tokenAmount('Amount', 'asset') },
  },
  'ReadyBalanceFacet.setReadyIdlePeriod': {
    intent: 'Set the Ready balance idle period',
    fields: { idle: seconds('Idle period') },
  },
  'ReferralFacet.bindInviter': {
    intent: 'Record who invited you',
    fields: { inviter: account('Inviter') },
  },
  'RefinancePayoffFacet.clearRefinancePayoffPermit': { intent: 'Remove a refinance payoff permit' },
  'RefinancePayoffFacet.setRefinancePayoffPermit': {
    intent: 'Attach a refinance payoff permit',
    fields: { maxAmount: baseUnits('Most paid from wallet') },
  },
  'RepayFacet.repayLoan': { intent: 'Repay a loan' },
  'RepayFacet.repayPartial': {
    intent: 'Repay part of a loan',
    fields: { partialAmount: baseUnits('Amount') },
  },
  'RewardClaimFacet.claimHeldInteractionRewards': { intent: 'Claim held rewards' },
  'RewardClaimFacet.claimInteractionRewards': { intent: 'Claim rewards' },
  'RewardClaimFacet.claimInteractionRewardsTo': { intent: 'Claim rewards' },
  'RewardClaimFacet.simulateClaimInteractionRewards': { intent: 'Preview a reward claim' },
  'RiskAccessFacet.setIlliquidPairConsent': {
    intent: 'Set consent for an illiquid pair',
    fields: { consent: raw('Consent') },
  },
  'RiskAccessFacet.setMidTierPairAck': { intent: 'Acknowledge a mid-tier pair' },
  'RiskAccessFacet.setRiskStrictMode': {
    intent: 'Set strict risk mode',
    fields: { enabled: raw('Strict mode on') },
  },
  'RiskAccessFacet.setVaultRiskTier': { intent: 'Set your asset access' },
  'RiskAccessFacet.setVaultRiskTierChecked': {
    intent: 'Set your asset access',
    fields: {
      expectedTierNonce: hide('the setting this change was reviewed under; a change refuses it'),
      expectedTermsVersion: hide('the risk terms this change was reviewed under; a change refuses it'),
    },
  },
  'SellerClaimFacet.claimAsSeller': { intent: 'Claim interest owed from a loan you sold' },
  'ServiceCapacityFacet.postCapacityDeposit': {
    intent: 'Deposit for service capacity',
    fields: { role: solEnum('Role', 'LibVaipakam.ServiceCapacityRole', { Solver: 'Solver', Keeper: 'Keeper' }), amount: vpfi('Deposit') },
  },
  'ServiceCapacityFacet.withdrawArchivedCapacityDeposit': {
    intent: 'Withdraw an old capacity deposit',
    fields: { role: solEnum('Role', 'LibVaipakam.ServiceCapacityRole', { Solver: 'Solver', Keeper: 'Keeper' }), epoch: raw('Epoch') },
  },
  'ServiceCapacityFacet.withdrawCapacityDeposit': {
    intent: 'Withdraw a capacity deposit',
    fields: { role: solEnum('Role', 'LibVaipakam.ServiceCapacityRole', { Solver: 'Solver', Keeper: 'Keeper' }), amount: vpfi('Amount') },
  },
  'SignedOfferFacet.acceptSignedOffer': { intent: 'Accept a signed offer' },
  'SignedOfferFacet.acceptSignedOfferWithPermit': { intent: 'Accept a signed offer' },
  'SignedOfferFacet.cancelSignedOffer': { intent: 'Cancel a signed offer' },
  'SignedOfferFacet.cancelSignedOffersBelow': {
    intent: 'Cancel your older signed offers',
    fields: { floor: raw('Cancel nonces below') },
  },
  'SignedOfferFacet.invalidateSignedOfferNonce': {
    intent: 'Cancel a signed offer',
    fields: { nonce: raw('Nonce') },
  },
  'StandingInstructionFacet.clearStandingInstructions': { intent: 'Clear a loan\'s standing instructions' },
  'StandingInstructionFacet.fundLoanReserve': {
    intent: 'Add to a loan reserve',
    fields: {
      kind: constEnum('Reserve', 'StandingInstructionFacet', 'RESERVE_', {
        RESERVE_PAYMENT: 'Payment',
        RESERVE_COLLATERAL: 'Collateral',
      }),
      amount: baseUnits('Amount'),
    },
  },
  'StandingInstructionFacet.previewInterestPayment': { intent: 'Preview an interest payment' },
  'StandingInstructionFacet.setStandingInstructionConfig': { intent: 'Set standing instruction limits' },
  'StandingInstructionFacet.setStandingInstructions': { intent: 'Set a loan\'s standing instructions' },
  'StandingInstructionFacet.withdrawLoanReserve': {
    intent: 'Withdraw from a loan reserve',
    fields: {
      kind: constEnum('Reserve', 'StandingInstructionFacet', 'RESERVE_', {
        RESERVE_PAYMENT: 'Payment',
        RESERVE_COLLATERAL: 'Collateral',
      }),
      amount: baseUnits('Amount'),
    },
  },
  'SwapToRepayFacet.swapToRepayFull': {
    intent: 'Repay a loan by selling collateral',
    fields: { maxCollateralIn: baseUnits('Most collateral sold') },
  },
  'SwapToRepayIntentFacet.cancelSwapToRepayIntent': { intent: 'Cancel a repay-by-sale order' },
  'SwapToRepayIntentFacet.commitSwapToRepayIntent': { intent: 'Place a repay-by-sale order' },
  'SwapToRepayPartialFacet.swapToRepayPartial': {
    intent: 'Repay part of a loan by selling collateral',
    fields: { collateralSwapAmount: baseUnits('Collateral sold') },
  },
  'VPFIDiscountFacet.depositVPFIToVault': {
    intent: 'Deposit VPFI to your vault',
    fields: { amount: vpfi('Amount') },
  },
  'VPFIDiscountFacet.depositVPFIToVaultWithPermit': {
    intent: 'Deposit VPFI to your vault',
    fields: { amount: vpfi('Amount') },
  },
  'VPFIDiscountFacet.pokeMyTier': { intent: 'Refresh your VPFI tier' },
  'VPFIDiscountFacet.setVPFIDiscountConsent': {
    intent: 'Set VPFI fee discount',
    fields: { enabled: raw('Use VPFI discount') },
  },
  'VPFIDiscountFacet.withdrawVPFIFromVault': {
    intent: 'Withdraw VPFI from your vault',
    fields: { amount: vpfi('Amount') },
  },
  'VaultDepositoryFacet.adoptUntracked': {
    intent: 'Add a direct transfer to your vault',
    fields: {
      amount: tokenAmount('Amount', 'asset'),
      declaredSource: account('Sent from'),
    },
  },
  'VaultDepositoryFacet.depositToVault': {
    intent: 'Deposit to your vault',
    fields: { amount: tokenAmount('Amount', 'asset') },
  },
  'VaultDepositoryFacet.disownUntracked': { intent: 'Disown a direct transfer to your vault' },
  'VaultDepositoryFacet.pinVaultVersion': {
    intent: 'Pin your vault version',
    fields: { id: raw('Version') },
  },
  'VaultDepositoryFacet.unpinVaultVersion': { intent: 'Unpin your vault version' },
  'VaultDepositoryFacet.withdrawFromVault': {
    intent: 'Withdraw from your vault',
    fields: { amount: tokenAmount('Amount', 'asset'), recipient: account('To') },
  },
  'VaultFactoryFacet.getOrCreateUserVault': { intent: 'Open your vault' },
  'VaultPayoutFacet.cancelPayout': { intent: 'Cancel a pending payout', fields: { id: raw('Payout ID') } },
  'VaultPayoutFacet.cosignPayout': { intent: 'Co-sign a payout', fields: { id: raw('Payout ID') } },
  'VaultPayoutFacet.escapeWithdraw': {
    intent: 'Withdraw by the escape route',
    fields: { amount: tokenAmount('Amount', 'asset') },
  },
};

// The vault's protected-mode choices, shared by its signed messages and its
// direct calls.
const SIGNER_ACTIONS = {
  SIGNER_ADD: 'Add a signer',
  SIGNER_ACCEPT: 'Accept being a signer',
  SIGNER_REMOVE: 'Remove a signer',
  SIGNER_CANCEL: 'Cancel a signer change',
};
const SETTINGS_ACTIONS = {
  SETTINGS_ENABLE: 'Turn protected mode on',
  SETTINGS_DELAY: 'Change the waiting period',
  SETTINGS_DISABLE: 'Turn protected mode off',
  SETTINGS_UNLOCK: 'Unlock the account',
};
const REPLACE_ACTIONS = {
  REPLACE_PROPOSE: 'Propose a new owner',
  REPLACE_APPROVE: 'Approve the new owner',
  REPLACE_CANCEL: 'Cancel the replacement',
};

// ── Direct calls to a person's own vault (#3818) ─────────────────────────
// Protected mode's no-signature route: the key sends the call itself, to its
// own vault, as `protect(bytes data)`, and the vault delegatecalls its
// protection code with `data` (and that code its recovery code). So the
// wallet sees `protect` with the real action inside `data`. The inner
// formats below sit in the same descriptor as `protect`, because the inner
// call runs AS the vault: its callee is the transaction's own target.
//
// `auth` says who acts. On this route its signature is empty and the vault
// requires the sender to be `auth.key`; a non-empty signature is a key's
// EIP-712 signature someone else relays, and then its expiry applies.
const AUTH_SIG = 'empty when the key sends the call itself; otherwise the key’s signature, which the vault checks';
const AUTH = (who = 'Acting key', until = 'Signature valid until') => ({
  'auth.key': account(who),
  'auth.expiry': unless(date(until), [0]),
  'auth.sig': hide(AUTH_SIG),
});
const PURPOSES = {
  PURPOSE_SETTINGS: 'Protected-mode changes',
  PURPOSE_ALLOWLIST_ADD: 'Adding a payout destination',
  PURPOSE_ALLOWLIST_CANCEL: 'Cancelling or removing a payout destination',
  PURPOSE_SIGNER_CHANGE: 'Co-signer changes',
  PURPOSE_REPLACEMENT: 'Owner replacement',
  PURPOSE_LOCK: 'Locking the account',
  PURPOSE_VERIFY: 'Verifying a payout destination',
  PURPOSE_RECOVERY: 'Recovery address changes',
  PURPOSE_RECOVERY_PROOF: 'Proving control of a recovery address',
  PURPOSE_CLAWBACK: 'Moving assets to the recovery address',
  PURPOSE_POSITION_MOVE: 'Moving position NFTs',
};

export const VAULT_CALLS = {
  'VaipakamVaultImplementation.protect': {
    intent: 'Change your account protection',
    fields: { data: { label: 'Change', format: 'calldata', params: { calleePath: '@.to' } } },
  },
  'VaultProtection.enable': {
    intent: 'Turn protected mode on',
    fields: { delay: seconds('Waiting period'), ...AUTH() },
  },
  'VaultProtection.setDelay': {
    intent: 'Change the waiting period',
    fields: { delay: seconds('New waiting period'), ...AUTH() },
  },
  'VaultProtection.requestDisable': { intent: 'Turn protected mode off', fields: AUTH() },
  'VaultProtection.requestUnlock': { intent: 'Unlock the account', fields: AUTH() },
  'VaultProtection.lock': { intent: 'Lock your account', fields: AUTH() },
  'VaultProtection.cancelSetting': {
    intent: 'Cancel a pending protected-mode change',
    fields: { action: constEnum('Change', 'VaultProtectionBase', 'SETTINGS_', SETTINGS_ACTIONS), ...AUTH() },
  },
  'VaultProtection.addAllowlisted': {
    intent: 'Add a payout destination',
    fields: { destination: account('Destination'), ...AUTH() },
  },
  'VaultProtection.cancelAllowlisted': {
    intent: 'Cancel adding a payout destination',
    fields: { destination: account('Destination'), ...AUTH() },
  },
  'VaultProtection.removeAllowlisted': {
    intent: 'Remove a payout destination',
    fields: { destination: account('Destination'), ...AUTH() },
  },
  'VaultProtection.verifyDestination': {
    intent: 'Verify a payout destination',
    fields: { account: account('For account'), diamond: mustBeDiamond(), ...AUTH('Destination') },
  },
  'VaultProtection.signerChange': {
    intent: 'Change a co-signer',
    fields: {
      action: constEnum('Change', 'VaultProtectionBase', 'SIGNER_', SIGNER_ACTIONS),
      who: account('Signer'),
      ...AUTH(),
    },
  },
  'VaultProtection.replacement': {
    intent: 'Replace the account owner',
    fields: {
      action: constEnum('Step', 'VaultProtectionBase', 'REPLACE_', REPLACE_ACTIONS),
      nominee: account('New owner'),
      ...AUTH(),
    },
  },
  'VaultProtection.burnNonce': {
    intent: 'Void a signature you gave',
    fields: { purpose: constEnum('Signatures for', 'VaultProtectionBase', 'PURPOSE_', PURPOSES) },
  },
  'VaultRecovery.requestRecoveryAddress': {
    intent: 'Set a recovery address',
    fields: {
      recovery: account('Recovery address'),
      ...AUTH(),
      'proof.key': account('Proof from'),
      'proof.expiry': unless(date('Proof valid until'), [0]),
      'proof.sig': hide('the recovery address’s own signature proving it controls itself; the vault checks it'),
    },
  },
  'VaultRecovery.cancelRecoveryAddress': { intent: 'Cancel a recovery address change', fields: AUTH() },
  'VaultRecovery.clearRecoveryAddress': { intent: 'Remove the recovery address', fields: AUTH() },
  'VaultRecovery.settleRecoveryAddress': { intent: 'Bring a waiting recovery address into force' },
  'VaultRecovery.clawback': { intent: 'Move assets to your recovery address', fields: AUTH() },
  'VaultRecovery.requestPositionMove': { intent: 'Move position NFTs to the new owner', fields: AUTH() },
  'VaultRecovery.cancelPositionMove': { intent: 'Cancel a position NFT move', fields: AUTH() },
};

// ── EIP-712 messages ────────────────────────────────────────────────────
// Each type string is READ from the named Solidity constant, so a change to
// a signed type changes the descriptor (and `--check` fails until it is
// rebuilt). `structs` maps an EIP-712 type name to the STRUCTS rules it
// shares with the calldata.
const VAULT_SOURCE = 'contracts/src/vault/VaultProtectionBase.sol';
const vaultMsg = (constant, intent, fields = {}) => ({ source: [VAULT_SOURCE, constant], intent, fields });
const VAULT_COMMON = {
  expiry: date('Signature valid until'),
};

export const TYPED = [
  {
    file: 'eip712-vaipakam-signed-offer',
    id: 'Vaipakam signed offers',
    domain: { name: 'Vaipakam SignedOffer', version: '1' },
    verifying: 'diamond',
    messages: [
      {
        source: ['contracts/src/libraries/LibSignedOffer.sol', 'SIGNED_OFFER_TYPEHASH'],
        typehash: 'SIGNED_OFFER_TYPEHASH',
        intent: 'Sign a loan offer',
        structs: { SignedOffer: 'LibSignedOffer.SignedOffer' },
      },
      {
        source: ['contracts/src/libraries/LibSignedOffer.sol', 'SIGNED_OFFER_SET_TYPEHASH'],
        typehash: 'SIGNED_OFFER_SET_TYPEHASH',
        intent: 'Sign a set of loan offers',
        structs: { SignedOffer: 'LibSignedOffer.SignedOffer' },
      },
      {
        source: ['contracts/src/libraries/LibSignedOffer.sol', 'FILL_TYPEHASH'],
        typehash: 'FILL_TYPEHASH',
        intent: 'Approve one fill of a signed offer',
        fields: {
          orderHash: hide(COMMIT),
          taker: account('Taker'),
          filledBefore: raw('Filled before'),
          fillAmount: raw('This fill (smallest units)'),
          validUntil: date('Approval valid until'),
        },
      },
    ],
  },
  {
    file: 'eip712-vaipakam-accept-offer',
    id: 'Vaipakam offer acceptance',
    domain: { name: 'Vaipakam AcceptOffer', version: '1' },
    verifying: 'diamond',
    messages: [
      {
        source: ['contracts/src/libraries/LibAcceptTerms.sol', 'ACCEPT_TERMS_TYPEHASH'],
        typehash: 'ACCEPT_TERMS_TYPEHASH',
        intent: 'Accept a loan offer',
        structs: { AcceptTerms: 'LibAcceptTerms.AcceptTerms' },
      },
    ],
  },
  {
    file: 'eip712-vaipakam-vault-adoption',
    id: 'Vaipakam vault adoption',
    domain: { name: 'Vaipakam Vault Adoption', version: '1' },
    verifying: 'diamond',
    messages: [
      {
        source: ['contracts/src/facets/VaultDepositoryFacet.sol', 'ADOPTION_TYPEHASH'],
        typehash: 'ADOPTION_TYPEHASH',
        intent: 'Add a direct transfer to your vault',
        fields: {
          amount: tokenAmount('Amount', 'asset'),
          declaredSource: account('Sent from'),
          ackTextHash: hide('the hash of the acknowledgement text shown in the app; the contract checks it'),
        },
      },
    ],
  },
  {
    file: 'eip712-vaipakam-vault',
    id: 'Vaipakam vault protection',
    // Signed to the person's OWN vault, so the verifying contract differs per
    // person and no deployment list can name it; the domain name binds it.
    domain: { name: 'Vaipakam Vault', version: '1' },
    verifying: null,
    messages: [
      vaultMsg('SETTINGS_TYPEHASH', 'Change protected mode', {
        action: constEnum('Change', 'VaultProtectionBase', 'SETTINGS_', SETTINGS_ACTIONS),
        value: unless(seconds('Waiting period'), [0]),
        ...VAULT_COMMON,
      }),
      vaultMsg('ALLOWLIST_ADD_TYPEHASH', 'Add a payout destination', { destination: account('Destination'), ...VAULT_COMMON }),
      vaultMsg('ALLOWLIST_CANCEL_TYPEHASH', 'Cancel adding a payout destination', { destination: account('Destination'), ...VAULT_COMMON }),
      vaultMsg('ALLOWLIST_REMOVE_TYPEHASH', 'Remove a payout destination', { destination: account('Destination'), ...VAULT_COMMON }),
      vaultMsg('SETTING_CANCEL_TYPEHASH', 'Cancel a pending protected-mode change', {
        action: constEnum('Change', 'VaultProtectionBase', 'SETTINGS_', SETTINGS_ACTIONS),
        ...VAULT_COMMON,
      }),
      vaultMsg('SIGNER_CHANGE_TYPEHASH', 'Change a co-signer', {
        action: constEnum('Change', 'VaultProtectionBase', 'SIGNER_', SIGNER_ACTIONS),
        signer: account('Signer'),
        ...VAULT_COMMON,
      }),
      vaultMsg('REPLACEMENT_TYPEHASH', 'Replace the account owner', {
        action: constEnum('Step', 'VaultProtectionBase', 'REPLACE_', REPLACE_ACTIONS),
        nominee: account('New owner'),
        round: raw('Proposal round'),
        ...VAULT_COMMON,
      }),
      vaultMsg('LOCK_TYPEHASH', 'Lock your account', VAULT_COMMON),
      vaultMsg('VERIFY_TYPEHASH', 'Verify a payout destination', {
        account: account('Account'),
        diamond: mustBeDiamond(),
        request: raw('Request'),
        ...VAULT_COMMON,
      }),
      vaultMsg('RECOVERY_SET_TYPEHASH', 'Set a recovery address', { recovery: account('Recovery address'), ...VAULT_COMMON }),
      vaultMsg('RECOVERY_PROOF_TYPEHASH', 'Prove control of a recovery address', {
        account: account('For account'),
        diamond: mustBeDiamond(),
        ...VAULT_COMMON,
      }),
      vaultMsg('RECOVERY_CANCEL_TYPEHASH', 'Cancel a recovery address change', { recovery: account('Recovery address'), ...VAULT_COMMON }),
      vaultMsg('RECOVERY_CLEAR_TYPEHASH', 'Remove the recovery address', VAULT_COMMON),
      vaultMsg('CLAWBACK_TYPEHASH', 'Move assets to your recovery address', {
        assets: hide('a hash of the asset list the app shows; the vault checks it'),
        ...VAULT_COMMON,
      }),
      vaultMsg('POSITION_MOVE_TYPEHASH', 'Move position NFTs to a new owner', { to: account('To'), ...VAULT_COMMON }),
      vaultMsg('POSITION_MOVE_CANCEL_TYPEHASH', 'Cancel a position NFT move', { at: date('Move due at'), ...VAULT_COMMON }),
    ],
  },
  {
    file: 'eip712-vaipakam-vault-beacon',
    id: 'Vaipakam vault versions',
    domain: { name: 'Vaipakam VaultBeacon', version: '1' },
    verifying: { deploymentKey: 'vaultBeacon' },
    messages: [
      {
        source: ['contracts/src/VaultBeacon.sol', 'PIN_CHANGE_TYPEHASH'],
        typehash: 'PIN_CHANGE_TYPEHASH',
        intent: 'Pin your vault version',
        fields: { vault: account('Vault'), target: raw('Version') },
      },
      {
        source: ['contracts/src/VaultBeacon.sol', 'CANCEL_PIN_TYPEHASH'],
        typehash: 'CANCEL_PIN_TYPEHASH',
        intent: 'Cancel a vault version pin',
        fields: { vault: account('Vault') },
      },
      {
        source: ['contracts/src/VaultBeacon.sol', 'PIN_DELAY_TYPEHASH'],
        typehash: 'PIN_DELAY_TYPEHASH',
        intent: 'Set the vault pin delay',
        fields: { vault: account('Vault'), delay: seconds('Delay') },
      },
    ],
  },
  {
    file: 'eip712-vaipakam-permit2',
    id: 'Vaipakam Permit2 transfers',
    // Permit2's own domain (no version). These are the witness transfers the
    // Diamond asks for; the spender is checked against the Diamond.
    domain: { name: 'Permit2' },
    verifying: { constant: ['contracts/src/libraries/LibPermit2.sol', 'PERMIT2'] },
    messages: [
      {
        source: ['contracts/src/libraries/LibSignedOffer.sol', 'WITNESS_TYPE_STRING'],
        prefix: PERMIT2_STUB(),
        intent: 'Fund a signed loan offer',
        structs: { SignedOffer: 'LibSignedOffer.SignedOffer', TokenPermissions: 'ISignatureTransfer.TokenPermissions' },
        fields: { spender: mustBeDiamond(), deadline: date('Permit valid until'), 'witness.deadline': date('Offer valid until') },
      },
      {
        source: ['contracts/src/libraries/LibRefinancePayoff.sol', 'WITNESS_TYPE_STRING'],
        prefix: PERMIT2_STUB(),
        intent: 'Allow a refinance payoff',
        structs: { TokenPermissions: 'ISignatureTransfer.TokenPermissions' },
        fields: {
          spender: mustBeDiamond(),
          deadline: date('Permit valid until'),
          'witness.loanId': raw('Loan ID'),
          'witness.offerId': raw('Refinance offer ID'),
        },
      },
    ],
  },
];

/** The head Permit2 puts before a witness type string (see LibPermit2). */
function PERMIT2_STUB() {
  return 'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,';
}
