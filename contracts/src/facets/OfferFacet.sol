// src/facets/OfferFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {LoanFacet} from "./LoanFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "./EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "./PrecloseFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";

/**
 * @title OfferFacet
 * @author Vaipakam Developer Team
 * @notice Creation, acceptance, and cancellation of lending and borrowing
 *         offers for the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *
 *      Supports three asset forms on each leg (principal and collateral):
 *      ERC-20, ERC-721 (rental), ERC-1155 (rental, fractional quantity).
 *      NFT rentals carry a borrower prepay of `amount * durationDays` plus a
 *      `RENTAL_BUFFER_BPS` (5%) buffer; daily pro-rata deduction happens in
 *      RepayFacet, buffer is swept at resolution time.
 *
 *      Compliance surface:
 *        - Country-pair check via {LibVaipakam.canTradeBetween} using
 *          ProfileFacet-stored user countries. **Phase 1**: `canTradeBetween`
 *          always returns true — country-pair sanctions are disabled at the
 *          protocol level; the call site is retained for zero-migration
 *          re-activation in Phase 2.
 *        - Tiered KYC (README §16) — transaction value in USD is computed
 *          from the liquid leg(s) and checked against
 *          {ProfileFacet.meetsKYCRequirement} for both counterparties.
 *        - Mandatory mutual consent on every create + accept —
 *          `creatorFallbackConsent` on the offer and
 *          `acceptorFallbackConsent` at accept time. The consent covers the
 *          combined abnormal-market + illiquid-assets fallback terms
 *          (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
 *          README.md §"Liquidity & Asset Classification"). Required on
 *          every offer regardless of leg liquidity — illiquid legs would
 *          additionally fail the LTV/HF gates without it, but consent is
 *          always gathered.
 *
 *      On accept, initiates the loan via cross-facet call to
 *      {LoanFacet.initiateLoan} and auto-completes any linked lender-sale
 *      vehicle ({EarlyWithdrawalFacet.completeLoanSale}) or borrower-offset
 *      offer ({PrecloseFacet.completeOffset}) atomically.
 */
