// test/MulticallFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {MulticallFacet} from "../src/facets/MulticallFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  MulticallFacetTest
 * @notice #1212 (E-10 Claim-All) — behavioural coverage of the generic
 *         best-effort delegatecall batcher. Uses the shared full-diamond
 *         {SetupTest} harness (which cuts {MulticallFacet}) and real,
 *         nonReentrant `claimAsLender` calls to prove the two properties the
 *         design hinges on:
 *
 *           1. delegatecall PRESERVES msg.sender — every batched claim
 *              self-authorizes against the real user, so a non-owner's batched
 *              claim is rejected exactly as a direct call would be.
 *           2. The single global reentrancy guard does NOT collide across
 *              sequential batched claims — two `nonReentrant` claims in one
 *              multicall both succeed (each runs in its own frame).
 *
 *         Plus best-effort (`allowFailure`) semantics and the input guards.
 */
contract MulticallFacetTest is SetupTest, IVaipakamErrors {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant DURATION_DAYS = 30;

    function setUp() public {
        setupHelper();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Create a Lender offer, have the borrower accept it, and return the
    ///      resulting loanId. If `repay` is true the borrower repays so the
    ///      loan is terminal and the lender has a pending claim; otherwise the
    ///      loan stays ACTIVE (an ineligible claim target).
    function _loan(bool repay) internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL,
                durationDays: DURATION_DAYS,
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
            })
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        if (repay) {
            vm.prank(borrower);
            RepayFacet(address(diamond)).repayLoan(loanId);
        }
    }

    function _claimCall(uint256 loanId, bool allowFailure)
        internal
        pure
        returns (MulticallFacet.Call memory)
    {
        return MulticallFacet.Call({
            callData: abi.encodeWithSelector(ClaimFacet.claimAsLender.selector, loanId),
            allowFailure: allowFailure
        });
    }

    // ─── Headline: batch two lender claims in one tx ─────────────────────────

    /// Two resolved loans, both claimed by the lender in ONE multicall. Proves
    /// the shared reentrancy guard does not collide across sequential
    /// `nonReentrant` claims, and that msg.sender is preserved (both auth).
    function testClaimAllTwoLenderClaims() public {
        uint256 loanA = _loan(true);
        uint256 loanB = _loan(true);

        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = _claimCall(loanA, false);
        calls[1] = _claimCall(loanB, false);

        vm.prank(lender);
        MulticallFacet.Result[] memory res =
            MulticallFacet(address(diamond)).multicall(calls);

        assertEq(res.length, 2, "two results");
        assertTrue(res[0].success, "loanA claimed");
        assertTrue(res[1].success, "loanB claimed");

        // Unambiguous proof each claim actually executed: a repeat direct claim
        // now reverts as already-claimed.
        vm.prank(lender);
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsLender(loanA);
        vm.prank(lender);
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsLender(loanB);
    }

    // ─── Best-effort: skip the ineligible item, claim the rest ───────────────

    function testAllowFailureSkipsIneligibleItem() public {
        uint256 resolved = _loan(true);
        uint256 active = _loan(false); // still ACTIVE — claimAsLender reverts

        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = _claimCall(resolved, false);
        calls[1] = _claimCall(active, true); // tolerated failure

        vm.prank(lender);
        MulticallFacet.Result[] memory res =
            MulticallFacet(address(diamond)).multicall(calls);

        assertTrue(res[0].success, "resolved item claimed");
        assertFalse(res[1].success, "active item skipped, not fatal");

        // The active loan is untouched — still directly claimable once resolved
        // is impossible while active, so a direct claim still reverts active.
        vm.prank(lender);
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsLender(active);
    }

    // ─── allowFailure == false aborts the whole batch ───────────────────────

    function testAllowFailureFalseAbortsBatch() public {
        uint256 resolved = _loan(true);
        uint256 active = _loan(false);

        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = _claimCall(resolved, false);
        calls[1] = _claimCall(active, false); // fatal failure -> whole batch reverts

        vm.prank(lender);
        vm.expectRevert();
        MulticallFacet(address(diamond)).multicall(calls);

        // Because the batch reverted atomically, the FIRST (resolved) claim was
        // rolled back too — it is still claimable directly.
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(resolved);
    }

    // ─── msg.sender preserved: a non-owner's batched claim is rejected ───────

    /// The keystone security property. If delegatecall did NOT preserve
    /// msg.sender (e.g. a plain `call` rewriting it to the Diamond), the
    /// NFT-owner check would evaluate against the wrong address. A stranger
    /// batching the lender's claim must be rejected exactly as a direct call is.
    function testMsgSenderPreservedRejectsNonOwner() public {
        uint256 resolved = _loan(true);
        address stranger = makeAddr("stranger");

        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](1);
        calls[0] = _claimCall(resolved, false); // fatal so the auth revert surfaces

        vm.prank(stranger);
        vm.expectRevert(); // NotNFTOwner (or sanctions/auth) — never succeeds
        MulticallFacet(address(diamond)).multicall(calls);

        // The claim did NOT execute — the real lender can still claim.
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(resolved);
    }

    // ─── Input guards ────────────────────────────────────────────────────────

    function testEmptyBatchReverts() public {
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](0);
        vm.prank(lender);
        vm.expectRevert(MulticallFacet.MulticallEmpty.selector);
        MulticallFacet(address(diamond)).multicall(calls);
    }

    function testTooLargeBatchReverts() public {
        // MAX_MULTICALL_CALLS is 30 — 31 items must revert.
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](31);
        for (uint256 i; i < 31; ++i) {
            calls[i] = _claimCall(1, true);
        }
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(MulticallFacet.MulticallTooLarge.selector, 31, 30)
        );
        MulticallFacet(address(diamond)).multicall(calls);
    }

    function testEmptyItemCallDataReverts() public {
        // An item with < 4 bytes of calldata would hit the Diamond's receive()
        // and report success without executing anything — reject it so a
        // malformed item can never masquerade as a claimed payout.
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = _claimCall(1, true);
        calls[1] = MulticallFacet.Call({callData: "", allowFailure: true});
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(MulticallFacet.MulticallItemMissingSelector.selector, 1)
        );
        MulticallFacet(address(diamond)).multicall(calls);
    }

    function testShortItemCallDataReverts() public {
        // 3 bytes (< selector) also rejected — even with allowFailure it is a
        // structural batch error, not a tolerable runtime failure.
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](1);
        calls[0] = MulticallFacet.Call({callData: hex"aabbcc", allowFailure: true});
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(MulticallFacet.MulticallItemMissingSelector.selector, 0)
        );
        MulticallFacet(address(diamond)).multicall(calls);
    }

    function testSelfRecursionReverts() public {
        // An item whose callData targets multicall itself must be rejected.
        MulticallFacet.Call[] memory inner = new MulticallFacet.Call[](1);
        inner[0] = _claimCall(1, true);
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](1);
        calls[0] = MulticallFacet.Call({
            callData: abi.encodeWithSelector(MulticallFacet.multicall.selector, inner),
            allowFailure: true
        });
        vm.prank(lender);
        vm.expectRevert(MulticallFacet.MulticallSelfRecursion.selector);
        MulticallFacet(address(diamond)).multicall(calls);
    }
}
