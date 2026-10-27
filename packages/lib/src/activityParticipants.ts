/**
 * #2703 — which wallets an activity row concerns: the PARTICIPANTS of one
 * decoded event, by an explicit rule.
 *
 * The connected app's Activity page reads the protocol-wide feed and keeps a
 * wallet's rows. It used to keep any row whose args contained the wallet's
 * address as text, so a row was a wallet's because the address appeared
 * somewhere in it: as a role grant, a treasury setting, an approved operator.
 * About two hundred event kinds could reach a page that way, none of them
 * labelled, and nothing said which of them were meant to. This module is the
 * rule that replaced it (owner decision 2026-10-23).
 *
 * THE RULE. An event's participants are the wallets it names as acting in it
 * or as affected by it:
 *   - its actor (`activityActor.ts`, the wallet the indexer files the row
 *     under), and
 *   - the further parties this table lists for its kind.
 * Contracts, assets, the treasury, and addresses an event merely authorizes or
 * configures (a keeper being permitted, an operator being approved) are not
 * participants. The zero address names no wallet and is dropped.
 *
 * EVERY ADDRESS IS CLASSIFIED. The test (`activityParticipants.test.ts`) walks
 * every event in the compiled Diamond ABI that carries an address and requires
 * each address input to be one of: the actor's, a listed party, a name that
 * never denotes a party (`NOT_A_PARTY`, for every event), or a name this kind
 * declares not a party (`LOCAL_NOT_A_PARTY`). An event whose addresses fit
 * none of those is either given parties here or recorded in `EXEMPT` under a
 * group whose reason says why a wallet's page does not show it. So a new event
 * naming a wallet cannot reach, or miss, the page by accident: it fails the
 * test until someone decides.
 *
 * WHAT IT DOES NOT READ. Only top-level inputs. A member of a tuple (a fee
 * leg's recipient, the matcher inside `LoanInitiatedDetails.details`) is not
 * read; each event carrying an address inside a tuple must be named in this
 * table or in `EXEMPT`, so that someone looked at it. The rows a wallet sees
 * because they concern ITS LOANS are a separate leg (the loan filter, by
 * `activityRefs.ts`) and need no party here.
 *
 * WHY IT LIVES IN THE SHARED LIBRARY. Same reason as `activityActor`: the
 * indexer files each row's actor by that rule, the app admits rows by this one
 * (the actor included), and the app's label catalog must name every kind
 * either admits. Keeping it here, as data, lets the app's test read the
 * admitted kinds instead of keeping a copy.
 *
 * Keyed by `Map`, never a plain object, so an event name that happens to be an
 * `Object.prototype` member never reads an inherited value as an entry.
 */
