// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {TreasuryFeeFacet} from "../src/facets/TreasuryFeeFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibDelivery} from "../src/libraries/LibDelivery.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {FeeOnTransferERC20Mock} from "./mocks/FeeOnTransferERC20Mock.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ZeroExProxyMock} from "./mocks/ZeroExProxyMock.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {defaultQuote, liquidationQuote} from "./helpers/ForcedSaleQuote.sol";

/// @dev Exposes {LibDelivery.pullExact}, which only libraries reach.
contract LibDeliveryHarness {
    function pullExact(address token, address from, address to, uint256 amount) external {
        LibDelivery.pullExact(token, from, to, amount);
    }
}

/**
 * @title  MeasuredDeliveryTest
 * @notice #2440 / #667 / #1281-011 — the protocol books only what arrived.
 *         A token that delivers less than it sends (here one that starts
 *         charging a 1% fee on transfer AFTER the loan opened, the realistic
 *         way such a token reaches a live position) must never make the books
 *         name tokens that are not there, and a close-out must never make up a
 *         short delivery from tokens the Diamond holds for anyone else.
 *
 *         The three outcomes of `LibDelivery`, one cell family each:
 *         - FORCED close-outs act on what arrived: the liquid default, the HF
 *           liquidation, the fallback entry, the fallback retry (sold and
 *           restored), the in-kind default and the rental default. Each cell
 *           seeds the Diamond with `OTHER` of the same token, standing for
 *           tokens it holds for other users, and asserts the close-out left
 *           exactly `OTHER` there. Before #2440 each of these sold, forwarded
 *           or credited the RECORDED amount, so the difference came out of
 *           `OTHER` (or, for a vault credit, left a claim the vault could not
 *           pay).
 *         - VOLUNTARY flows and WALLET payments are refused by name
 *           (`TokenDeliveryShort`): the rental preclose, a repayment and a
 *           collateral deposit at acceptance (#667: the lien can never exceed
 *           what the vault received, because a short deposit opens no loan).
 *         - The treasury fee host accrues what reached the treasury, and is
 *           reachable only through the Diamond.
 *
 *         Plus the rental preclose defect fixed on the way: the lender's
 *         rental share reached the lender's vault untracked, so the lender's
 *         claim could not be paid.
 *
 * @dev    The fee is switched on by etching `FeeOnTransferERC20Mock`'s code
 *         over the live `ERC20Mock`: the mock only APPENDS state (the fee and
 *         an optional charged sender), so every balance and allowance carries
 *         over. With a charged sender set, only transfers out of that address
 *         are charged, which isolates the one leg under test (the vault
 *         withdrawal) from the swap venue after it.
 */
