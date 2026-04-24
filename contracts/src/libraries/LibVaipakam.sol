// src/libraries/LibVaipakam.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";

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
    uint256 constant FALLBACK_TREASURY_BPS = 200;     // 2% treasury cut on fallback path
    uint256 constant KYC_TIER0_THRESHOLD_USD = 1_000 * 1e18; // Tier0 max
    uint256 constant KYC_TIER1_THRESHOLD_USD = 10_000 * 1e18; // Tier1 max
    uint256 constant MAX_FEE_EVENTS_ITER = 10_000; // Max feeEventsLog entries scanned per window query in MetricsFacet
    uint256 constant SEQUENCER_GRACE_PERIOD = 3600; // 1h post-recovery grace on L2s before prices are trusted again

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
    int256  constant ORACLE_USD_PEG_1E8 = 1e8;        // $1 scaled to 8 decimals

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
    uint256 constant VPFI_TIER1_MIN = 100 * 1e18;         // T1 starts at ≥ 100
    uint256 constant VPFI_TIER2_MIN = 1_000 * 1e18;       // T2 starts at ≥ 1,000
    uint256 constant VPFI_TIER3_MIN = 5_000 * 1e18;       // T3 starts at ≥ 5,000
    uint256 constant VPFI_TIER4_THRESHOLD = 20_000 * 1e18; // T4 starts strictly ABOVE this
    uint256 constant VPFI_TIER1_DISCOUNT_BPS = 1000;       // 10%
    uint256 constant VPFI_TIER2_DISCOUNT_BPS = 1500;       // 15%
    uint256 constant VPFI_TIER3_DISCOUNT_BPS = 2000;       // 20%
    uint256 constant VPFI_TIER4_DISCOUNT_BPS = 2400;       // 24%

    uint256 constant VPFI_FIXED_RATE_DEFAULT_WEI_PER_VPFI = 1e15; // 1 VPFI = 0.001 ETH
    uint256 constant VPFI_FIXED_GLOBAL_CAP = 2_300_000 * 1e18; // 2.3M VPFI pool (spec §8)
    uint256 constant VPFI_FIXED_WALLET_CAP = 30_000 * 1e18; // 30k VPFI per wallet (spec §8)

    // ─── VPFI Reward Pools (docs/TokenomicsTechSpec.md §3, §4, §7) ───────
    // Hard caps on each Phase-1 emission category. The diamond pays
    // claims from its own VPFI balance; a cumulative paid-out counter
    // enforces these caps at claim time.
    uint256 constant VPFI_STAKING_POOL_CAP = 55_200_000 * 1e18;      // 24% of supply
    uint256 constant VPFI_INTERACTION_POOL_CAP = 69_000_000 * 1e18;  // 30% of supply
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
        uint16 treasuryFeeBps;              // 0 ⇒ TREASURY_FEE_BPS (100)
        uint16 loanInitiationFeeBps;        // 0 ⇒ LOAN_INITIATION_FEE_BPS (10)
        uint16 liquidationHandlingFeeBps;   // 0 ⇒ LIQUIDATION_HANDLING_FEE_BPS (200)
        uint16 maxLiquidationSlippageBps;   // 0 ⇒ MAX_LIQUIDATION_SLIPPAGE_BPS (600)
        uint16 maxLiquidatorIncentiveBps;   // 0 ⇒ MAX_LIQUIDATOR_INCENTIVE_BPS (300)
        uint16 volatilityLtvThresholdBps;   // 0 ⇒ VOLATILITY_LTV_THRESHOLD_BPS (11000)
        uint16 rentalBufferBps;             // 0 ⇒ RENTAL_BUFFER_BPS (500)
        uint16 vpfiStakingAprBps;           // 0 ⇒ VPFI_STAKING_APR_BPS (500)
        uint16 vpfiTier1DiscountBps;        // 0 ⇒ VPFI_TIER1_DISCOUNT_BPS (1000)
        uint16 vpfiTier2DiscountBps;        // 0 ⇒ VPFI_TIER2_DISCOUNT_BPS (1500)
        uint16 vpfiTier3DiscountBps;        // 0 ⇒ VPFI_TIER3_DISCOUNT_BPS (2000)
        uint16 vpfiTier4DiscountBps;        // 0 ⇒ VPFI_TIER4_DISCOUNT_BPS (2400)
        // Fallback-path split, governance-configurable. Prospective
        // semantics: `Loan.fallbackLenderBonusBpsAtInit` / `...TreasuryBpsAtInit`
        // are snapshotted at `initiateLoan`, so governance changes via
        // `setFallbackSplit` never retroactively alter dual-consent offers.
        uint16 fallbackLenderBonusBps;      // 0 ⇒ FALLBACK_LENDER_BONUS_BPS (300)
        uint16 fallbackTreasuryBps;         // 0 ⇒ FALLBACK_TREASURY_BPS (200)
        // ── VPFI discount tier thresholds (18-dec VPFI; 0 ⇒ default) ──
        uint256 vpfiTier1Min;               // 0 ⇒ VPFI_TIER1_MIN (100e18)
        uint256 vpfiTier2Min;               // 0 ⇒ VPFI_TIER2_MIN (1_000e18)
        uint256 vpfiTier3Min;               // 0 ⇒ VPFI_TIER3_MIN (5_000e18)
        uint256 vpfiTier4Threshold;         // 0 ⇒ VPFI_TIER4_THRESHOLD (20_000e18)
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
        bool keeperAccessEnabled;
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
        // Slot 1: creator(20) + 9 small fields (9) = 29 bytes packed
        address creator;
        OfferType offerType;
        LiquidityStatus principalLiquidity;
        LiquidityStatus collateralLiquidity;
        bool accepted;
        AssetType assetType;
        bool useFullTermInterest;
        bool creatorFallbackConsent;
        AssetType collateralAssetType;
        bool keeperAccessEnabled;
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
        // Per-side keeper access gates. Each side controls its own flag —
        // borrower toggles `borrowerKeeperAccessEnabled`, lender toggles
        // `lenderKeeperAccessEnabled`. LibAuth resolves the appropriate flag
        // based on which side's action is being authorized. At loan creation
        // both flags mirror the offer's `keeperAccessEnabled`; after
        // initiation each side may toggle its own flag via
        // `ProfileFacet.setLoanKeeperAccess`.
        bool lenderKeeperAccessEnabled;
        bool borrowerKeeperAccessEnabled;
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
        // Slot 3
        address borrower;
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
        // Slot 9
        uint256 startTime; // Timestamp of initiation
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

    /// @notice Per-asset Pyth secondary-oracle config (Phase 3.2).
    ///         Installed by governance via
    ///         {OracleAdminFacet.setPythFeedConfig}. When `priceId !=
    ///         bytes32(0)` for an asset, {OracleFacet.getAssetPrice}
    ///         reads the Pyth price alongside Chainlink and reverts
    ///         {OraclePriceDivergence} if the two disagree by more than
    ///         `maxDeviationBps`. A stale Pyth read (older than
    ///         `maxStaleness`) also reverts — the secondary is
    ///         deliberately fail-closed because an operator who
    ///         configured it has said "both sources must agree".
    /// @dev `maxDeviationBps` is in basis points (10000 = 100%). Typical
    ///      values: 500 (5%) for volatile majors, 100 (1%) for stables.
    ///      `maxStaleness` in seconds — Pyth publishes sub-second so a
    ///      tight 30-60s window is the norm.
    struct PythFeedConfig {
        bytes32 priceId;
        uint16 maxDeviationBps;
        uint40 maxStaleness;
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
     *      `usdValue` in uint192 accommodates USD amounts scaled to 1e18 up
     *      to ~6.28e39 — vastly beyond any single fee.
     *      `usdValue` is 0 when the priced asset lacks a Chainlink feed at
     *      the time of accrual. The underlying asset-denominated accrual is
     *      reflected in `treasuryBalances[asset]` only when the configured
     *      treasury is the Diamond itself; external-treasury deployments
     *      push the tokens straight to the multisig, so `treasuryBalances`
     *      stays at zero for those fee paths (the fee still lives on-chain
     *      in the event log and `cumulativeFeesUSD`).
     */
    struct FeeEvent {
        uint64 timestamp;
        uint192 usdValue;
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
        uint32 startDay;     // inclusive
        uint32 endDay;       // exclusive; 0 = still open
        RewardSide side;
        bool processed;      // claim/sweep already routed this entry
        bool forfeited;      // true ⇒ route to treasury on processing
        uint256 perDayUSD18; // USD18 interest-per-day snapshotted at register
    }

    /**
     * @notice Per-user VPFI discount accumulator. Drives the time-weighted
     *         lender yield-fee discount (docs/GovernanceConfigDesign.md §5.2a).
     *         Updated on every escrow-VPFI balance mutation and at every
     *         offer-accept / yield-fee settlement. Ordering invariant: the
     *         accompanying `rollupUserDiscount(user, preMutationBalance)`
     *         call MUST execute BEFORE the mutation, so the closed period
     *         sees the balance that was actually in effect for it.
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
        uint16  discountBpsAtPreviousRollup;
        uint64  lastRollupAt;
        uint256 cumulativeDiscountBpsSeconds;
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
     *          (see `feeEventsLog` / `cumulativeFeesUSD` for the analytics
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
     *        • `approvedKeepers[user][keeper] == true` ⇔ `keeper ∈
     *          approvedKeepersList[user]`. The list mirrors the mapping for
     *          enumeration and is capped at MAX_APPROVED_KEEPERS.
     *        • `keeperAccessEnabled[user]`: user-level opt-in. A keeper call
     *          on a loan additionally requires the entitled side's per-loan
     *          flag — `loan.lenderKeeperAccessEnabled` for lender-entitled
     *          actions, `loan.borrowerKeeperAccessEnabled` for borrower-
     *          entitled actions. Each side toggles its own flag via
     *          `ProfileFacet.setLoanKeeperAccess` — see LibAuth.
     */
    struct Storage {
        uint256 nextOfferId;
        uint256 nextLoanId;
        uint256 nextTokenId; // For Vaipakam NFTs
        address vaipakamEscrowTemplate; // Shared UUPS implementation
        address treasury; // Configurable treasury address
        address zeroExProxy; // 0x proxy for liquidations
        address allowanceTarget; // allowance target for 0x proxy protocol
        address usdChainlinkDenominator; // Chainlink Feed Registry USD denominator (mainnet only)
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
        uint256 kycTier0ThresholdUSD; // Tier0 max (default 1_000 * 1e18)
        uint256 kycTier1ThresholdUSD; // Tier1 max (default 10_000 * 1e18)
        mapping(address => bool) keeperAccessEnabled; // User-level default: opt-in for third-party/keeper execution (default: false)
        // Snapshot of liquid-collateral liquidations that fell back to the
        // claim-time settlement path (README §7). Written by RiskFacet /
        // DefaultedFacet at fallback time; consumed by ClaimFacet on the
        // first lender/borrower claim.
        mapping(uint256 => FallbackSnapshot) fallbackSnapshot;
        // README §3/§9: per-user whitelist of approved keeper addresses for
        // non-liquidation third-party execution. A keeper may act on a loan
        // only if BOTH lender and borrower have approved it (intersection).
        // Capped at MAX_APPROVED_KEEPERS per user.
        mapping(address => mapping(address => bool)) approvedKeepers;
        mapping(address => address[]) approvedKeepersList;
        // README §13 analytics surface: timestamped log of every treasury-fee
        // accrual, priced in USD at accrual time. Appended by
        // LibFacet.recordTreasuryAccrual. Consumed by MetricsFacet for the
        // 24h/7d revenue windows and getRevenueStats(days_). Capped per query
        // by MAX_FEE_EVENTS_ITER on read.
        FeeEvent[] feeEventsLog;
        // Monotone cumulative sum of usdValue across feeEventsLog entries —
        // tracked separately so MetricsFacet.getTreasuryMetrics.totalFeesCollectedUSD
        // is an O(1) read. Never decreases.
        uint256 cumulativeFeesUSD;
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
        // Per-wallet cap on VPFI sold through the fixed-rate buy. Enforced
        // against `vpfiFixedRateSoldTo[user]`. Zero resolves to the spec
        // default {VPFI_FIXED_WALLET_CAP} (30k VPFI, see
        // docs/TokenomicsTechSpec.md §8a) via {cfgVpfiFixedWalletCap}. As
        // with the global cap, no "uncapped" mode is exposed.
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
        // Per-wallet running total of VPFI bought at the fixed rate.
        // Enforced against `vpfiFixedRatePerWalletCap` on each buy.
        mapping(address => uint256) vpfiFixedRateSoldTo;
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
        //   totalLenderInterestUSD18[d] += interestUSD
        //   userLenderInterestUSD18[d][lender] += interestUSD
        //   (and borrower mirror iff clean)
        // Claims walk finalized days < today, cap at MAX_INTERACTION_CLAIM_DAYS
        // per tx, and advance interactionLastClaimedDay.
        uint256 interactionLaunchTimestamp;
        uint256 interactionPoolPaidOut;
        mapping(uint256 => uint256) totalLenderInterestUSD18;
        mapping(uint256 => uint256) totalBorrowerInterestUSD18;
        mapping(uint256 => mapping(address => uint256)) userLenderInterestUSD18;
        mapping(uint256 => mapping(address => uint256)) userBorrowerInterestUSD18;
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
        //     `dailyGlobalLenderInterestUSD18[D]` and
        //     `dailyGlobalBorrowerInterestUSD18[D]` once all expected
        //     mirrors have reported OR `rewardGraceSeconds` has elapsed
        //   - Base then broadcasts the finalized global pair back to
        //     every mirror, where {LibInteractionRewards.claimForUserWindow}
        //     prefers `knownGlobal*InterestUSD18[D]` over the local total
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
        /// @dev Base-only: lender-side local USD18 interest reported by
        ///      chain `eid` for day `D`.
        mapping(uint256 => mapping(uint32 => uint256)) chainDailyLenderInterestUSD18;
        /// @dev Base-only: borrower-side local USD18 interest reported by
        ///      chain `eid` for day `D`.
        mapping(uint256 => mapping(uint32 => uint256)) chainDailyBorrowerInterestUSD18;
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
        /// @dev Base-only: finalized global lender USD18 interest for
        ///      day `D` (sum across reported eids).
        mapping(uint256 => uint256) dailyGlobalLenderInterestUSD18;
        /// @dev Base-only: finalized global borrower USD18 interest for
        ///      day `D` (sum across reported eids).
        mapping(uint256 => uint256) dailyGlobalBorrowerInterestUSD18;

        // ── Consumer side (every chain) ────────────────────────────────
        /// @dev Finalized global lender denominator known on this chain
        ///      for day `D`. On Base it is set directly by
        ///      {RewardAggregatorFacet.finalizeDay}; on mirrors it is
        ///      set by {RewardReporterFacet.onRewardBroadcastReceived}.
        ///      Zero means "not yet known locally" — claims for `D`
        ///      revert until the broadcast lands.
        mapping(uint256 => uint256) knownGlobalLenderInterestUSD18;
        /// @dev Mirror of {knownGlobalLenderInterestUSD18} for the
        ///      borrower side.
        mapping(uint256 => uint256) knownGlobalBorrowerInterestUSD18;
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
        // pricing flows through the direct `ethUsdFeed` address for
        // WETH and reverts with {NoPriceFeed} for other assets unless
        // the admin wires a per-asset direct feed (not yet exposed;
        // tracked in the follow-up).
        /// @dev AggregatorV3 address for ETH/USD (8 decimals). REQUIRED
        ///      for liquidity depth conversion and for pricing WETH
        ///      itself. Zero disables every ETH-quoted code path.
        address ethUsdFeed;
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

        // ─── Pyth secondary oracle (Phase 3.2) ───────────────────────────
        // Per-asset Pyth price-feed configuration. When an asset has a
        // non-zero `priceId`, {OracleFacet.getAssetPrice} reads BOTH the
        // primary Chainlink feed AND the Pyth price, then reverts if the
        // two diverge by more than `maxDeviationBps`. A stale Pyth read
        // also reverts — fail-closed so a silent drop to primary-only
        // can't happen.
        //
        // `pythEndpoint` is the chain-specific Pyth contract address
        // (canonical deployments at
        // https://docs.pyth.network/price-feeds/contract-addresses/evm).
        // Set via {OracleAdminFacet.setPythEndpoint}.
        address pythEndpoint;
        mapping(address => PythFeedConfig) pythFeedConfigs;

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
        // contributes `perDayUSD18` to the running open-per-day counter
        // via a START-day delta. At close, a matching NEGATIVE delta is
        // stamped on the close day (exclusive endDay). The delta cursor
        // is advanced lazily by the reporter path when shipping day `d`
        // AND by the claim path when walking reward entries.
        //
        // Claim math: per-entry reward =
        //   perDayUSD18 × (cumRPU18[endDay-1] − cumRPU18[startDay-1]) / 1e18
        // where cumRPU18[d] = Σ_{d' ≤ d} halfPool[d'] × 1e18 / globalTotal[d'].
        // Global denominator comes from the finalized cross-chain
        // broadcast (`knownGlobal*InterestUSD18[d]`); cumRPU cannot advance
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

        /// @dev Net change applied to {lenderOpenPerDayUSD18} at the START
        ///      of day `d`. registerLoan bumps [startDay] up, closeLoan
        ///      bumps [endDay] down. Stored as int256 for the net-zero
        ///      symmetry on same-day register + close.
        mapping(uint256 => int256) lenderPerDayDeltaUSD18;
        /// @dev Mirror of {lenderPerDayDeltaUSD18} for the borrower side.
        ///      Clean / forfeit status is recorded on the RewardEntry, NOT
        ///      by reversing deltas — defaulted borrowers remain in the
        ///      denominator to keep the daily pool budget stable.
        mapping(uint256 => int256) borrowerPerDayDeltaUSD18;
        /// @dev Running sum of `perDayUSD18` across lender-side loans open
        ///      at {lenderFrontierDay}. Advanced by {advanceLenderThrough}.
        uint256 lenderOpenPerDayUSD18;
        /// @dev Running sum of `perDayUSD18` across borrower-side loans
        ///      open at {borrowerFrontierDay}.
        uint256 borrowerOpenPerDayUSD18;
        /// @dev Last day for which {totalLenderInterestUSD18}[d] has been
        ///      snapshotted from the delta walk. Advance must be called
        ///      before the reporter ships day `d`.
        uint256 lenderFrontierDay;
        /// @dev Mirror of {lenderFrontierDay} for the borrower side.
        uint256 borrowerFrontierDay;

        /// @dev cumRPU18[d] = cumulative VPFI-wei reward per 1e18 USD18
        ///      through END of day `d`, using the GLOBAL (cross-chain)
        ///      denominator. Populated lazily by {advanceCumLenderThrough};
        ///      halts at the first day without `knownGlobalSet[d]`.
        mapping(uint256 => uint256) cumLenderRPU18;
        /// @dev Mirror of {cumLenderRPU18} for the borrower side.
        mapping(uint256 => uint256) cumBorrowerRPU18;
        /// @dev Last day through which {cumLenderRPU18} is populated
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
    }

    uint256 internal constant MAX_APPROVED_KEEPERS = 5;

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

    /// @dev Returns the KYC Tier-0 USD threshold, falling back to
    ///      {KYC_TIER0_THRESHOLD_USD} when the governance override is unset.
    /// @return threshold USD threshold scaled to 1e18.
    function getKycTier0Threshold() internal view returns (uint256 threshold) {
        uint256 v = storageSlot().kycTier0ThresholdUSD;
        return v == 0 ? KYC_TIER0_THRESHOLD_USD : v;
    }

    /// @dev Returns the KYC Tier-1 USD threshold, falling back to
    ///      {KYC_TIER1_THRESHOLD_USD} when the governance override is unset.
    /// @return threshold USD threshold scaled to 1e18.
    function getKycTier1Threshold() internal view returns (uint256 threshold) {
        uint256 v = storageSlot().kycTier1ThresholdUSD;
        return v == 0 ? KYC_TIER1_THRESHOLD_USD : v;
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

    /// @dev Returns the four tier thresholds (T1 min, T2 min, T3 min, T4 min-exclusive).
    function cfgVpfiTierThresholds()
        internal
        view
        returns (uint256 t1, uint256 t2, uint256 t3, uint256 t4Excl)
    {
        ProtocolConfig storage c = storageSlot().protocolCfg;
        t1     = c.vpfiTier1Min        == 0 ? VPFI_TIER1_MIN        : c.vpfiTier1Min;
        t2     = c.vpfiTier2Min        == 0 ? VPFI_TIER2_MIN        : c.vpfiTier2Min;
        t3     = c.vpfiTier3Min        == 0 ? VPFI_TIER3_MIN        : c.vpfiTier3Min;
        t4Excl = c.vpfiTier4Threshold  == 0 ? VPFI_TIER4_THRESHOLD  : c.vpfiTier4Threshold;
    }

    /// @dev Discount BPS for a tier index 1..4. Tier 0 is always zero.
    function cfgVpfiTierDiscountBps(uint8 tier) internal view returns (uint256) {
        if (tier == 0) return 0;
        ProtocolConfig storage c = storageSlot().protocolCfg;
        if (tier == 4) return c.vpfiTier4DiscountBps == 0 ? VPFI_TIER4_DISCOUNT_BPS : uint256(c.vpfiTier4DiscountBps);
        if (tier == 3) return c.vpfiTier3DiscountBps == 0 ? VPFI_TIER3_DISCOUNT_BPS : uint256(c.vpfiTier3DiscountBps);
        if (tier == 2) return c.vpfiTier2DiscountBps == 0 ? VPFI_TIER2_DISCOUNT_BPS : uint256(c.vpfiTier2DiscountBps);
        if (tier == 1) return c.vpfiTier1DiscountBps == 0 ? VPFI_TIER1_DISCOUNT_BPS : uint256(c.vpfiTier1DiscountBps);
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

    /// @dev Duration-tiered grace period used by DefaultedFacet. The tiers
    ///      are inclusive of the lower bound and exclusive of the upper:
    ///        durationDays < 7    → 1 hour
    ///        durationDays < 30   → 1 day
    ///        durationDays < 90   → 3 days
    ///        durationDays < 180  → 1 week
    ///        durationDays >= 180 → 2 weeks
    /// @param durationDays Loan duration in days.
    /// @return grace Grace period in seconds.
    function gracePeriod(uint256 durationDays) internal pure returns (uint256 grace) {
        if (durationDays < 7) return 1 hours;
        if (durationDays < 30) return 1 days;
        if (durationDays < 90) return 3 days;
        if (durationDays < 180) return 1 weeks;
        return 2 weeks;
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
        s.usdChainlinkDenominator = newUsdChainlinkDenominator;
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
        s.ethUsdFeed = newEthUsdFeed;
    }

    /// @dev Set the Chainlink Feed Registry ETH-denominator pseudo-address
    ///      used by OracleFacet's asset/ETH fallback price path. Owner-only.
    ///      Zero on L2s where the Feed Registry does not exist —
    ///      disables the ETH-route fallback (assets without a direct
    ///      asset/USD feed revert NoPriceFeed).
    /// @param newEthChainlinkDenominator ETH-denominator address recognised
    ///        by the Chainlink Feed Registry.
    function setEthChainlinkDenominator(address newEthChainlinkDenominator) internal {
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

    /// @notice Emitted when the chain's Pyth endpoint address changes.
    event PythEndpointSet(address indexed previous, address indexed next);

    /// @notice Emitted when a Pyth secondary-feed config is installed or
    ///         cleared for an asset. `priceId == bytes32(0)` indicates
    ///         clear; monitoring should alert on clear since it
    ///         downgrades the deviation-check protection for that asset.
    event PythFeedConfigSet(
        address indexed asset,
        bytes32 priceId,
        uint16 maxDeviationBps,
        uint40 maxStaleness
    );

    /// @notice Installs the per-chain Pyth endpoint address used by
    ///         {OracleFacet.getAssetPrice} to read secondary prices
    ///         and by {PriceUpdateFacet.updatePythAndCall} to post
    ///         signed update payloads. `address(0)` disables the
    ///         secondary-oracle path across the whole chain — every
    ///         asset falls back to Chainlink-only reads regardless of
    ///         its per-asset config.
    /// @param endpoint The Pyth oracle contract address for this chain.
    function setPythEndpoint(address endpoint) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.pythEndpoint;
        s.pythEndpoint = endpoint;
        emit PythEndpointSet(prev, endpoint);
    }

    /// @notice Installs or clears a Pyth secondary-feed config for an
    ///         asset. With `priceId = bytes32(0)` the asset falls back
    ///         to Chainlink-only reads.
    /// @dev Owner-only. After governance handover this is timelock-
    ///      gated, so every divergence-bound change has a 48h public
    ///      warning. `maxDeviationBps` must be in [1, BASIS_POINTS];
    ///      values of 0 or >= 10000 are treated as misconfiguration
    ///      and rejected.
    /// @param asset            Asset address to configure.
    /// @param priceId          Pyth feed id (32-byte). `bytes32(0)` clears.
    /// @param maxDeviationBps  Allowed divergence between Chainlink and
    ///                         Pyth, in basis points. Typical: 100-500.
    /// @param maxStaleness     Max acceptable Pyth publishTime age, in
    ///                         seconds. Typical: 30-120.
    function setPythFeedConfig(
        address asset,
        bytes32 priceId,
        uint16 maxDeviationBps,
        uint40 maxStaleness
    ) internal {
        LibDiamond.enforceIsContractOwner();
        if (asset == address(0)) revert IVaipakamErrors.InvalidAddress();
        Storage storage s = storageSlot();
        PythFeedConfig storage cfg = s.pythFeedConfigs[asset];
        if (priceId == bytes32(0)) {
            // Clear both fields explicitly — the "remove secondary"
            // escape hatch. Other fields ignored.
            cfg.priceId = bytes32(0);
            cfg.maxDeviationBps = 0;
            cfg.maxStaleness = 0;
            emit PythFeedConfigSet(asset, bytes32(0), 0, 0);
            return;
        }
        // Install: reject obvious misconfig.
        if (maxDeviationBps == 0 || maxDeviationBps >= BASIS_POINTS) {
            revert IVaipakamErrors.InvalidAmount();
        }
        if (maxStaleness == 0) revert IVaipakamErrors.InvalidAmount();
        cfg.priceId = priceId;
        cfg.maxDeviationBps = maxDeviationBps;
        cfg.maxStaleness = maxStaleness;
        emit PythFeedConfigSet(asset, priceId, maxDeviationBps, maxStaleness);
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
}
