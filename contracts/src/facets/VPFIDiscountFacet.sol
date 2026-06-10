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
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title VPFIDiscountFacet
 * @author Vaipakam Developer Team
 * @notice Phase 1 borrower VPFI discount mechanism — spec in
 *         docs/TokenomicsTechSpec.md.
 * @dev Five user-facing surfaces:
 *        1. `buyVPFIWithETH()` — fixed-rate purchase that credits VPFI to
 *           the buyer's WALLET. This function is the canonical-chain leg
 *           only; users on mirror chains reach it transparently via the
 *           `VPFIBuyAdapter` → `VPFIBuyReceiver` CCIP round-trip (the
 *           adapter is a separate contract, not part of the Diamond). Per
 *           spec, vault funding is a separate explicit user step on every
 *           chain regardless of how the buy was routed.
 *        2. `depositVPFIToVault(amount)` — explicit wallet → vault move.
 *           Required on every chain: on canonical (Base) immediately after
 *           buying, or on non-canonical chains once the OFT return leg
 *           (or a manual bridge via the CCIP CCT bridge UI) lands VPFI
 *           in the user's wallet.
 *        3. `withdrawVPFIFromVault(amount)` — counterpart of (2). Unstakes
 *           vault VPFI back to the caller's wallet and checkpoints staking
 *           accrual before the balance change.
 *        4. `quoteVPFIDiscount(offerId)` / `quoteVPFIDiscountFor(id, user)`
 *           — views used by the frontend to show the VPFI that will be
 *           deducted at accept time.
 *        5. `setVPFIDiscountConsent(bool)` / `getVPFIDiscountConsent(user)`
 *           — the single platform-level user setting that governs whether
 *           vaulted VPFI may be spent on protocol-fee discounts. This same
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
 *          `VPFIBuyAdapter` → `VPFIBuyReceiver` CCIP round-trip and
 *          receive VPFI back in their wallet on the chain they started
 *          from. No manual chain-switch or bridge step is required of
 *          the user before calling `depositVPFIToVault`.
 *        - The DISCOUNT itself (vault VPFI → treasury at acceptance) works
 *          on every chain, gated purely on borrower vault VPFI balance.
 *
 *      Reserve model: the diamond SELLS VPFI from its own balance (no
 *      mint-on-demand). Ops must fund the diamond during canonical deploy
 *      (e.g. owner mints to diamond via TreasuryFacet.mintVPFI). The caps
 *      enforce the invariant — the total ever sold at fixed rate never
 *      exceeds the effective global cap ({LibVaipakam.cfgVpfiFixedGlobalCap};
 *      default 2.3M VPFI per docs/TokenomicsTechSpec.md §8).
 *
 *      Security: `buyVPFIWithETH` and `depositVPFIToVault` are
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
    /// @param buyer             The purchaser (VPFI is delivered to their wallet).
    /// @param vpfiAmount        The VPFI amount credited to the buyer's wallet.
    /// @param ethAmount         The ETH amount accepted (equals `msg.value`).
    /// @param newVaultBalance  Buyer's vault VPFI balance immediately after
    ///        the buy. Note: same-chain buys deliver VPFI to the buyer's
    ///        WALLET (not their vault), so this value reflects the existing
    ///        vault balance unchanged. Cross-chain bridged buys
    ///        ({VPFIBridgedBuyProcessed}) are emitted from
    ///        {VPFIBuyReceiver} on Base separately.
    ///        EventSourcingAudit §3.18 — frontend updates the
    ///        "your VPFI balance is now X" UI directly from the event.
    /// @custom:event-category state-change/vault-mutation
    event VPFIPurchasedWithETH(
        address indexed buyer,
        uint256 vpfiAmount,
        uint256 ethAmount,
        uint256 newVaultBalance
    );

    /// @notice Emitted when a bridged buy lands on Base — mirrors the
    ///         {VPFIPurchasedWithETH} event but for the cross-chain
    ///         path. VPFI is transferred to the registered bridged-buy
    ///         receiver (not the buyer), which then bridges it back to
    ///         `buyer` on their origin chain over CCIP.
    /// @param buyer        Buyer on the origin chain.
    /// @param originChainId EVM chain id of the buyer's origin chain.
    /// @param vpfiAmount   VPFI credited to the buyer (via the CCIP bridge back).
    /// @param ethAmountPaid Native ETH the buyer paid on the origin chain.
    /// @custom:event-category state-change/vault-mutation
    event VPFIBridgedBuyProcessed(
        address indexed buyer,
        uint32 indexed originChainId,
        uint256 vpfiAmount,
        uint256 ethAmountPaid
    );

    /// @notice Emitted when admin rotates the authorized bridged-buy
    ///         receiver on Base.
    /// @custom:event-category informational/config
    event BridgedBuyReceiverUpdated(
        address indexed oldReceiver,
        address indexed newReceiver
    );

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

    /// @notice Emitted when any VPFI buy-side config is changed by admin.
    /// @custom:event-category informational/config
    event VPFIBuyConfigUpdated(
        uint256 weiPerVpfi,
        uint256 globalCap,
        uint256 perWalletCap,
        bool enabled,
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
     * @notice Buy VPFI with ETH at the fixed admin-configured rate.
     *         Purchased VPFI is delivered to the buyer's WALLET — funding
     *         vault is a separate, explicit user action (see
     *         {depositVPFIToVault}).
     * @dev Canonical-chain only — reverts `NotCanonicalVPFIChain` on mirrors.
     *      Per spec (docs/TokenomicsTechSpec.md §8a): "VPFI
     *      purchase on Base delivers tokens to the user's wallet, not
     *      directly to vault; bridging is only needed when the borrower
     *      wants to use VPFI on a non-canonical lending chain; on every
     *      chain — including the canonical one — moving VPFI into vault
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
    // forge-lint: disable-next-line(mixed-case-function)
    function buyVPFIWithETH() external payable nonReentrant whenNotPaused {
        // Tier-1 sanctions gate. Sanctioned wallet cannot acquire
        // new VPFI via the fixed-rate buy. See policy block on
        // `LibVaipakam.isSanctionedAddress`.
        LibVaipakam._assertNotSanctioned(msg.sender);
        // Direct buy on the canonical Base Diamond — origin = local
        // chain. The per-wallet cap is keyed on the buyer's origin
        // chain (`block.chainid` here), so Base-direct buys do not
        // consume the buyer's cap on any mirror chain. `block.chainid`
        // must fit the uint32 cap-bucket key — the canonical chain's id
        // always does; this guard is defence-in-depth against a silent
        // truncation writing usage into the wrong bucket.
        if (block.chainid > type(uint32).max) {
            revert VPFIInvalidOriginChainId();
        }
        uint256 vpfiOut = _computeBuyAndDebitCaps(
            msg.sender,
            uint32(block.chainid),
            msg.value
        );

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;

        // Deliver VPFI to the buyer's WALLET. Moving it into vault is a
        // separate explicit step (depositVPFIToVault) — same flow applies
        // whether or not the buyer later bridges to a non-canonical chain.
        IERC20(vpfi).safeTransfer(msg.sender, vpfiOut);

        // Forward the ETH to treasury atomically.
        payable(LibFacet.getTreasury()).sendValue(msg.value);

        emit VPFIPurchasedWithETH(
            msg.sender,
            vpfiOut,
            msg.value,
            LibVPFIDiscount.vaultVpfiBalance(msg.sender)
        );
    }

    /**
     * @notice Cross-chain entry point: process a fixed-rate buy that
     *         was paid for on a non-Base chain and arrived via the
     *         {VpfiBuyReceiver} CCIP contract.
     * @dev Gated to `s.bridgedBuyReceiver`. Runs the IDENTICAL
     *      caps/rate/reserve pipeline as {buyVPFIWithETH} so the 2.3M
     *      global cap holds across the whole mesh (Base is the only
     *      gate). The per-wallet cap (default 30K VPFI) is enforced
     *      **per origin chain** — this call's `originChainId` is the
     *      bucket key, so a buyer who has spent their cap on Polygon
     *      can still buy up to the cap on Optimism (per
     *      docs/TokenomicsTechSpec.md §8a).
     *
     *      VPFI is transferred to `msg.sender` (the receiver contract),
     *      which then fires a CCIP send to deliver it to `buyer` on
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
     * @param originChainId EVM chain id of the buyer's origin chain.
     *                      Used as the second key on
     *                      `vpfiFixedRateSoldToByChainId[buyer][originChainId]`
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
        uint32 originChainId,
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
        // CCIP message (validated upstream by the bridged-buy receiver
        // against the registered channel peer). The per-wallet cap is
        // keyed on that origin so the same buyer can buy up to the
        // Phase 1 30K cap on each origin chain independently, as
        // required by docs/TokenomicsTechSpec.md §8a.
        vpfiOut = _computeBuyAndDebitCaps(buyer, originChainId, ethAmountPaid);
        if (vpfiOut < minVpfiOut) revert VPFIBuyAmountTooSmall();

        // Hand VPFI to the receiver; it will CCIP-bridge to `buyer` on
        // `originChainId`. Receiver must approve + send in the same tx.
        IERC20(s.vpfiToken).safeTransfer(msg.sender, vpfiOut);

        emit VPFIBridgedBuyProcessed(buyer, originChainId, vpfiOut, ethAmountPaid);
    }

    /// @dev Shared caps/rate/reserve pipeline. Reverts with the same
    ///      errors as {buyVPFIWithETH}. Only runs on canonical Base —
    ///      caller must ensure the context is Base (both public entry
    ///      points do).
    /// @param buyer         Per-wallet-cap key.
    /// @param originChainId EVM chain id of the buyer's origin chain.
    ///                      The per-wallet cap bucket is keyed on
    ///                      `(buyer, originChainId)` so the same
    ///                      buyer's cap on each origin chain is
    ///                      independent (per docs/TokenomicsTechSpec.md
    ///                      §8a). For direct buys this is the canonical
    ///                      chain's own `block.chainid`; for bridged
    ///                      buys it is the source chain id asserted by
    ///                      the CCIP message.
    /// @param ethAmount     Native ETH amount paid.
    /// @return vpfiOut      VPFI amount to deliver at the current rate.
    function _computeBuyAndDebitCaps(
        address buyer,
        uint32 originChainId,
        uint256 ethAmount
    ) internal returns (uint256 vpfiOut) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.isCanonicalVpfiChain) revert NotCanonicalVPFIChain();
        if (!s.vpfiFixedRateBuyEnabled) revert VPFIBuyDisabled();
        // Per-wallet cap is bucketed per origin chain
        // (`vpfiFixedRateSoldToByChainId[buyer][originChainId]`).
        // A zero `originChainId` would silently land every buy in
        // bucket 0, desyncing the frontend's per-chain allowance view
        // from the on-chain ledger. It cannot happen on a well-formed
        // call — direct buys pass `block.chainid`, bridged buys pass a
        // CcipMessenger-resolved source chain id — so this is a
        // defence-in-depth reject of a malformed origin.
        if (originChainId == 0) revert VPFIInvalidOriginChainId();

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

        uint256 newWallet = s.vpfiFixedRateSoldToByChainId[buyer][originChainId] + vpfiOut;
        if (newWallet > LibVaipakam.cfgVpfiFixedWalletCap())
            revert VPFIPerWalletCapExceeded();

        uint256 onHand = IERC20(vpfi).balanceOf(address(this));
        if (onHand < vpfiOut) revert VPFIReserveInsufficient();

        s.vpfiFixedRateTotalSold = newTotal;
        s.vpfiFixedRateSoldToByChainId[buyer][originChainId] = newWallet;
    }

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
        // Checkpoint the staker BEFORE the deposit lands so the accrual
        // captures the pre-deposit staked amount for the period it was
        // active, then adopts the new balance as the next accrual baseline.
        LibStakingRewards.updateUser(msg.sender, newStakedBal);
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
        // Staking checkpoint on the OLD balance before the pull.
        LibStakingRewards.updateUser(msg.sender, newStakedBal);

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
        trackedBal = LibVPFIDiscount.trackedVpfiBalance(user);
        tier = LibVPFIDiscount.tierOf(trackedBal);
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
    // forge-lint: disable-next-line(mixed-case-function)
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
            s.vpfiDiscountEthPriceAsset
        );
    }

    /// @notice VPFI already purchased by `user` at the fixed rate
    ///         from THIS chain's local origin (i.e. the local Diamond's
    ///         `block.chainid`). Per-wallet caps are bucketed per origin
    ///         chain; this getter returns the local-origin bucket so
    ///         callers reading the running total for the
    ///         currently-connected chain see the value they expect.
    ///         Use {getVPFISoldToByChainId} to query a specific origin
    ///         chain's bucket.
    /// @param  user   Address whose cumulative fixed-rate buy total to read.
    /// @return soldTo Cumulative VPFI (18 dec) `user` has purchased
    ///                against the per-wallet cap on this chain's local
    ///                origin bucket.
    // forge-lint: disable-next-line(mixed-case-function)
    function getVPFISoldTo(address user) external view returns (uint256 soldTo) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.vpfiFixedRateSoldToByChainId[user][uint32(block.chainid)];
    }

    /// @notice VPFI already purchased by `user` at the fixed rate
    ///         against the per-wallet cap bucket for `originChainId`.
    ///         The Phase 1 30K wallet cap applies independently per
    ///         origin chain (per docs/TokenomicsTechSpec.md §8a).
    /// @param  user      Address whose cumulative buy total to read.
    /// @param  originChainId EVM chain id of the origin chain.
    /// @return soldTo    Cumulative VPFI (18 dec) `user` has purchased
    ///                   from `originChainId`.
    // forge-lint: disable-next-line(mixed-case-function)
    function getVPFISoldToByChainId(address user, uint32 originChainId)
        external
        view
        returns (uint256 soldTo)
    {
        return LibVaipakam.storageSlot().vpfiFixedRateSoldToByChainId[user][originChainId];
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /// @notice Set the fixed rate — ETH wei per 1 VPFI (18 dec). Default
    ///         1e15 means 1 VPFI = 0.001 ETH.
    /// @dev Setting to zero disables both the buy path and the discount
    ///      quote. ADMIN_ROLE-only. Emits {VPFIBuyConfigUpdated}.
    /// @param weiPerVpfi ETH wei accepted per 1 VPFI (18 dec).
    // forge-lint: disable-next-line(mixed-case-function)
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
            s.vpfiDiscountEthPriceAsset
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
    // forge-lint: disable-next-line(mixed-case-function)
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
            s.vpfiDiscountEthPriceAsset
        );
    }

    /// @notice Turn the fixed-rate buy path on or off.
    /// @dev Does NOT affect the discount path at loan acceptance — the
    ///      borrower can still use already-owned VPFI to discount a loan
    ///      even while the buy gate is closed. ADMIN_ROLE-only.
    ///      Emits {VPFIBuyConfigUpdated}.
    /// @param enabled True to open the buy path, false to close it.
    // forge-lint: disable-next-line(mixed-case-function)
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
            s.vpfiDiscountEthPriceAsset
        );
    }

    /// @notice Register (or rotate) the authorized VPFIBuyReceiver
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
    ///         preview before sending the CCIP message.
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
    // forge-lint: disable-next-line(mixed-case-function)
    function setVPFIDiscountETHPriceAsset(address asset)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.vpfiDiscountEthPriceAsset = asset;
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
