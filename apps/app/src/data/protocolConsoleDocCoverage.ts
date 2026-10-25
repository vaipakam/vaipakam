/**
 * #2071 — the Protocol Console held against the canonical knob reference,
 * `docs/ops/AdminConfigurableKnobsAndSwitches.md`.
 *
 * Every `###` setting in that document appears here exactly once: either
 * with the console values that report it, or with the reason the console
 * does not. `protocolConsoleDocCoverage.test.ts` fails when a heading is
 * added to the document without an entry, when an entry names a heading the
 * document no longer has, or when a rendered value is claimed by no entry.
 * So the next setting governance gains cannot go missing from this page
 * without someone writing down why.
 */
import type { ProtocolKnobValues } from './indexer';

export type NotShownReason =
  /** One value per asset, feed, venue or chain, not one protocol-wide
   *  value; it belongs on the surface for that asset or chain. */
  | 'per-asset-or-chain'
  /** A compile-time constant, not a governance setting. */
  | 'compile-time'
  /** Part of the VPFI rewards and recycling system, whose own surfaces
   *  report it. */
  | 'rewards-and-recycling'
  /** A switch for the industrial fork that stays off on this deploy, or a
   *  configuration this deploy does not present on public pages. */
  | 'not-on-retail'
  /** The contract exposes no read for it. */
  | 'no-getter'
  /** Protocol-wide and readable, but only as one field of a multi-value
   *  read or a list; tracked in #2680. */
  | 'not-yet'
  /** An explanatory section of the document, not a setting. */
  | 'explanatory';

export type DocCoverage =
  | {
      shown: readonly (keyof ProtocolKnobValues)[];
      /** Codex #2683 r5 — a heading that documents several settings names
       *  each one it does NOT show here, with the reason, so showing one of
       *  them cannot pass for covering the whole heading. */
      alsoNotShown?: Readonly<Record<string, NotShownReason>>;
    }
  | { notShown: NotShownReason };