contract OfferFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    /// @notice Emitted when a new offer is created.
    /// @param offerId The unique ID of the created offer.
    /// @param creator The address of the user creating the offer.
    /// @param offerType The type of offer (Lender or Borrower).
    event OfferCreated(
        uint256 indexed offerId,
        address indexed creator,
        LibVaipakam.OfferType offerType
    );

    /// @notice Emitted when an offer is accepted.
    /// @param offerId The ID of the accepted offer.
    /// @param acceptor The address of the user accepting the offer.
    /// @param loanId The ID of the initiated loan.
    event OfferAccepted(
        uint256 indexed offerId,
        address indexed acceptor,
        uint256 loanId
    );

    /// @notice Emitted when an offer is canceled.
    /// @param offerId The ID of the canceled offer.
    /// @param creator The address of the creator canceling the offer.
    event OfferCanceled(uint256 indexed offerId, address indexed creator);

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidOfferType();
    error InvalidOffer();
    error InvalidAssetType();
    error OfferAlreadyAccepted();
    // NotOfferCreator inherited from IVaipakamErrors
    error InsufficientAllowance();
    error LiquidityMismatch();
    error GetUserEscrowFailed(string reason);

    /**
     * @notice Creates a new lender or borrower offer.
     * @dev Deposits/locks the creator-side asset into the creator's per-user
     *      escrow via {EscrowFactoryFacet}:
     *        - Lender/ERC-20: `amount` of `lendingAsset`.
     *        - Lender/ERC-721 or ERC-1155: the NFT itself (custody-based rental).
     *        - Borrower/ERC-20 loan: collateral in its declared asset type.
     *        - Borrower/NFT rental: prepay + 5% buffer in `prepayAsset`.
     *      Re-checks liquidity on both legs via OracleFacet and latches
     *      the verdict into the offer. `creatorFallbackConsent` is mandatory
     *      on every create (docs/WebsiteReadme.md §"Offer and acceptance
     *      risk warnings" + README.md §"Liquidity & Asset Classification");
     *      missing consent reverts FallbackConsentRequired before any
     *      escrow movement. Mints a position NFT representing the offer.
     *      Reverts InvalidOfferType on zero duration, InvalidAmount on zero
     *      amount, InvalidAssetType on unknown asset enums.
     *      Emits OfferCreated. Callable by anyone when not paused.
     * @param params CreateOfferParams struct containing all offer parameters.
     * @return offerId The ID of the created offer.
     */
    function createOffer(
        LibVaipakam.CreateOfferParams calldata params
    ) external nonReentrant whenNotPaused returns (uint256 offerId) {
        if (params.durationDays == 0) revert InvalidOfferType();
        if (params.amount <= 0) revert InvalidAmount();

        // Self-lending guard: principal and collateral must reference
        // distinct asset contracts. With ETH as the oracle quote asset
        // the older USDT "always-Illiquid" hack that implicitly blocked
        // same-asset offers is gone, so the invariant is enforced here
        // directly at offer creation.
        if (
            params.lendingAsset != address(0) &&
            params.lendingAsset == params.collateralAsset
        ) revert SelfCollateralizedOffer();

        // Per-asset pause (governance-controlled reserve pause). Either
        // leg being paused blocks offer creation; existing offers that
        // reference the asset remain claimable via exit paths.
        LibFacet.requireAssetNotPaused(params.lendingAsset);
        LibFacet.requireAssetNotPaused(params.collateralAsset);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        unchecked {
            offerId = ++s.nextOfferId;
        }
        // Append to the creator's reverse index so indexers and
        // frontends can enumerate a user's offers without scanning events.
        s.userOfferIds[msg.sender].push(offerId);

        LibVaipakam.Offer storage offer = s.offers[offerId];
        _writeOfferFields(offer, offerId, params);

        // Check liquidity for both principal and collateral (stored per README)
        LibVaipakam.LiquidityStatus principalLiq = OracleFacet(address(this))
            .checkLiquidity(params.lendingAsset);
        LibVaipakam.LiquidityStatus collateralLiq = OracleFacet(address(this))
            .checkLiquidity(params.collateralAsset);
        offer.principalLiquidity = principalLiq;
        offer.collateralLiquidity = collateralLiq;

        // Liquidation-fallback terms consent is mandatory on every offer
        // (liquid and illiquid): the creator must acknowledge both the
        // abnormal-market fallback (lender claims collateral if liquidation
        // can't execute safely) and, when applicable, the illiquid
        // full-collateral-transfer terms. The frontend surfaces the full
        // warning copy before this call.
        if (!params.creatorFallbackConsent) revert FallbackConsentRequired();

        // Get/create escrow
        address escrow = getUserEscrow(msg.sender);

        // Handle asset deposit/approval
        bool success;
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            if (params.assetType == LibVaipakam.AssetType.ERC20) {
                IERC20(params.lendingAsset).safeTransferFrom(
                    msg.sender,
                    escrow,
                    params.amount
                );
            } else if (params.assetType == LibVaipakam.AssetType.ERC721) {
                IERC721(params.lendingAsset).safeTransferFrom(
                    msg.sender,
                    escrow,
                    params.tokenId
                );
            } else if (params.assetType == LibVaipakam.AssetType.ERC1155) {
                IERC1155(params.lendingAsset).safeTransferFrom(
                    msg.sender,
                    escrow,
                    params.tokenId,
                    params.quantity,
                    ""
                );
            } else {
                revert InvalidAssetType();
            }
        } else {
            // Borrower: Lock collateral
            if (params.assetType == LibVaipakam.AssetType.ERC20) {
                if (params.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    IERC20(params.collateralAsset).safeTransferFrom(
                        msg.sender,
                        escrow,
                        params.collateralAmount
                    );
                } else if (params.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(params.collateralAsset).safeTransferFrom(
                        msg.sender,
                        escrow,
                        params.collateralTokenId
                    );
                } else if (params.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(params.collateralAsset).safeTransferFrom(
                        msg.sender,
                        escrow,
                        params.collateralTokenId,
                        params.collateralQuantity,
                        ""
                    );
                } else {
                    revert InvalidAssetType();
                }
            } else if (
                params.assetType == LibVaipakam.AssetType.ERC721 ||
                params.assetType == LibVaipakam.AssetType.ERC1155
            ) {
                uint256 prepayAmount = offer.amount * offer.durationDays;
                uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps()) /
                    LibVaipakam.BASIS_POINTS;
                uint256 totalPrepay = prepayAmount + buffer;
                IERC20(offer.prepayAsset).safeTransferFrom(
                    msg.sender,
                    escrow,
                    totalPrepay
                );
            } else {
                revert InvalidAssetType();
            }
        }
        if (params.offerType == LibVaipakam.OfferType.Borrower) {}

        // Mint Vaipakam position NFT for offer
        unchecked {
            offer.positionTokenId = ++s.nextTokenId;
        }
        (success, ) = address(VaipakamNFTFacet(address(this))).call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                msg.sender,
                offer.positionTokenId,
                offerId,
                0,
                params.offerType == LibVaipakam.OfferType.Lender,
                LibVaipakam.LoanPositionStatus.OfferCreated
            )
        );

        if (!success) revert NFTMintFailed();

        // Register the offer in the MetricsFacet O(1) analytics layer —
        // increments activeOffersCount, pushes to activeOfferIdsList,
        // and marks the creator as a unique user. Runs last so the
        // offer struct is fully populated by this point.
        LibMetricsHooks.onOfferCreated(offer);

        emit OfferCreated(offerId, msg.sender, params.offerType);
    }

    /**
     * @dev Writes the ~18 offer fields in two frames so `forge coverage
     *      --ir-minimum` (no optimizer) doesn't pile every calldata load
     *      onto a single stack frame in {createOffer}.
     */
    function _writeOfferFields(
        LibVaipakam.Offer storage offer,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        _writeOfferPrincipalFields(offer, offerId, params);
        _writeOfferCollateralFields(offer, params);
    }

    function _writeOfferPrincipalFields(
        LibVaipakam.Offer storage offer,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        offer.id = offerId;
        offer.creator = msg.sender;
        offer.offerType = params.offerType;
        offer.lendingAsset = params.lendingAsset;
        offer.amount = params.amount;
        offer.interestRateBps = params.interestRateBps;
        offer.durationDays = params.durationDays;
        offer.assetType = params.assetType;
        offer.tokenId = params.tokenId;
        offer.quantity = params.quantity;
        offer.prepayAsset = params.prepayAsset;
    }

    function _writeOfferCollateralFields(
        LibVaipakam.Offer storage offer,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        offer.collateralAsset = params.collateralAsset;
        offer.collateralAmount = params.collateralAmount;
        offer.creatorFallbackConsent = params.creatorFallbackConsent;
        offer.collateralAssetType = params.collateralAssetType;
        offer.collateralTokenId = params.collateralTokenId;
        offer.collateralQuantity = params.collateralQuantity;
        offer.keeperAccessEnabled = params.keeperAccessEnabled;
    }

    /**
     * @notice Accepts an existing offer and initiates the loan.
     * @dev Compliance gates (in order): country pair via
     *      {LibVaipakam.canTradeBetween}; liquidity re-check with mutual
     *      illiquid consent; tiered KYC via
     *      {ProfileFacet.meetsKYCRequirement} on the transaction USD value.
     *
     *      Asset flow:
     *        - ERC-20 loan: lender escrow → borrower principal transfer;
     *          borrower-side collateral (ERC-20/721/1155) locked into borrower
     *          escrow.
     *        - NFT rental (Lender-offer): borrower prepay (principal fee ×
     *          days + `RENTAL_BUFFER_BPS` buffer) pulled into borrower escrow;
     *          rental user set on lender escrow.
     *        - NFT rental (Borrower-offer): lender's NFT escrowed, rental
     *          user set.
     *      Delegates loan creation to {LoanFacet.initiateLoan} (LTV/HF gates
     *      apply there). Atomically auto-completes any linked
     *      saleOfferToLoanId / offsetOfferToLoanId flow.
     *
     *      Reverts: InvalidOffer, OfferAlreadyAccepted, CountriesNotCompatible,
     *      FallbackConsentRequired, KYCRequired,
     *      EscrowWithdrawFailed, NFTRenterUpdateFailed, LoanInitiationFailed,
     *      OfferAcceptFailed. Emits OfferAccepted.
     * @param offerId The offer ID to accept.
     * @param acceptorFallbackConsent Acceptor's mandatory consent to the
     *        combined abnormal-market + illiquid-assets fallback terms
     *        (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
     *        README.md §"Liquidity & Asset Classification"). Required on
     *        every accept regardless of leg liquidity; combined with
     *        offer.creatorFallbackConsent and latched into the resulting
     *        loan via {Loan.fallbackConsentFromBoth}.
     * @return loanId The ID of the initiated loan.
     */
    function acceptOffer(
        uint256 offerId,
        bool acceptorFallbackConsent
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        return _acceptOffer(offerId, acceptorFallbackConsent);
    }

    function _acceptOffer(
        uint256 offerId,
        bool acceptorFallbackConsent
    ) internal returns (uint256 loanId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator == address(0)) revert InvalidOffer();
        if (offer.accepted) revert OfferAlreadyAccepted();

        // Per-asset pause: block accepts if either leg has been paused
        // since the offer was created. The offer creator can still cancel
        // and reclaim escrowed assets — cancelOffer is an exit path.
        LibFacet.requireAssetNotPaused(offer.lendingAsset);
        LibFacet.requireAssetNotPaused(offer.collateralAsset);

        // Check countries compatible
        string memory creatorCountry = ProfileFacet(address(this))
            .getUserCountry(offer.creator);
        string memory acceptorCountry = ProfileFacet(address(this))
            .getUserCountry(msg.sender);
        if (
            keccak256(abi.encodePacked(creatorCountry)) !=
            keccak256(abi.encodePacked(acceptorCountry))
        ) {
            if (!LibVaipakam.canTradeBetween(creatorCountry, acceptorCountry)) {
                revert CountriesNotCompatible();
            }
        }

        LibVaipakam.LiquidityStatus lendingAssetLiquidity = OracleFacet(
            address(this)
        ).checkLiquidity(offer.lendingAsset);
        // Liquidation-fallback terms consent is required from both sides on
        // every offer (liquid and illiquid). Creator consent is guaranteed
        // true by createOffer; we still check both defensively so a future
        // code path that bypasses createOffer enforcement can't land a loan
        // without mutual agreement on record.
        if (!(offer.creatorFallbackConsent && acceptorFallbackConsent)) {
            revert FallbackConsentRequired();
        }

        // Tiered KYC check based on transaction value (per README Section 16)
        uint256 valueUSD = _calculateTransactionValueUSD(offer);
        if (
            !ProfileFacet(address(this)).meetsKYCRequirement(offer.creator, valueUSD) ||
            !ProfileFacet(address(this)).meetsKYCRequirement(msg.sender, valueUSD)
        ) {
            revert KYCRequired();
        }

        address lenderEscrow;
        address borrowerEscrow;
        address lender;
        address borrower;

        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            lender = offer.creator;
            borrower = msg.sender;
            lenderEscrow = getUserEscrow(lender);
            borrowerEscrow = getUserEscrow(borrower);
        } else {
            lender = msg.sender;
            borrower = offer.creator;
            lenderEscrow = getUserEscrow(lender);
            borrowerEscrow = getUserEscrow(borrower);
        }
        uint256 vpfiDiscountDeducted;
        if (offer.assetType == LibVaipakam.AssetType.ERC20) {
            // Default path: deduct the 0.1% Loan Initiation Fee from the
            // lender's escrow BEFORE the net is delivered to the borrower
            // (README §6 lines 280, 332). Borrower still owes the full
            // `offer.amount` back — the fee is paid out of the lender's
            // funded principal, not added on top of the debt.
            //
            // VPFI discount path: activates when the borrower has enabled
            // the single platform-level VPFI-discount consent setting
            // (s.vpfiDiscountConsent[borrower]), the lending asset is
            // liquid, AND the borrower's escrow holds >= the required
            // VPFI. On success:
            //   - Borrower pays 0.075% of principal in VPFI from escrow to
            //     treasury (via LibVPFIDiscount.tryApply).
            //   - Lender delivers FULL 100% principal — no lender-side
            //     haircut.
            // On any precondition failure tryApply returns (false, 0)
            // silently and we fall through to the normal 0.1% fee path.
            bool discountApplied;
            if (
                s.vpfiDiscountConsent[borrower] &&
                lendingAssetLiquidity == LibVaipakam.LiquidityStatus.Liquid
            ) {
                (discountApplied, vpfiDiscountDeducted) = LibVPFIDiscount
                    .tryApply(offer.lendingAsset, offer.amount, borrower);
            }

            uint256 netToBorrower;
            if (discountApplied) {
                netToBorrower = offer.amount;
            } else {
                uint256 initiationFee = (offer.amount *
                    LibVaipakam.cfgLoanInitiationFeeBps()) /
                    LibVaipakam.BASIS_POINTS;
                netToBorrower = offer.amount - initiationFee;

                if (initiationFee > 0) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC20.selector,
                            lender,
                            offer.lendingAsset,
                            LibFacet.getTreasury(),
                            initiationFee
                        ),
                        TreasuryTransferFailed.selector
                    );
                    LibFacet.recordTreasuryAccrual(
                        offer.lendingAsset,
                        initiationFee
                    );
                }
            }

            // Transfer net principal to borrower (full amount when the VPFI
            // discount path fired; principal − fee otherwise).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    lender,
                    offer.lendingAsset,
                    borrower,
                    netToBorrower
                ),
                EscrowWithdrawFailed.selector
            );
        } else {
            if (offer.offerType == LibVaipakam.OfferType.Lender) {
                // NFT renting: Borrower prepays (per day fee * days + 5% buffer)
                uint256 prepayAmount = offer.amount * offer.durationDays;
                uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps()) /
                    LibVaipakam.BASIS_POINTS;
                uint256 totalPrepay = prepayAmount + buffer;
                IERC20(offer.prepayAsset).safeTransferFrom(
                    borrower,
                    borrowerEscrow,
                    totalPrepay
                );
            } else {
                // Borrower-type NFT offer accepted by lender: escrow the lender's NFT.
                // The lender (msg.sender/acceptor) must custody the NFT in their escrow
                // for the rental duration, matching the Lender-offer model.
                if (offer.assetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(offer.lendingAsset).safeTransferFrom(
                        lender,
                        lenderEscrow,
                        offer.tokenId
                    );
                } else if (offer.assetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(offer.lendingAsset).safeTransferFrom(
                        lender,
                        lenderEscrow,
                        offer.tokenId,
                        offer.quantity,
                        ""
                    );
                }
            }

            // Set renter (borrower as user)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowSetNFTUser.selector,
                    lender,
                    offer.lendingAsset,
                    offer.tokenId,
                    borrower,
                    uint64(block.timestamp + offer.durationDays * 1 days)
                ),
                NFTRenterUpdateFailed.selector
            );
        }

        // Lock collateral from borrower (already in escrow for Borrower offers)
        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                // ERC-20 lending: lock collateral based on collateral asset type
                if (offer.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    IERC20(offer.collateralAsset).safeTransferFrom(
                        borrower,
                        borrowerEscrow,
                        offer.collateralAmount
                    );
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(offer.collateralAsset).safeTransferFrom(
                        borrower,
                        borrowerEscrow,
                        offer.collateralTokenId
                    );
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(offer.collateralAsset).safeTransferFrom(
                        borrower,
                        borrowerEscrow,
                        offer.collateralTokenId,
                        offer.collateralQuantity,
                        ""
                    );
                }
            }
            // ERC721/ERC1155 lender offers: borrower prepay already transferred above
        }

        // Initiate loan
        bytes memory result = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                LoanFacet.initiateLoan.selector,
                offerId,
                msg.sender,
                acceptorFallbackConsent
            ),
            LoanInitiationFailed.selector
        );
        loanId = abi.decode(result, (uint256));

        // Update offer
        offer.accepted = true;
        LibMetricsHooks.onOfferAccepted(offerId);

        // Emit the discount event (after loanId is known) via
        // VPFIDiscountFacet so indexers can subscribe to a single facet for
        // discount analytics.
        if (vpfiDiscountDeducted > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VPFIDiscountFacet.emitDiscountApplied.selector,
                    loanId,
                    borrower,
                    offer.lendingAsset,
                    vpfiDiscountDeducted
                ),
                OfferAcceptFailed.selector
            );
        }

        // Auto-complete linked flows atomically so there is no gap where the
        // live loan could be repaid/defaulted between acceptance and completion.
        {
            LibVaipakam.Storage storage sCheck = LibVaipakam.storageSlot();
            // Lender-sale vehicle (created by createLoanSaleOffer)
            uint256 saleLoanId = sCheck.saleOfferToLoanId[offerId];
            if (saleLoanId != 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EarlyWithdrawalFacet.completeLoanSale.selector,
                        saleLoanId
                    ),
                    OfferAcceptFailed.selector
                );
            }
            // Borrower offset offer (created by offsetWithNewOffer)
            uint256 offsetLoanId = sCheck.offsetOfferToLoanId[offerId];
            if (offsetLoanId != 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        PrecloseFacet.completeOffset.selector,
                        offsetLoanId
                    ),
                    OfferAcceptFailed.selector
                );
            }
        }

        emit OfferAccepted(offerId, msg.sender, loanId);
    }

    /**
     * @notice Cancels an unaccepted offer and returns the locked assets.
     * @dev Creator-only (enforced via {LibAuth.requireOfferCreator}).
     *      Releases whatever was actually locked during {createOffer}:
     *      principal (Lender side) or collateral / rental prepay+buffer
     *      (Borrower side), matching the original asset type. Burns the
     *      offer position NFT and deletes the Offer record.
     *      Reverts NotOfferCreator or OfferAlreadyAccepted; emits
     *      OfferCanceled.
     * @param offerId The offer ID to cancel.
     */
    function cancelOffer(uint256 offerId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        LibAuth.requireOfferCreator(offer);
        if (offer.accepted) revert OfferAlreadyAccepted();

        // ── Strategic-flow NFT unlock on cancel ─────────────────────────────
        // requireOfferCreator above has bound msg.sender to offer.creator. For
        // the native-lock design the position NFT never leaves its owner; we
        // only need to clear the LibERC721 lock to restore ordinary transfer
        // rights.
        //
        // (a) Preclose Option 3 offset: release the borrower position NFT.
        uint256 lockedOffsetLoanId = s.offsetOfferToLoanId[offerId];
        if (lockedOffsetLoanId != 0) {
            LibERC721._unlock(s.loans[lockedOffsetLoanId].borrowerTokenId);
            delete s.offsetOfferToLoanId[offerId];
            delete s.loanToOffsetOfferId[lockedOffsetLoanId];
        }

        // (b) EarlyWithdrawal loan sale: release the lender position NFT.
        uint256 lockedSaleLoanId = s.saleOfferToLoanId[offerId];
        if (lockedSaleLoanId != 0) {
            LibERC721._unlock(s.loans[lockedSaleLoanId].lenderTokenId);
            delete s.saleOfferToLoanId[offerId];
            delete s.loanToSaleOfferId[lockedSaleLoanId];
        }

        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        msg.sender,
                        offer.lendingAsset,
                        msg.sender,
                        offer.amount
                    ),
                    EscrowWithdrawFailed.selector
                );
            } else if (offer.assetType == LibVaipakam.AssetType.ERC721) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC721.selector,
                        msg.sender,
                        offer.lendingAsset,
                        offer.tokenId,
                        msg.sender
                    ),
                    EscrowWithdrawFailed.selector
                );
            } else if (offer.assetType == LibVaipakam.AssetType.ERC1155) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC1155.selector,
                        msg.sender,
                        offer.lendingAsset,
                        offer.tokenId,
                        offer.quantity,
                        msg.sender
                    ),
                    EscrowWithdrawFailed.selector
                );
            }
        } else {
            // Borrower: Unlock what was actually deposited during createOffer
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                // ERC-20 loan: collateral was deposited based on collateralAssetType
                if (offer.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC20.selector,
                            msg.sender,
                            offer.collateralAsset,
                            msg.sender,
                            offer.collateralAmount
                        ),
                        EscrowWithdrawFailed.selector
                    );
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC721.selector,
                            msg.sender,
                            offer.collateralAsset,
                            offer.collateralTokenId,
                            msg.sender
                        ),
                        EscrowWithdrawFailed.selector
                    );
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC1155.selector,
                            msg.sender,
                            offer.collateralAsset,
                            offer.collateralTokenId,
                            offer.collateralQuantity,
                            msg.sender
                        ),
                        EscrowWithdrawFailed.selector
                    );
                }
            } else if (
                offer.assetType == LibVaipakam.AssetType.ERC721 ||
                offer.assetType == LibVaipakam.AssetType.ERC1155
            ) {
                // NFT rental borrower offer: ERC-20 prepayment was deposited
                uint256 prepayAmount = offer.amount * offer.durationDays;
                uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps()) /
                    LibVaipakam.BASIS_POINTS;
                uint256 totalPrepay = prepayAmount + buffer;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        msg.sender,
                        offer.prepayAsset,
                        msg.sender,
                        totalPrepay
                    ),
                    EscrowWithdrawFailed.selector
                );
            }
        }

        // Burn position NFT (not the underlying asset tokenId)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                offer.positionTokenId
            ),
            NFTBurnFailed.selector
        );

        // Stamp the cancel marker BEFORE the delete so `offers[id]` going
        // zero isn't mistaken for "never existed" by readers. The `userOfferIds`
        // reverse index still contains the id — indexers that want to display
        // "cancelled" as a terminal state read this map.
        s.offerCancelled[offerId] = true;
        LibMetricsHooks.onOfferCancelled(offerId);
        delete s.offers[offerId];

        emit OfferCanceled(offerId, msg.sender);
    }

    /**
     * @notice Returns open offer IDs whose creator country is trade-compatible
     *         with `user`'s country. Paginated.
     * @dev Consults {ProfileFacet.getUserCountry} for both sides and
     *      {LibVaipakam.canTradeBetween} — the trade-pair allowance table is
     *      governance-configured via {ProfileFacet.setTradeAllowance}. Walks
     *      the `activeOfferIdsList` maintained by LibMetricsHooks (bounded by
     *      `activeOffersCount`), not the lifetime sequence, so cancelled and
     *      accepted offers are never inspected. Pagination lets callers bound
     *      the per-call work even on very large order books.
     * @param user The user whose country drives the filter.
     * @param offset Number of compatible open offers to skip.
     * @param limit  Maximum number of IDs to return.
     * @return offerIds Array of compatible, unaccepted offer IDs (length ≤ limit).
     * @return total   Number of currently open offers scanned (`activeOffersCount`).
     */
    function getCompatibleOffers(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory offerIds, uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage src = s.activeOfferIdsList;
        total = src.length;
        if (limit == 0) return (new uint256[](0), total);

        string memory userCountry = ProfileFacet(address(this)).getUserCountry(user);
        uint256[] memory buffer = new uint256[](limit);
        uint256 skipped;
        uint256 filled;
        for (uint256 i = 0; i < total && filled < limit; ) {
            uint256 id = src[i];
            LibVaipakam.Offer storage offer = s.offers[id];
            string memory creatorCountry = ProfileFacet(address(this))
                .getUserCountry(offer.creator);
            if (LibVaipakam.canTradeBetween(userCountry, creatorCountry)) {
                if (skipped < offset) {
                    unchecked { ++skipped; }
                } else {
                    buffer[filled] = id;
                    unchecked { ++filled; }
                }
            }
            unchecked { ++i; }
        }

        offerIds = new uint256[](filled);
        for (uint256 j; j < filled; ) {
            offerIds[j] = buffer[j];
            unchecked { ++j; }
        }
    }

    // Internal helpers

    /**
     * @notice Thin wrapper around {EscrowFactoryFacet.getOrCreateUserEscrow}
     *         used to cross the facet boundary through the diamond fallback
     *         (which sets `msg.sender == address(this)` for the onlyDiamondInternal-free
     *         factory method).
     * @dev Reverts GetUserEscrowFailed on cross-facet call failure.
     * @param user The user whose escrow to resolve (created lazily).
     * @return proxy The user's escrow proxy address.
     */
    function getUserEscrow(address user) public returns (address proxy) {
        bool success;
        bytes memory result;
        (success, result) = address(this).call(
            abi.encodeWithSelector(
                EscrowFactoryFacet.getOrCreateUserEscrow.selector,
                user
            )
        );
        if (!success) revert GetUserEscrowFailed("Get User Escrow failed");
        proxy = abi.decode(result, (address));
        return (proxy);
    }

    // New Internal: Calculate transaction value in USD for KYC (liquid parts only)
    /// @dev Value = (lent amount if liquid * price) + (collateral amount if liquid * price). For NFTs, rental value = amount * durationDays if liquid (but NFTs illiquid, $0).
    ///      Scaled to 1e18 for threshold comparison.
    function _calculateTransactionValueUSD(
        LibVaipakam.Offer storage offer
    ) internal view returns (uint256 valueUSD) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Lent asset value if liquid
        LibVaipakam.LiquidityStatus lentLiquidity = OracleFacet(address(this))
            .checkLiquidity(offer.lendingAsset);
        if (lentLiquidity == LibVaipakam.LiquidityStatus.Liquid) {
            (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
                .getAssetPrice(offer.lendingAsset);
            uint8 tokenDecimals = IERC20Metadata(offer.lendingAsset).decimals();
            valueUSD += (offer.amount * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        } else if (offer.assetType != LibVaipakam.AssetType.ERC20) {
            // For NFT rentals: Rental value = amount (fee) * durationDays, but since illiquid, $0
            valueUSD += 0;
        }

        // Collateral value if liquid.
        // For lender-sale vehicle offers (collateralAmount == 0), use the live
        // loan's actual collateral amount so KYC is not undercounted.
        uint256 effectiveCollateral = offer.collateralAmount;
        uint256 linkedLoanId = s.saleOfferToLoanId[offer.id];
        if (linkedLoanId != 0 && effectiveCollateral == 0) {
            effectiveCollateral = s.loans[linkedLoanId].collateralAmount;
        }

        LibVaipakam.LiquidityStatus collLiquidity = OracleFacet(address(this))
            .checkLiquidity(offer.collateralAsset);
        if (collLiquidity == LibVaipakam.LiquidityStatus.Liquid) {
            (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
                .getAssetPrice(offer.collateralAsset);
            uint8 tokenDecimals = IERC20Metadata(offer.collateralAsset).decimals();
            valueUSD += (effectiveCollateral * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        }
    }

    /**
     * @notice Gets details of an offer.
     * @dev View function for off-chain/test queries. Returns full Offer struct.
     * @param offerId The offer ID.
     * @return offer The Offer struct.
     */
    function getOffer(
        uint256 offerId
    ) external view returns (LibVaipakam.Offer memory offer) {
        return LibVaipakam.storageSlot().offers[offerId];
    }

    /// @notice README §13.3 alias for {getOffer}. Returns the full Offer struct.
    function getOfferDetails(
        uint256 offerId
    ) external view returns (LibVaipakam.Offer memory) {
        return LibVaipakam.storageSlot().offers[offerId];
    }
}
