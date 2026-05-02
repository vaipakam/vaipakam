/**
 * T-042 admin dashboard — single typed source for every governance-
 * tunable knob the admin console surfaces.
 *
 * Two distinct concepts captured per knob:
 *
 *   1. **Hard bounds** (`hardMin`, `hardMax`): policy-encoded in the
 *      contract. Values outside the hard bound are rejected at the
 *      setter with `ParameterOutOfRange`. Sourced from the constants
 *      in `contracts/src/libraries/LibVaipakam.sol` — kept in sync
 *      manually here. Auditor-load-bearing.
 *
 *   2. **Soft zones** (`safeMin`, `safeMax`, `midMin`, `midMax`):
 *      *operational opinion*, frontend-curated. Inside the hard
 *      bound the dashboard splits the slider into three coloured
 *      regions:
 *        - green  (safe):       safeMin..safeMax
 *        - amber  (mid):        midMin..safeMin   AND   safeMax..midMax
 *        - red    (caution):    hardMin..midMin   AND   midMax..hardMax
 *      The contract enforces NEITHER the soft zones — they exist to
 *      help operators visually pick a sensible value within the
 *      contract's hard window. A red-zone proposal still passes the
 *      setter; the dashboard just visually flags it.
 *
 * Why frontend-curated zones (vs on-chain): operational opinion
 * evolves faster than contract upgrades. Adjusting "what's safe vs
 * cautious for the staking APR" should not require a `diamondCut`.
 * The hard bounds — which DO live on-chain — already prevent
 * actually-degenerate values; the soft zones are advisory, not
 * load-bearing for security.
 *
 * Per CLAUDE.md and T-042: the document
 * `docs/ops/AdminConfigurableKnobsAndSwitches.md` (mirrored at
 * `frontend/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md`)
 * is the prose reference. `infoAnchor` on each entry below points to
 * the corresponding heading slug.
 */

export type KnobCategory =
  | 'fees'
  | 'risk'
  | 'oracle'
  | 'rewards'
  | 'crossChain'
  | 'rangeOrders'
  | 'periodicInterest'
  | 'kyc'
  | 'matching';

export type KnobUnit =
  | 'bps' // basis points (1bp = 0.01%) — display as percent
  | 'seconds' // display as seconds / minutes / hours / days
  | 'wholeNumber' // raw int (e.g. VPFI per ETH ratio)
  | 'usd1e18' // 1e18-scaled USD — display as $X
  | 'tokens1e18' // 1e18-scaled token amount
  | 'address' // 0x… — no slider, surfaces as text + checksum
  | 'bytes32' // bytes32 — text input
  | 'bool'; // toggle switch

export interface KnobMeta {
  /** Stable identifier for the knob — used as React key + URL param. */
  id: string;
  /** Display label shown on the card. */
  label: string;
  /** One-sentence description shown below the label. Long-form rationale
   *  lives in the markdown runbook; this is the dashboard tooltip. */
  short: string;
  /** Category the knob belongs to. Drives layout grouping. */
  category: KnobCategory;
  /** Unit semantics — drives the formatter + the slider step. */
  unit: KnobUnit;
  /** Hard min from the contract (uint as string for >2^53 safety). */
  hardMin: string;
  /** Hard max from the contract. */
  hardMax: string;
  /** Soft-safe lower edge (frontend curated). Equal to hardMin when
   *  the safe zone touches the floor. */
  safeMin: string;
  /** Soft-safe upper edge. */
  safeMax: string;
  /** Mid (amber) zone lower edge. midMin ≤ safeMin. */
  midMin: string;
  /** Mid (amber) zone upper edge. midMax ≥ safeMax. */
  midMax: string;
  /** The on-chain getter function name on the relevant facet. Used
   *  by the dashboard's batched multicall reader. */
  getter: {
    facet: string;
    fn: string;
    /** Returned ABI types — single value or tuple. Inline strings
     *  rather than full ABI to keep this file readable. */
    returns: string;
    /** Optional argument descriptors when the getter is parameterised
     *  (e.g. per-asset risk params). */
    args?: Array<{ name: string; type: string }>;
  };
  /** The setter function. Frontend constructs the calldata + opens
   *  Safe with it pre-filled. */
  setter: {
    facet: string;
    fn: string;
    /** Setter param signature — arg names + types. */
    args: Array<{ name: string; type: string }>;
  };
  /** Slug for the heading anchor inside the markdown runbook. */
  infoAnchor: string;
  /** Default fallback value when the on-chain stored value is `0` and
   *  the effective getter would return a library default. Optional —
   *  only set when the knob has a sentinel-zero default behaviour. */
  defaultFallback?: string;
  /** When true, the cockpit view renders this knob as a circular
   *  gauge; when false (e.g. address / bytes32 / bool), renders as a
   *  toggle / text. */
  hasNumericRange: boolean;
}

