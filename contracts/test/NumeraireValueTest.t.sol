// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibNumeraireValue} from "../src/libraries/LibNumeraireValue.sol";
import {LibRiskMath} from "../src/libraries/LibRiskMath.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {NumeraireValueFacet} from "../src/facets/NumeraireValueFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";

/// @dev External wrapper so `vm.expectRevert` can catch the library's
///      internal reverts.
contract NumeraireValueHarness {
    function toValue(uint256 a, uint256 p, uint8 fd, uint8 td, bool up) external pure returns (uint256) {
        return LibNumeraireValue.toValue(a, p, fd, td, up);
    }

    function toAmount(uint256 v, uint256 p, uint8 fd, uint8 td, bool up) external pure returns (uint256) {
        return LibNumeraireValue.toAmount(v, p, fd, td, up);
    }

    function tryTokenDecimals(address t) external view returns (bool, uint8) {
        return LibNumeraireValue.tryTokenDecimals(t);
    }

    function tokenDecimals(address t) external view returns (uint8) {
        return LibNumeraireValue.tokenDecimals(t);
    }
}

/// @dev `decimals()` answers for the reader tests.
contract DecimalsAnswer {
    uint256 internal immutable d;

    constructor(uint256 d_) {
        d = d_;
    }

    function decimals() external view returns (uint256) {
        return d;
    }
}

contract DecimalsReverts {
    function decimals() external pure returns (uint8) {
        revert("no");
    }
}

contract DecimalsShortAnswer {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 6)
            return(0, 16)
        }
    }
}

/// @title NumeraireValueRuleTest
/// @notice The one 1e18 valuation rule (#2419): exact values across token and
///         feed decimals, the rounding each direction promises, the inverse,
///         and the named refusals.
contract NumeraireValueRuleTest is Test {
    NumeraireValueHarness internal h;

    function setUp() public {
        h = new NumeraireValueHarness();
    }

    /// @dev 1.5 tokens at a price of 2.5 is worth exactly 3.75 numeraire
    ///      units, 3.75e18, at every token / feed decimals combination — no
    ///      division leaves a remainder, so both roundings agree.
    function test_toValue_exactAcrossDecimalsGrid() public view {
        uint8[5] memory tds = [uint8(0), 6, 8, 18, 24];
        uint8[2] memory fds = [uint8(8), 18];
        for (uint256 i; i < tds.length; ++i) {
            for (uint256 j; j < fds.length; ++j) {
                uint8 td = tds[i];
                uint8 fd = fds[j];
                // A 0-decimal token has no half unit: 6 tokens at 2.5 = 15.
                (uint256 amount, uint256 expected) = td == 0
                    ? (uint256(6), uint256(15e18))
                    : ((15 * 10 ** td) / 10, uint256(3.75e18));
                uint256 price = (25 * 10 ** fd) / 10;
                assertEq(h.toValue(amount, price, fd, td, false), expected, "floor");
                assertEq(h.toValue(amount, price, fd, td, true), expected, "ceil");
            }
        }
    }

    /// @dev A leg worth under one numeraire unit keeps its value: 0.4 of a
    ///      6-decimal stablecoin at $1 (8-decimal feed) is 0.4e18.
    function test_toValue_subUnitLegIsNotZero() public view {
        assertEq(h.toValue(400_000, 1e8, 8, 6, false), 0.4e18);
        assertEq(h.toValue(400_000, 1e8, 8, 6, true), 0.4e18);
    }

    /// @dev One rounding, in the named direction: 1 wei of an 18-decimal
    ///      token at an 8-decimal price of 1 is 1e-8 of a 1e-18 unit.
    function test_toValue_roundsInTheNamedDirection() public view {
        assertEq(h.toValue(1, 1, 8, 18, false), 0);
        assertEq(h.toValue(1, 1, 8, 18, true), 1);
        assertEq(h.toValue(0, 1e8, 8, 18, true), 0, "zero amount is zero either way");
    }

    /// @dev Small scales multiply up exactly (no division at all).
    function test_toValue_belowEighteenDecimalsIsExact() public view {
        // 0-decimal token, 8-decimal feed: scale 8, so ×10^10.
        assertEq(h.toValue(3, 2e8, 8, 0, false), 6e18);
    }

    function test_toValue_refusesZeroPrice() public {
        vm.expectRevert(LibNumeraireValue.PriceZero.selector);
        h.toValue(1e18, 0, 8, 18, false);
        vm.expectRevert(LibNumeraireValue.PriceZero.selector);
        h.toAmount(1e18, 0, 8, 18, true);
    }

    /// @dev A scale 10^(sum − 18) cannot represent above 95 is refused by
    ///      name; 95 itself (gap 77) still works.
    function test_toValue_refusesUnrepresentableScale() public {
        assertEq(h.toValue(10 ** 77, 1, 59, 36, false), 1);
        vm.expectRevert(abi.encodeWithSelector(LibNumeraireValue.NumeraireScaleUnsupported.selector, 96));
        h.toValue(1, 1, 60, 36, false);
        vm.expectRevert(abi.encodeWithSelector(LibNumeraireValue.NumeraireScaleUnsupported.selector, 96));
        h.toAmount(1, 1, 60, 36, false);
    }

    /// @dev The inverse's guarantee, both ways, at a scale above 18 and one
    ///      below it: rounding up gives the SMALLEST amount whose floored
    ///      value reaches the target; rounding down the LARGEST whose
    ///      ceiled value stays within it.
    function testFuzz_toAmount_isTheTightInverse(uint96 rawValue, uint64 rawPrice, bool highScale) public view {
        uint256 value = uint256(rawValue) + 1;
        uint256 price = uint256(rawPrice) + 1;
        (uint8 fd, uint8 td) = highScale ? (uint8(8), uint8(18)) : (uint8(8), uint8(0));

        uint256 up = h.toAmount(value, price, fd, td, true);
        assertGe(h.toValue(up, price, fd, td, false), value, "ceil amount reaches the value");
        if (up > 0) assertLt(h.toValue(up - 1, price, fd, td, false), value, "and is the smallest");

        uint256 down = h.toAmount(value, price, fd, td, false);
        assertLe(h.toValue(down, price, fd, td, true), value, "floor amount stays within");
        assertGt(h.toValue(down + 1, price, fd, td, true), value, "and is the largest");
    }

    function test_tryTokenDecimals_readsAndRefuses() public {
        (bool ok, uint8 d) = h.tryTokenDecimals(address(new DecimalsAnswer(6)));
        assertTrue(ok);
        assertEq(d, 6);

        (ok, d) = h.tryTokenDecimals(address(new DecimalsAnswer(36)));
        assertTrue(ok, "36 is the largest accepted");
        assertEq(d, 36);

        address tooMany = address(new DecimalsAnswer(37));
        (ok, d) = h.tryTokenDecimals(tooMany);
        assertFalse(ok, "above 36 is unreadable");
        assertEq(d, 0);

        (ok,) = h.tryTokenDecimals(address(0xBEEF));
        assertFalse(ok, "no code");
        (ok,) = h.tryTokenDecimals(address(new DecimalsReverts()));
        assertFalse(ok, "reverting");
        (ok,) = h.tryTokenDecimals(address(new DecimalsShortAnswer()));
        assertFalse(ok, "short answer");

        vm.expectRevert(abi.encodeWithSelector(LibNumeraireValue.TokenDecimalsUnreadable.selector, tooMany));
        h.tokenDecimals(tooMany);
    }
}