import { activityActor, actorAttributedKinds } from './activityActor';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Kind → the address inputs naming a party besides the actor. */
const PARTIES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  // ── A loan's terms, settings and outcomes (the loan's own parties also see
  //    these through the loan filter; listing them here keeps a row on the
  //    page of a party the event names, whatever the loan list says).
  ['LoanInitiated', ['lender']],
  ['LoanInitiatedDetails', ['lender', 'borrower']],
  ['AutoExtendBorrowerCapsChanged', ['borrower']],
  ['AutoExtendLenderCapsChanged', ['lender']],
  ['AutoRefinanceCapsChanged', ['borrower']],
  ['AutoListOptOutCleared', ['clearedBy']],
  ['LenderBackstopOptInSet', ['lenderNftOwner']],
  ['CollateralAdded', ['borrower']],
  ['PartialCollateralWithdrawn', ['borrower']],
  // `from` is the side's previous holder, `to` its current one.
  ['CollateralConsolidated', ['from', 'to']],
  ['BorrowerSurplusClaimed', ['claimant']],
  ['LoanPreclosedDirect', ['borrower']],
  ['LoanObligationTransferred', ['originalBorrower', 'newBorrower']],
  ['LoanRefinanced', ['borrower', 'oldLender', 'newLender']],
  ['LoanSaleCompleted', ['originalLender', 'newLender']],
  ['LoanSold', ['originalLender', 'newLender']],
  ['OffsetOfferCreated', ['borrower']],
  ['OffsetCompleted', ['borrower']],
  ['LoanFallbackPending', ['lender']],
  ['LoanCuredFromFallback', ['borrower']],
  ['HFLiquidationTriggered', ['liquidator']],
  ['LoanPartiallyLiquidated', ['liquidator']],
  // `recipient` receives the seized collateral, at the liquidator's choice.
  ['LiquidationDiscounted', ['liquidator', 'recipient']],
  ['NotificationFeeBilled', ['payer']],
  ['VPFIYieldFeeDiscountApplied', ['lender']],
  // A rental's lender and its renter (`user`).
  ['VaultRentalUpdated', ['lender', 'user']],
  // The limit-order fill's taker sent the fill the lot left in.
  ['SwapToRepayIntentLotPulled', ['taker']],
  // ── Offers and their sale routes.
  ['OfferCreatedDetails', ['creator']],
  ['OfferCanceledDetails', ['creator']],
  ['OfferSaleProceedsCredited', ['borrower']],
  ['OfferSaleProceedsSplit', ['lender', 'borrower']],
  ['PostParallelSaleListing', ['borrower']],
  ['ParallelSaleLockReleased', ['borrower']],
  ['PrepaySaleListingSynced', ['caller']],
  ['PrepaySaleOfferSynced', ['caller']],
  ['PrepayListingMatched', ['bidder']],
  ['SignedOfferFilled', ['signer', 'acceptor']],
  ['SignedOfferMatched', ['signer', 'matcher']],
  ['SignedOfferCancelled', ['signer']],
  ['SignedOfferNonceBurned', ['signer']],
  // ── Lender intents.
  ['LenderIntentSet', ['owner']],
  ['LenderIntentFunded', ['owner']],
  ['LenderIntentCapitalWithdrawn', ['owner']],
  ['LenderIntentPrioritySet', ['owner']],
  ['LenderIntentCancelled', ['owner']],
  ['IntentMatched', ['lender', 'matcher']],
  // Whoever rolled the loan sent that transaction (the owner or a keeper).
  ['IntentLoanRolled', ['roller']],
  // The solver sent the fill the credit was spent on.
  ['IntentPriorityFill', ['solver']],
  // ── A wallet's own settings and consents.
  ['AutoLendConsentChanged', ['user']],
  ['AutoOptInOnNewLoanChanged', ['user']],
  ['DefaultAutoRefinanceCapsChanged', ['user']],
  ['KeeperAccessUpdated', ['user']],
  ['KeeperActionsUpdated', ['user']],
  ['KeeperRevoked', ['user']],
  ['VPFIDiscountConsentChanged', ['user']],
  ['NotificationFeeConsentSet', ['user']],
  ['TermsAccepted', ['user']],
  // ── Vault and position NFTs.
  ['UserVaultCreated', ['user']],
  ['TokenDisowned', ['user']],
  ['StuckERC20Recovered', ['user']],
  ['NFTMinted', ['owner']],
  ['Approval', ['owner']],
  ['ApprovalForAll', ['owner']],
  // The actor is the recipient (`to`); the sender gave the position up.
  ['Transfer', ['from']],
  // Proceeds owed to `recipient` held instead of paid. Shown only to the
  // recipient, under a label that names no list and no provider.
  ['SanctionedProceedsLocked', ['recipient']],
  // ── Perks and rewards (RL-6: usage rebates, never yield).
  ['PerkPurchased', ['buyer']],
  ['PerkCreditConsumed', ['user']],
  ['RewardEntryHorizonStamped', ['user']],
  ['RewardEntryExpiryArmed', ['user']],
  ['RewardEntryExpiryBegun', ['user']],
  ['RewardEntryExpired', ['user']],
  ['StagingDelivered', ['user']],
  ['StagingClaimantForfeited', ['user']],
  ['RewardSanctionsHeldApart', ['user']],
  ['RewardSanctionsHeldReleased', ['user']],
  // A position transfer that did not move a reward entry intact: the entry
  // stayed with its earner, or was split between earner and holder. Both
  // wallets' reward rights changed, so both are parties (#2708 r2). Labels
  // name the outcome only, never why.
  ['RewardEntryRepointRefused', ['earner', 'holder']],
  ['RewardEntrySplitAtTransfer', ['earner', 'holder']],
]);

/**
 * Input names that never denote a party, in any event: an asset or token, a
 * protocol contract, the treasury, or an address an event only authorizes.
 */
const NOT_A_PARTY: ReadonlyMap<string, string> = new Map<string, string>([
  ['asset', 'an asset'],
  ['token', 'a token'],
  ['lendingAsset', 'an asset'],
  ['collateralAsset', 'an asset'],
  ['principalAsset', 'an asset'],
  ['paymentToken', 'a token'],
  ['nftContract', 'an NFT contract'],
  ['adapter', 'a swap or aggregator adapter contract'],
  ['adapters', 'swap adapter contracts'],
  ['executor', "the protocol's sale executor"],
  ['conduit', 'a marketplace conduit contract'],
  ['proxy', "a vault's proxy contract"],
  // A vault-keyed setting (a risk-access consent) would need its vault's
  // owner to reach a page; the rule reads wallets only (#2707).
  ['vault', 'a vault contract, never a wallet'],
  ['treasury', 'the treasury'],
]);

/** Input names that are not a party in THIS kind, with the reason. */
const LOCAL_NOT_A_PARTY: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map<
  string,
  Readonly<Record<string, string>>
