// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  FallbackCustodyFacetGateTest
 * @notice #1566 S2a: the access gate on the three fund-moving entries of
 *         {FallbackCustodyFacet} (`enterFallback`, `retryFallbackSwap`,
 *         `disposeFallbackCustody`), and the ungated custody read
 *         (`getFallbackCustody`).
 * @dev    Why this file exists. Before S2a these bodies were private
 *         functions of RiskFacet, DefaultedFacet and ClaimFacet, reachable
 *         only through their callers. S2a made them routed selectors, so
 *         `onlyDiamondInternal` is now the only thing between an outside
 *         caller and the Diamond's fallback collateral:
 *         - `disposeFallbackCustody` has no state precondition of its own. It
 *           checks neither `snap.active` nor the loan status, and it pays the
 *           snapshot's treasury, lender and borrower slices out of the
 *           Diamond's balance on EVERY call. Its caller, the lender claim,
 *           checks `snap.active` first and clears it afterwards. Reached from
 *           outside, it would replay a payout out of the same-token custody of
 *           other fallback loans.
 *         - `enterFallback` would force an Active, past-grace loan into
 *           FallbackPending with no swap ever attempted.
 *         - `retryFallbackSwap` would sell the Diamond-held collateral.
 *         Every other cell reaches these entries only through the legitimate
 *         callers. If a refactor dropped the modifier from one of them (S2b
 *         changes the signature of `disposeFallbackCustody`), the rest of the
 *         suite would stay green and these cells would not.
 *
 *         Mutations killed: drop or weaken the gate on any one entry, and the
 *         matching `expectRevert(OnlyDiamondInternal)` sees a success or a
 *         different revert. Gate the read, and the outside read reverts. Each
 *         refusal is straddled by the same entry succeeding with the Diamond
 *         as the caller: the producer's self-call (G1), the Diamond itself
 *         with nothing else changed (G4), and the lender claim (G5).
 *
 *         Fixture: a real loan, defaulted past grace through the real
 *         producer (DefaultedFacet) with the only swap venue reverting, an
 *         external treasury, and no mocked vault withdraw. Every slice of the
 *         in-kind split is therefore an observable token transfer.
 */
contract FallbackCustodyFacetGateTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant DURATION_DAYS = 30;

    uint256 internal loanId;
    address internal treasury;
    address internal attacker;

    // Recorded by `_fcEnter` from the live snapshot and the Diamond's balance.
    uint256 internal lenderCol;
    uint256 internal treasuryCol;
    uint256 internal borrowerCol;
    uint256 internal diamondHeldAfterEntry;

    function setUp() public {
        setupHelper();
        treasury = makeAddr("fallback-gate-treasury");
        attacker = makeAddr("fallback-gate-attacker");
        // External treasury (the documented mainnet topology): the treasury
        // slice of the in-kind split then leaves the Diamond, so it is an
        // observable transfer like the other two.
        AdminFacet(address(diamond)).setTreasury(treasury);
        loanId = _fcOpenLoanPastGrace();
    }

    // --- Fixture ------------------------------------------------------------

    /// @dev An Active loan past its grace period whose only swap venue (adapter
    ///      slot 0, the ZeroEx shim) reverts, so `triggerDefault` takes the
    ///      fallback branch. Not yet in fallback: G1 needs the Active loan.
    function _fcOpenLoanPastGrace() internal returns (uint256 id) {
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
        id = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        vm.warp(block.timestamp + DURATION_DAYS * 1 days + 3 days + 1);
        assertEq(uint8(_fcStatus(id)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the loan is Active");
        assertTrue(DefaultedFacet(address(diamond)).isLoanDefaultable(id), "fixture-live: the loan is past grace");

        vm.mockCallRevert(
            mockZeroExProxy,
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap failed"
        );
    }

    /// @dev Drive the real producer into FallbackPending and record the split.
    ///      Asserts the fixture is live: an active snapshot with a non-zero
    ///      lender slice, a split covering the whole collateral, and (S2a) the
    ///      whole collateral resting in the Diamond.
    function _fcEnter() internal {
        uint256 heldBefore = _bal(address(diamond));
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
        assertEq(
            uint8(_fcStatus(loanId)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the real producer entered FallbackPending"
        );
        (uint256 l, uint256 t, uint256 b, , , bool active, ) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
        assertTrue(active, "fixture-live: the snapshot is active");
        assertGt(l, 0, "fixture-live: a non-zero lender slice");
        assertEq(l + t + b, COLLATERAL, "fixture-live: the split covers the whole collateral");
        diamondHeldAfterEntry = _bal(address(diamond));
        assertEq(diamondHeldAfterEntry - heldBefore, COLLATERAL, "fixture-live: S2a leaves the collateral in the Diamond");
        lenderCol = l;
        treasuryCol = t;
        borrowerCol = b;
    }

    function _fcStatus(uint256 id) internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(id).status;
    }

    function _bal(address who) internal view returns (uint256) {
        return IERC20(mockCollateralERC20).balanceOf(who);
    }

    /// @dev Each mutator, called by `caller`, reverts with exactly the gate's
    ///      error. The exact selector matters: without the gate `enterFallback`
    ///      on a FallbackPending loan still reverts (an invalid transition), so
    ///      a bare `expectRevert()` would pass with the gate removed.
    function _fcAssertMutatorsGated(address caller) internal {
        LibSwap.AdapterCall[] memory calls = defaultAdapterCalls();

        vm.prank(caller);
        vm.expectRevert(FallbackCustodyFacet.OnlyDiamondInternal.selector);
        FallbackCustodyFacet(address(diamond)).enterFallback(loanId);

        vm.prank(caller);
        vm.expectRevert(FallbackCustodyFacet.OnlyDiamondInternal.selector);
        FallbackCustodyFacet(address(diamond)).retryFallbackSwap(loanId, calls);

        vm.prank(caller);
        vm.expectRevert(FallbackCustodyFacet.OnlyDiamondInternal.selector);
        FallbackCustodyFacet(address(diamond)).disposeFallbackCustody(loanId);
    }

    /// @dev Nothing moved: still FallbackPending, snapshot active and unretried,
    ///      the Diamond's custody unchanged, and the read still (0, total).
    function _fcAssertCustodyUntouched() internal view {
        assertEq(uint8(_fcStatus(loanId)), uint8(LibVaipakam.LoanStatus.FallbackPending), "still FallbackPending");
        (, , , , , bool active, bool retried) = ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
        assertTrue(active, "the snapshot is still active");
        assertFalse(retried, "no retry was recorded");
        assertEq(_bal(address(diamond)), diamondHeldAfterEntry, "the Diamond's custody did not move");
        (uint256 vaultHeld, uint256 legacyDiamondHeld) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(vaultHeld, 0, "S2a: nothing is vault-held");
        assertEq(legacyDiamondHeld, COLLATERAL, "the whole split still rests in the Diamond");
    }

    // --- G1. enterFallback --------------------------------------------------

    /// @notice An outside caller cannot force an Active, past-grace loan into
    ///         FallbackPending. The real producer (DefaultedFacet's
    ///         swap-failure branch) reaches the same entry, exactly once,
    ///         through its self-call.
    /// @dev    Without the gate the outside call succeeds: every check inside
    ///         `enterFallback` is the Diamond calling itself.
    function test_G1_enterFallback_refusesOutsideCaller_producerReachesIt() public {
        vm.prank(attacker);
        vm.expectRevert(FallbackCustodyFacet.OnlyDiamondInternal.selector);
        FallbackCustodyFacet(address(diamond)).enterFallback(loanId);
        assertEq(uint8(_fcStatus(loanId)), uint8(LibVaipakam.LoanStatus.Active), "the loan is still Active");

        vm.expectCall(
            address(diamond),
            abi.encodeWithSelector(FallbackCustodyFacet.enterFallback.selector, loanId),
            1
        );
        _fcEnter();
    }

    // --- G2. Every mutator refuses every outside caller ----------------------

    /// @notice On a live FallbackPending loan each mutator refuses, with exactly
    ///         `OnlyDiamondInternal`, an unrelated account, the loan's own
    ///         lender and borrower, and the admin. The gate is identity-based,
    ///         not role-based: no party and no role may call it. Nothing moved.
    function test_G2_mutators_refuseNamedOutsideCallers() public {
        _fcEnter();
        _fcAssertMutatorsGated(attacker);
        _fcAssertMutatorsGated(lender);
        _fcAssertMutatorsGated(borrower);
        _fcAssertMutatorsGated(owner); // the admin: SetupTest's owner is this test contract
        _fcAssertCustodyUntouched();
    }

    /// @notice G2 over any caller other than the Diamond.
    function testFuzz_G2_mutators_refuseAnyOutsideCaller(address caller) public {
        vm.assume(caller != address(diamond));
        assumeNotForgeAddress(caller);
        _fcEnter();
        _fcAssertMutatorsGated(caller);
        _fcAssertCustodyUntouched();
    }

    // --- G3. The read is ungated --------------------------------------------

    /// @notice `getFallbackCustody` is a plain view anyone may call: (0, 0)
    ///         before fallback, then (0, total) while the snapshot is active,
    ///         where the total is what the producer actually moved into the
    ///         Diamond.
    function test_G3_getFallbackCustody_isUngated() public {
        vm.prank(attacker);
        (uint256 vaultHeld0, uint256 diamondHeld0) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(vaultHeld0, 0, "Active loan: nothing vault-held");
        assertEq(diamondHeld0, 0, "Active loan: no fallback custody");

        uint256 heldBefore = _bal(address(diamond));
        _fcEnter();
        vm.prank(attacker);
        (uint256 vaultHeld1, uint256 diamondHeld1) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(vaultHeld1, 0, "S2a: nothing is vault-held");
        assertEq(diamondHeld1, lenderCol + treasuryCol + borrowerCol, "the active split");
        assertEq(diamondHeld1, _bal(address(diamond)) - heldBefore, "what the producer moved into the Diamond");
    }

    // --- G4. dispose: only the caller differs --------------------------------

    /// @notice The same `disposeFallbackCustody(loanId)` on the same state is
    ///         refused for an outside caller and executed for the Diamond,
    ///         paying each snapshot slice out of the Diamond's balance.
    /// @dev    The host does not clear the snapshot; its caller does. That is
    ///         why the gate is the only guard against a replayed payout.
    function test_G4_dispose_onlyTheCallerDiffers() public {
        _fcEnter();
        vm.prank(attacker);
        vm.expectRevert(FallbackCustodyFacet.OnlyDiamondInternal.selector);
        FallbackCustodyFacet(address(diamond)).disposeFallbackCustody(loanId);

        address lenderVault = VaultFactoryFacet(address(diamond)).getUserVaultAddress(lender);
        address borrowerVault = VaultFactoryFacet(address(diamond)).getUserVaultAddress(borrower);
        uint256 treasury0 = _bal(treasury);
        uint256 lenderVault0 = _bal(lenderVault);
        uint256 borrowerVault0 = _bal(borrowerVault);

        vm.prank(address(diamond));
        FallbackCustodyFacet(address(diamond)).disposeFallbackCustody(loanId);

        assertEq(_bal(treasury) - treasury0, treasuryCol, "treasury slice paid");
        assertEq(_bal(lenderVault) - lenderVault0, lenderCol, "lender slice into the lender's vault");
        assertEq(_bal(borrowerVault) - borrowerVault0, borrowerCol, "borrower slice into the borrower's vault");
        assertEq(diamondHeldAfterEntry - _bal(address(diamond)), COLLATERAL, "the whole split left the Diamond");
    }

    // --- G5. dispose through the legitimate caller ----------------------------

    /// @notice The lender claim reaches the same entry exactly once and
    ///         resolves the fallback: every slice leaves the Diamond, the
    ///         lender is paid their slice, the snapshot is closed, and the
    ///         read drops to (0, 0).
    function test_G5_dispose_reachedThroughClaimAsLender() public {
        _fcEnter();
        address borrowerVault = VaultFactoryFacet(address(diamond)).getUserVaultAddress(borrower);
        uint256 lender0 = _bal(lender);
        uint256 treasury0 = _bal(treasury);
        uint256 borrowerVault0 = _bal(borrowerVault);

        vm.expectCall(
            address(diamond),
            abi.encodeWithSelector(FallbackCustodyFacet.disposeFallbackCustody.selector, loanId),
            1
        );
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        assertEq(_bal(lender) - lender0, lenderCol, "the lender is paid their slice");
        assertEq(_bal(treasury) - treasury0, treasuryCol, "treasury slice paid");
        assertEq(_bal(borrowerVault) - borrowerVault0, borrowerCol, "borrower slice parked in the borrower's vault");
        assertEq(diamondHeldAfterEntry - _bal(address(diamond)), COLLATERAL, "the whole split left the Diamond");
        (, , , , , bool active, ) = ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
        assertFalse(active, "the claim closed the snapshot");
        (uint256 vaultHeld, uint256 diamondHeld) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(vaultHeld, 0, "nothing vault-held");
        assertEq(diamondHeld, 0, "a resolved fallback holds nothing");
    }
}
