// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibStakingRewards} from "./LibStakingRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {EscrowFactoryFacet} from "../facets/EscrowFactoryFacet.sol";

/**
 * @title LibVPFIDiscount
 * @author Vaipakam Developer Team
 * @notice Shared quote / apply helpers for both VPFI fee discount paths
 *         (docs/TokenomicsTechSpec.md §6):
 *           - Borrower Loan Initiation Fee discount (normal 0.1%)
 *           - Lender Yield Fee discount             (normal 1%)
 *         Both paths share the same tier-by-escrow-balance gate and the
 *         same platform-level consent flag `s.vpfiDiscountConsent[user]`.
 * @dev Tier semantics (`LibVaipakam` constants):
 *
 *        Tier | Escrow VPFI range              | Discount
 *          0  | x < 100                        |   0%  (no discount)
 *          1  | 100    ≤ x < 1,000             |  10%
 *          2  | 1,000  ≤ x < 5,000             |  15%
 *          3  | 5,000  ≤ x ≤ 20,000            |  20%  (20k inclusive)
 *          4  |          x > 20,000            |  24%
 *
 *      Tier resolution is a pure VPFI balance check — no Chainlink
 *      dependency — so the tier gate is deterministic and cheap.
 *
 *      The tier-adjusted fee is still paid IN VPFI out of the user's escrow
 *      (spec: "the system should automatically deduct the required VPFI
 *      amount from escrow to Treasury"). That conversion still uses
 *      Chainlink USD feeds:
 *
 *        normalFeeInAsset      = feeBase × normalFeeBps / BASIS_POINTS
 *        payBps                = BASIS_POINTS − tierDiscountBps
 *        tierFeeInAsset        = normalFeeInAsset × payBps / BASIS_POINTS
 *        tierFeeUSD            = tierFeeInAsset × price(feeAsset)
 *        tierFeeWei            = tierFeeUSD × 1e(ethDecimals) / price(ETH)
 *        vpfiRequired          = tierFeeWei × 1e18 / weiPerVpfi
 *
 *      Every Chainlink or config input can be unavailable (no feed, stale
 *      feed, unregistered asset, missing ETH reference, zero rate). On any
 *      failure the quote returns `(false, 0, 0)` and the mutating path
 *      falls back silently to the normal non-discounted fee — this matches
 *      the spec's silent-fallback rule.
 *
 *      Library functions execute in the caller facet's context under the
 *      diamond's `delegatecall`, so `address(this)` resolves to the diamond.
 */
