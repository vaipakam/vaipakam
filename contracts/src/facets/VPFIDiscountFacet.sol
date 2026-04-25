// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibStakingRewards} from "../libraries/LibStakingRewards.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";

/**
 * @title VPFIDiscountFacet
 * @author Vaipakam Developer Team
 * @notice Phase 1 borrower VPFI discount mechanism — spec in
 *         docs/BorrowerVPFIDiscountMechanism.md.
 * @dev Five user-facing surfaces:
 *        1. `buyVPFIWithETH()` — fixed-rate purchase that credits VPFI to
 *           the buyer's WALLET. This function is the canonical-chain leg
 *           only; users on mirror chains reach it transparently via the
 *           `VPFIBuyAdapter` → `VPFIBuyReceiver` LayerZero round-trip (the
 *           adapter is a separate contract, not part of the Diamond). Per
 *           spec, escrow funding is a separate explicit user step on every
 *           chain regardless of how the buy was routed.
 *        2. `depositVPFIToEscrow(amount)` — explicit wallet → escrow move.
 *           Required on every chain: on canonical (Base) immediately after
 *           buying, or on non-canonical chains once the OFT return leg
 *           (or a manual bridge via the LayerZero OFT widget) lands VPFI
 *           in the user's wallet.
 *        3. `withdrawVPFIFromEscrow(amount)` — counterpart of (2). Unstakes
 *           escrow VPFI back to the caller's wallet and checkpoints staking
 *           accrual before the balance change.
 *        4. `quoteVPFIDiscount(offerId)` / `quoteVPFIDiscountFor(id, user)`
 *           — views used by the frontend to show the VPFI that will be
 *           deducted at accept time.
 *        5. `setVPFIDiscountConsent(bool)` / `getVPFIDiscountConsent(user)`
 *           — the single platform-level user setting that governs whether
 *           escrowed VPFI may be spent on protocol-fee discounts. This same
 *           flag governs BOTH the borrower Loan Initiation Fee discount
 *           (consumed in OfferFacet._acceptOffer) and the lender Yield
 *           Fee discount. No per-offer or per-call opt-in exists.
 *
 *      Admin surface (ADMIN_ROLE, matches VPFITokenFacet's pattern):
 *        - `setVPFIBuyRate(weiPerVpfi)` — rate at which ETH is accepted.
 *        - `setVPFIBuyCaps(globalCap, perWalletCap)` — global + wallet caps.
 *        - `setVPFIBuyEnabled(bool)` — kill-switch for the buy path.
 *        - `setVPFIDiscountETHPriceAsset(asset)` — WETH address (Chainlink
 *          oracle) used for the USD→ETH leg of the quote.
 *
 *      Chain scope:
 *        - Fixed-rate BUY is implemented on the canonical chain (Base) —
 *          that is where the reserve lives and where this function is
 *          callable. User-facing, however, the spec exposes a
 *          preferred-chain buy page: mirror-chain users reach this
 *          function transparently through the
 *          `VPFIBuyAdapter` → `VPFIBuyReceiver` LayerZero round-trip and
 *          receive VPFI back in their wallet on the chain they started
 *          from. No manual chain-switch or bridge step is required of
 *          the user before calling `depositVPFIToEscrow`.
 *        - The DISCOUNT itself (escrow VPFI → treasury at acceptance) works
 *          on every chain, gated purely on borrower escrow VPFI balance.
 *
 *      Reserve model: the diamond SELLS VPFI from its own balance (no
 *      mint-on-demand). Ops must fund the diamond during canonical deploy
 *      (e.g. owner mints to diamond via TreasuryFacet.mintVPFI). The caps
 *      enforce the invariant — the total ever sold at fixed rate never
 *      exceeds the effective global cap ({LibVaipakam.cfgVpfiFixedGlobalCap};
 *      default 2.3M VPFI per docs/TokenomicsTechSpec.md §8).
 *
 *      Security: `buyVPFIWithETH` and `depositVPFIToEscrow` are
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

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when a user buys VPFI with ETH at the fixed rate.
    /// @param buyer      The purchaser (VPFI is delivered to their wallet).
    /// @param vpfiAmount The VPFI amount credited to the buyer's wallet.
    /// @param ethAmount  The ETH amount accepted (equals `msg.value`).
    event VPFIPurchasedWithETH(
        address indexed buyer,
        uint256 vpfiAmount,
        uint256 ethAmount
    );

    /// @notice Emitted when a bridged buy lands on Base — mirrors the
    ///         {VPFIPurchasedWithETH} event but for the cross-chain
    ///         path. VPFI is transferred to the registered bridged-buy
    ///         receiver (not the buyer), which then OFT-bridges it back
    ///         to `buyer` on their origin chain.
    /// @param buyer        Buyer on the origin chain.
    /// @param originEid    LayerZero eid of the buyer's origin chain.
    /// @param vpfiAmount   VPFI credited to the buyer (via OFT bridge back).
    /// @param ethAmountPaid Native ETH the buyer paid on the origin chain.
    event VPFIBridgedBuyProcessed(
        address indexed buyer,
        uint32 indexed originEid,
        uint256 vpfiAmount,
        uint256 ethAmountPaid
    );

    /// @notice Emitted when admin rotates the authorized bridged-buy
    ///         receiver on Base.
    event BridgedBuyReceiverUpdated(
        address indexed oldReceiver,
        address indexed newReceiver
    );

    /// @notice Emitted when a holder moves VPFI from their wallet into their
    ///         escrow — typically after bridging from Base.
    /// @param user   The depositor (and escrow owner).
    /// @param amount VPFI amount moved from wallet to escrow.
    event VPFIDepositedToEscrow(address indexed user, uint256 amount);

    /// @notice Emitted when a staker unstakes — VPFI moves from the user's
    ///         escrow back to their wallet. Dropping below a tier threshold
    ///         here implicitly lowers the fee-discount tier on subsequent
    ///         acceptance / repayment events.
    /// @param user   The withdrawer (and escrow owner).
    /// @param amount VPFI amount moved from escrow to wallet.
    event VPFIWithdrawnFromEscrow(address indexed user, uint256 amount);

    /// @notice Emitted when the discount is successfully applied at loan
    ///         acceptance. Fired from the OfferFacet mutating path via
    ///         `LibVPFIDiscount.tryApply` — this facet re-emits it as a
    ///         passthrough so indexers can filter on one facet.
    /// @param loanId       The newly-initiated loan id.
    /// @param borrower     The borrower who paid the discounted fee in VPFI.
    /// @param lendingAsset The loan's principal asset.
    /// @param vpfiDeducted VPFI moved from borrower's escrow to treasury.
    event VPFIDiscountApplied(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed lendingAsset,
        uint256 vpfiDeducted
    );

    /// @notice Emitted when any VPFI buy-side config is changed by admin.
    event VPFIBuyConfigUpdated(
        uint256 weiPerVpfi,
        uint256 globalCap,
        uint256 perWalletCap,
        bool enabled,
        address ethPriceAsset
    );

    /// @notice Emitted when a user toggles the shared platform-level consent
    ///         to use escrowed VPFI for protocol fee discounts. A single
    ///         consent governs both the borrower Loan Initiation Fee
    ///         discount and the lender Yield Fee discount (spec: README
    ///         §"Treasury and Revenue Sharing", TokenomicsTechSpec §6).
    /// @param user    The user whose consent changed.
    /// @param enabled New consent state — true means escrow VPFI may be used.
    event VPFIDiscountConsentChanged(address indexed user, bool enabled);

    /// @notice Emitted when the lender Yield Fee discount is successfully
    ///         applied at repayment-time. Fired from the RepayFacet mutating
    ///         path via `LibVPFIDiscount.tryApplyYieldFee` — this facet
    ///         re-emits it as a passthrough so indexers can subscribe to a
    ///         single facet for discount analytics.
    /// @param loanId       The loan being settled.
    /// @param lender       The lender who paid the discounted yield fee in VPFI.
    /// @param lendingAsset The loan's principal asset.
    /// @param vpfiDeducted VPFI moved from lender's escrow to treasury.
    event VPFIYieldFeeDiscountApplied(
        uint256 indexed loanId,
        address indexed lender,
        address indexed lendingAsset,
        uint256 vpfiDeducted
    );

    // ─── User entry points ───────────────────────────────────────────────────

    /**
     * @notice Buy VPFI with ETH at the fixed admin-configured rate.
     *         Purchased VPFI is delivered to the buyer's WALLET — funding
     *         escrow is a separate, explicit user action (see
     *         {depositVPFIToEscrow}).
     * @dev Canonical-chain only — reverts `NotCanonicalVPFIChain` on mirrors.
     *      Per spec (docs/BorrowerVPFIDiscountMechanism.md §9): "VPFI
     *      purchase on Base delivers tokens to the user's wallet, not
     *      directly to escrow; bridging is only needed when the borrower
     *      wants to use VPFI on a non-canonical lending chain; on every
     *      chain — including the canonical one — moving VPFI into escrow
     *      is an explicit user-initiated action."
     *
     *      Reverts `VPFIBuyDisabled` when the admin kill-switch is off,
     *      `VPFIBuyRateNotSet` when no rate has been configured,
     *      `VPFIBuyAmountTooSmall` when `msg.value` rounds to zero VPFI,
     *      `VPFIGlobalCapExceeded` / `VPFIPerWalletCapExceeded` on cap
     *      breach, and `VPFIReserveInsufficient` when the diamond's on-hand
     *      VPFI balance can't cover the buy.
     *
     *      ETH is forwarded to the configured treasury in the same tx so
     *      the diamond does not accumulate native balance.
     *
     *      Emits {VPFIPurchasedWithETH}.
     */
    function buyVPFIWithETH() external payable nonReentrant whenNotPaused {
        // Direct buy on the canonical Base Diamond — origin = local
        // chain. The per-wallet cap is keyed on the buyer's origin
        // chain (Base in this case), so Base-direct buys do not
        // consume the buyer's cap on any mirror chain.
        uint256 vpfiOut = _computeBuyAndDebitCaps(
            msg.sender,
            LibVaipakam.storageSlot().localEid,
            msg.value
        );

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;

        // Deliver VPFI to the buyer's WALLET. Moving it into escrow is a
        // separate explicit step (depositVPFIToEscrow) — same flow applies
        // whether or not the buyer later bridges to a non-canonical chain.
        IERC20(vpfi).safeTransfer(msg.sender, vpfiOut);

        // Forward the ETH to treasury atomically.
        payable(LibFacet.getTreasury()).sendValue(msg.value);

        emit VPFIPurchasedWithETH(msg.sender, vpfiOut, msg.value);
    }

    /**
     * @notice Cross-chain entry point: process a fixed-rate buy that
     *         was paid for on a non-Base chain and arrived via the
     *         {VPFIBuyReceiver} OApp.
     * @dev Gated to `s.bridgedBuyReceiver`. Runs the IDENTICAL
     *      caps/rate/reserve pipeline as {buyVPFIWithETH} so the 2.3M
     *      global cap holds across the whole mesh (Base is the only
     *      gate). The per-wallet cap (default 30K VPFI) is enforced
     *      **per origin chain** — this call's `originEid` is the
     *      bucket key, so a buyer who has spent their cap on Polygon
     *      can still buy up to the cap on Optimism (per
     *      docs/TokenomicsTechSpec.md §8a).
     *
     *      VPFI is transferred to `msg.sender` (the receiver contract),
     *      which then fires an OFT send to deliver it to `buyer` on
     *      their origin chain. `ethAmountPaid` is informational only —
     *      the ETH itself was settled in the buyer's local treasury on
     *      the origin chain; Base never sees it, which is why no ETH
     *      forwards-to-treasury call happens here.
     *
     *      Reverts:
     *        - `NotCanonicalVPFIChain` on non-Base Diamonds.
     *        - `NotBridgedBuyReceiver` if caller is not the registered
     *          receiver.
     *        - Same cap/rate/reserve errors as {buyVPFIWithETH}.
     *
     *      Emits {VPFIBridgedBuyProcessed}.
     * @param buyer         Buyer on the origin chain.
     * @param originEid     LayerZero eid of the buyer's origin chain.
     *                      Used as the second key on
     *                      `vpfiFixedRateSoldToByEid[buyer][originEid]`
     *                      so the per-wallet cap is bucketed per origin
     *                      chain (NOT shared globally across all chains).
     * @param ethAmountPaid Native ETH the buyer paid on the origin
     *                      chain — used to size the VPFI out at the
     *                      current `weiPerVpfi`.
     * @param minVpfiOut    Slippage guard from the buyer — reverts if
     *                      the computed VPFI is less than this. Use 0
     *                      to disable.
     * @return vpfiOut      VPFI delivered to `msg.sender` (the receiver).
     */
    function processBridgedBuy(
        address buyer,
        uint32 originEid,
        uint256 ethAmountPaid,
        uint256 minVpfiOut
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 vpfiOut)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.bridgedBuyReceiver == address(0)) {
            revert BridgedBuyReceiverNotSet();
        }
        if (msg.sender != s.bridgedBuyReceiver) {
            revert NotBridgedBuyReceiver();
        }

        // Bridged buy — origin = the buyer's chain, asserted by the
        // OFT message (validated upstream by the bridged-buy receiver
        // against the registered peer). The per-wallet cap is keyed
        // on that origin so the same buyer can buy up to the Phase 1
        // 30K cap on each origin chain independently, as required by
        // docs/TokenomicsTechSpec.md §8a.
        vpfiOut = _computeBuyAndDebitCaps(buyer, originEid, ethAmountPaid);
        if (vpfiOut < minVpfiOut) revert VPFIBuyAmountTooSmall();

        // Hand VPFI to the receiver; it will OFT-bridge to `buyer` on
        // `originEid`. Receiver must approve and call OFT in the same tx.
        IERC20(s.vpfiToken).safeTransfer(msg.sender, vpfiOut);

        emit VPFIBridgedBuyProcessed(buyer, originEid, vpfiOut, ethAmountPaid);
    }

    /// @dev Shared caps/rate/reserve pipeline. Reverts with the same
    ///      errors as {buyVPFIWithETH}. Only runs on canonical Base —
    ///      caller must ensure the context is Base (both public entry
    ///      points do).
    /// @param buyer         Per-wallet-cap key.
    /// @param originEid     LayerZero V2 endpoint id of the buyer's
    ///                      origin chain. The per-wallet cap bucket is
    ///                      keyed on `(buyer, originEid)` so the same
    ///                      buyer's cap on each origin chain is
    ///                      independent (per docs/TokenomicsTechSpec.md
    ///                      §8a). For direct buys this is the canonical
    ///                      chain's `localEid`; for bridged buys it is
    ///                      the asserted-from-message origin eid.
    /// @param ethAmount     Native ETH amount paid.
    /// @return vpfiOut      VPFI amount to deliver at the current rate.
    function _computeBuyAndDebitCaps(
        address buyer,
        uint32 originEid,
        uint256 ethAmount
    ) internal returns (uint256 vpfiOut) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.isCanonicalVPFIChain) revert NotCanonicalVPFIChain();
        if (!s.vpfiFixedRateBuyEnabled) revert VPFIBuyDisabled();

        uint256 weiPerVpfi = s.vpfiFixedRateWeiPerVpfi;
        if (weiPerVpfi == 0) revert VPFIBuyRateNotSet();
        if (ethAmount == 0) revert InvalidAmount();

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();

        // vpfiOut (18 decimals) = ethAmount * 1e18 / weiPerVpfi
        vpfiOut = (ethAmount * 1e18) / weiPerVpfi;
        if (vpfiOut == 0) revert VPFIBuyAmountTooSmall();

        uint256 newTotal = s.vpfiFixedRateTotalSold + vpfiOut;
        // Caps use zero-fallback semantics (docs/TokenomicsTechSpec.md §8,
        // §8a): a stored zero means "use the spec default", never
        // "uncapped". Enforcement always runs — there is no bypass.
        if (newTotal > LibVaipakam.cfgVpfiFixedGlobalCap())
            revert VPFIGlobalCapExceeded();

        uint256 newWallet = s.vpfiFixedRateSoldToByEid[buyer][originEid] + vpfiOut;
        if (newWallet > LibVaipakam.cfgVpfiFixedWalletCap())
            revert VPFIPerWalletCapExceeded();

        uint256 onHand = IERC20(vpfi).balanceOf(address(this));
        if (onHand < vpfiOut) revert VPFIReserveInsufficient();

        s.vpfiFixedRateTotalSold = newTotal;
        s.vpfiFixedRateSoldToByEid[buyer][originEid] = newWallet;
    }

    /**
     * @notice Move VPFI from the caller's wallet into the caller's escrow.
     * @dev Intended for users who bridged VPFI to a non-canonical chain via
     *      LayerZero and now want to deposit it into their local escrow to
     *      qualify for the discount on that chain. Works on every chain,
     *      including the canonical one. Caller must have approved this
     *      diamond for `amount` on the registered VPFI token.
     *
     *      Reverts `VPFITokenNotSet` when the diamond has no VPFI bound,
     *      `InvalidAmount` on zero amount. Emits {VPFIDepositedToEscrow}.
     * @param amount VPFI wei amount to deposit (18 decimals).
     */
    function depositVPFIToEscrow(uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        (address vpfi, address escrow) = _prepareDeposit(amount);
        IERC20(vpfi).safeTransferFrom(msg.sender, escrow, amount);
        emit VPFIDepositedToEscrow(msg.sender, amount);
    }

    /**
     * @notice Permit2 variant of {depositVPFIToEscrow} (Phase 8b.1).
     *
     * @dev Pulls VPFI from the caller's wallet to their escrow via
     *      Uniswap's Permit2 in a single transaction — no separate
     *      `approve` tx required. The caller signs an EIP-712
     *      `PermitTransferFrom` typed-data payload off-chain (frontend
     *      handles payload + signature construction), then submits the
     *      signature alongside the deposit call here.
     *
     *      Staking + discount-accrual side-effects mirror
     *      {depositVPFIToEscrow} — both paths share `_prepareDeposit`.
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
    function depositVPFIToEscrowWithPermit(
        uint256 amount,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        (address vpfi, address escrow) = _prepareDeposit(amount);
        // Bind the Permit2 pull to the registered VPFI token. Without
        // this check a permit signed for a different ERC-20 would be
        // honoured by Permit2 while {_prepareDeposit} has already
        // re-stamped the VPFI discount accumulator and staking
        // checkpoint at the post-mutation balance — the on-chain VPFI
        // balance would not actually move and accounting would drift.
        LibPermit2.pull(msg.sender, escrow, vpfi, amount, permit, signature);
        emit VPFIDepositedToEscrow(msg.sender, amount);
    }

    /// @dev Shared pre-pull setup — validates amount, resolves the VPFI
    ///      token address and the caller's escrow, rolls up the
    ///      discount accumulator + staking checkpoint at the
    ///      post-mutation balance. Returns the resolved
    ///      `(vpfi, escrow)` so the caller can do the actual transfer
    ///      via whichever path (safeTransferFrom vs Permit2) fits.
    function _prepareDeposit(uint256 amount)
        private
        returns (address vpfi, address escrow)
    {
        if (amount == 0) revert InvalidAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        escrow = EscrowFactoryFacet(address(this)).getOrCreateUserEscrow(
            msg.sender
        );
        uint256 prevBal = IERC20(vpfi).balanceOf(escrow);
        // Roll up the VPFI discount accumulator, re-stamping at the
        // post-mutation balance so the next period accrues at the tier
        // the user will actually hold after this deposit lands.
        LibVPFIDiscount.rollupUserDiscount(msg.sender, prevBal + amount);
        // Checkpoint the staker BEFORE the deposit lands so the accrual
        // captures the pre-deposit staked amount for the period it was
        // active, then adopts the new balance as the next accrual baseline.
        LibStakingRewards.updateUser(msg.sender, prevBal + amount);
    }

    /**
     * @notice Move VPFI from the caller's escrow back to their wallet.
     * @dev The counterpart to {depositVPFIToEscrow} — lets a staker unstake
     *      by reducing their escrow VPFI balance. Staking accrual is
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
     *      `VPFIEscrowBalanceInsufficient` when the caller's escrow
     *      doesn't hold `amount`. Pausable + reentrancy-guarded.
     *
     *      Emits {VPFIWithdrawnFromEscrow}.
     * @param amount VPFI wei amount to withdraw (18 decimals).
     */
    function withdrawVPFIFromEscrow(uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert InvalidAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();

        address escrow = s.userVaipakamEscrows[msg.sender];
        if (escrow == address(0)) revert VPFIEscrowBalanceInsufficient();
        uint256 prevBal = IERC20(vpfi).balanceOf(escrow);
        if (prevBal < amount) revert VPFIEscrowBalanceInsufficient();

        // Close the VPFI-discount period and re-stamp at the post-
        // mutation balance. The closing period carries the stamp left
        // by the prior rollup (whatever tier was in effect up to now);
        // the next period starts at the tier the user will hold after
        // this withdraw.
        LibVPFIDiscount.rollupUserDiscount(msg.sender, prevBal - amount);
        // Staking checkpoint on the OLD balance before the pull.
        LibStakingRewards.updateUser(msg.sender, prevBal - amount);

        EscrowFactoryFacet(address(this)).escrowWithdrawERC20(
            msg.sender,
            vpfi,
            msg.sender,
            amount
        );

        emit VPFIWithdrawnFromEscrow(msg.sender, amount);
    }

    /**
     * @notice Set the caller's platform-level consent to use escrowed VPFI
     *         for protocol fee discounts. A single consent governs both
     *         the borrower Loan Initiation Fee discount and the lender
     *         Yield Fee discount — no offer-level or loan-level toggle is
     *         needed once this is true.
     * @dev Per spec (docs/TokenomicsTechSpec.md §6, README §"Treasury and
     *      Revenue Sharing"): "the [borrower / lender] must explicitly
     *      consent through a single platform-level user setting... Only
     *      when that platform-level consent is active and sufficient VPFI
     *      is available in escrow will the system automatically deduct
     *      the discounted fee amount in VPFI from escrow and transfer it
     *      to Treasury."
     *
     *      Pausable + non-reentrant so an operator pause fully disables
     *      new consent changes. Existing consent state is preserved across
     *      pauses.
     *
     *      Emits {VPFIDiscountConsentChanged}.
     * @param enabled True to opt in; false to opt out.
     */
    function setVPFIDiscountConsent(bool enabled)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam.storageSlot().vpfiDiscountConsent[msg.sender] = enabled;
        emit VPFIDiscountConsentChanged(msg.sender, enabled);
    }

    // ─── Public views ────────────────────────────────────────────────────────

    /**
     * @notice Returns `user`'s platform-level VPFI fee-discount consent.
     *         When true, the protocol automatically applies the borrower
     *         and lender discounts whenever the escrow holds enough VPFI
     *         and the asset leg is eligible.
     * @param user The address whose consent to read.
     * @return enabled Consent state.
     */
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
            LibVaipakam.storageSlot().userVpfiDiscountState[user];
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
     *      tier depends on the acceptor's escrow balance. Frontend should
     *      call {quoteVPFIDiscountFor} with the connected wallet address
     *      instead.
     *
     *      Matching the spec: the discount applies only to liquid lending
     *      assets. Liquidity is checked via OracleFacet at accept time; this
     *      quote only enforces the preconditions it can verify statically
     *      without re-running liquidity checks.
     * @param offerId Offer to quote against.
     * @return eligible          True iff the full quote succeeded.
     * @return vpfiRequired      VPFI (18 dec) borrower must hold in escrow.
     * @return borrowerEscrowBal Borrower's current escrow VPFI balance.
     * @return tier              Resolved tier 1..4 (0 when ineligible).
     */
    function quoteVPFIDiscount(uint256 offerId)
        external
        view
        returns (
            bool eligible,
            uint256 vpfiRequired,
            uint256 borrowerEscrowBal,
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

        // Tier depends on the borrower's escrow balance. For a Borrower offer
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
        address escrow = s.userVaipakamEscrows[knownBorrower];
        if (escrow != address(0) && s.vpfiToken != address(0)) {
            bal = IERC20(s.vpfiToken).balanceOf(escrow);
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
     * @return vpfiRequired      VPFI (18 dec) `borrower` must hold in escrow.
     * @return borrowerEscrowBal `borrower`'s current escrow VPFI balance.
     * @return tier              Resolved tier 1..4 (0 when ineligible).
     */
    function quoteVPFIDiscountFor(uint256 offerId, address borrower)
        external
        view
        returns (
            bool eligible,
            uint256 vpfiRequired,
            uint256 borrowerEscrowBal,
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
        address escrow = s.userVaipakamEscrows[borrower];
        if (escrow != address(0) && s.vpfiToken != address(0)) {
            bal = IERC20(s.vpfiToken).balanceOf(escrow);
        }

        if (!canQuote) return (false, 0, bal, 0);
        return (true, vpfi, bal, t);
    }

    /**
     * @notice Resolve `user`'s current VPFI discount tier purely from their
     *         escrow balance. Cheap, pure, no oracle dependency.
     * @param user Address whose tier to resolve.
     * @return tier        0..4 (0 means no discount).
     * @return escrowBal   `user`'s current escrow VPFI balance.
     * @return discountBps Discount applied to the normal fee for this tier.
     */
    function getVPFIDiscountTier(address user)
        external
        view
        returns (uint8 tier, uint256 escrowBal, uint256 discountBps)
    {
        escrowBal = LibVPFIDiscount.escrowVPFIBalance(user);
        tier = LibVPFIDiscount.tierOf(escrowBal);
        discountBps = LibVPFIDiscount.discountBpsForTier(tier);
    }

    /**
     * @notice Current VPFI buy-side config + running totals.
     * @dev    `globalCap` and `perWalletCap` are returned as EFFECTIVE
     *         values — when the admin leaves the stored slot at zero, the
     *         return value is the spec default
     *         ({LibVaipakam.VPFI_FIXED_GLOBAL_CAP} /
     *         {LibVaipakam.VPFI_FIXED_WALLET_CAP}). There is no
     *         "uncapped" mode (docs/TokenomicsTechSpec.md §8, §8a).
     * @return weiPerVpfi   Fixed rate — ETH wei accepted per 1 VPFI (18 dec).
     * @return globalCap    Effective global cap on VPFI sold at fixed rate.
     * @return perWalletCap Effective per-wallet cap.
     * @return totalSold    Cumulative VPFI sold at fixed rate.
     * @return enabled      True iff the buy path is currently open.
     * @return ethPriceAsset ERC-20 used as the ETH/USD reference asset.
     */
    function getVPFIBuyConfig()
        external
        view
        returns (
            uint256 weiPerVpfi,
            uint256 globalCap,
            uint256 perWalletCap,
            uint256 totalSold,
            bool enabled,
            address ethPriceAsset
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.vpfiFixedRateWeiPerVpfi,
            LibVaipakam.cfgVpfiFixedGlobalCap(),
            LibVaipakam.cfgVpfiFixedWalletCap(),
            s.vpfiFixedRateTotalSold,
            s.vpfiFixedRateBuyEnabled,
            s.vpfiDiscountETHPriceAsset
        );
    }

    /// @notice VPFI already purchased by `user` at the fixed rate
    ///         from THIS chain's local origin (i.e. the local Diamond's
    ///         `localEid`). Per-wallet caps are bucketed per origin
    ///         chain; this getter returns the local-origin bucket so
    ///         legacy callers reading the running total for the
    ///         currently-connected chain see the value they expect.
    ///         Use {getVPFISoldToByEid} to query a specific origin
    ///         chain's bucket.
    /// @param  user   Address whose cumulative fixed-rate buy total to read.
    /// @return soldTo Cumulative VPFI (18 dec) `user` has purchased
    ///                against the per-wallet cap on this chain's local
    ///                origin bucket.
    function getVPFISoldTo(address user) external view returns (uint256 soldTo) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.vpfiFixedRateSoldToByEid[user][s.localEid];
    }

    /// @notice VPFI already purchased by `user` at the fixed rate
    ///         against the per-wallet cap bucket for `originEid`.
    ///         The Phase 1 30K wallet cap applies independently per
    ///         origin chain (per docs/TokenomicsTechSpec.md §8a).
    /// @param  user      Address whose cumulative buy total to read.
    /// @param  originEid LayerZero V2 endpoint id of the origin chain.
    /// @return soldTo    Cumulative VPFI (18 dec) `user` has purchased
    ///                   from `originEid`.
    function getVPFISoldToByEid(address user, uint32 originEid)
        external
        view
        returns (uint256 soldTo)
    {
        return LibVaipakam.storageSlot().vpfiFixedRateSoldToByEid[user][originEid];
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /// @notice Set the fixed rate — ETH wei per 1 VPFI (18 dec). Default
    ///         1e15 means 1 VPFI = 0.001 ETH.
    /// @dev Setting to zero disables both the buy path and the discount
    ///      quote. ADMIN_ROLE-only. Emits {VPFIBuyConfigUpdated}.
    /// @param weiPerVpfi ETH wei accepted per 1 VPFI (18 dec).
    function setVPFIBuyRate(uint256 weiPerVpfi)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.vpfiFixedRateWeiPerVpfi = weiPerVpfi;
        emit VPFIBuyConfigUpdated(
            weiPerVpfi,
            s.vpfiFixedRateGlobalCap,
            s.vpfiFixedRatePerWalletCap,
            s.vpfiFixedRateBuyEnabled,
            s.vpfiDiscountETHPriceAsset
        );
    }

    /// @notice Set the global and per-wallet caps on fixed-rate VPFI sales.
    /// @dev Zero on either field resolves to the spec default
    ///      ({LibVaipakam.VPFI_FIXED_GLOBAL_CAP} /
    ///      {LibVaipakam.VPFI_FIXED_WALLET_CAP}) via
    ///      {LibVaipakam.cfgVpfiFixedGlobalCap} /
    ///      {LibVaipakam.cfgVpfiFixedWalletCap}. There is no "uncapped"
    ///      mode (docs/TokenomicsTechSpec.md §8, §8a). The existing
    ///      `vpfiFixedRateTotalSold` counter is NOT reset.
    ///      ADMIN_ROLE-only. Emits {VPFIBuyConfigUpdated} with the raw
    ///      stored inputs so admin can confirm a reset-to-default.
    /// @param globalCap    Max total VPFI sellable across all buyers
    ///                     (0 = fall back to the 2.3M VPFI spec default).
    /// @param perWalletCap Max VPFI sellable per buyer address
    ///                     (0 = fall back to the 30k VPFI spec default).
    function setVPFIBuyCaps(uint256 globalCap, uint256 perWalletCap)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.vpfiFixedRateGlobalCap = globalCap;
        s.vpfiFixedRatePerWalletCap = perWalletCap;
        emit VPFIBuyConfigUpdated(
            s.vpfiFixedRateWeiPerVpfi,
            globalCap,
            perWalletCap,
            s.vpfiFixedRateBuyEnabled,
            s.vpfiDiscountETHPriceAsset
        );
    }

    /// @notice Turn the fixed-rate buy path on or off.
    /// @dev Does NOT affect the discount path at loan acceptance — the
    ///      borrower can still use already-owned VPFI to discount a loan
    ///      even while the buy gate is closed. ADMIN_ROLE-only.
    ///      Emits {VPFIBuyConfigUpdated}.
    /// @param enabled True to open the buy path, false to close it.
    function setVPFIBuyEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.vpfiFixedRateBuyEnabled = enabled;
        emit VPFIBuyConfigUpdated(
            s.vpfiFixedRateWeiPerVpfi,
            s.vpfiFixedRateGlobalCap,
            s.vpfiFixedRatePerWalletCap,
            enabled,
            s.vpfiDiscountETHPriceAsset
        );
    }

    /// @notice Register (or rotate) the authorized VPFIBuyReceiver OApp
    ///         on Base. Only this address may invoke
    ///         {processBridgedBuy}.
    /// @dev ADMIN_ROLE-gated. Zero disables the bridged-buy ingress
    ///      until a new receiver is wired. Only meaningful on the
    ///      canonical VPFI chain; on mirrors the flag is inert
    ///      (processBridgedBuy reverts {NotCanonicalVPFIChain} first).
    /// @param receiver VPFIBuyReceiver proxy address on Base.
    function setBridgedBuyReceiver(
        address receiver
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address old = s.bridgedBuyReceiver;
        s.bridgedBuyReceiver = receiver;
        emit BridgedBuyReceiverUpdated(old, receiver);
    }

    /// @notice Returns the currently authorized VPFIBuyReceiver address,
    ///         or zero if bridged-buy ingress is disabled.
    function getBridgedBuyReceiver() external view returns (address) {
        return LibVaipakam.storageSlot().bridgedBuyReceiver;
    }

    /// @notice Quote the VPFI out for a given wei amount at the current
    ///         fixed rate — used by mirror-chain adapters to render a
    ///         preview before sending the LayerZero message.
    /// @dev Returns 0 if the buy path is disabled, the rate is unset,
    ///      or the amount rounds to zero VPFI. Does not consult caps —
    ///      caps are enforced atomically on Base inside
    ///      {processBridgedBuy}.
    /// @param weiAmount Native ETH amount (wei).
    /// @return vpfiOut  VPFI (18 dec) that would be delivered.
    function quoteFixedRateBuy(
        uint256 weiAmount
    ) external view returns (uint256 vpfiOut) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.vpfiFixedRateBuyEnabled) return 0;
        uint256 weiPerVpfi = s.vpfiFixedRateWeiPerVpfi;
        if (weiPerVpfi == 0 || weiAmount == 0) return 0;
        vpfiOut = (weiAmount * 1e18) / weiPerVpfi;
    }

    /// @notice Set the ERC-20 used as the ETH/USD price reference for the
    ///         discount quote. On mainnet this is the canonical WETH.
    /// @dev Zero disables the discount calculation (falls back to normal
    ///      fee). ADMIN_ROLE-only. Emits {VPFIBuyConfigUpdated}.
    /// @param asset ERC-20 address used as the ETH reference
    ///              (Chainlink-backed); address(0) disables the quote.
    function setVPFIDiscountETHPriceAsset(address asset)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.vpfiDiscountETHPriceAsset = asset;
        emit VPFIBuyConfigUpdated(
            s.vpfiFixedRateWeiPerVpfi,
            s.vpfiFixedRateGlobalCap,
            s.vpfiFixedRatePerWalletCap,
            s.vpfiFixedRateBuyEnabled,
            asset
        );
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
    /// @param vpfiDeducted VPFI moved from borrower escrow to treasury.
    function emitDiscountApplied(
        uint256 loanId,
        address borrower,
        address lendingAsset,
        uint256 vpfiDeducted
    ) external {
        // Restrict to the diamond's own cross-facet path — same policy as
        // EscrowFactoryFacet.onlyDiamondInternal (msg.sender == diamond).
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
    /// @param vpfiDeducted VPFI moved from lender escrow to treasury.
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
