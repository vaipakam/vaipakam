// src/libraries/LibVaipakam.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
// Numeraire generalization (B1) (T-047 prep): the INumeraireOracle interface that
// Phase 1+2 introduced for numeraire→USD boundary conversion is no
// longer needed — `OracleFacet.getAssetPrice` now returns numeraire-
// quoted prices directly via the renamed Chainlink slots
// (ethNumeraireFeed, numeraireChainlinkDenominator, numeraireSymbol).
// All comparison sites now compare numeraire-vs-numeraire, so the
// boundary conversion that lived in `_convertNumeraireToUsd` /
// `getKycTier{0,1}Threshold` is removed.

/**
 * @title LibVaipakam
 * @author Vaipakam Developer Team
 * @notice This library provides shared storage and data structures for the Vaipakam P2P lending platform.
 * @dev Used in the Diamond Standard (EIP-2535) to manage global state across facets.
 *      Storage is accessed via a specific slot to avoid collisions.
 *      Includes enums for asset types, liquidity, offer types, and loan statuses.
 *      Structs for Offers and Loans store key details.
 *      The Storage struct holds mappings and counters for offers, loans, escrows, and asset liquidity.
 *      No functions beyond storage access; all logic in facets.
 *      Expand for future phases (e.g., cross-chain, governance).
 *
 * @dev ─── Protocol-wide rounding convention ────────────────────────────
 *      All financial math uses Solidity's default integer division
 *      (rounds toward zero). Per formula, the direction is chosen so
 *      every wei of discrepancy favours a safe party. Per-site
 *      comments (`// Rounds DOWN — ...`) state the rationale at each
 *      division. Summary:
 *      - **LTV**: rounds DOWN → 1-BPS *under*-reported → borrower
 *        favour, sub-dust absolute error, acceptable.
 *      - **Health Factor**: rounds DOWN → slightly under-reported →
 *        protocol favour (liquidation may trigger marginally earlier).
 *      - **Interest accrual (simple)**: rounds DOWN on
 *        `(principal * rateBps * elapsed) / (SECONDS_PER_YEAR *
 *        BASIS_POINTS)` → borrower favour by <=1 wei (standard
 *        simple-interest convention).
 *      - **Reward split per user per day**: rounds DOWN on
 *        `(halfPool * userInterest) / chainTotal` → sum-of-shares <=
 *        half-pool, dust retained as over-emission guard.
 *      - **Liquidation bonus**: rounds DOWN on `(proceeds * bps) /
 *        10000` → bonus under-paid by <=1 wei (treasury favour).
 *      - **Oracle USD conversion**: `amount * price / 10**feedDec /
 *        10**tokenDec` — two sequential divides; error stays sub-dust
 *        because USD values are 1e18-scaled.
 *
 *      New division on a money path MUST state direction + who it
 *      favours + why it's safe. `ceilDiv` is reserved for cases where
 *      rounding down is actively dangerous (none currently).
 */