library LibVPFIDiscount {
    // ─── Tier helpers ────────────────────────────────────────────────────────

    /**
     * @notice Resolve the VPFI discount tier for a given escrow balance.
     * @dev `view`, not `pure`: tier thresholds are now admin-configurable
     *      through {ConfigFacet} and resolved via
     *      {LibVaipakam.cfgVpfiTierThresholds}. Defaults (100 / 1k / 5k /
     *      20k) apply when no override is set. The T3/T4 split remains
     *      strict: exactly the T4 threshold is T3, not T4.
     * @param escrowBal The user's escrow VPFI balance (18 decimals).
     * @return tier 0..4 — 0 means no discount.
     */
    function tierOf(uint256 escrowBal) internal view returns (uint8 tier) {
        (uint256 t1, uint256 t2, uint256 t3, uint256 t4Excl) =
            LibVaipakam.cfgVpfiTierThresholds();
        if (escrowBal > t4Excl) return 4;
        if (escrowBal >= t3) return 3;
        if (escrowBal >= t2) return 2;
        if (escrowBal >= t1) return 1;
        return 0;
    }

    /**
     * @notice Discount BPS for a given tier. T0 is 0 (no discount).
     * @dev `view`, not `pure`: discount BPS are admin-configurable via
     *      {ConfigFacet}. Defaults (10% / 15% / 20% / 24%) apply until
     *      an override is set; the setter enforces monotonicity across
     *      tiers so a higher-balance user can never receive a smaller
     *      discount than a lower-balance one.
     * @param tier Tier index 0..4.
     * @return bps Discount applied to the NORMAL fee (e.g. 1000 = 10% off).
     */
    function discountBpsForTier(uint8 tier) internal view returns (uint256 bps) {
        return LibVaipakam.cfgVpfiTierDiscountBps(tier);
    }

    /**
     * @notice Read `user`'s escrow VPFI balance through the diamond's
     *         storage + VPFI token. Returns 0 when escrow doesn't exist or
     *         VPFI isn't registered on this chain.
     * @param user Address whose escrow balance to read.
     * @return bal Escrow VPFI balance (18 decimals), or 0 if unavailable.
     */
    function escrowVPFIBalance(address user) internal view returns (uint256 bal) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.vpfiToken == address(0)) return 0;
        address escrow = s.userVaipakamEscrows[user];
        if (escrow == address(0)) return 0;
        return IERC20(s.vpfiToken).balanceOf(escrow);
    }

    // ─── Quotes (view) ───────────────────────────────────────────────────────

    /**
     * @notice Quote the VPFI amount required for the borrower tier-discounted
     *         Loan Initiation Fee on an ERC-20 principal offer.
     * @dev Caller must have already verified the offer is ERC-20 principal.
     *      Returns `(false, 0, 0)` when the borrower is in T0, or when any
     *      Chainlink / config input is unavailable. Never reverts.
     * @param principalAsset The offer's lending asset (ERC-20).
     * @param principal      The offer principal amount in lending asset wei.
     * @param borrower       The borrower whose tier is resolved.
     * @return canQuote      True iff a non-zero tier quote is available.
     * @return vpfiRequired  VPFI (18 dec) borrower must hold in escrow.
     * @return tier          Resolved tier 1..4 (0 on canQuote == false).
     */
    function quote(
        address principalAsset,
        uint256 principal,
        address borrower
    )
        internal
        view
        returns (bool canQuote, uint256 vpfiRequired, uint8 tier)
    {
        if (principal == 0 || borrower == address(0)) return (false, 0, 0);

        uint256 bal = escrowVPFIBalance(borrower);
        tier = tierOf(bal);
        if (tier == 0) return (false, 0, 0);

        uint256 normalFee = (principal * LibVaipakam.cfgLoanInitiationFeeBps()) /
            LibVaipakam.BASIS_POINTS;
        uint256 payBps = LibVaipakam.BASIS_POINTS - discountBpsForTier(tier);
        uint256 tierFee = (normalFee * payBps) / LibVaipakam.BASIS_POINTS;

        (bool ok, uint256 vpfi) = _feeAssetWeiToVPFI(principalAsset, tierFee);
        if (!ok) return (false, 0, 0);
        return (true, vpfi, tier);
    }

    /**
     * @notice Quote the VPFI required for the lender tier-discounted Yield
     *         Fee on a given interest amount.
     * @dev Mirror of {quote} for the lender-side discount.
     * @param feeAsset       The lending asset the interest is denominated in.
     * @param interestAmount The lender's pre-split interest in `feeAsset` wei.
     * @param lender         The lender whose tier is resolved.
     * @return canQuote      True iff a non-zero tier quote is available.
     * @return vpfiRequired  VPFI (18 dec) the lender must hold in escrow.
     * @return tier          Resolved tier 1..4 (0 on canQuote == false).
     */
    function quoteYieldFee(
        address feeAsset,
        uint256 interestAmount,
        address lender
    )
        internal
        view
        returns (bool canQuote, uint256 vpfiRequired, uint8 tier)
    {
        if (interestAmount == 0 || lender == address(0)) return (false, 0, 0);

        uint256 bal = escrowVPFIBalance(lender);
        tier = tierOf(bal);
        if (tier == 0) return (false, 0, 0);

        uint256 normalFee = (interestAmount * LibVaipakam.cfgTreasuryFeeBps()) /
            LibVaipakam.BASIS_POINTS;
        uint256 payBps = LibVaipakam.BASIS_POINTS - discountBpsForTier(tier);
        uint256 tierFee = (normalFee * payBps) / LibVaipakam.BASIS_POINTS;

        (bool ok, uint256 vpfi) = _feeAssetWeiToVPFI(feeAsset, tierFee);
        if (!ok) return (false, 0, 0);
        return (true, vpfi, tier);
    }

    // ─── Apply (mutating) ────────────────────────────────────────────────────

    /**
     * @notice Attempt to pay the borrower's tier-discounted Loan Initiation
     *         Fee in VPFI out of the borrower's escrow into the treasury.
     * @dev Silent fallback on any failure (quote fails, escrow short, sub-
     *      call reverts). On success transfers `vpfiRequired` from borrower
     *      escrow to configured treasury and records the treasury accrual.
     * @param principalAsset The offer's lending asset.
     * @param principal      The offer principal.
     * @param borrower       The borrower funding the discount.
     * @return applied       True iff VPFI was successfully deducted.
     * @return vpfiDeducted  VPFI amount moved from borrower escrow.
     */
    function tryApply(
        address principalAsset,
        uint256 principal,
        address borrower
    ) internal returns (bool applied, uint256 vpfiDeducted) {
        (bool canQuote, uint256 vpfiRequired, ) = quote(
            principalAsset,
            principal,
            borrower
        );
        if (!canQuote) return (false, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        address borrowerEscrow = s.userVaipakamEscrows[borrower];
        if (borrowerEscrow == address(0)) return (false, 0);

        uint256 escrowBal = IERC20(vpfi).balanceOf(borrowerEscrow);
        if (escrowBal < vpfiRequired) return (false, 0);

        // Checkpoint the staker BEFORE the balance leaves escrow so the
        // accrual captures the pre-deduction staked amount for the period
        // it was active. Uses the actual escrow balance (not stored mirror)
        // to stay robust against any reconciliation drift.
        LibStakingRewards.updateUser(borrower, escrowBal - vpfiRequired);

        address treasury = LibFacet.getTreasury();
        (bool ok, ) = address(this).call(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                borrower,
                vpfi,
                treasury,
                vpfiRequired
            )
        );
        if (!ok) return (false, 0);

        LibFacet.recordTreasuryAccrual(vpfi, vpfiRequired);
        return (true, vpfiRequired);
    }

    /**
     * @notice Attempt to pay the lender's tier-discounted Yield Fee in VPFI
     *         out of the lender's escrow into the treasury.
     * @dev On success, the lender keeps 100% of `interestAmount` in the
     *      lending asset (no 1% haircut) and the tier-discounted treasury
     *      share is satisfied entirely in VPFI from the lender's escrow.
     *      Silent fallback on any failure. Caller must have verified
     *      `s.vpfiDiscountConsent[lender]` before invoking.
     * @param feeAsset       The lending asset the interest is denominated in.
     * @param interestAmount The pre-split interest in `feeAsset` wei.
     * @param lender         The lender funding the VPFI side.
     * @return applied       True iff VPFI was successfully deducted.
     * @return vpfiDeducted  VPFI amount moved from lender escrow to treasury.
     */
    function tryApplyYieldFee(
        address feeAsset,
        uint256 interestAmount,
        address lender
    ) internal returns (bool applied, uint256 vpfiDeducted) {
        (bool canQuote, uint256 vpfiRequired, ) = quoteYieldFee(
            feeAsset,
            interestAmount,
            lender
        );
        if (!canQuote) return (false, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        address lenderEscrow = s.userVaipakamEscrows[lender];
        if (lenderEscrow == address(0)) return (false, 0);

        uint256 escrowBal = IERC20(vpfi).balanceOf(lenderEscrow);
        if (escrowBal < vpfiRequired) return (false, 0);

        // Mirror of tryApply's checkpoint on the lender side.
        LibStakingRewards.updateUser(lender, escrowBal - vpfiRequired);

        address treasury = LibFacet.getTreasury();
        (bool ok, ) = address(this).call(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                lender,
                vpfi,
                treasury,
                vpfiRequired
            )
        );
        if (!ok) return (false, 0);

        LibFacet.recordTreasuryAccrual(vpfi, vpfiRequired);
        return (true, vpfiRequired);
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /// @dev Shared conversion: fee expressed in `feeAsset` wei → VPFI (18 dec)
    ///      via the configured Chainlink feeds and the fixed ETH→VPFI rate.
    ///      Returns `(false, 0)` on any missing oracle / config input,
    ///      malformed ERC-20 decimals, or a zero intermediate result.
    ///      Never reverts.
    /// @param feeAsset            ERC-20 the fee is denominated in.
    /// @param feeAmountInAssetWei Fee amount in `feeAsset` wei (native decimals).
    /// @return canQuote           True iff all oracle / config inputs resolved.
    /// @return vpfiRequired       VPFI (18 dec) equivalent of the fee.
    function _feeAssetWeiToVPFI(
        address feeAsset,
        uint256 feeAmountInAssetWei
    ) private view returns (bool canQuote, uint256 vpfiRequired) {
        if (feeAsset == address(0) || feeAmountInAssetWei == 0) return (false, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 weiPerVpfi = s.vpfiFixedRateWeiPerVpfi;
        address ethRefAsset = s.vpfiDiscountETHPriceAsset;
        if (weiPerVpfi == 0 || ethRefAsset == address(0)) return (false, 0);
        if (s.vpfiToken == address(0)) return (false, 0);

        uint256 lendPrice;
        uint8 lendFeedDec;
        try OracleFacet(address(this)).getAssetPrice(feeAsset) returns (
            uint256 p,
            uint8 d
        ) {
            lendPrice = p;
            lendFeedDec = d;
        } catch {
            return (false, 0);
        }

        uint256 ethPrice;
        uint8 ethFeedDec;
        try OracleFacet(address(this)).getAssetPrice(ethRefAsset) returns (
            uint256 p,
            uint8 d
        ) {
            ethPrice = p;
            ethFeedDec = d;
        } catch {
            return (false, 0);
        }

        if (lendPrice == 0 || ethPrice == 0) return (false, 0);

        uint8 lendTokenDec = _safeTokenDecimals(feeAsset);
        uint8 ethTokenDec = _safeTokenDecimals(ethRefAsset);
        if (lendTokenDec == 0 || ethTokenDec == 0) return (false, 0);

        uint256 feeUsd1e18 = (feeAmountInAssetWei * lendPrice * 1e18) /
            (10 ** lendFeedDec) /
            (10 ** lendTokenDec);
        if (feeUsd1e18 == 0) return (false, 0);

        uint256 feeWei = (feeUsd1e18 *
            (10 ** ethTokenDec) *
            (10 ** ethFeedDec)) /
            (ethPrice * 1e18);
        if (feeWei == 0) return (false, 0);

        vpfiRequired = (feeWei * 1e18) / weiPerVpfi;
        canQuote = vpfiRequired > 0;
    }

    /// @dev `decimals()` on a malformed ERC-20 can revert or return 0 —
    ///      treat either as "can't quote" by returning 0.
    /// @param token ERC-20 to inspect.
    /// @return dec  Token decimals, or 0 when the call reverts / returns 0.
    function _safeTokenDecimals(address token) private view returns (uint8 dec) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 0;
        }
    }
}
