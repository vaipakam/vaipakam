// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMarketLedger} from "../libraries/LibMarketLedger.sol";

/**
 * @title  MarketLedgerFacet
 * @author Vaipakam Developer Team
 * @notice The instant market's common ledger (InstantMarketDesign §8): the
 *         Declared and Lent totals per lending asset and per pair, the step
 *         that keeps Declared in line with an Auto-lend slot, and the roll
 *         that moves the stored Declared totals past expired days.
 * @dev    Its own facet because `LenderIntentFacet` has no EIP-170 room for
 *         the ledger. It is the ONE host of the Declared writes:
 *         `LenderIntentFacet.setLenderIntent` and `cancelLenderIntent`, the
 *         only writers of the fields a slot's declared figure reads, self-call
 *         {syncDeclared}. Lent is written from the loan hooks
 *         (`LibMetricsHooks`, `LibInterestLedger`) and the intent fill, inline,
 *         because those run inside facets that cannot afford a self-call per
 *         principal change. Refreshed together with `LenderIntentFacet`: a
 *         slot writer refreshed onto a Diamond that does not route
 *         {syncDeclared} reverts every set and cancel (a hard revert, never a
 *         stale total).
 */
contract MarketLedgerFacet {
    /// @notice A Diamond-internal entry was called from outside the Diamond.
    error OnlyDiamondInternal();

    /// @notice Reconcile one Auto-lend slot's share of Declared with its
    ///         current `active`, `maxExposure` and `lendUntil`.
    /// @dev    Diamond-internal: self-called by `LenderIntentFacet` after it
    ///         writes the slot. Idempotent.
    function syncDeclared(address owner, address lendingAsset, address collateralAsset, uint8 slot)
        external
    {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibMarketLedger.syncIntent(
            s,
            s.lenderIntent[owner][lendingAsset][collateralAsset][slot],
            lendingAsset,
            collateralAsset,
            LibVaipakam.intentKeyHash(owner, lendingAsset, collateralAsset, slot)
        );
    }

    /// @notice Move the stored Declared totals for a lending asset and one of
    ///         its pairs forward over up to `maxDays` passed days, taking out
    ///         the slots whose fill window has closed. Anyone may call it.
    /// @dev    No figure depends on it: {getMarketLedger} and
    ///         {getPairLedger} subtract the days not yet rolled themselves,
    ///         and every slot write rolls its own asset and pair first (at
    ///         most `LibMarketLedger.MAX_ROLL_DAYS` days). It exists so a
    ///         write after a long quiet gap stays cheap. Moves no funds.
    function rollDeclaredLedger(address lendingAsset, address collateralAsset, uint256 maxDays)
        external
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibMarketLedger.roll(s.declaredByAsset[lendingAsset], maxDays);
        LibMarketLedger.roll(s.declaredByPair[lendingAsset][collateralAsset], maxDays);
    }

    /// @notice The common ledger for one lending asset, across every
    ///         collateral asset.
    /// @return declared The sum of `maxExposure` over every active Auto-lend
    ///         slot lending `lendingAsset` whose fill window is still open, as
    ///         of the start of today (UTC): a slot whose window closes today
    ///         counts until the day ends. It states what lenders have offered,
    ///         not what is in their vaults now; "available now" is an estimate
    ///         computed off-chain and labelled as one.
    /// @return lent The open principal of every ERC-20 loan in
    ///         `lendingAsset` that is `Active` or `FallbackPending`, from any
    ///         route.
    /// @return lentFromSlots The part of `lent` opened by Auto-lend slot
    ///         fills; with `declared`, how full the market is.
    function getMarketLedger(address lendingAsset)
        external
        view
        returns (uint256 declared, uint256 lent, uint256 lentFromSlots)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.LentTotals storage t = s.lentByAsset[lendingAsset];
        return (LibMarketLedger.declaredOf(s.declaredByAsset[lendingAsset]), t.all, t.fromSlots);
    }

    /// @notice The same three figures for one (lending asset, collateral
    ///         asset) pair. See {getMarketLedger}.
    function getPairLedger(address lendingAsset, address collateralAsset)
        external
        view
        returns (uint256 declared, uint256 lent, uint256 lentFromSlots)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.LentTotals storage t = s.lentByPair[lendingAsset][collateralAsset];
        return (
            LibMarketLedger.declaredOf(s.declaredByPair[lendingAsset][collateralAsset]),
            t.all,
            t.fromSlots
        );
    }
}
