// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OfferBookBoundsTest} from "./OfferBookBoundsTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPriceGuard} from "../src/libraries/LibPriceGuard.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";

/**
 * @title  RatePricedLendingAssetTest
 * @notice #3683: a token the price guard prices by an exchange rate may be
 *         collateral but never the asset lent. Refused when an offer enters
 *         the book, when a loan is opened from an offer posted before the
 *         token was bound, and when a lender intent is set. The guard's
 *         answer is mocked; the guard's own binding rules are covered in
 *         `PriceGuardRateTest`.
 */
contract RatePricedLendingAssetTest is OfferBookBoundsTest {
    function _markRatePriced(address asset) internal {
        vm.mockCall(
            LibTestPriceGuard.guardOf(address(diamond)),
            abi.encodeCall(IPriceGuard.isRatePriced, (asset)),
            abi.encode(true)
        );
    }

    function test_AnOfferLendingARatePricedTokenIsRefused() public {
        _markRatePriced(mockERC20);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(LibPriceGuard.RatePricedLendingAsset.selector, mockERC20));
        OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, mockERC20, 100e18, 200e18), type(uint64).max
        );
    }

    function test_ARatePricedTokenIsStillAdmittedAsCollateral() public {
        _markRatePriced(mockCollateralERC20);
        _lend(100e18); // lends mockERC20 against mockCollateralERC20
    }

    function test_ALoanFromAnOfferPostedBeforeTheBindingIsRefused() public {
        uint256 offerId = _lend(100e18);
        vm.warp(vm.getBlockTimestamp() + 1 hours); // past the offer's freshness window
        vm.roll(block.number + 10);
        _markRatePriced(mockERC20);
        // Build and sign first, so the helper's view calls don't take the
        // expected revert.
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        vm.expectRevert(abi.encodeWithSelector(LibPriceGuard.RatePricedLendingAsset.selector, mockERC20));
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    function test_ALenderIntentLendingARatePricedTokenIsRefused() public {
        _markRatePriced(mockERC20);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(LibPriceGuard.RatePricedLendingAsset.selector, mockERC20));
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, 1_000e18, 500, 5000, 30, 100e18, false, 0, false, true, LibVaipakam.IntentRateTerms(0, 0, false), uint64(vm.getBlockTimestamp() + 1 days)
        );
    }
}
