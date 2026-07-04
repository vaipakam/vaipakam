// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title VPFIDiscountFacet
 * @author Vaipakam Developer Team
 * @notice Phase 1 borrower VPFI discount mechanism — spec in
 *         docs/TokenomicsTechSpec.md.
 * @dev #687-A removed the issuer fixed-rate ETH → VPFI sale (`buyVPFIWithETH`,
 *      the bridged-buy ingress, and the global/per-wallet caps) to reduce the
 *      platform's securities-law surface. What remains is the consumptive
 *      fee-discount utility, with four user-facing surfaces:
 *        1. `depositVPFIToVault(amount)` — explicit wallet → vault move that
 *           stakes VPFI so it can back fee discounts. Users acquire VPFI
 *           through external markets / the CCIP CCT bridge, not the protocol.
 *        2. `withdrawVPFIFromVault(amount)` — counterpart of (1). Unstakes
 *           vault VPFI back to the caller's wallet, respecting the
 *           collateral-encumbrance lien, and checkpoints staking accrual
 *           before the balance change.
 *        3. `quoteVPFIDiscount(offerId)` / `quoteVPFIDiscountFor(id, user)`
 *           — views used by the frontend to show the VPFI that will be
 *           deducted at accept time.
 *        4. `setVPFIDiscountConsent(bool)` / `getVPFIDiscountConsent(user)`
 *           — the single platform-level user setting that governs whether
 *           vaulted VPFI may be spent on protocol-fee discounts. This same
 *           flag governs BOTH the borrower Loan Initiation Fee discount
 *           (consumed in OfferFacet._acceptOffer) and the lender Yield
 *           Fee discount. No per-offer or per-call opt-in exists.
 *
 *      Admin surface (ADMIN_ROLE, matches VPFITokenFacet's pattern):
 *        - `setVPFIDiscountRate(weiPerVpfi)` — VPFI price anchor used to
 *          value the discount (wei of ETH per 1 VPFI).
 *        - `setVPFIDiscountETHPriceAsset(asset)` — WETH address (Chainlink
 *          oracle) used for the USD→ETH leg of the quote.
 *        - `getVPFIDiscountConfig()` — reads back both of the above.
 *
 *      Chain scope: the DISCOUNT (vault VPFI → treasury at acceptance) works
 *      on every chain, gated purely on borrower vault VPFI balance.
 *
 *      Security: `depositVPFIToVault` / `withdrawVPFIFromVault` are
 *      reentrancy-guarded and pausable. The discount path in OfferFacet
 *      inherits that facet's guards.
 */
contract VPFIDiscountFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;
    using Address for address payable;

    /// @notice #569 §6 F-1 (2026-06-13) — raised by
    ///         {withdrawVPFIFromVault} when the requested unstake amount
    ///         exceeds the FREE vault VPFI balance because some of the
    ///         caller's VPFI backs a live loan as ERC-20 collateral
    ///         (it's in the encumbrance sub-ledger). The encumbered
    ///         portion can only exit through the loan's own lifecycle
    ///         (repay / liquidation / default), not this staking-unwind
    ///         door.
    /// @param requested The amount the caller asked to withdraw.
    /// @param free      The withdrawable free balance (raw − encumbered).
    error VPFIEncumberedByActiveLoan(uint256 requested, uint256 free);

    // ─── Events ──────────────────────────────────────────────────────────────




    /// @notice Emitted when a holder moves VPFI from their wallet into their
    ///         vault — typically after bridging from Base.
    /// @param user             The depositor (and vault owner).
    /// @param amount           VPFI amount moved from wallet to vault.
    /// @param newVaultBalance User's vault VPFI balance after the deposit.
    ///        EventSourcingAudit §3.19 — saves consumers a follow-up
    ///        view-call to render the staking UI.
    /// @custom:event-category state-change/vault-mutation
    event VPFIDepositedToVault(
        address indexed user,
        uint256 amount,
        uint256 newVaultBalance
    );

    /// @notice Emitted when a staker unstakes — VPFI moves from the user's
    ///         vault back to their wallet. Dropping below a tier threshold
    ///         here implicitly lowers the fee-discount tier on subsequent
    ///         acceptance / repayment events.
    /// @param user             The withdrawer (and vault owner).
    /// @param amount           VPFI amount moved from vault to wallet.
    /// @param newVaultBalance User's vault VPFI balance after the
    ///        withdrawal. EventSourcingAudit §3.19.
    /// @custom:event-category state-change/vault-mutation
    event VPFIWithdrawnFromVault(
        address indexed user,
        uint256 amount,
        uint256 newVaultBalance
    );

    /// @notice Emitted when the discount is successfully applied at loan
    ///         acceptance. Fired from the OfferFacet mutating path via
    ///         `LibVPFIDiscount.tryApply` — this facet re-emits it as a
    ///         passthrough so indexers can filter on one facet.
    /// @param loanId       The newly-initiated loan id.
    /// @param borrower     The borrower who paid the discounted fee in VPFI.
    /// @param lendingAsset The loan's principal asset.
    /// @param vpfiDeducted VPFI moved from borrower's vault to treasury.
    /// @custom:event-category informational/settlement
    event VPFIDiscountApplied(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed lendingAsset,
        uint256 vpfiDeducted
    );

    /// @notice Emitted when the VPFI fee-discount price config is changed by
    ///         admin (#687-A: the sale config was removed; only the discount
    ///         price anchor + ETH reference asset remain).
    /// @param weiPerVpfi    VPFI price anchor — ETH wei per 1 VPFI (18 dec).
    /// @param ethPriceAsset ERC-20 used as the ETH/USD reference asset.
    /// @custom:event-category informational/config
    event VPFIDiscountConfigUpdated(
        uint256 weiPerVpfi,
        address ethPriceAsset
    );

    /// @notice Emitted when a user toggles the shared platform-level consent
    ///         to use vaulted VPFI for protocol fee discounts. A single
    ///         consent governs both the borrower Loan Initiation Fee
    ///         discount and the lender Yield Fee discount (spec: README
    ///         §"Treasury and Revenue Sharing", TokenomicsTechSpec §6).
    /// @param user    The user whose consent changed.
    /// @param enabled New consent state — true means vault VPFI may be used.
    /// @custom:event-category informational/config
    event VPFIDiscountConsentChanged(address indexed user, bool enabled);

    /// @notice Emitted when the lender Yield Fee discount is successfully
    ///         applied at repayment-time. Fired from the RepayFacet mutating
    ///         path via `LibVPFIDiscount.tryApplyYieldFee` — this facet
    ///         re-emits it as a passthrough so indexers can subscribe to a
    ///         single facet for discount analytics.
    /// @param loanId       The loan being settled.
    /// @param lender       The lender who paid the discounted yield fee in VPFI.
    /// @param lendingAsset The loan's principal asset.
    /// @param vpfiDeducted VPFI moved from lender's vault to treasury.
    /// @custom:event-category informational/settlement
    event VPFIYieldFeeDiscountApplied(
        uint256 indexed loanId,
        address indexed lender,
        address indexed lendingAsset,
        uint256 vpfiDeducted
    );

    // ─── User entry points ───────────────────────────────────────────────────


    /**
     * @notice Move VPFI from the caller's wallet into the caller's vault.
     * @dev Intended for users who bridged VPFI to a non-canonical chain via
     *      Chainlink CCIP (CCT bridge) and now want to deposit it into their local vault to
     *      qualify for the discount on that chain. Works on every chain,
     *      including the canonical one. Caller must have approved this
     *      diamond for `amount` on the registered VPFI token.
     *
     *      Reverts `VPFITokenNotSet` when the diamond has no VPFI bound,
     *      `InvalidAmount` on zero amount. Emits {VPFIDepositedToVault}.
     * @param amount VPFI wei amount to deposit (18 decimals).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function depositVPFIToVault(uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        // Tier-1 sanctions gate. Don't let a sanctioned wallet
        // accumulate VPFI in their own vault.
        LibVaipakam._assertNotSanctioned(msg.sender);
        (address vpfi, ) = _prepareDeposit(amount);
        // Route through the protocol's chokepoint so the
        // protocolTrackedVaultBalance counter ticks for the staked
        // VPFI. The chokepoint resolves the user's vault
        // internally — `_prepareDeposit` still creates it (via
        // `getOrCreateUserVault`) so the staking-checkpoint /
        // discount-accumulator can rollup against the post-mutation
        // balance, but we no longer need the address back here.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultDepositERC20.selector,
                msg.sender,
                vpfi,
                amount
            ),
            VaultDepositFailed.selector
        );
        emit VPFIDepositedToVault(msg.sender, amount, LibVPFIDiscount.vaultVpfiBalance(msg.sender));
    }

    /**
     * @notice Permit2 variant of {depositVPFIToVault} (Phase 8b.1).
     *
     * @dev Pulls VPFI from the caller's wallet to their vault via
     *      Uniswap's Permit2 in a single transaction — no separate
     *      `approve` tx required. The caller signs an EIP-712
     *      `PermitTransferFrom` typed-data payload off-chain (frontend
     *      handles payload + signature construction), then submits the
     *      signature alongside the deposit call here.
     *
     *      Staking + discount-accrual side-effects mirror
     *      {depositVPFIToVault} — both paths share `_prepareDeposit`.
     *
     *      `permit.permitted.token` MUST equal the VPFI token address;
     *      the binding check is enforced by Permit2 itself (the token
     *      is mixed into the EIP-712 digest the user signed). `amount`
     *      MUST be ≤ `permit.permitted.amount`, again enforced inside
     *      Permit2.
     *
     * @param amount    VPFI wei to deposit (18 dec).
     * @param permit    `PermitTransferFrom` struct the user signed.
     * @param signature 65-byte ECDSA signature over the EIP-712 digest.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function depositVPFIToVaultWithPermit(
        uint256 amount,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate (mirrors `depositVPFIToVault`).
        LibVaipakam._assertNotSanctioned(msg.sender);
        (address vpfi, address vault) = _prepareDeposit(amount);
        // Bind the Permit2 pull to the registered VPFI token. Without
        // this check a permit signed for a different ERC-20 would be
        // honoured by Permit2 while {_prepareDeposit} has already
        // re-stamped the VPFI discount accumulator and staking
        // checkpoint at the post-mutation balance — the on-chain VPFI
        // balance would not actually move and accounting would drift.
        LibPermit2.pull(msg.sender, vault, vpfi, amount, permit, signature);
        // Permit2 already moved VPFI to the user's vault; record the
        // deposit in the protocolTrackedVaultBalance counter so the
        // staking checkpoint's `min(balanceOf, tracked)` reads the
        // staked balance correctly and the future stuck-recovery
        // path's cap math stays consistent.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.recordVaultDepositERC20.selector,
                msg.sender,
                vpfi,
                amount
            ),
            VaultDepositFailed.selector
        );
        emit VPFIDepositedToVault(msg.sender, amount, LibVPFIDiscount.vaultVpfiBalance(msg.sender));
    }

    /// @dev Shared pre-pull setup — validates amount, resolves the VPFI
    ///      token address and the caller's vault, rolls up the
    ///      discount accumulator + staking checkpoint at the
    ///      post-mutation balance. Returns the resolved
    ///      `(vpfi, vault)` so the caller can do the actual transfer
    ///      via whichever path (safeTransferFrom vs Permit2) fits.
    function _prepareDeposit(uint256 amount)
        private
        returns (address vpfi, address vault)
    {
        if (amount == 0) revert InvalidAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        vault = VaultFactoryFacet(address(this)).getOrCreateUserVault(
            msg.sender
        );
        uint256 prevBal = IERC20(vpfi).balanceOf(vault);
        // T-054 PR-2 — clamp the rollup / checkpoint balance against
        // the protocol-tracked counter so unsolicited dust pushed in
        // via direct `IERC20.transfer` does NOT inflate the user's
        // staking yield or VPFI discount tier. Post-mutation values
        // computed from current storage + the amount about to be
        // deposited via the chokepoint.
        uint256 prevTracked = s.protocolTrackedVaultBalance[msg.sender][vpfi];
        uint256 newStakedBal = LibVPFIDiscount.clampToTracked(
            prevBal + amount,
            prevTracked + amount
        );
        // Roll up the VPFI discount accumulator, re-stamping at the
        // post-mutation balance so the next period accrues at the tier
        // the user will actually hold after this deposit lands.
        LibVPFIDiscount.rollupUserDiscount(msg.sender, newStakedBal);
    }

    /**
     * @notice Move VPFI from the caller's vault back to their wallet.
     * @dev The counterpart to {depositVPFIToVault} — lets a staker unstake
     *      by reducing their vault VPFI balance. Staking accrual is
     *      checkpointed BEFORE the balance change so the withdrawn amount
     *      stops earning immediately.
     *
     *      Per spec (docs/TokenomicsTechSpec.md §6) this directly affects
     *      the user's fee-discount tier: withdrawing below a tier threshold
     *      drops the user into a lower tier on subsequent accept / repay
     *      events. Withdrawing while active loans are outstanding is
     *      allowed — the discount is evaluated opportunistically at fee
     *      time and failing the tier check simply reverts to the normal
     *      non-discounted path.
     *
     *      Reverts `VPFITokenNotSet` when the token is unregistered,
     *      `InvalidAmount` on zero, and
     *      `VPFIVaultBalanceInsufficient` when the caller's vault
     *      doesn't hold `amount`. Pausable + reentrancy-guarded.
     *
     *      Emits {VPFIWithdrawnFromVault}.
     * @param amount VPFI wei amount to withdraw (18 decimals).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function withdrawVPFIFromVault(uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        // Tier-1 sanctions gate. Funds OUT to msg.sender — block.
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (amount == 0) revert InvalidAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();

        address vault = s.userVaipakamVaults[msg.sender];
        if (vault == address(0)) revert VPFIVaultBalanceInsufficient();
        uint256 prevBal = IERC20(vpfi).balanceOf(vault);
        if (prevBal < amount) revert VPFIVaultBalanceInsufficient();

        // T-054 PR-2 — clamp the post-withdraw balance against the
        // protocol-tracked counter (less the same withdraw amount).
        // Excludes any unsolicited dust still sitting in the vault
        // from the post-mutation yield-bearing balance.
        uint256 prevTracked = s.protocolTrackedVaultBalance[msg.sender][vpfi];

        // #569 §6 F-1 (2026-06-13) — explicit encumbrance consult. VPFI
        // is collateral-eligible (triaged code-wrong: safe under P2P +
        // lender discretion). If the caller has VPFI backing a live loan
        // as ERC-20 collateral, that portion is in
        // `encumbered[msg.sender][vpfi][0]` and is NOT withdrawable
        // through this staking-unwind door — only down to the free
        // balance. The shared chokepoint guard in `vaultWithdrawERC20`
        // (line below) enforces the same bound, but checking up-front
        // (a) gives a clean, specific revert BEFORE the staking-rollup /
        // checkpoint work below runs on a doomed amount, and (b) keeps
        // this fund-exit surface self-protecting against any future
        // refactor that bypasses the chokepoint. Defense-in-depth.
        //
        // #569 Codex #572 round-2 P2 — cap by the tracked balance first
        // (same rationale as the chokepoint): unsolicited VPFI dust must
        // not inflate the free figure, or the post-withdraw tracked
        // decrement would dip below the active lien.
        uint256 cappedBal = prevBal < prevTracked ? prevBal : prevTracked;
        uint256 freeVpfi = LibEncumbrance.freeBalance(msg.sender, vpfi, 0, cappedBal);
        if (amount > freeVpfi) {
            revert VPFIEncumberedByActiveLoan(amount, freeVpfi);
        }
        uint256 newStakedBal = LibVPFIDiscount.clampToTracked(
            prevBal - amount,
            prevTracked - amount
        );
        // Close the VPFI-discount period and re-stamp at the post-
        // mutation balance. The closing period carries the stamp left
        // by the prior rollup (whatever tier was in effect up to now);
        // the next period starts at the tier the user will hold after
        // this withdraw.
        LibVPFIDiscount.rollupUserDiscount(msg.sender, newStakedBal);

        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            msg.sender,
            vpfi,
            msg.sender,
            amount
        );

        emit VPFIWithdrawnFromVault(msg.sender, amount, LibVPFIDiscount.vaultVpfiBalance(msg.sender));
    }

    /**
     * @notice Set the caller's platform-level consent to use vaulted VPFI
     *         for protocol fee discounts. A single consent governs both
     *         the borrower Loan Initiation Fee discount and the lender
     *         Yield Fee discount — no offer-level or loan-level toggle is
     *         needed once this is true.
     * @dev Per spec (docs/TokenomicsTechSpec.md §6, README §"Treasury and
     *      Revenue Sharing"): "the [borrower / lender] must explicitly
     *      consent through a single platform-level user setting... Only
     *      when that platform-level consent is active and sufficient VPFI
     *      is available in vault will the system automatically deduct
     *      the discounted fee amount in VPFI from vault and transfer it
     *      to Treasury."
     *
     *      Pausable + non-reentrant so an operator pause fully disables
     *      new consent changes. Existing consent state is preserved across
     *      pauses.
     *
     *      Emits {VPFIDiscountConsentChanged}.
     * @param enabled True to opt in; false to opt out.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function setVPFIDiscountConsent(bool enabled)
        external
        nonReentrant
        whenNotPaused
    {
        // T-087 Sub 4 round-4 P1s — the round-3 attempt to also
        // trigger a rollup-broadcast here was reverted:
        //
        //  1. Budget-exhausted revert: with `rewardMessenger` set,
        //     the rollup cascades into `protocolBroadcastTierUpdate`,
        //     which fail-closes when the protocol broadcast budget
        //     can't quote the CCIP fee. That would block a
        //     security-motivated `setVPFIDiscountConsent(false)`
        //     simply because protocol funds were temporarily low.
        //  2. Budget-drain via toggling: the de-dup gate only
        //     suppresses identical re-pushes, so toggling ON/OFF
        //     repeatedly DOES fire fresh broadcasts because the
        //     tier value flips each time. A user could intentionally
        //     drain the protocol broadcast budget by toggling at
        //     no on-chain cost beyond their own gas.
        //
        // The broadcast-facet consent gate (added in round-3)
        // still applies: the NEXT legitimate rollup (deposit /
        // withdraw / `pokeMyTier`) will push the consent-gated
        // (0, 0) and clear mirror caches. The dapp's consent UI
        // should chain a `pokeMyTier()` after `setVPFIDiscountConsent(false)`
        // to give the user an immediate cache clear (user pays
        // their own tx gas; protocol pays one broadcast, exactly
        // the same cost surface as any other balance mutation).
        LibVaipakam.storageSlot().vpfiDiscountConsent[msg.sender] = enabled;
        emit VPFIDiscountConsentChanged(msg.sender, enabled);
    }

    // ─── Public views ────────────────────────────────────────────────────────

    /**
     * @notice Returns `user`'s platform-level VPFI fee-discount consent.
     *         When true, the protocol automatically applies the borrower
     *         and lender discounts whenever the vault holds enough VPFI
     *         and the asset leg is eligible.
     * @param user The address whose consent to read.
     * @return enabled Consent state.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function getVPFIDiscountConsent(address user)
        external
        view
        returns (bool enabled)
    {
        return LibVaipakam.storageSlot().vpfiDiscountConsent[user];
    }

    /**
     * @notice Read `user`'s current VPFI-discount accumulator state.
     * @dev Exposes the three per-user fields that drive the time-weighted
     *      lender yield-fee discount (docs §5.2a):
     *        - `discountBpsAtPreviousRollup` — stamped BPS since last rollup.
     *        - `lastRollupAt`                — timestamp of last rollup.
     *        - `cumulativeDiscountBpsSeconds` — monotone running total.
     *      The frontend pairs these with a loan's `lenderDiscountAccAtInit`
     *      to compute the live time-weighted average discount for an
     *      open loan — the value that would apply if the yield fee were
     *      settled right now.
     * @param user Address to inspect.
     * @return discountBpsAtPreviousRollup Stamped discount BPS.
     * @return lastRollupAt                Timestamp of the last rollup.
     * @return cumulativeDiscountBpsSeconds Monotone accumulator.
     */
    function getUserVpfiDiscountState(address user)
        external
        view
        returns (
            uint16 discountBpsAtPreviousRollup,
            uint64 lastRollupAt,
            uint256 cumulativeDiscountBpsSeconds
        )
    {
        LibVaipakam.UserVpfiDiscountState storage u =
            LibVaipakam.storageSlot().userVpfiDiscountState_DEPRECATED[user];
        return (
            u.discountBpsAtPreviousRollup,
            u.lastRollupAt,
            u.cumulativeDiscountBpsSeconds
        );
    }

    /**
     * @notice Quote the VPFI required to apply the borrower discount on a
     *         given offer — only meaningful when the borrower address is
     *         known (offer is a Borrower offer).
     * @dev Frontend helper and acceptance-time pre-flight check. Returns
     *      `eligible == false` if the offer is non-ERC20, the lending asset
     *      is illiquid, any oracle is missing/stale, the admin has not
     *      configured the rate / ETH reference asset, or the known borrower
     *      sits in tier 0 (no discount). Never reverts.
     *
     *      For LENDER offers the acceptor (the future borrower) is unknown
     *      at quote time; this view returns `eligible == false` because the
     *      tier depends on the acceptor's vault balance. Frontend should
     *      call {quoteVPFIDiscountFor} with the connected wallet address
     *      instead.
     *
     *      Matching the spec: the discount applies only to liquid lending
     *      assets. Liquidity is checked via OracleFacet at accept time; this
     *      quote only enforces the preconditions it can verify statically
     *      without re-running liquidity checks.
     * @param offerId Offer to quote against.
     * @return eligible          True iff the full quote succeeded.
     * @return vpfiRequired      VPFI (18 dec) borrower must hold in vault.
     * @return borrowerVaultBal Borrower's current vault VPFI balance.
     * @return tier              Resolved tier 1..4 (0 when ineligible).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function quoteVPFIDiscount(uint256 offerId)
        external
        view
        returns (
            bool eligible,
            uint256 vpfiRequired,
            uint256 borrowerVaultBal,
            uint8 tier
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator == address(0) || offer.accepted) {
            return (false, 0, 0, 0);
        }
        if (offer.assetType != LibVaipakam.AssetType.ERC20) {
            return (false, 0, 0, 0);
        }

        // Tier depends on the borrower's vault balance. For a Borrower offer
        // the creator is the borrower; for a Lender offer the borrower is the
        // acceptor (unknown here). Surface a negative quote in the Lender
        // case — the frontend knows to call {quoteVPFIDiscountFor}.
        address knownBorrower = offer.offerType == LibVaipakam.OfferType.Borrower
            ? offer.creator
            : address(0);
        if (knownBorrower == address(0)) return (false, 0, 0, 0);

        (bool canQuote, uint256 vpfi, uint8 t) = LibVPFIDiscount.quote(
            offer.lendingAsset,
            offer.amount,
            knownBorrower
        );

        uint256 bal;
        address vault = s.userVaipakamVaults[knownBorrower];
        if (vault != address(0) && s.vpfiToken != address(0)) {
            bal = IERC20(s.vpfiToken).balanceOf(vault);
        }

        if (!canQuote) return (false, 0, bal, 0);
        return (true, vpfi, bal, t);
    }

    /**
     * @notice Quote the borrower discount for `offerId` assuming `borrower`
     *         would be the loan's borrower — used by the frontend to render
     *         the acceptor-side preview on LENDER offers where the creator
     *         is not the future borrower.
     * @dev Same failure contract as {quoteVPFIDiscount}; never reverts.
     * @param offerId  Offer to quote against.
     * @param borrower Address to resolve the tier against.
     * @return eligible          True iff the full quote succeeded.
     * @return vpfiRequired      VPFI (18 dec) `borrower` must hold in vault.
     * @return borrowerVaultBal `borrower`'s current vault VPFI balance.
     * @return tier              Resolved tier 1..4 (0 when ineligible).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function quoteVPFIDiscountFor(uint256 offerId, address borrower)
        external
        view
        returns (
            bool eligible,
            uint256 vpfiRequired,
            uint256 borrowerVaultBal,
            uint8 tier
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator == address(0) || offer.accepted) {
            return (false, 0, 0, 0);
        }
        if (offer.assetType != LibVaipakam.AssetType.ERC20) {
            return (false, 0, 0, 0);
        }
        if (borrower == address(0)) return (false, 0, 0, 0);

        (bool canQuote, uint256 vpfi, uint8 t) = LibVPFIDiscount.quote(
            offer.lendingAsset,
            offer.amount,
            borrower
        );

        uint256 bal;
        address vault = s.userVaipakamVaults[borrower];
        if (vault != address(0) && s.vpfiToken != address(0)) {
            bal = IERC20(s.vpfiToken).balanceOf(vault);
        }

        if (!canQuote) return (false, 0, bal, 0);
        return (true, vpfi, bal, t);
    }

    /**
     * @notice Resolve `user`'s current VPFI discount tier purely from their
     *         vault balance. Cheap, pure, no oracle dependency.
     * @param user Address whose tier to resolve.
     * @return tier        0..4 (0 means no discount).
     * @return vaultBal   `user`'s current vault VPFI balance.
     * @return discountBps Discount applied to the normal fee for this tier.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function getVPFIDiscountTier(address user)
        external
        view
        returns (uint8 tier, uint256 vaultBal, uint256 discountBps)
    {
        vaultBal = LibVPFIDiscount.vaultVpfiBalance(user);
        tier = LibVPFIDiscount.tierOf(vaultBal);
        discountBps = LibVPFIDiscount.discountBpsForTier(tier);
    }

    /// @notice T-087 Sub 1.D — the EFFECTIVE tier + BPS the user
    ///         can actually claim at this instant. Returns the
    ///         post-min-history-gate + post-min-tier-over-history-
    ///         clamp values on Base; reads from the cached
    ///         `CachedTier` slot on mirrors. Use this for any UI
    ///         surface that needs to show "what discount applies
    ///         at the moment of a fee charge" — Codex Sub 1.B
    ///         round-3 P2 #2 caught that displaying the raw
    ///         vault-balance tier from {getVPFIDiscountTier}
    ///         during the min-history window let the dapp show
    ///         a tier the user couldn't actually claim. The two
    ///         getters are intentionally separate: {getVPFIDiscountTier}
    ///         answers "what tier does my current stake balance
    ///         imply?", {getEffectiveDiscount} answers "what
    ///         discount applies right now?".
    /// @return effTier  EFFECTIVE_TIER (0-4); the post-gate value.
    /// @return effBps   EFFECTIVE_BPS; the BPS the fee path applies.
    function getEffectiveDiscount(address user)
        external
        view
        returns (uint8 effTier, uint16 effBps)
    {
        // Codex Sub 1.D round-1 P2 — every settlement path
        // (RepayFacet, PrecloseFacet, RefinanceFacet via
        // `LibVPFIDiscount.tryApplyYieldFee`) gates the actual
        // discount on `s.vpfiDiscountConsent[user]` BEFORE calling
        // the accumulator. Mirroring that gate here keeps the
        // dapp's tier / lender-preview surface aligned with what
        // the fee path actually applies — a user who hasn't opted
        // in sees (0, 0) just like the on-chain fee path would.
        if (!LibVaipakam.storageSlot().vpfiDiscountConsent[user]) {
            return (0, 0);
        }
        return LibVPFIDiscount.effectiveTierAndBps(user);
    }

    /// @custom:event-category state-change/vpfi-discount
    /// @notice T-087 Sub 4 — emitted when a user (or the protocol on
    ///         their behalf) triggers a balance-mutation-free rollup.
    event TierPoked(address indexed user, uint256 trackedBalance);

    /**
     * @notice T-087 Sub 4 — trigger a balance-mutation-free rollup of
     *         the caller's VPFI-discount accumulator.
     *
     * @dev Use case: time-only EFFECTIVE_TIER activation. Once a
     *      user's stake has aged past `cfgTwaMinStakedDaysEffective`,
     *      their on-chain tier becomes claimable without any balance
     *      mutation needed. `pokeMyTier()` lets them surface that
     *      tier to mirror chains via the protocol-funded broadcast
     *      path (T-087 Sub 2.D) without having to make a tiny
     *      deposit / withdraw round-trip.
     *
     *      The function is fully permissionless and idempotent: it
     *      re-reads the caller's tracked balance and re-stamps the
     *      accumulator at that same balance. If the tier hasn't
     *      changed, no broadcast fires (the broadcast path
     *      short-circuits on equal tier). If the tier HAS changed —
     *      e.g., the user just crossed the min-history boundary —
     *      the broadcast pushes the new tier to every configured
     *      mirror chain.
     *
     *      Gated by `whenNotPaused` so emergency pause halts pokes
     *      (consistent with the deposit/withdraw paths). ALSO
     *      gated by `vpfiDiscountConsent` (Codex round-1 P2 #2):
     *      a consent-off user's RAW tier would otherwise leak to
     *      mirrors via the un-gated `effectiveTierAndBps` path in
     *      `ProtocolBroadcastFacet`, putting the mirror cache out
     *      of sync with the consent-gated canonical fee path.
     *      Consent-off pokes emit `TierPokeSkippedNoConsent` and
     *      return without rolling up.
     */
    function pokeMyTier() external nonReentrant whenNotPaused {
        // #494 Card B — Tier-1 sanctions gate on the caller. pokeMyTier
        // is a state-mutating entry point that drives a protocol-funded
        // CCIP broadcast; per CLAUDE.md "Retail-deploy policy" every
        // Tier-1 entry-creator path reverts SanctionedAddress for
        // listed callers. The other Sub 4 user-initiated paths
        // (depositVPFIToVault / withdrawVPFIFromVault / setConsent) are
        // already gated; this closes the matching gap on poke.
        LibVaipakam._assertNotSanctioned(msg.sender);
        // The trackedVpfiBalance read is the same one every settlement
        // path uses; for a user with no stake history it returns 0 and
        // the rollup is essentially a no-op at the accumulator level.
        //
        // T-087 Sub 4 round-3 P2 #2 — the round-1 consent-off early
        // return was wrong: it left mirror caches with whatever stale
        // non-zero tier the user previously pushed. The fix moved to
        // `ProtocolBroadcastFacet.protocolBroadcastTierUpdate`, which
        // now zeros out the broadcast tier when consent is off. So
        // consent-off pokes correctly push (0, 0) and clear the
        // cache.
        uint256 trackedBal = LibVPFIDiscount.trackedVpfiBalance(msg.sender);
        LibVPFIDiscount.rollupUserDiscount(msg.sender, trackedBal);
        emit TierPoked(msg.sender, trackedBal);
    }

    /**
     * @notice T-087 Sub 4 round-2 P2 — protocol-tracked VPFI balance
     *         for `user`. This is the balance the discount
     *         accumulator uses, which CAN be less than the raw
     *         `vaultVpfiBalance(user)` if the user transferred VPFI
     *         directly into their vault instead of going through
     *         `depositVPFIToVault`. The dapp's tier-display surface
     *         reads this getter when deciding whether to surface
     *         the "min-history pending" promise — using
     *         `getVPFIDiscountTier` instead would mislabel direct-
     *         transfer dust as "will activate automatically", when
     *         in fact `pokeMyTier()` would not activate it because
     *         the accumulator sees zero tracked balance.
     */
    function getTrackedVPFIBalance(address user) external view returns (uint256) {
        return LibVPFIDiscount.trackedVpfiBalance(user);
    }

    /**
     * @notice T-087 Sub 4 round-3 P2 #1 — RAW tier derived from the
     *         protocol-TRACKED balance, mirroring `getVPFIDiscountTier`
     *         but using only the balance the accumulator actually
     *         counts. Direct-transfer vault dust is EXCLUDED — so the
     *         dapp's min-history-pending check can correctly
     *         distinguish "user staked through depositVPFIToVault and
     *         qualifies" from "user has dust + small legitimate stake,
     *         but the tracked tier is still 0".
     */
    function getTrackedVPFIDiscountTier(address user)
        external
        view
        returns (uint8 tier, uint256 trackedBal, uint256 discountBps)
    {
        // #954 (§2.2) — preview the tier from the SAME frozen-adjusted balance
        // the accumulator actually stamps (`rollupUserDiscount` →
        // `tierVpfiBalance`), so a stored party holding a transferred
        // position's frozen VPFI surplus doesn't see an inflated tier preview
        // that the stamp would never grant.
        uint256 rawTracked = LibVPFIDiscount.trackedVpfiBalance(user);
        trackedBal = LibVPFIDiscount.tierVpfiBalance(user, rawTracked);
        tier = LibVPFIDiscount.tierOf(trackedBal);
        discountBps = LibVPFIDiscount.discountBpsForTier(tier);
    }


    // ─── Discount price config (admin) ───────────────────────────────────────
    //
    // #687-A: the issuer fixed-rate SALE was removed. What remains is the
    // consumptive fee-discount utility — it needs a VPFI price anchor + an
    // ETH/USD reference asset to value the discount (see
    // `LibVPFIDiscount._feeAssetWeiToVpfi`). The two setters + reader below are
    // the renamed, sale-free survivors of the old buy-config surface.

    /// @notice Current VPFI fee-discount price config.
    /// @return weiPerVpfi    ETH wei per 1 VPFI (18 dec) used to value the VPFI
    ///                       fee discount. Zero ⇒ discount falls back to the
    ///                       normal fee.
    /// @return ethPriceAsset ERC-20 used as the ETH/USD reference asset.
    // forge-lint: disable-next-line(mixed-case-function)
    function getVPFIDiscountConfig()
        external
        view
        returns (uint256 weiPerVpfi, address ethPriceAsset)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.vpfiDiscountWeiPerVpfi, s.vpfiDiscountEthPriceAsset);
    }

    /// @notice Set the VPFI price anchor used by the fee-discount quote —
    ///         ETH wei per 1 VPFI (18 dec). Default 1e15 ⇒ 1 VPFI = 0.001 ETH.
    /// @dev Zero disables the discount quote (falls back to the normal fee).
    ///      ADMIN_ROLE-only. Emits {VPFIDiscountConfigUpdated}. (Renamed from
    ///      the removed `setVPFIBuyRate` — #687-A: the field is a discount price
    ///      anchor, not a sale rate.)
    /// @param weiPerVpfi ETH wei per 1 VPFI (18 dec).
    // forge-lint: disable-next-line(mixed-case-function)
    function setVPFIDiscountRate(uint256 weiPerVpfi)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.vpfiDiscountWeiPerVpfi = weiPerVpfi;
        emit VPFIDiscountConfigUpdated(weiPerVpfi, s.vpfiDiscountEthPriceAsset);
    }

    /// @notice Set the ERC-20 used as the ETH/USD price reference for the
    ///         discount quote. On mainnet this is the canonical WETH.
    /// @dev Zero disables the discount calculation (falls back to normal fee).
    ///      ADMIN_ROLE-only. Emits {VPFIDiscountConfigUpdated}.
    /// @param asset ERC-20 address used as the ETH reference (Chainlink-backed);
    ///              address(0) disables the quote.
    // forge-lint: disable-next-line(mixed-case-function)
    function setVPFIDiscountETHPriceAsset(address asset)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.vpfiDiscountEthPriceAsset = asset;
        emit VPFIDiscountConfigUpdated(s.vpfiDiscountWeiPerVpfi, asset);
    }

    // ─── Internal passthrough for OfferFacet ─────────────────────────────────

    /// @dev Emits the discount-applied event from this facet. Called via
    ///      cross-facet call by OfferFacet so indexers only need to
    ///      subscribe to one contract for discount analytics. Gated to
    ///      `msg.sender == address(this)` — only the diamond's
    ///      `LibFacet.crossFacetCall` can reach this selector. Reverts
    ///      {UnauthorizedCrossFacetCall} on any external caller.
    /// @param loanId       Newly-initiated loan id.
    /// @param borrower     Borrower who paid the discounted fee in VPFI.
    /// @param lendingAsset Loan's principal asset.
    /// @param vpfiDeducted VPFI moved from borrower vault to treasury.
    function emitDiscountApplied(
        uint256 loanId,
        address borrower,
        address lendingAsset,
        uint256 vpfiDeducted
    ) external {
        // Restrict to the diamond's own cross-facet path — same policy as
        // VaultFactoryFacet.onlyDiamondInternal (msg.sender == diamond).
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        emit VPFIDiscountApplied(loanId, borrower, lendingAsset, vpfiDeducted);
    }

    /// @dev Mirror of {emitDiscountApplied} for the lender Yield Fee
    ///      discount path. Called via cross-facet call by RepayFacet so the
    ///      analytics surface for all VPFI-discount paths lives on this
    ///      single facet. Same cross-facet gating as {emitDiscountApplied}.
    /// @param loanId       Loan being settled.
    /// @param lender       Lender who paid the discounted yield fee in VPFI.
    /// @param lendingAsset Loan's principal asset.
    /// @param vpfiDeducted VPFI moved from lender vault to treasury.
    function emitYieldFeeDiscountApplied(
        uint256 loanId,
        address lender,
        address lendingAsset,
        uint256 vpfiDeducted
    ) external {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        emit VPFIYieldFeeDiscountApplied(
            loanId,
            lender,
            lendingAsset,
            vpfiDeducted
        );
    }
}
