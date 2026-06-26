// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibMetricsTypes} from "../libraries/LibMetricsTypes.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title LenderIntentFacet
 * @author Vaipakam Developer Team
 * @notice #393 v1 — the LenderIntentVault standing-terms surface. A lender
 *         registers a set-and-forget lending INTENT for an ERC-20 asset-pair
 *         (bounds: max exposure, min APR, max init-LTV, max term, min slice);
 *         a permissioned solver later materializes concrete offers within those
 *         bounds via `OfferMatchFacet.matchIntent` (v1-b), consuming the
 *         lender's EXISTING per-user vault balance. The lender-of-record stays
 *         the depositing user (`loan.lender` = the intent owner), so the vault
 *         is never the on-chain lender and every downstream claim / VPFI / KYC /
 *         sanctions path is the existing, audited one — unchanged. See
 *         docs/DesignsAndPlans/LenderIntentVaultV1Design.md §1 + §3.1.
 *
 * @dev    Surface: set/cancel/read the intent terms, PLUS the v1-d working-
 *         capital lifecycle. `fundLenderIntent` pulls the lender's wallet
 *         capital into their vault and LIENS it under the intent (mirroring
 *         how `createOffer` pre-vaults + locks an offer's principal);
 *         `matchIntent` (OfferMatchFacet) draws fill slices from that lien;
 *         `withdrawLenderIntentCapital` returns the un-lent remainder to the
 *         wallet (the `cancelOffer` exit pattern). Liened capital is never
 *         free balance, so no other vault-withdraw door can reach it — and
 *         repaid proceeds (which return as free balance + a Position-NFT
 *         claim) can never be double-spent through the exit door. The
 *         lender-of-record stays the depositing user (`loan.lender` = the
 *         intent owner). ERC-20-on-ERC-20 only. One intent per (owner,
 *         lendingAsset, collateralAsset).
 */
contract LenderIntentFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    DiamondAccessControl
{
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice A lender registered / updated a standing intent for an asset-pair.
    event LenderIntentSet(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset,
        uint256 maxExposure,
        uint256 minRateBps,
        uint16 maxInitLtvBps,
        uint32 maxDurationDays,
        uint256 minFillAmount,
        bool requiresKeeperAuth
    );

    /// @notice A lender tore down a standing intent for an asset-pair.
    event LenderIntentCancelled(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset
    );

    /// @notice The LenderIntentVault fill-path master kill-switch toggled.
    event LenderIntentEnabledSet(bool enabled);

    /// @notice A lender funded un-lent working capital into a standing intent
    ///         (#393 v1-d). `newCapital` is the post-fund liened total.
    event LenderIntentFunded(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset,
        uint256 amount,
        uint256 newCapital
    );

    /// @notice A lender withdrew un-lent working capital from a standing intent
    ///         back to their wallet (#393 v1-d). `remainingCapital` is the
    ///         post-withdraw liened total.
    event LenderIntentCapitalWithdrawn(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset,
        uint256 amount,
        uint256 remainingCapital
    );

    /// @notice A repaid intent loan was AUTO-ROLLED (#393 v1-d.2): its proceeds
    ///         (principal + interest) were re-liened into the owner's intent
    ///         capital instead of paid to a wallet. `roller` is the caller
    ///         (the owner or an authorized keeper); `newCapital` is the
    ///         post-roll liened total.
    event IntentLoanRolled(
        address indexed owner,
        address indexed roller,
        uint256 indexed loanId,
        address lendingAsset,
        address collateralAsset,
        uint256 rolledAmount,
        uint256 newCapital
    );

    /// @notice A loan reached the terminal Settled state. Mirrors the canonical
    ///         `ClaimFacet.LoanSettled` (same signature ⇒ same topic) so an
    ///         auto-roll-driven settle is indexed identically to a claim-driven
    ///         one (#393 v1-d.2, Codex #623 P3).
    event LoanSettled(uint256 indexed loanId);

    /// @notice A required address argument was the zero address.
    error LenderIntentZeroAddress();
    /// @notice `lendingAsset == collateralAsset` — a self-collateralized intent
    ///         the fill path's `createOffer` would reject (`SelfCollateralizedOffer`).
    error LenderIntentSelfCollateralized();
    /// @notice `maxExposure`, `minRateBps`, `maxInitLtvBps`, or `minFillAmount`
    ///         was outside its valid range (see `setLenderIntent`).
    error LenderIntentInvalidBounds();
    /// @notice No active intent exists for the (owner, asset-pair) to cancel.
    error LenderIntentNotActive();
    /// @notice A diamond-internal-only entry was called externally.
    error OnlyDiamondInternal();
    /// @notice VPFI cannot be an intent's LENDING asset (#393 v1-d.1, Codex
    ///         P2). VPFI's vaulted balance drives the fee-discount tier +
    ///         staking rewards, which the generic vault chokepoints the intent
    ///         fund / fill / withdraw paths use do NOT re-stamp
    ///         (`LibVPFIDiscount.rollupUserDiscount`). Lending VPFI through an
    ///         intent would silently drift that accounting, so it is rejected
    ///         at the root (registration) — VPFI as COLLATERAL stays supported.
    error LenderIntentVpfiLendingUnsupported();
    /// @notice `rollIntentLoan` was called on a loan that didn't originate from
    ///         an intent, or isn't in the clean fully-Repaid state auto-roll
    ///         requires (defaulted / liquidated / fallback loans must use the
    ///         normal claim path — their proceeds may be collateral-denominated
    ///         or partial).
    error LenderIntentLoanNotRollable();
    /// @notice The lender position was SOLD: the current position-NFT holder is
    ///         no longer the originating intent owner, so the repaid proceeds
    ///         are owed to the buyer (who claims them normally) and must NOT be
    ///         redirected into the original owner's intent capital.
    error LenderIntentPositionTransferred();
    /// @notice The loan's lender claim is missing, already consumed, or not the
    ///         intent's plain ERC-20 lending asset — nothing to roll.
    error LenderIntentNothingToRoll();

    /// @notice Register or overwrite the caller's standing lending intent for an
    ///         ERC-20 asset-pair.
    /// @dev    Tier-1 sanctions-gated (the intent is a new lending commitment).
    ///         Re-calling with the same pair overwrites the bounds in place
    ///         (live `matchIntent` reads always see the latest terms, so there
    ///         is no stale-terms window to invalidate — no nonce needed). The
    ///         bounds are a HARD band a solver's concrete terms must satisfy;
    ///         the protocol HF/LTV init gate still applies on top at fill.
    /// @param lendingAsset       The ERC-20 the lender supplies.
    /// @param collateralAsset    The ERC-20 collateral the lender will accept.
    /// @param maxExposure        Hard cap on aggregate LIVE principal from this
    ///                           intent (> 0).
    /// @param minRateBps         APR floor in basis points; a fill below reverts.
    /// @param maxInitLtvBps      The lender's own init-LTV ceiling in BPS
    ///                           (1..=BPS_DENOMINATOR); the protocol gate is the
    ///                           min of this and the per-asset/tier cap.
    /// @param maxDurationDays    Longest loan term the lender accepts (> 0).
    /// @param minFillAmount      Smallest slice a solver may fill (> 0,
    ///                           <= maxExposure).
    /// @param requiresKeeperAuth When true, only a solver the lender has
    ///                           authorized (v1-c keeper bit) may fill; when
    ///                           false the intent is openly fillable.
    /// @param riskAndTermsConsent Must be `true`. Mirrors the mandatory
    ///                           `creatorRiskAndTermsConsent` every offer-create
    ///                           path records: a standing intent is a lending
    ///                           commitment, so the lender consents to the
    ///                           risk/terms framework here, once, at registration
    ///                           (the loans it later materializes inherit it).
    function setLenderIntent(
        address lendingAsset,
        address collateralAsset,
        uint256 maxExposure,
        uint256 minRateBps,
        uint16 maxInitLtvBps,
        uint32 maxDurationDays,
        uint256 minFillAmount,
        bool requiresKeeperAuth,
        bool riskAndTermsConsent
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);

        // Mandatory risk/terms consent — same gate as every offer-create path
        // (`RiskAndTermsConsentRequired`), captured once for the standing intent.
        if (!riskAndTermsConsent) revert IVaipakamErrors.RiskAndTermsConsentRequired();

        if (lendingAsset == address(0) || collateralAsset == address(0)) {
            revert LenderIntentZeroAddress();
        }
        // A self-collateralized pair is unfillable: the fill path's `createOffer`
        // rejects `lendingAsset == collateralAsset` (`SelfCollateralizedOffer`),
        // so an intent advertised as active could never produce a loan.
        if (lendingAsset == collateralAsset) {
            revert LenderIntentSelfCollateralized();
        }
        // #393 v1-d.1 (Codex P2) — VPFI may not be the LENDING asset: its vault
        // balance is load-bearing for the fee-discount tier + staking rewards,
        // which the generic vault chokepoints used by the intent fund / fill /
        // withdraw paths don't re-stamp. Reject at the root so no VPFI-lending
        // intent can ever exist (fund / matchIntent / withdraw all require an
        // active intent, so this single gate covers the whole lifecycle). VPFI
        // as collateral is unaffected.
        if (lendingAsset == LibVaipakam.storageSlot().vpfiToken) {
            revert LenderIntentVpfiLendingUnsupported();
        }
        // #393 v1-c — `requiresKeeperAuth` is now honoured: a true intent is
        // fillable only by the lender or a solver they've authorized for
        // `KEEPER_ACTION_SIGNED_FILL` (gate enforced in `matchIntent`). No longer
        // rejected here.
        // Bounds sanity: exposure + slice positive, slice within exposure, an
        // LTV ceiling in (0, 100%], a positive term, and a rate floor at or
        // below the protocol interest ceiling so a materialized offer can
        // actually clear `createOffer` (which rejects rates > MAX_INTEREST_BPS).
        // `minRateBps == 0` is permitted (a 0% floor = "any rate").
        if (
            maxExposure == 0
                || minFillAmount == 0
                || minFillAmount > maxExposure
                || minRateBps > LibVaipakam.MAX_INTEREST_BPS
                || maxInitLtvBps == 0
                || maxInitLtvBps > LibVaipakam.BASIS_POINTS
                || maxDurationDays == 0
        ) {
            revert LenderIntentInvalidBounds();
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.lenderIntent[msg.sender][lendingAsset][collateralAsset] = LibVaipakam
            .LenderIntent({
            active: true,
            maxExposure: maxExposure,
            minRateBps: minRateBps,
            maxInitLtvBps: maxInitLtvBps,
            maxDurationDays: maxDurationDays,
            minFillAmount: minFillAmount,
            requiresKeeperAuth: requiresKeeperAuth
        });

        // #625 WI-2a — sync the discovery registry. A bare registration commits NO
        // capital, so it does NOT enter the keeper feed until funded — gating set
        // membership on funded capital blocks arbitrary zero-capital registrations
        // from bloating the global feed (Codex WI-2a r1).
        LibVaipakam.syncIntentRegistry(msg.sender, lendingAsset, collateralAsset);

        emit LenderIntentSet(
            msg.sender,
            lendingAsset,
            collateralAsset,
            maxExposure,
            minRateBps,
            maxInitLtvBps,
            maxDurationDays,
            minFillAmount,
            requiresKeeperAuth
        );
    }

    /// @notice Tear down the caller's standing intent for an asset-pair. No new
    ///         fills can materialize against it; loans already open from prior
    ///         fills are unaffected (they settle through the normal path) and
    ///         their live-principal is released at their own terminal close.
    /// @dev    Tier-2-style close-out: NOT sanctions-gated on the canceller, so a
    ///         flagged lender can always WIND DOWN their standing exposure.
    function cancelLenderIntent(address lendingAsset, address collateralAsset)
        external
        nonReentrant
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.LenderIntent storage intent =
            s.lenderIntent[msg.sender][lendingAsset][collateralAsset];
        if (!intent.active) revert LenderIntentNotActive();
        intent.active = false;
        // #625 WI-2a — now inactive ⇒ drop it from the discovery registry.
        LibVaipakam.syncIntentRegistry(msg.sender, lendingAsset, collateralAsset);
        emit LenderIntentCancelled(msg.sender, lendingAsset, collateralAsset);
    }

    /// @notice #393 v1-d — fund (or top up) the caller's standing intent with
    ///         un-lent working capital. Pulls `amount` of `lendingAsset` from
    ///         the caller's wallet into their per-user vault and LIENS it under
    ///         the intent — exactly as `createOffer` pre-vaults and locks an
    ///         offer's principal. Liened capital is the pool `matchIntent`
    ///         draws fill slices from; it is NOT free balance, so no other
    ///         vault-withdraw door can reach it, and it can only leave via a
    ///         fill or via {withdrawLenderIntentCapital}.
    /// @dev    Tier-1 sanctions-gated (new lending capital entering the
    ///         protocol). Requires an ACTIVE intent for the pair — fund follows
    ///         set, the way staking follows opt-in — so capital is never parked
    ///         without a governing intent. The caller must have approved the
    ///         Diamond for exactly `amount` of `lendingAsset` first (the
    ///         protocol's exact-amount approval convention).
    /// @param lendingAsset    The ERC-20 the intent supplies (must match an
    ///                        active intent).
    /// @param collateralAsset The intent's collateral asset (intent key).
    /// @param amount          Working capital to pull wallet → vault (> 0).
    function fundLenderIntent(
        address lendingAsset,
        address collateralAsset,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (amount == 0) revert LenderIntentInvalidBounds();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.lenderIntent[msg.sender][lendingAsset][collateralAsset].active) {
            revert LenderIntentNotActive();
        }
        // #393 v1-d.1 (Codex round-2 P2) — re-assert the VPFI-lending block at
        // the on-ramp, BEFORE custody moves. The `setLenderIntent` gate alone
        // isn't airtight: `vpfiToken` can be configured/rotated AFTER an intent
        // row was stored (or a pre-gate intent could survive an upgrade), and
        // such a row would otherwise fund VPFI through the generic chokepoint
        // with no discount/staking rollup. Blocking funding here transitively
        // blocks `matchIntent` too (it can only draw funded capital), so no
        // VPFI-denominated intent capital can ever form. The exit
        // (`withdrawLenderIntentCapital`) stays open so any pre-existing such
        // capital can still be wound down.
        if (lendingAsset == s.vpfiToken) {
            revert LenderIntentVpfiLendingUnsupported();
        }
        // #393 v1-d.1 (Codex P2) — respect the per-asset pause on this on-ramp:
        // a paused asset must take no NEW custody commitment (mirrors
        // `createOffer`, which pauses-checks both legs). The exit
        // (`withdrawLenderIntentCapital`) stays open during a pause so a lender
        // can always wind down — same "block new, allow exit" posture as the
        // sanctions Tier-1/Tier-2 split.
        LibFacet.requireAssetNotPaused(lendingAsset);
        LibFacet.requireAssetNotPaused(collateralAsset);
        // Pull wallet → vault via the protocol chokepoint (records the tracked
        // balance under the lender). Same on-ramp `createOffer` /
        // `depositVPFIToVault` use.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultDepositERC20.selector,
                msg.sender,
                lendingAsset,
                amount
            ),
            IVaipakamErrors.VaultDepositFailed.selector
        );
        // Lien the just-deposited capital under the intent (mirrors an offer's
        // principal lock). It is now encumbered — not free balance.
        LibEncumbrance.lienIntentCapital(
            msg.sender, lendingAsset, collateralAsset, amount
        );
        // #625 WI-2a — funded ⇒ the intent is now fillable; (re)list it in the feed.
        LibVaipakam.syncIntentRegistry(msg.sender, lendingAsset, collateralAsset);
        emit LenderIntentFunded(
            msg.sender,
            lendingAsset,
            collateralAsset,
            amount,
            s.lenderIntentCapital[msg.sender][lendingAsset][collateralAsset]
        );
    }

    /// @notice #393 v1-d — withdraw un-lent intent working capital back to the
    ///         caller's wallet: the standing-capital exit, modelled on
    ///         `cancelOffer`. Releases `amount` from the intent's capital lien
    ///         (reverts if it exceeds the un-lent liened capital) and withdraws
    ///         it from the vault to the caller. Because it only ever touches
    ///         the distinct intent lien, it can NEVER reach repaid proceeds
    ///         (which return as free balance + a Position-NFT claim) — so the
    ///         repaid-proceeds double-spend the #592 VPFI reservation guards
    ///         against is structurally impossible through this door.
    /// @dev    Tier-1 sanctions-gated (funds flow OUT to the caller). Does NOT
    ///         require the intent to still be active — a cancelled intent's
    ///         residual capital must stay withdrawable so a lender can fully
    ///         wind down. The lien release runs BEFORE the withdraw so the
    ///         vault chokepoint's free-balance guard sees the amount as free
    ///         (same ordering as `ClaimFacet` releasing the proceeds
    ///         reservation before paying out).
    /// @param lendingAsset    The intent's lending asset (intent key).
    /// @param collateralAsset The intent's collateral asset (intent key).
    /// @param amount          Un-lent capital to return wallet-ward (> 0,
    ///                        <= the liened capital).
    function withdrawLenderIntentCapital(
        address lendingAsset,
        address collateralAsset,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (amount == 0) revert LenderIntentInvalidBounds();
        // Release from the lien (reverts `IntentCapitalInsufficient` if it
        // exceeds the un-lent capital) BEFORE the withdraw, so the chokepoint
        // guard sees the amount as free balance.
        LibEncumbrance.unlienIntentCapital(
            msg.sender, lendingAsset, collateralAsset, amount
        );
        // #393 v1-d.1 (Codex round-3 P2) — this is the ONLY VPFI-as-lending path
        // left open (fund + matchIntent reject VPFI): the wind-down of capital
        // that became VPFI-denominated via a post-funding `vpfiToken` rotation.
        // The generic withdraw below doesn't re-stamp the VPFI discount/staking
        // accounting, so do it here (mirrors `VPFIDiscountFacet.withdrawVPFIFromVault`)
        // — else a lender keeps a stale high VPFI tier after pulling the VPFI
        // out. No-op for every non-VPFI lending asset (the common case).
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (lendingAsset == s.vpfiToken) {
            address vault = s.userVaipakamVaults[msg.sender];
            uint256 prevBal = IERC20(lendingAsset).balanceOf(vault);
            uint256 prevTracked = s.protocolTrackedVaultBalance[msg.sender][
                lendingAsset
            ];
            // Post-withdraw vault VPFI, clamped to the tracked counter so
            // unsolicited dust can't inflate the re-stamped tier.
            uint256 newBal = LibVPFIDiscount.clampToTracked(
                prevBal - amount, prevTracked - amount
            );
            LibVPFIDiscount.rollupUserDiscount(msg.sender, newBal);
        }
        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            msg.sender,
            lendingAsset,
            msg.sender,
            amount
        );
        // #625 WI-2a — capital may now be 0 ⇒ de-list the intent if depleted.
        LibVaipakam.syncIntentRegistry(msg.sender, lendingAsset, collateralAsset);
        emit LenderIntentCapitalWithdrawn(
            msg.sender,
            lendingAsset,
            collateralAsset,
            amount,
            s.lenderIntentCapital[msg.sender][lendingAsset][collateralAsset]
        );
    }

    /// @notice Master kill-switch for the standing-intent fill path
    ///         (`OfferMatchFacet.matchIntent`). Default `false`: lenders can
    ///         register intents but no fill executes until governance flips
    ///         this on post-bake. Same ship-off / governance-on / break-glass-
    ///         off pattern as `partialFillEnabled` / `internalMatchEnabled`.
    /// @dev    ADMIN_ROLE-only (TimelockController post-handover). Lives on this
    ///         facet (not `ConfigFacet`) because `ConfigFacet` is at the EIP-170
    ///         ceiling; the kill-switch sits with its feature.
    function setLenderIntentEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.lenderIntentEnabled = enabled;
        emit LenderIntentEnabledSet(enabled);
    }

    /// @notice Whether the standing-intent fill path is currently enabled
    ///         (the `setLenderIntentEnabled` kill-switch state).
    function isLenderIntentEnabled() external view returns (bool) {
        return LibVaipakam.cfgLenderIntentEnabled();
    }

    /// @notice #393 v1-b — release the live-principal a `matchIntent` loan
    ///         consumed, when its principal returns to the lender's vault at
    ///         lender-claim time. Self-gated (diamond-internal cross-facet call
    ///         from ClaimFacet). Keyed off the per-loan ORIGINATING intent —
    ///         NOT the current `loan.lender` (a lender-position sale mutates it),
    ///         so a sold position still releases the original owner's counter,
    ///         and a non-intent loan (`owner == address(0)`) is a no-op. Idempotent:
    ///         `delete` makes a second call a no-op.
    /// @dev    Lives here (not in the inlined `onLoanStatusChanged` hook) because
    ///         that hook inlines into every loan-transition facet and RiskFacet
    ///         is at the EIP-170 ceiling — the heavy triple-mapping decrement
    ///         must sit behind a single cross-facet boundary.
    function releaseIntentExposure(uint256 loanId) external {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntentOrigin memory io = s.intentOrigin[loanId];
        if (io.owner == address(0)) return; // not an intent-originated loan
        // Release the ORIGINAL fill amount (`io.amount`), NOT `loan.principal`
        // (a partial repayment reduces the latter, which would leave the
        // partial-repaid slice permanently counted against the cap).
        uint256 live =
            s.lenderIntentLivePrincipal[io.owner][io.lendingAsset][io.collateralAsset];
        s.lenderIntentLivePrincipal[io.owner][io.lendingAsset][io.collateralAsset] =
            io.amount <= live ? live - io.amount : 0;
        delete s.intentOrigin[loanId];
        // #625 WI-2c — de-register from the roll-discovery set (the proceeds were
        // claimed/withdrawn through the normal path, not auto-rolled).
        LibVaipakam.removeIntentLoan(loanId);
    }

    /// @notice #393 v1-d.2 — AUTO-ROLL a fully-repaid standing-intent loan:
    ///         re-lien its proceeds (principal + interest) back into the
    ///         originating owner's intent capital for zero-gap redeployment,
    ///         instead of paying them to a wallet. The next `matchIntent` then
    ///         redeploys the compounded capital with no manual claim/refund
    ///         round-trip.
    /// @dev    Callable by the originating intent OWNER, or a keeper the owner
    ///         authorized for `KEEPER_ACTION_AUTO_ROLL` (principal-keyed — the
    ///         authority is "act for this lender"). Hard guards:
    ///         - The loan must be cleanly **Repaid**. Defaulted / liquidated /
    ///           fallback loans use the normal claim (their proceeds may be
    ///           collateral-denominated or partial, not re-lendable principal).
    ///         - The current lender position-NFT holder must STILL be the
    ///           originating owner. If the position was SOLD, the buyer is owed
    ///           the proceeds (they claim normally); auto-roll must not redirect
    ///           them into the original owner's intent.
    ///         The lender claim is CONSUMED as the proceeds are re-liened,
    ///         preserving the two-bucket invariant (funds are either a claim or
    ///         liened capital, never both ⇒ no double-spend). VPFI can't appear
    ///         (blocked as an intent lending asset). The lender NFT is burned and
    ///         the loan settles exactly as a normal lender claim would
    ///         (coordinating with the borrower's claim).
    /// @param  loanId The repaid intent loan to roll.
    function rollIntentLoan(uint256 loanId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntentOrigin memory io = s.intentOrigin[loanId];
        if (io.owner == address(0)) revert LenderIntentLoanNotRollable();

        // Proceeds are re-committed as new lending capital for the owner (Tier-1,
        // same posture as `fundLenderIntent`); the roller acts on funds. Screen
        // both.
        LibVaipakam._assertNotSanctioned(io.owner);
        LibVaipakam._assertNotSanctioned(msg.sender);

        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Only a clean full repay rolls.
        if (loan.status != LibVaipakam.LoanStatus.Repaid) {
            revert LenderIntentLoanNotRollable();
        }
        // #623 Codex round-1 P1 — the re-lien targets `io.owner`'s vault, but
        // RepayFacet deposits the proceeds into `loan.lender`'s vault. A loan
        // sale (`sellLoanViaBuyOffer`) migrates `loan.lender` to a buyer WITHOUT
        // clearing `intentOrigin`, and the buyer could transfer the position NFT
        // back to `io.owner` — passing the `ownerOf` guard below while the
        // proceeds sit in the buyer's vault. Require `loan.lender == io.owner`
        // too, so the vault we re-lien from is the one that actually holds the
        // proceeds. (Both guards: `loan.lender` = where the funds are;
        // `ownerOf` = who's entitled to the claim.)
        if (loan.lender != io.owner) revert LenderIntentPositionTransferred();
        // Lender-position-sale guard — roll only if the original owner STILL
        // holds the position NFT (else the buyer is owed the proceeds).
        if (IERC721(address(this)).ownerOf(loan.lenderTokenId) != io.owner) {
            revert LenderIntentPositionTransferred();
        }
        // #623 Codex round-1 P1 — a loan carrying preclose / transfer-obligation
        // HELD proceeds (`heldForLender`) has a SECOND lender payout the normal
        // claim makes but this roll doesn't. Rather than strand it (the NFT is
        // about to burn), reject the loan to the normal claim path.
        if (s.heldForLender[loanId] != 0) revert LenderIntentLoanNotRollable();
        // #623 Codex round-1 P2 — VPFI rotated onto the lending asset post-match
        // means RepayFacet RESERVED the proceeds (`lenderProceedsEncumbered`);
        // this roll can't release that reservation, and consuming the claim
        // would block the normal claim from releasing it either → vault stuck
        // over-encumbered. Reject — VPFI winds down via the normal claim.
        // (Consistent with v1-d.1's VPFI-lending blocks.)
        if (io.lendingAsset == s.vpfiToken) {
            revert LenderIntentVpfiLendingUnsupported();
        }
        // #623 Codex round-3 P1 — reject directly on the PER-LOAN lender-proceeds
        // reservation, not just the aggregate free balance. If the asset was VPFI
        // at repay (even if `vpfiToken` has since rotated away, so the live-token
        // check above misses it) AND the owner happens to hold ≥ rolledAmount of
        // OTHER free balance in the same token, the free-balance assert below
        // would pass while THIS loan's reservation stays live — and consuming the
        // claim + burning the NFT here would leave the normal claim unable to
        // ever call `releaseLenderProceeds`, stranding the reservation. Reject to
        // the normal claim path, which releases it.
        if (s.lenderProceedsEncumbered[loanId] != 0) {
            revert LenderIntentLoanNotRollable();
        }
        // #623 Codex round-3 P2 — honour a CANCELLED intent. If the lender wound
        // the intent down (`cancelLenderIntent`) while this loan was outstanding,
        // a globally-authorized keeper must not re-lien the proceeds into the now
        // inactive intent (idle encumbered capital `matchIntent` won't touch) —
        // that contradicts cancel's promise that open loans settle via the normal
        // path. Reject to the normal claim instead.
        if (
            !s.lenderIntent[io.owner][io.lendingAsset][io.collateralAsset].active
        ) {
            revert LenderIntentLoanNotRollable();
        }
        // #623 Codex round-3 P2 — honour per-asset pauses (block-new / allow-exit),
        // mirroring `fundLenderIntent`. The roll is a NEW standing-capital
        // commitment, so a paused leg must route the lender to the normal claim
        // exit rather than re-lien into the paused pair.
        LibFacet.requireAssetNotPaused(io.lendingAsset);
        LibFacet.requireAssetNotPaused(io.collateralAsset);
        // Authorize the roller for the owner (owner-self or an AUTO_ROLL keeper).
        LibAuth.requireKeeperForPrincipal(
            LibVaipakam.KEEPER_ACTION_AUTO_ROLL, io.owner
        );

        // The lender claim (principal + interest) must be present, unconsumed,
        // and the intent's plain ERC-20 lending asset.
        LibVaipakam.ClaimInfo storage claim = s.lenderClaims[loanId];
        if (
            claim.claimed ||
            claim.amount == 0 ||
            claim.assetType != LibVaipakam.AssetType.ERC20 ||
            claim.asset != io.lendingAsset
        ) {
            revert LenderIntentNothingToRoll();
        }
        uint256 rolledAmount = claim.amount; // compound: principal + interest

        // #623 Codex round-2 P2 — assert the proceeds are STILL FREE in the
        // owner's vault before consuming the claim. They normally sit free (the
        // repay deposit), but could be encumbered by a VPFI lender-proceeds
        // RESERVATION (recorded per-loan at repay time if the asset was VPFI
        // then — even if `vpfiToken` has since rotated away, so the live-token
        // check above wouldn't catch it) OR already spent / encumbered via
        // another vault-backed path (e.g. a vault-backed signed offer) before an
        // authorized keeper rolls. If they're not free, reject to the normal
        // claim path rather than mint UNBACKED intent capital (which could never
        // be matched or withdrawn) and strand the real proceeds.
        uint256 rawBal =
            s.protocolTrackedVaultBalance[io.owner][io.lendingAsset];
        if (
            LibEncumbrance.freeBalance(io.owner, io.lendingAsset, 0, rawBal)
                < rolledAmount
        ) {
            revert LenderIntentLoanNotRollable();
        }

        // Consume the claim BEFORE re-liening, so the proceeds can never be both
        // claimable (NFT) and re-liened (capital) — the two-bucket invariant.
        claim.claimed = true;

        // Re-lien the proceeds as intent capital. They already sit FREE in the
        // owner's vault (the repay deposit; non-VPFI ⇒ unencumbered), so the
        // lien just encumbers them + bumps the capital pool — re-lendable by the
        // next `matchIntent` with no wallet round-trip.
        LibEncumbrance.lienIntentCapital(
            io.owner, io.lendingAsset, io.collateralAsset, rolledAmount
        );
        // #625 WI-2a — re-lien re-funds the owner's intent ⇒ (re)list it (if active).
        LibVaipakam.syncIntentRegistry(io.owner, io.lendingAsset, io.collateralAsset);

        // Release the loan's live-principal exposure (the ORIGINAL fill amount)
        // and clear the per-loan origin marker — the same decrement
        // `releaseIntentExposure` performs, inlined since `io` is in hand.
        uint256 live = s.lenderIntentLivePrincipal[io.owner][io.lendingAsset][
            io.collateralAsset
        ];
        s.lenderIntentLivePrincipal[io.owner][io.lendingAsset][
            io.collateralAsset
        ] = io.amount <= live ? live - io.amount : 0;
        delete s.intentOrigin[loanId];
        // #625 WI-2c — de-register from the roll-discovery set (now rolled).
        LibVaipakam.removeIntentLoan(loanId);

        // Burn the lender position NFT (its claim is consumed) — mirrors the
        // lender-claim close.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanClosed
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector, loan.lenderTokenId
            ),
            IVaipakamErrors.NFTBurnFailed.selector
        );

        emit IntentLoanRolled(
            io.owner,
            msg.sender,
            loanId,
            io.lendingAsset,
            io.collateralAsset,
            rolledAmount,
            s.lenderIntentCapital[io.owner][io.lendingAsset][io.collateralAsset]
        );

        // Settle coordination — identical rule to the lender claim: settle once
        // the borrower has claimed (or has nothing to claim). Otherwise the loan
        // stays Repaid until the borrower runs their own claim.
        LibVaipakam.ClaimInfo storage borrowerClaim = s.borrowerClaims[loanId];
        bool borrowerHasNothing = borrowerClaim.amount == 0 &&
            borrowerClaim.assetType == LibVaipakam.AssetType.ERC20 &&
            s.borrowerLifRebate[loanId].rebateAmount == 0;
        if (borrowerClaim.claimed || borrowerHasNothing) {
            LibLifecycle.transitionFromAny(loan, LibVaipakam.LoanStatus.Settled);
            emit LoanSettled(loanId);
        }
    }

    /// @notice Read a standing intent. `active == false` ⇒ none / cancelled.
    function getLenderIntent(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) external view returns (LibVaipakam.LenderIntent memory) {
        return LibVaipakam.storageSlot().lenderIntent[owner][lendingAsset][
            collateralAsset
        ];
    }

    /// @notice Aggregate LIVE principal currently out from `owner`'s intent on
    ///         the `(lendingAsset, collateralAsset)` pair — the figure
    ///         `matchIntent` checks against `maxExposure` (#393 v1-b). Keyed by
    ///         the full intent; decremented at each originated loan's terminal
    ///         close.
    function getLenderIntentLivePrincipal(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().lenderIntentLivePrincipal[owner][
            lendingAsset
        ][collateralAsset];
    }

    /// @notice #393 v1-d — the un-lent, liened working capital `owner` has
    ///         funded for the intent on `(lendingAsset, collateralAsset)`: the
    ///         pool `matchIntent` draws fill slices from, and the amount
    ///         `withdrawLenderIntentCapital` can return to the wallet. Excludes
    ///         capital already lent out (tracked by `lenderIntentLivePrincipal`)
    ///         and repaid proceeds (which return as a Position-NFT claim).
    function getLenderIntentCapital(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().lenderIntentCapital[owner][
            lendingAsset
        ][collateralAsset];
    }

    /// @notice #755 — paginated view of ALL standing intents a single lender
    ///         owns across pairs, so the dapp can list and manage them in one
    ///         place. Unlike the owner-agnostic, funded-active-only
    ///         `MetricsFacet.getActiveLenderIntents` global keeper feed, this
    ///         pages the per-owner registry and ALSO returns PAUSED intents
    ///         (cancelled but still carrying reserved capital) — the `active`
    ///         flag on each `OwnerLenderIntentSummary` row distinguishes active
    ///         from paused, and `availableCapital` / `livePrincipal` show what's
    ///         reserved and what's out on loan. An intent leaves the registry
    ///         only once fully torn down (inactive AND zero reserved capital).
    /// @dev    Returns a per-owner wrapper type ({OwnerLenderIntentSummary}),
    ///         NOT the shared {LenderIntentSummary} the global feed returns, so
    ///         adding the `active` flag here can't perturb that feed's ABI.
    /// @dev    Migration note (Codex #756 P2): `ownerIntentKeys` is populated
    ///         FORWARD-only, at the same `syncIntentRegistry` sites as the
    ///         global `activeIntentKeys` feed — both registries share that
    ///         property. On a from-scratch deployment (every deployment to date)
    ///         that is complete: every intent is registered through a synced
    ///         path. Only an in-place diamond upgrade performed OVER pre-existing
    ///         intent state would start this set empty; the one-time migration is
    ///         a re-sync of the known keys (identical to what the global feed
    ///         would need), not a per-view backfill — so the two registries stay
    ///         consistent and the platform's pre-live status means there is no
    ///         such live state to migrate today.
    /// @param  owner   The lender whose standing intents to list.
    /// @param  offset  Start index into the owner's intent set.
    /// @param  limit   Maximum rows to return from `offset`.
    /// @return intents The owner's intents within `[offset, offset+limit)`.
    /// @return total   The owner's total intent count, for pagination.
    function getLenderIntentsByOwner(
        address owner,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (
            LibMetricsTypes.OwnerLenderIntentSummary[] memory intents,
            uint256 total
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        EnumerableSet.Bytes32Set storage keys = s.ownerIntentKeys[owner];
        total = keys.length();
        if (offset >= total) {
            return (new LibMetricsTypes.OwnerLenderIntentSummary[](0), total);
        }
        uint256 endExcl = offset + limit;
        if (endExcl > total) endExcl = total;
        uint256 size = endExcl - offset;
        intents = new LibMetricsTypes.OwnerLenderIntentSummary[](size);
        for (uint256 i = 0; i < size; i++) {
            LibVaipakam.IntentKey memory key =
                s.intentKeyTuple[keys.at(offset + i)];
            intents[i] = LibMetricsTypes.toOwnerLenderIntentSummary(
                key,
                s.lenderIntent[key.owner][key.lendingAsset][key.collateralAsset],
                s.lenderIntentLivePrincipal[key.owner][key.lendingAsset][
                    key.collateralAsset
                ],
                s.lenderIntentCapital[key.owner][key.lendingAsset][
                    key.collateralAsset
                ]
            );
        }
    }
}
