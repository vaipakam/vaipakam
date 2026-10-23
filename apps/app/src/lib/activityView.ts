/**
 * UX-008 — turn the raw indexer event stream into a readable activity
 * feed. The old page leaked camelCase event names ("Nftminted"),
 * exploded each transaction into 3–6 near-duplicate rows, and carried
 * no plain-language description. This module is the pure core:
 *
 *   - ACTIVITY_LABELS maps every known contract event kind to a
 *     plain-language line and a coalescing priority;
 *   - humanizeKind is the fallback for an unmapped kind, handling
 *     ALL-CAPS acronyms (NFT/LTV/VPFI) the naive regex mangled;
 *   - coalesceByTx collapses one on-chain transaction's many events
 *     into ONE representative row (the highest-priority event), with a
 *     count of how many sub-events it hid.
 *
 * Kept framework-free and pure so it is unit-tested directly (the live
 * feed's honesty rules — truncation, participant filter — stay in the
 * page).
 */
import { activityParticipants } from '@vaipakam/lib/activityParticipants';
import type { IndexedActivityEvent } from '../data/indexer';
import { formatTokenAmount, shortAddress } from './format';
import { LoanStatus } from './types';

export type ActivityCategory =
  | 'offer'
  | 'loan-open'
  | 'loan-repay'
  | 'loan-close'
  | 'loan-default'
  | 'loan-modify'
  | 'collateral'
  | 'other';

interface ActivityLabel {
  /** Plain-language line, e.g. "Offer created". */
  label: string;
  category: ActivityCategory;
  /** Higher wins when several events share one transaction — the
   *  user-meaningful outcome should represent the row, not a
   *  book-keeping sub-event (Transfer, *Details). */
  priority: number;
}

/**
 * Known contract event kinds → readable label. Sourced from the
 * indexer's `log.eventName` handlers (apps/indexer/src/chainIndexer.ts).
 * A `*Details` companion event or a raw `Transfer` deliberately gets a
 * LOW priority so it never represents a transaction that also emitted
 * the real action.
 */
