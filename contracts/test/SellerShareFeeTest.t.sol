// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibInterestLedger} from "../src/libraries/LibInterestLedger.sol";

/// @dev Runs {LibInterestLedger.takeForSellers} against its own storage, so
///      the netting rule can be pinned without a Diamond.
contract TakeForSellersHarness {
    function seed(uint256 loanId, uint16 feeBps, address seller, uint256 grossOwed) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.loans[loanId].id = loanId;
        s.loans[loanId].treasuryFeeBpsAtInit = feeBps;
        s.sellerInterestClaims[loanId].push(
            LibVaipakam.SellerInterestClaim({seller: seller, grossOwed: grossOwed})
        );
    }

    function take(uint256 loanId, uint256 interestGross, uint256 interestNet)
        external
        returns (uint256 sellersGross, uint256 sellersNet)
    {
        (, sellersGross, sellersNet) =
            LibInterestLedger.takeForSellers(LibVaipakam.storageSlot(), loanId, interestGross, interestNet);
    }
}

/// @title SellerShareFeeTest
/// @notice #1209 (Codex #3068 r2) — a seller pays the yield fee the slice
///         charged. A slice that charged a fee nets the seller at the loan's
///         own rate; a slice that charged none (its net is its gross: the
///         periodic forced sale) pays the seller gross, so no withheld fee is
///         left over for the holder.
contract SellerShareFeeTest is Test {
    uint256 internal constant LOAN_ID = 7;
    uint16 internal constant FEE_BPS = 200;
    TakeForSellersHarness internal h;
    address internal seller = makeAddr("seller");

    function setUp() public {
        h = new TakeForSellersHarness();
        h.seed(LOAN_ID, FEE_BPS, seller, 100 ether);
    }

    function test_feeCarryingSlice_netsTheSellerAtTheLoansFee() public {
        (uint256 gross, uint256 net) = h.take(LOAN_ID, 100 ether, 98 ether);
        assertEq(gross, 100 ether, "the seller's claim takes the slice");
        assertEq(net, 98 ether, "net of the loan's 2% fee");
    }

    function test_feeFreeSlice_paysTheSellerGross() public {
        (uint256 gross, uint256 net) = h.take(LOAN_ID, 100 ether, 100 ether);
        assertEq(gross, 100 ether, "the seller's claim takes the slice");
        assertEq(net, 100 ether, "no fee was charged, so the seller is paid gross");
    }

    function test_holderDiscountedSlice_stillNetsTheSellerAtTheLoansFee() public {
        // The slice's fee was discounted on the holder's part only, so it is
        // below the loan's fee overall; the seller still pays the full rate.
        (, uint256 net) = h.take(LOAN_ID, 100 ether, 99 ether);
        assertEq(net, 98 ether, "the holder's discount never reaches the seller");
    }
}
