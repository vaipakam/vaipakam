// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title  LibFeeEntitlement
 * @notice #1347 (M2 PR-5a/5b) — pricing + per-party absorption helpers for the
 *         Full VPFI tariff, per the LIF·year absorption design
 *         (`VpfiAbsorptionDistributionFormulaRedesign.md` §F, rev 15).
 *
 *         The tariff is **fee-native**: `C* = baseLif_list × tYears × K`, where
 *         `baseLif_list` is the LIST (pre-discount) Loan-Initiation Fee
 *         converted to protocol numeraire (1e18), `tYears = durationDays / 365`,
 *         and `K = cfgTariffKPerLifYear()` (default 5e18). It is NEVER a
 *         `feeUSD / vpfiPrice` conversion and NEVER the retired ETH·day volume
 *         schedule.
 *
 *         Full is **per-party** (double absorption): each of borrower and lender
 *         that opts into Full pays ONE `C*` from THEIR OWN vault into the
 *         recycle bucket (`RecycleSource.FullTariff`). Both Full ⇒ `2 × C*`
 *         absorbed. The tariff is non-refundable and lives OUTSIDE the
 *         `borrowerLifRebate` settle/forfeit machinery — it is credited straight
 *         to the bucket at initiation and never recorded as `vpfiHeld`.
 *
 * @dev    Library, delegatecalled from {FeeEntitlementFacet}. `address(this)`
 *         resolves to the Diamond in every function below, exactly as in
 *         {LibNotificationFee}. Ships DARK: {resolveAndCharge} treats every
 *         Full opt-in as a failed opt-in while `cfgFeeEntitlementEnabled()` is
 *         false (revert unless the party set `allowFullDowngrade`).
 */