export const ACTIVITY_LABELS: Record<string, ActivityLabel> = {
  // Offers
  OfferCreated: { label: 'Offer created', category: 'offer', priority: 50 },
  OfferAccepted: { label: 'Offer accepted', category: 'loan-open', priority: 80 },
  OfferCanceled: { label: 'Offer cancelled', category: 'offer', priority: 60 },
  OfferClosed: { label: 'Offer closed', category: 'offer', priority: 40 },
  OfferModified: { label: 'Offer amended', category: 'offer', priority: 55 },
  OfferMatched: { label: 'Offers matched', category: 'loan-open', priority: 80 },
  OfferConsumedBySale: { label: 'Offer used for a sale', category: 'offer', priority: 45 },
  // Loan lifecycle
  LoanInitiated: { label: 'Loan started', category: 'loan-open', priority: 90 },
  LoanInitiatedDetails: { label: 'Loan started', category: 'loan-open', priority: 10 },
  LoanRepaid: { label: 'Loan repaid', category: 'loan-repay', priority: 90 },
  PartialRepaid: { label: 'Partial repayment', category: 'loan-repay', priority: 70 },
  LoanSettled: { label: 'Loan settled', category: 'loan-close', priority: 85 },
  // Companion breakdown of a settle — low priority so it never
  // represents a tx that also emitted the real LoanSettled.
  LoanSettlementBreakdown: { label: 'Loan settled', category: 'loan-close', priority: 10 },
  LoanDefaulted: { label: 'Loan defaulted', category: 'loan-default', priority: 90 },
  // #2374 — the protocol's record of what the loan owed at the default.
  // Book-keeping beside the default itself: it moves no funds, so it carries
  // no value leg (the figure is stated on the claim), and its LOW priority
  // keeps it from ever representing the transaction — even below the
  // unmapped default (20), so `LoanStatusChanged` on a fallback entry still
  // represents the row as it did before this event existed.
  OwedAtDefaultRecorded: { label: 'Amount owed at default recorded', category: 'loan-default', priority: 8 },
  // #2427 — the protocol's record of what internal matching cleared from a
  // loan it closed. Book-keeping beside the match: it moves no funds, so it
  // carries no value leg (the figure is stated on the claim), and the same
  // LOW priority keeps it from ever representing the transaction.
  OwedAtInternalMatchRecorded: { label: 'Amount cleared by internal matching recorded', category: 'loan-close', priority: 8 },
  LoanLiquidated: { label: 'Loan liquidated', category: 'loan-default', priority: 90 },
  BackstopAbsorbedLoan: { label: 'Loan absorbed by backstop', category: 'loan-default', priority: 88 },
  LoanExtended: { label: 'Loan extended', category: 'loan-modify', priority: 75 },
  LoanRefinanced: { label: 'Loan refinanced', category: 'loan-modify', priority: 85 },
  LoanPreclosedDirect: { label: 'Loan closed early', category: 'loan-close', priority: 85 },
  // A claim is the user's OWN final action and must outrank the
  // LoanSettled (85) the same tx emits (Codex #1171 r2): ClaimFacet
  // fires LenderFundsClaimed/BorrowerFundsClaimed then LoanSettled in
  // one transaction, and the indexer inserts every decoded log — so
  // without a higher priority the feed would label the claim "Loan
  // settled" and bury the real action in "+1 more".
  LenderFundsClaimed: { label: 'Funds claimed', category: 'loan-close', priority: 92 },
  BorrowerFundsClaimed: { label: 'Collateral claimed', category: 'loan-close', priority: 92 },
  // Borrower's VPFI loan-initiation-fee rebate, paid alongside the
  // borrower claim (lower priority than it so the claim represents).
  BorrowerLifRebateClaimed: { label: 'Fee rebate claimed', category: 'loan-close', priority: 60 },
  OffsetCompleted: { label: 'Loan offset', category: 'loan-close', priority: 80 },
  OffsetOfferCreated: { label: 'Offset offer created', category: 'offer', priority: 50 },
  LoanSold: { label: 'Loan sold', category: 'loan-modify', priority: 80 },
  LoanSaleCompleted: { label: 'Loan sale completed', category: 'loan-modify', priority: 82 },
  LoanSaleOfferLinked: { label: 'Loan listed for sale', category: 'loan-modify', priority: 60 },
  LoanObligationTransferred: { label: 'Loan position transferred', category: 'loan-modify', priority: 70 },
  // Swap-to-repay roll: proceeds re-capitalized into the position.
  IntentLoanRolled: { label: 'Loan rolled over', category: 'loan-modify', priority: 75 },
  CollateralAdded: { label: 'Collateral added', category: 'collateral', priority: 75 },
  InternalMatchExecuted: { label: 'Loan matched internally', category: 'loan-open', priority: 82 },
  // Prepay collateral-sale listings (the borrower's parallel-sale exit).
  PrepayListingPosted: { label: 'Collateral listed for sale', category: 'loan-modify', priority: 55 },
  PrepayListingMatched: { label: 'Collateral sale matched', category: 'loan-modify', priority: 78 },
  PrepayListingUpdated: { label: 'Collateral listing updated', category: 'loan-modify', priority: 50 },
  PrepayListingCanceled: { label: 'Collateral listing cancelled', category: 'loan-modify', priority: 45 },
  PrepayCollateralSaleSettled: { label: 'Collateral sale settled', category: 'loan-close', priority: 80 },
  // Swap-to-repay
  SwapToRepayExecuted: { label: 'Repaid via collateral swap', category: 'loan-repay', priority: 88 },
  SwapToRepayPartialExecuted: { label: 'Partial repay via swap', category: 'loan-repay', priority: 70 },
  SwapToRepayIntentCommitted: { label: 'Swap-to-repay set up', category: 'loan-repay', priority: 40 },
  SwapToRepayIntentFilled: { label: 'Swap-to-repay filled', category: 'loan-repay', priority: 78 },
  SwapToRepayIntentCancelled: { label: 'Swap-to-repay cancelled', category: 'loan-repay', priority: 40 },
  SwapToRepayIntentForceCancelled: { label: 'Swap-to-repay cancelled', category: 'loan-repay', priority: 40 },
  // #1566 slices 2-3 — custody provenance on the loan's timeline. Low priority:
  // each fires inside the transaction whose own event represents it (the fill,
  // the failed liquidation, a claim, a cure, a match).
  SwapToRepayIntentLotPulled: { label: 'Swap-to-repay collateral taken', category: 'loan-repay', priority: 12 },
  FallbackCustodyMoved: { label: 'Collateral custody updated', category: 'collateral', priority: 12 },
  // Periodic interest
  PeriodicInterestSettled: { label: 'Interest settled', category: 'loan-repay', priority: 50 },
  PeriodicInterestAutoLiquidated: { label: 'Auto-liquidated for interest', category: 'loan-default', priority: 85 },
  RepayPartialPeriodAdvanced: { label: 'Interest period advanced', category: 'loan-repay', priority: 45 },
  // Informational: the periodic swap cleared the slippage gate but the
  // lender still received less interest than owed.
  PeriodicSlippageOverBuffer: { label: 'Interest settled with slippage', category: 'loan-repay', priority: 40 },
  // Signed offers
  SignedOfferFilled: { label: 'Signed offer filled', category: 'loan-open', priority: 80 },
  SignedOfferMatched: { label: 'Signed offers matched', category: 'loan-open', priority: 80 },
  SignedOfferCancelled: { label: 'Signed offer cancelled', category: 'offer', priority: 55 },
  SignedOfferNonceBurned: { label: 'Signed offer voided', category: 'offer', priority: 30 },
  // VPFI / rewards / vault — surfaced in the wallet's OWN feed (the
  // indexer's pluckActivityRefs attributes these to the acting wallet;
  // apps/indexer/src/chainIndexer.ts). Without explicit labels they
  // rendered humanized English in every locale.
  InteractionRewardsClaimed: { label: 'Rewards claimed', category: 'other', priority: 60 },
  RewardDeliveredToVault: { label: 'Rewards delivered to your vault', category: 'other', priority: 55 },
  VPFIDepositedToVault: { label: 'VPFI deposited to vault', category: 'other', priority: 60 },
  VPFIWithdrawnFromVault: { label: 'VPFI withdrawn from vault', category: 'other', priority: 60 },
  VaultVpfiDebited: { label: 'VPFI spent from vault', category: 'other', priority: 50 },
  // #1566 — a forfeited reward entry settled (shown on its owner's feed and
  // its loan's timeline).
  RewardEntryForfeitSettled: { label: 'Rewards forfeited', category: 'other', priority: 50 },
  // #2658 — every other event the indexer files under a loan or offer
  // (#1794 files them from the ABI by one rule, so they reach the wallet's
  // feed through its loan ids). None is hidden: each is something that
  // happened on the chain to the wallet's loan or offer, and the page
  // shows what it knows. Book-keeping and companion events carry a LOW
  // priority (below the unmapped default of 20) so they ride inside the
  // row of the action that emitted them as "+N more" and never represent
  // it; an outcome (a liquidation, a failed sale, a claim) outranks the
  // status edge and the swap attempts its transaction also emits.
  // `LoanStatusChanged` keeps the default priority it had while unmapped.
  // The guard in activityView.test.ts derives the set from the ABI.
  AutoDailyDeducted: { label: 'Daily rental fee paid', category: 'loan-repay', priority: 50 },
  AutoExtendBorrowerCapsChanged: { label: 'Automatic extension limits updated', category: 'loan-modify', priority: 40 },
  AutoExtendLenderCapsChanged: { label: 'Automatic extension limits updated', category: 'loan-modify', priority: 40 },
  // Emitted even when the opt-out was already clear (a documented no-op
  // confirmation), so the label states the resulting setting, not a change.
  AutoListOptOutCleared: { label: 'Automatic grace-period listing on', category: 'loan-modify', priority: 40 },
  AutoRefinanceCapsChanged: { label: 'Automatic refinance limits updated', category: 'loan-modify', priority: 40 },
  BackstopFilled: { label: 'Funded by the backstop', category: 'loan-open', priority: 60 },
  BackstopLoanClaimed: { label: 'Backstop recovery claimed', category: 'loan-close', priority: 80 },
  // Paid inside the borrower's claim, before its own event: below the claim
  // (92) so the claim represents the row; its value is still a leg of it.
  BorrowerSurplusClaimed: { label: 'Surplus claimed', category: 'loan-close', priority: 60 },
  ClaimRetryExecuted: { label: 'Collateral sale retried', category: 'loan-close', priority: 70 },
  CollateralConsolidated: { label: 'Collateral consolidated', category: 'collateral', priority: 30 },
  FeeEntitlementRepriced: { label: 'Fee terms updated', category: 'loan-modify', priority: 8 },
  FeeEntitlementStamped: { label: 'Fee terms recorded', category: 'loan-open', priority: 8 },
  HFLiquidationTriggered: { label: 'Liquidation triggered', category: 'loan-default', priority: 86 },
  IntentMatched: { label: 'Order matched', category: 'loan-open', priority: 78 },
  IntentPriorityFill: { label: 'Priority credit used for a fill', category: 'loan-open', priority: 30 },
  LenderBackstopOptInSet: { label: 'Backstop exit choice updated', category: 'loan-modify', priority: 45 },
  LiquidationDiscounted: { label: 'Liquidated at a discount', category: 'loan-default', priority: 89 },
  LiquidationFallback: { label: 'Collateral sale failed', category: 'loan-default', priority: 84 },
  // Emitted beside LiquidationFallback when the split had no price: one
  // above it, so the more specific outcome names the row.
  LiquidationFallbackOracleUnavailable: { label: 'Collateral sale failed: no price available', category: 'loan-default', priority: 85 },
  LiquidationFallbackSplit: { label: 'Collateral split recorded', category: 'loan-default', priority: 12 },
  LoanCuredFromFallback: { label: 'Loan restored by adding collateral', category: 'collateral', priority: 85 },
  LoanFallbackPending: { label: 'Settlement pending after a failed sale', category: 'loan-default', priority: 87 },
  LoanKeeperEnabled: { label: 'Keeper permission updated', category: 'loan-modify', priority: 40 },
  LoanPartiallyLiquidated: { label: 'Loan partly liquidated', category: 'loan-default', priority: 88 },
  LoanSaleListingTornDown: { label: 'Loan sale listing removed', category: 'loan-modify', priority: 45 },
  LoanStatusChanged: { label: 'Loan status updated', category: 'other', priority: 20 },
  NotificationFeeBilled: { label: 'Notification fee charged', category: 'other', priority: 30 },
  OfferBackstopEligibilitySet: { label: 'Backstop eligibility set', category: 'offer', priority: 40 },
  OfferCreatorFullTariffSet: { label: 'Fee choice recorded for the offer', category: 'offer', priority: 12 },
  OfferKeeperEnabled: { label: 'Keeper permission updated', category: 'offer', priority: 40 },
  OfferSaleProceedsCredited: { label: 'Sale proceeds credited to the vault', category: 'offer', priority: 60 },
  OfferSaleProceedsSplit: { label: 'Sale proceeds split', category: 'loan-close', priority: 75 },
  ParallelSaleLockReleased: { label: 'Collateral sale listing released', category: 'offer', priority: 45 },
  PartialCollateralWithdrawn: { label: 'Collateral partly withdrawn', category: 'collateral', priority: 75 },
  PostParallelSaleListing: { label: 'Collateral sale listing posted', category: 'offer', priority: 55 },
  PrepaySaleListingSynced: { label: 'Collateral sale listing rechecked', category: 'loan-modify', priority: 15 },
  PrepaySaleOfferSynced: { label: 'Sale offer rechecked', category: 'offer', priority: 15 },
  SanctionedProceedsLocked: { label: 'Share held in the vault while this wallet is flagged', category: 'loan-close', priority: 30 },
  SwapAdapterAttempted: { label: 'Swap route tried', category: 'other', priority: 6 },
  SwapAdapterSucceeded: { label: 'Swap route used', category: 'other', priority: 6 },
  SwapAllAdaptersFailed: { label: 'Every swap route failed', category: 'loan-default', priority: 14 },
  // Records BOTH directions: a closed loan's owed VPFI entering a vault
  // owner's fee-tier exclusion, and leaving it (cleared, with no owner and a
  // zero amount, when the position NFT returns to the stored party). One
  // static label serves both, so it names the update, not a direction.
  TierExclusionUpdated: { label: 'VPFI discount-tier exclusion updated', category: 'other', priority: 12 },
  VPFIDiscountApplied: { label: 'Fee discount applied (paid in VPFI)', category: 'loan-open', priority: 12 },
  VPFIYieldFeeDiscountApplied: { label: 'Yield fee discount applied (paid in VPFI)', category: 'loan-close', priority: 12 },
  VaultRentalUpdated: { label: 'Rental access updated', category: 'loan-modify', priority: 12 },
  // #2703 — kinds the participants rule (@vaipakam/lib/activityParticipants)
  // admits to a wallet's page because the wallet is a party: its own
  // settings, intents, vault, perks and reward entries. Companions and
  // NFT book-keeping stay low so the action beside them represents the row.
  // The flagged-wallet rows use the in-app wording only (no list or
  // provider named), the same as SanctionedProceedsLocked.
  ApprovalForAll: { label: 'Approval for all position NFTs', category: 'other', priority: 5 },
  NFTMinted: { label: 'Position NFT minted', category: 'other', priority: 5 },
  OfferCreatedDetails: { label: 'Offer created', category: 'offer', priority: 10 },
  OfferCanceledDetails: { label: 'Offer cancelled', category: 'offer', priority: 10 },
  // Created lazily inside a wallet's first offer, accept or deposit, before
  // that action's own event: low, so the action represents the row (#2708 r1).
  UserVaultCreated: { label: 'Vault created', category: 'other', priority: 8 },
  TermsAccepted: { label: 'Terms of use accepted', category: 'other', priority: 40 },
  TokenDisowned: { label: 'Unsolicited tokens disowned', category: 'other', priority: 40 },
  StuckERC20Recovered: { label: 'Stuck tokens recovered', category: 'other', priority: 60 },
  AutoLendConsentChanged: { label: 'Auto-lend setting updated', category: 'other', priority: 40 },
  AutoOptInOnNewLoanChanged: { label: 'Automatic refinance setting for new loans updated', category: 'other', priority: 40 },
  DefaultAutoRefinanceCapsChanged: { label: 'Default automatic refinance limits updated', category: 'other', priority: 40 },
  KeeperAccessUpdated: { label: 'Keeper access setting updated', category: 'other', priority: 40 },
  KeeperActionsUpdated: { label: 'Keeper permissions updated', category: 'other', priority: 40 },
  KeeperRevoked: { label: 'Keeper removed', category: 'other', priority: 40 },
  VPFIDiscountConsentChanged: { label: 'VPFI fee discount setting updated', category: 'other', priority: 40 },
  LenderIntentSet: { label: 'Standing lending intent set', category: 'offer', priority: 50 },
  LenderIntentFunded: { label: 'Standing lending intent funded', category: 'offer', priority: 50 },
  LenderIntentCapitalWithdrawn: { label: 'Capital withdrawn from a standing lending intent', category: 'offer', priority: 50 },
  LenderIntentCancelled: { label: 'Standing lending intent cancelled', category: 'offer', priority: 50 },
  LenderIntentPrioritySet: { label: 'Priority routing setting updated', category: 'offer', priority: 30 },
  PerkPurchased: { label: 'Perk bought with VPFI', category: 'other', priority: 60 },
  PerkCreditConsumed: { label: 'Perk credit used', category: 'other', priority: 12 },
  RewardEntryHorizonStamped: { label: 'Reward claim window started', category: 'other', priority: 30 },
  RewardEntryExpiryArmed: { label: 'Reward entered its final notice period', category: 'other', priority: 40 },
  RewardEntryExpiryBegun: { label: 'Unclaimed reward returning to the rewards programme', category: 'other', priority: 44 },
  RewardEntryExpired: { label: 'Unclaimed reward returned to the rewards programme', category: 'other', priority: 46 },
  // Also emitted for a share set apart for a flagged wallet (its venue is the
  // held balance), beside RewardSanctionsHeldApart: below it, so the row says
  // the reward was set aside, never that it was delivered (#2708 r1).
  StagingDelivered: { label: 'Rewards settled for a day', category: 'other', priority: 45 },
  RewardSanctionsHeldApart: { label: 'Rewards set aside while this wallet is flagged', category: 'other', priority: 50 },
  RewardSanctionsHeldReleased: { label: 'Set-aside rewards ready to claim', category: 'other', priority: 55 },
  StagingClaimantForfeited: { label: 'Rewards forfeited while this wallet is flagged', category: 'other', priority: 50 },
  // Low-priority book-keeping — never represents a transaction alone.
  Transfer: { label: 'Transfer', category: 'other', priority: 5 },
  Approval: { label: 'Approval', category: 'other', priority: 5 },
};

