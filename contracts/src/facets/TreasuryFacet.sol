// src/facets/TreasuryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IVPFIToken} from "../interfaces/IVPFIToken.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {ICrossChainMessenger} from "../crosschain/ICrossChainMessenger.sol";
import {LibTreasuryBuyback} from "../libraries/LibTreasuryBuyback.sol";
import {LibBuybackOrderValidation} from "../libraries/LibBuybackOrderValidation.sol";
import {LibTreasuryYield} from "../libraries/LibTreasuryYield.sol";

/**
 * @title TreasuryFacet
 * @author Vaipakam Developer Team
 * @notice This facet manages treasury fee accumulation and claims for the Vaipakam platform.
 * @dev Part of Diamond Standard (EIP-2535). Uses shared LibVaipakam storage for balances.
 *      Fees (TREASURY_FEE_BPS = 1% of interest + late fees) accumulate in the
 *      diamond proxy at settlement time. LibSettlement is the single source
 *      of truth for the fee split across all settlement paths (repay,
 *      preclose, refinance, partial withdraw).
 *      ADMIN_ROLE-gated claim to a specified address (multi-sig in production).
 *      Supports ERC-20 assets; custom errors, events, ReentrancyGuard, pausable.
 *      Expand for Phase 2 (governance distributions, reserves).
 */
