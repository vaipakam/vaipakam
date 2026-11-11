// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTiming} from "../src/libraries/LibTiming.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {ISignatureTransfer} from "../src/libraries/LibPermit2.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {PrecloseOffsetFacet} from "../src/facets/PrecloseOffsetFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayPartialFacet} from "../src/facets/SwapToRepayPartialFacet.sol";

/// @title  TxDeadlineEntryTest
/// @notice #3412 — every price-exposed user entry takes a required
///         `validUntil` and runs it through `LibTiming.requireDeadline`
///         before anything else: 0 reverts `DeadlineRequired`, a passed
///         deadline reverts `DeadlinePassed`. Each entry is called with
///         otherwise-meaningless arguments, so the revert proves the
///         deadline is checked first, ahead of every other refusal.
contract TxDeadlineEntryTest is SetupTest {
    uint64 internal constant NOW = 1_000_000;

    function setUp() public {
        setupHelper();
        vm.warp(NOW);
    }

    /// Calls entry `i` (0..12) with the given validUntil.
    function _call(uint256 i, uint64 validUntil) internal {
        address d = address(diamond);
        LibVaipakam.CreateOfferParams memory cp;
        LibVaipakam.OfferModifyParams memory mp;
        LibSwap.AdapterCall[] memory calls;
        ISignatureTransfer.PermitTransferFrom memory permit;
        if (i == 0) OfferCreateFacet(d).createOffer(cp, validUntil);
        else if (i == 1) OfferCreateFacet(d).createOfferWithPermit(cp, permit, "", validUntil);
        else if (i == 2) OfferMutateFacet(d).setOfferAmount(1, 1, 1, validUntil);
        else if (i == 3) OfferMutateFacet(d).setOfferRate(1, 1, 1, validUntil);
        else if (i == 4) OfferMutateFacet(d).setOfferCollateral(1, 1, 1, validUntil);
        else if (i == 5) OfferMutateFacet(d).modifyOffer(1, mp, validUntil);
        else if (i == 6) {
            LenderIntentFacet(d).setLenderIntent(
                address(1), address(2), 1, 1, 1, 1, 1, false, true, validUntil
            );
        } else if (i == 7) SwapToRepayFacet(d).swapToRepayFull(1, calls, 1, validUntil);
        else if (i == 8) SwapToRepayPartialFacet(d).swapToRepayPartial(1, 1, calls, validUntil);
        else if (i == 9) {
            EarlyWithdrawalFacet(d).createLoanSaleOffer(1, 1, true, 1 days, 0, type(uint256).max, validUntil);
        } else if (i == 10) {
            EarlyWithdrawalDirectFacet(d).sellLoanViaBuyOffer(1, 2, 0, type(uint256).max, validUntil);
        } else if (i == 11) {
            PrecloseOffsetFacet(d).offsetWithNewOffer(1, 1, 1, address(1), 1, true, address(0), validUntil);
        } else {
            PrecloseFacet(d).transferObligationViaOffer(1, 2, validUntil);
        }
    }

    uint256 internal constant ENTRIES = 13;

    function test_EveryPriceExposedEntry_RefusesMissingDeadline() public {
        for (uint256 i; i < ENTRIES; ++i) {
            vm.expectRevert(LibTiming.DeadlineRequired.selector);
            this.callEntry(i, 0);
        }
    }

    function test_EveryPriceExposedEntry_RefusesPassedDeadline() public {
        for (uint256 i; i < ENTRIES; ++i) {
            vm.expectRevert(abi.encodeWithSelector(LibTiming.DeadlinePassed.selector, uint256(NOW - 1)));
            this.callEntry(i, NOW - 1);
        }
    }

    /// The deadline second itself is still valid: the call gets past the
    /// deadline check and fails (if at all) on a later, unrelated refusal.
    function test_EveryPriceExposedEntry_AcceptsDeadlineSecondItself() public {
        for (uint256 i; i < ENTRIES; ++i) {
            try this.callEntry(i, NOW) {} catch (bytes memory err) {
                bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
                assertTrue(sel != LibTiming.DeadlinePassed.selector, "deadline second refused");
                assertTrue(sel != LibTiming.DeadlineRequired.selector, "deadline second read as missing");
            }
        }
    }

    /// External hop so `expectRevert` / `try` see exactly one call.
    function callEntry(uint256 i, uint64 validUntil) external {
        _call(i, validUntil);
    }
}