/**
 * The full knob catalogue. Order within a category is the display
 * order on the dashboard. Categories themselves are ordered by the
 * `categoryOrder` constant below.
 */
export const ADMIN_KNOBS: KnobMeta[] = [
  // ─── Fees & Protocol Economics ──────────────────────────────────

  {
    id: 'treasuryFeeBps',
    label: 'Treasury fee',
    short: 'Cut of accrued lender interest forwarded to treasury.',
    category: 'fees',
    unit: 'bps',
    hardMin: '0',
    hardMax: '1000', // MAX_FEE_BPS — assume 10% as in current ConfigFacet
    safeMin: '50', // 0.5%
    safeMax: '300', // 3%
    midMin: '0',
    midMax: '500', // 5%
    getter: { facet: 'ConfigFacet', fn: 'getTreasuryFeeBps', returns: 'uint16' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setFeesConfig',
      args: [
        { name: 'treasuryFeeBps', type: 'uint16' },
        { name: 'loanInitiationFeeBps', type: 'uint16' },
      ],
    },
    infoAnchor: 'treasury-fee-on-lender-interest',
    hasNumericRange: true,
  },
  {
    id: 'loanInitiationFeeBps',
    label: 'Loan-initiation fee',
    short: 'Borrower-paid fee at loan start (in VPFI). Tier discounts apply.',
    category: 'fees',
    unit: 'bps',
    hardMin: '0',
    hardMax: '1000',
    safeMin: '5', // 0.05%
    safeMax: '100', // 1%
    midMin: '0',
    midMax: '500',
    getter: { facet: 'ConfigFacet', fn: 'getLoanInitiationFeeBps', returns: 'uint16' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setFeesConfig',
      args: [
        { name: 'treasuryFeeBps', type: 'uint16' },
        { name: 'loanInitiationFeeBps', type: 'uint16' },
      ],
    },
    infoAnchor: 'loan-initiation-fee',
    hasNumericRange: true,
  },
  {
    id: 'lifMatcherFeeBps',
    label: 'LIF matcher kickback',
    short: 'Slice of treasury LIF that goes to the wallet calling matchOffers.',
    category: 'fees',
    unit: 'bps',
    hardMin: '0',
    hardMax: '1000',
    safeMin: '50',
    safeMax: '300',
    midMin: '0',
    midMax: '500',
    getter: { facet: 'ConfigFacet', fn: 'getLifMatcherFeeBps', returns: 'uint16' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setLifMatcherFeeBps',
      args: [{ name: 'newBps', type: 'uint16' }],
    },
    infoAnchor: 'lif-matcher-kickback',
    hasNumericRange: true,
  },
  {
    id: 'stakingAprBps',
    label: 'Staking APR',
    short: 'VPFI staking annual return. 0 disables rewards while preserving stake.',
    category: 'fees',
    unit: 'bps',
    hardMin: '0',
    hardMax: '2000', // STAKING_APR_BPS_MAX = 20%
    safeMin: '500', // 5%
    safeMax: '1500', // 15%
    midMin: '0',
    midMax: '1800', // 18%
    getter: { facet: 'ConfigFacet', fn: 'getStakingAprBps', returns: 'uint16' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setStakingApr',
      args: [{ name: 'aprBps', type: 'uint16' }],
    },
    infoAnchor: 'staking-apr',
    hasNumericRange: true,
  },

  // ─── Oracle Stack ────────────────────────────────────────────────

  {
    id: 'pythNumeraireMaxDeviationBps',
    label: 'Pyth ↔ Chainlink max deviation',
    short:
      'Tolerated divergence between Chainlink ETH/USD and Pyth ETH/USD. Beyond this the price view fails-closed.',
    category: 'oracle',
    unit: 'bps',
    hardMin: '100', // 1%
    hardMax: '2000', // 20%
    safeMin: '300', // 3%
    safeMax: '700', // 7%
    midMin: '100',
    midMax: '1200', // 12%
    defaultFallback: '500', // 5%
    getter: {
      facet: 'OracleAdminFacet',
      fn: 'getPythNumeraireMaxDeviationBps',
      returns: 'uint16',
    },
    setter: {
      facet: 'OracleAdminFacet',
      fn: 'setPythNumeraireMaxDeviationBps',
      args: [{ name: 'bps', type: 'uint16' }],
    },
    infoAnchor: 'pyth-numeraire-max-deviation-bps',
    hasNumericRange: true,
  },
  {
    id: 'pythConfidenceMaxBps',
    label: 'Pyth confidence ceiling',
    short: 'Soft-skip Pyth when its uncertainty (conf/price) exceeds this.',
    category: 'oracle',
    unit: 'bps',
    hardMin: '50',
    hardMax: '500',
    safeMin: '75',
    safeMax: '200',
    midMin: '50',
    midMax: '350',
    defaultFallback: '100',
    getter: { facet: 'OracleAdminFacet', fn: 'getPythConfidenceMaxBps', returns: 'uint16' },
    setter: {
      facet: 'OracleAdminFacet',
      fn: 'setPythConfidenceMaxBps',
      args: [{ name: 'bps', type: 'uint16' }],
    },
    infoAnchor: 'pyth-confidence-max-bps',
    hasNumericRange: true,
  },
  {
    id: 'pythMaxStalenessSeconds',
    label: 'Pyth max staleness',
    short: 'Beyond this age, the Pyth snapshot soft-skips and Chainlink-only proceeds.',
    category: 'oracle',
    unit: 'seconds',
    hardMin: '60',
    hardMax: '3600',
    safeMin: '180', // 3 min
    safeMax: '900', // 15 min
    midMin: '60',
    midMax: '1800', // 30 min
    defaultFallback: '300',
    getter: {
      facet: 'OracleAdminFacet',
      fn: 'getPythMaxStalenessSeconds',
      returns: 'uint64',
    },
    setter: {
      facet: 'OracleAdminFacet',
      fn: 'setPythMaxStalenessSeconds',
      args: [{ name: 'secondsBudget', type: 'uint64' }],
    },
    infoAnchor: 'pyth-max-staleness-seconds',
    hasNumericRange: true,
  },
  {
    id: 'secondaryOracleMaxDeviationBps',
    label: 'Secondary-quorum max deviation',
    short:
      'Tellor / API3 / DIA agreement window vs Chainlink primary. Outside → disagree.',
    category: 'oracle',
    unit: 'bps',
    hardMin: '100',
    hardMax: '2000',
    safeMin: '300',
    safeMax: '700',
    midMin: '100',
    midMax: '1200',
    defaultFallback: '500',
    getter: {
      facet: 'OracleAdminFacet',
      fn: 'getSecondaryOracleMaxDeviationBps',
      returns: 'uint16',
    },
    setter: {
      facet: 'OracleAdminFacet',
      fn: 'setSecondaryOracleMaxDeviationBps',
      args: [{ name: 'bps', type: 'uint16' }],
    },
    infoAnchor: 'secondary-oracle-max-deviation-bps',
    hasNumericRange: true,
  },
  {
    id: 'secondaryOracleMaxStalenessSeconds',
    label: 'Secondary-quorum max staleness',
    short:
      'Beyond this age, secondary oracle data is treated as Unavailable.',
    category: 'oracle',
    unit: 'seconds',
    hardMin: '60',
    hardMax: '104400', // 29h
    safeMin: '600', // 10 min
    safeMax: '14400', // 4h
    midMin: '60',
    midMax: '86400', // 24h
    defaultFallback: '3600',
    getter: {
      facet: 'OracleAdminFacet',
      fn: 'getSecondaryOracleMaxStaleness',
      returns: 'uint40',
    },
    setter: {
      facet: 'OracleAdminFacet',
      fn: 'setSecondaryOracleMaxStaleness',
      args: [{ name: 'maxStaleness', type: 'uint40' }],
    },
    infoAnchor: 'secondary-oracle-max-staleness-seconds',
    hasNumericRange: true,
  },
  {
    id: 'pythOracle',
    label: 'Pyth oracle address',
    short: 'Per-chain Pyth contract. Zero disables the numeraire-redundancy gate.',
    category: 'oracle',
    unit: 'address',
    hardMin: '0',
    hardMax: '0',
    safeMin: '0',
    safeMax: '0',
    midMin: '0',
    midMax: '0',
    getter: { facet: 'OracleAdminFacet', fn: 'getPythOracle', returns: 'address' },
    setter: {
      facet: 'OracleAdminFacet',
      fn: 'setPythOracle',
      args: [{ name: 'oracle', type: 'address' }],
    },
    infoAnchor: 'pyth-oracle-address',
    hasNumericRange: false,
  },
  {
    id: 'pythNumeraireFeedId',
    label: 'Pyth numeraire feed ID',
    short: 'ETH/USD on ETH-native chains; bridged-WETH/USD on BNB / Polygon.',
    category: 'oracle',
    unit: 'bytes32',
    hardMin: '0',
    hardMax: '0',
    safeMin: '0',
    safeMax: '0',
    midMin: '0',
    midMax: '0',
    getter: { facet: 'OracleAdminFacet', fn: 'getPythNumeraireFeedId', returns: 'bytes32' },
    setter: {
      facet: 'OracleAdminFacet',
      fn: 'setPythNumeraireFeedId',
      args: [{ name: 'feedId', type: 'bytes32' }],
    },
    infoAnchor: 'pyth-numeraire-feed-id',
    hasNumericRange: false,
  },

  // ─── Rewards & Staking (cross-chain interest aggregation) ────────

  {
    id: 'rewardGraceSeconds',
    label: 'Reward grace window',
    short:
      'Window after a day closes during which finalizeDay can be called even if a mirror is missing.',
    category: 'rewards',
    unit: 'seconds',
    hardMin: '300', // 5 min
    hardMax: '2592000', // 30 days
    safeMin: '3600', // 1h
    safeMax: '86400', // 24h
    midMin: '600', // 10 min
    midMax: '604800', // 7 days
    getter: {
      facet: 'RewardReporterFacet',
      fn: 'getRewardGraceSeconds',
      returns: 'uint64',
    },
    setter: {
      facet: 'RewardReporterFacet',
      fn: 'setRewardGraceSeconds',
      args: [{ name: 'secondsValue', type: 'uint64' }],
    },
    infoAnchor: 'reward-grace-seconds',
    hasNumericRange: true,
  },
  {
    id: 'interactionCapVpfiPerEth',
    label: 'Interaction-rewards cap',
    short:
      'Per-day VPFI payout ceiling per ETH of eligible interest. 0=default, max-uint=disabled.',
    category: 'rewards',
    unit: 'wholeNumber',
    hardMin: '1',
    hardMax: '1000000',
    safeMin: '100',
    safeMax: '5000',
    midMin: '1',
    midMax: '50000',
    getter: {
      facet: 'InteractionRewardsFacet',
      fn: 'getInteractionCapVpfiPerEth',
      returns: 'uint256',
    },
    setter: {
      facet: 'InteractionRewardsFacet',
      fn: 'setInteractionCapVpfiPerEth',
      args: [{ name: 'value', type: 'uint256' }],
    },
    infoAnchor: 'interaction-rewards-cap-vpfi-per-eth',
    hasNumericRange: true,
  },

  // ─── Cross-chain VPFI buy (T-031 Layer 4a) ───────────────────────

  {
    id: 'reconciliationWatchdogEnabled',
    label: 'Reconciliation watchdog',
    short:
      'Master switch for the off-chain cross-chain buy-flow reconciliation watchdog. Off = no alerts.',
    category: 'crossChain',
    unit: 'bool',
    hardMin: '0',
    hardMax: '1',
    safeMin: '1',
    safeMax: '1',
    midMin: '0',
    midMax: '1',
    getter: {
      facet: 'VPFIBuyReceiver',
      fn: 'reconciliationWatchdogEnabled',
      returns: 'bool',
    },
    setter: {
      facet: 'VPFIBuyReceiver',
      fn: 'setReconciliationWatchdogEnabled',
      args: [{ name: 'enabled', type: 'bool' }],
    },
    infoAnchor: 'reconciliation-watchdog-enabled-flag-reconciliationwatchdogenabled',
    hasNumericRange: false,
  },

  // ─── Range Orders Phase 1 ────────────────────────────────────────

  {
    id: 'rangeAmountEnabled',
    label: 'Range Orders — amount range',
    short:
      'Master flag. When false, OfferFacet rejects amount-range writes (single-amount only).',
    category: 'rangeOrders',
    unit: 'bool',
    hardMin: '0',
    hardMax: '1',
    safeMin: '0',
    safeMax: '1',
    midMin: '0',
    midMax: '1',
    getter: { facet: 'ConfigFacet', fn: 'getRangeAmountEnabled', returns: 'bool' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setRangeAmountEnabled',
      args: [{ name: 'enabled', type: 'bool' }],
    },
    infoAnchor: 'range-orders-kill-switch-flags-rangeamountenabled-rangerateenabled-partialfillenabled',
    hasNumericRange: false,
  },
  {
    id: 'rangeRateEnabled',
    label: 'Range Orders — rate range',
    short:
      'Master flag. When false, OfferFacet rejects interestRate-range writes.',
    category: 'rangeOrders',
    unit: 'bool',
    hardMin: '0',
    hardMax: '1',
    safeMin: '0',
    safeMax: '1',
    midMin: '0',
    midMax: '1',
    getter: { facet: 'ConfigFacet', fn: 'getRangeRateEnabled', returns: 'bool' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setRangeRateEnabled',
      args: [{ name: 'enabled', type: 'bool' }],
    },
    infoAnchor: 'range-orders-kill-switch-flags-rangeamountenabled-rangerateenabled-partialfillenabled',
    hasNumericRange: false,
  },
  {
    id: 'partialFillEnabled',
    label: 'Range Orders — partial fills',
    short:
      'Master flag. When false, lender offers must be filled in a single match.',
    category: 'rangeOrders',
    unit: 'bool',
    hardMin: '0',
    hardMax: '1',
    safeMin: '0',
    safeMax: '1',
    midMin: '0',
    midMax: '1',
    getter: { facet: 'ConfigFacet', fn: 'getPartialFillEnabled', returns: 'bool' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setPartialFillEnabled',
      args: [{ name: 'enabled', type: 'bool' }],
    },
    infoAnchor: 'range-orders-kill-switch-flags-rangeamountenabled-rangerateenabled-partialfillenabled',
    hasNumericRange: false,
  },

  // ─── T-034 — Periodic Interest Payment ───────────────────────────

  {
    id: 'periodicInterestEnabled',
    label: 'Periodic Interest — master switch',
    short:
      'Master flag. When false, OfferFacet rejects any non-None cadence and the entire feature is dormant.',
    category: 'periodicInterest',
    unit: 'bool',
    hardMin: '0',
    hardMax: '1',
    safeMin: '0',
    safeMax: '1',
    midMin: '0',
    midMax: '1',
    getter: { facet: 'ConfigFacet', fn: 'getPeriodicInterestEnabled', returns: 'bool' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setPeriodicInterestEnabled',
      args: [{ name: 'enabled', type: 'bool' }],
    },
    infoAnchor: 'periodic-interest-payment-kill-switches',
    hasNumericRange: false,
  },
  {
    id: 'numeraireSwapEnabled',
    label: 'Numeraire — cross-numeraire swap',
    short:
      'Independent flag gating setNumeraire. When false, governance cannot rotate the numeraire away from USD-as-default.',
    category: 'periodicInterest',
    unit: 'bool',
    hardMin: '0',
    hardMax: '1',
    safeMin: '0',
    safeMax: '1',
    midMin: '0',
    midMax: '1',
    getter: { facet: 'ConfigFacet', fn: 'getNumeraireSwapEnabled', returns: 'bool' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setNumeraireSwapEnabled',
      args: [{ name: 'enabled', type: 'bool' }],
    },
    infoAnchor: 'periodic-interest-payment-kill-switches',
    hasNumericRange: false,
  },
  {
    id: 'numeraireSymbol',
    label: 'Numeraire — symbol (lowercase ASCII)',
    short:
      'bytes32 lowercase symbol of the active numeraire (e.g. "usd", "eur", "xau"). Drives Tellor/API3/DIA secondary-oracle query construction. Empty = default "usd".',
    category: 'periodicInterest',
    unit: 'bytes32',
    hardMin: '0',
    hardMax: '0',
    safeMin: '0',
    safeMax: '0',
    midMin: '0',
    midMax: '0',
    getter: { facet: 'ConfigFacet', fn: 'getNumeraireSymbol', returns: 'bytes32' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setNumeraire',
      args: [
        { name: 'ethNumeraireFeed', type: 'address' },
        { name: 'numeraireChainlinkDenominator', type: 'address' },
        { name: 'numeraireSymbol', type: 'bytes32' },
        { name: 'pythCrossCheckFeedId', type: 'bytes32' },
        { name: 'newThresholdInNewNumeraire', type: 'uint256' },
        { name: 'newNotificationFeeInNewNumeraire', type: 'uint256' },
        { name: 'newKycTier0InNewNumeraire', type: 'uint256' },
        { name: 'newKycTier1InNewNumeraire', type: 'uint256' },
      ],
    },
    infoAnchor: 'periodic-interest-payment-numeraire-abstraction',
    hasNumericRange: false,
  },
  {
    id: 'ethNumeraireFeed',
    label: 'Numeraire — ETH/<numeraire> Chainlink feed',
    short:
      'Chainlink AggregatorV3 returning ETH price quoted in the active numeraire. ETH/USD on USD-as-numeraire deploys; rotates to ETH/EUR / ETH/XAU / etc. when governance flips the numeraire.',
    category: 'periodicInterest',
    unit: 'address',
    hardMin: '0',
    hardMax: '0',
    safeMin: '0',
    safeMax: '0',
    midMin: '0',
    midMax: '0',
    getter: { facet: 'ConfigFacet', fn: 'getEthNumeraireFeed', returns: 'address' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setNumeraire',
      args: [
        { name: 'ethNumeraireFeed', type: 'address' },
        { name: 'numeraireChainlinkDenominator', type: 'address' },
        { name: 'numeraireSymbol', type: 'bytes32' },
        { name: 'pythCrossCheckFeedId', type: 'bytes32' },
        { name: 'newThresholdInNewNumeraire', type: 'uint256' },
        { name: 'newNotificationFeeInNewNumeraire', type: 'uint256' },
        { name: 'newKycTier0InNewNumeraire', type: 'uint256' },
        { name: 'newKycTier1InNewNumeraire', type: 'uint256' },
      ],
    },
    infoAnchor: 'periodic-interest-payment-numeraire-abstraction',
    hasNumericRange: false,
  },
  {
    id: 'minPrincipalForFinerCadence',
    label: 'Periodic Interest — finer-cadence threshold',
    short:
      'Principal threshold for opting into finer-than-mandatory cadence. In numeraire-units (1e18-scaled). Default $100k.',
    category: 'periodicInterest',
    unit: 'usd1e18',
    hardMin: '1000000000000000000000', // 1_000 * 1e18
    hardMax: '10000000000000000000000000', // 10_000_000 * 1e18
    safeMin: '50000000000000000000000', // 50_000 * 1e18
    safeMax: '500000000000000000000000', // 500_000 * 1e18
    midMin: '10000000000000000000000', // 10_000 * 1e18
    midMax: '2000000000000000000000000', // 2_000_000 * 1e18
    getter: {
      facet: 'ConfigFacet',
      fn: 'getMinPrincipalForFinerCadence',
      returns: 'uint256',
    },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setMinPrincipalForFinerCadence',
      args: [{ name: 'newThreshold', type: 'uint256' }],
    },
    defaultFallback: '100000000000000000000000', // 100_000 * 1e18
    infoAnchor: 'periodic-interest-payment-threshold',
    hasNumericRange: true,
  },
  {
    id: 'preNotifyDays',
    label: 'Pre-notify lead time (days)',
    short:
      'Days the off-chain watcher fires push notifications before maturity AND each periodic-interest checkpoint.',
    category: 'periodicInterest',
    unit: 'wholeNumber',
    hardMin: '1',
    hardMax: '14',
    safeMin: '2',
    safeMax: '5',
    midMin: '1',
    midMax: '7',
    getter: { facet: 'ConfigFacet', fn: 'getPreNotifyDays', returns: 'uint8' },
    setter: {
      facet: 'ConfigFacet',
      fn: 'setPreNotifyDays',
      args: [{ name: 'newDays', type: 'uint8' }],
    },
    defaultFallback: '3',
    infoAnchor: 'periodic-interest-payment-pre-notify',
    hasNumericRange: true,
  },
];