>([
  ['Approval', { approved: 'the address approved for one position NFT' }],
  ['ApprovalForAll', { operator: 'the operator approved for every position NFT' }],
  // Two definitions share the name (an admin recovery, and the user's own
  // declared recovery); the rule is keyed by name, so both are classified.
  [
    'StuckERC20Recovered',
    {
      admin: 'the admin role that signed the recovery',
      declaredSource: 'the address the user declared sent the tokens',
    },
  ],
  // A keeper being permitted or refused is configured, not acting.
  ['KeeperActionsUpdated', { keeper: 'the keeper being permitted' }],
  ['KeeperRevoked', { keeper: 'the keeper being refused' }],
  ['LoanKeeperEnabled', { keeper: 'the keeper being permitted on the loan' }],
  ['OfferKeeperEnabled', { keeper: 'the keeper being permitted on the offer' }],
  ['SwapToRepayIntentForceCancelled', { source: 'the Diamond itself' }],
  [
    'VaultVpfiDebited',
    { recipient: "where the VPFI went (a wallet, the treasury or a fill's taker); the row is the vault owner's" },
  ],
]);

/** Why a group of events never reaches a wallet's Activity page. */
export const EXEMPT_GROUPS = {
  admin:
    'Protocol administration and configuration, set by governance or a protocol role. No position or wallet setting changes.',
  treasury:
    "Treasury and protocol-owned funds (buybacks, payroll, the backstop vault, the reward pool, VPFI supply). The wallets named are protocol accounts or recipients of the protocol's own funds.",
  crossChain:
    'Accounting between deployments (reward budgets, compensation, repatriation, ingress packets). The addresses named are deployments, remitters and messengers.',
  serviceOperator:
    "A service operator's own accounting (capacity deposits, arming fees, keeper rewards, day-closure walks, the auto-pause watcher). Not a lending position's activity.",
  screening:
    "Sanctions screening evidence, and the KYC and country records the retail deploy leaves dormant. A flagged wallet is told by the app's banner, never by a feed row; the funds consequences that are the wallet's own are rows (see PARTIES).",
  rewardInternal:
    "Reward bookkeeping that restates or prepares another row's outcome: index compaction, tier caches and broadcasts, a delivery record being opened, a payout's accounting companion.",
} as const;

export type ExemptGroup = keyof typeof EXEMPT_GROUPS;

