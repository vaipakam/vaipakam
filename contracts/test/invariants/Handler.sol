// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {defaultAdapterCalls} from "../helpers/AdapterCallHelpers.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "../helpers/LibAcceptTestSigner.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {defaultQuote, liquidationQuote} from "../helpers/ForcedSaleQuote.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../../src/facets/EarlyWithdrawalDirectFacet.sol";
import {RepayPeriodicFacet} from "../../src/facets/RepayPeriodicFacet.sol";
import {ForcedSaleFacet} from "../../src/facets/ForcedSaleFacet.sol";
import {ForcedSalePreviewFacet} from "../../src/facets/ForcedSalePreviewFacet.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {AutoLifecycleFacet} from "../../src/facets/AutoLifecycleFacet.sol";
import {RefinancePayoffPermitHelper} from "../helpers/RefinancePayoffPermitHelper.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibTestTiming} from "../helpers/LibTestTiming.sol";

/**
 * @title Handler
 * @notice Shared stateful fuzz handler for Vaipakam invariant suites. Drives
 *         createOffer / acceptOffer / repay / partialRepay / addCollateral /
 *         triggerDefault / claim against a bounded actor set (3 lenders,
 *         3 borrowers), tracks ghost deposits and withdrawals per ERC-20
 *         asset, and exposes accessors the invariant suites read.
 *
 *         Fuzz surface is deliberately restricted to ERC-20-only offers
 *         (USDC principal, WETH collateral) so invariants over token flow
 *         and claim state remain tractable. NFT rental and illiquid paths
 *         are covered by scenario tests.
 */