/// @title NumeraireValueRiskTest
/// @notice The risk path on the shared rule (#2419): sub-unit and near-unit
///         legs are valued at full precision; the facet's views route; an
///         unreadable token is refused by name.
contract NumeraireValueRiskTest is SetupTest {
    uint256 internal loanId;

    function setUp() public {
        setupHelper();
        vm.clearMockedCalls();
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1800 ether,
                durationDays: 30,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1800 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
        loanId = 1;
    }

    function _setLegs(uint256 principal, uint256 collateral) internal {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.principal = principal;
        loan.collateralAmount = collateral;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
    }

    /// @dev Near-unit legs keep their ratio at 1e18 precision: 1.6 / 1.9 is
    ///      an LTV of 84.21%.
    function test_nearUnitLegsKeepTheirRatio() public {
        _setLegs(1.6 ether, 1.9 ether);
        assertEq(RiskFacet(address(diamond)).calculateLTV(loanId), 8421);
    }

    /// @dev A debt worth under one unit is valued as a debt: a nonzero LTV
    ///      and a finite HF.
    function test_subUnitDebtIsADebt() public {
        _setLegs(0.4 ether, 1800 ether);
        assertEq(RiskFacet(address(diamond)).calculateLTV(loanId), 2); // 0.4 / 1800
        assertLt(RiskFacet(address(diamond)).calculateHealthFactor(loanId), type(uint256).max);
    }

    /// @dev The token's own decimals scale the value: 0.5 of a 6-decimal
    ///      principal against $1,800 is still an LTV of 2 bps.
    function test_tokenDecimalsScaleTheValue() public {
        vm.mockCall(mockERC20, abi.encodeWithSignature("decimals()"), abi.encode(uint256(6)));
        _setLegs(500_000, 1800 ether);
        assertEq(RiskFacet(address(diamond)).calculateLTV(loanId), 2);
        assertEq(
            NumeraireValueFacet(address(diamond)).getNumeraireValue(mockERC20, 500_000, true),
            0.5e18
        );
    }

    /// @dev The facet's two views, through the Diamond, at the oracle's price.
    function test_facetViewsRoute() public view {
        NumeraireValueFacet v = NumeraireValueFacet(address(diamond));
        assertEq(v.getNumeraireValue(mockCollateralERC20, 3 ether, false), 3e18);
        assertEq(v.getAmountForNumeraireValue(mockCollateralERC20, 3e18, true), 3 ether);
    }

    /// @dev The KYC read: a liquid asset is valued by the rule, rounded down;
    ///      an asset that is not liquid is worth 0 (README: illiquid assets
    ///      count for nothing in a KYC comparison).
    function test_liquidValueForKyc() public {
        NumeraireValueFacet v = NumeraireValueFacet(address(diamond));
        mockOraclePrice(mockCollateralERC20, 3, 8); // $0.00000003 per token
        // 50,000,001 wei x 3 / 1e8 = 1.50000003, floored to 1.
        assertEq(v.getLiquidNumeraireValue(mockCollateralERC20, 50_000_001), 1, "rounds down");
        assertEq(v.getLiquidNumeraireValue(mockCollateralERC20, 1 ether), 3e10);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid);
        assertEq(v.getLiquidNumeraireValue(mockCollateralERC20, 1 ether), 0, "illiquid is 0");
    }

    /// @dev The one health-factor rule: both divisions floored, each step at
    ///      full precision, so a value whose plain product with HF_SCALE would
    ///      overflow still yields its HF; no debt and an unrepresentable HF
    ///      both read as the maximum.
    function test_healthFactorRule() public pure {
        // floor(floor(3e18 * 8000 / 1e4) * 1e18 / 2e18) = 1.2e18
        assertEq(LibRiskMath.healthFactor(3e18, 8000, 2e18), 1.2e18, "small exact");
        // floor(floor(10 * 8333 / 1e4) * 1e18 / 7): 8 * 1e18 / 7, floored
        assertEq(LibRiskMath.healthFactor(10, 8333, 7), uint256(8e18) / 7, "both floors");
        // 1e60 x 8500 / 1e4 = 8.5e59; 8.5e59 x 1e18 alone would overflow.
        assertEq(LibRiskMath.healthFactor(1e60, 8500, 1e60), 0.85e18, "large legs");
        assertEq(LibRiskMath.healthFactor(1e60, 8500, 0), type(uint256).max, "no debt");
        assertEq(
            LibRiskMath.healthFactor(type(uint256).max / 2, 10_000, 1),
            type(uint256).max,
            "saturates"
        );
    }

    /// @dev A token whose `decimals()` cannot be read is refused by name.
    function test_unreadableDecimalsAreRefused() public {
        vm.mockCallRevert(mockCollateralERC20, abi.encodeWithSignature("decimals()"), "");
        vm.expectRevert(
            abi.encodeWithSelector(LibNumeraireValue.TokenDecimalsUnreadable.selector, mockCollateralERC20)
        );
        RiskFacet(address(diamond)).calculateLTV(loanId);
    }

    /// @dev A dust floor stored below the one-unit minimum can only have been
    ///      written on the earlier whole-unit scale (the setter refuses one),
    ///      so it reads as no floor, in the getter and the reader alike.
    function test_oldScaleDustFloorReadsAsNoFloor() public {
        bytes32 slot = bytes32(uint256(LibVaipakam.VANGKI_STORAGE_POSITION) + 275);
        AdminFacet(address(diamond)).setPartialLiquidationSizing(0, 0, 5_000e18);
        // Self-check: the slot written below IS the dust floor.
        assertEq(uint256(vm.load(address(diamond), slot)), 5_000e18, "dust floor slot");
        (,, uint256 floor) = AdminFacet(address(diamond)).getPartialLiquidationSizing();
        assertEq(floor, 5_000e18);

        vm.store(address(diamond), slot, bytes32(uint256(2_000))); // $2k, whole units
        (,, floor) = AdminFacet(address(diamond)).getPartialLiquidationSizing();
        assertEq(floor, 0, "an old-scale floor is no floor");
    }
}
