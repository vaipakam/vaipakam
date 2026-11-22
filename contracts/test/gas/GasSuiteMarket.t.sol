// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {GasSuiteBase} from "./GasSuiteBase.sol";
import {InstantMarketBase} from "../InstantMarketTest.t.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LenderIntentFacet} from "../../src/facets/LenderIntentFacet.sol";
import {InstantMarketFacet} from "../../src/facets/InstantMarketFacet.sol";
import {InstantFillFacet} from "../../src/facets/InstantFillFacet.sol";
import {OfferMatchIntentFacet} from "../../src/facets/OfferMatchIntentFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  GasSuiteMarketTest
 * @notice The gas suite's Auto-lend and instant-market actions (#3915,
 *         RefactorRulesDesign §5.1): instant borrow with 1, 2, 4 and 8
 *         sources, the keeper's slot match, and setting, funding and
 *         cancelling a slot. Arranged on {InstantMarketBase}'s fixture (both
 *         pair assets read as liquidity tier 3), measured through
 *         {GasSuiteBase._measure}. `budgets.json` reads the instant-borrow
 *         rows to find the largest source count one transaction can carry.
 *
 * forge-config: default.isolate = true
 */
contract GasSuiteMarketTest is GasSuiteBase, InstantMarketBase {
    uint256 internal constant SLOT_SIZE = 1000 ether;

    /// @dev The instant-market setup, with SetupTest's fixed health-factor
    ///      and LTV answers removed ({GasSuiteBase._clearRiskMocks}) and the
    ///      base's liquidity-tier answers put back.
    function setUp() public override {
        super.setUp();
        _clearRiskMocks();
        vm.mockCall(
            address(diamond), abi.encodeWithSignature("getEffectiveLiquidityTier(address)", mockERC20), abi.encode(uint8(3))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSignature("getEffectiveLiquidityTier(address)", mockCollateralERC20),
            abi.encode(uint8(3))
        );
    }

    // ─── Instant borrow ──────────────────────────────────────────────────

    function test_gas_instant_borrow_1() public {
        _instantBorrow(1);
    }

    function test_gas_instant_borrow_2() public {
        _instantBorrow(2);
    }

    function test_gas_instant_borrow_4() public {
        _instantBorrow(4);
    }

    function test_gas_instant_borrow_8() public {
        _instantBorrow(8);
    }

    /// @dev `n` Auto-lend slots of {SLOT_SIZE}, each one rate step dearer,
    ///      and one borrow that takes all of them.
    function _instantBorrow(uint256 n) internal {
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](n);
        for (uint256 i; i < n; i++) {
            address who = _newParty(string.concat("gasSlot", vm.toString(i)));
            _slot(who, 500 + 10 * i, SLOT_SIZE, true);
            srcs[i] = _src(who);
        }
        _age();
        _measure(
            string.concat("instant_borrow_", vm.toString(n)),
            taker,
            abi.encodeCall(
                InstantMarketFacet.borrowInstant,
                (_req(n * SLOT_SIZE, n * SLOT_SIZE * 2, 500 + 10 * n, n * SLOT_SIZE), srcs)
            )
        );
    }

    // ─── Auto-lend slots ─────────────────────────────────────────────────

    function test_gas_slot_set() public {
        _measure("slot_set", lender2, _setSlotCall());
    }

    function test_gas_slot_fund() public {
        vm.prank(lender2);
        (bool ok,) = address(diamond).call(_setSlotCall());
        assertTrue(ok, "slot set");
        ERC20Mock(mockERC20).mint(lender2, SLOT_SIZE);
        _measure(
            "slot_fund",
            lender2,
            abi.encodeCall(LenderIntentFacet.fundLenderIntent, (mockERC20, mockCollateralERC20, 0, SLOT_SIZE))
        );
    }

    function test_gas_slot_cancel() public {
        _slot(lender2, 500, SLOT_SIZE, false);
        _measure(
            "slot_cancel",
            lender2,
            abi.encodeCall(LenderIntentFacet.cancelLenderIntent, (mockERC20, mockCollateralERC20, 0))
        );
    }

    /// @dev The keeper fills a borrower's offer from a slot (matchIntent).
    function test_gas_slot_match() public {
        _slot(lender2, RATE_BPS, SLOT_SIZE, false);
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Borrower);
        p.durationDays = TERM;
        uint256 offerId = _createOffer(taker, p);
        _age();
        _measure(
            "slot_match",
            makeAddr("gasSolver"),
            abi.encodeCall(OfferMatchIntentFacet.matchIntent, (lender2, mockERC20, mockCollateralERC20, 0, offerId, PRINCIPAL))
        );
    }

    function _setSlotCall() internal view returns (bytes memory) {
        return abi.encodeCall(
            LenderIntentFacet.setLenderIntent,
            (
                mockERC20,
                mockCollateralERC20,
                0,
                SLOT_SIZE,
                RATE_BPS,
                MAX_INIT_LTV_BPS,
                TERM,
                MIN_FILL,
                false,
                0,
                true,
                true,
                LibVaipakam.IntentRateTerms(0, 0, false),
                type(uint64).max
            )
        );
    }
}
