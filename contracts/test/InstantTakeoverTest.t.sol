// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {InstantMarketBase} from "./InstantMarketTest.t.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {MarketLedgerFacet} from "../src/facets/MarketLedgerFacet.sol";
import {InstantMarketFacet} from "../src/facets/InstantMarketFacet.sol";
import {InstantFillFacet} from "../src/facets/InstantFillFacet.sol";
import {InstantTakeoverFacet} from "../src/facets/InstantTakeoverFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {CollateralConcentrationFacet} from "../src/facets/CollateralConcentrationFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestCalmPair} from "./helpers/LibTestCalmPair.sol";
import {OfferPriceGuardFacet} from "../src/facets/OfferPriceGuardFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibTestProtection} from "./helpers/LibTestProtection.sol";
import {LibProtectedAccount} from "../src/libraries/LibProtectedAccount.sol";

/**
 * @title  InstantTakeoverTest
 * @notice Instant market (#3656, design §7) — a lender hands an instant-market
 *         loan to another lender's slot at face value.
 */
contract InstantTakeoverTest is InstantMarketBase {
    uint256 internal constant PRINCIPAL = 1000 ether;

    /// @dev `lender`'s slot lends PRINCIPAL to `taker` at 5%; `lender2` has a
    ///      slot with the takeover consent unless `consent` is false.
    function _openAndOffer(uint256 incomingRate, uint32 incomingDays, bool consent)
        internal
        returns (uint256 loanId)
    {
        _slot(lender, 500, PRINCIPAL, true);
        _slotWith(lender2, incomingRate, PRINCIPAL, incomingDays, consent);
        _age();
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](1);
        srcs[0] = _src(lender);
        (, InstantMarketFacet.InstantFill[] memory fills) = _borrow(_req(PRINCIPAL, 2000 ether, 700, PRINCIPAL), srcs);
        loanId = fills[0].loanId;
        // SetupTest pins the loan-to-value read at 66.66%; this loan's real
        // figure is 50% (1:1 prices, 2:1 collateral), the slot's limit.
        _mockLtv(MAX_INIT_LTV_BPS);
    }

    function _mockLtv(uint256 ltv) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(ltv));
    }

    function _slotWith(address who, uint256 rateBps, uint256 maxExposure, uint32 maxDays, bool consent) internal {
        vm.prank(who);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, maxExposure, rateBps, MAX_INIT_LTV_BPS,
            maxDays, MIN_FILL, false, 0, true, true, type(uint64).max
        );
        ERC20Mock(mockERC20).mint(who, maxExposure);
        vm.prank(who);
        ERC20(mockERC20).approve(address(diamond), maxExposure);
        vm.prank(who);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 0, maxExposure);
        if (consent) {
            vm.prank(who);
            InstantMarketFacet(address(diamond)).setInstantSlot(
                mockERC20, mockCollateralERC20, 0, false, false, true, true, type(uint64).max
            );
        }
    }

    function _takeover(address caller, uint256 loanId, address incoming) internal {
        vm.prank(caller);
        InstantTakeoverFacet(address(diamond)).takeoverInstant(
            loanId, incoming, 0, uint64(vm.getBlockTimestamp() + 1 hours)
        );
    }

    /// @dev The incoming slot pays exactly the principal into the outgoing
    ///      holder's vault; the position moves on the same loan record with
    ///      every term unchanged; the outgoing holder's earned interest is
    ///      reported as their seller claim; the ledger keeps the loan
    ///      instant and slot-lent.
    function test_takeoverMovesTheLoanAtFaceValue() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        LibVaipakam.Loan memory before = _loan(loanId);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        LibTestCalmPair.checkpoint(address(diamond), mockERC20, mockCollateralERC20);

        uint256 holderVaultBefore = _vaultBal(lender, mockERC20);
        uint256 incomingVaultBefore = _vaultBal(lender2, mockERC20);
        vm.recordLogs();
        _takeover(lender, loanId, lender2);

        assertEq(_vaultBal(lender, mockERC20) - holderVaultBefore, PRINCIPAL, "holder paid face value");
        assertEq(incomingVaultBefore - _vaultBal(lender2, mockERC20), PRINCIPAL, "slot capital paid it");

        LibVaipakam.Loan memory afterLoan = _loan(loanId);
        assertEq(afterLoan.lender, lender2, "position moved");
        assertEq(afterLoan.borrower, taker, "borrower unchanged");
        assertEq(afterLoan.principal, before.principal, "principal unchanged");
        assertEq(afterLoan.interestRateBps, before.interestRateBps, "rate unchanged");
        assertEq(afterLoan.durationDays, before.durationDays, "term unchanged");
        assertEq(afterLoan.collateralAmount, before.collateralAmount, "collateral unchanged");

        bool seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != InstantTakeoverFacet.InstantTakenOver.selector) continue;
            (uint8 slot, uint256 paid, uint256 earned) = abi.decode(logs[i].data, (uint8, uint256, uint256));
            assertEq(slot, 0);
            assertEq(paid, PRINCIPAL, "paid reported");
            assertGt(earned, 0, "earned interest left as a seller claim");
            seen = true;
        }
        assertTrue(seen, "event emitted");

        (, , uint256 lent, uint256 fromSlots, uint256 instant) =
            MarketLedgerFacet(address(diamond)).getPairLedger(mockERC20, mockCollateralERC20);
        assertEq(lent, PRINCIPAL, "lent unchanged");
        assertEq(fromSlots, PRINCIPAL, "still slot-lent, now from the incoming slot");
        assertEq(instant, PRINCIPAL, "still instant");

        // #3714 — live principal moves with the loan: out of the outgoing
        // slot, into the incoming one at the principal outstanding; the
        // incoming slot's capital and room both fell by it.
        (, uint256 outFillable, uint256 outLive, ) =
            MarketLedgerFacet(address(diamond)).getSlotLedger(lender, mockERC20, mockCollateralERC20, 0);
        (, uint256 inFillable, uint256 inLive, uint256 inCapital) =
            MarketLedgerFacet(address(diamond)).getSlotLedger(lender2, mockERC20, mockCollateralERC20, 0);
        assertEq(outLive, 0, "outgoing slot holds nothing");
        assertEq(inLive, afterLoan.principal, "incoming slot holds the principal outstanding");
        assertEq(inLive + outLive, fromSlots, "lent from slots is the sum of live");
        assertEq(inCapital, 0, "the incoming slot's capital paid it");
        assertEq(inFillable, 0, "so it has nothing fillable");
        (, uint256 available, , , ) =
            MarketLedgerFacet(address(diamond)).getPairLedger(mockERC20, mockCollateralERC20);
        assertEq(available, outFillable + inFillable, "available is the sum of fillable amounts");
    }

    /// @dev A takeover is a fill of the incoming slot, so it runs the same
    ///      calm-price check as any other fill of that slot: with no recent
    ///      hourly checkpoints for the pair it is refused.
    function test_refusedWithoutRecentPriceCheckpoints() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferPriceGuardFacet.IntentPairNoCheckpoint.selector, mockERC20, mockCollateralERC20
            )
        );
        _takeover(lender, loanId, lender2);
    }

    /// @dev The takeover runs the one new-loan check the accept runs, read
    ///      live and branch-aware, not a fixed 1.5 default: in the
    ///      depth-tiered regime a new loan is admitted at health factor 1.0
    ///      (the tier cap is the binding buffer), so a tiered loan at 1.2 is
    ///      taken on as new.
    function test_tieredLoanIsTakenOnAtTheTieredFloor() public {
        address[] memory paa = new address[](2);
        paa[0] = mockERC20;
        paa[1] = mockCollateralERC20;
        ConfigFacet(address(diamond)).setPaaAssets(paa);
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(CollateralConcentrationFacet.newLoanInitLtvCapBps.selector),
            abi.encode(uint256(6500), uint8(3), uint8(0), false)
        );
        _mockLtv(MAX_INIT_LTV_BPS);
        uint256 loanId = _openAndOffer(500, TERM, true);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        LibTestCalmPair.checkpoint(address(diamond), mockERC20, mockCollateralERC20);
        vm.mockCall(
            address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector), abi.encode(1.2e18)
        );
        _takeover(lender, loanId, lender2);
        assertEq(_loan(loanId).lender, lender2, "taken on as new");
    }

    function test_refusedWithoutTakeoverConsent() public {
        uint256 loanId = _openAndOffer(500, TERM, false);
        vm.expectRevert(InstantTakeoverFacet.InstantTakeoverNotOffered.selector);
        _takeover(lender, loanId, lender2);
    }

    function test_refusedWhenLoanRateBelowSlotMinimum() public {
        uint256 loanId = _openAndOffer(600, TERM, true);
        vm.expectRevert(
            abi.encodeWithSelector(InstantTakeoverFacet.InstantTakeoverRateBelowSlot.selector, 500, 600)
        );
        _takeover(lender, loanId, lender2);
    }

    function test_refusedWhenDueDatePastSlotTerm() public {
        uint256 loanId = _openAndOffer(500, 10, true);
        vm.expectPartialRevert(InstantTakeoverFacet.InstantTakeoverTermPastSlot.selector);
        _takeover(lender, loanId, lender2);
    }

    function test_refusedWhenLtvAboveSlotLimit() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        _mockLtv(MAX_INIT_LTV_BPS + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                InstantTakeoverFacet.InstantTakeoverLtvAboveSlot.selector, MAX_INIT_LTV_BPS + 1, MAX_INIT_LTV_BPS
            )
        );
        _takeover(lender, loanId, lender2);
    }

    function test_refusedIntoTheBorrower() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        vm.expectRevert(abi.encodeWithSelector(InstantTakeoverFacet.InstantTakeoverSameParty.selector, taker));
        _takeover(lender, loanId, taker);
    }

    function test_refusedForANonInstantLoan() public {
        vm.expectRevert(abi.encodeWithSelector(InstantTakeoverFacet.InstantLoanNotEligible.selector, 999));
        _takeover(lender, 999, lender2);
    }

    /// @dev The standing-intent fill switch stops a takeover drawing the
    ///      incoming slot's capital, as it stops a match.
    function test_refusedWhenIntentFillsOff() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(false);
        vm.expectRevert(abi.encodeWithSignature("FunctionDisabled(uint8)", uint8(4)));
        _takeover(lender, loanId, lender2);
    }

    /// @dev A locked incoming account opens no new commitment, so its slot
    ///      cannot take a loan over.
    function test_refusedWhenTheIncomingAccountIsLocked() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        LibTestProtection.enable(address(diamond), lender2, 2 days);
        LibTestProtection.lock(address(diamond), lender2, lender2);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.ProtectedVaultLocked.selector, lender2));
        _takeover(lender, loanId, lender2);
    }

    function test_refusedWhenMarketOff() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        vm.prank(owner);
        InstantMarketFacet(address(diamond)).setInstantMarketEnabled(false);
        vm.expectRevert(InstantMarketFacet.InstantMarketDisabled.selector);
        _takeover(lender, loanId, lender2);
    }

    /// @dev A keeper holding the holder's early-withdrawal mandate for the
    ///      loan starts it; the proceeds still reach the holder's vault.
    function test_aMandatedKeeperStartsItForTheHolder() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        LibTestCalmPair.checkpoint(address(diamond), mockERC20, mockCollateralERC20);
        address keeper = makeAddr("takeover-keeper");
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(keeper, LibVaipakam.KEEPER_ACTION_INIT_EARLY_WITHDRAW);
        vm.prank(lender);
        ProfileFacet(address(diamond)).setLoanKeeperEnabled(loanId, keeper, true);
        uint256 holderVaultBefore = _vaultBal(lender, mockERC20);
        _takeover(keeper, loanId, lender2);
        assertEq(_vaultBal(lender, mockERC20) - holderVaultBefore, PRINCIPAL, "holder paid face value");
        assertEq(_loan(loanId).lender, lender2, "position moved");
    }

    /// @dev Only the position's holder (or its direct-sale keeper) starts it.
    function test_refusedForAStranger() public {
        uint256 loanId = _openAndOffer(500, TERM, true);
        vm.expectRevert();
        _takeover(lender2, loanId, lender2);
    }
}