/** Order in which categories appear on the dashboard. */
export const KNOB_CATEGORY_ORDER: KnobCategory[] = [
  'fees',
  'risk',
  'oracle',
  'crossChain',
  'rewards',
  'rangeOrders',
  'periodicInterest',
  'matching',
  'kyc',
];

/** Display labels per category. Translated via i18n; this is the
 *  English fallback. */
export const KNOB_CATEGORY_LABELS: Record<KnobCategory, string> = {
  fees: 'Fees & Protocol Economics',
  risk: 'Risk Parameters',
  oracle: 'Oracle Stack',
  crossChain: 'Cross-Chain',
  rewards: 'Rewards & Staking',
  rangeOrders: 'Range Orders Flags',
  periodicInterest: 'Periodic Interest Payment',
  matching: 'Order Matching',
  kyc: 'KYC / Sanctions',
};

/**
 * Group the catalogue by category, preserving the in-array order
 * within each category for stable dashboard rendering.
 */
export function knobsByCategory(): Record<KnobCategory, KnobMeta[]> {
  const out: Partial<Record<KnobCategory, KnobMeta[]>> = {};
  for (const knob of ADMIN_KNOBS) {
    if (!out[knob.category]) out[knob.category] = [];
    out[knob.category]!.push(knob);
  }
  // Ensure every category has an array even if empty (simplifies
  // dashboard rendering).
  for (const cat of KNOB_CATEGORY_ORDER) {
    if (!out[cat]) out[cat] = [];
  }
  return out as Record<KnobCategory, KnobMeta[]>;
}

/**
 * Build the deep-link URL from a knob id to the corresponding section
 * in the in-app rendering of the runbook. Wires the info-icon click
 * target on each card.
 */
export function knobInfoUrl(knob: KnobMeta, locale: string): string {
  const base = locale === 'en' ? '/admin/docs' : `/${locale}/admin/docs`;
  return `${base}#${knob.infoAnchor}`;
}

/**
 * Classify a numeric value into one of the three coloured zones
 * relative to the knob's hard bound + soft zones. Used by the
 * dashboard to render the marker colour + the surrounding rail.
 *
 * Returns `safe` / `mid` / `caution`. Caller renders accordingly.
 */
export type KnobZone = 'safe' | 'mid' | 'caution';

export function classifyValue(knob: KnobMeta, value: bigint): KnobZone {
  const safeMin = BigInt(knob.safeMin);
  const safeMax = BigInt(knob.safeMax);
  const midMin = BigInt(knob.midMin);
  const midMax = BigInt(knob.midMax);
  if (value >= safeMin && value <= safeMax) return 'safe';
  if (value >= midMin && value <= midMax) return 'mid';
  return 'caution';
}
