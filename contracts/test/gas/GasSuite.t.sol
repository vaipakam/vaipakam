// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {GasSuiteBase} from "./GasSuiteBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferMutateFacet} from "../../src/facets/OfferMutateFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {OfferMatchFacet} from "../../src/facets/OfferMatchFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {PartialWithdrawalFacet} from "../../src/facets/PartialWithdrawalFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";
import {VaultDepositoryFacet} from "../../src/facets/VaultDepositoryFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../../src/facets/EarlyWithdrawalDirectFacet.sol";
import {EarlyWithdrawalFacet} from "../../src/facets/EarlyWithdrawalFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {LibAcceptTestSigner} from "../helpers/LibAcceptTestSigner.sol";
import {defaultAdapterCalls} from "../helpers/AdapterCallHelpers.sol";
import {defaultQuote, liquidationQuote} from "../helpers/ForcedSaleQuote.sol";

/**
 * @title  GasSuiteTest
 * @notice One test per user action (#3915, RefactorRulesDesign §5.1). Each
 *         arranges the state, then measures the action as its own isolated
 *         transaction through {GasSuiteBase._measure}. The action names are
 *         the keys of `contracts/gas-suite/budgets.json`.
 *
 * forge-config: default.isolate = true
 */
contract GasSuiteTest is GasSuiteBase {
    function setUp() public {
        _setUpGasSuite();
    }

    // ─── Isolation (acceptance: a repeated call in one body reads lower) ──

    /// @dev Under isolation, the same action twice reads the same: each call
    ///      starts cold.
    /// forge-config: default.isolate = true
    function test_isolation_repeatReadsTheSame() public {
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender);
        Measured memory a = _measure("_probe_isolated_1", lender, abi.encodeCall(OfferCreateFacet.createOffer, (p, type(uint64).max)));
        Measured memory b = _measure("_probe_isolated_2", lender, abi.encodeCall(OfferCreateFacet.createOffer, (p, type(uint64).max)));
        // The second offer finds the lender's vault and counters already
        // written (non-zero to non-zero), so it may read a little lower; it
        // must not read the warm figure the next test shows.
        assertGt(b.gas * 10, a.gas * 8, "isolated: the second call is still cold");
    }

    /// @dev Without isolation the whole test body is one transaction: the
    ///      second call reads warm slots and measures well below the
    ///      isolated figure. This is why the suite isolates every action.
    /// forge-config: default.isolate = false
    function test_isolation_offRepeatReadsLower() public {
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender);
        Measured memory iso = _measure("_probe_warm_1", lender, abi.encodeCall(OfferCreateFacet.createOffer, (p, type(uint64).max)));
        Measured memory warm = _measure("_probe_warm_2", lender, abi.encodeCall(OfferCreateFacet.createOffer, (p, type(uint64).max)));
        assertLt(warm.gas * 10, iso.gas * 8, "without isolation the repeat reads warm and lower");
    }

    // ─── Offers ──────────────────────────────────────────────────────────

    function test_gas_offer_post() public {
        _measure(
            "offer_post",
            lender,
            abi.encodeCall(OfferCreateFacet.createOffer, (_params(LibVaipakam.OfferType.Lender), type(uint64).max))
        );
    }

    function test_gas_offer_change() public {
        uint256 offerId = _createOffer(lender, _params(LibVaipakam.OfferType.Lender));
        LibVaipakam.OfferModifyParams memory m = LibVaipakam.OfferModifyParams({
            amount: PRINCIPAL,
            amountMax: PRINCIPAL,
            interestRateBps: RATE_BPS + 50,
            interestRateBpsMax: RATE_BPS + 50,
            collateralAmount: COLLATERAL,
            collateralAmountMax: COLLATERAL,
            linkKind: 0,
            linkMarginBps: 0,
            rateFarFromAverageAcknowledged: false
        });
        _measure("offer_change", lender, abi.encodeCall(OfferMutateFacet.modifyOffer, (offerId, m, type(uint64).max)));
    }

    function test_gas_offer_cancel() public {
        uint256 offerId = _createOffer(lender, _params(LibVaipakam.OfferType.Lender));
        // Past the cancel cooldown that protects a just-posted offer from a
        // race with its taker (OfferCancelFacet, MIN_OFFER_CANCEL_DELAY).
        _skip(LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        _measure("offer_cancel", lender, abi.encodeCall(OfferCancelFacet.cancelOffer, (offerId)));
    }

    // ─── Opening a loan ──────────────────────────────────────────────────

    function test_gas_loan_accept_erc20() public {
        uint256 offerId = _createOffer(lender, _params(LibVaipakam.OfferType.Lender));
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        _measure("loan_accept_erc20", borrower, abi.encodeCall(OfferAcceptFacet.acceptOffer, (offerId, t, sig)));
    }

    function test_gas_loan_match_offers() public {
        // Matching is behind the partial-fill switch, off by default.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        uint256 lo = _createOffer(lender, _params(LibVaipakam.OfferType.Lender));
        uint256 bo = _createOffer(borrower, _params(LibVaipakam.OfferType.Borrower));
        address keeper = makeAddr("gasKeeper");
        _measure("loan_match_offers", keeper, abi.encodeCall(OfferMatchFacet.matchOffers, (lo, bo)));
    }

    // ─── Repayment ───────────────────────────────────────────────────────

    function test_gas_repay_full() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        _measure("repay_full", borrower, abi.encodeCall(RepayFacet.repayLoan, (loanId)));
    }

    function test_gas_repay_partial() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        _measure("repay_partial", borrower, abi.encodeCall(RepayFacet.repayPartial, (loanId, PRINCIPAL / 2)));
    }

    // ─── Collateral ──────────────────────────────────────────────────────

    function test_gas_collateral_add() public {
        uint256 loanId = _openLoan();
        _measure("collateral_add", borrower, abi.encodeCall(AddCollateralFacet.addCollateral, (loanId, 100 ether)));
    }

    function test_gas_collateral_withdraw_surplus() public {
        uint256 loanId = _openLoan();
        vm.prank(borrower);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 500 ether);
        _measure(
            "collateral_withdraw_surplus",
            borrower,
            abi.encodeCall(PartialWithdrawalFacet.partialWithdrawCollateral, (loanId, 100 ether))
        );
    }

    // ─── Claims ──────────────────────────────────────────────────────────

    function test_gas_claim_lender() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        _measure("claim_lender", lender, abi.encodeCall(ClaimFacet.claimAsLender, (loanId)));
    }

    function test_gas_claim_borrower() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        _measure("claim_borrower", borrower, abi.encodeCall(ClaimFacet.claimAsBorrower, (loanId)));
    }

    // ─── Forced closes ───────────────────────────────────────────────────

    function test_gas_close_default_time_based() public {
        uint256 loanId = _openLoan();
        _skip((DURATION_DAYS + 30) * 1 days);
        uint256 quote = defaultQuote(address(diamond), loanId);
        _measure(
            "close_default_time_based",
            makeAddr("gasKeeper"),
            abi.encodeCall(DefaultedFacet.triggerDefault, (loanId, quote, defaultAdapterCalls()))
        );
    }

    function test_gas_close_liquidation_hf() public {
        uint256 loanId = _openLoan();
        // Collateral at $0.50: 2,000 units are worth $1,000 against a $1,000
        // debt, so the health factor is below 1 at any threshold under 100%.
        mockOraclePrice(mockCollateralERC20, 0.5e8, 8);
        uint256 quote = liquidationQuote(address(diamond), loanId);
        _measure(
            "close_liquidation_hf",
            makeAddr("gasLiquidator"),
            abi.encodeCall(RiskFacet.triggerLiquidation, (loanId, quote, defaultAdapterCalls()))
        );
    }

    // ─── Exits ───────────────────────────────────────────────────────────

    function test_gas_exit_preclose() public {
        uint256 loanId = _openLoan();
        _skip(5 days);
        _measure("exit_preclose", borrower, abi.encodeCall(PrecloseFacet.precloseDirect, (loanId)));
    }

    function test_gas_exit_sale_direct() public {
        uint256 loanId = _openLoan();
        _skip(5 days);
        address buyer = _provisionFundedActor("gasBuyer", mockERC20, PRINCIPAL * 2);
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender);
        p.durationDays = DURATION_DAYS - 5;
        uint256 buyOfferId = _createOffer(buyer, p);
        _measure(
            "exit_sale_direct",
            lender,
            abi.encodeCall(
                EarlyWithdrawalDirectFacet.sellLoanViaBuyOffer, (loanId, buyOfferId, 0, type(uint256).max, type(uint64).max)
            )
        );
    }

    function test_gas_exit_sale_listing() public {
        uint256 loanId = _openLoan();
        _skip(5 days);
        _measure(
            "exit_sale_listing",
            lender,
            abi.encodeCall(
                EarlyWithdrawalFacet.createLoanSaleOffer,
                (loanId, RATE_BPS, true, uint64(3 days), 0, type(uint256).max, type(uint64).max)
            )
        );
    }

    // ─── Vault moves ─────────────────────────────────────────────────────

    function test_gas_vault_deposit() public {
        _measure(
            "vault_deposit",
            lender,
            abi.encodeCall(VaultDepositoryFacet.depositToVault, (uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 100 ether))
        );
    }

    function test_gas_vault_withdraw() public {
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 100 ether);
        _measure(
            "vault_withdraw",
            lender,
            abi.encodeCall(
                VaultDepositoryFacet.withdrawFromVault, (lender, uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 50 ether, lender)
            )
        );
    }
}
