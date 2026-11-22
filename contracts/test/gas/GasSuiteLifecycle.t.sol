// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {GasSuiteBase} from "./GasSuiteBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {RepayPeriodicFacet} from "../../src/facets/RepayPeriodicFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {AutoLifecycleSettingsFacet} from "../../src/facets/AutoLifecycleSettingsFacet.sol";
import {IZeroExProxy} from "../../src/interfaces/IZeroExProxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {LibAcceptTestSigner} from "../helpers/LibAcceptTestSigner.sol";
import {LibTestFallbackGate} from "../helpers/LibTestFallbackGate.sol";
import {RefinancePayoffPermitHelper} from "../helpers/RefinancePayoffPermitHelper.sol";
import {defaultAdapterCalls} from "../helpers/AdapterCallHelpers.sol";
import {defaultQuote} from "../helpers/ForcedSaleQuote.sol";

/**
 * @title  GasSuiteLifecycleTest
 * @notice The gas suite's lifecycle actions (#3915, RefactorRulesDesign §5.1):
 *         an NFT rental's opening and its daily deduction, a time-based
 *         default whose every swap route fails and so enters the in-kind
 *         fallback, and a refinance completed inside the new lender's accept.
 *         Each is measured as its own isolated transaction.
 *
 * forge-config: default.isolate = true
 */
contract GasSuiteLifecycleTest is GasSuiteBase {
    uint256 internal constant DAILY_FEE = 10 ether;

    function setUp() public {
        _setUpGasSuite();
    }

    // ─── NFT rental ──────────────────────────────────────────────────────

    /// @dev A lender offer renting `mockNft721` #1 for 30 days, prepaid in
    ///      `mockERC20`.
    function _rentalOffer() internal returns (uint256 offerId) {
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender);
        p.lendingAsset = mockNft721;
        p.amount = DAILY_FEE;
        p.amountMax = DAILY_FEE;
        p.assetType = LibVaipakam.AssetType.ERC721;
        p.tokenId = 1;
        p.quantity = 1;
        p.collateralAsset = address(0);
        p.collateralAmount = 0;
        p.collateralAmountMax = 0;
        offerId = _createOffer(lender, p);
    }

    function test_gas_rental_accept() public {
        uint256 offerId = _rentalOffer();
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        _measure("rental_accept", borrower, abi.encodeCall(OfferAcceptFacet.acceptOffer, (offerId, t, sig)));
    }

    function test_gas_rental_day_deduct() public {
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, _rentalOffer());
        _skip(1 days);
        _measure(
            "rental_day_deduct", makeAddr("gasKeeper"), abi.encodeCall(RepayPeriodicFacet.autoDeductDaily, (loanId))
        );
    }

    // ─── Fallback entry ──────────────────────────────────────────────────

    /// @dev Every listed route fails, so the time-based default enters the
    ///      in-kind fallback (#1566 S2a): the collateral stays in the
    ///      borrower's vault under the loan's lien and the snapshot is taken.
    function test_gas_close_fallback_entry() public {
        uint256 loanId = _openLoan();
        _skip((DURATION_DAYS + 30) * 1 days);
        vm.mockCallRevert(mockZeroExProxy, abi.encodeWithSelector(IZeroExProxy.swap.selector), "swap failed");
        LibTestFallbackGate.open(address(diamond), loanId);
        uint256 quote = defaultQuote(address(diamond), loanId);
        _measure(
            "close_fallback_entry",
            makeAddr("gasKeeper"),
            abi.encodeCall(DefaultedFacet.triggerDefault, (loanId, quote, defaultAdapterCalls()))
        );
    }

    // ─── Refinance ───────────────────────────────────────────────────────

    /// @dev The borrower tags a request at a lower rate; a new lender accepts
    ///      it, and the same transaction pays the old lender (net principal
    ///      vault to vault, the rest through the payoff permit) and closes the
    ///      old loan as Repaid (#3042, #1558).
    function test_gas_refinance_accept() public {
        uint256 oldLoanId = _openLoan();
        vm.prank(borrower);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoRefinanceCaps(
            oldLoanId, true, uint16(RATE_BPS + 100), uint64(vm.getBlockTimestamp() + 365 days)
        );
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Borrower);
        p.interestRateBps = RATE_BPS - 100;
        p.interestRateBpsMax = RATE_BPS - 100;
        p.fillMode = LibVaipakam.FillMode.Aon;
        p.allowsPartialRepay = false;
        p.refinanceTargetLoanId = oldLoanId;
        uint256 tagged = _createOffer(borrower, p);
        vm.prank(borrower);
        ERC20(mockERC20).approve(address(diamond), 0);
        RefinancePayoffPermitHelper.attach(address(diamond), borrower, mockERC20, tagged);

        (address newLender, uint256 newLenderPk) = makeAddrAndKey("gasRefiLender");
        ERC20Mock(mockERC20).mint(newLender, PRINCIPAL);
        vm.prank(newLender);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        _skip(10 days);

        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(address(diamond), newLender, tagged, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, newLenderPk);
        _measure("refinance_accept", newLender, abi.encodeCall(OfferAcceptFacet.acceptOffer, (tagged, t, sig)));
    }
}