/** Keyed by the heading text exactly as the document writes it, after `### `. */
export const DOC_COVERAGE: Readonly<Record<string, DocCoverage>> = {
  'Treasury fee on lender interest': { shown: ['treasuryFeeBps'] },
  'Loan-initiation fee': { shown: ['loanInitiationFeeBps'] },
  'LIF matcher kickback': { shown: ['lifMatcherFeeBps'] },
  'VPFI tier discount thresholds + tier discount BPS': { shown: ['tierThresholds', 'tierDiscountBps'] },
  'Liquidation handling fee + max slippage + max liquidator incentive': {
    shown: ['liquidationHandlingFeeBps', 'maxLiquidationSlippageBps', 'maxLiquidatorIncentiveBps'],
  },
  'Graduated partial-liquidation sizing (#395)': { notShown: 'not-yet' },
  'Loan-admission HF floor (#394)': { shown: ['minHealthFactor'] },
  'Quote-time interest-rate model (#400)': { shown: ['rateModel', 'rateModelMaxDeviationBps'] },
  'Swap-to-Repay max slippage (T-090)': { shown: ['maxSwapToRepaySlippageBps'] },
  'Risk config — volatility-LTV threshold + rental buffer': {
    shown: ['volatilityLtvThresholdBps', 'rentalBufferBps'],
  },
  'Loan-default grace buckets': { notShown: 'not-yet' },
  'Per-asset risk parameters': { notShown: 'per-asset-or-chain' },
  'Notification fee (per loan-side)': { notShown: 'not-yet' },
  'Max offer duration days': { shown: ['maxOfferDurationDays'] },
  'Auto-pause duration seconds': { shown: ['autoPauseDurationSeconds'] },
  'Auto-pause cooldown seconds': { notShown: 'not-yet' },
  'Secondary-oracle max deviation BPS': { shown: ['secondaryOracleMaxDeviationBps'] },
  'Secondary-oracle max staleness seconds': { shown: ['secondaryOracleMaxStalenessSeconds'] },
  'Pyth oracle address': { shown: ['pythOracle'] },
  'Pyth cross-check feed id (pythCrossCheckFeedId)': { shown: ['pythCrossCheckFeedId'] },
  'Pyth max staleness seconds': { shown: ['pythMaxStalenessSeconds'] },
  'Pyth cross-check max deviation BPS (pythCrossCheckMaxDeviationBps)': {
    shown: ['pythCrossCheckMaxDeviationBps'],
  },
  'Pyth confidence max BPS': { shown: ['pythConfidenceMaxBps'] },
  'Per-asset Chainlink feed override': { notShown: 'per-asset-or-chain' },
  'Stable-token feed override': { notShown: 'per-asset-or-chain' },
  'Sequencer uptime feed': { shown: ['sequencerUptimeFeed'] },
  'Chainlink Feed Registry / USD denominator / ETH denominator / WETH contract / ETH-USD feed / Uniswap V3 factory':
    { notShown: 'not-yet' },
  'Reward grace seconds': { shown: ['rewardGraceSeconds'] },
  'Reward messenger / base chain id / canonical reward chain flag': { notShown: 'rewards-and-recycling' },
  'Interaction-rewards launch timestamp': { notShown: 'rewards-and-recycling' },
  'Interaction-rewards cap (VPFI per ETH)': { notShown: 'rewards-and-recycling' },
  'Spend-gated perk configuration (`perkPriceVpfi`, `perkDurationSeconds`)': {
    notShown: 'rewards-and-recycling',
  },
  'Per-chain keeper allocation (`chainKeeperAllocateBps`)': { notShown: 'rewards-and-recycling' },
  'Per-chain daily attribution ceiling (`chainDailyAttributionCap`)': { notShown: 'rewards-and-recycling' },
  'Platform recycling margin (`recycleMarginBps`)': { notShown: 'rewards-and-recycling' },
  'Absorption tariff coefficient (`tariffKPerLifYear`)': { notShown: 'rewards-and-recycling' },
  'Full VPFI tariff kill switch (`feeEntitlementEnabled`)': { notShown: 'rewards-and-recycling' },
  'Loan-side reward-cap haircut (`rewardHaircutBps`)': { notShown: 'rewards-and-recycling' },
  'Per-user daily share cap (`userSideShareCapBps`)': { notShown: 'rewards-and-recycling' },
  'Allocation-register keeper weight (`recycleRegisterKeeperBps`)': { notShown: 'rewards-and-recycling' },
  'Reward claim horizon (`rewardClaimHorizonDays`)': { notShown: 'rewards-and-recycling' },
  'Per-chain surplus flag multiple (`recycleSurplusMultiple`)': { notShown: 'rewards-and-recycling' },
  'Governor commitment arming (`governorCommitArmedFromDay`)': { notShown: 'rewards-and-recycling' },
  'Expected source chain ids (`expectedSourceChainIds`)': { notShown: 'rewards-and-recycling' },
  'Repatriation endpoints (`repatriationEndpoints`, `repatriationTokenAdminRegistry`)': {
    notShown: 'rewards-and-recycling',
  },
  'KYC tier 0 / tier 1 thresholds (numeraire)': { notShown: 'not-on-retail' },
  'Standing-intent fill switch (`lenderIntentEnabled`)': { shown: ['lenderIntentEnabled'] },
  'Standing-intent admission floor (`minIntentFillNumeraire`)': { shown: ['minIntentFillNumeraire'] },
  'Matching kill-switch (`partialFillEnabled`)': { shown: ['partialFillEnabled'] },
  'Master kill-switch — `discountPathEnabled`': { notShown: 'no-getter' },
  'Per-tier liquidator discount (BPS)': { notShown: 'not-yet' },
  'Periodic interest enabled flag (periodicInterestEnabled)': { shown: ['periodicInterestEnabled'] },
  'Numeraire swap enabled flag (numeraireSwapEnabled)': { shown: ['numeraireSwapEnabled'] },
  // The heading's feed-side slots are the symbol, the ETH feed, the
  // Chainlink denominator and the Pyth feed id (its own heading above);
  // its value-side knobs are the finer-cadence threshold (its own heading)
  // and the KYC tier thresholds.
  'Numeraire-rotation surface — Generalizing Numeraire (B1)': {
    shown: ['numeraireSymbol', 'ethNumeraireFeed'],
    alsoNotShown: {
      numeraireChainlinkDenominator: 'no-getter',
      kycTierThresholdsNumeraire: 'not-on-retail',
    },
  },
  'Predominantly Available Denominator (PAD)': { notShown: 'not-yet' },
  'Min principal for finer cadence (minPrincipalForFinerCadence)': { shown: ['minPrincipalForFinerCadence'] },
  'Pre-notify lead time in days (preNotifyDays)': { shown: ['preNotifyDays'] },
  'Range-orders cancel cooldown': { notShown: 'compile-time' },
  'Treasury address': { shown: ['treasury'] },
  '0x proxy / Pancakeswap V3 factory / Sushiswap V3 factory': { notShown: 'not-yet' },
  'Reward messenger address mapping': { notShown: 'per-asset-or-chain' },
  'CCIP messenger registry (chain selectors, remote messengers, channel peers)': {
    notShown: 'per-asset-or-chain',
  },
  'Sanctions oracle address': { notShown: 'not-on-retail' },
  '`cfgAutoLendEnabled`': { shown: ['autoLendEnabled'] },
  '`cfgAutoRefinanceEnabled`': { shown: ['autoRefinanceEnabled'] },
  '`cfgAutoExtendEnabled`': { shown: ['autoExtendEnabled'] },
  'Independence from per-user consent': { notShown: 'explanatory' },
  'Recommended operational mode': { notShown: 'explanatory' },
  '`keepersPaused` — global keeper pause': { shown: ['keepersPaused'] },
  '`aggregatorAdaptersPaused` — external yield-aggregator pause': { notShown: 'no-getter' },
  '`peerLtvReadsPaused` — peer-protocol data-read pause': { notShown: 'no-getter' },
  '`swapAdapterDisabled[adapter]` — per-venue swap pause': { notShown: 'per-asset-or-chain' },
};