contract TreasuryFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when treasury fees are claimed.
    /// @param asset The ERC-20 asset claimed.
    /// @param amount The claimed amount.
    /// @param claimant The address receiving the claim (specified by owner).
    /// @custom:event-category state-change/treasury-mutation
    event TreasuryFeesClaimed(
        address indexed asset,
        uint256 amount,
        address indexed claimant
    );

    /// @notice Emitted when VPFI is minted through the treasury's admin
    ///         mint path. Mirrors (but does not replace) the token's own
    ///         Minted event — this one captures that the mint originated
    ///         from the Diamond's ADMIN_ROLE flow for governance audit.
    /// @param to     Recipient of the freshly-minted VPFI.
    /// @param amount Amount minted (18 decimals).
    /// @custom:event-category state-change/vault-mutation
    event VPFIMinted(address indexed to, uint256 amount);

    /// @notice Emitted on a successful `convertTreasuryAsset`.
    /// @param tokenIn The input asset whose treasury balance was converted.
    /// @param amountIn The full input balance consumed.
    /// @param targetCount The number of configured target legs the
    ///        input was split across. Per-leg amounts are recoverable
    ///        from the `treasuryBalances` deltas and the `LibSwap`
    ///        swap-event stream (keyed on the sentinel `loanId == 0`).
    /// @custom:event-category state-change/treasury-mutation
    event TreasuryConverted(
        address indexed tokenIn,
        uint256 amountIn,
        uint256 targetCount
    );

    // Facet-specific errors (InvalidAddress, NotCanonicalVPFIChain inherited
    // from IVaipakamErrors).
    error ZeroAmount();
    error VPFITokenNotRegistered();
    /// @notice `convertTreasuryAsset` requires Diamond-as-treasury
    ///         mode (`s.treasury == address(this)`) — only then does
    ///         `treasuryBalances` track convertible funds.
    error TreasuryNotDiamond();
    /// @notice The conversion eligibility gate (USD-value OR max-interval)
    ///         has not been met yet.
    error ConversionNotEligible();
    /// @notice No target allocation is configured — governance must call
    ///         `ConfigFacet.setTreasuryConvertTargets` first.
    error TreasuryConvertNoTargets();
    /// @notice The per-target `calls` / `minOuts` arrays do not match the
    ///         configured target count.
    error TreasuryConvertArityMismatch(uint256 provided, uint256 expected);
    /// @notice A conversion leg's swap soft-failed across every adapter.
    error TreasuryConvertSwapFailed(address tokenOut);

    // ─── T-087 Sub 3.A — buyback remittance ──────────────────────────

    /// @notice `remitBuyback` was called for a token that is NOT on
    ///         the allow-list for this chain (per
    ///         `s.buybackAllowedToken[chainId][token]`).
    error BuybackTokenNotAllowed(uint256 chainId, address token);
    /// @notice `remitBuyback` was called for a token marked in
    ///         `buybackNoConvert` — the token is intentionally
    ///         exempted from cross-chain remittance (e.g., ETH from
    ///         `buyVPFIWithETH` stays in operational reserve + LP).
    error BuybackTokenNoConvert(address token);
    /// @notice The configured `buybackBudget` for the token can't
    ///         cover the requested remit amount.
    error InsufficientBuybackBudget(uint256 requested, uint256 available);
    /// @notice The Diamond's CCIP port (`s.crossChainMessenger`) is
    ///         not configured. Admin must call
    ///         `setCrossChainMessenger` before `remitBuyback`.
    error CrossChainMessengerNotSet();
    /// @notice Inbound `absorbRemittance` not called by the
    ///         registered `buybackRemittanceReceiver`.
    error OnlyBuybackRemittanceReceiver(address caller);
    /// @notice `setCrossChainMessenger` or
    ///         `setBuybackRemittanceReceiver` called with zero.
    error TreasuryZeroAddress();
    /// @notice Codex Sub 3.A round-6 P2 #1 — operator passed a
    ///         `destToken` that disagrees with the pre-pinned
    ///         `s.buybackDestToken[srcToken]`. Either the operator
    ///         typo'd OR the mapping was never set; either way the
    ///         remit must abort BEFORE debiting the budget so the
    ///         funds aren't stranded mid-bridge.
    error BuybackDestTokenMismatch(
        address srcToken,
        address expected,
        address provided
    );

    /// @notice Default CCIP destination gas limit for the buyback
    ///         remittance callback. `BuybackRemittanceReceiver`'s
    ///         inbound handler does: 1 token transfer + 1 facet call
    ///         (`absorbRemittance`) + 1 event emit. 300k covers it
    ///         with headroom.
    uint256 internal constant BUYBACK_DEST_GAS_LIMIT = 300_000;

    /// @custom:event-category state-change/buyback-remittance
    event BuybackRemitted(
        bytes32 indexed messageId,
        address indexed token,
        uint256 amount,
        uint256 destChainId
    );
    /// @custom:event-category state-change/buyback-remittance
    event BuybackRemittanceAbsorbed(
        address indexed token,
        uint256 amount,
        uint256 indexed sourceChainId
    );
    /// @custom:event-category state-change/buyback-remittance
    /// @notice Codex Sub 3.A round-2 P1 #2 — admin moved
    ///         `amount` of `token` from `treasuryBalances` into
    ///         `buybackBudget` so a future `remitBuyback` can ship
    ///         it cross-chain to Base.
    event BuybackBudgetCredited(address indexed token, uint256 amount);
    /// @custom:event-category informational/config
    /// @notice T-087 Sub 3.B round-3 P2 — per-token raw-amount
    ///         tranche cap for `commitBuybackIntent`. `cap == 0`
    ///         disables the gate.
    event BuybackMaxTrancheSet(address indexed token, uint256 cap);
    /// @custom:event-category informational/config
    event BuybackAllowedTokenSet(
        uint256 indexed chainId,
        address indexed token,
        bool allowed
    );
    /// @custom:event-category informational/config
    event BuybackNoConvertSet(address indexed token, bool on);
    /// @custom:event-category informational/config
    event BuybackDestTokenSet(
        address indexed srcToken,
        address indexed destToken
    );
    /// @custom:event-category informational/config
    event BuybackRemittanceReceiverSet(
        address indexed previous,
        address indexed newReceiver
    );
    /// @custom:event-category informational/config
    event CrossChainMessengerSet(
        address indexed previous,
        address indexed newMessenger
    );

    /**
     * @notice Claims accumulated treasury fees for an asset.
     * @dev ADMIN_ROLE-only. Sweeps the full accumulated balance for `asset`
     *      to `claimant` (typically a multi-sig wallet). Zeroes
     *      `treasuryBalances[asset]` BEFORE the transfer (CEI pattern).
     *      Reverts InvalidAddress on zero claimant, ZeroAmount if no
     *      balance to claim. Emits TreasuryFeesClaimed.
     * @param asset The ERC-20 asset to sweep.
     * @param claimant The recipient of the swept balance (non-zero).
     */
    function claimTreasuryFees(
        address asset,
        address claimant
    ) external nonReentrant whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (claimant == address(0)) revert InvalidAddress();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 balance = s.treasuryBalances[asset];
        if (balance == 0) revert ZeroAmount();

        // Update balance before transfer (CEI pattern)
        s.treasuryBalances[asset] = 0;

        // Transfer to claimant
        IERC20(asset).safeTransfer(claimant, balance);

        emit TreasuryFeesClaimed(asset, balance, claimant);
    }

    /**
     * @notice View function to get treasury balance for an asset.
     * @dev Returns accumulated fees (from repayments, forfeitures, etc.).
     * @param asset The ERC-20 asset.
     * @return balance The treasury balance for the asset.
     */
    function getTreasuryBalance(
        address asset
    ) external view returns (uint256 balance) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.treasuryBalances[asset];
    }

    /**
     * @notice Mint VPFI to `to` through the registered token.
     * @dev Phase 1 tokenomics — see docs/TokenomicsTechSpec.md §2 and §8.
     *      Two off-chain prerequisites must be satisfied before this call
     *      succeeds:
     *        1. VPFITokenFacet.setVPFIToken(...) has registered the
     *           canonical VPFI proxy with the Diamond; otherwise reverts
     *           {VPFITokenNotRegistered}.
     *        2. The token's owner (timelock / multi-sig) has called
     *           `VPFIToken.setMinter(diamond)` so the Diamond is the
     *           authorized minter; otherwise the inner call reverts
     *           {IVPFIToken.NotMinter} and its data is bubbled up.
     *
     *      This function is the single minting primitive used by the
     *      Diamond. Allocation-table mints (founders' vesting wallets,
     *      audit payouts, bug-bounty funding, etc.) route through it
     *      under ADMIN_ROLE. Per-user reward claims (interaction rewards,
     *      scheduled in a later rollout phase) will call it cross-facet
     *      from ClaimFacet / RewardsFacet on the user's pull.
     *
     *      Cap enforcement is delegated to the token itself
     *      (ERC20CappedUpgradeable in VPFIToken) so the 230M invariant is
     *      preserved regardless of which Diamond code path mints.
     *
     * @param to     Recipient of the freshly-minted VPFI (non-zero).
     * @param amount VPFI amount in 18 decimals (non-zero).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function mintVPFI(
        address to,
        uint256 amount
    ) external nonReentrant whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Canonical-chain gate: only the Base (mainnet) / Base Sepolia
        // (testnet) Diamond can mint. On every other chain in the mesh
        // supply arrives exclusively via the Chainlink CCIP CCT (Cross-Chain Token) peer bridge
        // from the canonical adapter, so minting locally would break the
        // 230M global-cap invariant.
        if (!s.isCanonicalVpfiChain) revert NotCanonicalVPFIChain();

        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();

        address token = s.vpfiToken;
        if (token == address(0)) revert VPFITokenNotRegistered();

        IVPFIToken(token).mint(to, amount);

        emit VPFIMinted(to, amount);
    }

    /**
     * @notice Convert one accumulated treasury asset into the governance-
     *         configured target allocation.
     * @dev T-600. Legal-safe path: protocol-internal asset management —
     *      every output stays inside the Diamond (`recipient =
     *      address(this)`), credited back into `treasuryBalances`. There
     *      is NO insider beneficiary and NO per-tx auto-route; subsequent
     *      distribution (buyback / staker boost / budget) is a separate
     *      governance action.
     *
     *      Requires Diamond-as-treasury mode — `treasuryBalances` only
     *      tracks convertible funds when `s.treasury == address(this)`.
     *
     *      The target allocation is the fully governance-configurable
     *      `s.treasuryConvertTargets` list (`ConfigFacet.setTreasuryConvertTargets`)
     *      — an ordered set of `(asset, bps)` entries summing to 10000.
     *      The input balance is split pro-rata; the FINAL entry absorbs
     *      integer-division rounding. `perTargetCalls[i]` / `minOuts[i]`
     *      align with target `i`, so both arrays must have exactly the
     *      configured target count.
     *
     *      One `tokenIn` per call (a keeper loops off-chain): each call
     *      is atomic and independently auditable. Each leg routes through
     *      `LibSwap.swapWithFailover` — the same ranked-adapter try-list
     *      machinery `RiskFacet.triggerLiquidation` uses — with the
     *      sentinel `loanId = 0` (loan ids are 1-based) marking a
     *      treasury conversion in the swap-event stream. A leg whose
     *      target equals `tokenIn` is credited straight back (no
     *      self-swap).
     *
     * @param tokenIn The treasury asset to convert (non-zero, non-empty balance).
     * @param perTargetCalls Ranked adapter try-list per configured target.
     * @param minOuts Slippage floor per configured target.
     */
    function convertTreasuryAsset(
        address tokenIn,
        LibSwap.AdapterCall[][] calldata perTargetCalls,
        uint256[] calldata minOuts
    ) external nonReentrant whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Diamond-as-treasury precondition.
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        if (tokenIn == address(0)) revert InvalidAddress();
        // Codex Sub 3.A round-1 P2 — the no-convert flag must also
        // block the treasury-convert path; otherwise an admin or
        // keeper could rotate a protected asset (e.g., ETH from
        // `buyVPFIWithETH`) out of its native form via convert even
        // though `remitBuyback` blocks it. The flag covers BOTH
        // outbound paths uniformly.
        if (s.buybackNoConvert[tokenIn]) revert BuybackTokenNoConvert(tokenIn);

        uint256 balance = s.treasuryBalances[tokenIn];
        if (balance == 0) revert ZeroAmount();

        // Eligibility: USD-value OR max-interval, whichever first.
        if (!_eligibleForConversion(tokenIn, balance)) {
            revert ConversionNotEligible();
        }

        uint256 n = s.treasuryConvertTargets.length;
        if (n == 0) revert TreasuryConvertNoTargets();
        if (perTargetCalls.length != n) {
            revert TreasuryConvertArityMismatch(perTargetCalls.length, n);
        }
        if (minOuts.length != n) {
            revert TreasuryConvertArityMismatch(minOuts.length, n);
        }

        // CEI — zero the input balance and stamp the conversion time
        // before any external swap call.
        s.treasuryBalances[tokenIn] = 0;
        s.treasuryLastConversionAt = uint64(block.timestamp);

        // Split pro-rata; the final target absorbs the rounding dust so
        // the legs always sum back to exactly `balance`.
        uint256 allocated;
        for (uint256 i = 0; i < n; ++i) {
            LibVaipakam.TreasuryConvertTarget storage t = s.treasuryConvertTargets[i];
            uint256 amount = (i == n - 1)
                ? balance - allocated
                : (balance * t.bps) / LibVaipakam.BASIS_POINTS;
            allocated += amount;
            _convertLeg(tokenIn, t.asset, amount, minOuts[i], perTargetCalls[i], s);
        }

        emit TreasuryConverted(tokenIn, balance, n);
    }

    /// @dev Settle one conversion leg. `tokenIn == tokenOut` short-circuits
    ///      (the slice already IS the target — credit it straight back, no
    ///      self-swap). Otherwise routes through `LibSwap.swapWithFailover`;
    ///      a soft-failure across every adapter reverts the WHOLE call so
    ///      the zeroed input balance is rolled back — funds are never lost.
    function _convertLeg(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        LibSwap.AdapterCall[] calldata calls,
        LibVaipakam.Storage storage s
    ) private {
        if (amountIn == 0) return;
        if (tokenIn == tokenOut) {
            s.treasuryBalances[tokenOut] += amountIn;
            return;
        }
        (bool ok, uint256 outAmount, ) = LibSwap.swapWithFailover(
            0, // loanId sentinel — 0 marks a treasury conversion
            tokenIn,
            tokenOut,
            amountIn,
            minOut,
            address(this),
            calls
        );
        if (!ok) revert TreasuryConvertSwapFailed(tokenOut);
        s.treasuryBalances[tokenOut] += outAmount;
    }

    /// @dev Conversion eligibility — true when EITHER the time since the
    ///      last conversion has exceeded the configured max interval, OR
    ///      the input balance's numeraire value clears the configured
    ///      threshold. The numeraire leg is best-effort: an oracle that
    ///      reverts / has no feed leaves only the time leg in force
    ///      (mirrors `LibFacet.accrueTreasuryFee`'s best-effort pricing).
    function _eligibleForConversion(address tokenIn, uint256 balance)
        private
        view
        returns (bool)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 maxInterval =
            LibVaipakam.cfgTreasuryConvertMaxIntervalDays() * 1 days;
        // Never-converted (`treasuryLastConversionAt == 0`) ⇒ the time
        // leg is trivially satisfied — the first conversion is allowed.
        if (block.timestamp - s.treasuryLastConversionAt >= maxInterval) {
            return true;
        }
        (bool ok, uint256 price, uint8 feedDec) =
            OracleFacet(address(this)).tryGetAssetPrice(tokenIn);
        if (!ok || price == 0) return false;
        uint8 tokenDec = IERC20Metadata(tokenIn).decimals();
        uint256 numeraireValue =
            (balance * price * 1e18) / (10 ** feedDec) / (10 ** tokenDec);
        return numeraireValue >= LibVaipakam.cfgTreasuryConvertUsdThreshold();
    }

    // ─── T-087 Sub 3.A — buyback remittance ──────────────────────────

    /**
     * @notice Send accumulated buyback budget cross-chain to the
     *         Base-side `BuybackRemittanceReceiver`. Each remittance
     *         is one (token, amount) per CCIP message; the agent /
     *         operator schedules these calls when `buybackBudget[token]`
     *         crosses an off-chain threshold.
     *
     * @dev ADMIN-gated. Debits the budget BEFORE the cross-chain send
     *      (CEI). Approves the CcipMessenger for `amount` of `token`,
     *      then calls `sendMessage` with a 1-element TokenAmount list
     *      and a 32-byte payload carrying the declared token address
     *      for cross-validation on the Base receiver.
     *
     *      The Diamond IS the registered channel handler on the buyback
     *      channel for this chain (`channelOf[address(this)] ==
     *      VPFI_BUYBACK_CHANNEL` on the CcipMessenger). The messenger
     *      uses `channelOf[msg.sender]` to route, so the Diamond is the
     *      authoritative source-sender — the Base-side
     *      `channelPeerOf[VPFI_BUYBACK_CHANNEL][thisChainId]` must
     *      point at this Diamond for the inbound to authenticate.
     *
     *      Reverts:
     *        - `BuybackTokenNoConvert` if `token` is on the no-convert
     *          list (e.g., ETH from `buyVPFIWithETH` stays in
     *          operational reserve + LP — never crosses chains).
     *        - `BuybackTokenNotAllowed(chainId, token)` if the token
     *          is not on this chain's allow-list.
     *        - `InsufficientBuybackBudget` if `amount` exceeds the
     *          tracked budget.
     *        - `CrossChainMessengerNotSet` if the port isn't wired.
     *
     * @param token         Source-chain ERC20 to remit. MUST be the
     *                      same address (or canonical mirror) the Base
     *                      receiver knows for this asset.
     * @param amount        Amount in the token's own decimals.
     * @param refundAddress `msg.value` surplus refund target. The CCIP
     *                      fee is forwarded exactly; remainder returns.
     * @return messageId The opaque CCIP message id.
     */
    /// @param srcToken  Source-chain ERC20 to remit. Debited from
    ///                  `s.buybackBudget[srcToken]` + approved to the
    ///                  messenger for pull.
    /// @param destToken Base-chain ERC20 the CCIP pool will deliver.
    ///                  Encoded in the payload so the receiver's
    ///                  `TokenMismatch` gate compares against the
    ///                  destination-side address (Codex Sub 3.A
    ///                  round-1 P1 #2). For mirror USDC → Base USDC,
    ///                  these are different ERC20 addresses; CCIP's
    ///                  token-pool mapping does the cross-chain swap.
    function remitBuyback(
        address srcToken,
        address destToken,
        uint256 amount,
        address payable refundAddress
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (srcToken == address(0) || destToken == address(0)) {
            revert InvalidAddress();
        }
        if (amount == 0) revert ZeroAmount();
        if (s.buybackNoConvert[srcToken]) revert BuybackTokenNoConvert(srcToken);

        uint256 chainId = block.chainid;
        if (!s.buybackAllowedToken[chainId][srcToken]) {
            revert BuybackTokenNotAllowed(chainId, srcToken);
        }
        // Codex round-6 P2 #1 — destToken must match the admin-
        // pinned mapping. A typo would otherwise let the source
        // CCIP send debit + succeed, then the Base receiver revert
        // `TokenMismatch` → funds stuck mid-bridge.
        address expectedDest = s.buybackDestToken[srcToken];
        if (expectedDest == address(0) || expectedDest != destToken) {
            revert BuybackDestTokenMismatch(srcToken, expectedDest, destToken);
        }

        // Config gates fire BEFORE accounting gates so a
        // misconfiguration surfaces with a clear error rather than
        // being masked by a coincidentally-zero budget.
        address messenger = s.crossChainMessenger;
        if (messenger == address(0)) revert CrossChainMessengerNotSet();
        // Codex Sub 3.A round-2 P2 #1 — reject zero refund address
        // upfront. A typo'd `address(0)` would otherwise let surplus
        // `msg.value - fee` get burned in the `.call` at the end.
        if (refundAddress == address(0)) revert TreasuryZeroAddress();

        uint256 budget = s.buybackBudget[srcToken];
        if (amount > budget) revert InsufficientBuybackBudget(amount, budget);

        // Debit FIRST (CEI). The cross-chain send is the post-debit
        // external interaction; if CcipMessenger reverts, the whole
        // tx rolls back and the budget is preserved.
        s.buybackBudget[srcToken] = budget - amount;

        // Approve the messenger for the exact amount. The messenger
        // (NOT the router; round-5 P1 #4) is the contract the
        // Diamond's tokens flow through; `forceApprove` re-sets the
        // allowance to exactly `amount` to handle non-standard ERC20s
        // (USDT) and any leftover from a prior partial pull.
        IERC20(srcToken).forceApprove(messenger, amount);

        // Build the payload: DESTINATION token address for cross-
        // validation on the receiver (Codex Sub 3.A round-1 P1 #2).
        // Source chain id is already in the CCIP header.
        bytes memory payload = abi.encode(destToken);

        // Token transfer list: exactly one entry. CCIP's pool maps
        // `srcToken` → `destToken` on Base; the receiver gets the
        // destination-side address in `tokens[0].token`.
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({
            token: srcToken,
            amount: amount
        });

        // Quote the fee + forward exactly that much; surplus refunds.
        // The CcipMessenger reads `channelOf[address(this)]` to pick
        // the channel — this Diamond must be registered as the
        // buyback channel handler.
        uint256 fee = ICrossChainMessenger(messenger).quoteMessageFee(
            s.baseChainId, payload, tokens, BUYBACK_DEST_GAS_LIMIT
        );
        if (msg.value < fee) revert InsufficientBuybackBudget(fee, msg.value);

        messageId = ICrossChainMessenger(messenger).sendMessage{value: fee}(
            s.baseChainId, payload, tokens, BUYBACK_DEST_GAS_LIMIT
        );

        if (msg.value > fee) {
            (bool ok,) = refundAddress.call{value: msg.value - fee}("");
            if (!ok) revert TreasuryZeroAddress(); // refund failure
        }

        emit BuybackRemitted(messageId, srcToken, amount, s.baseChainId);
    }

    /**
     * @notice Base-side ingress for the buyback remittance. Called by
     *         the registered `BuybackRemittanceReceiver` AFTER the
     *         receiver has validated the inbound delivery + forwarded
     *         the tokens to this Diamond. This function only updates
     *         the consolidated `buybackBudget` accounting.
     * @dev    Sender check: only the registered receiver can call.
     *         The receiver's `onCrossChainMessage` is in turn gated to
     *         the CcipMessenger; so this is a 3-stage trust chain.
     */
    function absorbRemittance(
        address token,
        uint256 amount,
        uint256 sourceChainId
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.buybackRemittanceReceiver) {
            revert OnlyBuybackRemittanceReceiver(msg.sender);
        }
        // Codex Sub 3.A round-1 P1 #1 — credit the Base-side
        // consolidated budget that Sub 3.B's `commitBuybackIntent`
        // spends from, NOT the per-chain `buybackBudget` accumulator
        // (which only tracks the LOCAL fee revenue waiting for
        // remittance). The two slots are intentionally separate;
        // crediting the wrong one would mean delivered tokens reach
        // the Diamond but the future Fusion commit can't see them.
        s.baseBuybackBudget[token] += amount;
        emit BuybackRemittanceAbsorbed(token, amount, sourceChainId);
    }

    /**
     * @notice Codex Sub 3.A round-2 P1 #2 — admin moves accumulated
     *         fee revenue from `s.treasuryBalances[token]` into
     *         `s.buybackBudget[token]`. Without this hook the
     *         per-chain buyback budget would never get populated and
     *         `remitBuyback` would always hit
     *         `InsufficientBuybackBudget`.
     * @dev    For Sub 3.A scope this is a MANUAL admin call: the
     *         operator decides what portion of accumulated fees
     *         becomes "for buyback" vs "for treasury direct claim".
     *         A fully-automated split at fee-accrual time is tracked
     *         as a Sub 3 add-on (the priority router card #472 is
     *         the Base-side analogue; this per-chain allocator is a
     *         separate follow-up).
     *
     *         Reverts:
     *           - `BuybackTokenNoConvert` if the token is on the
     *             no-convert list (the same flag protects this path
     *             since "no convert" implies "no buyback either").
     *           - `InsufficientBuybackBudget` if the diamond's
     *             `treasuryBalances[token]` cannot cover the
     *             requested allocation.
     */
    function creditBuybackBudget(address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.buybackNoConvert[token]) revert BuybackTokenNoConvert(token);

        // Codex Sub 3.A round-5 P2 #2 — mirror-side credit must pass
        // the buyback allow-list check before any accounting moves;
        // otherwise an admin could credit a token that isn't
        // bridgeable, draining treasury and stranding the funds in
        // `buybackBudget` because the follow-up `remitBuyback` would
        // always revert `BuybackTokenNotAllowed`. On Base
        // (`isCanonicalRewardChain`), no allow-list gate applies —
        // the credit goes straight to `baseBuybackBudget` which
        // never crosses a bridge.
        if (
            !s.isCanonicalRewardChain
                && !s.buybackAllowedToken[block.chainid][token]
        ) {
            revert BuybackTokenNotAllowed(block.chainid, token);
        }

        uint256 treasuryBal = s.treasuryBalances[token];
        if (amount > treasuryBal) {
            revert InsufficientBuybackBudget(amount, treasuryBal);
        }
        s.treasuryBalances[token] = treasuryBal - amount;
        // Codex Sub 3.A round-3 P2 #1 — on Base (canonical reward
        // chain), local fee revenue doesn't need to cross any
        // bridge; credit `baseBuybackBudget` directly so the future
        // Sub 3.B `commitBuybackIntent` can spend it. On mirrors,
        // credit the per-chain accumulator that `remitBuyback` will
        // later ship to Base.
        if (s.isCanonicalRewardChain) {
            s.baseBuybackBudget[token] += amount;
        } else {
            s.buybackBudget[token] += amount;
        }
        emit BuybackBudgetCredited(token, amount);
    }

    // ─── T-087 Sub 3.A — admin setters ───────────────────────────────

    function setBuybackAllowedToken(
        uint256 chainId,
        address token,
        bool allowed
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (token == address(0)) revert InvalidAddress();
        LibVaipakam.storageSlot().buybackAllowedToken[chainId][token] = allowed;
        emit BuybackAllowedTokenSet(chainId, token, allowed);
    }

    function setBuybackNoConvert(address token, bool on)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (token == address(0)) revert InvalidAddress();
        LibVaipakam.storageSlot().buybackNoConvert[token] = on;
        emit BuybackNoConvertSet(token, on);
    }

    /// @notice Codex Sub 3.A round-6 P2 #1 — pin the destination-
    ///         chain token address that this chain's `srcToken`
    ///         remits to. `remitBuyback` enforces this mapping at
    ///         call time so an admin typo on the operator-supplied
    ///         `destToken` cannot strand funds mid-bridge. Pass
    ///         `address(0)` to clear the pinning (which then makes
    ///         every future `remitBuyback(srcToken, ...)` revert
    ///         `BuybackDestTokenMismatch`).
    function setBuybackDestToken(address srcToken, address destToken)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (srcToken == address(0)) revert InvalidAddress();
        LibVaipakam.storageSlot().buybackDestToken[srcToken] = destToken;
        emit BuybackDestTokenSet(srcToken, destToken);
    }

    function setBuybackRemittanceReceiver(address newReceiver)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (newReceiver == address(0)) revert TreasuryZeroAddress();
        // Codex Sub 3.A round-3 P2 #2 — receiver MUST be a contract.
        // An EOA in this slot would let that EOA call
        // `absorbRemittance` directly + inflate `baseBuybackBudget`
        // without any real CCIP delivery, since the only sender
        // check on `absorbRemittance` is the equality with this slot.
        if (newReceiver.code.length == 0) revert TreasuryZeroAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        emit BuybackRemittanceReceiverSet(
            s.buybackRemittanceReceiver, newReceiver
        );
        s.buybackRemittanceReceiver = newReceiver;
    }

    function setCrossChainMessenger(address newMessenger)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (newMessenger == address(0)) revert TreasuryZeroAddress();
        // Codex Sub 3.A round-3 P2 #2 — messenger MUST be a contract.
        // The `remitBuyback` call routes tokens through this address;
        // an EOA would silently fail every send (no `sendMessage` on
        // it) at runtime instead of at config time.
        if (newMessenger.code.length == 0) revert TreasuryZeroAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        emit CrossChainMessengerSet(s.crossChainMessenger, newMessenger);
        s.crossChainMessenger = newMessenger;
    }

    // ─── T-087 Sub 3.A — public reads ────────────────────────────────

    function getBuybackBudget(address token) external view returns (uint256) {
        return LibVaipakam.storageSlot().buybackBudget[token];
    }

    /// @notice T-087 Sub 3.A round-1 P1 #1 — read the Base-side
    ///         consolidated buyback budget that `absorbRemittance`
    ///         credits and Sub 3.B's `commitBuybackIntent` will spend
    ///         from. Separate from the per-chain `buybackBudget`
    ///         accumulator that tracks LOCAL fee revenue awaiting
    ///         remittance. Reads `0` on mirrors (which never hold
    ///         consolidated Base-side budget) — that's by design.
    function getBaseBuybackBudget(address token) external view returns (uint256) {
        return LibVaipakam.storageSlot().baseBuybackBudget[token];
    }

    function isBuybackAllowedToken(uint256 chainId, address token)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().buybackAllowedToken[chainId][token];
    }

    function isBuybackNoConvert(address token) external view returns (bool) {
        return LibVaipakam.storageSlot().buybackNoConvert[token];
    }

    function getBuybackDestToken(address srcToken)
        external
        view
        returns (address)
    {
        return LibVaipakam.storageSlot().buybackDestToken[srcToken];
    }

    function getCrossChainMessenger() external view returns (address) {
        return LibVaipakam.storageSlot().crossChainMessenger;
    }

    function getBuybackRemittanceReceiver() external view returns (address) {
        return LibVaipakam.storageSlot().buybackRemittanceReceiver;
    }

    // ─── T-087 Sub 3.B — buyback intent ledger ───────────────────────

    /**
     * @notice Commit a new BUYBACK intent against a Fusion order
     *         hash. Reserves `amountIn` of `token` out of
     *         `baseBuybackBudget` into `baseBuybackReserved`,
     *         records the ledger entry, and stamps the order kind
     *         so `IntentDispatchFacet.postInteraction` routes the
     *         fill into `LibTreasuryBuyback.onFill`.
     * @dev    ADMIN-gated. `orderHash` is computed off-chain by the
     *         operator from the Fusion order template + LOP domain
     *         separator; the contract trusts the caller to provide
     *         the exact value the Fusion solver will fill against.
     *         Sub 3.C will wire the off-chain computation; for Sub
     *         3.B the operator passes it manually.
     */
    function commitBuybackIntent(
        bytes32 orderHash,
        address token,
        uint256 amountIn,
        uint256 minVpfiOut,
        uint256 expiresAt
    )
        external
        nonReentrant
        whenNotPaused
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibTreasuryBuyback.commitBuyback(
            orderHash, token, amountIn, minVpfiOut, expiresAt
        );
    }

    /// @notice T-087 Sub 3.B round-3 P2 — set / clear the per-token
    ///         raw-amount tranche cap. `commitBuyback` rejects an
    ///         `amountIn` larger than the cap. Pass `0` to disable
    ///         the cap for the token.
    function setBuybackMaxTranche(address token, uint256 cap)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (token == address(0)) revert InvalidAddress();
        LibVaipakam.storageSlot().cfgBuybackMaxTranche[token] = cap;
        emit BuybackMaxTrancheSet(token, cap);
    }

    function getBuybackMaxTranche(address token)
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().cfgBuybackMaxTranche[token];
    }

    /// @notice Permissionless rollback for an expired buyback intent.
    /// @dev    Releases the reservation back to `baseBuybackBudget`,
    ///         marks the order `Expired`, and clears the kind
    ///         discriminator. Reverts if the order is still active
    ///         (use `expiresAt` < `block.timestamp` to gate).
    function expireBuybackIntent(bytes32 orderHash)
        external
        nonReentrant
        whenNotPaused
    {
        LibTreasuryBuyback.expireBuyback(orderHash);
    }

    function getBuybackOrder(bytes32 orderHash)
        external
        view
        returns (LibVaipakam.BuybackOrderInfo memory)
    {
        return LibVaipakam.storageSlot().buybackOrders[orderHash];
    }

    function getOrderHashKind(bytes32 orderHash)
        external
        view
        returns (bytes32)
    {
        return LibVaipakam.storageSlot().orderHashKind[orderHash];
    }

    /// @notice T-087 Sub 3.B — current staking-pool buyback budget.
    ///         `LibTreasuryBuyback.onFill` credits this slot with the
    ///         delivered VPFI on every BUYBACK postInteraction; the
    ///         staking distributor (Sub 3 add-on #472 will widen the
    ///         claim cap from this slot) reads it as the spendable
    ///         budget.
    function getStakingPoolBuybackBudget() external view returns (uint256) {
        return LibVaipakam.storageSlot().stakingPoolBuybackBudget;
    }

    // ─── T-087 Sub 3.C — validated buyback commit ────────────────────

    /// @dev Default TWAP window upper bound (seconds). Effective when
    ///      `s.cfgBuybackTwapMaxWindowSec` reads 0.
    uint32 internal constant DEFAULT_BUYBACK_TWAP_WINDOW_SEC = 1800;
    /// @dev Lower bound enforced by `setBuybackTwapMaxWindowSec`.
    uint32 internal constant MIN_BUYBACK_TWAP_WINDOW_SEC = 600;
    /// @dev Upper bound enforced by `setBuybackTwapMaxWindowSec`.
    uint32 internal constant MAX_BUYBACK_TWAP_WINDOW_SEC = 3600;

    error BuybackTwapWindowOutOfBounds(uint256 windowSec, uint256 maxAllowed);
    /// @custom:event-category informational/config
    event BuybackTwapMaxWindowSecSet(uint32 windowSec);

    /**
     * @notice Commit a buyback intent against a fully validated
     *         Fusion order template. The diamond recomputes the LOP
     *         v4 orderHash on-chain (EIP-712), validates every field
     *         against the canonical buyback shape, marks the order
     *         "validated", and reserves the source token through
     *         `LibTreasuryBuyback.commitBuyback`.
     *         `IntentDispatchFacet.isValidSignature` returns the
     *         ERC-1271 magic value ONLY for validated orderHashes.
     */
    function commitBuybackIntentValidated(
        bytes32 orderHash,
        LibBuybackOrderValidation.BuybackOrderTemplate calldata tpl,
        uint256 amountIn,
        uint256 minVpfiOut,
        uint64 expiresAt
    )
        external
        nonReentrant
        whenNotPaused
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // ── 0. Codex Sub 3.C round-2 P2 #2 — minVpfiOut > 0.
        //    1inch LOP rejects fills where the computed taking
        //    amount is zero, so a minVpfiOut == 0 order would have
        //    its source tokens reserved on-chain but never settle.
        //    Force a positive floor to prevent the stranded-budget
        //    failure mode.
        if (minVpfiOut == 0) {
            revert LibTreasuryBuyback.BuybackZeroAmount();
        }

        // ── 1. TWAP window bound ────────────────────────────────────
        uint32 maxWindow = s.cfgBuybackTwapMaxWindowSec == 0
            ? DEFAULT_BUYBACK_TWAP_WINDOW_SEC
            : s.cfgBuybackTwapMaxWindowSec;
        // Codex Sub 3.C round-3 P3 — guard the subtraction so the
        // "expiry-in-past" branch reverts with the documented
        // BuybackTwapWindowOutOfBounds error instead of a generic
        // 0.8 arithmetic panic from uint underflow.
        if (expiresAt <= block.timestamp) {
            revert BuybackTwapWindowOutOfBounds(0, uint256(maxWindow));
        }
        uint256 window = uint256(expiresAt) - block.timestamp;
        if (window > uint256(maxWindow)) {
            revert BuybackTwapWindowOutOfBounds(window, uint256(maxWindow));
        }

        // ── 2. Recompute orderHash on-chain + field validation ──────
        bytes32 lopDomainSeparator = _fetchLopDomainSeparator(
            s.cfgFusionLimitOrderProtocol
        );
        LibBuybackOrderValidation.validateBuybackOrder(
            orderHash,
            tpl,
            address(this),     // expected maker = receiver = diamond
            tpl.makerAsset,    // expected makerAsset
            s.vpfiToken,       // expected takerAsset = VPFI
            amountIn,
            minVpfiOut,
            expiresAt,
            lopDomainSeparator
        );

        // ── 3. Reserve + record ledger entry ───────────────────────
        LibTreasuryBuyback.commitBuyback(
            orderHash, tpl.makerAsset, amountIn, minVpfiOut, uint256(expiresAt)
        );

        // ── 4. Mark validated so isValidSignature returns magic ─────
        LibTreasuryBuyback.markValidated(orderHash);
    }

    /// @notice T-087 Sub 3.C — exposed canonical extension bytes the
    ///         off-chain agent must use when constructing the Fusion
    ///         order template. Mirrors the swap-to-repay
    ///         `canonicalExtension()` view.
    function canonicalBuybackExtension() external view returns (bytes memory) {
        return LibBuybackOrderValidation.canonicalBuybackExtension(address(this));
    }

    /// @notice T-087 Sub 3.C — admin: set the TWAP window upper
    ///         bound (seconds). 0 means "use the default 1800".
    ///         Bounded to MIN..MAX.
    function setBuybackTwapMaxWindowSec(uint32 windowSec)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (windowSec != 0 && (
            windowSec < MIN_BUYBACK_TWAP_WINDOW_SEC
                || windowSec > MAX_BUYBACK_TWAP_WINDOW_SEC
        )) {
            revert BuybackTwapWindowOutOfBounds(
                uint256(windowSec), uint256(MAX_BUYBACK_TWAP_WINDOW_SEC)
            );
        }
        LibVaipakam.storageSlot().cfgBuybackTwapMaxWindowSec = windowSec;
        emit BuybackTwapMaxWindowSecSet(windowSec);
    }

    function getBuybackTwapMaxWindowSec() external view returns (uint32) {
        uint32 v = LibVaipakam.storageSlot().cfgBuybackTwapMaxWindowSec;
        return v == 0 ? DEFAULT_BUYBACK_TWAP_WINDOW_SEC : v;
    }

    function isBuybackValidated(bytes32 orderHash) external view returns (bool) {
        return LibVaipakam.storageSlot().buybackValidated[orderHash];
    }

    function getBuybackConsumedSoFar(bytes32 orderHash)
        external
        view
        returns (uint128)
    {
        return LibVaipakam.storageSlot().buybackConsumedSoFar[orderHash];
    }

    /// @dev Fetch the LOP's EIP-712 DOMAIN_SEPARATOR via staticcall.
    function _fetchLopDomainSeparator(address lop) private view returns (bytes32) {
        (bool ok, bytes memory ret) = lop.staticcall(
            abi.encodeWithSignature("DOMAIN_SEPARATOR()")
        );
        require(ok && ret.length == 32, "lop ds");
        return abi.decode(ret, (bytes32));
    }

    // ─── T-087 Sub 3 add-on #472 — priority router config ────────────

    /// @custom:event-category informational/config
    event RewardEmissionsTopUpTargetSet(uint256 target);
    /// @custom:event-category informational/config
    event KeeperRewardTopUpTargetSet(uint256 target);

    /// @notice Admin: top-up target for the reward emissions budget.
    ///         Buyback proceeds cascade up to this floor first; the
    ///         excess flows to keepers + staking. Pass `0` to disable
    ///         the reward step entirely (cascade skips straight to
    ///         keepers).
    function setRewardEmissionsTopUpTarget(uint256 target)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().cfgRewardEmissionsTopUpTarget = target;
        emit RewardEmissionsTopUpTargetSet(target);
    }

    function getRewardEmissionsTopUpTarget() external view returns (uint256) {
        return LibVaipakam.storageSlot().cfgRewardEmissionsTopUpTarget;
    }

    function getRewardEmissionsBudget() external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardEmissionsBudget;
    }

    /// @notice Admin: top-up target for the keeper reward budget.
    ///         Second step of the priority cascade. Pass `0` to
    ///         disable the keeper step entirely.
    function setKeeperRewardTopUpTarget(uint256 target)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().cfgKeeperRewardTopUpTarget = target;
        emit KeeperRewardTopUpTargetSet(target);
    }

    function getKeeperRewardTopUpTarget() external view returns (uint256) {
        return LibVaipakam.storageSlot().cfgKeeperRewardTopUpTarget;
    }

    function getKeeperRewardBudget() external view returns (uint256) {
        return LibVaipakam.storageSlot().keeperRewardBudget;
    }

    // ─── T-087 Sub 3 add-on #473 — productive treasury reserve ──────

    error TreasuryYieldBpsOutOfBounds(uint16 bps, uint16 maxAllowed);
    error TreasuryYieldVenueInvalid(uint8 venue);
    error TreasuryYieldVenueAddressNotContract(address candidate);

    /// @custom:event-category informational/config
    event TreasuryYieldVenueSet(address indexed token, uint8 venue);
    /// @custom:event-category informational/config
    event TreasuryExternalYieldMaxBpsSet(uint16 bps);
    /// @custom:event-category informational/config
    event AaveV3PoolSet(address indexed pool);
    /// @custom:event-category informational/config
    event LidoStakingSet(address indexed staking);

    /// @notice Admin: per-token venue config. Pass venue:
    ///   0 (NONE) — disable external yield for this token,
    ///   1 (AAVE_V3) — supply via Aave V3,
    ///   2 (LIDO_STETH) — stake via Lido.
    function setTreasuryYieldVenue(address token, uint8 venue)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (token == address(0)) revert InvalidAddress();
        if (venue > LibVaipakam.TREASURY_YIELD_VENUE_LIDO_STETH) {
            revert TreasuryYieldVenueInvalid(venue);
        }
        LibVaipakam.storageSlot().cfgTreasuryYieldVenue[token] = venue;
        emit TreasuryYieldVenueSet(token, venue);
    }

    /// @notice Admin: ceiling on externally-deployed share per
    ///         token. 0 means "use the default 7000 bps". Hard upper
    ///         bound 8000 bps.
    function setTreasuryExternalYieldMaxBps(uint16 bps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (bps > LibTreasuryYield.MAX_EXTERNAL_YIELD_BPS) {
            revert TreasuryYieldBpsOutOfBounds(
                bps, LibTreasuryYield.MAX_EXTERNAL_YIELD_BPS
            );
        }
        LibVaipakam.storageSlot().cfgTreasuryExternalYieldMaxBps = bps;
        emit TreasuryExternalYieldMaxBpsSet(bps);
    }

    function setAaveV3Pool(address pool)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (pool == address(0)) revert InvalidAddress();
        if (pool.code.length == 0) revert TreasuryYieldVenueAddressNotContract(pool);
        LibVaipakam.storageSlot().cfgAaveV3Pool = pool;
        emit AaveV3PoolSet(pool);
    }

    function setLidoStaking(address staking)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (staking == address(0)) revert InvalidAddress();
        if (staking.code.length == 0) revert TreasuryYieldVenueAddressNotContract(staking);
        LibVaipakam.storageSlot().cfgLidoStaking = staking;
        emit LidoStakingSet(staking);
    }

    /// @notice Admin: deploy `amount` of `token` from the diamond's
    ///         treasury balance to the configured venue.
    function deployTreasuryYield(address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        LibTreasuryYield.deployTreasuryYield(token, amount);
    }

    /// @notice Admin: pull `amount` of `token` back from the
    ///         external venue to the diamond.
    function withdrawTreasuryYield(address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        LibTreasuryYield.withdrawTreasuryYield(token, amount);
    }

    function getTreasuryYieldVenue(address token) external view returns (uint8) {
        return LibVaipakam.storageSlot().cfgTreasuryYieldVenue[token];
    }

    function getTreasuryDeployedExternal(address token) external view returns (uint256) {
        return LibVaipakam.storageSlot().treasuryDeployedExternal[token];
    }

    function getTreasuryExternalYieldMaxBps() external view returns (uint16) {
        uint16 v = LibVaipakam.storageSlot().cfgTreasuryExternalYieldMaxBps;
        return v == 0 ? LibTreasuryYield.DEFAULT_EXTERNAL_YIELD_MAX_BPS : v;
    }

    function getAaveV3Pool() external view returns (address) {
        return LibVaipakam.storageSlot().cfgAaveV3Pool;
    }

    function getLidoStaking() external view returns (address) {
        return LibVaipakam.storageSlot().cfgLidoStaking;
    }
}