library LibFeeEntitlement {
    /// @notice Full opt-in presented while the tariff kill switch is off and the
    ///         party did not permit a downgrade to HoldOnly/None.
    error FeeEntitlementDisabled();
    /// @notice Quoted `C*` exceeds the party's signed/calldata `maxCStar` and
    ///         the party did not permit a downgrade.
    error FeeEntitlementTariffAboveAuth(uint256 quotedCStar, uint256 maxCStar);
    /// @notice Full opt-in could not complete (vault short of `C*`, or the list
    ///         LIF could not be priced to numeraire) and no downgrade permitted.
    error FeeEntitlementFullOptInFailed(address party);

    /**
     * @notice Compute the notional Full tariff `C*` for a loan.
     * @dev    `C* = baseLifListNumeraire18 × tYears × K`, all fixed-point 1e18.
     *         `numeraireOk` is false only when the list LIF could not be priced
     *         (feed unavailable / token has no decimals) — the caller decides
     *         whether that blocks a Full opt-in (it does) or merely stamps the
     *         loan reward-ineligible (`cStar = 0`).
     * @param  lendingAsset  The loan's ERC-20 principal asset.
     * @param  principal     Filled principal in lending-asset wei.
     * @param  durationDays  Loan term in days (floored to ≥ 1).
     * @return cStar         Notional tariff in VPFI wei (1e18); 0 when unpriced.
     * @return numeraireOk   True iff the list LIF resolved a numeraire price.
     */
    function computeCStar(
        address lendingAsset,
        uint256 principal,
        uint256 durationDays
    ) internal view returns (uint256 cStar, bool numeraireOk) {
        uint256 baseLifTokenWei = (principal *
            LibVaipakam.cfgLoanInitiationFeeBps()) / LibVaipakam.BASIS_POINTS;
        (uint256 baseLifNumeraire18, bool feedOk) = _lifToNumeraire18(
            lendingAsset,
            baseLifTokenWei
        );
        if (!feedOk) return (0, false);
        numeraireOk = true;

        uint256 dd = durationDays == 0 ? 1 : durationDays;
        // tYears as 1e18 fixed-point, then C* = base × tYears × K, unscaling
        // each 1e18 multiply. Ordering keeps the intermediate under 2^256 for
        // any realistic (base ≤ ~1e30, dd ≤ ~1e4, K ≤ 5e19) input.
        uint256 tYearsRay = (dd * 1e18) / LibVaipakam.DAYS_PER_YEAR;
        // Staged 1e18 unscale after each multiply — the exact form the design
        // doc specifies (§F4) to keep the intermediate bounded well under 2^256
        // for large principals; a single fused multiply could overflow. The
        // per-stage rounding loss is ≤ 1 wei-VPFI, immaterial to the tariff.
        // forge-lint: disable-next-line(divide-before-multiply)
        cStar =
            (((baseLifNumeraire18 * tYearsRay) / 1e18) *
                LibVaipakam.cfgTariffKPerLifYear()) /
            1e18;
    }

    /**
     * @notice Resolve one party's fee-entitlement mode and, when Full, pull the
     *         `C*` tariff from their vault into the recycle bucket.
     * @dev    Frozen decision order (§F rev 14/15, steps 4–6):
     *          1. Not opting into Full → HoldOnly (if hold-eligible) or None.
     *          2. Full but kill switch off → revert {FeeEntitlementDisabled}
     *             unless `allowDowngrade` (then HoldOnly/None).
     *          3. Full but `C*` unpriced or `C* > maxCStar` or vault short →
     *             revert (tariff-above-auth / full-opt-in-failed) unless
     *             `allowDowngrade`.
     *          4. Otherwise → pull `C*` (vault → Diamond), restamp the discount
     *             accumulator at the post-pull tracked balance, credit the
     *             recycle bucket, and stamp mode = Full, `tariffPaid = C*`.
     *
     *         Never silently ignores a Full opt-in: a party that authorized Full
     *         and cannot complete reverts the whole accept unless it explicitly
     *         permitted a downgrade.
     */
    function resolveAndCharge(
        uint256 loanId,
        address party,
        bool wantsFull,
        uint256 maxCStar,
        bool allowDowngrade,
        bool holdEligible,
        bool liquid,
        uint256 cStar,
        bool numeraireOk
    ) internal returns (LibVaipakam.FeeEntitlementMode mode, uint256 tariffPaid) {
        if (!wantsFull) {
            return (
                holdEligible
                    ? LibVaipakam.FeeEntitlementMode.HoldOnly
                    : LibVaipakam.FeeEntitlementMode.None,
                0
            );
        }

        // The party authorized Full — from here a failure reverts unless the
        // party permitted a downgrade.
        if (!LibVaipakam.cfgFeeEntitlementEnabled()) {
            if (allowDowngrade) return _downgrade(holdEligible);
            revert FeeEntitlementDisabled();
        }
        // Full requires a LIQUID principal, not merely a priceable one: the
        // own-side discount (`holdOnlyBorrowerLif`) is gated on accept-time
        // liquidity, so a priceable-but-illiquid asset (feed exists but the DEX
        // depth/slippage probe fails) would otherwise pull `C*` with NO paired
        // discount. Treat `!liquid` as a failed Full opt-in — same as unpriced.
        if (!numeraireOk || !liquid) {
            if (allowDowngrade) return _downgrade(holdEligible);
            revert FeeEntitlementFullOptInFailed(party);
        }
        if (cStar > maxCStar) {
            if (allowDowngrade) return _downgrade(holdEligible);
            revert FeeEntitlementTariffAboveAuth(cStar, maxCStar);
        }

        if (_vaultVpfiBalance(party) < cStar) {
            if (allowDowngrade) return _downgrade(holdEligible);
            revert FeeEntitlementFullOptInFailed(party);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;

        // Pull C* into Diamond custody, restamp the discount accumulator at the
        // post-mutation tracked balance (an unstake must take effect
        // immediately for every open loan's average), then credit the bucket.
        // Mirrors LibNotificationFee.bill's pull → rollup → credit sequence.
        //
        // GUARD the withdrawal. The CLEAN-downgrade cases — vault short of `C*`,
        // or `C*` encumbered by an active lien — are already caught by the
        // FREE-balance pre-check above ({_vaultVpfiBalance} mirrors
        // `vaultWithdrawERC20`'s cap exactly), so a downgrade-authorized party
        // falls back to HoldOnly/None there WITHOUT the accept bricking (Codex
        // #1366 r2 P2) AND before the pre-mint borrower +10% LIF bump could have
        // been granted on stale info. This catch therefore only fires on the
        // RESIDUAL (a paused VPFI token / an unexpected transfer failure), where
        // it must REVERT rather than silently downgrade: {chargeBorrowerLifAndDeliver}
        // may already have applied the Full +10% LIF discount (keyed on the same
        // free-balance {fullOptInConfirmed}), so downgrading here would leave the
        // borrower the cheaper fee with no paired `C*` (Codex #1366 r4 P2). A
        // revert rolls the whole accept — bump included — back atomically.
        try
            VaultFactoryFacet(address(this)).vaultWithdrawERC20(
                party,
                vpfi,
                address(this),
                cStar
            )
        {
            // pulled — fall through to rollup + credit
        } catch {
            revert FeeEntitlementFullOptInFailed(party);
        }
        LibVPFIDiscount.rollupUserDiscount(
            party,
            s.protocolTrackedVaultBalance[party][vpfi]
        );
        LibVpfiRecycle.credit(
            LibVpfiRecycle.RecycleSource.FullTariff,
            loanId,
            cStar
        );
        return (LibVaipakam.FeeEntitlementMode.Full, cStar);
    }

    /**
     * @notice Whether a party's Full opt-in would CONFIRM at this instant —
     *         kill switch on, list-LIF priceable, `C* ≤ maxCStar`, and the vault
     *         holds `≥ C*` VPFI. Pure read (no state change, no revert).
     * @dev    Lets the PRE-mint borrower Loan-Initiation-Fee path apply the Full
     *         own-side `+10%` bump in lockstep with the POST-mint `C*` charge in
     *         {resolveAndCharge}: both run in the same non-reentrant tx against
     *         unchanged storage (the LIF is charged in the lending asset — no
     *         VPFI moves between the two), so their verdicts are identical. If
     *         this returns true the later {resolveAndCharge} necessarily also
     *         charges Full; if false, {resolveAndCharge} downgrades or reverts —
     *         and a revert rolls the whole accept (LIF included) back, so the
     *         bump can never be granted without the tariff being taken.
     * @return confirmed True iff a Full charge would complete right now.
     */
    function fullOptInConfirmed(
        address party,
        bool wantsFull,
        uint256 maxCStar,
        address lendingAsset,
        uint256 principal,
        uint256 durationDays,
        bool liquid
    ) internal view returns (bool confirmed) {
        if (!wantsFull || !LibVaipakam.cfgFeeEntitlementEnabled() || !liquid) {
            return false;
        }
        (uint256 cStar, bool numeraireOk) = computeCStar(
            lendingAsset,
            principal,
            durationDays
        );
        if (!numeraireOk || cStar > maxCStar) return false;
        return _vaultVpfiBalance(party) >= cStar;
    }

    /// @dev The party's WITHDRAWABLE (FREE) VPFI vault balance — mirroring
    ///      `VaultFactoryFacet.vaultWithdrawERC20`'s cap EXACTLY: the raw
    ///      `balanceOf` capped by `protocolTrackedVaultBalance` (which excludes
    ///      unsolicited dust) and then reduced by the active `(user, VPFI, 0)`
    ///      lien aggregate via {LibEncumbrance.freeBalance}. Both the pre-mint
    ///      {fullOptInConfirmed} preview (which gates the borrower's +10% LIF
    ///      bump) and {resolveAndCharge}'s authoritative pull-gate read THIS, so
    ///      they agree with the withdrawal. Using the gross tracked balance would
    ///      let ENCUMBERED VPFI (e.g. locked by the user's own borrower offer)
    ///      "confirm" a Full whose withdrawal then reverts — stranding the +10%
    ///      LIF discount with no paired `C*` on a downgrade-authorized accept
    ///      (Codex #1366 r3 P1). A residual token-PAUSE failure is still caught
    ///      by {resolveAndCharge}'s try/catch (accept never bricks).
    function _vaultVpfiBalance(address party) private view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) return 0;
        address vault = s.userVaipakamVaults[party];
        if (vault == address(0)) return 0;
        uint256 tracked = s.protocolTrackedVaultBalance[party][vpfi];
        uint256 raw = IERC20(vpfi).balanceOf(vault);
        uint256 capped = tracked < raw ? tracked : raw;
        return LibEncumbrance.freeBalance(party, vpfi, 0, capped);
    }

    /// @dev A permitted downgrade from Full → HoldOnly (if the party is
    ///      hold-eligible) or None, with no tariff pulled.
    function _downgrade(
        bool holdEligible
    ) private pure returns (LibVaipakam.FeeEntitlementMode, uint256) {
        return (
            holdEligible
                ? LibVaipakam.FeeEntitlementMode.HoldOnly
                : LibVaipakam.FeeEntitlementMode.None,
            0
        );
    }

    /// @dev List-LIF wei → protocol numeraire (1e18). Same conversion family as
    ///      {LibInteractionRewards} interest numeraire: `amount × price × 1e18 /
    ///      10^feedDec / 10^tokenDec`. `feedOk` is false on any oracle/decimals
    ///      failure so the caller can distinguish "unpriced" from "zero LIF".
    function _lifToNumeraire18(
        address asset,
        uint256 amount
    ) private view returns (uint256 value, bool feedOk) {
        if (asset == address(0)) return (0, false);

        uint256 price;
        uint8 feedDec;
        try OracleFacet(address(this)).getAssetPrice(asset) returns (
            uint256 p,
            uint8 d
        ) {
            price = p;
            feedDec = d;
        } catch {
            return (0, false);
        }
        if (price == 0) return (0, false);

        // A zero-decimal ERC-20 is legitimately priceable (`10 ** 0 == 1`); only
        // a REVERTING `decimals()` is treated as unpriceable, matching the other
        // numeraire conversions in this codebase (Codex #1366 r4 P3).
        uint8 tokenDec;
        try IERC20Metadata(asset).decimals() returns (uint8 d) {
            tokenDec = d;
        } catch {
            return (0, false);
        }

        feedOk = true;
        value = (amount * price * 1e18) / (10 ** feedDec) / (10 ** tokenDec);
    }
}