contract MeasuredDeliveryTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant LENDER_TOKEN_ID = 7777;
    uint256 internal constant BORROWER_TOKEN_ID = 8888;
    uint256 internal constant PRINCIPAL = 500 ether;
    uint256 internal constant COLLATERAL = 1_000 ether;
    /// @dev Tokens of the same asset the Diamond holds for other users.
    uint256 internal constant OTHER = 777 ether;
    uint256 internal constant FEE_BPS = 100; // 1%

    // Rental shape (7 days at 10 a day, 5% buffer).
    uint256 internal constant DAILY_FEE = 10 ether;
    uint256 internal constant RENTAL_DAYS = 7;

    address internal col;
    address internal bVault;

    function setUp() public {
        setupHelper();
        col = mockCollateralERC20;
        bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
    }

    // -- Helpers ------------------------------------------------------------

    /// @dev `token` starts charging FEE_BPS on transfer, on every transfer
    ///      (`onlyFrom == 0`) or only on transfers out of `onlyFrom`.
    function _chargesFee(address token, address onlyFrom) internal {
        vm.etch(token, address(new FeeOnTransferERC20Mock("FoT", "FOT", 18)).code);
        FeeOnTransferERC20Mock(token).setFeeBps(FEE_BPS);
        FeeOnTransferERC20Mock(token).setChargedSender(onlyFrom);
        assertEq(FeeOnTransferERC20Mock(token).feeBps(), FEE_BPS, "fixture: the fee is on");
    }

    /// @dev What one charged transfer of `x` delivers.
    function _less(uint256 x) internal pure returns (uint256) {
        return x - (x * FEE_BPS) / 10_000;
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _tracked(address user, address token) internal view returns (uint256) {
        return VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(user, token);
    }

    function _vault(address user) internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user);
    }

    /// @dev An Active zero-rate 30-day ERC-20 loan (`mockERC20` principal,
    ///      `col` collateral) with real position NFTs held by the stored
    ///      parties and the collateral liened in the borrower's vault, as loan
    ///      initiation leaves it. `liquid` = both legs liquid at par (the swap
    ///      branches); otherwise both illiquid with both parties' consent (the
    ///      in-kind branch). The Diamond also holds `OTHER` of the collateral.
    function _scaffold(bool liquid) internal {
        TestMutatorFacet(address(diamond)).mintNFTRaw(lender, LENDER_TOKEN_ID);
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrower, BORROWER_TOKEN_ID);
        vm.startPrank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(
            LENDER_TOKEN_ID, LOAN, LibVaipakam.LoanPositionStatus.LoanInitiated
        );
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(
            BORROWER_TOKEN_ID, LOAN, LibVaipakam.LoanPositionStatus.LoanInitiated
        );
        vm.stopPrank();

        LibVaipakam.LiquidityStatus liq =
            liquid ? LibVaipakam.LiquidityStatus.Liquid : LibVaipakam.LiquidityStatus.Illiquid;

        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = mockERC20;
        l.principal = PRINCIPAL;
        l.collateralAsset = col;
        l.collateralAmount = COLLATERAL;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.interestRateBps = 0;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.lenderTokenId = LENDER_TOKEN_ID;
        l.borrowerTokenId = BORROWER_TOKEN_ID;
        l.liquidationLtvBpsAtInit = 8_500;
        l.riskAndTermsConsentFromBoth = !liquid;
        l.principalLiquidity = liq;
        l.collateralLiquidity = liq;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);

        ERC20Mock(col).mint(bVault, COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower, col, COLLATERAL);
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            LOAN, borrower, col, 0, COLLATERAL, LibVaipakam.AssetType.ERC20
        );
        mockOracleLiquidity(col, liq);
        mockOracleLiquidity(mockERC20, liq);

        ERC20Mock(col).mint(address(diamond), OTHER);
    }

    function _pastGrace() internal {
        vm.warp(block.timestamp + 61 days);
    }

    /// @dev The one swap venue quotes nothing, so every route fails its floor
    ///      (and every attempt unwinds); `_swapsFill` puts SetupTest's rate back.
    function _failEverySwap() internal {
        ZeroExProxyMock(mockZeroExProxy).setRate(0, 1);
    }

    function _swapsFill() internal {
        ZeroExProxyMock(mockZeroExProxy).setRate(11, 10);
    }

    function _status() internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(LOAN).status;
    }

    function _row() internal view returns (uint256 row) {
        (row, ) = FallbackCustodyFacet(address(diamond)).getFallbackCustody(LOAN);
    }

    function _snapshot() internal view returns (uint256 lc, uint256 tc, uint256 bc) {
        (lc, tc, bc, , , , ) = ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
    }

    function _lien() internal view returns (uint256 amount) {
        (amount, ) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(LOAN);
    }

    /// @dev The loan's paid-through mark (`lenderInterestDeliveredThroughAt`),
    ///      which has no getter: slot 480 of the Diamond's namespace, per
    ///      `storage-layout/layout.golden.json`. Every cell that reads it first
    ///      proves the slot by writing a known value through the mutator.
    function _paidThrough(uint256 loanId) internal view returns (uint256) {
        bytes32 slot = keccak256(abi.encode(loanId, uint256(LibVaipakam.VANGKI_STORAGE_POSITION) + 480));
        return uint256(vm.load(address(diamond), slot));
    }

    /// @dev The fallback custody fixture: a liquid default whose every swap
    ///      route fails, so the producer returns the collateral to the
    ///      borrower's vault under the lien. Fixture-live: FallbackPending and
    ///      the row, the vault, the snapshot and the lien all name one figure.
    function _enterFallback() internal returns (uint256 row) {
        _pastGrace();
        _failEverySwap();
        uint256 sellQuote = defaultQuote(address(diamond), LOAN);
        vm.prank(makeAddr("defaultKeeper"));
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, sellQuote, defaultAdapterCalls());
        _swapsFill();

        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.FallbackPending), "fixture: FallbackPending");
        row = _row();
        (uint256 lc, uint256 tc, uint256 bc) = _snapshot();
        assertEq(lc + tc + bc, row, "fixture: the snapshot splits the row exactly");
        assertEq(_bal(col, bVault), row, "fixture: the vault holds the row");
        assertEq(_lien(), row, "fixture: one lien over the row");
    }

    // -- Forced close-outs act on what arrived ------------------------------

    /// @notice A liquid time-based default whose collateral withdrawal lands
    ///         short sells only what reached the Diamond.
    /// @dev    Kills: the default selling the recorded collateral, which draws
    ///         the shortfall out of `OTHER`.
    function test_LiquidDefault_SellsOnlyWhatArrived() public {
        _scaffold(true);
        _pastGrace();
        _chargesFee(col, bVault);

        uint256 sellQuote = defaultQuote(address(diamond), LOAN);
        vm.prank(makeAddr("defaultKeeper"));
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, sellQuote, defaultAdapterCalls());

        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Defaulted), "the default completed");
        assertEq(_bal(col, address(diamond)), OTHER, "the Diamond's other holdings paid nothing");
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount,
            _less(COLLATERAL),
            "the loan's collateral is what arrived"
        );
        assertEq(_bal(col, bVault), 0, "the vault gave up the whole collateral");
        assertEq(_tracked(borrower, col), 0, "and its tracked balance with it");
    }

    /// @notice An HF liquidation whose collateral withdrawal lands short sells
    ///         only what reached the Diamond.
    /// @dev    Kills: the liquidation selling the recorded collateral.
    function test_HfLiquidation_SellsOnlyWhatArrived() public {
        _scaffold(true);
        _chargesFee(col, bVault);
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.sequencerHealthy.selector), abi.encode(true));
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN),
            abi.encode(uint256(0.9e18))
        );

        uint256 sellQuote = liquidationQuote(address(diamond), LOAN);
        vm.prank(makeAddr("liquidator"));
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, sellQuote, defaultAdapterCalls());

        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Defaulted), "the liquidation completed");
        assertEq(_bal(col, address(diamond)), OTHER, "the Diamond's other holdings paid nothing");
        assertEq(_bal(col, bVault), 0, "the vault gave up the whole collateral");
        assertEq(_tracked(borrower, col), 0, "and its tracked balance with it");
    }

    /// @notice When every swap route fails, the fallback custody the producer
    ///         returns to the borrower's vault is booked at what the vault
    ///         received, through both short hops (vault to Diamond, Diamond
    ///         back to vault).
    /// @dev    Kills: the row, the snapshot or the lien naming the recorded
    ///         collateral, and the return deposit drawing on `OTHER`.
    function test_FallbackEntry_CustodyIsWhatTheVaultHolds() public {
        _scaffold(true);
        _chargesFee(col, address(0));

        uint256 row = _enterFallback();

        assertEq(row, _less(_less(COLLATERAL)), "the row is what came back through both hops");
        assertEq(_bal(col, address(diamond)), OTHER, "the Diamond's other holdings paid nothing");
        assertEq(_tracked(borrower, col), row, "the tracked balance is the vault's real balance");
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount,
            row,
            "the loan's collateral is the custody"
        );
    }

    /// @notice A claim-time retry that sells sells only what left the vault
    ///         and reached the Diamond.
    /// @dev    Kills: the retry selling the row rather than the arrival.
    function test_FallbackRetry_SellsOnlyWhatArrived() public {
        _scaffold(true);
        _chargesFee(col, bVault);
        uint256 row = _enterFallback();
        assertEq(row, _less(COLLATERAL), "fixture: only the vault's own transfers are charged");

        vm.prank(address(diamond));
        (bool ok, ) = FallbackCustodyFacet(address(diamond)).retryFallbackSwap(LOAN, defaultAdapterCalls());

        assertTrue(ok, "the retry sold");
        assertEq(_row(), 0, "the row is spent");
        assertEq(_bal(col, bVault), 0, "the vault gave up the custody");
        assertEq(_bal(col, address(diamond)), OTHER, "the Diamond's other holdings paid nothing");
    }

    /// @notice A claim-time retry that fails restores less than it pulled; the
    ///         snapshot gives up the difference from the borrower's slice
    ///         first, so the lender's slice is untouched, and the row, the
    ///         vault, the snapshot and the lien still agree.
    /// @dev    Kills: a restore booked at the pulled figure (the row then names
    ///         tokens the vault does not hold, and the in-kind split debits
    ///         past it), and a shortfall taken from the lender before the
    ///         borrower (owner decision 2026-10-20, lender first).
    function test_FallbackRetry_FailedRestore_BorrowerSliceAbsorbsTheShortfall() public {
        _scaffold(true);
        _chargesFee(col, address(0));
        uint256 row = _enterFallback();
        (uint256 lc0, uint256 tc0, uint256 bc0) = _snapshot();
        uint256 restored = _less(_less(row));
        assertGt(bc0, row - restored, "fixture: the borrower slice covers the round trip's loss");

        _failEverySwap();
        vm.prank(address(diamond));
        (bool ok, ) = FallbackCustodyFacet(address(diamond)).retryFallbackSwap(LOAN, defaultAdapterCalls());
        _swapsFill();

        assertFalse(ok, "the retry failed");
        assertEq(_row(), restored, "the row is what came back");
        assertEq(_bal(col, bVault), restored, "the vault holds the row");
        assertEq(_lien(), restored, "the lien is the row");
        (uint256 lc, uint256 tc, uint256 bc) = _snapshot();
        assertEq(lc, lc0, "the lender's slice is untouched");
        assertEq(tc, tc0, "the treasury's slice is untouched");
        assertEq(bc, bc0 - (row - restored), "the borrower's slice absorbed the shortfall");
        assertEq(lc + tc + bc, restored, "the snapshot still splits the row exactly");
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount,
            restored,
            "the loan's collateral follows the row"
        );
        assertEq(_bal(col, address(diamond)), OTHER, "the Diamond's other holdings paid nothing");
    }

    /// @notice An in-kind default credits the lender's vault, and names the
    ///         lender's claim, at what that vault received, so the claim pays.
    /// @dev    Kills: the claim naming the recorded collateral, which the
    ///         lender's vault cannot pay (the claim reverts).
    function test_InKindDefault_LenderClaimIsWhatTheVaultReceived() public {
        _scaffold(false);
        _pastGrace();
        _chargesFee(col, address(0));
        address lVault = _vault(lender);
        uint256 lVault0 = _bal(col, lVault);

        uint256 sellQuote = defaultQuote(address(diamond), LOAN);
        vm.prank(makeAddr("defaultKeeper"));
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, sellQuote, defaultAdapterCalls());

        assertEq(uint8(_status()), uint8(LibVaipakam.LoanStatus.Defaulted), "the default completed");
        (, uint256 claim, ) = ClaimFacet(address(diamond)).getClaimableAmount(LOAN, true);
        assertEq(claim, _less(COLLATERAL), "the claim is what arrived");
        assertEq(_bal(col, lVault) - lVault0, claim, "the lender's vault holds the claim");
        assertEq(_tracked(lender, col), claim, "and tracks it");

        uint256 wallet0 = _bal(col, lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        assertEq(_bal(col, lender) - wallet0, _less(claim), "the claim paid (less the token's own fee)");
        assertEq(_tracked(lender, col), 0, "nothing is left on the books");
        assertEq(_bal(col, address(diamond)), OTHER, "the Diamond's other holdings paid nothing");
    }

    // -- Wallet payments are refused unless they arrive in full -------------

    /// @notice A repayment that would reach the lender short is refused by
    ///         name: the lender's claim is set at the full repayment.
    function test_Repay_RefusedUnlessAllArrives() public {
        _scaffold(true);
        vm.warp(block.timestamp + 10 days);
        _chargesFee(mockERC20, address(0));

        vm.expectPartialRevert(IVaipakamErrors.TokenDeliveryShort.selector);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(LOAN);
    }

    /// @notice #667 — a collateral deposit at acceptance that would reach the
    ///         borrower's vault short is refused by name, so no loan opens with
    ///         a lien over collateral the vault does not hold.
    function test_Accept_CollateralRefusedUnlessAllArrives() public {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(_lenderErc20Offer());
        _chargesFee(col, address(0));

        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        uint256 walletBefore = _bal(col, borrower);

        vm.expectPartialRevert(IVaipakamErrors.TokenDeliveryShort.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);

        assertEq(_bal(col, borrower), walletBefore, "nothing left the borrower's wallet");
    }

    /// @notice #2440 — the net principal delivered at acceptance must reach the
    ///         borrower in full: the loan records the borrower as owing the
    ///         whole principal, so a lending asset that delivers less than it
    ///         sends is refused at acceptance, as the collateral is.
    /// @dev    Kills: the borrower owing principal they never received.
    function test_Accept_PrincipalRefusedUnlessAllArrives() public {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(_lenderErc20Offer());
        _chargesFee(mockERC20, _vault(lender));

        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);

        vm.expectPartialRevert(IVaipakamErrors.TokenDeliveryShort.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    // -- Rentals ------------------------------------------------------------

    /// @notice The rental preclose credits the lender's rental share to the
    ///         lender's vault ON THE BOOKS, so the lender's claim pays.
    /// @dev    Kills: the share reaching the vault untracked (before #2440 the
    ///         claim's withdraw then underflowed the tracked balance).
    function test_RentalPreclose_LenderClaimPays() public {
        uint256 loanId = _openRental();
        vm.warp(block.timestamp + 2 days);
        address lVault = _vault(lender);
        uint256 tracked0 = _tracked(lender, mockERC20);

        vm.prank(borrower);
        PrecloseFacet(address(diamond)).precloseDirect(loanId);

        (, uint256 claim, ) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(claim, 0, "fixture: the lender has rent to claim");
        assertEq(_tracked(lender, mockERC20) - tracked0, claim, "the share is on the lender's books");

        uint256 wallet0 = _bal(mockERC20, lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertEq(_bal(mockERC20, lender) - wallet0, claim, "the lender's claim paid in full");
        assertEq(IERC721(mockNft721).ownerOf(1), lender, "and the NFT came home");
        assertEq(_tracked(lender, mockERC20), tracked0, "nothing is left on the books");
        assertEq(_bal(mockERC20, lVault), tracked0, "and nothing in the vault");
    }

    /// @notice The rental preclose is the borrower's own choice, so a share
    ///         that would reach the lender short is refused by name.
    function test_RentalPreclose_RefusedUnlessAllArrives() public {
        uint256 loanId = _openRental();
        vm.warp(block.timestamp + 2 days);
        _chargesFee(mockERC20, address(0));

        vm.expectPartialRevert(IVaipakamErrors.TokenDeliveryShort.selector);
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).precloseDirect(loanId);
    }

    /// @notice A rental default whose prepay withdrawal lands short takes the
    ///         shortfall from the treasury's fee before the lender's share, and
    ///         the lender's claim is what the lender's vault received.
    /// @dev    The treasury is an external address here (the documented
    ///         mainnet topology), so every move out of the Diamond is a real
    ///         transfer. Kills: the default forwarding the recorded prepay
    ///         (drawn from `OTHER`), and a shortfall taken from the lender.
    function test_RentalDefault_ShortfallFromTreasuryFeeFirst() public {
        address treasury = makeAddr("externalTreasury");
        AdminFacet(address(diamond)).setTreasury(treasury);
        uint256 loanId = _openRental();
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        ERC20Mock(mockERC20).mint(address(diamond), OTHER);
        uint256 diamond0 = _bal(mockERC20, address(diamond));
        vm.warp(uint256(l.startTime) + RENTAL_DAYS * 1 days + 1 days + 1);
        _chargesFee(mockERC20, address(0));
        address lVault = _vault(lender);
        uint256 lVault0 = _bal(mockERC20, lVault);

        uint256 sellQuote = defaultQuote(address(diamond), loanId);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, sellQuote, defaultAdapterCalls());

        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Defaulted),
            "the default completed"
        );
        assertEq(_bal(mockERC20, address(diamond)), diamond0, "the Diamond's other holdings paid nothing");
        uint256 treasuryFee = (l.prepayAmount * 200) / 10_000;
        uint256 shortfall = l.prepayAmount - _less(l.prepayAmount);
        assertLt(shortfall, treasuryFee, "fixture: the treasury fee covers the shortfall");
        (, uint256 claim, ) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claim, _less(l.prepayAmount - treasuryFee), "the lender's whole share, less the push's own fee");
        assertEq(_bal(mockERC20, lVault) - lVault0, claim, "the lender's vault holds the claim");
        assertEq(
            _bal(mockERC20, treasury),
            _less(l.bufferAmount) + _less(treasuryFee - shortfall),
            "the treasury bore the shortfall"
        );
    }

    /// @notice A rental day is booked as paid to the lender in full, so a
    ///         prepay token that starts charging on transfer stops the daily
    ///         deduction by name; the rental then settles through the
    ///         time-based default, which acts on what arrives.
    /// @dev    Kills: the daily deduction paying the lender short while the
    ///         prepay pool is debited the whole day.
    function test_RentalDailyDeduct_RefusedUnlessAllArrives() public {
        uint256 loanId = _openRental();
        vm.warp(block.timestamp + 1 days);

        uint256 snap = vm.snapshotState();
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(loanId);
        vm.revertToState(snap);

        _chargesFee(mockERC20, address(0));
        vm.expectPartialRevert(IVaipakamErrors.TokenDeliveryShort.selector);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(loanId);
    }

    /// @notice #2440 (Codex r3) — the clean branch pays the lender-position
    ///         holder's WALLET, and a reading at a wallet is trusted only to
    ///         refuse: its owner can lower it mid-transfer (a receiving hook
    ///         forwarding the tokens on) and would be paid again if the short
    ///         figure were booked. So a short arrival is refused there, in the
    ///         forced auto-liquidation too, and the paid-through mark does not
    ///         move. Kills: reporting what arrived and leaving the rest owed to
    ///         the same wallet.
    function test_ResidentLenderPayout_WalletShortRefused() public {
        _scaffold(true);
        uint256 amount = 100 ether;
        ERC20Mock(mockERC20).mint(address(diamond), amount);
        TestMutatorFacet(address(diamond)).setLenderPaidThroughWithPrincipalRaw(LOAN, 1, PRINCIPAL);
        assertEq(_paidThrough(LOAN), 1, "fixture: the slot read is the paid-through mark");
        _chargesFee(mockERC20, address(diamond));

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.TokenDeliveryShort.selector, mockERC20, amount, _less(amount)
            )
        );
        vm.prank(address(diamond));
        EncumbranceMutateFacet(address(diamond)).freezeOrPayActiveLenderResident(
            LOAN, mockERC20, amount, block.timestamp + 30 days
        );
        assertEq(_paidThrough(LOAN), 1, "the period stays open");
    }

    /// @notice The control for the cell above: a payout that arrives in full
    ///         reports the whole amount and marks the lender paid through.
    function test_ResidentLenderPayout_FullArrivalMarksPaidThrough() public {
        _scaffold(true);
        uint256 amount = 100 ether;
        ERC20Mock(mockERC20).mint(address(diamond), amount);
        TestMutatorFacet(address(diamond)).setLenderPaidThroughWithPrincipalRaw(LOAN, 1, PRINCIPAL);
        assertEq(_paidThrough(LOAN), 1, "fixture: the slot read is the paid-through mark");
        uint256 boundary = block.timestamp + 30 days;

        vm.prank(address(diamond));
        uint256 delivered = EncumbranceMutateFacet(address(diamond)).freezeOrPayActiveLenderResident(
            LOAN, mockERC20, amount, boundary
        );

        assertEq(delivered, amount, "the whole payout arrived");
        assertEq(_paidThrough(LOAN), boundary, "the lender is paid through the boundary");
    }

    // -- Voluntary flows refuse a short arrival at every hop ----------------

    /// @notice #2440 (Codex r2) — the rental repayment's SECOND hop, Diamond to
    ///         the lender's vault, is refused when it lands short, as its first
    ///         hop is: the lender's claim names the whole share.
    /// @dev    Only transfers out of the Diamond are charged, so the first hop
    ///         (borrower vault to Diamond) and the treasury fee arrive in full
    ///         and the refusal names exactly the second hop. Kills: the claim
    ///         shrinking to what the vault received while the loan closes as
    ///         repaid in full.
    function test_RentalRepay_LenderCreditRefusedUnlessAllArrives() public {
        uint256 loanId = _openRental();
        vm.warp(block.timestamp + RENTAL_DAYS * 1 days);

        uint256 snap = vm.snapshotState();
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        (, uint256 share, ) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(share, 0, "fixture: the lender has a rental share");
        vm.revertToState(snap);

        _chargesFee(mockERC20, address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.TokenDeliveryShort.selector, mockERC20, share, _less(share))
        );
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
    }

    /// @notice #2440 (Codex r2) — a swap-to-repay's lender proceeds are
    ///         deposited into the lender's vault in full or not at all: the
    ///         loan closes on that figure and the lender's claim names it.
    /// @dev    Kills: the claim and the reservation shrinking to what arrived.
    function test_SwapToRepayLenderProceeds_RefusedUnlessAllArrives() public {
        _scaffold(true);
        uint256 due = 100 ether;
        ERC20Mock(mockERC20).mint(address(diamond), due);
        _chargesFee(mockERC20, address(diamond));

        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.TokenDeliveryShort.selector, mockERC20, due, _less(due))
        );
        vm.prank(address(diamond));
        EncumbranceMutateFacet(address(diamond)).freezeLenderProceeds(LOAN, due);
    }

    /// @notice #2440 — the same swap-to-repay's principal surplus to the
    ///         borrower-position holder is refused when it lands short.
    function test_SwapToRepaySurplus_RefusedUnlessAllArrives() public {
        _scaffold(true);
        uint256 surplus = 40 ether;
        ERC20Mock(mockERC20).mint(address(diamond), surplus);
        _chargesFee(mockERC20, address(diamond));

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.TokenDeliveryShort.selector, mockERC20, surplus, _less(surplus)
            )
        );
        vm.prank(address(diamond));
        EncumbranceMutateFacet(address(diamond)).freezeOrPayBorrowerSurplus(LOAN, borrower, surplus);
    }

    // -- The treasury fee host ----------------------------------------------

    /// @notice Both legs of the fee host are reachable only by the Diamond.
    function test_TreasuryFeeHost_RefusesOutsideCallers() public {
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        TreasuryFeeFacet(address(diamond)).collectFeeFromPayer(borrower, mockERC20, 1 ether);
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        TreasuryFeeFacet(address(diamond)).collectFeeFromVault(borrower, mockERC20, 1 ether);
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        TreasuryFeeFacet(address(diamond)).collectFeeFromDiamond(mockERC20, 1 ether);
    }

    /// @notice #2440 (Codex r3) — a treasury share the Diamond holds (a
    ///         liquidation's handling fee, a settlement's interest cut) is
    ///         pushed to an EXTERNAL treasury and accrues what reached it,
    ///         never the requested figure, and the Diamond gives up exactly
    ///         the share. Kills: the twelve hand-written push-then-accrue
    ///         pairs this replaced, which accrued the requested figure.
    function test_TreasuryFeeHost_DiamondShareAccruesWhatArrived() public {
        address treasury = makeAddr("externalTreasury");
        AdminFacet(address(diamond)).setTreasury(treasury);
        ERC20Mock(mockERC20).mint(address(diamond), OTHER + 4 ether);
        _chargesFee(mockERC20, address(diamond));

        vm.prank(address(diamond));
        uint256 accrued = TreasuryFeeFacet(address(diamond)).collectFeeFromDiamond(mockERC20, 4 ether);

        assertEq(accrued, _less(4 ether), "the host returns what arrived");
        assertEq(_bal(mockERC20, treasury), accrued, "the treasury holds what it was credited with");
        assertEq(_bal(mockERC20, address(diamond)), OTHER, "the Diamond gave up exactly the share");
    }

    /// @notice #2623 — where the Diamond IS the treasury (SetupTest's
    ///         topology), a share it already holds is already where the
    ///         treasury keeps it: nothing moves, so a charging token takes no
    ///         fee out of the pooled balance, and the whole share accrues.
    ///         Kills: a self-transfer that hands the token its charge out of
    ///         tokens held for other users.
    function test_TreasuryFeeHost_DiamondAsTreasury_NothingMovesWholeShareAccrues() public {
        ERC20Mock(mockERC20).mint(address(diamond), OTHER + 4 ether);
        _chargesFee(mockERC20, address(diamond));
        uint256 accrued0 = TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);

        vm.recordLogs();
        vm.prank(address(diamond));
        uint256 accrued = TreasuryFeeFacet(address(diamond)).collectFeeFromDiamond(mockERC20, 4 ether);

        assertEq(accrued, 4 ether, "the whole share accrues");
        assertEq(
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20) - accrued0,
            4 ether,
            "the treasury balance names the whole share"
        );
        assertEq(_bal(mockERC20, address(diamond)), OTHER + 4 ether, "nothing left the Diamond");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(
                logs[i].emitter != mockERC20 || logs[i].topics[0] != keccak256("Transfer(address,address,uint256)"),
                "no token moved"
            );
        }
    }

    // -- The sender side ----------------------------------------------------

    /// @dev `token` starts charging FEE_BPS to the SENDER on top of each
    ///      transfer out of `onlyFrom`: the recipient receives the whole
    ///      amount, the sender loses the amount plus the fee.
    function _chargesFeeOnTop(address token, address onlyFrom) internal {
        _chargesFee(token, onlyFrom);
        FeeOnTransferERC20Mock(token).setFeeOnTop(true);
    }

    /// @notice #2440 (Codex r3) — a move out of the Diamond that cost it more
    ///         than it sent is refused, in every flow: the excess would come
    ///         out of tokens the Diamond holds for someone else, and a
    ///         receiver-side reading sees nothing wrong (the recipient got the
    ///         whole amount). Kills: measuring only the receiving end.
    function test_OverDebit_RefusedOutOfTheDiamond() public {
        // An external treasury, so the share really leaves the Diamond (where
        // the Diamond is the treasury nothing moves, see the #2623 cell).
        AdminFacet(address(diamond)).setTreasury(makeAddr("externalTreasury"));
        ERC20Mock(mockERC20).mint(address(diamond), OTHER + 4 ether);
        _chargesFeeOnTop(mockERC20, address(diamond));

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.TokenOverDebit.selector,
                mockERC20,
                4 ether,
                4 ether + (4 ether * FEE_BPS) / 10_000
            )
        );
        vm.prank(address(diamond));
        TreasuryFeeFacet(address(diamond)).collectFeeFromDiamond(mockERC20, 4 ether);
    }

    /// @notice The same out of a user's vault: the vault's other positions
    ///         would pay the excess, and its tracked balance would stay above
    ///         what it holds. Refused, a forced flow's withdrawal included.
    function test_OverDebit_RefusedOutOfAVault() public {
        ERC20Mock(mockERC20).mint(bVault, 10 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower, mockERC20, 10 ether);
        _chargesFeeOnTop(mockERC20, bVault);

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.TokenOverDebit.selector,
                mockERC20,
                4 ether,
                4 ether + (4 ether * FEE_BPS) / 10_000
            )
        );
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(borrower, mockERC20, lender, 4 ether);
    }

    /// @notice The control: an ordinary token costs its sender exactly what
    ///         it sent, so the same moves go through untouched.
    function test_OverDebit_OrdinaryTokenUnaffected() public {
        ERC20Mock(mockERC20).mint(bVault, 10 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower, mockERC20, 10 ether);
        vm.prank(address(diamond));
        uint256 delivered = VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(borrower, mockERC20, lender, 4 ether);
        assertEq(delivered, 4 ether, "delivered in full");
        assertEq(_bal(mockERC20, bVault), 6 ether, "the vault lost what it sent");
    }

    /// @notice A wallet fee accrues in full when it arrives in full, and is
    ///         refused by name when it would not.
    function test_TreasuryFeeHost_WalletFee() public {
        uint256 accrued0 = TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
        vm.prank(address(diamond));
        TreasuryFeeFacet(address(diamond)).collectFeeFromPayer(borrower, mockERC20, 3 ether);
        assertEq(
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20) - accrued0, 3 ether, "accrued in full"
        );

        _chargesFee(mockERC20, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.TokenDeliveryShort.selector, mockERC20, 3 ether, _less(3 ether)
            )
        );
        vm.prank(address(diamond));
        TreasuryFeeFacet(address(diamond)).collectFeeFromPayer(borrower, mockERC20, 3 ether);
    }

    /// @notice A vault fee never refuses: the treasury accrues, and the host
    ///         returns, what reached it, while the vault gives up the whole fee.
    function test_TreasuryFeeHost_VaultFeeAccruesWhatArrived() public {
        ERC20Mock(mockERC20).mint(bVault, 10 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower, mockERC20, 10 ether);
        _chargesFee(mockERC20, address(0));
        uint256 accrued0 = TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);

        vm.prank(address(diamond));
        uint256 accrued = TreasuryFeeFacet(address(diamond)).collectFeeFromVault(borrower, mockERC20, 4 ether);

        assertEq(accrued, _less(4 ether), "the host returns what arrived");
        assertEq(
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20) - accrued0,
            accrued,
            "the treasury accrued what arrived"
        );
        assertEq(_bal(mockERC20, bVault), 6 ether, "the vault gave up the whole fee");
        assertEq(_tracked(borrower, mockERC20), 6 ether, "and tracks that");
    }

    // -- A move whose source is its recipient --------------------------------

    /// @notice A vault-to-vault move between two positions one user holds
    ///         (lender on one loan, borrower on another, as after a
    ///         consolidation) cannot raise the vault's balance. It delivered
    ///         everything the vault kept, which is the whole amount for an
    ///         ordinary token: a measured rise of zero would book nothing and
    ///         leave the moved tokens outside every ledger.
    function test_SameVaultMove_DeliversWhatTheVaultKept() public {
        ERC20Mock(mockERC20).mint(bVault, 10 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower, mockERC20, 10 ether);

        vm.prank(address(diamond));
        uint256 delivered = VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower, mockERC20, bVault, 4 ether
        );

        assertEq(delivered, 4 ether, "the whole amount stayed where it was sent");
        assertEq(_bal(mockERC20, bVault), 10 ether, "nothing left the vault");
        assertEq(_tracked(borrower, mockERC20), 6 ether, "the caller credits the receiving record");
    }

    /// @notice The same move of a token that charges on transfer delivered the
    ///         amount less the charge the vault paid, never more.
    function test_SameVaultMove_ChargedTokenDeliversLessTheCharge() public {
        ERC20Mock(mockERC20).mint(bVault, 10 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower, mockERC20, 10 ether);
        _chargesFee(mockERC20, address(0));

        vm.prank(address(diamond));
        uint256 delivered = VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower, mockERC20, bVault, 4 ether
        );

        assertEq(delivered, _less(4 ether), "the amount less the charge");
        assertEq(_bal(mockERC20, bVault), 10 ether - (4 ether - _less(4 ether)), "the vault paid the charge");
    }

    /// @notice A wallet payment whose payer is also the payee (a lender-NFT
    ///         holder repaying part of the loan it is owed) is paid in full
    ///         for an ordinary token, and refused by name for a charged one.
    function test_SelfPayment_PaidInFull_RefusedWhenCharged() public {
        LibDeliveryHarness harness = new LibDeliveryHarness();
        ERC20Mock(mockERC20).mint(lender, 5 ether);
        vm.prank(lender);
        IERC20(mockERC20).approve(address(harness), type(uint256).max);
        uint256 before = _bal(mockERC20, lender);

        harness.pullExact(mockERC20, lender, lender, 5 ether);
        assertEq(_bal(mockERC20, lender), before, "paid to itself, in full");

        _chargesFee(mockERC20, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.TokenDeliveryShort.selector, mockERC20, 5 ether, _less(5 ether))
        );
        harness.pullExact(mockERC20, lender, lender, 5 ether);
    }

    // -- Offer fixtures -----------------------------------------------------

    function _lenderErc20Offer() internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: col,
            collateralAmount: COLLATERAL,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: PRINCIPAL,
            interestRateBpsMax: 500,
            collateralAmountMax: COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    /// @dev A real NFT rental: the lender lists NFT 1, the borrower accepts
    ///      and funds the prepay (rent plus a 5% buffer) in `mockERC20`.
    function _openRental() internal returns (uint256 loanId) {
        uint256 rent = DAILY_FEE * RENTAL_DAYS;
        uint256 totalPrepay = rent + (rent * 500) / 10_000;
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockNft721,
                amount: DAILY_FEE,
                interestRateBps: 0,
                collateralAsset: mockERC20,
                collateralAmount: totalPrepay,
                durationDays: RENTAL_DAYS,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 1,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: DAILY_FEE,
                interestRateBpsMax: 0,
                collateralAmountMax: totalPrepay,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "fixture: the rental is open"
        );
    }
}
