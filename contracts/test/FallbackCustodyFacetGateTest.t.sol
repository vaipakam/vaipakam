// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibFallbackCustody} from "../src/libraries/LibFallbackCustody.sol";
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
 * @notice #1566 S2a/S2b: the access gate on the three fund-moving entries of
 *         {FallbackCustodyFacet} (`enterFallback`, `retryFallbackSwap`,
 *         `disposeFallbackCustody`), and the ungated custody read
 *         (`getFallbackCustody`).
 * @dev    Why this file exists. Before S2a these bodies were private
 *         functions of RiskFacet, DefaultedFacet and ClaimFacet, reachable
 *         only through their callers. S2a made them routed selectors, so
 *         `onlyDiamondInternal` is now the only thing between an outside
 *         caller and a loan's fallback custody, which since S2b rests in the
 *         borrower's vault under the loan's lien:
 *         - `disposeFallbackCustody` checks neither the loan status nor
 *           `snap.active`. Reached from outside it would move the treasury
 *           and lender slices out of the borrower's vault, to recipients the
 *           caller names (`lenderSliceOwner`, `lenderMove`), before the
 *           lender ever claimed: the custody row bounds a repeat, not a first
 *           call out of turn.
 *         - `enterFallback` would force an Active, past-grace loan into
 *           FallbackPending with no swap ever attempted.
 *         - `retryFallbackSwap` would pull the custody out of the borrower's
 *           vault and sell it.
 *         Every other cell reaches these entries only through the legitimate
 *         callers. If a refactor dropped the modifier from one of them, the
 *         rest of the suite would stay green and these cells would not.
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
 *         in-kind split is therefore an observable token transfer out of the
 *         borrower's vault.
 */
contract FallbackCustodyFacetGateTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant DURATION_DAYS = 30;

    uint256 internal loanId;
    address internal treasury;
    address internal attacker;

    // Recorded by `_fcEnter` from the live snapshot and the balances.
    uint256 internal lenderCol;
    uint256 internal treasuryCol;
    uint256 internal borrowerCol;
    uint256 internal diamondHeldAfterEntry;
    uint256 internal borrowerVaultAfterEntry;

    function setUp() public {
        setupHelper();
        treasury = makeAddr("fallback-gate-treasury");
        attacker = makeAddr("fallback-gate-attacker");
        // External treasury (the documented mainnet topology): the treasury
        // slice of the in-kind split then leaves the borrower's vault for an
        // address other than the Diamond, so it is an observable transfer like
        // the other two.
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
    ///      lender slice, a split covering the whole collateral, and (S2b) the
    ///      whole collateral back in the borrower's vault as the custody row,
    ///      with the Diamond's balance unchanged by the entry.
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
        assertEq(diamondHeldAfterEntry, heldBefore, "fixture-live: S2b leaves nothing in the Diamond");
        (uint256 row, uint256 legacy) = FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(row, COLLATERAL, "fixture-live: the collateral is the borrower's vault-held custody row");
        assertEq(legacy, 0, "fixture-live: nothing reads as Diamond-held");
        borrowerVaultAfterEntry = _bal(_borrowerVault());
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

    function _borrowerVault() internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(borrower);
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
        FallbackCustodyFacet(address(diamond)).disposeFallbackCustody(
            loanId, caller, LibFallbackCustody.Move.ToLender
        );
    }

    /// @dev Nothing moved: still FallbackPending, snapshot active and unretried,
    ///      the Diamond's balance and the borrower's vault unchanged, and the
    ///      read still (total, 0).
    function _fcAssertCustodyUntouched() internal view {
        assertEq(uint8(_fcStatus(loanId)), uint8(LibVaipakam.LoanStatus.FallbackPending), "still FallbackPending");
        (, , , , , bool active, bool retried) = ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
        assertTrue(active, "the snapshot is still active");
        assertFalse(retried, "no retry was recorded");
        assertEq(_bal(address(diamond)), diamondHeldAfterEntry, "the Diamond's balance did not move");
        assertEq(_bal(_borrowerVault()), borrowerVaultAfterEntry, "the borrower's vault did not move");
        (uint256 vaultHeld, uint256 legacyDiamondHeld) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(vaultHeld, COLLATERAL, "the whole split is still vault-held");
        assertEq(legacyDiamondHeld, 0, "and none of it reads as Diamond-held");
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
    ///         before fallback, then (total, 0) while the snapshot is active,
    ///         where the total is what the producer put back into the
    ///         borrower's vault.
    function test_G3_getFallbackCustody_isUngated() public {
        vm.prank(attacker);
        (uint256 vaultHeld0, uint256 diamondHeld0) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(vaultHeld0, 0, "Active loan: nothing vault-held");
        assertEq(diamondHeld0, 0, "Active loan: no fallback custody");

        _fcEnter();
        vm.prank(attacker);
        (uint256 vaultHeld1, uint256 diamondHeld1) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(vaultHeld1, lenderCol + treasuryCol + borrowerCol, "the active split, vault-held");
        assertEq(diamondHeld1, 0, "none of it in the Diamond");
        assertEq(vaultHeld1, borrowerVaultAfterEntry, "and it is what the borrower's vault holds");
    }

    // --- G4. dispose: only the caller differs --------------------------------

    /// @notice The same `disposeFallbackCustody` on the same state is refused
    ///         for an outside caller and executed for the Diamond, moving the
    ///         treasury and lender slices out of the borrower's vault and
    ///         leaving the borrower slice there.
    /// @dev    The host does not clear the snapshot; its caller does. The row
    ///         drains, so a repeat moves nothing, but a FIRST call out of turn
    ///         would pay the slices before the lender claimed: the gate is the
    ///         only guard against that.
    function test_G4_dispose_onlyTheCallerDiffers() public {
        _fcEnter();
        vm.prank(attacker);
        vm.expectRevert(FallbackCustodyFacet.OnlyDiamondInternal.selector);
        FallbackCustodyFacet(address(diamond)).disposeFallbackCustody(
            loanId, attacker, LibFallbackCustody.Move.ToLender
        );

        address lenderVault = VaultFactoryFacet(address(diamond)).getUserVaultAddress(lender);
        uint256 treasury0 = _bal(treasury);
        uint256 lenderVault0 = _bal(lenderVault);

        vm.prank(address(diamond));
        (uint256 toTreasury, uint256 toLenderSlice, uint256 retained) = FallbackCustodyFacet(address(diamond))
            .disposeFallbackCustody(loanId, lender, LibFallbackCustody.Move.ToLender);

        assertEq(toTreasury, treasuryCol, "returns the treasury slice");
        assertEq(toLenderSlice, lenderCol, "returns the lender slice");
        assertEq(retained, borrowerCol, "returns the retained borrower slice");
        assertEq(_bal(treasury) - treasury0, treasuryCol, "treasury slice paid");
        assertEq(_bal(lenderVault) - lenderVault0, lenderCol, "lender slice into the lender's vault");
        assertEq(borrowerVaultAfterEntry - _bal(_borrowerVault()), treasuryCol + lenderCol, "only those left the borrower's vault");
        assertEq(_bal(address(diamond)), diamondHeldAfterEntry, "the Diamond is never a waypoint");
    }

    // --- G5. dispose through the legitimate caller ----------------------------

    /// @notice The lender claim reaches the same entry exactly once and
    ///         resolves the fallback: the treasury and lender slices leave the
    ///         borrower's vault, the lender is paid their slice, the borrower
    ///         slice stays in the vault, the snapshot is closed, and the read
    ///         drops to (0, 0).
    function test_G5_dispose_reachedThroughClaimAsLender() public {
        _fcEnter();
        uint256 lender0 = _bal(lender);
        uint256 treasury0 = _bal(treasury);

        vm.expectCall(
            address(diamond),
            abi.encodeWithSelector(
                FallbackCustodyFacet.disposeFallbackCustody.selector,
                loanId,
                lender,
                LibFallbackCustody.Move.ToLender
            ),
            1
        );
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        assertEq(_bal(lender) - lender0, lenderCol, "the lender is paid their slice");
        assertEq(_bal(treasury) - treasury0, treasuryCol, "treasury slice paid");
        assertEq(_bal(_borrowerVault()), borrowerCol, "the borrower slice stays in the borrower's vault");
        assertEq(_bal(address(diamond)), diamondHeldAfterEntry, "the Diamond is never a waypoint");
        (, , , , , bool active, ) = ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
        assertFalse(active, "the claim closed the snapshot");
        (uint256 vaultHeld, uint256 diamondHeld) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
        assertEq(vaultHeld, 0, "the custody row is spent");
        assertEq(diamondHeld, 0, "a resolved fallback holds nothing");
    }
}