contract Handler is Test {
    InvariantBase public base;
    address public diamond;
    address public usdc;
    address public weth;

    // Active (not-yet-accepted) lender offer IDs
    uint256[] public lenderOfferIds;
    // Active (not-yet-accepted) borrower offer IDs
    uint256[] public borrowerOfferIds;
    // All initiated loan IDs (may be Repaid/Defaulted/Settled later)
    uint256[] public loanIds;

    // Ghost bookkeeping — monotonically increasing flow counters.
    // Deposits: tokens moved from actors into diamond/vault scope.
    // Withdrawals: tokens moved out of that scope back to actors.
    mapping(address => uint256) public ghostDeposits;   // asset => cumulative in
    mapping(address => uint256) public ghostWithdrawals; // asset => cumulative out

    // Per-loan claim flags tracked independently of protocol state so
    // invariants can assert monotonicity and exclusivity without relying
    // on internal storage reads.
    mapping(uint256 => bool) public ghostClaimedLender;
    mapping(uint256 => bool) public ghostClaimedBorrower;
    /// @dev #3241 — loans an HF liquidation closed. A liquidation may close a
    ///      loan at any time (its trigger is the health factor, not the
    ///      clock), so the time-default suite skips these.
    mapping(uint256 => bool) public ghostLiquidated;
    /// @dev #3241 — loans whose lender position was sold at least once.
    mapping(uint256 => bool) public ghostSold;
    /// @dev #3241 — periodic-interest periods settled per loan (a just-stamp or a sale).
    mapping(uint256 => uint256) public ghostPeriodicSettled;
    /// @dev #3241 — loans a periodic settlement sold collateral from. That sale is the one path
    ///      that lowers an Active loan's collateral, so the monotonicity suite skips these.
    mapping(uint256 => bool) public ghostPeriodicSold;
    /// @dev #3241 — the loan an offset offer was posted to close (0 for an ordinary offer).
    mapping(uint256 => uint256) public ghostOffsetOf;
    /// @dev #3241 — the loan a refinance request was posted to replace (0 for an ordinary offer).
    mapping(uint256 => uint256) public ghostRefinanceOf;
    /// @dev #3241 — open NFT-rental offers. Kept apart from `lenderOfferIds` so a suite that has
    ///      not opted into rentals never sees one through the ERC-20 accept.
    uint256[] public rentalOfferIds;
    /// @dev #3241 — rentals are off unless the deployer turns them on ({enableRentals}).
    bool public rentalsEnabled;
    address internal immutable deployer;

    // Call-count telemetry surfaced to invariants for sanity / coverage.
    mapping(bytes32 => uint256) public callCount;

    constructor(InvariantBase _base) {
        base = _base;
        diamond = address(_base.diamond());
        usdc = _base.mockUsdc();
        weth = _base.mockWeth();
        deployer = msg.sender;
    }

    /// @notice #3241 — lets a suite opt into NFT rentals. Only the deployer may: the suites that
    ///         target this handler directly keep their ERC-20-only surface.
    function enableRentals() external {
        require(msg.sender == deployer, "Handler: deployer only");
        rentalsEnabled = true;
    }

    // ── Actor selection helpers ─────────────────────────────────────────
    function _lender(uint256 seed) internal view returns (address) {
        return base.lenderAt(seed);
    }
    function _borrower(uint256 seed) internal view returns (address) {
        return base.borrowerAt(seed);
    }

    // ── Handler actions ────────────────────────────────────────────────

    /// @notice Lender creates an ERC-20 lending offer (USDC principal, WETH collateral).
    function createLenderOffer(
        uint256 lenderSeed,
        uint256 amount,
        uint256 durationDays,
        uint256 rateBps,
        uint256 collateralAmount
    ) external {
        callCount["createLenderOffer"]++;
        address lender = _lender(lenderSeed);

        amount = bound(amount, 100 ether, 10_000 ether);
        durationDays = bound(durationDays, 1, 365);
        rateBps = bound(rateBps, 100, 2000);
        collateralAmount = bound(collateralAmount, 1 ether, 100 ether);

        // Pre-funded balance check — skip if lender has spent down their pool
        if (ERC20Mock(usdc).balanceOf(lender) < amount) return;

        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: usdc,
            amount: amount,
            interestRateBps: rateBps,
            collateralAsset: weth,
            collateralAmount: collateralAmount,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amount,
            interestRateBpsMax: rateBps,
            collateralAmountMax: collateralAmount,
            periodicInterestCadence: _cadenceFor(lenderSeed, amount, durationDays),
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });

        vm.prank(lender);
        try OfferCreateFacet(diamond).createOffer(p) returns (uint256 id) {
            lenderOfferIds.push(id);
            ghostDeposits[usdc] += amount;
        } catch {}
    }

    /// @notice Borrower creates an ERC-20 borrow request (WETH collateral posted up-front).
    function createBorrowerOffer(
        uint256 borrowerSeed,
        uint256 amount,
        uint256 durationDays,
        uint256 rateBps,
        uint256 collateralAmount
    ) external {
        callCount["createBorrowerOffer"]++;
        address borrower = _borrower(borrowerSeed);

        amount = bound(amount, 100 ether, 10_000 ether);
        durationDays = bound(durationDays, 1, 365);
        rateBps = bound(rateBps, 100, 2000);
        collateralAmount = bound(collateralAmount, 1 ether, 100 ether);

        if (ERC20Mock(weth).balanceOf(borrower) < collateralAmount) return;

        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: usdc,
            amount: amount,
            interestRateBps: rateBps,
            collateralAsset: weth,
            collateralAmount: collateralAmount,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amount,
            interestRateBpsMax: rateBps,
            collateralAmountMax: collateralAmount,
            periodicInterestCadence: _cadenceFor(borrowerSeed, amount, durationDays),
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });

        vm.prank(borrower);
        try OfferCreateFacet(diamond).createOffer(p) returns (uint256 id) {
            borrowerOfferIds.push(id);
            ghostDeposits[weth] += collateralAmount;
        } catch {}
    }

    /// @notice Borrower accepts an open lender offer — collateral posted on accept.
    function acceptLenderOffer(uint256 borrowerSeed, uint256 offerIdx) external {
        callCount["acceptLenderOffer"]++;
        if (lenderOfferIds.length == 0) return;
        address borrower = _borrower(borrowerSeed);
        uint256 idx = bound(offerIdx, 0, lenderOfferIds.length - 1);
        uint256 offerId = lenderOfferIds[idx];

        LibVaipakam.Offer memory o = OfferCancelFacet(diamond).getOffer(offerId);
        if (o.accepted || o.creator == address(0)) {
            _popOfferAt(lenderOfferIds, idx);
            return;
        }
        if (ERC20Mock(weth).balanceOf(borrower) < o.collateralAmount) return;

        // #662 — accept now requires an acceptor-signed AcceptTerms. Build +
        // sign as the borrower (view-only) before the pranked external call so
        // the try/catch still observes the protocol-level accept outcome.
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(diamond, borrower, offerId, true, ghostOffsetOf[offerId]);
        bytes memory sig =
            LibAcceptTestSigner.sign(diamond, t, base.borrowerPkAt(borrowerSeed));
        vm.prank(borrower);
        try OfferAcceptFacet(diamond).acceptOffer(offerId, t, sig) returns (uint256 loanId) {
            loanIds.push(loanId);
            ghostDeposits[weth] += o.collateralAmount;
            ghostWithdrawals[usdc] += o.amount; // principal leaves vault to borrower wallet
            _popOfferAt(lenderOfferIds, idx);
        } catch {}
    }

    /// @notice Lender accepts an open borrower request — principal funded on accept.
    function acceptBorrowerOffer(uint256 lenderSeed, uint256 offerIdx) external {
        callCount["acceptBorrowerOffer"]++;
        if (borrowerOfferIds.length == 0) return;
        address lender = _lender(lenderSeed);
        uint256 idx = bound(offerIdx, 0, borrowerOfferIds.length - 1);
        uint256 offerId = borrowerOfferIds[idx];

        LibVaipakam.Offer memory o = OfferCancelFacet(diamond).getOffer(offerId);
        if (o.accepted || o.creator == address(0)) {
            _popOfferAt(borrowerOfferIds, idx);
            return;
        }
        if (ERC20Mock(usdc).balanceOf(lender) < o.amount) return;

        // #662 — accept now requires an acceptor-signed AcceptTerms. Build +
        // sign as the lender (view-only) before the pranked external call.
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(diamond, lender, offerId, true, 0);
        bytes memory sig =
            LibAcceptTestSigner.sign(diamond, t, base.lenderPkAt(lenderSeed));
        vm.prank(lender);
        try OfferAcceptFacet(diamond).acceptOffer(offerId, t, sig) returns (uint256 loanId) {
            loanIds.push(loanId);
            ghostDeposits[usdc] += o.amount;
            ghostWithdrawals[usdc] += o.amount; // principal flows lender→borrower through vault
            _popOfferAt(borrowerOfferIds, idx);
        } catch {}
    }

    /// @notice Borrower repays loan in full.
    function repay(uint256 loanIdx) external {
        callCount["repay"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        vm.prank(L.borrower);
        try RepayFacet(diamond).repayLoan(loanId) {
            // repayment funds flow borrower→lender through vault + collateral
            // released to borrower. We don't track exact amounts here — the
            // funds-conservation invariant reads balances directly.
        } catch {}
    }

    /// @notice Borrower makes a partial repayment.
    function repayPartial(uint256 loanIdx, uint256 amount) external {
        callCount["repayPartial"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        amount = bound(amount, 1 ether, L.principal);
        if (ERC20Mock(L.principalAsset).balanceOf(L.borrower) < amount) return;

        vm.prank(L.borrower);
        try RepayFacet(diamond).repayPartial(loanId, amount) {} catch {}
    }

    /// @notice Borrower closes an active loan early through the direct
    ///         preclose route (#3241): pays what is owed now, collateral
    ///         released.
    function precloseDirect(uint256 loanIdx) external {
        callCount["precloseDirect"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        vm.prank(L.borrower);
        try PrecloseFacet(diamond).precloseDirect(loanId) {} catch {}
    }

    /// @notice #3241 — the borrower of an active loan starts the preclose offset: it posts a lender
    ///         offer from its own principal (escrowed in its own vault, so nothing crosses
    ///         parties). When another borrower accepts that offer, the original loan closes in the
    ///         same transaction and its lender is paid. The offer joins the open lender offers,
    ///         so `acceptLenderOffer` is what completes it.
    function offsetLoan(uint256 loanIdx, uint256 rateBps, uint256 durationDays) external {
        callCount["offsetLoan"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;
        uint256 maturity = uint256(L.startTime) + L.durationDays * 1 days;
        if (maturity <= block.timestamp + 1 days) return;
        durationDays = bound(durationDays, 1, (maturity - block.timestamp) / 1 days);
        rateBps = bound(rateBps, 100, 2000);

        vm.prank(L.borrower);
        try PrecloseFacet(diamond).offsetWithNewOffer(
            loanId, rateBps, durationDays, L.collateralAsset, L.collateralAmount, true, L.prepayAsset
        ) returns (uint256 offerId) {
            lenderOfferIds.push(offerId);
            ghostOffsetOf[offerId] = loanId;
        } catch {}
    }

    /// @notice #3241 — the borrower of an active loan asks to refinance it: it consents to a rate
    ///         cap, posts a refinance request for the loan's principal on the loan's own
    ///         collateral (carried over, so nothing is pledged again), and attaches the payoff
    ///         permit that pays what the new lender's principal does not cover. Nothing crosses
    ///         parties. When a lender accepts the request, the replacement loan opens and the
    ///         original closes in the same transaction, so `acceptBorrowerOffer` completes it.
    function refinanceRequest(uint256 loanIdx, uint256 rateBps, uint256 durationDays) external {
        callCount["refinanceRequest"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;
        rateBps = bound(rateBps, 100, 2000);
        durationDays = bound(durationDays, 1, 365);

        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: L.principalAsset,
            amount: L.principal,
            interestRateBps: rateBps,
            collateralAsset: L.collateralAsset,
            collateralAmount: L.collateralAmount,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: L.prepayAsset,
            collateralAssetType: L.collateralAssetType,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: L.principal,
            interestRateBpsMax: rateBps,
            collateralAmountMax: L.collateralAmount,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Aon, // a refinance request is all-or-nothing
            refinanceTargetLoanId: loanId,
            useFullTermInterest: false
        });

        vm.startPrank(L.borrower);
        try AutoLifecycleFacet(diamond).setAutoRefinanceCaps(
            loanId, true, uint16(rateBps), uint64(block.timestamp + 400 days)
        ) {
            try OfferCreateFacet(diamond).createOffer(p) returns (uint256 offerId) {
                vm.stopPrank();
                RefinancePayoffPermitHelper.attach(diamond, L.borrower, L.principalAsset, offerId);
                borrowerOfferIds.push(offerId);
                ghostRefinanceOf[offerId] = loanId;
                return;
            } catch {}
        } catch {}
        vm.stopPrank();
    }

    /// @notice #3241 — a lender lists one of its rentable NFTs at a daily fee, prepaid in USDC.
    ///         The NFT moves from the lender's wallet into its own vault.
    function createRentalOffer(uint256 lenderSeed, uint256 tokenPick, uint256 dailyFee, uint256 durationDays)
        external
    {
        callCount["createRentalOffer"]++;
        if (!rentalsEnabled) return;
        address lender = _lender(lenderSeed);
        uint256 tokenId = (lenderSeed % 3) * 1000 + 1 + (tokenPick % base.RENTAL_TOKENS_PER_LENDER());
        address nft = base.mockNft();
        if (IERC721(nft).ownerOf(tokenId) != lender) return;
        dailyFee = bound(dailyFee, 1 ether, 100 ether);
        durationDays = bound(durationDays, 1, 60);

        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: nft,
            amount: dailyFee,
            interestRateBps: 0,
            collateralAsset: address(0),
            collateralAmount: 0,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC721,
            tokenId: tokenId,
            quantity: 1,
            creatorRiskAndTermsConsent: true,
            prepayAsset: usdc,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: dailyFee,
            interestRateBpsMax: 0,
            collateralAmountMax: 0,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
        vm.prank(lender);
        try OfferCreateFacet(diamond).createOffer(p) returns (uint256 id) {
            rentalOfferIds.push(id);
        } catch {}
    }

    /// @notice #3241 — a borrower rents a listed NFT: the prepayment (rent for the whole term
    ///         plus the 5% buffer) moves from its wallet into its own vault, and it receives the
    ///         NFT's user rights. The NFT itself stays in the lender's vault.
    function acceptRentalOffer(uint256 borrowerSeed, uint256 offerIdx) external {
        callCount["acceptRentalOffer"]++;
        if (rentalOfferIds.length == 0) return;
        address borrower = _borrower(borrowerSeed);
        uint256 idx = bound(offerIdx, 0, rentalOfferIds.length - 1);
        uint256 offerId = rentalOfferIds[idx];

        LibVaipakam.Offer memory o = OfferCancelFacet(diamond).getOffer(offerId);
        if (o.accepted || o.creator == address(0)) {
            _popOfferAt(rentalOfferIds, idx);
            return;
        }
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(diamond, borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(diamond, t, base.borrowerPkAt(borrowerSeed));
        vm.prank(borrower);
        try OfferAcceptFacet(diamond).acceptOffer(offerId, t, sig) returns (uint256 loanId) {
            loanIds.push(loanId);
            _popOfferAt(rentalOfferIds, idx);
        } catch {}
    }

    /// @notice #3241 — the permissionless daily rent deduction on a rental: one agreed day's fee
    ///         from the renter's prepayment to the lender side, less the treasury's share.
    function autoDeductDaily(uint256 loanIdx) external {
        callCount["autoDeductDaily"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];
        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;
        if (L.assetType == LibVaipakam.AssetType.ERC20) return;
        try RepayPeriodicFacet(diamond).autoDeductDaily(loanId) {} catch {}
    }

    /// @notice The lender of an active loan sells the position into a standing
    ///         lender offer (#3241, the direct early-withdrawal route). The
    ///         buyer becomes the lender; the loan itself carries on.
    function sellLoan(uint256 loanIdx, uint256 offerIdx) external {
        callCount["sellLoan"]++;
        if (loanIds.length == 0 || lenderOfferIds.length == 0) return;
        uint256 loanId = loanIds[bound(loanIdx, 0, loanIds.length - 1)];
        uint256 oIdx = bound(offerIdx, 0, lenderOfferIds.length - 1);
        uint256 offerId = lenderOfferIds[oIdx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        LibTestTiming.waitOutTermsAge(diamond, offerId); // #3443
        vm.prank(L.lender);
        try EarlyWithdrawalDirectFacet(diamond).sellLoanViaBuyOffer(loanId, offerId) {
            ghostSold[loanId] = true;
            _popOfferAt(lenderOfferIds, oIdx);
        } catch {}
    }

    /// @notice Borrower tops up collateral on an active loan.
    function addCollateral(uint256 loanIdx, uint256 amount) external {
        callCount["addCollateral"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        amount = bound(amount, 1 ether, 50 ether);
        if (ERC20Mock(L.collateralAsset).balanceOf(L.borrower) < amount) return;

        vm.prank(L.borrower);
        try AddCollateralFacet(diamond).addCollateral(loanId, amount) {
            ghostDeposits[L.collateralAsset] += amount;
        } catch {}
    }

    /// @notice Warps time forward and attempts default trigger past the grace window.
    function triggerDefault(uint256 loanIdx) external {
        callCount["triggerDefault"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        // Jump past duration + generous grace so the call has a chance to
        // land. Only warp FORWARD — an absolute warp could rewind the clock
        // relative to other handler calls and retroactively violate timing
        // invariants on previously-defaulted long-duration loans.
        uint256 target = L.startTime + L.durationDays * 1 days + 30 days;
        if (target > block.timestamp) vm.warp(target);

        uint256 sellQuote = defaultQuote(diamond, loanId);
        try DefaultedFacet(diamond).triggerDefault(loanId, sellQuote, defaultAdapterCalls()) {} catch {}
    }

    /// @notice #3241 — a Health-Factor liquidation. The loan's health factor
    ///         reads below 1 for this one call (every other read keeps the
    ///         rig's healthy 2.0), and the rig's one venue fails, so the
    ///         liquidation lands in the in-kind fallback. Permissionless: the
    ///         handler calls it, as a keeper would.
    function triggerLiquidation(uint256 loanIdx) external {
        callCount["triggerLiquidation"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        bytes memory hfCall = abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId);
        vm.mockCall(diamond, hfCall, abi.encode(uint256(0.9e18)));
        try this.quoteLiquidation(loanId) returns (uint256 sellQuote) {
            try RiskFacet(diamond).triggerLiquidation(loanId, sellQuote, defaultAdapterCalls()) {
                ghostLiquidated[loanId] = true;
            } catch {}
        } catch {}
        vm.mockCall(diamond, hfCall, abi.encode(uint256(2e18)));
    }

    /// @dev External so a quote that reverts is caught rather than failing the run.
    function quoteLiquidation(uint256 loanId) external view returns (uint256) {
        return liquidationQuote(diamond, loanId);
    }

    /// @notice #3241 — settle a periodic-interest period. Warps to the end of the period's grace
    ///         if it is not there yet, then settles. With the period's interest already paid this
    ///         only advances the checkpoint; otherwise it sells the least collateral that covers
    ///         the shortfall through the working venue (adapter index 1), at the quantity the
    ///         forced-sale preview sizes. Permissionless: the handler calls it, as a keeper would.
    function settlePeriodic(uint256 loanIdx) external {
        callCount["settlePeriodic"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;
        if (L.periodicInterestCadence == LibVaipakam.PeriodicInterestCadence.None) return;

        (,, uint256 graceEndsAt,,,,) = RepayPeriodicFacet(diamond).previewPeriodicSettle(loanId);
        if (graceEndsAt > block.timestamp) vm.warp(graceEndsAt);

        uint256 sell = ForcedSalePreviewFacet(diamond)
            .previewForcedSale(loanId, ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement).sell;
        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](1);
        calls[0] = LibSwap.AdapterCall({adapterIdx: 1, data: bytes("")});
        try RepayPeriodicFacet(diamond).settlePeriodicInterest(loanId, sell, calls) {
            ghostPeriodicSettled[loanId]++;
            if (_getLoan(loanId).collateralAmount < L.collateralAmount) ghostPeriodicSold[loanId] = true;
        } catch {}
    }

    /// @notice Lender claims on a defaulted / fallback-pending loan.
    function claimAsLender(uint256 loanIdx) external {
        callCount["claimAsLender"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (ghostClaimedLender[loanId]) return;

        vm.prank(L.lender);
        try ClaimFacet(diamond).claimAsLender(loanId) {
            ghostClaimedLender[loanId] = true;
        } catch {}
    }

    /// @notice Borrower claims repaid collateral.
    function claimAsBorrower(uint256 loanIdx) external {
        callCount["claimAsBorrower"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (ghostClaimedBorrower[loanId]) return;

        vm.prank(L.borrower);
        try ClaimFacet(diamond).claimAsBorrower(loanId) {
            ghostClaimedBorrower[loanId] = true;
        } catch {}
    }

    /// @notice Time jump only — lets fuzz sequences interleave age without a state change.
    function warp(uint256 delta) external {
        callCount["warp"]++;
        delta = bound(delta, 1 hours, 30 days);
        vm.warp(block.timestamp + delta);
    }

    // ── Accessors for invariant suites ──────────────────────────────────

    function loanIdsLength() external view returns (uint256) {
        return loanIds.length;
    }

    function loanIdAt(uint256 i) external view returns (uint256) {
        return loanIds[i];
    }

    function lenderOfferIdsLength() external view returns (uint256) {
        return lenderOfferIds.length;
    }

    function rentalOfferIdsLength() external view returns (uint256) {
        return rentalOfferIds.length;
    }

    function borrowerOfferIdsLength() external view returns (uint256) {
        return borrowerOfferIds.length;
    }

    // ── Internals ──────────────────────────────────────────────────────

    /// @dev #3241 — about half the offers long enough for it, and at or above the $1,000
    ///      finer-cadence threshold the base sets, carry a monthly cadence. The bit is a hash of
    ///      the fuzzed inputs, not a slice of the seed: the fuzzer favours edge values (0, 1, the
    ///      maximum), whose low bits barely vary, and a slice left the path almost never taken.
    function _cadenceFor(uint256 seed, uint256 amount, uint256 durationDays)
        internal
        pure
        returns (LibVaipakam.PeriodicInterestCadence)
    {
        if (durationDays > 30 && amount >= 1_000 ether && uint256(keccak256(abi.encode(seed, amount, durationDays))) % 2 == 1) {
            return LibVaipakam.PeriodicInterestCadence.Monthly;
        }
        return LibVaipakam.PeriodicInterestCadence.None;
    }

    function _getLoan(uint256 loanId) internal view returns (LibVaipakam.Loan memory L) {
        L = LoanFacet(diamond).getLoanDetails(loanId);
    }

    function _popOfferAt(uint256[] storage arr, uint256 idx) internal {
        uint256 last = arr.length - 1;
        if (idx != last) arr[idx] = arr[last];
        arr.pop();
    }
}