library LibVaipakam {
    /// @dev ERC-7201 namespaced storage slot for Vaipakam's global state.
    ///      Derived from: keccak256(abi.encode(uint256(keccak256("vaipakam.storage")) - 1)) & ~bytes32(uint256(0xff))
    ///      The `-1` and `& ~0xff` guard against collisions with Solidity's standard
    ///      storage layout (slot 0 for plain vars, `keccak256(key . pos)` for mappings).
    bytes32 internal constant VANGKI_STORAGE_POSITION =
        0x76f6f3ffb4e1cbadb2d289330bfeb7bd9d50e6e2407a61733161f6e3e1d10e00;

    // Constants (configurable via governance in Phase 2)
    uint256 constant MIN_HEALTH_FACTOR = 150 * 1e16; // 1.5 scaled to 1e18
    uint256 constant TREASURY_FEE_BPS = 100; // 1% of interest
    uint256 constant BASIS_POINTS = 10000;
    uint256 constant HF_SCALE = 1e18; // Health Factor precision
    uint256 constant HF_LIQUIDATION_THRESHOLD = 1e18; // HF < 1 for liquidation
    uint256 constant SECONDS_PER_YEAR = 365 days;
    uint256 constant DAYS_PER_YEAR = 365;
    uint256 constant ONE_DAY = 1 days;
    // $1M pool-depth floor for classifying an asset as Liquid. Expressed
    // in the units produced by the WETH-referenced heuristic in
    // {OracleFacet._checkLiquidityWithConfig}: `poolLiquidity * ethPrice /
    // 10**ethFeedDecimals`, where `ethPrice` is the 8-decimal Chainlink
    // ETH/USD answer. The constant is an empirical floor, not a strict
    // dollar unit — it is calibrated against asset/WETH 0.3% v3-style AMM
    // pools on target deployments and tuned via ops if coverage shifts.
    uint256 constant MIN_LIQUIDITY_USD = 1_000_000 * 1e6;
    uint256 constant LTV_SCALE = 10000; // Basis points (e.g., 7500 = 75%)
    uint256 constant RENTAL_BUFFER_BPS = 500; // 5% buffer for NFT rentals
    uint256 constant VOLATILITY_LTV_THRESHOLD_BPS = 11000; // 110% LTV for fallback (1.1x loan value)
    uint256 constant MAX_LIQUIDATION_SLIPPAGE_BPS = 600; // 6% max slippage on DEX liquidation swaps (README §7)
    uint256 constant MAX_LIQUIDATOR_INCENTIVE_BPS = 300; // 3% cap on dynamic liquidator incentive (README §3)
    uint256 constant LIQUIDATION_HANDLING_FEE_BPS = 200; // 2% of proceeds to treasury on successful DEX liquidation (README §3)
    uint256 constant LOAN_INITIATION_FEE_BPS = 10; // 0.1% fee deducted from ERC-20 principal at loan initiation (README §6 lines 280, 332)
    // Fallback-path split (README §7): lender gets principal + accrued
    // interest + {FALLBACK_LENDER_BONUS_BPS} of principal; treasury gets
    // {FALLBACK_TREASURY_BPS} of principal; borrower gets the remainder.
    // Both are governance-configurable via {ConfigFacet.setFallbackSplit},
    // applied prospectively — each Loan snapshots the effective values at
    // `initiateLoan` so the dual-consent contract at offer creation is
    // never retroactively altered. Stored zero ⇒ use these defaults.
    uint256 constant FALLBACK_LENDER_BONUS_BPS = 300; // 3% lender bonus on fallback path
    uint256 constant FALLBACK_TREASURY_BPS = 200; // 2% treasury cut on fallback path
    // ─── Range Orders Phase 1 constants (docs/RangeOffersDesign.md) ─────
    // Cancel cooldown: when an offer has zero matches against it
    // (`amountFilled == 0`), `cancelOffer` reverts until this many seconds
    // after `Offer.createdAt`. Blunts the cancel-front-run attack on the
    // matching path (§9.2 of the design). Partial-filled offers can be
    // cancelled immediately because the lender has already committed value.
    uint256 constant MIN_OFFER_CANCEL_DELAY = 5 minutes;
    // Loan duration cap defaults + bounds (Findings 00025).
    // ProjectDetailsREADME §2 mandates `1 ≤ durationDays ≤ 365` with
    // on-chain enforcement so external callers cannot bypass the
    // frontend validation. Default is 365 days; admin can re-tune via
    // `ConfigFacet.setMaxOfferDurationDays(uint16)` within the
    // [floor, ceil] bounds below. The floor prevents an accidental
    // "1 day max" lockout (a bricked governance call that locks every
    // user out of placing a meaningful offer); the ceiling caps how
    // far governance can stretch the interest formula
    // `principal × rate × days / 365` before its accuracy degrades
    // for multi-year loans. Lower bound at offer creation is the
    // existing `durationDays == 0 → InvalidOfferType` check (so the
    // minimum loan duration is 1 day; that's not governance-tunable).
    uint16 constant MAX_OFFER_DURATION_DAYS_DEFAULT = 365;
    uint16 constant MIN_OFFER_DURATION_DAYS_FLOOR = 7;
    uint16 constant MAX_OFFER_DURATION_DAYS_CEIL = 4385; // 12+ years
    // Matcher fee, in BPS of LIF: when LIF flows to treasury, this
    // fraction kicks to `msg.sender` of the matching call (whoever
    // submitted `matchOffers` / `acceptOffer` / preclose-offset /
    // refinance). 1% of LIF — symbolic on L2s where gas is cheap;
    // establishes the seam for Phase 2 to dial up if community bots
    // need stronger incentives.
    uint256 constant LIF_MATCHER_FEE_BPS = 100;

    /// @dev Auto-pause defaults + bounds (Phase 1 follow-up). Default
    ///      30 min: long enough for human incident-response, short
    ///      enough that a false-positive doesn't strand users. Floor
    ///      5 min so admin can't stealth-disable by setting to ~0.
    ///      Ceiling 2 hours so a compromised watcher's worst case is
    ///      a 2-hour freeze (admin can short-circuit via `unpause()`).
    uint256 constant AUTO_PAUSE_DURATION_DEFAULT = 1800; // 30 min
    uint256 constant MIN_AUTO_PAUSE_SECONDS = 300; // 5 min
    uint256 constant MAX_AUTO_PAUSE_SECONDS = 7200; // 2 hours

    /// @dev T-032 / Numeraire generalization (B1) — Notification fee (per loan-side)
    ///      defaults + bounds. Charged in VPFI, denominated in the
    ///      ACTIVE NUMERAIRE (1e18-scaled — USD by post-deploy default;
    ///      whatever governance has rotated to otherwise), deducted on
    ///      first paid-tier notification fired by the off-chain
    ///      hf-watcher. Default 2.0 numeraire-units covers Push
    ///      Protocol channel-side delivery costs at the operator's
    ///      expected notification volumes (~5-10 notifications per
    ///      loan lifetime). Floor 0.1 prevents governance accidentally
    ///      setting it to ~0 and starving the channel; ceiling 50.0
    ///      caps the worst-case bill on a per-loan basis if governance
    ///      misfires upward.
    ///
    ///      The numeraire-quoted fee converts to VPFI via the
    ///      ETH/numeraire price returned by `OracleFacet.getAssetPrice(WETH)`
    ///      (anchored at the oracle layer post-B1) times the fixed
    ///      `VPFI_PER_ETH_FIXED_PHASE1` rate. No USD-intermediate is
    ///      involved — the fee storage value, the oracle return, and
    ///      the resulting math are all in the active numeraire end to
    ///      end. Atomic multi-arg `setNumeraire` in `ConfigFacet` keeps
    ///      this in lockstep with the threshold and KYC tiers when
    ///      governance rotates.
    uint256 constant NOTIFICATION_FEE_DEFAULT = 2 * 1e18;
    uint256 constant MIN_NOTIFICATION_FEE_FLOOR = 1e17; // 0.1 numeraire-units
    uint256 constant MAX_NOTIFICATION_FEE_CEIL = 50 * 1e18; // 50 numeraire-units

    /// @dev T-032 — Phase 1 fixed VPFI/ETH rate. VPFI doesn't have a
    ///      real market price yet; the fee math is anchored to
    ///      ETH/numeraire times this fixed rate so VPFI gets a
    ///      synthetic numeraire quote without needing a tradable VPFI
    ///      market:
    ///        `vpfiAmount = feeNumeraire
    ///                       / (ethPriceNumeraire × VPFI_PER_ETH_FIXED_PHASE1)`
    ///      where `VPFI_PER_ETH_FIXED_PHASE1 = 1e15` (1 VPFI = 0.001
    ///      ETH, both 18-dec). The constant is unit-agnostic — it
    ///      describes the VPFI-to-ETH peg, independent of the active
    ///      numeraire. When VPFI lists on an exchange (Phase 2),
    ///      governance can replace this fixed rate with a live
    ///      VPFI/numeraire feed without needing the USD intermediate
    ///      that the pre-B1 design carried.
    uint256 constant VPFI_PER_ETH_FIXED_PHASE1 = 1e15;
    // Sanity ceiling on `interestRateBpsMax` at offer creation. Below
    // 100% APR equivalent (10000 bps). Tighter would risk rejecting
    // legitimate distressed-borrower offers; higher would let pranks
    // / typo-grade offers spam the book.
    uint256 constant MAX_INTEREST_BPS = 10_000;

    // ─── T-034 — Periodic Interest Payment defaults + bounds ─────────────
    // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md.
    //
    // Cadence interval lookup table (in days). The `intervalDays` library
    // helper returns these for the four non-`None` cadences. None → 0.
    uint256 constant PERIODIC_INTERVAL_MONTHLY_DAYS = 30;
    uint256 constant PERIODIC_INTERVAL_QUARTERLY_DAYS = 90;
    uint256 constant PERIODIC_INTERVAL_SEMI_ANNUAL_DAYS = 180;
    uint256 constant PERIODIC_INTERVAL_ANNUAL_DAYS = 365;

    // Pre-notify lead time. Single knob shared between the maturity
    // pre-notify lane and the new periodic-checkpoint pre-notify lane in
    // the off-chain hf-watcher. Range narrow on purpose: <1 day misses
    // weekend-buffer; >14 days creates noise that trains users to ignore
    // the alert. Default 3 mirrors the existing maturity-warning cadence.
    uint8 constant PERIODIC_PRE_NOTIFY_DAYS_DEFAULT = 3;
    uint8 constant PERIODIC_PRE_NOTIFY_DAYS_FLOOR = 1;
    uint8 constant PERIODIC_PRE_NOTIFY_DAYS_CEIL = 14;

    // Principal threshold above which the lender can opt the loan into a
    // finer-than-mandatory cadence (Monthly / Quarterly / SemiAnnual on
    // any duration; finer-than-Annual on multi-year). Denominated in
    // numeraire-units (1e18-scaled). Default $100k under USD-as-
    // numeraire (post-deploy default; B1 — read from Chainlink ETH/USD
    // via `ethNumeraireFeed`). Floor $1k stops a
    // misconfigured "everyone qualifies" setting; ceiling $10M caps the
    // worst-case "nobody qualifies" misfire.
    uint256 constant PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT = 100_000 * 1e18;
    uint256 constant PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR = 1_000 * 1e18;
    uint256 constant PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL = 10_000_000 * 1e18;

    uint256 constant KYC_TIER0_THRESHOLD_NUMERAIRE = 1_000 * 1e18; // Tier0 max
    uint256 constant KYC_TIER1_THRESHOLD_NUMERAIRE = 10_000 * 1e18; // Tier1 max
    uint256 constant MAX_FEE_EVENTS_ITER = 10_000; // Max feeEventsLog entries scanned per window query in MetricsFacet
    uint256 constant SEQUENCER_GRACE_PERIOD = 3600; // 1h post-recovery grace on L2s before prices are trusted again

    // ─── T-044 — duration-tiered loan-default grace bounds ───────────────
    // The grace period applied between a loan's `endTime` and the moment
    // {DefaultedFacet.markDefaulted} can fire is a function of the loan's
    // original `durationDays`. Short loans get a short grace; long loans
    // get a longer one. Both the bucket threshold (`maxDurationDays`)
    // AND the per-bucket grace (`graceSeconds`) are admin-configurable
    // via {ConfigFacet.setGraceBuckets}, with `gracePeriod()` falling back
    // to the compile-time default schedule when storage is empty.
    //
    // **Schedule shape — fixed 6-slot positional table**:
    // The schedule is exactly 6 slots; admin can edit the values inside
    // each slot but cannot add or remove rows. Each slot carries its own
    // hard bounds for BOTH the duration threshold and the grace period
    // (see {graceSlotBounds}). This gives operators the flexibility to
    // tune values within sensible per-slot windows — a < 7 day bucket
    // can never be set to a 90-day grace, a < 365 day bucket can never
    // be flipped down to a 1-hour grace.
    //
    // Slot 5 is the catch-all (`maxDurationDays == 0`); it covers any
    // loan duration above slot 4's threshold and is governed only by its
    // own grace bounds (no duration ceiling).
    //
    // Defended against compromised-admin attacks the same way every other
    // governance setter is (see T-033) — every value is range-checked at
    // the setter and the bounds themselves are compile-time constants.
    uint256 constant GRACE_BUCKETS_FIXED_COUNT = 6;
    // Absolute floor / ceiling — every per-slot bound below stays inside
    // these. Belt-and-braces guard against a future per-slot-bound bump
    // that accidentally breaks the global invariants (TZ tolerance + max
    // lender lock-up).
    uint256 constant GRACE_SECONDS_MIN = 1 hours;
    uint256 constant GRACE_SECONDS_MAX = 90 days;

    // ─── Chainlink staleness thresholds (stable-peg-aware hybrid) ───────
    // Volatile feeds (ETH/BTC/etc.-USD) publish on a 1h heartbeat + 0.5%
    // deviation trigger. Stable / fiat / commodity feeds (USDC, EUR/USD,
    // JPY/USD, XAU/USD) publish on a 24h heartbeat + small deviation —
    // they commonly go a full day without an update because the price is
    // pinned to its reference. OracleFacet.getAssetPrice enforces a
    // two-tier staleness rule:
    //   age <= ORACLE_VOLATILE_STALENESS                              → accept
    //   age <= ORACLE_STABLE_STALENESS AND feed reports within peg    → accept
    //   otherwise                                                     → revert
    //
    // The stable-path check uses the SAME `answer` already read (no
    // extra feed call) and is gated on `feed.decimals() == 8` so only
    // 8-decimal USD-quoted feeds qualify — an asset/ETH feed that
    // happens to report 1e18 is not misclassified.
    //
    // "Within peg" = within ORACLE_PEG_TOLERANCE_BPS of either
    //   (a) the implicit USD $1 peg (ORACLE_USD_PEG_1E8), or
    //   (b) any registered non-USD peg in `stableFeedBySymbol` (EUR/JPY/
    //       XAU/etc.) whose reference feed is itself within
    //       ORACLE_STABLE_STALENESS. Fiat/commodity reference feeds are
    //       themselves on 24h heartbeats, so we cannot force a 2h
    //       freshness requirement on them — we reuse the stable ceiling.
    uint256 constant ORACLE_VOLATILE_STALENESS = 2 hours;
    uint256 constant ORACLE_STABLE_STALENESS = 25 hours;
    uint256 constant ORACLE_PEG_TOLERANCE_BPS = 300; // 3%
    int256 constant ORACLE_USD_PEG_1E8 = 1e8; // $1 scaled to 8 decimals

    // ─── VPFI Discount Tier Table (docs/TokenomicsTechSpec.md §6) ────────
    // Tiered fee discount gated purely by the user's escrow VPFI balance.
    // A single platform-level consent flag (vpfiDiscountConsent) governs
    // both borrower Loan Initiation Fee and lender Yield Fee discounts.
    // Tier resolution is a pure balance check — no Chainlink dependency —
    // so the tier gate is deterministic and cheap to compute.
    //
    // Tier | Escrow VPFI range       | Discount | Lender Yield | Borrower Init
    //   0  | < 100                   |     0%   |       1%     |        0.1%
    //   1  | 100 ≤ x < 1,000         |    10%   |     0.9%     |       0.09%
    //   2  | 1,000 ≤ x < 5,000       |    15%   |    0.85%     |      0.085%
    //   3  | 5,000 ≤ x ≤ 20,000      |    20%   |     0.8%     |       0.08%  (20k inclusive)
    //   4  |       x > 20,000        |    24%   |    0.76%     |      0.076%
    //
    // Discount BPS are applied to the NORMAL fee:
    //   effectiveFeeBps = normalFeeBps * (BASIS_POINTS - tierDiscountBps) / BASIS_POINTS
    //
    // Boundary semantics matter at the T3/T4 split: exactly 20,000 VPFI is
    // T3 (not T4), so the check is strictly `> 20_000e18` for T4.
    uint256 constant VPFI_TIER1_MIN = 100 * 1e18; // T1 starts at ≥ 100
    uint256 constant VPFI_TIER2_MIN = 1_000 * 1e18; // T2 starts at ≥ 1,000
    uint256 constant VPFI_TIER3_MIN = 5_000 * 1e18; // T3 starts at ≥ 5,000
    uint256 constant VPFI_TIER4_THRESHOLD = 20_000 * 1e18; // T4 starts strictly ABOVE this
    uint256 constant VPFI_TIER1_DISCOUNT_BPS = 1000; // 10%
    uint256 constant VPFI_TIER2_DISCOUNT_BPS = 1500; // 15%
    uint256 constant VPFI_TIER3_DISCOUNT_BPS = 2000; // 20%
    uint256 constant VPFI_TIER4_DISCOUNT_BPS = 2400; // 24%

    uint256 constant VPFI_FIXED_RATE_DEFAULT_WEI_PER_VPFI = 1e15; // 1 VPFI = 0.001 ETH
    uint256 constant VPFI_FIXED_GLOBAL_CAP = 2_300_000 * 1e18; // 2.3M VPFI pool (spec §8)
    uint256 constant VPFI_FIXED_WALLET_CAP = 30_000 * 1e18; // 30k VPFI per wallet (spec §8)

    // ─── VPFI Reward Pools (docs/TokenomicsTechSpec.md §3, §4, §7) ───────
    // Hard caps on each Phase-1 emission category. The diamond pays
    // claims from its own VPFI balance; a cumulative paid-out counter
    // enforces these caps at claim time.
    uint256 constant VPFI_STAKING_POOL_CAP = 55_200_000 * 1e18; // 24% of supply
    uint256 constant VPFI_INTERACTION_POOL_CAP = 69_000_000 * 1e18; // 30% of supply
    // Reward base for interaction daily pool — multiplied by the
    // schedule's annualRate and `dt / 365` to size each day's emission.
    uint256 constant VPFI_INITIAL_MINT = 23_000_000 * 1e18;
    // APR paid on escrow-held VPFI (spec §7). In BPS, applied as
    //   increment_1e18 = APR_BPS * 1e18 * dt / (BASIS_POINTS * SECONDS_PER_YEAR)
    uint256 constant VPFI_STAKING_APR_BPS = 500; // 5%
    // Max days walked in a single claimInteractionRewards() call — bounds
    // gas cost for long-dormant users without denying access.
    uint256 constant MAX_INTERACTION_CLAIM_DAYS = 30;
    // Default per-user daily cap on platform-interaction reward payouts
    // (docs/TokenomicsTechSpec.md §4). Expressed as "whole VPFI per 1 ETH
    // of eligible interest" — 500 ≡ 0.5 VPFI per 0.001 ETH. Applied
    // independently on the lender and borrower sides each day. The
    // effective cap is admin-configurable via
    // {InteractionRewardsFacet.setInteractionCapVpfiPerEth}; a stored
    // zero falls back to this constant (see {getInteractionCapVpfiPerEth}).
    uint256 constant INTERACTION_CAP_DEFAULT_VPFI_PER_ETH = 500;

    event TreasurySet(address indexed newTreasury);

    // Shared errors consolidated in IVaipakamErrors.sol

    /**
     * @notice Enum for supported asset types.
     * @dev ERC20 for tokens, NFT721 for unique NFTs, NFT1155 for semi-fungible NFTs.
     */
    enum AssetType {
        ERC20,
        ERC721,
        ERC1155
    }

    /**
     * @notice Enum for asset liquidity status.
     * @dev Liquid if Chainlink feed and DEX pool exist; Illiquid otherwise (includes all NFTs).
     */
    enum LiquidityStatus {
        Liquid,
        Illiquid
    }

    /**
     * @notice Enum for offer types.
     * @dev Lender offers to lend, Borrower requests to borrow.
     */
    enum OfferType {
        Lender,
        Borrower
    }

    /**
     * @notice T-034 — cadence at which the borrower must settle accrued
     *         interest during the loan's lifetime.
     * @dev `None` is today's behavior — terminal-only repayment. The four
     *      finer values correspond to fixed intervals (30 / 90 / 180 /
     *      365 days). For loans with `durationDays > 365` the contract
     *      enforces a minimum cadence of `Annual`. For all loans, the
     *      cadence interval must be strictly less than `durationDays`
     *      (a cadence whose first checkpoint lands at or after maturity
     *      is meaningless). For loans where either side is illiquid,
     *      cadence MUST be `None` (the auto-liquidate path requires
     *      both assets to be DEX-swappable). See
     *      docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3.
     *      Lookup helper: `intervalDays(cadence)` returns the matching
     *      day count or 0 for `None`.
     */
    enum PeriodicInterestCadence {
        None,
        Monthly,
        Quarterly,
        SemiAnnual,
        Annual
    }

    /**
     * @notice Enum for loan statuses.
     * @dev Active during term, Repaid on successful closure, Defaulted on failure, Settled after both parties claim.
     */
    /**
     * @notice Loan lifecycle status.
     * @dev `FallbackPending` is the interim state entered when a DEX
     *      liquidation swap fails or would exceed the 6% slippage ceiling
     *      (README §§148-152, 298). In this state:
     *        - The lender may claim immediately (no borrower grace window).
     *        - The borrower may still cure by `addCollateral` (if HF/LTV
     *          is restored, the loan reverts to `Active` and the fallback
     *          snapshot is cancelled) or by `repayLoan` in full (loan
     *          transitions to `Repaid`, snapshot cancelled).
     *        - The borrower MAY NOT claim collateral until the lender
     *          claim finalizes and the status transitions to `Defaulted`.
     *      Once `claimAsLender` starts, it either retries the swap
     *      successfully (proceeds path) or falls back to the collateral
     *      split — either outcome sets the status to `Defaulted`.
     */
    enum LoanStatus {
        Active,
        Repaid,
        Defaulted,
        Settled,
        FallbackPending
    }

    /**
     * @notice NFT-position lifecycle status stamped on Vaipakam position NFTs.
     * @dev Distinct from `LoanStatus` because NFTs begin life as offer
     *      receipts (pre-loan) and outlive the loan through the claim phase.
     *      Stored on-chain as the enum; stringified only at `tokenURI()`.
     *      `None` is the default for uninitialized tokens — treat as
     *      equivalent to `OfferCreated` for rendering purposes.
     */
    enum LoanPositionStatus {
        None,
        OfferCreated,
        LoanInitiated,
        LoanRepaid,
        LoanDefaulted,
        LoanLiquidated,
        LoanClosed,
        LoanFallbackPending
    }

    /**
     * @notice Enum for KYC tier levels.
     * @dev Tier0 = no KYC, Tier1 = limited KYC, Tier2 = full KYC.
     */
    enum KYCTier {
        Tier0,
        Tier1,
        Tier2
    }

    /**
     * @notice Admin-configurable protocol parameters (read through the
     *         `cfg*` helpers below; written by {ConfigFacet}).
     * @dev Stored-zero semantics: every field treats `0` as "not set" and
     *      falls back to the corresponding `LibVaipakam` constant default.
     *      This preserves behaviour on freshly deployed diamonds that have
     *      not yet called any {ConfigFacet} setter and on diamonds
     *      upgraded in-place before {ConfigFacet.initializeConfig} runs.
     *
     *      Packing: the first 12 fields are `uint16` BPS values packed
     *      into a single storage slot (12 × 16 = 192 bits < 256). The
     *      four tier thresholds each occupy their own slot (they hold
     *      18-decimal VPFI balances that routinely exceed `uint128`).
     *
     *      Scope (user directive 2026-04-21): tunable = fees, VPFI tier
     *      table, LTV / liquidation risk knobs, rental buffer, staking
     *      APR. Kept immutable: tokenomics supply caps (`VPFI_*_CAP`,
     *      `VPFI_INITIAL_MINT`), `MIN_HEALTH_FACTOR`, fallback 3%/2%
     *      settlement split, `BASIS_POINTS` and other scale constants.
     */
    struct ProtocolConfig {
        // ── Packed BPS slot (14 × uint16 = 224 bits; 32 bits of headroom) ──
        uint16 treasuryFeeBps; // 0 ⇒ TREASURY_FEE_BPS (100)
        uint16 loanInitiationFeeBps; // 0 ⇒ LOAN_INITIATION_FEE_BPS (10)
        uint16 liquidationHandlingFeeBps; // 0 ⇒ LIQUIDATION_HANDLING_FEE_BPS (200)
        uint16 maxLiquidationSlippageBps; // 0 ⇒ MAX_LIQUIDATION_SLIPPAGE_BPS (600)
        uint16 maxLiquidatorIncentiveBps; // 0 ⇒ MAX_LIQUIDATOR_INCENTIVE_BPS (300)
        uint16 volatilityLtvThresholdBps; // 0 ⇒ VOLATILITY_LTV_THRESHOLD_BPS (11000)
        uint16 rentalBufferBps; // 0 ⇒ RENTAL_BUFFER_BPS (500)
        uint16 vpfiStakingAprBps; // 0 ⇒ VPFI_STAKING_APR_BPS (500)
        uint16 vpfiTier1DiscountBps; // 0 ⇒ VPFI_TIER1_DISCOUNT_BPS (1000)
        uint16 vpfiTier2DiscountBps; // 0 ⇒ VPFI_TIER2_DISCOUNT_BPS (1500)
        uint16 vpfiTier3DiscountBps; // 0 ⇒ VPFI_TIER3_DISCOUNT_BPS (2000)
        uint16 vpfiTier4DiscountBps; // 0 ⇒ VPFI_TIER4_DISCOUNT_BPS (2400)
        // Fallback-path split, governance-configurable. Prospective
        // semantics: `Loan.fallbackLenderBonusBpsAtInit` / `...TreasuryBpsAtInit`
        // are snapshotted at `initiateLoan`, so governance changes via
        // `setFallbackSplit` never retroactively alter dual-consent offers.
        uint16 fallbackLenderBonusBps; // 0 ⇒ FALLBACK_LENDER_BONUS_BPS (300)
        uint16 fallbackTreasuryBps; // 0 ⇒ FALLBACK_TREASURY_BPS (200)
        // Range Orders Phase 1: matcher's slice of the LIF that flows
        // to treasury at match-time (lender-asset path) or at terminal
        // (VPFI path). 0 ⇒ LIF_MATCHER_FEE_BPS (100 = 1%). Tunable so
        // governance can dial up to 5-10% if community bot operators
        // need a stronger incentive to compete (per the design plan's
        // "Match-fee economics revisit" Phase 2 item). Capped at
        // MAX_FEE_BPS (50%) by the setter.
        uint16 lifMatcherFeeBps; // 0 ⇒ LIF_MATCHER_FEE_BPS (100)
        // Auto-pause window (Phase 1 follow-up). Duration in seconds
        // for an off-chain anomaly-watcher's `autoPause()` to freeze
        // the protocol while humans investigate. 0 ⇒
        // AUTO_PAUSE_DURATION_DEFAULT (1800 = 30 min). Capped at
        // [MIN_AUTO_PAUSE_SECONDS, MAX_AUTO_PAUSE_SECONDS] by the
        // setter — floor prevents "set to 0" disable-by-stealth,
        // ceiling caps a compromised watcher's worst-case freeze.
        uint32 autoPauseDurationSeconds; // 0 ⇒ AUTO_PAUSE_DURATION_DEFAULT
        // Maximum offer durationDays (Findings 00025). 0 ⇒
        // MAX_OFFER_DURATION_DAYS_DEFAULT (365). Bounded at the setter
        // by [MIN_OFFER_DURATION_DAYS_FLOOR, MAX_OFFER_DURATION_DAYS_CEIL]
        // — floor prevents an accidental "1 day max" lockout, ceiling
        // caps how far governance can stretch the duration interest
        // formula's accuracy. Stored as uint16 so the slot stays
        // packed; the runtime read returns uint256 via `cfgMaxOfferDurationDays`.
        uint16 maxOfferDurationDays; // 0 ⇒ MAX_OFFER_DURATION_DAYS_DEFAULT (365)
        // ── Range Orders Phase 1 master kill-switch flags ─────────────
        // All default `false` on a fresh deploy. Flipped on by governance
        // via `ConfigFacet.setRangeAmountEnabled` / `setRangeRateEnabled`
        // / `setPartialFillEnabled` after the testnet bake. While off,
        // `OfferFacet.createOffer` enforces the legacy single-value
        // shape — see docs/RangeOffersDesign.md §15.
        bool rangeAmountEnabled;
        bool rangeRateEnabled;
        bool partialFillEnabled;
        // ── VPFI discount tier thresholds (18-dec VPFI; 0 ⇒ default) ──
        uint256 vpfiTier1Min; // 0 ⇒ VPFI_TIER1_MIN (100e18)
        uint256 vpfiTier2Min; // 0 ⇒ VPFI_TIER2_MIN (1_000e18)
        uint256 vpfiTier3Min; // 0 ⇒ VPFI_TIER3_MIN (5_000e18)
        uint256 vpfiTier4Threshold; // 0 ⇒ VPFI_TIER4_THRESHOLD (20_000e18)
        // ── T-032 / Numeraire generalization (B1) — Notification fee config ─────────
        // Flat per-loan-side notification fee, denominated in the
        // ACTIVE NUMERAIRE (1e18 scaled — USD by post-deploy default;
        // whatever governance has rotated to otherwise). Charged in
        // VPFI from the user's escrow at the moment the off-chain
        // hf-watcher fires the FIRST notification on a PaidPush-tier
        // subscription for that loan-side. Zero (default) means use
        // the library constant `NOTIFICATION_FEE_DEFAULT` (2.0
        // numeraire-units); set via `ConfigFacet.setNotificationFee`.
        // Bounded `[MIN_NOTIFICATION_FEE_FLOOR, MAX_NOTIFICATION_FEE_CEIL]`
        // at the setter so a misfire can't lock users out OR drain
        // their escrows. The fee → VPFI math is anchored end-to-end
        // in the active numeraire: `getAssetPrice(WETH)` returns
        // ETH/numeraire post-B1, multiplied by the fixed
        // `VPFI_PER_ETH_FIXED_PHASE1` peg gives a synthetic
        // VPFI/numeraire rate, and the stored fee divides directly. No
        // USD-intermediate is involved at any step (the per-knob
        // `notificationFeeUsdOracle` was retired in Numeraire generalization (Phase 1);
        // the `INumeraireOracle` abstraction was retired in B1).
        uint256 notificationFee; // 0 ⇒ NOTIFICATION_FEE_DEFAULT (2e18)
        // ── T-034 / B1 — Periodic Interest Payment config ─────────────
        // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §6.
        //
        // The numeraire identity is captured by the feed-side slots at
        // the top-level Storage struct (`ethNumeraireFeed`,
        // `numeraireChainlinkDenominator`, `numeraireSymbol`) — there
        // is no longer a dedicated "numeraire oracle" contract. The
        // post-Numeraire-generalization design has `OracleFacet.getAssetPrice` return
        // numeraire-quoted prices natively; comparison sites compare
        // numeraire-vs-numeraire without any boundary conversion.
        // Principal threshold for opting into a finer-than-mandatory
        // cadence. Stored in numeraire-units (1e18-scaled). 0 ⇒
        // PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT. Range
        // `[PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR,
        //   PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL]` enforced
        // by both setters. Read at `createOffer` to gate Filter 2.
        uint256 minPrincipalForFinerCadence; // 0 ⇒ default
        // Pre-notify lead time, in days. Single knob shared between
        // the maturity pre-notify lane and the new periodic-checkpoint
        // pre-notify lane in the off-chain hf-watcher. 0 ⇒
        // PERIODIC_PRE_NOTIFY_DAYS_DEFAULT (3). Range
        // `[PERIODIC_PRE_NOTIFY_DAYS_FLOOR, PERIODIC_PRE_NOTIFY_DAYS_CEIL]`
        // enforced by `ConfigFacet.setPreNotifyDays`.
        uint8 preNotifyDays; // 0 ⇒ default 3
        // Master kill-switch for the entire Periodic Interest Payment
        // mechanic. Default `false` — the feature ships dormant. While
        // `false`:
        //   - `OfferFacet.createOffer` reverts `PeriodicInterestDisabled`
        //     for any non-`None` cadence.
        //   - `RepayFacet.settlePeriodicInterest` reverts wholesale (PR2).
        //   - `RepayFacet.repayPartial` interest-first fold + inline
        //     checkpoint advance is bypassed (PR2).
        //   - Every cadence-aware UI surface in the frontend is hidden.
        // Flipped on by `ADMIN_ROLE` via
        // `ConfigFacet.setPeriodicInterestEnabled(bool)` once governance
        // is ready to activate the feature mesh-wide. See §10.1 of the
        // design doc for the full behavior matrix.
        bool periodicInterestEnabled;
        // Independently gates the atomic batched `setNumeraire` setter.
        // Default `false` — a fresh deploy ships USD-as-numeraire (the
        // ETH/USD Chainlink feed pointed at by `s.ethNumeraireFeed`,
        // empty `s.numeraireSymbol` interpreted as "usd") and
        // governance cannot rotate to a different numeraire until this
        // flag flips. Threshold-only updates via
        // `setMinPrincipalForFinerCadence(uint256)` and the per-knob
        // setters are NOT gated by this flag — governance can tune
        // individual values within the same numeraire freely.
        bool numeraireSwapEnabled;
    }

    /// @dev Struct to store parameters of createOffer function, avoiding stack-too-deep.
    struct CreateOfferParams {
        OfferType offerType;
        address lendingAsset;
        uint256 amount;
        uint256 interestRateBps;
        address collateralAsset;
        uint256 collateralAmount;
        uint256 durationDays;
        AssetType assetType;
        uint256 tokenId;
        uint256 quantity;
        // Creator's agreement to the liquidation-fallback terms (abnormal-market
        // fallback + illiquid full-collateral transfer). Mandatory on every
        // offer — `createOffer` reverts when false.
        bool creatorFallbackConsent;
        address prepayAsset;
        AssetType collateralAssetType;
        uint256 collateralTokenId;
        uint256 collateralQuantity;
        // Phase 6: keeper access is now per-keeper-per-offer via
        // `offerKeeperEnabled[offerId][keeper]`. No single keeper bool on
        // the params; the creator enables specific keepers after create
        // (or before acceptance) via `ProfileFacet.setOfferKeeperEnabled`.

        // Lender-controlled gate for borrower-initiated partial repay
        // (`RepayFacet.repayPartial`). Semantics differ by offer side:
        //   - Lender offer: lender at create says "I allow my borrower
        //     to partial-repay". Borrower's accept = consent.
        //   - Borrower offer: borrower at create says "I want the option
        //     to partial-repay". Lender's accept = consent.
        // In both cases the offer is a take-it-or-leave-it package; an
        // acceptor who disagrees with the flag simply doesn't accept.
        // Snapshotted onto `Loan.allowsPartialRepay` at loan init and
        // enforced at the top of `RepayFacet.repayPartial`. Default
        // `false` is the Phase-1-safe behaviour: explicit opt-in only.
        bool allowsPartialRepay;
        // ── Range Orders Phase 1 max fields (docs/RangeOffersDesign.md
        //    §2.2). Pair with the legacy `amount` / `interestRateBps`
        //    fields above (= the min). Auto-collapsed to single-value
        //    semantics when left at 0 — preserves backward compat with
        //    every existing test / script that builds CreateOfferParams.
        //    Range mode requires the corresponding master flag
        //    (`rangeAmountEnabled` / `rangeRateEnabled`) to be true on
        //    the protocol config; see §15 of the design doc.
        uint256 amountMax;
        uint256 interestRateBpsMax;
        // ── T-034 — Periodic Interest Payment cadence ─────────────────
        // Lender's chosen settlement cadence. Default `None` (zero in
        // the enum) preserves backward compat with every existing
        // CreateOfferParams construction site that doesn't set this
        // field. While `periodicInterestEnabled == false`, any non-`None`
        // value is rejected at `createOffer` with
        // `PeriodicInterestDisabled`. See
        // docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3.
        PeriodicInterestCadence periodicInterestCadence;
    }

    /**
     * @notice Struct for an offer (lender or borrower).
     * @dev Stores details for matching and loan initiation.
     *      Liquidity determined at creation.
     *      Accepted flag prevents re-acceptance.
     */
    struct Offer {
        // Slot 0
        uint256 id;
        // Slot 1: creator(20) + 10 small fields (10) + 1 enum (1)
        //         = 31 bytes packed; 1 free
        address creator;
        OfferType offerType;
        LiquidityStatus principalLiquidity;
        LiquidityStatus collateralLiquidity;
        bool accepted;
        AssetType assetType;
        bool useFullTermInterest;
        bool creatorFallbackConsent;
        AssetType collateralAssetType;
        // Carried into `Loan.allowsPartialRepay` at offer acceptance.
        // See {CreateOfferParams.allowsPartialRepay} for full semantics.
        bool allowsPartialRepay;
        // ── T-034 — Periodic Interest Payment cadence ─────────────────
        // Lender's chosen settlement cadence (None for terminal-only).
        // Validated at `createOffer` per the matrix in
        // docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3 — three
        // filters: liquid-both precondition, interval < duration, and
        // duration-vs-threshold gating. Snapshotted onto `Loan` at
        // acceptance and immutable for the loan's lifetime.
        PeriodicInterestCadence periodicInterestCadence;
        // Slot 2
        address lendingAsset; // ERC20 or NFT contract
        // Slot 3
        uint256 amount; // Principal/rental fee
        // Slot 4
        uint256 interestRateBps; // Basis points for interest/rental rate
        // Slot 5
        address collateralAsset; // ERC20 or NFT contract address
        // Slot 6
        uint256 collateralAmount;
        // Slot 7
        uint256 durationDays;
        // Slot 8
        uint256 tokenId; // For NFT721/1155; 0 for ERC20 — always the underlying asset token ID
        // Slot 9
        uint256 positionTokenId; // Vaipakam position NFT minted at offer creation
        // Slot 10
        uint256 quantity; // For ERC1155; 1 for ERC721; 0 for ERC20
        // Slot 11
        address prepayAsset; // ERC20 for NFT rental fees (e.g., USDC); address(0) for ERC20 loans
        // Slot 12
        uint256 collateralTokenId; // Token ID for NFT collateral; 0 for ERC20
        // Slot 13
        uint256 collateralQuantity; // Quantity for ERC1155 collateral; 0 for ERC20/ERC721
        // ── Range Orders Phase 1 fields (append-only; see
        //    docs/RangeOffersDesign.md §2.1). The legacy `amount` and
        //    `interestRateBps` fields above semantically equal the MIN
        //    of each range; the matching new field is the inclusive max.
        //    A single-value offer satisfies `amountMax == amount` and
        //    `interestRateBpsMax == interestRateBps`. Auto-collapsed at
        //    `createOffer` time when the caller leaves the max field
        //    zero so existing single-value tests / scripts compile + run
        //    unchanged.
        // Slot 14
        uint256 amountMax; // ≥ amount (= the min); 0 ⇒ collapse to amount at create.
        // Slot 15 — cumulative principal consumed across all matches
        //          against this offer. Lender-side partial fills only;
        //          borrower offers stay at 0 (Phase 1 single-fill).
        uint256 amountFilled;
        // Slot 16
        uint256 interestRateBpsMax; // ≥ interestRateBps; 0 ⇒ collapse to interestRateBps.
        // Slot 17 — packed: createdAt(8) + 24 bytes headroom
        uint64 createdAt; // Unix-seconds; stamped at createOffer.
    }

    /**
     * @notice Struct for an active loan.
     * @dev Created on offer acceptance; tracks repayment/default.
     *      References original offerId for details.
     */
    struct Loan {
        // Slot 0
        uint256 id;
        // Slot 1
        uint256 offerId;
        // Slot 2: lender(20) + 9 small fields (9) + 2 × uint16 (4) = 32 bytes packed
        address lender;
        LiquidityStatus principalLiquidity;
        LiquidityStatus collateralLiquidity;
        LoanStatus status;
        AssetType assetType;
        bool useFullTermInterest;
        bool fallbackConsentFromBoth;
        AssetType collateralAssetType;
        // Phase 6: keeper access is now per-keeper-per-loan via
        // `loanKeeperEnabled[loanId][keeper]` (see Storage below). Per-side
        // authority is enforced via each NFT holder's own
        // `approvedKeeperActions` bitmask, so there's no per-loan per-side
        // bool here. The master "pause all keepers" switch remains on
        // `keeperAccessEnabled[user]` (per-user, Storage-level).
        // Fallback-path settlement split, snapshotted at `initiateLoan` from
        // the then-current {ProtocolConfig.fallbackLenderBonusBps} /
        // `fallbackTreasuryBps`. {LibFallback.computeFallbackEntitlements}
        // reads from here — not from live config — so any subsequent
        // governance change via {ConfigFacet.setFallbackSplit} applies
        // prospectively only to loans initiated after the change. Zero
        // on a pre-upgrade loan falls through to the compile-time defaults
        // in `LibFallback` (backfill-safe).
        uint16 fallbackLenderBonusBpsAtInit;
        uint16 fallbackTreasuryBpsAtInit;
        // Slot 3: borrower(20) + 1 small field (1) + 1 enum (1)
        //         + uint64 (8) = 30 bytes packed; 2 free
        address borrower;
        // Snapshotted from `Offer.allowsPartialRepay` at loan init.
        // Read by `RepayFacet.repayPartial` to gate borrower-initiated
        // partial repayment — when false, the call reverts with
        // `PartialRepayNotAllowed`. Snapshot semantics mirror other
        // loan-time invariants (fallback consent, fallback split bps):
        // immutable for the loan's lifetime regardless of any later
        // governance / offer-level change.
        bool allowsPartialRepay;
        // ── T-034 — Periodic Interest Payment fields ──────────────────
        // Snapshotted from `Offer.periodicInterestCadence` at loan init.
        // Immutable for the loan's lifetime — same snapshot discipline as
        // `allowsPartialRepay` and the fallback split bps. None on every
        // loan created while `periodicInterestEnabled` is false. See
        // docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §2.1.
        PeriodicInterestCadence periodicInterestCadence;
        // Unix-seconds timestamp of the most recent fully-settled period
        // checkpoint. Initialised to `startTime` at `initiateLoan`.
        // Advanced by exactly `intervalDays(cadence) * 1 days` per
        // settlement (just-stamp or auto-liquidate). Zero on loans whose
        // cadence is None (the field is read but the next-checkpoint
        // computation in `RepayFacet` short-circuits when cadence is
        // None, so this never matters there).
        uint64 lastPeriodicInterestSettledAt;
        // Slot 4
        uint256 lenderTokenId;
        // Slot 5
        uint256 borrowerTokenId;
        // Slot 6
        uint256 principal; // Lent amount or rental value
        // Slot 7
        address principalAsset;
        // Slot 8
        uint256 interestRateBps;
        // Slot 9: startTime(8) + interestPaidSinceLastPeriod(16)
        //        = 24 bytes packed; 8 free
        // T-034 downsized startTime from uint256 to uint64 to free 24
        // bytes for `interestPaidSinceLastPeriod` and future expansion.
        // uint64 holds Unix-seconds through year 2554 — well past any
        // plausible loan horizon. Every reader implicitly widens to
        // uint256 via Solidity arithmetic; only the three write sites
        // (`LoanFacet.initiateLoan`, `RepayFacet`, `PrecloseFacet`) need
        // explicit `uint64(block.timestamp)` casts.
        uint64 startTime; // Timestamp of initiation
        // T-034 — interest paid by the borrower since the most recent
        // periodic checkpoint (or since `startTime` for the first
        // period). Reset to zero on each settlement. Only the interest
        // portion of `repayPartial` payments accumulates here — under
        // T-034's interest-first allocation, that's the same value as
        // `min(payment, accruedThisPeriod)`. uint128 is plenty: it
        // overflows at ~3.4 × 10^38 wei, far above any conceivable
        // single-period interest amount in any asset.
        uint128 interestPaidSinceLastPeriod;
        // Slot 10
        uint256 durationDays;
        // Slot 11
        address collateralAsset;
        // Slot 12
        uint256 collateralAmount;
        // Slot 13
        uint256 tokenId; // For NFT lending assets
        // Slot 14
        uint256 quantity; // For ERC1155
        // Slot 15
        uint256 prepayAmount;
        // Slot 16
        uint256 bufferAmount;
        // Slot 17
        uint256 lastDeductTime;
        // Slot 18
        address prepayAsset; // ERC20 for NFT rental fees (e.g., USDC); address(0) for ERC20 loans
        // Slot 19
        uint256 collateralTokenId; // Token ID for NFT collateral; 0 for ERC20
        // Slot 20
        uint256 collateralQuantity; // Quantity for ERC1155 collateral; 0 for ERC20/ERC721
        // Slot 21 — VPFI discount per-loan snapshot (§5.2a).
        // Lender's `UserVpfiDiscountState.cumulativeDiscountBpsSeconds`
        // at offer acceptance. At yield-fee settlement, subtracting this
        // from the lender's current accumulator and dividing by loan
        // duration yields the time-weighted average discount BPS — the
        // rate the lender actually earned over the loan's full lifetime.
        // Defeats last-minute escrow top-ups that used to steal the full
        // tier-4 discount for a loan the lender was mostly at tier-1 on.
        uint256 lenderDiscountAccAtInit;
        // Slot 22 — Borrower-side mirror of the lender snapshot above
        // (Phase 5 / §5.2b). Borrower's
        // `UserVpfiDiscountState.cumulativeDiscountBpsSeconds` at offer
        // acceptance. Only populated on loans that take the VPFI-fee path
        // (the borrower chose to pay the full 0.1% LIF in VPFI); zero on
        // lending-asset-fee loans. On proper settlement the delta between
        // the borrower's current accumulator and this anchor, divided by
        // loan duration, yields the time-weighted average discount BPS
        // — which scales the VPFI rebate paid out via ClaimFacet. The
        // gameable one-shot tier lookup at init is replaced by this
        // time-weighted window, so a borrower who tops up to tier 3 at
        // accept and unstakes the next block earns only a prorated
        // rebate (~0) instead of the full discount.
        uint256 borrowerDiscountAccAtInit;
        // ── Range Orders Phase 1 — matcher address ─────────────────────
        // Recorded at loan init from the matching write's `msg.sender`
        // (`matchOffers` / `acceptOffer` / preclose-offset / refinance).
        // Consumed by `LibVPFIDiscount.settleBorrowerLifProper` and
        // `forfeitBorrowerLif` to route 1% of any LIF flowing to
        // treasury (lender-asset path: directly at match; VPFI path:
        // deferred to terminal). Zero on legacy loans created before
        // the Range Orders Phase 1 cutover. See
        // docs/RangeOffersDesign.md §"1% match fee mechanic."
        address matcher;
        // ── T-032 — notification-fee billed flags ──────────────────────
        // Set by `LoanFacet.markNotifBilled` (callable only by
        // `NOTIF_BILLER_ROLE` — held by the off-chain hf-watcher) the
        // first time a paid-tier (Push-Protocol) notification fires
        // for the corresponding side of this loan. Once set, the user's
        // VPFI escrow has already been debited the
        // `cfgNotificationFee()`-equivalent amount in VPFI,
        // routed directly to treasury (no Diamond custody — see
        // `LibNotificationFee.bill` for the routing). Idempotent: the
        // facet method no-ops if the flag is already true. Free-tier
        // (Telegram-only) subscribers and unsubscribed users always
        // leave both flags `false` — they're billed only on PaidPush.
        bool lenderNotifBilled;
        bool borrowerNotifBilled;
    }

    /**
     * @notice Struct for claimable funds after loan resolution.
     * @dev Tracks what each party can claim via ClaimFacet.
     */
    struct ClaimInfo {
        address asset;
        uint256 amount;
        AssetType assetType;
        uint256 tokenId;
        uint256 quantity;
        bool claimed;
    }

    /**
     * @notice Snapshot of a liquid-collateral loan that fell back to the
     *         claim-time settlement path (README §7 lines 142–153, 251, 290).
     * @dev Written by RiskFacet / DefaultedFacet when the DEX swap reverts
     *      (or is skipped for slippage > 6%). While `active == true`, the
     *      collateral is held inside the Diamond, the snapshot records the
     *      split that would apply if the lender-claim retry also fails,
     *      and ClaimFacet may attempt liquidation one more time.
     *      lenderCollateral / treasuryCollateral / borrowerCollateral are
     *      denominated in the collateral asset; lenderPrincipalDue /
     *      treasuryPrincipalDue are denominated in the principal asset and
     *      drive the retry-proceeds split if the retry swap succeeds.
     */
    struct FallbackSnapshot {
        uint256 lenderCollateral;
        uint256 treasuryCollateral;
        uint256 borrowerCollateral;
        uint256 lenderPrincipalDue;
        uint256 treasuryPrincipalDue;
        bool active;
        bool retryAttempted;
    }

    struct RiskParams {
        uint256 maxLtvBps; // Max LTV in basis points
        uint256 liqThresholdBps; // Liquidation Threshold in basis points
        uint256 liqBonusBps; // Liquidation Bonus in basis points
        uint256 reserveFactorBps; // Reserve Factor in basis points
        uint256 minPartialBps; // Min partial repay % (e.g., 100 for 1%)
    }

    /// @notice One row of the duration-tiered grace-period table.
    /// @dev Buckets are stored as a sorted array in
    ///      `Storage.graceBuckets`, with `maxDurationDays` strictly
    ///      ascending across the array. `gracePeriod(durationDays)`
    ///      returns the `graceSeconds` of the first bucket whose
    ///      `maxDurationDays > durationDays`. The LAST bucket is the
    ///      catch-all and is identified by `maxDurationDays == 0` —
    ///      its `graceSeconds` applies to every duration above the
    ///      penultimate bucket's threshold. This shape matches the
    ///      compile-time default schedule in `gracePeriod()` exactly,
    ///      so a fresh deploy with empty storage and a storage-driven
    ///      deploy produce identical lookups for the original 5
    ///      buckets, plus the new `≥ 365 days → 30 days` row.
    struct GraceBucket {
        uint256 maxDurationDays;
        uint256 graceSeconds;
    }

    /// @notice Per-feed oracle override. Governance-installed tighter
    ///         staleness bound and/or minimum-valid-answer floor on a
    ///         specific Chainlink aggregator address. `maxStaleness == 0`
    ///         is the "not set" marker — the global two-tier defaults
    ///         (ORACLE_VOLATILE_STALENESS / ORACLE_STABLE_STALENESS)
    ///         apply in that case.
    /// @dev `minValidAnswer <= 0` is treated as "no floor" (the baseline
    ///         `answer > 0` sanity check already rejects non-positive
    ///         readings). A feed returning below this floor triggers a
    ///         StalePriceData revert, preventing attacker- or
    ///         incident-driven near-zero reads from surfacing as legitimate
    ///         prices.
    struct FeedOverride {
        /// Max age in seconds. 0 = override not set.
        uint40 maxStaleness;
        /// Minimum acceptable `answer` from the aggregator. Must be
        /// expressed in the aggregator's own decimals. `<= 0` = no floor.
        int256 minValidAnswer;
    }

    /// @notice Per-user acceptance of the protocol's Terms of Service.
    ///         Written once per user per ToS version by
    ///         `LegalFacet.acceptTerms`. Frontends gate app entry until
    ///         `version == currentTosVersion` AND `hash == currentTosHash`.
    /// @dev `version == 0` is the "never accepted" marker — first-time
    ///      visitors always need to sign to enter the app.
    ///      `acceptedAt` is the block timestamp at acceptance; used by
    ///      audit / compliance queries asking "when did this wallet
    ///      accept version X?".
    struct TosAcceptance {
        uint32 version;
        bytes32 hash;
        uint64 acceptedAt;
    }

    /**
     * @notice Timestamped record of a fee accrual to the treasury.
     * @dev Appended by {LibFacet.recordTreasuryAccrual} at every treasury-debit
     *      site so MetricsFacet can report rolling 24h/7d windows and a true
     *      lifetime cumulative total. Packed into a single slot:
     *      `timestamp` fits any reasonable future block time in uint64, and
     *      `numeraireValue` in uint192 accommodates active-numeraire amounts
     *      scaled to 1e18 up to ~6.28e39 — vastly beyond any single fee. The
     *      protocol is currency-agnostic: amounts are quoted in whatever
     *      numeraire governance has configured (USD by post-deploy default).
     *      `numeraireValue` is 0 when the priced asset lacks a Chainlink feed
     *      at the time of accrual. The underlying asset-denominated accrual
     *      is reflected in `treasuryBalances[asset]` only when the configured
     *      treasury is the Diamond itself; external-treasury deployments
     *      push the tokens straight to the multisig, so `treasuryBalances`
     *      stays at zero for those fee paths (the fee still lives on-chain
     *      in the event log and `cumulativeFeesNumeraire`).
     */
    struct FeeEvent {
        uint64 timestamp;
        uint192 numeraireValue;
    }

    /// @notice Which side of a loan a {RewardEntry} represents.
    enum RewardSide {
        Lender,
        Borrower
    }

    /**
     * @notice Per-loan per-side reward accrual entry (spec §4 daily accrual).
     * @dev One entry per loan per side EXCEPT lender side, which may have
     *      multiple entries if the lender position is transferred via
     *      early-withdrawal sale. Each entry covers one contiguous
     *      `[startDay, endDay)` window for `user`.
     *
     *      endDay == 0 marks the entry as still open. closeLoan writes
     *      the terminal endDay + flags. Forfeited entries route to
     *      treasury at claim time (per-user directive: defaulted borrower
     *      rewards and early-withdrawal initiator rewards go to treasury).
     */
    struct RewardEntry {
        address user;
        uint64 loanId;
        uint32 startDay; // inclusive
        uint32 endDay; // exclusive; 0 = still open
        RewardSide side;
        bool processed; // claim/sweep already routed this entry
        bool forfeited; // true ⇒ route to treasury on processing
        uint256 perDayNumeraire18; // Numeraire18 interest-per-day snapshotted at register
    }

    /**
     * @notice Per-user VPFI discount accumulator. Drives the time-weighted
     *         lender yield-fee discount (docs/GovernanceConfigDesign.md §5.2a).
     *         Updated on every escrow-VPFI balance mutation and at every
     *         offer-accept / yield-fee settlement. Ordering invariant: the
     *         accompanying `rollupUserDiscount(user, postMutationBalance)`
     *         call runs at the mutation site; the closing period carries
     *         the bps stamp left by the prior rollup (the tier that was in
     *         effect across the just-closed window), and the re-stamp uses
     *         the post-mutation balance to seed the next period.
     *
     * @dev Packed layout:
     *        slot 0: uint16 (2) + uint64 (8) = 10 bytes → fits comfortably
     *        slot 1: uint256 cumulativeDiscountBpsSeconds
     *      `cumulativeDiscountBpsSeconds` is monotone non-decreasing and
     *      the per-loan delta `(now_cum - loan.lenderDiscountAccAtInit) /
     *      loanDuration` produces the average discount BPS the lender
     *      actually qualified for over that loan's lifetime — a last-
     *      minute top-up cannot backdate its effect onto prior periods.
     */
    struct UserVpfiDiscountState {
        uint16 discountBpsAtPreviousRollup;
        uint64 lastRollupAt;
        uint256 cumulativeDiscountBpsSeconds;
    }

    /**
     * @notice Per-loan custody + claim bookkeeping for the borrower Loan
     *         Initiation Fee VPFI-path (Phase 5 / §5.2b).
     *
     * @dev Lifecycle:
     *        init (VPFI path):      vpfiHeld = full LIF-equivalent VPFI
     *                               pulled from borrower escrow to the
     *                               Diamond; rebateAmount = 0
     *        proper settlement:     rebateAmount = vpfiHeld × avgBps / BPS
     *                               (Diamond sends treasury share to
     *                               treasury, retains rebateAmount for
     *                               the borrower claim); vpfiHeld = 0
     *        default / liquidation: both zeroed, full vpfiHeld forwarded
     *                               to treasury (no rebate)
     *        claim:                 rebateAmount cleared to zero as the
     *                               Diamond transfers VPFI to the claimant
     *
     *      Non-VPFI-path loans keep this struct at the zero default; no
     *      settlement side-effects and no claim.
     */
    struct BorrowerLifRebate {
        uint256 vpfiHeld; // Diamond's custody while the loan is live
        uint256 rebateAmount; // Claimable VPFI after proper settlement
    }

    /**
     * @notice Main storage struct for Vaipakam.
     * @dev Holds all global data: offers, loans, IDs, escrows, asset configs.
     *      Accessed via storageSlot function.
     *
     *      APPEND-ONLY POST-LAUNCH: after the first mainnet deployment, fields
     *      in this struct MUST only be added at the end. Never reorder, rename,
     *      or change the type of an existing field. Never remove a field — if
     *      a field becomes unused, mark it `// DEPRECATED` and leave the slot
     *      reserved (see `liquidAssets` for the precedent). Violating this
     *      rule corrupts every live loan, offer, and user escrow in storage.
     *      Pre-launch: free to reorder at will.
     *
     *      ── Storage invariants (must hold across every tx boundary) ────────
     *        • `lenderClaims[loanId]` / `borrowerClaims[loanId]`: at most one
     *          unclaimed ClaimInfo per party per loan. Written only by the
     *          settlement path that produced the funds (repay / preclose /
     *          default / fallback); zeroed only by ClaimFacet on withdrawal.
     *        • `heldForLender[loanId]`: monotone non-decreasing between loan
     *          initiation and lender claim; reset to 0 when the lender is
     *          paid out. Only written by PrecloseFacet / RefinanceFacet /
     *          PartialWithdrawalFacet — never by repay paths.
     *        • `fallbackSnapshot[loanId].active == true` ⇔ the loan is in
     *          status FallbackPending. Set exclusively by RiskFacet /
     *          DefaultedFacet at fallback time; cleared by ClaimFacet on the
     *          first lender/borrower claim. Never mutated outside these sites.
     *        • `treasuryBalances[asset]`: IOU of treasury-earmarked tokens
     *          still physically held at the Diamond. Written by
     *          {LibFacet.recordTreasuryAccrual} only when `treasury ==
     *          address(this)`; external-treasury deployments leave this
     *          ledger at zero because the fees are pushed out synchronously
     *          (see `feeEventsLog` / `cumulativeFeesNumeraire` for the analytics
     *          of record). Monotone non-decreasing between accruals;
     *          reset to zero by `TreasuryFacet.claimTreasuryFees`. Any
     *          interest/late-fee split that debits lender/borrower MUST
     *          credit treasury via {LibFacet.recordTreasuryAccrual} by
     *          exactly `treasuryShare` — LibSettlement's plan is the single
     *          source of truth for that split.
     *        • `offerIdToLoanId[offerId]`: set exactly once, at loan
     *          initiation. Zero means "offer never consumed." Never rewritten.
     *        • `loanToSaleOfferId` / `saleOfferToLoanId` /
     *          `offsetOfferToLoanId` / `loanToOffsetOfferId`: bijective pairs.
     *          Both sides must be written together and cleared together;
     *          a one-sided write is a bug.
     *        • `approvedKeeperActions[user][keeper] != 0` ⇔ `keeper ∈
     *          approvedKeepersList[user]`. The list mirrors the mapping for
     *          enumeration and is capped at MAX_APPROVED_KEEPERS.
     *        • `keeperAccessEnabled[user]`: user-level master switch (Phase 6).
     *          A keeper call on a loan additionally requires
     *          `loanKeeperEnabled[loanId][keeper] == true` AND the
     *          per-action bit set on
     *          `approvedKeeperActions[nftOwner][keeper]` — all three gates
     *          must pass. See `LibAuth.requireKeeperFor` and
     *          `ProfileFacet.setLoanKeeperEnabled`.
     */
    struct Storage {
        uint256 nextOfferId;
        uint256 nextLoanId;
        uint256 nextTokenId; // For Vaipakam NFTs
        address vaipakamEscrowTemplate; // Shared UUPS implementation
        address treasury; // Configurable treasury address
        address zeroExProxy; // 0x proxy for liquidations
        address allowanceTarget; // allowance target for 0x proxy protocol
        address numeraireChainlinkDenominator; // Chainlink Feed Registry denominator constant for the active numeraire (Denominations.USD by default; rotates with the numeraire)
        // T-034 Numeraire generalization (B1) — symbol of the active numeraire used by
        // the symbol-derived secondary oracles (Tellor / API3 / DIA). Stored
        // as bytes32 (max 32 ASCII chars) for cheap on-chain comparison;
        // governance writes lowercase ASCII (e.g. "usd", "eur", "xau").
        // Empty bytes32 (post-deploy default before governance writes)
        // is interpreted as "usd" in `_checkTellor` / `_checkApi3` /
        // `_checkDIA` so the protocol behaves identically to the pre-
        // sweep deploy out of the box.
        bytes32 numeraireSymbol;
        address chainlnkRegistry; // Chainlink Feed Registry (mainnet only; address(0) on L2s)
        address wethContract; // Canonical WETH on the active network — v3-style AMM liquidity quote asset
        address uniswapV3Factory; // UNISWAP_V3_FACTORY
        address diamondAddress;
        mapping(uint256 => uint256) loanToSaleOfferId;
        mapping(uint256 => Offer) offers;
        mapping(uint256 => Loan) loans;
        mapping(address => address) userVaipakamEscrows; // Per-user proxy addresses
        mapping(address => RiskParams) assetRiskParams;
        mapping(address => uint256) treasuryBalances;
        mapping(address => string) userCountry; // ISO code, e.g., "US"
        mapping(address => bool) kycVerified;
        mapping(bytes32 => mapping(bytes32 => bool)) allowedTrades; // hash(countryA) => hash(countryB) => true if A can trade with B
        mapping(uint256 => ClaimInfo) lenderClaims; // loanId => lender's claimable funds
        mapping(uint256 => ClaimInfo) borrowerClaims; // loanId => borrower's claimable funds
        mapping(address => KYCTier) kycTier; // user => KYC tier level
        mapping(uint256 => uint256) heldForLender; // loanId => extra amount held for lender from preclose operations
        mapping(uint256 => uint256) offsetOfferToLoanId; // newOfferId => originalLoanId for offset tracking
        mapping(uint256 => uint256) saleOfferToLoanId; // saleOfferId => loanId for lender sale completion
        mapping(uint256 => uint256) offerIdToLoanId; // offerId => loanId (set at loan initiation)
        mapping(uint256 => uint256) loanToOffsetOfferId; // loanId => offset offerId (borrower preclose Option 3)
        uint256 currentEscrowVersion; // incremented on each implementation upgrade
        uint256 mandatoryEscrowVersion; // minimum version required; 0 = no mandatory upgrade
        mapping(address => uint256) escrowVersion; // user => version when their proxy was last upgraded
        uint256 kycTier0ThresholdNumeraire; // Tier0 max (default 1_000 * 1e18)
        uint256 kycTier1ThresholdNumeraire; // Tier1 max (default 10_000 * 1e18)
        mapping(address => bool) keeperAccessEnabled; // User-level master switch — quick "pause all keepers for me" (default: false)
        // Snapshot of liquid-collateral liquidations that fell back to the
        // claim-time settlement path (README §7). Written by RiskFacet /
        // DefaultedFacet at fallback time; consumed by ClaimFacet on the
        // first lender/borrower claim.
        mapping(uint256 => FallbackSnapshot) fallbackSnapshot;
        // Phase 6: per-user whitelist of approved keepers + their per-action
        // authorization bitmask. The bitmask uses the KEEPER_ACTION_* constants
        // below. A zero value means the keeper is not approved (equivalent to
        // not-on-the-list); a non-zero value authorizes the keeper for the set
        // bits' actions. Capped at MAX_APPROVED_KEEPERS per user. Per-side
        // authority is automatic: a lender-entitled action for a loan checks
        // the lender-NFT holder's bitmask, a borrower-entitled action checks
        // the borrower-NFT holder's — the two bitmasks are independent.
        mapping(address => mapping(address => uint8)) approvedKeeperActions;
        mapping(address => address[]) approvedKeepersList;
        // Phase 6: per-loan and per-offer keeper enable flags. A keeper may
        // drive an action on a loan iff they are both enabled for the loan
        // (this mapping) AND the relevant NFT holder's bitmask above has the
        // action bit set. Offer-level flags are latched into loan-level at
        // `initiateLoan` via the creator's whitelist; post-acceptance each
        // NFT holder can edit the loan-level flag via
        // `ProfileFacet.setLoanKeeperEnabled`.
        mapping(uint256 => mapping(address => bool)) loanKeeperEnabled;
        mapping(uint256 => mapping(address => bool)) offerKeeperEnabled;
        // README §13 analytics surface: timestamped log of every treasury-fee
        // accrual, priced in the active numeraire at accrual time. Appended
        // by LibFacet.recordTreasuryAccrual. Consumed by MetricsFacet for the
        // 24h/7d revenue windows and getRevenueStats(days_). Capped per query
        // by MAX_FEE_EVENTS_ITER on read.
        FeeEvent[] feeEventsLog;
        // Monotone cumulative sum of numeraireValue across feeEventsLog
        // entries — tracked separately so
        // MetricsFacet.getTreasuryMetrics.totalFeesCollectedNumeraire is an
        // O(1) read. Never decreases.
        uint256 cumulativeFeesNumeraire;
        // README §16 Phase 1 KYC pass-through flag. When FALSE (the default
        // at Phase 1 launch), every `meetsKYCRequirement` / `isKYCVerified`
        // check returns true so KYC logic does not block any user flow. The
        // tier / threshold / admin plumbing is preserved so governance may
        // flip this to true in a later phase to activate real enforcement
        // without a further diamond cut.
        bool kycEnforcementEnabled;
        // Phase 1 tokenomics (docs/TokenomicsTechSpec.md): address of the
        // VPFIToken UUPS proxy that serves as the canonical on-chain handle
        // for the protocol's ERC20. Written by VPFITokenFacet.setVPFIToken
        // (ADMIN_ROLE) after the token proxy is deployed; read by facets
        // that surface token state or (later) interact with minter/burn
        // paths. Zero value means the token has not been registered yet.
        //
        // On the canonical chain (Base mainnet / Base Sepolia testnet) this
        // points at the VPFIToken ERC20Capped proxy. On every non-canonical
        // chain (Eth/Polygon/Arbitrum/Optimism mainnet + Sepolia testnet) it
        // points at the VPFIMirror OFT proxy — same name/symbol/decimals,
        // no cap, no independent mint surface (supply flows in/out via the
        // LayerZero peer mesh, not via diamond-initiated mints).
        address vpfiToken;
        // True on the chain that hosts the canonical VPFIToken + OFT adapter
        // (Base mainnet / Base Sepolia). On every other chain this stays
        // FALSE, which is what TreasuryFacet.mintVPFI checks to reject mint
        // calls on mirror chains — only the canonical chain can mint new
        // VPFI into circulation, mirrors receive VPFI exclusively via the
        // OFT V2 peer mesh. Defaults to false at diamond init; flipped to
        // true by VPFITokenFacet.setCanonicalVPFIChain(true) exactly once
        // during the canonical deploy.
        bool isCanonicalVPFIChain;
        // ── Borrower VPFI Discount (Phase 1) ────────────────────────────
        // Fixed ETH rate at which borrowers may buy VPFI directly from the
        // protocol on the canonical chain. Stored as wei-per-VPFI so the
        // 0.001 ETH default is `1e15`. Set via
        // VPFIDiscountFacet.setVPFIBuyRate (ADMIN_ROLE). Zero means the
        // admin has not configured the rate yet and the buy/discount path
        // is disabled.
        uint256 vpfiFixedRateWeiPerVpfi;
        // Global cap on VPFI sold through the fixed-rate buy, in VPFI
        // wei. Enforced against `vpfiFixedRateTotalSold`. Zero resolves to
        // the spec default {VPFI_FIXED_GLOBAL_CAP} (2.3M VPFI, see
        // docs/TokenomicsTechSpec.md §8) via {cfgVpfiFixedGlobalCap}. There
        // is no "uncapped" mode — the spec forbids surfacing the buy as
        // unlimited on any chain.
        uint256 vpfiFixedRateGlobalCap;
        // Per-(wallet, origin-chain) cap on VPFI sold through the
        // fixed-rate buy. Enforced against
        // `vpfiFixedRateSoldToByEid[user][originEid]` (declared at
        // the end of this struct). Zero resolves to the spec default
        // {VPFI_FIXED_WALLET_CAP} (30k VPFI, see
        // docs/TokenomicsTechSpec.md §8a) via {cfgVpfiFixedWalletCap}.
        // As with the global cap, no "uncapped" mode is exposed. The
        // Phase 1 cap is per-chain, not one shared global wallet cap
        // across every chain.
        uint256 vpfiFixedRatePerWalletCap;
        // Monotone append-only counter of total VPFI sold at the fixed
        // rate. Feeds the global cap check and the transparency view.
        uint256 vpfiFixedRateTotalSold;
        // Chain-local ERC-20 address whose Chainlink USD feed is used to
        // convert the discounted fee from USD into ETH during the
        // discount-eligibility calculation. In practice this is the
        // canonical WETH on the active network. Zero means the ETH oracle
        // is not configured and the discount path falls back silently to
        // the normal lender-paid fee.
        address vpfiDiscountETHPriceAsset;
        // Admin kill-switch for the fixed-rate buy. The discount path at
        // loan acceptance remains functional even when this flag is false
        // — it only gates `buyVPFIWithETH`. Set via setVPFIBuyEnabled.
        bool vpfiFixedRateBuyEnabled;
        // DEPRECATED — single-key per-wallet running total. Replaced by
        // the per-(buyer, originEid) mapping {vpfiFixedRateSoldToByEid}
        // declared at the end of this struct. The slot is preserved
        // only because the Diamond storage layout is append-only; the
        // facet code no longer reads or writes this mapping. Per spec
        // (docs/TokenomicsTechSpec.md §8a) the per-wallet cap is now
        // enforced per origin chain.
        mapping(address => uint256) vpfiFixedRateSoldTo_LEGACY_DO_NOT_USE;
        // Platform-level opt-in to use escrowed VPFI for protocol fee
        // discounts. One common consent governs both the borrower Loan
        // Initiation Fee discount and the lender Yield Fee discount. Per
        // spec (docs/TokenomicsTechSpec.md §6 and §9, README §"Treasury and
        // Revenue Sharing"): offer-level or loan-level toggles are not
        // required once this flag is true. When false, all fee flows revert
        // to the default non-discounted path; when true, the discount is
        // applied automatically whenever the escrow holds enough VPFI and
        // the asset leg is eligible (liquidity + oracle availability).
        mapping(address => bool) vpfiDiscountConsent;
        // ─── VPFI Staking Rewards (spec §7) ─────────────────────────────
        // Escrow-held VPFI is automatically "staked" and earns 5% APR from
        // VPFI_STAKING_POOL_CAP. reward-per-token time-weighted accrual —
        // every VPFI escrow balance mutation (deposit, discount deduction,
        // withdrawVPFIFromEscrow) MUST call LibStakingRewards.updateUser
        // BEFORE mutating the escrow balance, passing the user's current
        // staked balance as the checkpoint input.
        //
        // rewardPerTokenStored is VPFI-per-staked-VPFI scaled by 1e18.
        // totalStakedVPFI is the sum of every user's `userStakedVPFI`.
        // stakingPoolPaidOut is monotone — claims are capped so this
        // never exceeds VPFI_STAKING_POOL_CAP. userStakedVPFI mirrors the
        // user's actual escrow VPFI balance; it is authoritative for the
        // accrual math and decouples the reward bookkeeping from any
        // escrow-side balance read.
        uint256 stakingRewardPerTokenStored;
        uint256 stakingLastUpdateTime;
        uint256 totalStakedVPFI;
        uint256 stakingPoolPaidOut;
        mapping(address => uint256) userStakedVPFI;
        mapping(address => uint256) userStakingRewardPerTokenPaid;
        mapping(address => uint256) userStakingPendingReward;
        // ─── VPFI Lender Yield-Fee Time-Weighted Discount (§5.2a) ──────
        // Per-user accumulator backing the lender-side time-weighted
        // yield-fee discount. Each loan stores `lenderDiscountAccAtInit`
        // (on Loan struct) at offer acceptance; at yield-fee settlement,
        // the time-weighted average BPS over the loan window =
        //   (cumulativeDiscountBpsSeconds_now - loan.lenderDiscountAccAtInit)
        //   / (now - loan.startTime)
        // — and that average replaces the previous live tier-at-repay
        // lookup. See docs/GovernanceConfigDesign.md §5.2a for the full
        // rationale and the anti-gaming design sketch.
        mapping(address => UserVpfiDiscountState) userVpfiDiscountState;
        // ─── VPFI Platform Interaction Rewards (spec §4) ────────────────
        // Daily emission pool split 50/50 across lenders (by USD interest
        // earned that day) and borrowers (by USD interest paid that day on
        // CLEAN full-term in-grace repayment only — no defaults, no
        // liquidations, no post-grace settlements). Emission schedule
        // (§4) decays from 32% annual rate in months 0–6 down to 5% after
        // month 78, scaled against VPFI_INITIAL_MINT. Pull-only claims
        // via InteractionRewardsFacet.claimInteractionRewards().
        //
        // dayIndex = (block.timestamp - interactionLaunchTimestamp) / 1 days;
        // launch timestamp is seeded at diamond init by admin; zero means
        // emissions have not yet begun and both totals are no-ops.
        //
        // Settlement hooks (RepayFacet on clean full repay, and any
        // future preclose path on a strict clean-repay outcome) record
        // the USD-valued (Chainlink spot) interest booked on day `d`:
        //   totalLenderInterestNumeraire18[d] += interestUSD
        //   userLenderInterestNumeraire18[d][lender] += interestUSD
        //   (and borrower mirror iff clean)
        // Claims walk finalized days < today, cap at MAX_INTERACTION_CLAIM_DAYS
        // per tx, and advance interactionLastClaimedDay.
        uint256 interactionLaunchTimestamp;
        uint256 interactionPoolPaidOut;
        mapping(uint256 => uint256) totalLenderInterestNumeraire18;
        mapping(uint256 => uint256) totalBorrowerInterestNumeraire18;
        mapping(uint256 => mapping(address => uint256)) userLenderInterestNumeraire18;
        mapping(uint256 => mapping(address => uint256)) userBorrowerInterestNumeraire18;
        mapping(address => uint256) interactionLastClaimedDay;
        /// @dev Admin-configurable "whole VPFI per 1 ETH of eligible
        ///      interest" per-user daily cap used in
        ///      {LibInteractionRewards} claim + preview. Zero = use the
        ///      {INTERACTION_CAP_DEFAULT_VPFI_PER_ETH} default (500 →
        ///      0.5 VPFI per 0.001 ETH, matching docs/TokenomicsTechSpec.md
        ///      §4). Applied independently per side per day.
        uint256 interactionCapVpfiPerEth;
        // ─── Cross-Chain Reward Accounting (spec §4a) ────────────────────
        // The §4 reward formula's denominator `totalDailyInterestUSD` is
        // PROTOCOL-WIDE, not per-chain — but each independent Diamond
        // only sees local interest. This block wires the reporter /
        // aggregator / consumer sides across the mesh:
        //   - every Diamond (Base + mirrors) runs a reporter that ships
        //     its day-`D` local (lender, borrower) USD totals to Base
        //   - Base runs an aggregator that sums per-chain reports into
        //     `dailyGlobalLenderInterestNumeraire18[D]` and
        //     `dailyGlobalBorrowerInterestNumeraire18[D]` once all expected
        //     mirrors have reported OR `rewardGraceSeconds` has elapsed
        //   - Base then broadcasts the finalized global pair back to
        //     every mirror, where {LibInteractionRewards.claimForUserWindow}
        //     prefers `knownGlobal*InterestNumeraire18[D]` over the local total
        //     as the formula denominator
        //
        // Trust model: LayerZero packets flow through the dedicated
        // VaipakamRewardOApp contract addressed by `rewardOApp`. Only
        // that address may invoke the trusted ingress handlers
        // (RewardAggregatorFacet.onChainReportReceived on Base,
        // RewardReporterFacet.onRewardBroadcastReceived on mirrors).

        /// @dev True exactly on the canonical reward chain (Base mainnet
        ///      chainId 8453 / Base Sepolia 84532). Gates the aggregator
        ///      ingress + finalize + broadcast trigger. Admin-settable so
        ///      the flag is parity-independent of the Diamond deployment.
        bool isCanonicalRewardChain;
        /// @dev LayerZero V2 endpoint id of THIS chain. Stamped on
        ///      outbound chain reports and used by the Base aggregator
        ///      to key per-chain sub-totals.
        uint32 localEid;
        /// @dev Base (canonical) chain's LayerZero endpoint id. Mirrors
        ///      send chain reports to this eid; zero on Base itself.
        uint32 baseEid;
        /// @dev Authorized LayerZero OApp address on this chain. Only
        ///      this address may call the trusted ingress handlers
        ///      (aggregator receive on Base, broadcast receive on mirrors).
        address rewardOApp;
        /// @dev Seconds past the first chain report for day `D` after
        ///      which `finalizeDay(D)` may be called even if not every
        ///      expected mirror has reported. Defaults to 4 hours when
        ///      unset. Admin-configurable.
        uint64 rewardGraceSeconds;
        /// @dev Base-only: list of remote LayerZero eids that are
        ///      expected to report each day (every mirror chain in the
        ///      mesh, PLUS the Base chain's own `localEid` because Base
        ///      is also a source of interest). Admin-maintained.
        uint32[] expectedSourceEids;
        // ── Reporter side (every chain) ────────────────────────────────
        /// @dev Per-chain per-day "already reported" guard. Set when the
        ///      local Diamond successfully ships its day-`D` report (on
        ///      Base: writes directly to aggregator storage; on mirrors:
        ///      queues the OApp send).
        mapping(uint256 => uint64) chainReportSentAt;
        // ── Aggregator side (Base only) ────────────────────────────────
        /// @dev Base-only: lender-side local Numeraire18 interest reported by
        ///      chain `eid` for day `D`.
        mapping(uint256 => mapping(uint32 => uint256)) chainDailyLenderInterestNumeraire18;
        /// @dev Base-only: borrower-side local Numeraire18 interest reported by
        ///      chain `eid` for day `D`.
        mapping(uint256 => mapping(uint32 => uint256)) chainDailyBorrowerInterestNumeraire18;
        /// @dev Base-only: `(dayId, eid)` idempotency guard — rejects
        ///      duplicate reports for the same `(day, chain)` pair.
        mapping(uint256 => mapping(uint32 => bool)) chainDailyReported;
        /// @dev Base-only: number of expected eids that have reported
        ///      for day `D` so far. Used to decide full-coverage fast
        ///      finalization.
        mapping(uint256 => uint32) chainDailyReportCount;
        /// @dev Base-only: `block.timestamp` of the FIRST report for
        ///      day `D`. Drives the grace-window fallback when not all
        ///      mirrors have reported.
        mapping(uint256 => uint64) dailyFirstReportAt;
        /// @dev Base-only: finalized flag for day `D`. Set by
        ///      {RewardAggregatorFacet.finalizeDay}; late reports after
        ///      finalization are rejected (idempotency preserves claim
        ///      determinism).
        mapping(uint256 => bool) dailyGlobalFinalized;
        /// @dev Base-only: finalized global lender Numeraire18 interest for
        ///      day `D` (sum across reported eids).
        mapping(uint256 => uint256) dailyGlobalLenderInterestNumeraire18;
        /// @dev Base-only: finalized global borrower Numeraire18 interest for
        ///      day `D` (sum across reported eids).
        mapping(uint256 => uint256) dailyGlobalBorrowerInterestNumeraire18;
        // ── Consumer side (every chain) ────────────────────────────────
        /// @dev Finalized global lender denominator known on this chain
        ///      for day `D`. On Base it is set directly by
        ///      {RewardAggregatorFacet.finalizeDay}; on mirrors it is
        ///      set by {RewardReporterFacet.onRewardBroadcastReceived}.
        ///      Zero means "not yet known locally" — claims for `D`
        ///      revert until the broadcast lands.
        mapping(uint256 => uint256) knownGlobalLenderInterestNumeraire18;
        /// @dev Mirror of {knownGlobalLenderInterestNumeraire18} for the
        ///      borrower side.
        mapping(uint256 => uint256) knownGlobalBorrowerInterestNumeraire18;
        /// @dev Per-day `knownGlobal*` set-flag. Cheaper than comparing
        ///      both sides to zero; distinguishes "day `D` finalized
        ///      with zero global interest" from "day `D` not yet
        ///      broadcast here".
        mapping(uint256 => bool) knownGlobalSet;
        // ─── Bridged Fixed-Rate VPFI Buy (spec §: Early Fixed-Rate ──────
        // Purchase Program, cross-chain extension) ─────────────────────────
        // Base is the SOLE seller of the fixed-rate VPFI. Non-Base chains
        // get a "bridged buy" UX via VPFIBuyAdapter: user pays native ETH
        // on Arb/Op/Eth, the adapter forwards a LayerZero message to
        // VPFIBuyReceiver on Base, this Diamond on Base validates caps +
        // reserves exactly as in {buyVPFIWithETH}, transfers VPFI to the
        // receiver, and the receiver bridges it back via VPFIOFTAdapter.
        //
        // `bridgedBuyReceiver` is the sole address allowed to call
        // {processBridgedBuy} — identical trust pattern to `rewardOApp`.
        /// @dev Authorized VPFIBuyReceiver contract on Base. Only this
        ///      address may invoke {VPFIDiscountFacet.processBridgedBuy}.
        ///      Set via {setBridgedBuyReceiver}; zero disables the
        ///      bridged-buy ingress.
        address bridgedBuyReceiver;
        // ─── L2 Sequencer Uptime Circuit Breaker ────────────────────────
        // On L2s (Base/Arb/OP/etc.) we must not consume Chainlink prices
        // while the sequencer has been down — users can't submit txs, so
        // posted prices lag and create a restart-arb / liquidation-storm
        // window. When `sequencerUptimeFeed` is non-zero, OracleFacet
        // consults this Chainlink feed before every price read: if the
        // feed answer is 1 (sequencer DOWN) or the last status change
        // was within SEQUENCER_GRACE_PERIOD seconds (just recovered),
        // price reads revert. Set to `address(0)` on L1 / Ethereum
        // mainnet where no sequencer exists — skips the check.
        /// @dev Chainlink L2 Sequencer Uptime feed address (e.g., Base
        ///      mainnet: 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433).
        ///      Zero = check skipped (L1/mainnet deployments).
        address sequencerUptimeFeed;
        // ─── Per-Asset Pause (governance-controlled reserve pause) ──────
        // Governance can pause a specific asset without flipping the
        // protocol-wide pause. Creation paths (createOffer, acceptOffer,
        // addCollateral, refinance, preclose-offset) consult this map
        // via {LibFacet.requireAssetNotPaused}; exit paths (repay,
        // liquidate, triggerDefault, claim, withdraw, stake) always
        // remain callable so users can close out existing exposure on
        // an asset that is being wound down. Toggled via
        // {AdminFacet.pauseAsset} / {AdminFacet.unpauseAsset}.
        /// @dev `assetPaused[asset] == true` ⇒ new exposure through this
        ///      asset is blocked. Defaults to false for every asset.
        mapping(address => bool) assetPaused;
        // ─── Per-user reverse indexes for on-chain enumeration ──────────
        // Bot / indexer / frontend friendly: lets callers page through
        // every loan and offer a user has touched without scanning event
        // logs. Append-only: entries are never removed even after a loan
        // settles or an offer is cancelled, so historical reads stay
        // stable and the arrays can be treated as monotonic logs.
        // Filtering by current `LoanStatus` / `offerCancelled` is done at
        // read time in the paginated views.
        /// @dev Loans where the user is lender OR borrower. Pushed once
        ///      per side at {LoanFacet.initiateLoan}. Sequential IDs.
        mapping(address => uint256[]) userLoanIds;
        /// @dev Offers created by the user. Pushed once at
        ///      {OfferFacet.createOffer}. Sequential IDs.
        mapping(address => uint256[]) userOfferIds;
        /// @dev Explicit cancel flag. The `Offer.accepted` field is
        ///      reused by matching, so a distinct `offerCancelled` map
        ///      is required to represent the pre-accept cancelled state
        ///      without changing the `Offer` struct layout (append-only
        ///      rule). Reads: both `accepted` and `offerCancelled` are
        ///      terminal — either flag means the offer is no longer
        ///      matchable.
        mapping(uint256 => bool) offerCancelled;
        // ─── MetricsFacet O(1) analytics layer ──────────────────────────
        // Counters and active-set indices maintained by LibMetricsHooks
        // at every loan/offer lifecycle edge. Eliminates the MAX_ITER
        // silent-truncation pattern in MetricsFacet: aggregators become
        // O(1) reads and list views iterate active-set lists in
        // O(results) instead of scanning 1..nextId.
        //
        // Invariants (must hold across every tx boundary):
        //   • activeLoansCount == #{loanId : status ∈ {Active, FallbackPending}}
        //   • activeLoansCount == activeLoanIdsList.length
        //   • activeOffersCount == #{offerId : !accepted && !cancelled}
        //   • activeOffersCount == activeOfferIdsList.length
        //   • activeLoanIdsListPos[id] ∈ {0, 1..activeLoanIdsList.length};
        //     0 ⇔ id not in list; k ⇔ list[k-1] == id (1-based).
        //   • same for activeOfferIdsListPos.
        //   • userSeen[u] == true ⇒ u contributed to uniqueUserCount exactly
        //     once (idempotent _markUserSeen).
        //   • nftsInEscrowByCollection[c] == #{active loan legs valued in c
        //     where the leg asset type is not ERC20}.
        //   • loanIdByPositionTokenId[tokenId] points at the loan id whose
        //     lender- or borrower-position NFT has this tokenId; 0 if no
        //     active loan matches.
        //
        // Migration: these fields are append-only and safe to add on a
        // live diamond but will read zero until a one-time backfill walks
        // existing loans/offers and invokes the hooks retroactively.
        /// @dev Count of loans currently in {Active, FallbackPending}.
        uint256 activeLoansCount;
        /// @dev Monotone count of every loan ever initiated. Equals
        ///      nextLoanId on a diamond that has only ever created loans
        ///      via LoanFacet.initiateLoan.
        uint256 totalLoansEverCreated;
        /// @dev Count of loans currently in {Defaulted, Settled} — the
        ///      "loan ended badly or has been wound down" set that
        ///      MetricsFacet.getProtocolStats.defaultRateBps consumes.
        uint256 terminalBadOrSettledCount;
        /// @dev Σ interestRateBps across every loan ever initiated.
        ///      Divided by totalLoansEverCreated to yield averageAPR.
        uint256 interestRateBpsSum;
        /// @dev T-032 — cumulative VPFI debited from user escrows and
        ///      routed to treasury via `LoanFacet.markNotifBilled`.
        ///      Never decremented; the operator monitors this for
        ///      anomaly detection (a compromised NOTIF_BILLER_ROLE
        ///      could falsely bill, capped at the per-loan-side fee
        ///      but observable here as a spike).
        uint256 notificationFeesAccrued;
        /// @dev Count of offers currently not accepted and not cancelled.
        uint256 activeOffersCount;
        /// @dev Count of unique wallets that have ever created an offer
        ///      or participated in a loan as lender/borrower. Pure
        ///      lifetime counter — never decremented.
        uint256 uniqueUserCount;
        /// @dev Idempotency guard for `uniqueUserCount`.
        mapping(address => bool) userSeen;
        /// @dev Per-collection count of active loan legs whose asset type
        ///      is NFT (ERC721/ERC1155). An active loan with NFT principal
        ///      leg increments the principal collection; NFT collateral
        ///      leg increments the collateral collection. Both can
        ///      increment the same collection when the legs share it.
        mapping(address => uint256) nftsInEscrowByCollection;
        /// @dev Reverse map from Vaipakam position NFT id → loan id.
        ///      Populated at loan initiation for both lender and borrower
        ///      position NFTs. Stays set after the loan settles so
        ///      historical lookups still resolve; readers that require
        ///      liveness must check `loan.status` themselves.
        mapping(uint256 => uint256) loanIdByPositionTokenId;
        /// @dev Append-with-swap-pop list of active loan ids. Enables
        ///      O(results) iteration for MetricsFacet.getActiveLoansPaginated.
        uint256[] activeLoanIdsList;
        /// @dev 1-based position map for swap-and-pop removal.
        mapping(uint256 => uint256) activeLoanIdsListPos;
        /// @dev Active-offer analogue of `activeLoanIdsList`.
        uint256[] activeOfferIdsList;
        /// @dev 1-based position map for active-offer swap-and-pop.
        mapping(uint256 => uint256) activeOfferIdsListPos;
        // ─── ETH-referenced oracle / liquidity config ────────────────────
        // OracleFacet classifies an ERC-20 as Liquid via a v3-style AMM
        // asset/WETH 0.3% pool (the deepest quote layer across EVM
        // chains), converts depth to USD via the ETH/USD feed, and
        // prices assets with a hybrid rule: prefer a direct asset/USD
        // Chainlink feed; fall back to asset/ETH × ETH/USD when no
        // direct USD feed exists. On L2s where the Chainlink Feed
        // Registry is not deployed, `chainlnkRegistry` is address(0)
        // and both the USD and ETH Feed Registry lookups are skipped —
        // pricing flows through the direct `ethNumeraireFeed` address for
        // WETH and reverts with {NoPriceFeed} for other assets unless
        // the admin wires a per-asset direct feed (not yet exposed;
        // tracked in the follow-up).
        /// @dev AggregatorV3 address for ETH/USD (8 decimals). REQUIRED
        ///      for liquidity depth conversion and for pricing WETH
        ///      itself. Zero disables every ETH-quoted code path.
        address ethNumeraireFeed;
        /// @dev Chainlink Feed Registry ETH pseudo-address denominator
        ///      (mainnet: 0x0000...0000000EeeeE...). Used by
        ///      getAssetPrice to look up asset/ETH feeds as the USD
        ///      fallback. Zero on L2s and disables the asset/ETH
        ///      fallback path.
        address ethChainlinkDenominator;
        // ─── Generalized stablecoin peg registry ─────────────────────────
        // OracleFacet's peg-aware stale branch accepts a price as fresh
        // if the feed (8-decimal USD-quoted) reports within
        // ORACLE_PEG_TOLERANCE_BPS of the USD $1 anchor OR of any
        // registered fiat / commodity reference (EUR, JPY, XAU, etc.).
        // The reference feeds are Chainlink 8-decimal USD-quoted
        // aggregators; they are themselves subject to the 25h
        // ORACLE_STABLE_STALENESS ceiling (their heartbeats are also
        // 24h+), and are skipped in the peg loop if stale beyond that.
        //
        // symbol key is `bytes32(bytes(symbol))` with right-padded
        // zeroes — e.g. `"EUR" -> 0x4555520000...`. Registry is
        // maintained swap-and-pop so iteration is O(active symbols).
        /// @dev Fiat / commodity symbol → AggregatorV3 reference feed.
        mapping(bytes32 => address) stableFeedBySymbol;
        /// @dev Append-with-swap-pop list of registered symbols.
        bytes32[] stableFeedSymbolsList;
        /// @dev 1-based position map for swap-and-pop removal.
        mapping(bytes32 => uint256) stableFeedSymbolPos;
        // ─── Per-feed oracle override (Phase 3.1 hardening) ──────────────
        // Lets governance tighten `maxStaleness` and install a minimum-
        // valid-answer floor on individual Chainlink aggregators WITHOUT
        // redeploying. The two-tier global defaults (ORACLE_VOLATILE_
        // STALENESS / ORACLE_STABLE_STALENESS) remain the fallback — an
        // override is consulted only when `maxStaleness > 0`. Set via
        // `OracleAdminFacet.setFeedOverride` under ORACLE_ADMIN_ROLE,
        // which becomes timelock-gated after the governance handover.
        //
        // Use cases:
        //   - High-value collateral (BTC, ETH) feed gets a tighter 30-
        //     minute staleness to reduce the blind window vs the default
        //     2h volatile ceiling.
        //   - A feed known to occasionally return 1 wei during incidents
        //     gets a `minValidAnswer` floor so a bad read reverts rather
        //     than producing a fake "asset collapse" price.
        //   - An off-US-market-hours commodity feed gets a relaxed
        //     staleness to avoid false stalenesss reverts overnight.
        mapping(address => FeedOverride) feedOverrides;
        // ─── Address-level sanctions oracle (Phase 4.3) ─────────────────
        // Chainalysis operates a free on-chain sanctions oracle on every
        // chain it supports; governance sets this slot to the per-chain
        // oracle address via {ProfileFacet.setSanctionsOracle}. When the
        // slot is non-zero, {OfferFacet.createOffer} and
        // {OfferFacet.acceptOffer} both refuse calls from (or involving)
        // flagged addresses — the OFAC-aligned "no new business" posture.
        // Ongoing actions (repay, claim) stay unrestricted so existing
        // counterparties aren't stranded. `address(0)` disables the
        // check entirely, which is the correct state on chains where
        // Chainalysis does not deploy an oracle.
        address sanctionsOracle;
        // ─── Legal: Terms of Service acceptance (Phase 4.1) ──────────────
        // On-chain record of every wallet's acceptance of the current ToS
        // version. `currentTosVersion` starts at 0 (no ToS in force), which
        // the frontend treats as "gate disabled — app is still pre-launch
        // / testnet"; once governance sets `currentTosVersion >= 1` via
        // `LegalFacet.setCurrentTos`, every user wallet must sign an
        // `acceptTerms(version, hash)` tx before the frontend unlocks
        // `/app/*` routes. The version+hash pair in storage lets audit
        // tooling reconstruct exactly which ToS text a given user agreed
        // to and when.
        uint32 currentTosVersion;
        bytes32 currentTosHash;
        mapping(address => TosAcceptance) tosAcceptance;
        // ─── Phase 2 Interaction Reward Accrual (spec §4 daily) ─────────
        // Replaces the Phase-1 "lump-sum-at-settlement" accounting with
        // per-day accrual. Each loan, on {LoanFacet.initiateLoan},
        // contributes `perDayNumeraire18` to the running open-per-day counter
        // via a START-day delta. At close, a matching NEGATIVE delta is
        // stamped on the close day (exclusive endDay). The delta cursor
        // is advanced lazily by the reporter path when shipping day `d`
        // AND by the claim path when walking reward entries.
        //
        // Claim math: per-entry reward =
        //   perDayNumeraire18 × (cumRPN18[endDay-1] − cumRPN18[startDay-1]) / 1e18
        // where cumRPN18[d] = Σ_{d' ≤ d} halfPool[d'] × 1e18 / globalTotal[d'].
        // Global denominator comes from the finalized cross-chain
        // broadcast (`knownGlobal*InterestNumeraire18[d]`); cumRPN cannot advance
        // past days whose broadcast hasn't landed.
        //
        // Forfeit routing (user directive):
        //   - defaulted / liquidated / post-grace cured borrower
        //     → entry.forfeited = true, reward goes to treasury
        //   - early-withdrawal-sale initiator (the old lender at transfer)
        //     → entry.forfeited = true, reward goes to treasury
        // A permissionless {sweepForfeitedByLoanId} lets anyone push
        // already-closed forfeited entries into the treasury accumulator
        // (covers abandoned wallets that never claim).

        /// @dev Sequential id → RewardEntry.
        mapping(uint256 => RewardEntry) rewardEntries;
        /// @dev Monotone-increasing id allocator; 0 is the "unset" sentinel.
        uint256 nextRewardEntryId;
        /// @dev Append-only list of entry ids per user (lender + borrower).
        mapping(address => uint256[]) userRewardEntryIds;
        /// @dev Per-loan borrower entry id (0 ⇒ unset). A loan has at most
        ///      one borrower entry.
        mapping(uint256 => uint256) loanBorrowerEntryId;
        /// @dev Per-loan CURRENTLY-OPEN lender entry id (0 ⇒ unset). On
        ///      early-withdrawal transfer, this pointer is advanced to the
        ///      new lender's freshly forged entry; the prior entry is
        ///      closed with forfeit=true.
        mapping(uint256 => uint256) loanActiveLenderEntryId;
        /// @dev Net change applied to {lenderOpenPerDayNumeraire18} at the START
        ///      of day `d`. registerLoan bumps [startDay] up, closeLoan
        ///      bumps [endDay] down. Stored as int256 for the net-zero
        ///      symmetry on same-day register + close.
        mapping(uint256 => int256) lenderPerDayDeltaNumeraire18;
        /// @dev Mirror of {lenderPerDayDeltaNumeraire18} for the borrower side.
        ///      Clean / forfeit status is recorded on the RewardEntry, NOT
        ///      by reversing deltas — defaulted borrowers remain in the
        ///      denominator to keep the daily pool budget stable.
        mapping(uint256 => int256) borrowerPerDayDeltaNumeraire18;
        /// @dev Running sum of `perDayNumeraire18` across lender-side loans open
        ///      at {lenderFrontierDay}. Advanced by {advanceLenderThrough}.
        uint256 lenderOpenPerDayNumeraire18;
        /// @dev Running sum of `perDayNumeraire18` across borrower-side loans
        ///      open at {borrowerFrontierDay}.
        uint256 borrowerOpenPerDayNumeraire18;
        /// @dev Last day for which {totalLenderInterestNumeraire18}[d] has been
        ///      snapshotted from the delta walk. Advance must be called
        ///      before the reporter ships day `d`.
        uint256 lenderFrontierDay;
        /// @dev Mirror of {lenderFrontierDay} for the borrower side.
        uint256 borrowerFrontierDay;
        /// @dev cumRPN18[d] = cumulative VPFI-wei reward per 1e18 Numeraire18
        ///      through END of day `d`, using the GLOBAL (cross-chain)
        ///      denominator. Populated lazily by {advanceCumLenderThrough};
        ///      halts at the first day without `knownGlobalSet[d]`.
        mapping(uint256 => uint256) cumLenderRPN18;
        /// @dev Mirror of {cumLenderRPN18} for the borrower side.
        mapping(uint256 => uint256) cumBorrowerRPN18;
        /// @dev Last day through which {cumLenderRPN18} is populated
        ///      (contiguous from day 0). Day 0 cum = 0 (spec §4 exclusion).
        uint256 cumLenderCursor;
        /// @dev Mirror of {cumLenderCursor} for the borrower side.
        uint256 cumBorrowerCursor;
        /// @dev Admin-configurable protocol parameters (fees, VPFI tier
        ///      table, risk knobs). Zero fields fall back to their
        ///      `LibVaipakam` constant defaults — see {ProtocolConfig}
        ///      and the `cfg*` helpers below. Written exclusively through
        ///      {ConfigFacet} under ADMIN_ROLE (routed through the 48h
        ///      Timelock post-handover).
        ProtocolConfig protocolCfg;
        // ─── Borrower LIF discount claim bookkeeping (Phase 5 / §5.2b) ─
        /// @dev Per-loan custody + claimable rebate for the borrower
        ///      VPFI-path LIF. Keys are loan ids. A loan that took the
        ///      lending-asset path (no VPFI discount) never touches this
        ///      mapping — the zero struct reads correctly and settlement
        ///      helpers no-op on zero vpfiHeld.
        mapping(uint256 => BorrowerLifRebate) borrowerLifRebate;
        // ─── Phase 7a: liquidation swap adapter failover chain ──────────
        /// @dev Priority-ordered list of {ISwapAdapter} contracts.
        ///      {LibSwap.swapWithFailover} iterates from index 0 and
        ///      commits on the first adapter that returns proceeds
        ///      at least equal to the oracle-derived `minOutputAmount`.
        ///      Governance (AdminFacet, ADMIN_ROLE) maintains the list
        ///      via `addSwapAdapter` / `removeSwapAdapter` /
        ///      `reorderSwapAdapters`. An empty list reverts
        ///      {LibSwap.NoSwapAdaptersConfigured} — any deployment
        ///      that routes liquidations must populate this array
        ///      before the first loan settles.
        address[] swapAdapters;
        // ─── Phase 7b: multi-venue oracle liquidity check ───────────────
        /// @dev PancakeSwap V3 factory address on this chain. PancakeV3
        ///      is a Uniswap V3 fork — same `IUniswapV3Factory.getPool`
        ///      lookup, same `slot0()` / `liquidity()` pool views — so
        ///      the depth probe in {OracleFacet} can target it via the
        ///      identical helper used for UniswapV3. Governance sets
        ///      per-chain; null collapses the OR-combine to whichever
        ///      other factories are configured. PancakeV3's fee-tier
        ///      set differs slightly from UniV3 (uses 2500 in place of
        ///      3000) so the on-chain probe iterates a superset that
        ///      covers every clone.
        address pancakeswapV3Factory;
        /// @dev SushiSwap V3 factory address on this chain. Also a
        ///      Uniswap V3 fork; same probe semantics as PancakeV3.
        ///      Together with `uniswapV3Factory` and
        ///      `pancakeswapV3Factory`, gives the liquidity check 1-of-3
        ///      OR-redundancy without any per-asset governance config.
        address sushiswapV3Factory;
        // ─── Phase 7b.2: cross-provider price-feed redundancy ──────────
        /// @dev Tellor oracle address on this chain. Tellor is keyed
        ///      by 32-byte queryId derived from the asset's symbol via
        ///      `keccak256(abi.encode("SpotPrice", abi.encode(symbol,
        ///      "usd")))`. {OracleFacet} reads `asset.symbol()` on
        ///      demand, lowercases it, derives the queryId, and runs
        ///      a deviation check against the Chainlink primary.
        ///      Zero address disables the Tellor leg silently — the
        ///      primary still works, no revert. Per-asset governance
        ///      config is intentionally NOT present.
        address tellorOracle;
        /// @dev API3 ServerV1 address on this chain. API3 is keyed by
        ///      32-byte dapiName hash derived from the asset's symbol
        ///      via `keccak256(abi.encodePacked(bytes32(string(symbol,
        ///      "/USD"))))`. Same derivation pattern as Tellor; same
        ///      no-per-asset-config policy.
        address api3ServerV1;
        /// @dev DIA Oracle V2 address on this chain. DIA is keyed by
        ///      a string `<SYMBOL>/USD` (e.g. "ETH/USD"). {OracleFacet}
        ///      derives the key by reading `asset.symbol()` and
        ///      concatenating `/USD`. Same no-per-asset-config policy
        ///      as Tellor + API3.
        address diaOracleV2;
        /// @dev Maximum allowed deviation between the Chainlink
        ///      primary and any secondary oracle (Tellor / API3),
        ///      in basis points. Chain-level config — no per-asset
        ///      override. Defaults to 500 (5%) on a fresh deploy
        ///      until governance writes a non-zero value via
        ///      `setSecondaryOracleMaxDeviationBps`. Zero is treated
        ///      as "use the LibVaipakam.SECONDARY_ORACLE_MAX_DEVIATION_BPS_DEFAULT".
        uint16 secondaryOracleMaxDeviationBps;
        /// @dev Maximum acceptable secondary-oracle data age, in
        ///      seconds. Chain-level. Defaults to
        ///      `LibVaipakam.SECONDARY_ORACLE_MAX_STALENESS_DEFAULT`
        ///      when zero.
        uint40 secondaryOracleMaxStaleness;
        // ─── T-033 — Pyth as numeraire-redundancy oracle ───────────────
        //
        // Pyth was removed in Phase 7b.2 because a per-asset `priceId`
        // mapping conflicts with the no-per-asset-config policy. T-033
        // re-introduces it in a *numeraire-only* shape: one Pyth feed
        // per chain (ETH/USD or, on non-ETH-native chains, WETH/USD)
        // is consulted as a sanity gate alongside Chainlink's
        // ETH/USD reading. Per-asset redundancy stays the symbol-
        // derived Tellor / API3 / DIA secondary quorum — Pyth doesn't
        // replace it, just adds a single load-bearing-peg defense.

        /// @dev Pyth contract address on this chain. Zero disables
        ///      the numeraire gate silently — protocol falls back to
        ///      Chainlink-only on the WETH/USD reading. Same
        ///      "off-by-default-on-fresh-deploy" pattern as the other
        ///      secondary oracles.
        address pythOracle;
        /// @dev Pyth feed id for this chain's numeraire ETH/USD (or
        ///      bridged WETH/USD on chains where bridged WETH is the
        ///      unit of account, e.g. BNB / Polygon mainnet). Single
        ///      governance write per chain — adding new collateral
        ///      assets never touches this slot.
        bytes32 pythCrossCheckFeedId;
        /// @dev Maximum acceptable staleness (in seconds) for the
        ///      Pyth numeraire snapshot. Beyond this, the gate soft-
        ///      skips (treats Pyth as unavailable for this read);
        ///      Chainlink-only proceeds. Bounded to
        ///      `[PYTH_MAX_STALENESS_MIN_SECONDS,
        ///      PYTH_MAX_STALENESS_MAX_SECONDS]` by the setter.
        uint64 pythMaxStalenessSeconds;
        /// @dev Maximum tolerated divergence between Chainlink ETH/USD
        ///      and Pyth ETH/USD, in basis points (1 bp = 0.01%).
        ///      Beyond this, the price view fails-closed
        ///      (`OracleCrossCheckDivergence`). Bounded to
        ///      `[PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN,
        ///      PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX]` by the setter
        ///      so a misconfig can't accidentally halt the protocol
        ///      (zero) or effectively disable the gate (≥ 100%).
        uint16 pythCrossCheckMaxDeviationBps;
        /// @dev Maximum tolerated Pyth confidence fraction
        ///      (`conf / price`) in basis points. When the published
        ///      uncertainty exceeds this, the gate soft-skips Pyth
        ///      (the publisher window is too thin to trust). Bounded
        ///      to `[PYTH_CONFIDENCE_MAX_BPS_MIN,
        ///      PYTH_CONFIDENCE_MAX_BPS_MAX]` by the setter.
        uint16 pythConfidenceMaxBps;
        // ─── Per-Origin-Chain VPFI Fixed-Rate Wallet Caps ───────────────
        /// @dev Per-(buyer, originEid) running total of VPFI bought at
        ///      the fixed rate. Replaces the legacy
        ///      `vpfiFixedRateSoldTo[buyer]` global key — that flat
        ///      mapping is no longer written nor read by the buy /
        ///      bridged-buy paths (its slot is preserved only because
        ///      the Diamond storage layout is append-only).
        ///
        ///      Per docs/TokenomicsTechSpec.md §8a and README §
        ///      "Treasury and Revenue Sharing": the Phase 1
        ///      30K VPFI per-wallet cap is **per origin chain**, not
        ///      one shared global wallet cap. A user buying up to the
        ///      cap on one origin chain does not consume their cap on
        ///      another. For direct buys via {buyVPFIWithETH} the
        ///      `originEid` is the canonical chain's `localEid`; for
        ///      bridged buys via {processBridgedBuy} it is the
        ///      caller-asserted `originEid` argument carried from the
        ///      OFT message.
        mapping(address => mapping(uint32 => uint256)) vpfiFixedRateSoldToByEid;
        // ── Range Orders Phase 1 — match-override slot ─────────────────
        // Set by `OfferFacet.matchOffers` immediately before
        // cross-facet-calling `LoanFacet.initiateLoan`, read by
        // `LoanFacet._copyFinancialFields`, cleared at the end of the
        // matchOffers tx. Lets matchOffers inject the midpoint match
        // terms (amount / rateBps / collateralAmount) into the loan
        // without changing `LoanFacet.initiateLoan`'s signature. The
        // `active` flag distinguishes "matchOffers in flight" from
        // "legacy single-value path" — the latter never sets it, so
        // _copyFinancialFields falls back to reading offer.amount /
        // offer.interestRateBps / offer.collateralAmount as before
        // (auto-collapse keeps that semantically correct because in
        // single-value mode amountMax == amount).
        MatchOverride matchOverride;
        // ── T-044 — admin-configurable loan-default grace schedule ─────
        // Empty array (length == 0) means "use the compile-time default
        // schedule embedded in `gracePeriod()`" — zero-config-friendly.
        // Populated array overrides the defaults; entries must be sorted
        // ascending on `maxDurationDays`, with the final entry's
        // `maxDurationDays == 0` marking the catch-all bucket. Validated
        // by {ConfigFacet.setGraceBuckets} against
        // GRACE_BUCKETS_MAX_LEN / GRACE_BUCKET_DAYS_MIN/MAX /
        // GRACE_SECONDS_MIN/MAX before any write.
        GraceBucket[] graceBuckets;
    }

    /// @dev Range Orders Phase 1 — set by matchOffers, read by
    ///      LoanFacet._copyFinancialFields + OfferFacet._acceptOffer,
    ///      cleared post-match. See `Storage.matchOverride` for full
    ///      semantics. Carries both the concrete match terms (amount /
    ///      rateBps / collateralAmount) AND the address-resolution
    ///      override (counterparty / matcher) needed when matchOffers
    ///      processes a lender offer with msg.sender = bot rather than
    ///      a counterparty.
    struct MatchOverride {
        // Match terms read by LoanFacet._copyFinancialFields.
        uint256 amount;
        uint256 rateBps;
        uint256 collateralAmount;
        // Address-resolution override read by OfferFacet._acceptOffer.
        // counterparty: the OTHER party in the match (= the borrower
        // when matchOffers processes a lender offer). _acceptOffer
        // uses this in place of msg.sender for sanctions/country/KYC
        // checks + the borrower-resolution branch + the borrower
        // collateral pull (which is SKIPPED when override active
        // because the borrower already escrowed at borrower-offer
        // create time).
        address counterparty;
        // matcher: receives the 1% LIF kickback. Same as msg.sender on
        // the legacy acceptOffer path (set client-side from msg.sender
        // there), distinct from msg.sender on the matchOffers path.
        address matcher;
        bool active;
    }

    /// @dev Default secondary-oracle deviation tolerance: 5%.
    uint16 internal constant SECONDARY_ORACLE_MAX_DEVIATION_BPS_DEFAULT = 500;

    /// @dev Default secondary-oracle staleness: 1h.
    uint40 internal constant SECONDARY_ORACLE_MAX_STALENESS_DEFAULT = 3600;

    // ─── T-033 — Pyth numeraire-redundancy bounds ──────────────────────────
    //
    // Every Pyth knob is governance-tunable but bounded so a
    // compromised admin / governance multisig cannot push the value
    // to a degenerate setting that effectively disables the gate
    // (too-loose bounds) or fail-closes the protocol (too-tight
    // bounds). The setter on {OracleAdminFacet} reverts on out-of-
    // range writes with a `ParameterOutOfRange(name, value, min,
    // max)` error so failed governance proposals surface clearly.

    /// @dev Default deviation between Chainlink and Pyth ETH/USD
    ///      that's tolerated before {OracleCrossCheckDivergence}
    ///      fires: 5%. Pyth and Chainlink can naturally drift this
    ///      far in fast markets without either being compromised.
    uint16 internal constant PYTH_NUMERAIRE_MAX_DEVIATION_BPS_DEFAULT = 500;

    /// @dev Lower bound on the deviation tolerance — 1% (100 bps).
    ///      Tighter than this would fail-close on legitimate
    ///      cross-oracle drift and DoS the protocol. The bound
    ///      applies to setter writes; the runtime value is allowed
    ///      to be at the floor.
    uint16 internal constant PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN = 100;

    /// @dev Upper bound on the deviation tolerance — 20% (2000 bps).
    ///      Looser than this and the gate is effectively disabled
    ///      (a 20% peg-feed drift between independent oracles is
    ///      already unusual; a 30%+ drift is "one is compromised"
    ///      no matter how charitable the variance assumption).
    uint16 internal constant PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX = 2000;

    /// @dev Default Pyth confidence-fraction ceiling: 1% (100 bps).
    ///      `conf / price > 1%` → soft-skip Pyth on this read.
    uint16 internal constant PYTH_CONFIDENCE_MAX_BPS_DEFAULT = 100;

    /// @dev Lower bound on confidence ceiling — 0.5% (50 bps).
    ///      Tighter and Pyth gets soft-skipped too often (most
    ///      well-published feeds run conf < 0.3%, so 0.5% gives
    ///      headroom for fast markets without going opaque).
    uint16 internal constant PYTH_CONFIDENCE_MAX_BPS_MIN = 50;

    /// @dev Upper bound on confidence ceiling — 5% (500 bps).
    ///      Beyond this the "Pyth said the price is X" claim has
    ///      enough uncertainty that consulting it is meaningless.
    uint16 internal constant PYTH_CONFIDENCE_MAX_BPS_MAX = 500;

    /// @dev Default Pyth max-staleness: 5 min. Pyth's published
    ///      heartbeat on ETH/USD is sub-second on Base; 5min is a
    ///      generous "the publishers are at least breathing" bound.
    uint64 internal constant PYTH_MAX_STALENESS_DEFAULT_SECONDS = 300;

    /// @dev Lower bound on Pyth staleness budget — 1 min. Tighter
    ///      and a transient mempool jam soft-skips Pyth too often.
    uint64 internal constant PYTH_MAX_STALENESS_MIN_SECONDS = 60;

    /// @dev Upper bound on Pyth staleness budget — 1 h. Beyond this
    ///      Pyth is effectively cached forever and a stale-but-
    ///      manipulated reading could drive divergence outcomes.
    uint64 internal constant PYTH_MAX_STALENESS_MAX_SECONDS = 3600;

    // ─── Setter range audit (2026-05-02) — bounds for governance-tunable
    //     parameters that previously had no min/max. The shared
    //     `ParameterOutOfRange(name, value, min, max)` error in
    //     {IVaipakamErrors} is the load-bearing guard; even a
    //     compromised governance multisig cannot push these values
    //     beyond the policy range without a contract upgrade.

    /// @dev Tighter cap on the secondary-oracle deviation tolerance
    ///      (Tellor / API3 / DIA). Replaces the previous
    ///      `(0, BASIS_POINTS)` window — too wide. Same shape as the
    ///      Pyth gate.
    uint16 internal constant SECONDARY_ORACLE_MAX_DEVIATION_BPS_MIN = 100;
    uint16 internal constant SECONDARY_ORACLE_MAX_DEVIATION_BPS_MAX = 2000;

    /// @dev Bounds for {setSecondaryOracleMaxStaleness}. Previous
    ///      `!= 0` had no upper bound — a misconfig could allow
    ///      arbitrary stale data through the secondary quorum.
    ///      Upper at 29h leaves a 5h buffer above the 24h heartbeat
    ///      that some stablecoin price feeds (USDC, USDT) publish on
    ///      — tightening below 24h would soft-skip those feeds on
    ///      every legitimate update.
    uint40 internal constant SECONDARY_ORACLE_MAX_STALENESS_MIN_SECONDS = 60;
    uint40 internal constant SECONDARY_ORACLE_MAX_STALENESS_MAX_SECONDS =
        29 * 3600;

    /// @dev Bounds for {setRewardGraceSeconds}. Previous setter had
    ///      no bounds. Min 5 min so a transient outage can't be
    ///      confused with a real grace; max 30 days so the grace
    ///      window can't be set to "indefinite" (defeats the purpose).
    uint64 internal constant REWARD_GRACE_MIN_SECONDS = 300;
    uint64 internal constant REWARD_GRACE_MAX_SECONDS = 30 days;

    /// @dev Bounds for {setInteractionCapVpfiPerEth}. The setter's
    ///      `value` is "whole VPFI per ETH of eligible interest"
    ///      (NOT 1e18-scaled; spec default is `500`). Previously
    ///      unbounded — a compromised admin could push to absurd
    ///      ratios. Min 1 VPFI/ETH (effectively shuts down rewards
    ///      without flipping the disable sentinel); max 1,000,000
    ///      VPFI/ETH (above any realistic interaction-rate spec).
    ///      The two intentional sentinels documented on the setter
    ///      (`0` = reset-to-default, `type(uint256).max` = disable
    ///      cap emergency knob) are preserved as escape paths.
    uint256 internal constant INTERACTION_CAP_VPFI_PER_ETH_MIN = 1;
    uint256 internal constant INTERACTION_CAP_VPFI_PER_ETH_MAX = 1_000_000;

    /// @dev Bounds for {RiskFacet.updateRiskParams.maxLtvBps}. Min
    ///      10% — `maxLtv = 1` would effectively disable borrowing
    ///      for the asset. Upper bound stays at BASIS_POINTS via
    ///      the existing inline check.
    uint16 internal constant RISK_PARAMS_MAX_LTV_BPS_MIN = 1000;

    /// @dev Bounds for {RiskFacet.updateRiskParams.liqThresholdBps}.
    ///      Min 15%. The existing inline check enforces
    ///      `liqThreshold > maxLtv`, so the absolute floor only
    ///      kicks in for unrealistically-low maxLtv settings the
    ///      RISK_PARAMS_MAX_LTV_BPS_MIN already prevents.
    uint16 internal constant RISK_PARAMS_LIQ_THRESHOLD_BPS_MIN = 1500;

    /// @dev Bounds for {RiskFacet.updateRiskParams.reserveFactorBps}.
    ///      Max 50% — `reserveFactor = BASIS_POINTS` (100%) means
    ///      lender receives 0% interest, defeats the lending
    ///      product. Existing inline `≤ BASIS_POINTS` is replaced
    ///      by this tighter cap.
    uint16 internal constant RISK_PARAMS_RESERVE_FACTOR_BPS_MAX = 5000;

    /// @dev Bound for {ConfigFacet.setStakingApr}. Max 20% APR.
    ///      Previous `≤ BASIS_POINTS` (100%) is permissive but
    ///      unrealistic; protocol staking APRs even reaching 20% are
    ///      already very generous for VPFI staking, and a higher
    ///      cap is a governance-error vector rather than a feature.
    uint16 internal constant STAKING_APR_BPS_MAX = 2000;

    /// @dev Bounds for {ProfileFacet.updateKYCThresholds}. The
    ///      existing inline check enforces `tier0 < tier1`;
    ///      these bounds prevent governance from setting absurdly
    ///      low or high USD thresholds (denominated in 1e18).
    ///      KYC is OFF on the retail deploy (per CLAUDE.md), so
    ///      these bounds are belt-and-suspenders rather than
    ///      load-bearing on retail; on the industrial fork they
    ///      cap the tunable to a credible per-tier USD window.
    uint256 internal constant KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR = 100e18; // $100
    uint256 internal constant KYC_THRESHOLD_NUMERAIRE_MAX_CEIL = 1_000_000e18; // $1M

    uint256 internal constant MAX_APPROVED_KEEPERS = 5;

    // ─── Phase 6: Keeper action bitmask constants ────────────────────────────
    // Each keeper carries a `uint8` bitmask of actions they're authorised to
    // drive for a given NFT holder. Bits are OR'd together; up to 8 actions
    // (5 used today, 3 spare). The constants are `uint8` to match the
    // `approvedKeeperActions[user][keeper]` storage type and to keep mask
    // operations on the stack small.
    uint8 internal constant KEEPER_ACTION_COMPLETE_LOAN_SALE = 1 << 0; // 0x01
    uint8 internal constant KEEPER_ACTION_COMPLETE_OFFSET = 1 << 1; // 0x02
    uint8 internal constant KEEPER_ACTION_INIT_EARLY_WITHDRAW = 1 << 2; // 0x04
    uint8 internal constant KEEPER_ACTION_INIT_PRECLOSE = 1 << 3; // 0x08
    uint8 internal constant KEEPER_ACTION_REFINANCE = 1 << 4; // 0x10
    /// @dev All actions — convenience for "grant everything" UX flows.
    uint8 internal constant KEEPER_ACTION_ALL = 0x1F;

    /**
     * @notice Retrieves the Vaipakam storage slot.
     * @dev Uses assembly to load the struct at the predefined position.
     *      Used by all facets to access shared state.
     * @return s The Storage struct.
     */
    function storageSlot() internal pure returns (Storage storage s) {
        bytes32 position = VANGKI_STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }

    /// @dev Writes `user`'s ISO country code into shared storage. No
    ///      validation of the string here — the calling facet (ProfileFacet)
    ///      enforces length / normalization.
    /// @param user    Address whose country code to set.
    /// @param country ISO-3166 country code.
    function setUserCountry(address user, string memory country) internal {
        Storage storage s = storageSlot();
        s.userCountry[user] = country;
    }

    /// @dev Returns the KYC Tier-0 threshold in NUMERAIRE-units (1e18-
    ///      scaled). After Numeraire generalization (B1), `OracleFacet.getAssetPrice`
    ///      returns numeraire-quoted prices directly, so comparison
    ///      sites (`OfferFacet`, `RiskFacet`, `DefaultedFacet`) compute
    ///      `valueNumeraire` and compare against this return value
    ///      numeraire-vs-numeraire. The boundary conversion that lived
    ///      here under Phase 2 is removed — the numeraire abstraction
    ///      moved up to the oracle layer.
    function getKycTier0Threshold() internal view returns (uint256 threshold) {
        uint256 v = storageSlot().kycTier0ThresholdNumeraire;
        return v == 0 ? KYC_TIER0_THRESHOLD_NUMERAIRE : v;
    }

    /// @dev Returns the KYC Tier-1 threshold in NUMERAIRE-units (1e18-
    ///      scaled). Same shape as Tier-0 above. Numeraire generalization (B1).
    function getKycTier1Threshold() internal view returns (uint256 threshold) {
        uint256 v = storageSlot().kycTier1ThresholdNumeraire;
        return v == 0 ? KYC_TIER1_THRESHOLD_NUMERAIRE : v;
    }

    /// @dev Returns the effective per-user daily interaction-reward cap
    ///      (whole VPFI per 1 ETH of eligible interest). Falls back to
    ///      {INTERACTION_CAP_DEFAULT_VPFI_PER_ETH} when the admin override
    ///      is unset. A governance-stored `type(uint256).max` disables the
    ///      cap entirely (claim math short-circuits on that sentinel).
    /// @return cap Whole VPFI per 1 ETH ratio used to size the per-user
    ///             per-side per-day payout ceiling.
    function getInteractionCapVpfiPerEth() internal view returns (uint256 cap) {
        uint256 v = storageSlot().interactionCapVpfiPerEth;
        return v == 0 ? INTERACTION_CAP_DEFAULT_VPFI_PER_ETH : v;
    }

    // ─── ProtocolConfig getters (zero ⇒ constant default) ────────────
    // Every call site that previously referenced a `LibVaipakam.*_BPS`
    // constant should now route through one of these helpers so that
    // {ConfigFacet} can tune the value at runtime. Keep these in sync
    // with the `ProtocolConfig` struct layout above.

    function cfgTreasuryFeeBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.treasuryFeeBps;
        return v == 0 ? TREASURY_FEE_BPS : uint256(v);
    }

    function cfgLoanInitiationFeeBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.loanInitiationFeeBps;
        return v == 0 ? LOAN_INITIATION_FEE_BPS : uint256(v);
    }

    function cfgLiquidationHandlingFeeBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.liquidationHandlingFeeBps;
        return v == 0 ? LIQUIDATION_HANDLING_FEE_BPS : uint256(v);
    }

    function cfgMaxLiquidationSlippageBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.maxLiquidationSlippageBps;
        return v == 0 ? MAX_LIQUIDATION_SLIPPAGE_BPS : uint256(v);
    }

    function cfgMaxLiquidatorIncentiveBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.maxLiquidatorIncentiveBps;
        return v == 0 ? MAX_LIQUIDATOR_INCENTIVE_BPS : uint256(v);
    }

    function cfgVolatilityLtvThresholdBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.volatilityLtvThresholdBps;
        return v == 0 ? VOLATILITY_LTV_THRESHOLD_BPS : uint256(v);
    }

    function cfgRentalBufferBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.rentalBufferBps;
        return v == 0 ? RENTAL_BUFFER_BPS : uint256(v);
    }

    function cfgVpfiStakingAprBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.vpfiStakingAprBps;
        return v == 0 ? VPFI_STAKING_APR_BPS : uint256(v);
    }

    /// @dev Fallback-path split, with zero-is-default fall-through to the
    ///      compile-time constants. Callers at `initiateLoan` read these
    ///      once to snapshot onto the `Loan`; settlement (`LibFallback`)
    ///      reads from the loan's snapshot fields, not from here.
    function cfgFallbackLenderBonusBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.fallbackLenderBonusBps;
        return v == 0 ? FALLBACK_LENDER_BONUS_BPS : uint256(v);
    }

    function cfgFallbackTreasuryBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.fallbackTreasuryBps;
        return v == 0 ? FALLBACK_TREASURY_BPS : uint256(v);
    }

    /// @dev Range Orders Phase 1 — matcher's slice of any LIF that
    ///      flows to treasury, in BPS. Governance-tunable via
    ///      `ConfigFacet.setLifMatcherFeeBps`; falls back to the
    ///      LIF_MATCHER_FEE_BPS constant (100 = 1%) when unset.
    function cfgLifMatcherFeeBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.lifMatcherFeeBps;
        return v == 0 ? LIF_MATCHER_FEE_BPS : uint256(v);
    }

    /// @dev Phase 1 follow-up — auto-pause duration (seconds) used by
    ///      `LibPausable.autoPause`. Governance-tunable via
    ///      `ConfigFacet.setAutoPauseDurationSeconds` within
    ///      [MIN_AUTO_PAUSE_SECONDS, MAX_AUTO_PAUSE_SECONDS]. Falls
    ///      back to AUTO_PAUSE_DURATION_DEFAULT (1800 = 30 min)
    ///      when unset.
    function cfgAutoPauseDurationSeconds() internal view returns (uint256) {
        uint32 v = storageSlot().protocolCfg.autoPauseDurationSeconds;
        return v == 0 ? AUTO_PAUSE_DURATION_DEFAULT : uint256(v);
    }

    /// @dev Maximum offer duration in days (Findings 00025).
    ///      Governance-tunable via `ConfigFacet.setMaxOfferDurationDays`
    ///      within [MIN_OFFER_DURATION_DAYS_FLOOR,
    ///      MAX_OFFER_DURATION_DAYS_CEIL]. Falls back to
    ///      MAX_OFFER_DURATION_DAYS_DEFAULT (365) when unset.
    function cfgMaxOfferDurationDays() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.maxOfferDurationDays;
        return v == 0 ? MAX_OFFER_DURATION_DAYS_DEFAULT : uint256(v);
    }

    /// @dev T-032 / Numeraire generalization (Phase 1) — Notification fee in NUMERAIRE
    ///      units (1e18 scaled). Governance-tunable via
    ///      `ConfigFacet.setNotificationFee` within
    ///      [MIN_NOTIFICATION_FEE_FLOOR, MAX_NOTIFICATION_FEE_CEIL].
    ///      Falls back to `NOTIFICATION_FEE_DEFAULT` (2.0 numeraire-units
    ///      = $2 under USD-as-numeraire) when unset. The numeraire-to-USD
    ///      conversion happens at the `LibNotificationFee.vpfiAmountForFee`
    ///      boundary so the stored value can be re-anchored when
    ///      governance rotates the numeraire.
    function cfgNotificationFee() internal view returns (uint256) {
        uint256 v = storageSlot().protocolCfg.notificationFee;
        return v == 0 ? NOTIFICATION_FEE_DEFAULT : v;
    }

    /// @dev Returns the four tier thresholds (T1 min, T2 min, T3 min, T4 min-exclusive).
    function cfgVpfiTierThresholds()
        internal
        view
        returns (uint256 t1, uint256 t2, uint256 t3, uint256 t4Excl)
    {
        ProtocolConfig storage c = storageSlot().protocolCfg;
        t1 = c.vpfiTier1Min == 0 ? VPFI_TIER1_MIN : c.vpfiTier1Min;
        t2 = c.vpfiTier2Min == 0 ? VPFI_TIER2_MIN : c.vpfiTier2Min;
        t3 = c.vpfiTier3Min == 0 ? VPFI_TIER3_MIN : c.vpfiTier3Min;
        t4Excl = c.vpfiTier4Threshold == 0
            ? VPFI_TIER4_THRESHOLD
            : c.vpfiTier4Threshold;
    }

    /// @dev Discount BPS for a tier index 1..4. Tier 0 is always zero.
    function cfgVpfiTierDiscountBps(
        uint8 tier
    ) internal view returns (uint256) {
        if (tier == 0) return 0;
        ProtocolConfig storage c = storageSlot().protocolCfg;
        if (tier == 4)
            return
                c.vpfiTier4DiscountBps == 0
                    ? VPFI_TIER4_DISCOUNT_BPS
                    : uint256(c.vpfiTier4DiscountBps);
        if (tier == 3)
            return
                c.vpfiTier3DiscountBps == 0
                    ? VPFI_TIER3_DISCOUNT_BPS
                    : uint256(c.vpfiTier3DiscountBps);
        if (tier == 2)
            return
                c.vpfiTier2DiscountBps == 0
                    ? VPFI_TIER2_DISCOUNT_BPS
                    : uint256(c.vpfiTier2DiscountBps);
        if (tier == 1)
            return
                c.vpfiTier1DiscountBps == 0
                    ? VPFI_TIER1_DISCOUNT_BPS
                    : uint256(c.vpfiTier1DiscountBps);
        return 0;
    }

    /// @dev Effective global cap on the fixed-rate VPFI buy. A stored zero
    ///      resolves to the spec default {VPFI_FIXED_GLOBAL_CAP} (2.3M VPFI,
    ///      docs/TokenomicsTechSpec.md §8). There is no "uncapped" state —
    ///      the spec forbids surfacing the buy as unlimited.
    function cfgVpfiFixedGlobalCap() internal view returns (uint256) {
        uint256 v = storageSlot().vpfiFixedRateGlobalCap;
        return v == 0 ? VPFI_FIXED_GLOBAL_CAP : v;
    }

    /// @dev Effective per-wallet cap on the fixed-rate VPFI buy. A stored
    ///      zero resolves to the spec default {VPFI_FIXED_WALLET_CAP} (30k
    ///      VPFI, docs/TokenomicsTechSpec.md §8a). There is no "uncapped"
    ///      state; the Buy VPFI page renders this same effective value
    ///      directly (no frontend fallback).
    function cfgVpfiFixedWalletCap() internal view returns (uint256) {
        uint256 v = storageSlot().vpfiFixedRatePerWalletCap;
        return v == 0 ? VPFI_FIXED_WALLET_CAP : v;
    }

    /// @dev Duration-tiered grace period used by DefaultedFacet, RepayFacet,
    ///      RiskFacet. T-044 made the schedule admin-configurable; when
    ///      `Storage.graceBuckets` is empty (the post-deploy default) this
    ///      function falls back to the original compile-time schedule
    ///      below, extended with a new ≥ 365 days bucket per T-044's spec.
    ///
    ///      Default schedule (used when `graceBuckets.length == 0`):
    ///        durationDays < 7    → 1 hour
    ///        durationDays < 30   → 1 day
    ///        durationDays < 90   → 3 days
    ///        durationDays < 180  → 1 week
    ///        durationDays < 365  → 2 weeks
    ///        durationDays >= 365 → 30 days   (T-044 — new bucket)
    ///
    ///      Configured-array semantics: walk buckets in storage order; the
    ///      first bucket whose `maxDurationDays > durationDays` wins. The
    ///      final bucket carries `maxDurationDays == 0` as the catch-all
    ///      marker. Setter validation (see ConfigFacet.setGraceBuckets)
    ///      guarantees the array is sorted, monotonic, and fully bounded.
    ///
    ///      Note: this used to be `pure`. T-044 changed it to `view`
    ///      because it now reads `s.graceBuckets`. Every existing caller
    ///      is `view` or `nonpayable` — no signature impact downstream.
    /// @param durationDays Loan duration in days.
    /// @return grace Grace period in seconds.
    function gracePeriod(
        uint256 durationDays
    ) internal view returns (uint256 grace) {
        GraceBucket[] storage buckets = storageSlot().graceBuckets;
        uint256 len = buckets.length;
        if (len == 0) {
            // Compile-time default schedule (T-044 extended).
            if (durationDays < 7) return 1 hours;
            if (durationDays < 30) return 1 days;
            if (durationDays < 90) return 3 days;
            if (durationDays < 180) return 1 weeks;
            if (durationDays < 365) return 2 weeks;
            return 30 days;
        }
        // Storage-driven path. Last entry's maxDurationDays == 0 marks
        // the catch-all; any bucket whose threshold strictly exceeds
        // durationDays wins, walked in array order.
        for (uint256 i = 0; i < len; i++) {
            uint256 maxD = buckets[i].maxDurationDays;
            if (maxD == 0) return buckets[i].graceSeconds;
            if (durationDays < maxD) return buckets[i].graceSeconds;
        }
        // Defensive fallback — setter validation prevents reaching here
        // (every valid array ends in a maxDurationDays == 0 catch-all),
        // but if storage is somehow malformed return the last entry's
        // grace rather than reverting.
        return buckets[len - 1].graceSeconds;
    }

    /// @notice T-034 — interval-in-days lookup for a cadence enum value.
    /// @dev Pure helper (no storage reads) so callers can fold it inline
    ///      cheaply. Returns 0 for `None` (the no-cadence sentinel) so
    ///      arithmetic that adds the result to a timestamp short-circuits
    ///      to "no checkpoint" automatically. See
    ///      docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §2.4.
    function intervalDays(
        PeriodicInterestCadence cadence
    ) internal pure returns (uint256) {
        if (cadence == PeriodicInterestCadence.Monthly)
            return PERIODIC_INTERVAL_MONTHLY_DAYS;
        if (cadence == PeriodicInterestCadence.Quarterly)
            return PERIODIC_INTERVAL_QUARTERLY_DAYS;
        if (cadence == PeriodicInterestCadence.SemiAnnual)
            return PERIODIC_INTERVAL_SEMI_ANNUAL_DAYS;
        if (cadence == PeriodicInterestCadence.Annual)
            return PERIODIC_INTERVAL_ANNUAL_DAYS;
        return 0; // None
    }

    /// @notice External view exposing the current grace-bucket schedule.
    ///         Returns an empty array when storage is unconfigured (the
    ///         compile-time defaults in `gracePeriod()` are in force).
    /// @dev Read by the admin console's GraceBucketsCard via
    ///      ConfigFacet.getGraceBuckets — kept here as a library helper
    ///      so callers don't have to know storage layout.
    function getGraceBucketsConfigured()
        internal
        view
        returns (GraceBucket[] memory)
    {
        return storageSlot().graceBuckets;
    }

    /// @notice Per-slot policy bounds for the fixed 6-slot grace schedule
    ///         (T-044). Returns the inclusive bounds the setter validates
    ///         each slot against; the admin console reads the same view
    ///         to render per-row min/max hints.
    ///
    ///         Slot semantics:
    ///         | Slot | Default tier | maxDays bounds | grace bounds |
    ///         |------|--------------|----------------|--------------|
    ///         | 0    | < 7 days     | [1, 14]        | [1h,  5d]    |
    ///         | 1    | < 30 days    | [7, 60]        | [1h, 15d]    |
    ///         | 2    | < 90 days    | [30, 180]      | [1d, 30d]    |
    ///         | 3    | < 180 days   | [90, 270]      | [3d, 45d]    |
    ///         | 4    | < 365 days   | [180, 540]     | [7d, 60d]    |
    ///         | 5    | catch-all    | (must == 0)    | [14d, 90d]   |
    ///
    /// @param slot 0-indexed slot id (must be < GRACE_BUCKETS_FIXED_COUNT).
    /// @return minDays Lower bound on `maxDurationDays` for this slot.
    ///         For slot 5 (catch-all) returns 0 to indicate the only
    ///         legal value is 0.
    /// @return maxDays Upper bound on `maxDurationDays`. For slot 5
    ///         returns 0 to enforce the catch-all marker.
    /// @return minGrace Lower bound on `graceSeconds` for this slot.
    /// @return maxGrace Upper bound on `graceSeconds` for this slot.
    function graceSlotBounds(
        uint256 slot
    )
        internal
        pure
        returns (
            uint256 minDays,
            uint256 maxDays,
            uint256 minGrace,
            uint256 maxGrace
        )
    {
        if (slot == 0) return (1, 14, 1 hours, 5 days);
        if (slot == 1) return (7, 60, 1 hours, 15 days);
        if (slot == 2) return (30, 180, 1 days, 30 days);
        if (slot == 3) return (90, 270, 3 days, 45 days);
        if (slot == 4) return (180, 540, 7 days, 60 days);
        if (slot == 5) return (0, 0, 14 days, 90 days);
        revert("graceSlotBounds: slot out of range");
    }

    /// @dev Late fee schedule: 1% on the first day past due, +0.5% each
    ///      subsequent day, capped at 5% of principal. Returns 0 when the
    ///      loan is still within `endTime`.
    /// @param loanId  Loan id.
    /// @param endTime Unix timestamp at which the loan's duration expires.
    /// @return fee    Late fee in principal units (BPS-scaled).
    function calculateLateFee(
        uint256 loanId,
        uint256 endTime
    ) internal view returns (uint256 fee) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (block.timestamp <= endTime) return 0;

        uint256 daysLate = (block.timestamp - endTime) / 1 days;
        uint256 feePercent = 100 + (daysLate * 50); // 1% + 0.5% per day (in basis points)
        if (feePercent > 500) feePercent = 500; // Cap 5%

        return (loan.principal * feePercent) / 10000; // Basis points
    }

    /**
     * @notice Sets trade allowance between two countries (owner-only).
     * @dev Bidirectional by default (sets both A->B and B->A); for asymmetric, call twice.
     *      Uses keccak256 for string hashing to save gas.
     *      Callable via a facet (e.g., ProfileFacet) by Diamond owner.
     * @param countryA ISO code for country A.
     * @param countryB ISO code for country B.
     * @param allowed True to allow trade, false to block.
     */
    function setTradeAllowance(
        string memory countryA,
        string memory countryB,
        bool allowed
    ) internal {
        // Access control enforced by calling facet via onlyRole modifier
        Storage storage s = storageSlot();
        bytes32 hashA = keccak256(bytes(countryA));
        bytes32 hashB = keccak256(bytes(countryB));
        s.allowedTrades[hashA][hashB] = allowed;
        s.allowedTrades[hashB][hashA] = allowed; // Bidirectional; remove if asymmetric needed
    }

    /**
     * @notice Checks if two countries can trade.
     * @dev PHASE 1 BEHAVIOR: country-pair restrictions are disabled at the
     *      protocol level. This always returns `true` regardless of the
     *      `allowedTrades` mapping, so any two users may transact
     *      irrespective of the countries stored on their profiles. The
     *      mapping and its setter {setTradeAllowance} are preserved so
     *      governance can re-activate pair-based sanctions in Phase 2
     *      without a storage migration — callers should treat the return
     *      value as load-bearing even though it's a no-op today.
     *      (silences unused-parameter warnings — `countryA` / `countryB`
     *      are read in the Phase-2 branch below.)
     * @param countryA ISO code for country A.
     * @param countryB ISO code for country B.
     * @return canTrade Always `true` in Phase 1.
     */
    function canTradeBetween(
        string memory countryA,
        string memory countryB
    ) internal pure returns (bool canTrade) {
        countryA;
        countryB;
        return true;
    }

    /**
     * @notice Gated, default-DENY country-pair check. Returns `true` only
     *         when governance has explicitly whitelisted the pair via
     *         {setTradeAllowance}; an unset entry (and self-trade) is
     *         denied.
     * @dev    NOT used by the retail Vaipakam deploy. The retail flow goes
     *         through {canTradeBetween} which is hardcoded to `true`.
     *         This helper exists for two reasons:
     *           1. The industrial-fork variant of the protocol switches
     *              the gate on without a storage-layout migration; that
     *              fork's facets call this function instead of the pure
     *              one.
     *           2. Test coverage: `CountryPairGatedTest` exercises the
     *              storage-driven semantics (whitelist, symmetry, missing
     *              pair => deny) so the gated branch stays truthful even
     *              while it's dormant on retail.
     *         Both helpers share the same `s.allowedTrades` storage —
     *         {setTradeAllowance} writes are visible to both, so the
     *         retail deploy can ship pre-populated whitelists for a
     *         later cutover without rewriting the setter API.
     * @param  countryA ISO-3166 alpha-2 / alpha-3 code (whatever the
     *         operator standardised on; comparison is keccak-by-bytes).
     * @param  countryB Same encoding as `countryA`.
     * @return canTrade  `true` iff `s.allowedTrades[hashA][hashB]` is set.
     */
    function _canTradeBetweenStorageGated(
        string memory countryA,
        string memory countryB
    ) internal view returns (bool canTrade) {
        Storage storage s = storageSlot();
        bytes32 hashA = keccak256(bytes(countryA));
        bytes32 hashB = keccak256(bytes(countryB));
        return s.allowedTrades[hashA][hashB];
    }

    /// @dev Set the Chainlink Feed Registry USD denominator. Owner-only.
    ///      Setting to `address(0)` forces {OracleFacet.getAssetPrice} down
    ///      the NoPriceFeed branch.
    /// @param newUsdChainlinkDenominator USD-denominator address registered
    ///        in the Chainlink Feed Registry (typically the canonical USD
    ///        pseudo-address).
    function setUsdChainlinkDenominator(
        address newUsdChainlinkDenominator
    ) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.numeraireChainlinkDenominator = newUsdChainlinkDenominator;
    }

    /// @dev Set the Chainlink Feed Registry contract used by OracleFacet.
    ///      Owner-only. Setting to `address(0)` disables price lookups.
    /// @param newChainlnkRegistry Chainlink Feed Registry contract address.
    function setChainlinkRegistry(address newChainlnkRegistry) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.chainlnkRegistry = newChainlnkRegistry;
    }

    /// @dev Set the canonical WETH ERC-20 used by OracleFacet as the
    ///      v3-style AMM pool-depth quote asset. Owner-only. Setting to
    ///      `address(0)` fail-closes every asset to Illiquid.
    /// @param newWethContract WETH ERC-20 contract address on the active
    ///        network.
    function setWethContract(address newWethContract) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.wethContract = newWethContract;
    }

    /// @dev Set the direct Chainlink ETH/USD AggregatorV3 feed. Owner-only.
    ///      REQUIRED — used by OracleFacet to price WETH itself and to
    ///      convert asset/WETH pool depth into USD. Setting to `address(0)`
    ///      disables every ETH-quoted code path (WETH pricing, depth
    ///      conversion, asset/ETH fallback price).
    /// @param newEthUsdFeed Chainlink ETH/USD aggregator contract address.
    function setEthUsdFeed(address newEthUsdFeed) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.ethNumeraireFeed = newEthUsdFeed;
    }

    /// @dev Set the Chainlink Feed Registry ETH-denominator pseudo-address
    ///      used by OracleFacet's asset/ETH fallback price path. Owner-only.
    ///      Zero on L2s where the Feed Registry does not exist —
    ///      disables the ETH-route fallback (assets without a direct
    ///      asset/USD feed revert NoPriceFeed).
    /// @param newEthChainlinkDenominator ETH-denominator address recognised
    ///        by the Chainlink Feed Registry.
    function setEthChainlinkDenominator(
        address newEthChainlinkDenominator
    ) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.ethChainlinkDenominator = newEthChainlinkDenominator;
    }

    /// @dev Register / replace / deregister a fiat or commodity peg
    ///      reference feed for OracleFacet's generalized peg-aware stable
    ///      staleness branch. Owner-only. `symbol` is the short ticker
    ///      ("USD" — implicit, do not register; "EUR", "JPY", "XAU",
    ///      "GBP", etc.), case-sensitive and up to 32 bytes.
    ///
    ///      Semantics:
    ///        - feed != 0 and symbol unknown → append to registry
    ///        - feed != 0 and symbol known   → update reference feed
    ///        - feed == 0 and symbol known   → remove via swap-and-pop
    ///        - feed == 0 and symbol unknown → no-op
    /// @param symbol Short fiat / commodity ticker (e.g. "EUR").
    /// @param feed   Chainlink aggregator for `<symbol>/USD` (8 decimals).
    function setStableTokenFeed(string memory symbol, address feed) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        bytes32 key = bytes32(bytes(symbol));
        uint256 pos = s.stableFeedSymbolPos[key];
        if (feed == address(0)) {
            if (pos == 0) return;
            uint256 lastIdx = s.stableFeedSymbolsList.length - 1;
            uint256 idx = pos - 1;
            if (idx != lastIdx) {
                bytes32 last = s.stableFeedSymbolsList[lastIdx];
                s.stableFeedSymbolsList[idx] = last;
                s.stableFeedSymbolPos[last] = idx + 1;
            }
            s.stableFeedSymbolsList.pop();
            delete s.stableFeedSymbolPos[key];
            delete s.stableFeedBySymbol[key];
            return;
        }
        s.stableFeedBySymbol[key] = feed;
        if (pos == 0) {
            s.stableFeedSymbolsList.push(key);
            s.stableFeedSymbolPos[key] = s.stableFeedSymbolsList.length;
        }
    }

    /// @dev Set the v3-style AMM factory used by OracleFacet's liquidity
    ///      classification. Owner-only. Setting to `address(0)` fail-closes
    ///      every asset to Illiquid.
    /// @param newUniswapV3Factory v3-style AMM factory contract address.
    function setUniswapV3Factory(address newUniswapV3Factory) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.uniswapV3Factory = newUniswapV3Factory;
    }

    /// @dev Set the Chainlink L2 Sequencer Uptime feed used by
    ///      OracleFacet as a circuit breaker before every price read.
    ///      Owner-only. Setting to `address(0)` disables the check —
    ///      correct for L1/Ethereum mainnet where no sequencer exists.
    ///      On L2s (Base/Arb/OP) this MUST be set to the canonical
    ///      sequencer uptime feed at deploy time.
    /// @param newFeed Chainlink L2 Sequencer Uptime feed address.
    function setSequencerUptimeFeed(address newFeed) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.sequencerUptimeFeed = newFeed;
    }

    /// @notice Emitted whenever a per-feed oracle override is installed or
    ///         cleared. Off-chain monitoring watches this so a governance-
    ///         driven freshness tightening is publicly observable.
    /// @param feed           Chainlink aggregator address the override
    ///                       applies to.
    /// @param maxStaleness   New max age in seconds (0 = cleared).
    /// @param minValidAnswer New minimum-valid-answer floor (0/negative =
    ///                       no floor).
    event FeedOverrideSet(
        address indexed feed,
        uint40 maxStaleness,
        int256 minValidAnswer
    );

    /// @notice Installs or clears a per-feed staleness + min-answer
    ///         override for a specific Chainlink aggregator.
    /// @dev Owner-only. After the governance handover the owner is the
    ///      TimelockController, so every override change is 48h-gated
    ///      and publicly observable via `CallScheduled` on the timelock.
    ///      Passing `maxStaleness == 0` clears BOTH fields regardless of
    ///      the `minValidAnswer` argument — it's the "remove the
    ///      override entirely" escape hatch.
    /// @param feed           Chainlink aggregator to configure.
    /// @param maxStaleness   Max acceptable age in seconds. 0 clears.
    /// @param minValidAnswer Floor on the raw answer the aggregator
    ///                       returns; in the aggregator's decimals.
    ///                       Pass 0 (or a negative int) for no floor.
    function setFeedOverride(
        address feed,
        uint40 maxStaleness,
        int256 minValidAnswer
    ) internal {
        LibDiamond.enforceIsContractOwner();
        if (feed == address(0)) revert IVaipakamErrors.InvalidAddress();
        Storage storage s = storageSlot();
        FeedOverride storage ovr = s.feedOverrides[feed];
        if (maxStaleness == 0) {
            // Clear both fields — explicit "remove override" action.
            ovr.maxStaleness = 0;
            ovr.minValidAnswer = 0;
            emit FeedOverrideSet(feed, 0, 0);
            return;
        }
        ovr.maxStaleness = maxStaleness;
        ovr.minValidAnswer = minValidAnswer;
        emit FeedOverrideSet(feed, maxStaleness, minValidAnswer);
    }

    // ─── Phase 7b.2: Tellor + API3 + chain-level secondary config ──

    /// @notice Emitted when the chain's Tellor oracle address changes.
    event TellorOracleSet(address indexed previous, address indexed next);

    /// @notice Emitted when the chain's API3 ServerV1 address changes.
    event Api3ServerV1Set(address indexed previous, address indexed next);

    /// @notice Emitted when the chain's DIA Oracle V2 address changes.
    event DIAOracleV2Set(address indexed previous, address indexed next);

    /// @notice Emitted when the chain-level secondary-oracle deviation
    ///         tolerance changes. Off-chain monitors should alert on
    ///         transitions: a wider tolerance weakens the cross-
    ///         provider check.
    event SecondaryOracleMaxDeviationBpsSet(uint16 previous, uint16 current);

    /// @notice Emitted when the chain-level secondary-oracle staleness
    ///         tolerance changes.
    event SecondaryOracleMaxStalenessSet(uint40 previous, uint40 current);

    /// @notice Install the chain's Tellor oracle address. Owner-only;
    ///         null disables Tellor's leg of the price-feed deviation
    ///         check globally.
    function setTellorOracle(address oracle) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.tellorOracle;
        s.tellorOracle = oracle;
        emit TellorOracleSet(prev, oracle);
    }

    /// @notice Install the chain's API3 ServerV1 address. Owner-only;
    ///         null disables API3's leg of the deviation check globally.
    function setApi3ServerV1(address server) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.api3ServerV1;
        s.api3ServerV1 = server;
        emit Api3ServerV1Set(prev, server);
    }

    /// @notice Install the chain's DIA Oracle V2 address. Owner-only;
    ///         null disables DIA's leg of the deviation check globally.
    function setDIAOracleV2(address oracle) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.diaOracleV2;
        s.diaOracleV2 = oracle;
        emit DIAOracleV2Set(prev, oracle);
    }

    /// @notice Set the chain-level deviation tolerance applied to
    ///         every secondary oracle (Tellor / API3 / DIA) when it
    ///         disagrees with the Chainlink primary.
    /// @dev    Setter-range audit (2026-05-02): tightened from the
    ///         original `(0, BASIS_POINTS)` window to
    ///         `[SECONDARY_ORACLE_MAX_DEVIATION_BPS_MIN,
    ///         SECONDARY_ORACLE_MAX_DEVIATION_BPS_MAX]` so a
    ///         compromised governance multisig cannot push the
    ///         tolerance to a degenerate setting (1 bps fail-closes
    ///         every legitimate cross-oracle drift; 9999 effectively
    ///         disables the gate).
    function setSecondaryOracleMaxDeviationBps(uint16 bps) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            bps < SECONDARY_ORACLE_MAX_DEVIATION_BPS_MIN ||
            bps > SECONDARY_ORACLE_MAX_DEVIATION_BPS_MAX
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "secondaryOracleMaxDeviationBps",
                uint256(bps),
                uint256(SECONDARY_ORACLE_MAX_DEVIATION_BPS_MIN),
                uint256(SECONDARY_ORACLE_MAX_DEVIATION_BPS_MAX)
            );
        }
        Storage storage s = storageSlot();
        uint16 prev = s.secondaryOracleMaxDeviationBps;
        s.secondaryOracleMaxDeviationBps = bps;
        emit SecondaryOracleMaxDeviationBpsSet(prev, bps);
    }

    /// @notice Set the chain-level secondary-oracle staleness tolerance
    ///         in seconds.
    /// @dev    Setter-range audit (2026-05-02): added upper bound.
    ///         Previously only `!= 0` — a misconfig could allow
    ///         arbitrary stale data through the secondary quorum,
    ///         defeating the freshness gate.
    function setSecondaryOracleMaxStaleness(uint40 maxStaleness) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            maxStaleness < SECONDARY_ORACLE_MAX_STALENESS_MIN_SECONDS ||
            maxStaleness > SECONDARY_ORACLE_MAX_STALENESS_MAX_SECONDS
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "secondaryOracleMaxStaleness",
                uint256(maxStaleness),
                uint256(SECONDARY_ORACLE_MAX_STALENESS_MIN_SECONDS),
                uint256(SECONDARY_ORACLE_MAX_STALENESS_MAX_SECONDS)
            );
        }
        Storage storage s = storageSlot();
        uint40 prev = s.secondaryOracleMaxStaleness;
        s.secondaryOracleMaxStaleness = maxStaleness;
        emit SecondaryOracleMaxStalenessSet(prev, maxStaleness);
    }

    /// @notice Read the effective deviation tolerance — falls back to
    ///         the package default when no value is configured.
    function effectiveSecondaryOracleMaxDeviationBps()
        internal
        view
        returns (uint16)
    {
        uint16 v = storageSlot().secondaryOracleMaxDeviationBps;
        return v == 0 ? SECONDARY_ORACLE_MAX_DEVIATION_BPS_DEFAULT : v;
    }

    /// @notice Read the effective staleness tolerance — falls back to
    ///         the package default when no value is configured.
    function effectiveSecondaryOracleMaxStaleness()
        internal
        view
        returns (uint40)
    {
        uint40 v = storageSlot().secondaryOracleMaxStaleness;
        return v == 0 ? SECONDARY_ORACLE_MAX_STALENESS_DEFAULT : v;
    }

    // ─── T-033 — Pyth setters + readers with bounded ranges ────────────────

    /// @notice Emitted when the chain-level Pyth contract address
    ///         changes. Setting to `address(0)` disables the
    ///         numeraire gate globally, so the event is worth a
    ///         human review either way.
    event PythOracleSet(address indexed previous, address indexed next);

    /// @notice Emitted when the chain's Pyth ETH/USD (or WETH/USD)
    ///         feed id changes. Single-write-per-chain — emitted at
    ///         init and on any subsequent governance update.
    event PythNumeraireFeedIdSet(
        bytes32 indexed previous,
        bytes32 indexed next
    );

    /// @notice Emitted when the Pyth max-staleness budget changes.
    event PythMaxStalenessSecondsSet(uint64 previous, uint64 current);

    /// @notice Emitted when the Pyth numeraire deviation tolerance
    ///         changes. Stored value applies on the next price view.
    event PythNumeraireMaxDeviationBpsSet(uint16 previous, uint16 current);

    /// @notice Emitted when the Pyth confidence ceiling changes.
    event PythConfidenceMaxBpsSet(uint16 previous, uint16 current);

    /// @notice Set the Pyth contract address on this chain. Zero
    ///         disables the numeraire gate globally — protocol price
    ///         views fall back to Chainlink-only on the WETH/USD leg.
    /// @dev    Owner-only. No range bound — `address(0)` is the
    ///         meaningful "disabled" sentinel and any non-zero
    ///         contract is acceptable here (sanity-check that it
    ///         responds to {IPyth.getPriceUnsafe} happens on first
    ///         use, not at setter time).
    function setPythOracle(address oracle) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.pythOracle;
        s.pythOracle = oracle;
        emit PythOracleSet(prev, oracle);
    }

    /// @notice Set the Pyth feed id used as this chain's numeraire
    ///         (ETH/USD on ETH-native chains, bridged-WETH/USD on
    ///         BNB / Polygon mainnet).
    /// @dev    Zero disables the gate at the feed-id layer (same
    ///         soft-skip semantics as a zero `pythOracle`); non-zero
    ///         values are accepted as-is. The price-read path
    ///         catches a mis-identified feed via the deviation gate.
    function setPythCrossCheckFeedId(bytes32 feedId) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        bytes32 prev = s.pythCrossCheckFeedId;
        s.pythCrossCheckFeedId = feedId;
        emit PythNumeraireFeedIdSet(prev, feedId);
    }

    /// @notice Set the Pyth max-staleness budget in seconds. Bounded
    ///         to `[PYTH_MAX_STALENESS_MIN_SECONDS,
    ///         PYTH_MAX_STALENESS_MAX_SECONDS]`. A compromised
    ///         governance multisig cannot push the budget tighter
    ///         than 1 min (would soft-skip Pyth on every transient
    ///         mempool jam, defeating the gate) or looser than 1 h
    ///         (a stale-but-manipulated reading could drive the
    ///         deviation outcome).
    function setPythMaxStalenessSeconds(uint64 secondsBudget) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            secondsBudget < PYTH_MAX_STALENESS_MIN_SECONDS ||
            secondsBudget > PYTH_MAX_STALENESS_MAX_SECONDS
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "pythMaxStalenessSeconds",
                uint256(secondsBudget),
                uint256(PYTH_MAX_STALENESS_MIN_SECONDS),
                uint256(PYTH_MAX_STALENESS_MAX_SECONDS)
            );
        }
        Storage storage s = storageSlot();
        uint64 prev = s.pythMaxStalenessSeconds;
        s.pythMaxStalenessSeconds = secondsBudget;
        emit PythMaxStalenessSecondsSet(prev, secondsBudget);
    }

    /// @notice Set the Chainlink ↔ Pyth max-deviation tolerance, in
    ///         basis points. Bounded to
    ///         `[PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN,
    ///         PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX]`.
    function setPythCrossCheckMaxDeviationBps(uint16 bps) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            bps < PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN ||
            bps > PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "pythCrossCheckMaxDeviationBps",
                uint256(bps),
                uint256(PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN),
                uint256(PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX)
            );
        }
        Storage storage s = storageSlot();
        uint16 prev = s.pythCrossCheckMaxDeviationBps;
        s.pythCrossCheckMaxDeviationBps = bps;
        emit PythNumeraireMaxDeviationBpsSet(prev, bps);
    }

    /// @notice Set the Pyth confidence-fraction ceiling, in basis
    ///         points. Bounded to `[PYTH_CONFIDENCE_MAX_BPS_MIN,
    ///         PYTH_CONFIDENCE_MAX_BPS_MAX]`.
    function setPythConfidenceMaxBps(uint16 bps) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            bps < PYTH_CONFIDENCE_MAX_BPS_MIN ||
            bps > PYTH_CONFIDENCE_MAX_BPS_MAX
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "pythConfidenceMaxBps",
                uint256(bps),
                uint256(PYTH_CONFIDENCE_MAX_BPS_MIN),
                uint256(PYTH_CONFIDENCE_MAX_BPS_MAX)
            );
        }
        Storage storage s = storageSlot();
        uint16 prev = s.pythConfidenceMaxBps;
        s.pythConfidenceMaxBps = bps;
        emit PythConfidenceMaxBpsSet(prev, bps);
    }

    /// @notice Read the effective Pyth max-staleness — falls back to
    ///         the package default when no value is configured.
    function effectivePythMaxStalenessSeconds() internal view returns (uint64) {
        uint64 v = storageSlot().pythMaxStalenessSeconds;
        return v == 0 ? PYTH_MAX_STALENESS_DEFAULT_SECONDS : v;
    }

    /// @notice Read the effective Pyth deviation tolerance — falls
    ///         back to the package default when no value is
    ///         configured.
    function effectivePythCrossCheckMaxDeviationBps()
        internal
        view
        returns (uint16)
    {
        uint16 v = storageSlot().pythCrossCheckMaxDeviationBps;
        return v == 0 ? PYTH_NUMERAIRE_MAX_DEVIATION_BPS_DEFAULT : v;
    }

    /// @notice Read the effective Pyth confidence ceiling — falls
    ///         back to the package default when no value is
    ///         configured.
    function effectivePythConfidenceMaxBps() internal view returns (uint16) {
        uint16 v = storageSlot().pythConfidenceMaxBps;
        return v == 0 ? PYTH_CONFIDENCE_MAX_BPS_DEFAULT : v;
    }

    /// @notice Emitted when the chain's sanctions oracle address changes.
    ///         Off-chain monitoring should alert on a transition to or
    ///         from `address(0)`: zero disables the check globally, so
    ///         the event is worth a human review either way.
    event SanctionsOracleSet(address indexed previous, address indexed next);

    /// @notice Installs the per-chain Chainalysis sanctions oracle
    ///         address. Owner-only — timelock-gated after the
    ///         governance handover. Setting to `address(0)` disables
    ///         sanctions screening across the chain (correct when
    ///         Chainalysis has not deployed an oracle there).
    /// @param oracle The Chainalysis oracle contract address, or zero.
    function setSanctionsOracle(address oracle) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.sanctionsOracle;
        s.sanctionsOracle = oracle;
        emit SanctionsOracleSet(prev, oracle);
    }

    /// @notice Read-through helper: true iff the configured oracle
    ///         reports `who` as currently sanctioned. Returns false
    ///         when no oracle is configured (the gate is disabled)
    ///         OR when the oracle call reverts (fail-open on
    ///         infrastructure failure — the alternative would brick
    ///         every interaction on the chain whenever Chainalysis's
    ///         oracle has an outage, which would over-react to a
    ///         vendor availability issue).
    ///
    /// ─── Sanctions enforcement policy (Phase 1, retail deploy) ───
    ///
    /// The retail deploy may have a sanctions oracle configured (e.g.
    /// Chainalysis on-chain SDN list). When set, the gate splits the
    /// callable surface into two tiers:
    ///
    /// **Tier 1 — BLOCK** when `msg.sender` is sanctioned (revert
    /// with `ProfileFacet.SanctionedAddress(who)`). Any entry point
    /// that creates new state or routes funds TO the caller:
    ///   - `OfferFacet.createOffer` / `acceptOffer` (creator + acceptor checks)
    ///   - `EscrowFactoryFacet.getOrCreateUserEscrow` (no escrow ever
    ///     exists for a sanctioned wallet)
    ///   - `ClaimFacet.claimAsLender` / `claimAsBorrower` (funds OUT)
    ///   - `VPFIDiscountFacet.buyVPFI` (token purchase)
    ///   - `RiskFacet.triggerLiquidation` (3% liquidator bonus → caller)
    ///   - `EarlyWithdrawalFacet.withdrawEarly` (lender pulls early)
    ///   - `PrecloseFacet.transferObligationViaOffer` (funds + state)
    ///   - `RefinanceFacet.refinanceLoan` (funds + new loan state)
    ///
    /// **Tier 2 — ALLOW** even when `msg.sender` is sanctioned. Each
    /// entry point either CLOSES exposure to the sanctioned party or
    /// is a permissionless safety action that benefits the
    /// non-sanctioned counterparty:
    ///   - `RepayFacet.repay` / `repayPartial` — closes the loan,
    ///     unsanctioned lender gets paid. Refusing this would force
    ///     default → liquidation, which routes the same value through
    ///     a worse path; counter-productive for compliance.
    ///   - `AddCollateralFacet.addCollateral` — borrower puts MORE
    ///     skin in to keep loan healthy; pro-protocol.
    ///   - `DefaultedFacet.markDefaulted` — anyone unflagged calls
    ///     this; value flows to lender, not msg.sender.
    ///
    /// ─── Legal reasoning for Tier-2 carve-outs ───
    ///
    /// Liquidation of a sanctioned-borrower's collateral is allowed
    /// because the lender's claim was established BEFORE the
    /// sanction (security interest in the collateral, contractually
    /// pledged at loan-init). Executing on a pre-existing security
    /// interest is the pattern OFAC General Licenses authorize for
    /// "wind-down of contracts entered into prior to designation".
    /// The sanctioned party's residual interest (collateral surplus
    /// after debt + bonus) stays frozen in their own escrow — Tier-1
    /// blocks `claimAsBorrower`, so no value flows to the sanctioned
    /// wallet. Lender (unsanctioned) receives principal+interest;
    /// liquidator (must be unsanctioned, Tier-1 blocks the bonus)
    /// receives the 3% bonus. Sanctioned residue is held but not
    /// transferred to any other address.
    ///
    /// ─── What about funds frozen in a sanctioned wallet's escrow? ───
    ///
    /// The protocol does not seize, redirect, or release these funds.
    /// They remain in the sanctioned wallet's own escrow and become
    /// claimable again if the oracle delists the address. This is
    /// the same behaviour as Circle's USDC blocklist — frozen, not
    /// seized. The frontend communicates this to a sanctioned wallet
    /// when it connects; the public Terms of Service carries one
    /// generic disclosure line about restricted access.
    ///
    /// @param who The address to check.
    function isSanctionedAddress(address who) internal view returns (bool) {
        address oracle = storageSlot().sanctionsOracle;
        if (oracle == address(0)) return false;
        try ISanctionsList(oracle).isSanctioned(who) returns (bool flagged) {
            return flagged;
        } catch {
            return false;
        }
    }

    /// @notice Mirrors `ProfileFacet.SanctionedAddress` (same name +
    ///         same args ⇒ same EVM selector). Declared here so
    ///         LibVaipakam doesn't have to import ProfileFacet,
    ///         which would create a circular dependency. Consumers
    ///         see identical revert data regardless of which file
    ///         emits.
    error SanctionedAddress(address who);

    /// @notice Tier-1 enforcement helper. Reverts with
    ///         `SanctionedAddress(who)` (selector identical to
    ///         `ProfileFacet.SanctionedAddress`) when `who` is
    ///         flagged by the configured oracle. No-op when the
    ///         oracle is unset or fails open. See the policy block
    ///         above for the full Tier-1 / Tier-2 split.
    /// @dev Plant this at every Tier-1 entry point. Co-located here
    ///      so a single edit point dedups the boilerplate.
    function _assertNotSanctioned(address who) internal view {
        if (isSanctionedAddress(who)) {
            revert SanctionedAddress(who);
        }
    }
}
