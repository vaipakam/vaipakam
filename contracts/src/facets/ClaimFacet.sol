// src/facets/ClaimFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskMatchLiquidationFacet} from "./RiskMatchLiquidationFacet.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/**
 * @title ClaimFacet
 * @author Vaipakam Developer Team
 * @notice This facet implements the claim-based fund distribution model for the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Uses shared LibVaipakam storage.
 *      After a loan is resolved (Repaid, Defaulted), funds are held in vault as "claimable".
 *      Lenders present their Vaipakam NFT to claim their principal + interest (or rental fees on default).
 *      Borrowers present their Vaipakam NFT to claim their collateral (or refund on rental repay).
 *      NFTs are burned only after the respective party successfully claims.
 *      Once both parties claim (or one party has nothing to claim), the loan status is set to Settled.
 *      Treasury fees are transferred immediately at resolution time and do not go through this facet.
 *      Custom errors, ReentrancyGuard, Pausable. Cross-facet calls for vault and NFT operations.
 *      Expand for Phase 2 (e.g., partial claims, time-locked claims, NFT-based access control delegation).
 */
contract ClaimFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when a lender claims their funds.
    /// @param loanId The resolved loan ID.
    /// @param claimant The address claiming the funds (must own the lender NFT).
    /// @param asset The token address claimed.
    /// @param amount The amount claimed.
    /// @param newBothClaimed True iff the borrower side has ALSO already
    ///        claimed (or had nothing to claim) — when true the loan is
    ///        about to settle and the position NFTs are about to burn.
    ///        EventSourcingAudit §3.11 — lets cache-merge consumers update
    ///        the row's terminal-status and NFT-burn-imminent state from
    ///        this single event.
    /// @custom:event-category state-change/claim-mutation
    event LenderFundsClaimed(
        uint256 indexed loanId,
        address indexed claimant,
        address asset,
        uint256 amount,
        bool newBothClaimed
    );

    /// @notice Emitted when a borrower claims their collateral or refund.
    /// @param loanId The resolved loan ID.
    /// @param claimant The address claiming the funds (must own the borrower NFT).
    /// @param asset The token address claimed.
    /// @param amount The amount claimed.
    /// @param newBothClaimed True iff the lender side has ALSO already
    ///        claimed — see {LenderFundsClaimed} for semantics.
    /// @custom:event-category state-change/claim-mutation
    event BorrowerFundsClaimed(
        uint256 indexed loanId,
        address indexed claimant,
        address asset,
        uint256 amount,
        bool newBothClaimed
    );

    /// @notice Emitted when both parties have claimed and the loan is fully settled.
    /// @param loanId The now-settled loan ID.
    /// @custom:event-category state-change/loan-mutation
    event LoanSettled(uint256 indexed loanId);

    /// @notice Emitted when a claim-time liquidation retry runs.
    /// @param loanId The loan under claim.
    /// @param succeeded True if the retry swap cleared the 6% slippage gate.
    /// @param proceeds Principal-asset proceeds received on success, 0 on failure.
    /// @custom:event-category informational/claim
    event ClaimRetryExecuted(
        uint256 indexed loanId,
        bool succeeded,
        uint256 proceeds
    );

    /// @notice Emitted when a borrower claims their Phase 5 LIF VPFI rebate.
    /// @param loanId The loan whose rebate was credited at proper settlement.
    /// @param claimant The address receiving the VPFI (borrower NFT holder).
    /// @param amount VPFI wei transferred.
    /// @param newVaultVpfiBalance Borrower's post-claim VPFI vault balance
    ///        (sum of any prior staked / discount-tier balance plus this
    ///        rebate). EventSourcingAudit §3.20 — frontend updates the
    ///        "VPFI balance is now X" UI directly from the event.
    /// @custom:event-category state-change/reward-claim
    event BorrowerLifRebateClaimed(
        uint256 indexed loanId,
        address indexed claimant,
        uint256 amount,
        uint256 newVaultVpfiBalance
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    // NotNFTOwner inherited from IVaipakamErrors
    /// @notice Funds for this loan side have already been claimed.
    error AlreadyClaimed();
    /// @notice Nothing is claimable for this loan side.
    error NothingToClaim();
    // InvalidLoanStatus and CrossFacetCallFailed inherited from IVaipakamErrors

    // ─── External Functions ───────────────────────────────────────────────────

    /**
     * @notice Allows the lender to claim their funds after a loan is resolved.
     * @dev Caller must own the lender's Vaipakam position NFT (proven via ERC721.ownerOf).
     *      Transfers the recorded claimable amount from the lender's vault to the caller.
     *      Burns the lender's NFT after a successful claim.
     *      If the borrower has already claimed (or has nothing to claim), sets loan to Settled.
     *      Reverts if loan is Active, Settled, or already claimed.
     *      Emits LenderFundsClaimed and optionally LoanSettled.
     * @param loanId The ID of the resolved loan.
     */
    function claimAsLender(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        // No retry-swap try-list supplied — fallback collateral is
        // distributed as recorded by the original liquidation. Phase
        // 7a default behaviour for lenders who don't bring quotes.
        LibSwap.AdapterCall[] memory empty = new LibSwap.AdapterCall[](0);
        _claimAsLenderImpl(loanId, empty);
    }

    /**
     * @notice Phase 7a counterpart to {claimAsLender}: lender (or a
     *         keeper acting on the lender's NFT) supplies a ranked
     *         retry try-list when the loan is in `FallbackPending`.
     *         Frontend / HF watcher fetches fresh quotes from 0x /
     *         1inch / UniV3 / Balancer, ranks by expected output, and
     *         submits — same shape as
     *         {RiskFacet.triggerLiquidation}'s second argument.
     *
     *         Behaviour identical to {claimAsLender} when the loan is
     *         Repaid / Defaulted (retryCalls ignored). For a
     *         `FallbackPending` loan the library iterates the try-list,
     *         commits on first success, and rewrites the lender +
     *         borrower claims to principal-asset proceeds. Total
     *         failure leaves the recorded collateral split intact and
     *         transitions the loan terminally to Defaulted.
     * @param loanId      Resolved loan id.
     * @param retryCalls  Caller-ranked AdapterCall[] for the retry swap.
     *                    Empty array is equivalent to the no-retry
     *                    variant.
     */
    function claimAsLenderWithRetry(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    ) external nonReentrant whenNotPaused {
        // Forward calldata-typed array as memory through the impl by
        // copying. The length is bounded (~4 entries in practice) so
        // the copy cost is negligible.
        uint256 n = retryCalls.length;
        LibSwap.AdapterCall[] memory copied = new LibSwap.AdapterCall[](n);
        for (uint256 i = 0; i < n; ++i) {
            copied[i] = LibSwap.AdapterCall({
                adapterIdx: retryCalls[i].adapterIdx,
                data: retryCalls[i].data
            });
        }
        _claimAsLenderImpl(loanId, copied);
    }

    function _claimAsLenderImpl(
        uint256 loanId,
        LibSwap.AdapterCall[] memory retryCalls
    ) internal {
        // Tier-1 sanctions gate. Funds flow OUT to msg.sender on
        // claim — bright-line OFAC violation if the recipient is
        // sanctioned. See `LibVaipakam.isSanctionedAddress` policy
        // block for the full Tier-1/Tier-2 split. No-op when the
        // oracle is unset.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Loan must be resolved (Repaid, Defaulted, or FallbackPending awaiting
        // the lender's one-shot retry). Active or already Settled is rejected.
        if (
            loan.status != LibVaipakam.LoanStatus.Repaid &&
            loan.status != LibVaipakam.LoanStatus.Defaulted &&
            loan.status != LibVaipakam.LoanStatus.FallbackPending
        ) revert InvalidLoanStatus();

        // Already-claimed guard FIRST. A successful claim burns the
        // lender position NFT, so on a double-claim attempt
        // `requireLenderNftOwner` below would revert
        // `ERC721NonexistentToken` on the burned token — this guard
        // must run before it so the caller sees the precise
        // `AlreadyClaimed()` error. (`claim` is a storage pointer; a
        // claim-time full match deletes the record, but that path
        // returns early — see `fullyResolved` below — before any
        // further read.)
        LibVaipakam.ClaimInfo storage claim = s.lenderClaims[loanId];
        if (claim.claimed) revert AlreadyClaimed();

        // EC-007 — verify lender position-NFT ownership BEFORE the
        // claim-time fallback resolution. `_resolveFallbackIfActive`
        // runs the internal-match auto-dispatch, which pays the 1%
        // matcher bonus to `msg.sender`. Gating ownership here keeps
        // `claimAsLender` / `claimAsLenderWithRetry` lender-owner-only,
        // so a third party cannot call the claim entry point purely to
        // trigger the match and skim the matcher incentive. (Without
        // this, the `fullyResolved` early-return path below would
        // bypass the post-resolution ownership check entirely.)
        LibAuth.requireLenderNftOwner(loan);

        // README §7 lines 147–151: if this loan fell back to the claim-time
        // settlement path, attempt one more liquidation before paying the
        // lender. Success rewrites claims to principal-asset amounts; failure
        // leaves them as the collateral split recorded by the fallback. Once
        // resolved, the loan is terminally Defaulted (no further cure).
        if (loan.status == LibVaipakam.LoanStatus.FallbackPending) {
            bool fullyResolved = _resolveFallbackIfActive(loanId, loan, retryCalls);
            // EC-007 — a full claim-time internal match settled the lender
            // in the principal asset and deleted the claim records. There
            // is nothing left to pay out here; returning avoids the
            // `NothingToClaim()` revert below, which would otherwise roll
            // back the successful match (the auto-dispatch ran in this tx).
            if (fullyResolved) return;
            // EC-003 Phase 3 — the auto-dispatch inside
            // `_resolveFallbackIfActive` may have transitioned the
            // loan to `InternalMatched` (on a full match). Only force
            // the FallbackPending → Defaulted terminal when the loan
            // is STILL FallbackPending (i.e., auto-dispatch didn't
            // fire, OR partial-match left a residual). The Defaulted
            // transition's allow-list edge from FallbackPending stays
            // unchanged.
            if (loan.status == LibVaipakam.LoanStatus.FallbackPending) {
                LibLifecycle.transition(
                    loan,
                    LibVaipakam.LoanStatus.FallbackPending,
                    LibVaipakam.LoanStatus.Defaulted
                );
            }
        }

        // Claimable if there's a recorded amount, or heldForLender funds, or an NFT rental to return,
        // or an NFT collateral claim (for ERC-20 loans defaulting into NFT collateral).
        // `claim` + the already-claimed guard were resolved at the top
        // of this function; re-read nothing here.
        bool hasHeld = s.heldForLender[loanId] > 0;
        bool hasRentalNft = loan.assetType != LibVaipakam.AssetType.ERC20;
        bool hasNftCollateralClaim = claim.assetType != LibVaipakam.AssetType.ERC20;
        if (claim.amount == 0 && !hasHeld && !hasRentalNft && !hasNftCollateralClaim) revert NothingToClaim();

        // Lender position-NFT ownership was already verified at the top
        // of this function (before the claim-time fallback resolution).

        // Mark claimed before transfer to prevent re-entrancy
        claim.claimed = true;

        // Transfer claimable assets from lender's vault to claimant (if any)
        if (claim.assetType == LibVaipakam.AssetType.ERC20) {
            if (claim.amount > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        loan.lender,
                        claim.asset,
                        msg.sender,
                        claim.amount
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        } else if (claim.assetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    loan.lender,
                    claim.asset,
                    claim.tokenId,
                    msg.sender
                ),
                NFTTransferFailed.selector
            );
        } else if (claim.assetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    loan.lender,
                    claim.asset,
                    claim.tokenId,
                    claim.quantity,
                    msg.sender
                ),
                NFTTransferFailed.selector
            );
        }

        // If heldForLender funds exist from prior preclose top-ups, withdraw those too.
        // These are in the payment asset (principalAsset for ERC20, prepayAsset for NFT).
        uint256 held = s.heldForLender[loanId];
        if (held > 0) {
            address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
                ? loan.principalAsset
                : loan.prepayAsset;
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.lender,
                    payAsset,
                    msg.sender,
                    held
                ),
                VaultWithdrawFailed.selector
            );
        }

        // For NFT rentals: return the vaulted rental NFT to the lender
        if (loan.assetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    msg.sender
                ),
                VaultTransferFailed.selector
            );
        } else if (loan.assetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    loan.quantity,
                    msg.sender
                ),
                VaultTransferFailed.selector
            );
        }

        // Update lender's NFT to "Loan Closed" before burning (per README)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanClosed
            ),
            NFTStatusUpdateFailed.selector
        );

        // Burn the lender's NFT
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector, loan.lenderTokenId),
            NFTBurnFailed.selector
        );

        // If borrower already claimed or has nothing to claim, settle the loan.
        // Phase 5: a pending borrower LIF rebate counts as "something to
        // claim" so the loan stays in Repaid/Defaulted until the borrower
        // also runs their claim — this preserves the NFT-owner gating on
        // the rebate payout inside `claimAsBorrower`.
        LibVaipakam.ClaimInfo storage borrowerClaim = s.borrowerClaims[loanId];
        bool borrowerHasNothing = borrowerClaim.amount == 0 &&
            borrowerClaim.assetType == LibVaipakam.AssetType.ERC20 &&
            s.borrowerLifRebate[loanId].rebateAmount == 0;
        bool willSettle = borrowerClaim.claimed || borrowerHasNothing;

        emit LenderFundsClaimed(
            loanId,
            msg.sender,
            claim.asset,
            claim.amount,
            // §3.11 — newBothClaimed signals "loan is about to settle and
            // NFTs are about to burn" rather than the literal "borrower
            // flag flipped". When the borrower has nothing to claim
            // (illiquid default, NFT rental terminal, etc.) the
            // borrowerClaim.claimed flag stays false but the loan still
            // settles immediately on the lender claim.
            willSettle
        );

        if (willSettle) {
            LibLifecycle.transitionFromAny(loan, LibVaipakam.LoanStatus.Settled);
            emit LoanSettled(loanId);
        }
    }

    /**
     * @notice Allows the borrower to claim their collateral (or rental refund) after a loan is resolved.
     * @dev Caller must own the borrower's Vaipakam position NFT (proven via ERC721.ownerOf).
     *      Transfers the recorded claimable amount from the borrower's vault to the caller.
     *      Burns the borrower's NFT after a successful claim.
     *      If the lender has already claimed (or has nothing to claim), sets loan to Settled.
     *      Reverts if loan is Active, Settled, already claimed, or nothing to claim (e.g., on default).
     *      Emits BorrowerFundsClaimed and optionally LoanSettled.
     * @param loanId The ID of the resolved loan.
     */
    function claimAsBorrower(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate. Same reasoning as claimAsLender —
        // funds flow OUT to msg.sender; sanctioned recipient blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Borrower can only claim after the loan is terminally Repaid or
        // Defaulted. FallbackPending is explicitly blocked: during that window
        // the borrower can still cure via addCollateral/repayLoan, so handing
        // them the collateral split would short-circuit the cure policy.
        if (
            loan.status != LibVaipakam.LoanStatus.Repaid &&
            loan.status != LibVaipakam.LoanStatus.Defaulted
        ) revert InvalidLoanStatus();

        LibVaipakam.ClaimInfo storage claim = s.borrowerClaims[loanId];
        if (claim.claimed) revert AlreadyClaimed();
        // NFT collateral claims have amount=0 but tokenId/quantity as payload.
        // Phase 5 / §5.2b adds a second claimable lane: any pending VPFI
        // rebate credited at proper settlement (borrowerLifRebate). Loans
        // that paid LIF in the lending asset, or defaulted/liquidated,
        // have rebateAmount == 0 and no-op that branch below.
        bool hasNftClaim = claim.assetType != LibVaipakam.AssetType.ERC20;
        uint256 lifRebate = s.borrowerLifRebate[loanId].rebateAmount;
        if (claim.amount == 0 && !hasNftClaim && lifRebate == 0) {
            revert NothingToClaim();
        }

        // Verify caller owns the borrower's Vaipakam position NFT
        LibAuth.requireBorrowerNftOwner(loan);

        // Mark claimed before transfer to prevent re-entrancy
        claim.claimed = true;

        // Transfer claimable collateral from borrower's vault to claimant
        if (claim.assetType == LibVaipakam.AssetType.ERC20) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.borrower,
                    claim.asset,
                    msg.sender,
                    claim.amount
                ),
                VaultWithdrawFailed.selector
            );
        } else if (claim.assetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    loan.borrower,
                    claim.asset,
                    claim.tokenId,
                    msg.sender
                ),
                VaultWithdrawFailed.selector
            );
        } else if (claim.assetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    loan.borrower,
                    claim.asset,
                    claim.tokenId,
                    claim.quantity,
                    msg.sender
                ),
                VaultWithdrawFailed.selector
            );
        }

        // Phase 5 / §5.2b — transfer any pending borrower LIF VPFI rebate.
        // The Diamond custody-holds the rebate slice between settlement
        // (settleBorrowerLifProper) and this claim; zero it out and
        // transfer to the claimant in one step.
        if (lifRebate > 0) {
            s.borrowerLifRebate[loanId].rebateAmount = 0;
            address vpfi = s.vpfiToken;
            if (vpfi != address(0)) {
                IERC20(vpfi).safeTransfer(msg.sender, lifRebate);
                emit BorrowerLifRebateClaimed(
                    loanId,
                    msg.sender,
                    lifRebate,
                    LibVPFIDiscount.vaultVpfiBalance(msg.sender)
                );
            }
        }

        // Update borrower's NFT to "Loan Closed" before burning (per README)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanClosed
            ),
            NFTStatusUpdateFailed.selector
        );

        // Burn the borrower's NFT
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector, loan.borrowerTokenId),
            NFTBurnFailed.selector
        );

        // If lender already claimed or truly has nothing to claim, settle the loan.
        // Must check heldForLender, NFT rental returns, and NFT collateral claims.
        // Note: the borrower LIF rebate is paid out in the same tx above, so
        // it doesn't gate the Settled transition — once the borrower's
        // claimAsBorrower has run, every borrower-side payout has cleared.
        LibVaipakam.ClaimInfo storage lenderClaim = s.lenderClaims[loanId];
        bool lenderHasHeld = s.heldForLender[loanId] > 0;
        bool lenderHasRentalNft = loan.assetType != LibVaipakam.AssetType.ERC20;
        bool lenderHasNftCollateralClaim = lenderClaim.assetType != LibVaipakam.AssetType.ERC20;
        bool lenderFullyClaimed = lenderClaim.claimed;
        bool lenderHasNothing = lenderClaim.amount == 0 && !lenderHasHeld && !lenderHasRentalNft && !lenderHasNftCollateralClaim;
        bool willSettle = lenderFullyClaimed || lenderHasNothing;

        emit BorrowerFundsClaimed(
            loanId,
            msg.sender,
            claim.asset,
            claim.amount,
            // §3.11 — newBothClaimed signals "loan is about to settle"
            // (NFTs about to burn) — see LenderFundsClaimed for rationale.
            willSettle
        );

        if (willSettle) {
            LibLifecycle.transitionFromAny(loan, LibVaipakam.LoanStatus.Settled);
            emit LoanSettled(loanId);
        }
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    /// @dev Resolves a pending fallback snapshot at claim time. When
    ///      `retryCalls` is non-empty and no retry has yet been tried,
    ///      we run the swap one more time through the Phase-7a adapter
    ///      failover chain under the same 6% slippage gate used at
    ///      liquidation time. On success: collateral held in the
    ///      Diamond is converted to principal-asset proceeds and split
    ///      per README §7 (lender due first, then 2% treasury, surplus
    ///      to borrower); claims are rewritten accordingly. On failure
    ///      (empty try-list, all adapters reverted, or borrower claim
    ///      path): the pre-recorded collateral split is pushed from
    ///      the Diamond to lender/treasury/borrower vaults.
    /// @dev Returns `true` when a claim-time internal match FULLY resolved
    ///      the loan (transitioned it to `InternalMatched` and cleared the
    ///      lender claim records). The caller MUST then return without
    ///      touching the claim records — see the `NothingToClaim()` note in
    ///      `_claimAsLenderImpl`. Returns `false` for the partial-match,
    ///      no-match, and retry-swap paths, where the (scaled) residual is
    ///      still pending a normal claim-record payout.
    function _resolveFallbackIfActive(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibSwap.AdapterCall[] memory retryCalls
    ) internal returns (bool fullyResolved) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];
        if (!snap.active) return false;

        // EC-003 Phase 3 / EC-007 — internal-match-first at claim time.
        // The candidate pool grows between keeper-tick and lender-claim
        // (fresh Active counterparties, freshly-failed FallbackPending
        // loans), so this is the safety net for keeper outages + the
        // race between keeper scan and lender claim.
        //
        // The auto-dispatch may:
        //   - FULLY match the loan → it transitions FallbackPending →
        //     InternalMatched, `snap.active` is cleared, the lender is
        //     paid in the principal asset by the match settlement and
        //     the lender claim records are deleted. We detect this below
        //     by re-reading `snap.active` and signal `fullyResolved` so
        //     the caller skips the claim-record payout entirely.
        //   - PARTIALLY match the loan → it stays FallbackPending, the
        //     snapshot is scaled to the residual, `snap.active` STAYS
        //     true. We must NOT return — we fall through to the
        //     distribution path so the (scaled) residual is paid out.
        //   - not match at all → `snap.active` unchanged; same
        //     fall-through.
        //
        // EC-003 Phase 3 (#21) — `msg.sender` is threaded as the
        // explicit `matcher`. `_claimAsLenderImpl` has already verified
        // it owns the lender position NFT (EC-007 hoisted that check
        // ahead of this call), so the lender who triggers their own
        // claim-time rescue is the matcher and earns the 1% bonus.
        RiskMatchLiquidationFacet(address(this)).attemptInternalMatchAutoDispatch(loanId, msg.sender);
        // EC-007 — a full match consumed the snapshot and cleared the
        // lender claim records. Signal the caller to return early: if it
        // fell through to the claim-record payout it would read a zeroed
        // claim, revert `NothingToClaim()`, and — because the auto-dispatch
        // ran in THIS transaction — roll back the successful match.
        if (!snap.active) return true;

        bool retrySucceeded;
        uint256 proceeds;
        if (retryCalls.length > 0 && !snap.retryAttempted) {
            snap.retryAttempted = true;
            (retrySucceeded, proceeds) = _attemptRetrySwap(loanId, loan, retryCalls);
            emit ClaimRetryExecuted(loanId, retrySucceeded, proceeds);
        }

        if (retrySucceeded) {
            _distributeRetryProceeds(loanId, loan, snap, proceeds);
        } else {
            _distributeFallbackCollateral(loanId, loan, snap);
        }
        snap.active = false;
        // Partial-match / no-match / retry-swap: the (scaled) residual is
        // now recorded in the lender claim records — the caller must run
        // the normal claim-record payout.
        return false;
    }

    /// @dev Phase 7a — runs the retry swap through {LibSwap.swapWithFailover}.
    ///      `retryCalls` is the lender / keeper-supplied ranked
    ///      try-list across registered adapters. Returns (false, 0) if
    ///      every adapter reverted or the try-list was empty (still
    ///      over the 6% slippage ceiling, thin liquidity, or any
    ///      technical failure).
    function _attemptRetrySwap(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibSwap.AdapterCall[] memory retryCalls
    ) internal returns (bool, uint256) {
        uint256 expected = _expectedSwapOutput(
            loan.collateralAsset,
            loan.principalAsset,
            loan.collateralAmount
        );
        uint256 minOut = (expected *
            (LibVaipakam.BASIS_POINTS -
                LibVaipakam.cfgMaxLiquidationSlippageBps())) /
            LibVaipakam.BASIS_POINTS;

        // LibSwap takes calldata; we have memory here. Solidity
        // doesn't auto-convert memory→calldata for library internal
        // calls, so swap to an inline assembly trick OR call a small
        // wrapper that takes calldata. Cleanest: declare a tiny
        // external `_libSwapWrapper(...)` selector via address(this).
        // Skipping that complexity by inlining the iteration here —
        // mirrors LibSwap.swapWithFailover with a memory try-list.
        return _swapWithFailoverMem(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            loan.collateralAmount,
            minOut,
            address(this),
            retryCalls
        );
    }

    /// @dev Memory-array variant of {LibSwap.swapWithFailover}.
    ///      Identical semantics + invariants — only the try-list is
    ///      `memory` (came from the storage-copied retry list above)
    ///      instead of `calldata`. Kept local to ClaimFacet because
    ///      the only caller is {_attemptRetrySwap}; promoting it to
    ///      LibSwap would force every caller to overload their try-
    ///      list location.
    function _swapWithFailoverMem(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        LibSwap.AdapterCall[] memory calls
    ) internal returns (bool, uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 registered = s.swapAdapters.length;
        if (registered == 0) revert LibSwap.NoSwapAdaptersConfigured();
        uint256 n = calls.length;
        if (n == 0) return (false, 0);

        for (uint256 i = 0; i < n; ++i) {
            uint256 idx = calls[i].adapterIdx;
            if (idx >= registered) {
                revert LibSwap.AdapterIndexOutOfRange(idx, registered);
            }
            address adapter = s.swapAdapters[idx];
            SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
            SafeERC20.forceApprove(IERC20(inputToken), adapter, inputAmount);
            try
                ISwapAdapter(adapter).execute(
                    inputToken,
                    outputToken,
                    inputAmount,
                    minOutputAmount,
                    recipient,
                    calls[i].data
                )
            returns (uint256 out_) {
                SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
                emit LibSwap.SwapAdapterAttempted(loanId, idx, adapter, true);
                emit LibSwap.SwapAdapterSucceeded(loanId, idx, adapter, out_);
                return (true, out_);
            } catch {
                SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
                emit LibSwap.SwapAdapterAttempted(loanId, idx, adapter, false);
            }
        }
        emit LibSwap.SwapAllAdaptersFailed(loanId);
        return (false, 0);
    }

    /// @dev Distributes principal-asset proceeds from a successful retry
    ///      swap. Lender first (up to their `lenderPrincipalDue` = principal
    ///      + accrued + late fees + 3%), then treasury (2%), then borrower
    ///      surplus. Rewrites the lender and borrower claim records to the
    ///      principal asset so the normal withdrawal flow below works.
    function _distributeRetryProceeds(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibVaipakam.FallbackSnapshot storage snap,
        uint256 proceeds
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        uint256 lenderGets;
        uint256 treasuryGets;
        uint256 borrowerGets;
        if (proceeds <= snap.lenderPrincipalDue) {
            lenderGets = proceeds;
        } else {
            lenderGets = snap.lenderPrincipalDue;
            uint256 rem = proceeds - lenderGets;
            treasuryGets = snap.treasuryPrincipalDue <= rem
                ? snap.treasuryPrincipalDue
                : rem;
            borrowerGets = rem - treasuryGets;
        }

        if (treasuryGets > 0) {
            IERC20(loan.principalAsset).safeTransfer(s.treasury, treasuryGets);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryGets);
        }

        if (lenderGets > 0) {
            address lenderVault = LibFacet.getOrCreateVault(loan.lender);
            IERC20(loan.principalAsset).safeTransfer(lenderVault, lenderGets);
            // T-051 — Diamond-side transfer to vault ticks the
            // protocolTrackedVaultBalance counter so the eventual
            // claimAsLender's vaultWithdrawERC20 doesn't underflow.
            LibVaipakam.recordVaultDeposit(loan.lender, loan.principalAsset, lenderGets);
        }
        if (borrowerGets > 0) {
            address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);
            IERC20(loan.principalAsset).safeTransfer(borrowerVault, borrowerGets);
            LibVaipakam.recordVaultDeposit(loan.borrower, loan.principalAsset, borrowerGets);
        }

        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderGets,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: borrowerGets,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerGets == 0
        });
    }

    /// @dev Pushes the pre-recorded collateral split from the Diamond into
    ///      the lender vault / treasury / borrower vault. Used when the
    ///      retry swap failed or was skipped (borrower-first claim).
    function _distributeFallbackCollateral(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibVaipakam.FallbackSnapshot storage snap
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (snap.treasuryCollateral > 0) {
            IERC20(loan.collateralAsset).safeTransfer(
                s.treasury,
                snap.treasuryCollateral
            );
            LibFacet.recordTreasuryAccrual(loan.collateralAsset, snap.treasuryCollateral);
        }

        if (snap.lenderCollateral > 0) {
            address lenderVault = LibFacet.getOrCreateVault(loan.lender);
            IERC20(loan.collateralAsset).safeTransfer(lenderVault, snap.lenderCollateral);
            LibVaipakam.recordVaultDeposit(loan.lender, loan.collateralAsset, snap.lenderCollateral);
        }
        if (snap.borrowerCollateral > 0) {
            address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);
            IERC20(loan.collateralAsset).safeTransfer(borrowerVault, snap.borrowerCollateral);
            LibVaipakam.recordVaultDeposit(loan.borrower, loan.collateralAsset, snap.borrowerCollateral);
        }
        // Claim records were already written in the collateral asset at
        // fallback time; nothing to rewrite here. loanId retained for
        // symmetry with _distributeRetryProceeds and for future hooks.
        loanId;
    }

    /// @dev Oracle-derived expected swap output in principal-asset units.
    ///      Mirrors RiskFacet/DefaultedFacet so the retry path uses the
    ///      same 6% slippage semantics.
    function _expectedSwapOutput(
        address collateralAsset,
        address principalAsset,
        uint256 collateralAmount
    ) internal view returns (uint256) {
        (uint256 colPrice, uint8 colFeedDec) = OracleFacet(address(this))
            .getAssetPrice(collateralAsset);
        (uint256 prinPrice, uint8 prinFeedDec) = OracleFacet(address(this))
            .getAssetPrice(principalAsset);
        if (prinPrice == 0) return 0;
        uint8 colTokenDec = IERC20Metadata(collateralAsset).decimals();
        uint8 prinTokenDec = IERC20Metadata(principalAsset).decimals();
        return
            (collateralAmount * colPrice * (10 ** prinTokenDec) *
                (10 ** prinFeedDec)) /
            (prinPrice * (10 ** colTokenDec) * (10 ** colFeedDec));
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    /**
     * @notice Returns the claimable ERC-20 amount and claim status for a lender
     *         or borrower side of a loan.
     * @dev Returns (address(0), 0, false) if no claim has been recorded (e.g.
     *      loan still Active). For NFT-asset claims or held-for-lender funds
     *      use {getClaimable} — those cases carry `amount == 0` but are still
     *      claimable.
     * @param loanId The loan ID to query.
     * @param isLender True to query the lender side; false for the borrower side.
     * @return asset The ERC-20 token address claimable.
     * @return amount The claimable amount.
     * @return claimed Whether the funds have already been claimed.
     */
    function getClaimableAmount(
        uint256 loanId,
        bool isLender
    )
        external
        view
        returns (
            address asset,
            uint256 amount,
            bool claimed
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ClaimInfo storage claim = isLender
            ? s.lenderClaims[loanId]
            : s.borrowerClaims[loanId];
        return (claim.asset, claim.amount, claim.claimed);
    }

    /// @notice Phase 5 borrower LIF VPFI rebate state for a given loan.
    /// @dev `vpfiHeld` > 0 while the loan is live and took the VPFI fee
    ///      path at init; zero once settlement runs. `rebateAmount` > 0
    ///      after a proper settlement (repay / preclose / refinance-old-
    ///      loan) credited the borrower; zero after
    ///      `claimAsBorrower` paid it out, after a default/liquidation
    ///      forfeiture, or on loans that never took the VPFI path. A
    ///      loan is "rebate-actionable" iff `rebateAmount > 0`.
    /// @param loanId Loan to query.
    /// @return rebateAmount Claimable VPFI (18 dec) the borrower NFT owner
    ///                      receives on their next `claimAsBorrower`.
    /// @return vpfiHeld     VPFI currently held by the Diamond against this
    ///                      loan pending settlement. Zero after any
    ///                      terminal transition.
    function getBorrowerLifRebate(uint256 loanId)
        external
        view
        returns (uint256 rebateAmount, uint256 vpfiHeld)
    {
        LibVaipakam.BorrowerLifRebate storage r =
            LibVaipakam.storageSlot().borrowerLifRebate[loanId];
        return (r.rebateAmount, r.vpfiHeld);
    }

    /// @notice Full claim payload for the requested side of a loan — use
    ///         this over `getClaimableAmount` when the claim may be an
    ///         NFT (ERC-721/1155) or when held-for-lender funds exist, as
    ///         those cases carry `amount == 0` but are still claimable.
    /// @dev Treat the claim as actionable when:
    ///         `!claimed && (amount > 0 || assetType != ERC20 ||
    ///                      heldForLender > 0 || hasRentalNftReturn)`
    ///      — mirroring the guards in `claimAsLender` / `claimAsBorrower`.
    ///      Phase 5 adds the borrower LIF rebate; query
    ///      {getBorrowerLifRebate} for that lane.
    function getClaimable(
        uint256 loanId,
        bool isLender
    )
        external
        view
        returns (
            address asset,
            uint256 amount,
            bool claimed,
            LibVaipakam.AssetType assetType,
            uint256 tokenId,
            uint256 quantity,
            uint256 heldForLender,
            bool hasRentalNftReturn
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ClaimInfo storage claim = isLender
            ? s.lenderClaims[loanId]
            : s.borrowerClaims[loanId];
        asset = claim.asset;
        amount = claim.amount;
        claimed = claim.claimed;
        assetType = claim.assetType;
        tokenId = claim.tokenId;
        quantity = claim.quantity;
        if (isLender) {
            heldForLender = s.heldForLender[loanId];
            // NFT-asset loans (ERC-721/1155 lent out) entitle the lender to
            // reclaim the NFT at resolution even when no fungible amount
            // was recorded against the claim struct.
            hasRentalNftReturn =
                s.loans[loanId].assetType != LibVaipakam.AssetType.ERC20;
        }
    }

    /// @notice Returns the fallback-path settlement snapshot for a loan.
    /// @dev    Emitted alongside `LiquidationFallback` and persisted to
    ///         `s.fallbackSnapshot[loanId]` whenever a liquid-collateral
    ///         loan falls through to the claim-time settlement path
    ///         (DEX swap reverted or exceeded the 6% slippage ceiling).
    ///         Frontends use this to render the lender / treasury /
    ///         borrower three-way collateral split alongside the
    ///         principal-due figures, without parsing logs. While
    ///         `active == false`, the loan never entered the fallback
    ///         path — the other view return values are zero.
    /// @param loanId Loan to query.
    /// @return lenderCollateral     Collateral units routed to the lender if
    ///                              the claim-time retry fails (principal +
    ///                              interest + late fees + 3% bonus, capped
    ///                              at available collateral).
    /// @return treasuryCollateral   Collateral units routed to treasury
    ///                              (≈2% of principal, or zero if
    ///                              undercollateralized).
    /// @return borrowerCollateral   Remainder back to the borrower.
    /// @return lenderPrincipalDue   Principal-asset amount the lender is
    ///                              owed if the claim-time swap retry
    ///                              succeeds (drives the proceeds split).
    /// @return treasuryPrincipalDue Principal-asset amount routed to
    ///                              treasury when the retry succeeds.
    /// @return active               True iff this loan is in the fallback
    ///                              path (snapshot is meaningful).
    /// @return retryAttempted       True iff `ClaimFacet` already ran the
    ///                              one-shot claim-time retry against this
    ///                              snapshot.
    function getFallbackSnapshot(uint256 loanId)
        external
        view
        returns (
            uint256 lenderCollateral,
            uint256 treasuryCollateral,
            uint256 borrowerCollateral,
            uint256 lenderPrincipalDue,
            uint256 treasuryPrincipalDue,
            bool active,
            bool retryAttempted
        )
    {
        LibVaipakam.FallbackSnapshot storage snap =
            LibVaipakam.storageSlot().fallbackSnapshot[loanId];
        return (
            snap.lenderCollateral,
            snap.treasuryCollateral,
            snap.borrowerCollateral,
            snap.lenderPrincipalDue,
            snap.treasuryPrincipalDue,
            snap.active,
            snap.retryAttempted
        );
    }
}