const EXEMPT: ReadonlyMap<string, ExemptGroup> = new Map<string, ExemptGroup>([
  // admin
  ...(
    [
      'AaveV3PoolSet',
      'AdapterImplementationUpgraded',
      'AdapterOperatorBound',
      'AdminTransferred',
      'AggregatorAdapterCreated',
      'AllowanceTargetSet',
      'Api3ServerV1Set',
      'AssetNumeraireDirectFeedOverrideSet',
      'BaseRewardDeploymentSet',
      'BuybackRemittanceReceiverSet',
      'CollateralListingExecutorUpdated',
      'CrossChainMessengerSet',
      'DIAOracleV2Set',
      'DiamondCut',
      'EmergencyRoleRevoked',
      'FeedOverrideSet',
      'FusionLimitOrderProtocolSet',
      'LaunchedThroughGate',
      'LidoStakingSet',
      'MirrorRewardDeploymentSet',
      'NumeraireUpdated',
      'OwnershipTransferred',
      'PancakeswapV2FactorySet',
      'PancakeswapV3FactorySet',
      'Paused',
      'PeerProtocolAddressesSet',
      'PredominantDenominatorUpdated',
      'PythOracleSet',
      'RateModelSet',
      'RepatriationEndpointsSet',
      'RepatriationTokenAdminRegistrySet',
      'RewardRemittanceKeeperUpdated',
      'RewardRemittanceReceiverUpdated',
      'RoleGranted',
      'RoleRevoked',
      'RoyaltyUpdated',
      'SanctionsOracleSet',
      'ServiceCapacityEscrowBound',
      'SushiswapV2FactorySet',
      'SushiswapV3FactorySet',
      'TellorOracleSet',
      'TierReferenceAssetsSet',
      'TreasurySet',
      'UniswapV2FactorySet',
      'Unpaused',
      'VaultImplementationUpgraded',
      'VPFIDiscountConfigUpdated',
      'VPFITokenRotated',
      'VPFITokenSet',
      'ZeroExProxySet',
    ] as const
  ).map((k) => [k, 'admin'] as const),
  // treasury
  ...(
    [
      'BackstopAbsorbCapSet',
      'BackstopAbsorbCollateralSwept',
      'BackstopAbsorbExposureReleased',
      'BackstopAbsorbSeeded',
      'BackstopAbsorbWithdrawn',
      'BackstopIntentSet',
      'BackstopNFTSwept',
      'BackstopRewardsClaimed',
      'BackstopSeeded',
      'BackstopVaultImplementationSet',
      'BackstopWithdrawnToTreasury',
      'BroadcastBudgetToppedUp',
      'BroadcastBudgetWithdrawn',
      'BuybackDestTokenSet',
      'PayrollStreamCreated',
      'RewardPoolFunded',
      'SalaryWithdrawn',
      'TreasuryConverted',
      'TreasuryFeesClaimed',
      'VPFIMinted',
    ] as const
  ).map((k) => [k, 'treasury'] as const),
  // crossChain
  ...(
    [
      'CompensationConfirmed',
      'CompensationCredited',
      'CompensationQuarantined',
      'DayClockInstalled',
      'ImportedOutstandingCleared',
      'IngressPacketRecorded',
      'IngressPacketSplitAttested',
      'OutstandingCompensationImported',
      'RemitRouteRecorded',
      'RepatriationCancelAckDispatched',
      'RepatriationExecuted',
      'RepatriationInstructionRecorded',
      'RepatriationInstructionTombstoned',
      'RewardCustodyERC1155Swept',
      'RewardCustodyERC721Swept',
      'RewardCustodyForeignTokenSwept',
      'RewardCustodyHolderBound',
      'RewardCustodyHolderReplaced',
      'RewardCustodyNativeSwept',
      'RewardCustodyPredecessorVpfiRecovered',
      'RewardCustodyRowDebited',
      'RewardCustodyUnattributedVpfiSwept',
      'RewardCustodyUnclassifiedReleased',
      'StrandedReturnDispatched',
    ] as const
  ).map((k) => [k, 'crossChain'] as const),
  // serviceOperator
  ...(
    [
      'ArmingFeePaid',
      'AutoPaused',
      'CapacityBucketReset',
      'CapacityDepositArmed',
      'CapacityDepositEpochArchived',
      'CapacityDepositMigrated',
      'CapacityDepositParkReleased',
      'CapacityDepositParked',
      'CapacityDepositPosted',
      'CapacityDepositRaised',
      'CapacityDepositWithdrawn',
      'CapacityFreeTierSpent',
      'CapacitySpent',
      'ClosureWalkStarted',
      'DayObligationsClosed',
      'KeeperRewardPaid',
      'KeeperRewardSkipped',
    ] as const
  ).map((k) => [k, 'serviceOperator'] as const),
  // screening
  ...(
    [
      'KYCStatusUpdated',
      'KYCTierUpdated',
      'RewardSanctionsEvidenceCleared',
      'RewardSanctionsEvidenceRecorded',
      'RewardSanctionsWindowRecorded',
      'SanctionsFlagRefreshed',
      'ServiceCapacitySanctionsMarkerHealed',
      'ServiceCapacitySanctionsRefused',
      'UserCountrySet',
      'VaultBannedFromRecoveryAttempt',
    ] as const
  ).map((k) => [k, 'screening'] as const),
  // rewardInternal
  ...(
    [
      'MirrorTierCacheWritten',
      'ProtocolTierBroadcastSent',
      'ProtocolTierBroadcastSkipped',
      'RewardEntryIndexCompacted',
      'StagingDomainOpened',
      'StagingPaid',
      'StagingRecordOpened',
      'TierPoked',
      'TierPushCommitted',
      'TierPushDeferred',
      'TierPushLaneSettled',
    ] as const
  ).map((k) => [k, 'rewardInternal'] as const),
]);

/** A lower-cased 20-byte hex address other than zero. */
function isWalletAddress(a: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(a) && a !== ZERO_ADDRESS;
}

function readAddress(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  if (typeof v !== 'string') return null;
  const a = v.toLowerCase();
  return isWalletAddress(a) ? a : null;
}

/**
 * The wallets one decoded event concerns, lower-cased and de-duplicated: its
 * actor and its listed parties. Empty for an exempt or unknown kind.
 */
export function activityParticipants(eventName: string, args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const actor = activityActor(eventName, args);
  if (actor !== null && isWalletAddress(actor)) out.add(actor);
  for (const name of PARTIES.get(eventName) ?? []) {
    const a = readAddress(args, name);
    if (a) out.add(a);
  }
  return [...out];
}

/** Every event kind that can name a participant: the actor-attributed kinds
 *  and the kinds with listed parties. The app's label catalog must name each. */
export function participantKinds(): ReadonlySet<string> {
  return new Set([...actorAttributedKinds(), ...PARTIES.keys()]);
}

/** The classification tables, for the completeness test. Not for runtime use. */
export const PARTICIPANT_RULE_FOR_TEST = {
  PARTIES,
  NOT_A_PARTY,
  LOCAL_NOT_A_PARTY,
  EXEMPT,
} as const;
