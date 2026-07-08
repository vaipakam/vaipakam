// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {LibMetricsHooks} from "./LibMetricsHooks.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {LibFacet} from "./LibFacet.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {LenderIntentFacet} from "../facets/LenderIntentFacet.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/**
 * @title LibConsolidation
 * @author Vaipakam Developer Team
 * @notice #594 — consolidate a transferred loan position into the **current**
 *         position-NFT holder's vault, so `loan.{borrower|lender} == vault
 *         owner == NFT holder` again and the position becomes an *ordinary*
 *         loan (no borrower-pin special case). Full design in
 *         `docs/DesignsAndPlans/CollateralConsolidationToHolder.md`.
 * @dev    The primitive moves four things as one atomic unit (§1): the vaulted
 *         asset, the side-specific encumbrance lien, the loan custody anchor,
 *         and the VPFI tier stamp — plus the off-anchor accounting (rewards,
 *         intent exposure, metrics, the append-only user-loan index). It
 *         **self-resolves** the holder from `ownerOf` and enforces NO caller
 *         check (the holder auth lives only in the standalone wrapper, k95), so
 *         it composes with permissionless / keeper-driven hosts.
 *
 *         The lien re-key precedes the asset move (§4): no ERC-721/1155
 *         `onReceived` callback can observe the asset in the destination vault
 *         while the lien still points at the old one.
 */
library LibConsolidation {
    /// @notice Sanctions context (§2 step 3 / D-5). `Tier1Strict` reverts on a
    ///         sanctioned holder; `Tier2CloseOut` returns {Result.Skipped}
    ///         (the retail sanctions policy keeps close-outs open).
    enum Ctx {
        Tier1Strict,
        Tier2CloseOut
    }

    /// @notice Outcome of a consolidation attempt (§2 step 1 / D-3). The
    ///         standalone wrapper maps `Skipped` → `ConsolidationNotAllowed`;
    ///         `NoOp`/`AlreadyConsolidated`/`Consolidated` all succeed.
    enum Result {
        Consolidated, // moved assets + re-anchored
        AlreadyConsolidated, // current == stored (common no-op)
        NoOp, // terminal loan (nothing live)
        Skipped // excluded-live state, or Tier2 sanctioned holder
    }

    /// @notice Emitted on a real consolidation (assets moved + re-anchored).
    event CollateralConsolidated(
        uint256 indexed loanId,
        bool isLenderSide,
        address indexed from,
        address indexed to,
        address asset,
        uint256 amount
    );

    /**
     * @notice Consolidate the `side` of `loanId` to its current NFT holder.
     * @param loanId       The loan.
     * @param isLenderSide true = lender (principal) side, false = borrower
     *                     (collateral) side.
     * @param ctx          Sanctions context (Tier-1 entry vs Tier-2 close-out).
     * @return The {Result} (never reverts on state alone; Tier1 sanctions and a
     *         genuine move can still revert).
     */
    function consolidateToHolder(
        uint256 loanId,
        bool isLenderSide,
        Ctx ctx
    ) internal returns (Result) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // 1. Status-gate BEFORE any `ownerOf` (terminal loans may have a burned
        //    position NFT, which would revert in `ownerOf`).
        LibVaipakam.LoanStatus st = loan.status;
        if (
            st == LibVaipakam.LoanStatus.Repaid ||
            st == LibVaipakam.LoanStatus.Settled ||
            st == LibVaipakam.LoanStatus.Defaulted ||
            st == LibVaipakam.LoanStatus.InternalMatched
        ) {
            return Result.NoOp;
        }
        if (_isExcludedLive(s, loan, loanId, isLenderSide)) {
            return Result.Skipped;
        }

        // 2. Resolve the current holder (self-resolve; NO caller check — k95).
        uint256 tokenId = isLenderSide
            ? loan.lenderTokenId
            : loan.borrowerTokenId;
        address current = IERC721(address(this)).ownerOf(tokenId);
        address stored = isLenderSide ? loan.lender : loan.borrower;

        // 3. Sanctions, driven by `ctx`, evaluated BEFORE the
        //    already-consolidated short-circuit so a Tier1 hook on an
        //    already-consolidated position still checks (zP7).
        if (ctx == Ctx.Tier1Strict) {
            LibVaipakam._assertNotSanctioned(current); // reverts if flagged
        } else if (LibVaipakam.isSanctionedAddress(current)) {
            // #1123 — non-reverting oracle-up observation of a flagged current
            // holder: register them in the confirmed-flagged registry so they
            // cannot move the position during a later oracle outage. Direct write
            // (the `isSanctionedAddress` read above already confirmed the flag with
            // the oracle reachable — no second oracle call needed).
            LibVaipakam.storageSlot().sanctionsConfirmedFlagged[current] = true;
            return Result.Skipped; // Tier-2: skip, never block the close-out
        }
        if (current == stored) {
            return Result.AlreadyConsolidated;
        }

        // 4. Destination vault.
        address toProxy = VaultFactoryFacet(address(this)).getOrCreateUserVault(
            current
        );

        // 5. Re-key the side-specific lien FIRST (before the move).
        LibEncumbrance.rekeyLienToHolder(loanId, current, isLenderSide);

        // 6. Move the side's vaulted asset (if any). Codex #659 P1 — open the
        //    sanctions-exempt window around ONLY this from-side withdrawal: the
        //    `stored` owner may have been sanctions-flagged AFTER transferring
        //    the position, and `VaultFactoryFacet.vaultWithdraw*` resolves their
        //    vault through the Tier-1-gated `getOrCreateUserVault`. The stored
        //    party is losing custody (asset pushed OUT to the already-checked
        //    `current` holder), so the receive-side gate must not brick the
        //    Tier-2 close-out. Round-3: the exemption is pinned to the exact
        //    `stored` address (not a blanket flag), so a token transfer that
        //    reenters mid-move cannot resolve a DIFFERENT flagged wallet's vault
        //    through it. Cleared immediately after.
        s.consolidationMoveFromUser = stored;
        (address movedAsset, uint256 movedAmount) = isLenderSide
            ? _moveLenderHeld(s, loan, loanId, stored, current, toProxy)
            : _moveBorrowerCollateral(s, loan, stored, current, toProxy);
        s.consolidationMoveFromUser = address(0);

        // 7. Mutate the anchor + append-only index (dup-protected) + metrics.
        if (isLenderSide) {
            loan.lender = current;
        } else {
            loan.borrower = current;
        }
        _appendUserLoanIfAbsent(s, current, loanId); // append-only, no duplicates
        LibMetricsHooks.markUserSeen(s, current);

        // 8. Reassign the off-anchor accounting. The reward entry is RE-POINTED
        //    to the holder (consolidation is not a sale — the entry transfers
        //    intact and stays sweep-discoverable; Codex #655 Msn).
        LibInteractionRewards.repointRewardEntry(loanId, current, isLenderSide);
        if (isLenderSide) {
            // Release the LenderIntentVault exposure off the departed lender —
            // a passive transfer + consolidation is economically a lender exit.
            if (s.intentOrigin[loanId].owner != address(0)) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        LenderIntentFacet.releaseIntentExposure.selector,
                        loanId
                    ),
                    bytes4(0)
                );
            }
        }

        // 9. Re-stamp the VPFI discount tier + staking checkpoint for both
        //    vaults with post-move balances (D-4 / k-D).
        _restampVpfi(s, stored, current);

        emit CollateralConsolidated(
            loanId,
            isLenderSide,
            stored,
            current,
            movedAsset,
            movedAmount
        );
        return Result.Consolidated;
    }

    // ─── Exclusion detection (side-scoped — D-3 principle 1) ────────────────

    /// @dev True if `loan` is in an excluded *live* state for the given side.
    ///      Borrower-side exclusions (live prepay listing / offer-keyed
    ///      parallel-sale listing / live swap-to-repay intent) do NOT block the
    ///      lender side. `FallbackPending` is excluded for both (the collateral
    ///      lien is released + the snapshot sits in Diamond custody).
    function _isExcludedLive(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        bool isLenderSide
    ) private view returns (bool) {
        if (loan.status == LibVaipakam.LoanStatus.FallbackPending) {
            return true;
        }
        // NFT rentals are OUT OF SCOPE for #594 (design §3.1/§3.2, Codex #655
        // Msj): a rental's backing is the prepay pool (borrower) / prepayAsset
        // proceeds (lender), NOT the generic collateral leg these moves handle.
        // `loan.assetType != ERC20` identifies a rental (the LENT asset is the
        // NFT). Exclude both sides until a rental-aware consolidation is built
        // (tracked in #654).
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            return true;
        }
        if (isLenderSide) {
            // #597 dependency (Codex #655 Msm + YPp): a VPFI `heldForLender`
            // amount can be PARTIALLY reserved — preclose/offset add *unreserved*
            // VPFI to the accumulator while a partial internal match adds
            // *reserved* VPFI to the SAME accumulator. Any unreserved portion,
            // once moved into the holder's vault, is a FREE, unstake-drainable
            // balance (the holder could `withdrawVPFIFromVault` before claim). So
            // skip unless the held VPFI is **fully reserved IN VPFI**
            // (`reservedAsset == vpfi && reserved >= held`) — the
            // fully-reserved case is handled safely because the lender-side lien
            // re-key (§2 step 5) carries the reservation across with the balance.
            // The partially- or un-reserved case waits for #597.
            uint256 held = s.heldForLender[loanId];
            if (held != 0 && loan.principalAsset == s.vpfiToken) {
                bool fullyVpfiReserved = s.lenderProceedsEncumberedAsset[
                    loanId
                ] ==
                    s.vpfiToken &&
                    s.lenderProceedsEncumbered[loanId] >= held;
                if (!fullyVpfiReserved) return true;
            }
        } else {
            // Borrower-side-only locks.
            if (s.prepayListingOrderHash[loanId] != bytes32(0)) return true;
            if (
                s.offerPrepayListingOrderHash[uint96(loan.offerId)] !=
                bytes32(0)
            ) return true;
            if (s.intentCommits[loanId].orderHash != bytes32(0)) return true;
        }
        return false;
    }

    /// @dev Append `loanId` to `user`'s loan index ONLY if not already present
    ///      (Codex #655 Msl) — re-anchoring to a holder already indexed for the
    ///      loan (e.g. a lender who acquired the borrower NFT, or a transfer
    ///      back to a prior holder) must not double-count: the metrics /
    ///      dashboard readers walk `userLoanIds` without de-duping.
    function _appendUserLoanIfAbsent(
        LibVaipakam.Storage storage s,
        address user,
        uint256 loanId
    ) private {
        uint256[] storage ids = s.userLoanIds[user];
        uint256 n = ids.length;
        for (uint256 i; i < n; ) {
            if (ids[i] == loanId) return; // already indexed
            unchecked {
                ++i;
            }
        }
        ids.push(loanId);
    }

    // ─── Asset moves ────────────────────────────────────────────────────────

    /// @dev Move the borrower's collateral `stored` → `current`. ERC-20 moves
    ///      directly (+ tracked-balance record); ERC-721/1155 use the
    ///      Diamond-mediated two-leg move (the lien is already re-keyed, so the
    ///      withdraw guard sees the source balance as free).
    function _moveBorrowerCollateral(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        address stored,
        address current,
        address toProxy
    ) private returns (address asset, uint256 amount) {
        asset = loan.collateralAsset;
        LibVaipakam.AssetType t = loan.collateralAssetType;
        if (t == LibVaipakam.AssetType.ERC20) {
            amount = loan.collateralAmount;
            if (amount == 0) return (asset, 0);
            _moveERC20(stored, current, asset, amount, toProxy);
        } else if (t == LibVaipakam.AssetType.ERC721) {
            amount = 1;
            _moveNFT(s, stored, asset, loan.collateralTokenId, 1, toProxy, true);
        } else {
            // ERC1155
            amount = loan.collateralQuantity;
            if (amount == 0) return (asset, 0);
            _moveNFT(
                s,
                stored,
                asset,
                loan.collateralTokenId,
                amount,
                toProxy,
                false
            );
        }
    }

    /// @dev Move the lender's physically-held proceeds `stored` → `current`.
    ///      For an active ERC-20 loan the principal already left the lender
    ///      vault, so usually nothing moves; `heldForLender[loanId]` (parked
    ///      from preclose/offset, denominated in the loan's principal asset)
    ///      moves when non-zero. The `lenderProceedsEncumbered` reservation was
    ///      already re-keyed in step 5.
    function _moveLenderHeld(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        address stored,
        address current,
        address toProxy
    ) private returns (address asset, uint256 amount) {
        amount = s.heldForLender[loanId];
        if (amount == 0) return (address(0), 0);
        // heldForLender is in the payment asset; for ERC-20 loans that is the
        // principal asset. (NFT-rental lender positions are excluded upstream,
        // so the prepay-asset case does not reach here.)
        asset = loan.principalAsset;
        _moveERC20(stored, current, asset, amount, toProxy);
    }

    /// @dev ERC-20 vault→vault: withdraw from `stored` (decrements its tracked
    ///      balance) to `toProxy`, then record the deposit under `current`.
    function _moveERC20(
        address stored,
        address current,
        address asset,
        uint256 amount,
        address toProxy
    ) private {
        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            stored,
            asset,
            toProxy,
            amount
        );
        VaultFactoryFacet(address(this)).recordVaultDepositERC20(
            current,
            asset,
            amount
        );
    }

    /// @dev ERC-721/1155 Diamond-mediated two-leg move (§2 step 6 / D-6). Arm
    ///      the receiver pin, withdraw NFT `stored` → Diamond (leg 1, accepted +
    ///      pin consumed by {ReceiverFacet}), then push Diamond → `toProxy`
    ///      (leg 2; operator == Diamond, accepted by the dest gate). No
    ///      tracked-balance bump (NFTs are not in the ERC-20 counter — iWB).
    function _moveNFT(
        LibVaipakam.Storage storage s,
        address stored,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address toProxy,
        bool is721
    ) private {
        // Arm the pin for leg 1.
        s.consolidationInFlight = true;
        s.consolidationExpectedToken = asset;
        s.consolidationExpectedTokenId = tokenId;
        s.consolidationExpectedAmount = amount;

        if (is721) {
            VaultFactoryFacet(address(this)).vaultWithdrawERC721(
                stored,
                asset,
                tokenId,
                address(this) // leg 1 → Diamond
            );
            IERC721(asset).safeTransferFrom(address(this), toProxy, tokenId); // leg 2
        } else {
            VaultFactoryFacet(address(this)).vaultWithdrawERC1155(
                stored,
                asset,
                tokenId,
                amount,
                address(this) // leg 1 → Diamond
            );
            IERC1155(asset).safeTransferFrom(
                address(this),
                toProxy,
                tokenId,
                amount,
                ""
            ); // leg 2
        }

        // Defensive: the ReceiverFacet consumes the pin on accept; clear it
        // unconditionally in case leg 1 used a non-callback path.
        if (s.consolidationInFlight) {
            s.consolidationInFlight = false;
            s.consolidationExpectedToken = address(0);
            s.consolidationExpectedTokenId = 0;
            s.consolidationExpectedAmount = 0;
        }
    }

    // ─── VPFI re-stamp ──────────────────────────────────────────────────────

    /// @dev Re-stamp the VPFI discount tier and staking checkpoint for both the
    ///      departed and the new vault with post-move tracked balances. A no-op
    ///      when neither balance changed (the moved asset was not VPFI), so it
    ///      is safe to call unconditionally (D-4).
    function _restampVpfi(
        LibVaipakam.Storage storage s,
        address stored,
        address current
    ) private {
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) return;
        uint256 storedBal = s.protocolTrackedVaultBalance[stored][vpfi];
        uint256 currentBal = s.protocolTrackedVaultBalance[current][vpfi];
        LibVPFIDiscount.rollupUserDiscount(stored, storedBal);
        LibVPFIDiscount.rollupUserDiscount(current, currentBal);
    }

    /// @notice Re-stamp a SINGLE user's VPFI discount tier + staking checkpoint
    ///         at their CURRENT tracked VPFI balance.
    /// @dev    Codex #657 round-4 — a host that eagerly consolidates a
    ///         transferred VPFI-collateral position checkpoints the holder at
    ///         the FULL pre-withdraw balance (via {consolidateToHolder} →
    ///         {_restampVpfi}), then immediately WITHDRAWS some/all of that
    ///         collateral (partial-withdrawal, partial swap-to-repay, intent
    ///         commit to custody). Without a post-withdraw re-stamp the holder
    ///         keeps fee-tier / staking credit on VPFI that already left their
    ///         vault until the next VPFI action checkpoints them. Hosts call
    ///         this AFTER the withdrawal, passing `loan.borrower` (== the holder
    ///         post-consolidation), so the credit reflects the reduced balance
    ///         immediately. No-op when VPFI isn't configured. Mirrors the
    ///         "rollup at the mutation site with the post-mutation balance" rule.
    function restampUserVpfi(address user) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) return;
        uint256 bal = s.protocolTrackedVaultBalance[user][vpfi];
        LibVPFIDiscount.rollupUserDiscount(user, bal);
    }
}