/**
 * #2703 — whether one feed event belongs on a wallet's Activity page: it
 * concerns one of the wallet's loans, or the wallet is one of its
 * participants by the shared rule (`@vaipakam/lib/activityParticipants`:
 * its actor, the one the indexer files the row under, and the further
 * parties the rule lists). Never because the address appears somewhere in
 * the args: that admitted role grants, treasury settings and approved
 * operators, under names nobody had written. `me` is lower-case.
 */
export function isWalletActivity(
  ev: IndexedActivityEvent,
  me: string,
  myLoanIds: ReadonlySet<number>,
): boolean {
  if (ev.loanId !== null && myLoanIds.has(ev.loanId)) return true;
  // The indexer sends args it could not parse as the raw string; such a row
  // names no participant the rule can read.
  const args = typeof ev.args === 'object' && ev.args !== null ? ev.args : {};
  return activityParticipants(ev.kind, args).includes(me);
}

/**
 * Fallback humanizer for a kind absent from ACTIVITY_LABELS — splits
 * camelCase AND keeps ALL-CAPS acronyms (NFT, LTV, VPFI) intact, which
 * the old `([a-z])([A-Z])` + `toLowerCase()` mangled to "Nftminted".
 */
export function humanizeKind(kind: string): string {
  if (!kind) return 'Protocol event';
  const withSpaces = kind
    // boundary between a lowerc/digit and an uppercase: fooBar → foo Bar
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // boundary between an acronym run and a following Word: NFTMinted → NFT Minted
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  // Capitalize the first word; leave the rest as-is so acronyms stay
  // upper ("NFT Minted", not "Nft minted").
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

/** The readable label for an event kind (mapped or humanized). */
export function labelForKind(kind: string): string {
  return ACTIVITY_LABELS[kind]?.label ?? humanizeKind(kind);
}

/**
 * #2658 (#2702 r2) — a status edge INTO an end state is itself the loan's
 * lifecycle outcome. `LoanStatusChanged` is generic as a kind ("Loan status
 * updated"), but its `to` says what happened, and some transactions carry no
 * other event that does: the last daily rental deduction moves the loan to
 * Repaid and emits only the deduction beside the edge. So the edge is named by
 * its destination, at a priority above the routine steps that can cause it
 * (a deduction, an interest settlement, a retry) and below every event that
 * names an outcome itself (a repayment, a default, a claim, a failed sale),
 * which keep their rows. An edge back to Active (a cure) has its own event
 * and keeps the generic name. Keyed by the LibVaipakam.LoanStatus member name.
 */
export const STATUS_EDGE_LABELS: Record<string, ActivityLabel> = {
  Repaid: { label: 'Loan repaid', category: 'loan-repay', priority: 72 },
  Defaulted: { label: 'Loan defaulted', category: 'loan-default', priority: 72 },
  Settled: { label: 'Loan settled', category: 'loan-close', priority: 72 },
  FallbackPending: { label: 'Settlement pending after a failed sale', category: 'loan-default', priority: 72 },
  InternalMatched: { label: 'Loan closed by internal matching', category: 'loan-close', priority: 72 },
};

/** Where a row's display label is translated: the per-kind catalog, or the
 *  per-destination catalog for a status edge into an end state. */
export interface LabelSource {
  catalog: 'labels' | 'statusEdgeLabels';
  key: string;
}

/** The end state a `LoanStatusChanged` moved the loan into, by member name,
 *  when it is one {@link STATUS_EDGE_LABELS} names; otherwise null. */
function statusEdgeOf(ev: IndexedActivityEvent): string | null {
  if (ev.kind !== 'LoanStatusChanged') return null;
  const raw = (ev.args as Record<string, unknown> | null | undefined)?.to;
  const code = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const name = Object.keys(LoanStatus).find((k) => LoanStatus[k as keyof typeof LoanStatus] === code);
  return name !== undefined && Object.hasOwn(STATUS_EDGE_LABELS, name) ? name : null;
}

/** The label entry and catalog key one event is named by. */
function labelOf(ev: IndexedActivityEvent): { meta: ActivityLabel | undefined; source: LabelSource } {
  const edge = statusEdgeOf(ev);
  if (edge !== null) {
    return { meta: STATUS_EDGE_LABELS[edge], source: { catalog: 'statusEdgeLabels', key: edge } };
  }
  return {
    meta: Object.hasOwn(ACTIVITY_LABELS, ev.kind) ? ACTIVITY_LABELS[ev.kind] : undefined,
    source: { catalog: 'labels', key: ev.kind },
  };
}

/** One coalesced feed row — a single transaction's representative
 *  event plus how many sub-events it stood in for. */
export interface ActivityRowView {
  /** Stable key (representative event's tx + logIndex). */
  key: string;
  event: IndexedActivityEvent;
  label: string;
  /** Where {@link label}'s translation lives. */
  labelSource: LabelSource;
  category: ActivityCategory;
  /** Extra events in the same transaction that this row subsumes. */
  hiddenCount: number;
  /** The representative plus every event of the same transaction that names
   *  its loan or offer — the action's own legs, which {@link rowValue} reads
   *  (#2383 r1). A neighbouring loan or offer in a multicall is not one. */
  related: IndexedActivityEvent[];
}

const DEFAULT_PRIORITY = 20;

function priorityOf(ev: IndexedActivityEvent): number {
  return labelOf(ev).meta?.priority ?? DEFAULT_PRIORITY;
}

/**
 * Collapse events sharing one transaction into a single representative
 * row. Input order is preserved for the OUTPUT (rows sorted by the
 * representative event, newest first) and the representative is the
 * highest-priority event in the group (ties broken by lowest logIndex —
 * the earliest emitted). Events with no txHash each stand alone.
 */
export function coalesceByTx(events: IndexedActivityEvent[]): ActivityRowView[] {
  const groups = new Map<string, IndexedActivityEvent[]>();
  for (const ev of events) {
    // Fall back to a per-event key when txHash is missing so such
    // events are never merged together.
    const key = ev.txHash ? ev.txHash : `${ev.blockNumber}:${ev.logIndex}:${ev.kind}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(ev);
    else groups.set(key, [ev]);
  }

  const rows: ActivityRowView[] = [];
  for (const bucket of groups.values()) {
    let rep = bucket[0];
    for (const ev of bucket) {
      const better =
        priorityOf(ev) > priorityOf(rep) ||
        (priorityOf(ev) === priorityOf(rep) && ev.logIndex < rep.logIndex);
      if (better) rep = ev;
    }
    const { meta, source } = labelOf(rep);
    rows.push({
      key: `${rep.txHash || rep.blockNumber}-${rep.logIndex}`,
      event: rep,
      label: meta?.label ?? humanizeKind(rep.kind),
      labelSource: source,
      category: meta?.category ?? 'other',
      hiddenCount: bucket.length - 1,
      related: bucket.filter(
        (ev) =>
          ev === rep ||
          (rep.loanId !== null && ev.loanId === rep.loanId) ||
          (rep.offerId !== null && ev.offerId === rep.offerId),
      ),
    });
  }

  // Newest first: higher block, then higher logIndex.
  rows.sort(
    (a, b) =>
      b.event.blockNumber - a.event.blockNumber ||
      b.event.logIndex - a.event.logIndex,
  );
  return rows;
}

/** One thing a row moved or offered, from the indexer's normalized fields. */
export type ValueLeg =
  | { kind: 'token'; asset: string; amount: bigint; amountMax: bigint | null }
  | { kind: 'nft'; asset: string; tokenId: string; erc1155: boolean; quantity: bigint | null };

const DIGITS = /^\d+$/;

/**
 * #2383 — the value one event carries, from the fields the INDEXER normalized.
 * Nothing is reconstructed from `args` (#2378 tried and was withdrawn): an
 * event without a value, or with one the indexer could not establish, has none.
 */
export function valueLeg(ev: IndexedActivityEvent): ValueLeg | null {
  const asset = ev.asset ?? null;
  if (!asset) return null;
  if (ev.assetType === 0 && ev.amount != null && DIGITS.test(ev.amount)) {
    const amountMax = ev.amountMax != null && DIGITS.test(ev.amountMax) ? BigInt(ev.amountMax) : null;
    return { kind: 'token', asset, amount: BigInt(ev.amount), amountMax };
  }
  if ((ev.assetType === 1 || ev.assetType === 2) && ev.tokenId != null) {
    const erc1155 = ev.assetType === 2;
    const quantity =
      erc1155 && ev.quantity != null && DIGITS.test(ev.quantity) && BigInt(ev.quantity) > 0n
        ? BigInt(ev.quantity)
        : null;
    return { kind: 'nft', asset, tokenId: ev.tokenId, erc1155, quantity };
  }
  return null;
}

/**
 * Which value an event states, so that one transaction's companions are not
 * counted twice: an offer's create/cancel pair (and an amendment) states the
 * offer's terms once; a loan start, its details companion and the accept or
 * match that made it state one fill. Every claim lane is its own value — a
 * borrower claim can pay residual collateral AND a frozen principal surplus,
 * in different assets, in one transaction (#2383 r1).
 *
 * `BorrowerLifRebateClaimed` moves VPFI but the indexer does not itemise it, so
 * it is listed here only so the row can say an amount went unstated.
 */
const VALUE_GROUP: Record<string, string> = {
  OfferCreated: 'offer',
  OfferCreatedDetails: 'offer',
  OfferCanceled: 'offer',
  OfferCanceledDetails: 'offer',
  OfferModified: 'offer',
  LoanInitiated: 'fill',
  LoanInitiatedDetails: 'fill',
  OfferAccepted: 'fill',
  OfferMatched: 'fill',
  LenderFundsClaimed: 'lender-claim',
  BorrowerFundsClaimed: 'borrower-claim',
  BorrowerSurplusClaimed: 'borrower-surplus',
  CollateralAdded: 'collateral-added',
  BorrowerLifRebateClaimed: 'lif-rebate',
};

/** Everything a row can say about value. */
export interface RowValue {
  /** Each distinct value the transaction moved for the row's loan or offer. */
  legs: ValueLeg[];
  /** The same action moved or offered something the indexer did not state
   *  (an unitemised rebate, a value it could not establish, or a row
   *  recorded before values were). */
  unstated: boolean;
  /** A lender claim also pays out any funds held for the lender from earlier
   *  top-ups, and its event names only the claim's own amount. */
  mayIncludeHeldForLender: boolean;
}

/**
 * #2383 r1 — the row's value across EVERY event of its action, not only the
 * representative's: a claim that paid two assets states both, and an amount
 * the indexer could not state is said to exist rather than dropped.
 */
export function rowValue(row: Pick<ActivityRowView, 'related'>): RowValue {
  const byGroup = new Map<string, ValueLeg | null>();
  const ordered = [...row.related].sort((a, b) => a.logIndex - b.logIndex);
  let mayIncludeHeldForLender = false;
  for (const ev of ordered) {
    const group = VALUE_GROUP[ev.kind];
    if (!group) continue;
    if (ev.kind === 'LenderFundsClaimed') mayIncludeHeldForLender = true;
    if (byGroup.get(group)) continue; // already established by a companion
    byGroup.set(group, valueLeg(ev));
  }
  const legs = [...byGroup.values()].filter((l): l is ValueLeg => l !== null);
  return { legs, unstated: legs.length < byGroup.size, mayIncludeHeldForLender };
}

/** What is known about an ERC-20 leg's token while it renders. */
export type LegMeta =
  | { status: 'ready'; decimals: number; symbol: string }
  | { status: 'loading' }
  | { status: 'unreadable' };

/** The locale's words for the states a leg can be in. */
export interface LegLabels {
  loading: (token: string) => string;
  unreadable: (amount: string, token: string) => string;
  quantityUnknown: string;
}

/**
 * One leg as text. A token always carries its contract's short address beside
 * the symbol — a symbol is whatever the token says it is, and two contracts can
 * both call themselves "USDC". Until the token's details load, or when they
 * cannot be read, the leg SAYS so: a known amount is never silently dropped,
 * and base units are never shown as if they were a token amount.
 */
export function legText(leg: ValueLeg, meta: LegMeta, labels: LegLabels): string {
  const token = shortAddress(leg.asset);
  if (leg.kind === 'nft') {
    const nft = `NFT ${token} #${leg.tokenId}`;
    if (!leg.erc1155) return nft;
    return leg.quantity !== null ? `${leg.quantity} × ${nft}` : `${nft} (${labels.quantityUnknown})`;
  }
  const range = leg.amountMax !== null && leg.amountMax > leg.amount;
  if (meta.status === 'loading') return labels.loading(token);
  if (meta.status === 'unreadable') {
    const raw = range ? `${leg.amount}–${leg.amountMax}` : `${leg.amount}`;
    return labels.unreadable(raw, token);
  }
  const n = (v: bigint) => formatTokenAmount(v, meta.decimals);
  const amount = range ? `${n(leg.amount)}–${n(leg.amountMax as bigint)}` : n(leg.amount);
  return `${amount} ${meta.symbol} (${token})`;
}
