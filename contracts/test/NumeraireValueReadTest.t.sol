// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibFacet} from "../src/libraries/LibFacet.sol";
import {LibNumeraireValueRead} from "../src/libraries/LibNumeraireValueRead.sol";
import {NumeraireValueFacet} from "../src/facets/NumeraireValueFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Test-only facet exposing the best-effort read and the fee log, cut
///      into the test Diamond so both run in the Diamond's context.
contract NumeraireValueReadProbeFacet {
    function probeTryValue(address asset, uint256 amount, bool roundUp)
        external
        view
        returns (bool ok, uint256 value)
    {
        return LibNumeraireValueRead.tryValue(asset, amount, roundUp);
    }

    function probeRecordFee(address asset, uint256 amount) external {
        LibFacet.recordTreasuryAccrual(asset, amount);
    }

    function probeFeeLogLength() external view returns (uint256) {
        return LibVaipakam.storageSlot().feeLedger.length;
    }

    function probeFeeLogValue(uint256 i) external view returns (uint192) {
        return LibVaipakam.storageSlot().feeLedger[i].numeraireValue;
    }

    function probeCumulativeFees() external view returns (uint256) {
        return LibVaipakam.storageSlot().feeLedgerTotal;
    }

    function probeSetCumulativeFees(uint256 v) external {
        LibVaipakam.storageSlot().feeLedgerTotal = v;
    }
}

/// @title NumeraireValueReadTest
/// @notice The best-effort valuation read (#2419) and the sites that use it:
///         the fee log, the metrics views and the periodic-interest cadence
///         threshold. Every value is the shared rule's, 1e18-scaled, so one
///         numeraire unit is 1e18 whatever the token's decimals; a value the
///         rule refuses reads as "unvalued" and never reverts the caller.
contract NumeraireValueReadTest is SetupTest {
    NumeraireValueReadProbeFacet internal probe;
    address internal usd6; // 6-decimal token at $1
    address internal usd0; // 0-decimal token at $1

    function setUp() public {
        setupHelper();

        NumeraireValueReadProbeFacet impl = new NumeraireValueReadProbeFacet();
        bytes4[] memory sels = new bytes4[](6);
        sels[0] = NumeraireValueReadProbeFacet.probeTryValue.selector;
        sels[1] = NumeraireValueReadProbeFacet.probeRecordFee.selector;
        sels[2] = NumeraireValueReadProbeFacet.probeFeeLogLength.selector;
        sels[3] = NumeraireValueReadProbeFacet.probeFeeLogValue.selector;
        sels[4] = NumeraireValueReadProbeFacet.probeCumulativeFees.selector;
        sels[5] = NumeraireValueReadProbeFacet.probeSetCumulativeFees.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(impl),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        probe = NumeraireValueReadProbeFacet(address(diamond));

        usd6 = address(new ERC20Mock("USD6", "USD6", 6));
        usd0 = address(new ERC20Mock("USD0", "USD0", 0));
        mockOraclePrice(usd6, 1e8, 8);
        mockOraclePrice(usd0, 1e8, 8);
    }

    // ─── The read itself ────────────────────────────────────────────────

    /// @dev One whole token at $1 is worth 1e18 at 0, 6 and 18 decimals.
    function test_tryValue_oneUnitIs1e18AtEveryDecimals() public view {
        (bool ok, uint256 v) = probe.probeTryValue(mockERC20, 1 ether, false);
        assertTrue(ok);
        assertEq(v, 1e18, "18 decimals");
        (ok, v) = probe.probeTryValue(usd6, 1e6, false);
        assertTrue(ok);
        assertEq(v, 1e18, "6 decimals");
        (ok, v) = probe.probeTryValue(usd0, 1, false);
        assertTrue(ok);
        assertEq(v, 1e18, "0 decimals");
    }

    /// @dev The read is the binding rule's answer, in both roundings.
    function test_tryValue_agreesWithTheBindingRule() public {
        mockOraclePrice(mockCollateralERC20, 3, 8); // $0.00000003 per token
        // 50,000,001 wei x 3 / 1e8 = 1.50000003 → floor 1, ceil 2.
        for (uint256 i = 0; i < 2; ++i) {
            bool up = i == 1;
            (bool ok, uint256 v) = probe.probeTryValue(mockCollateralERC20, 50_000_001, up);
            assertTrue(ok);
            assertEq(
                v,
                NumeraireValueFacet(address(diamond)).getNumeraireValue(mockCollateralERC20, 50_000_001, up)
            );
            assertEq(v, up ? 2 : 1);
        }
    }

    /// @dev Every refusal of the rule reads as unvalued, never as a revert.
    function test_tryValue_refusalsReadAsUnvalued() public {
        (bool ok, uint256 v) = probe.probeTryValue(address(0), 1 ether, false);
        assertFalse(ok, "zero address");
        assertEq(v, 0);

        vm.mockCallRevert(usd6, abi.encodeWithSignature("decimals()"), "");
        (ok, v) = probe.probeTryValue(usd6, 1e6, false);
        assertFalse(ok, "unreadable decimals");
        assertEq(v, 0);

        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, usd0),
            ""
        );
        (ok, v) = probe.probeTryValue(usd0, 1, false);
        assertFalse(ok, "no price");

        // A value beyond 256 bits overflows inside the rule.
        mockOraclePrice(mockCollateralERC20, type(uint128).max, 8);
        (ok, v) = probe.probeTryValue(mockCollateralERC20, type(uint160).max, false);
        assertFalse(ok, "overflow");
        assertEq(v, 0);
    }

    /// @dev A zero amount of a priced asset is a value (0), not a refusal,
    ///      so a caller can tell "nothing to value" from "unpriced".
    function test_tryValue_zeroAmountOfAPricedAssetIsValued() public view {
        (bool ok, uint256 v) = probe.probeTryValue(usd6, 0, false);
        assertTrue(ok);
        assertEq(v, 0);
    }

    // ─── The fee log ────────────────────────────────────────────────────

    /// @dev A fee is logged at the shared rule's 1e18 value whatever the
    ///      token's decimals; an unvalued fee is logged at 0 and the
    ///      accrual itself still lands.
    function test_feeLog_valuesEachFeeAt1e18() public {
        probe.probeRecordFee(usd6, 2_500_000); // 2.5 tokens at $1
        probe.probeRecordFee(usd0, 3); // 3 tokens at $1
        uint256 n = probe.probeFeeLogLength();
        assertEq(probe.probeFeeLogValue(n - 2), 2.5e18, "6 decimals");
        assertEq(probe.probeFeeLogValue(n - 1), 3e18, "0 decimals");
        assertEq(probe.probeCumulativeFees(), 5.5e18);

        vm.mockCallRevert(usd6, abi.encodeWithSignature("decimals()"), "");
        probe.probeRecordFee(usd6, 1e6);
        assertEq(probe.probeFeeLogLength(), n + 1, "logged");
        assertEq(probe.probeFeeLogValue(n), 0, "unvalued fee logs 0");
        assertEq(probe.probeCumulativeFees(), 5.5e18, "total unchanged");
    }

    /// @dev The log never blocks the settlement it records: an event value
    ///      above the field's width is stored at its maximum, and the total
    ///      stops at the uint256 maximum instead of overflowing.
    function test_feeLog_saturatesInsteadOfReverting() public {
        // 1e40 whole tokens at $1 = 1e58 numeraire, above 2^192 (~6.28e57).
        probe.probeRecordFee(mockERC20, 1e58);
        uint256 n = probe.probeFeeLogLength();
        assertEq(probe.probeFeeLogValue(n - 1), type(uint192).max, "event saturates");
        assertEq(probe.probeCumulativeFees(), 1e58, "total keeps the full value");

        probe.probeSetCumulativeFees(type(uint256).max - 1);
        probe.probeRecordFee(mockERC20, 1 ether);
        assertEq(probe.probeCumulativeFees(), type(uint256).max, "total saturates");
    }

    // ─── Metrics ────────────────────────────────────────────────────────

    function _seedLoan(address principalAsset, uint256 principal, address collateralAsset, uint256 collateral)
        internal
    {
        LibVaipakam.Loan memory l;
        l.id = 1;
        l.lender = lender;
        l.borrower = borrower;
        l.principal = principal;
        l.principalAsset = principalAsset;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.collateralAsset = collateralAsset;
        l.collateralAmount = collateral;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.interestRateBps = 500;
        l.status = LibVaipakam.LoanStatus.Active;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(1, l);
        TestMutatorFacet(address(diamond)).setNextLoanId(2);
    }

    /// @dev Metrics value each leg at 1e18 per numeraire unit, whatever the
    ///      token's decimals: 1.5 of a 6-decimal principal plus 3 of an
    ///      18-decimal collateral is 4.5 units.
    function test_metrics_valueEachLegAt1e18() public {
        _seedLoan(usd6, 1_500_000, mockCollateralERC20, 3 ether);
        (uint256 tvl, uint256 erc20Col,) = MetricsFacet(address(diamond)).getProtocolTVL();
        assertEq(erc20Col, 3e18, "collateral");
        assertEq(tvl, 4.5e18, "principal + collateral");
    }

    /// @dev An asset the rule cannot value counts as 0 and never reverts the
    ///      aggregate.
    function test_metrics_unvaluedLegCountsAsZero() public {
        _seedLoan(usd6, 1_500_000, mockCollateralERC20, 3 ether);
        vm.mockCallRevert(mockCollateralERC20, abi.encodeWithSignature("decimals()"), "");
        (uint256 tvl, uint256 erc20Col,) = MetricsFacet(address(diamond)).getProtocolTVL();
        assertEq(erc20Col, 0, "unvalued collateral");
        assertEq(tvl, 1.5e18, "principal still counted");
    }

    // ─── Periodic-interest cadence threshold ────────────────────────────

    function _cadenceOffer(uint256 amount) internal returns (uint256) {
        vm.prank(lender);
        return OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 400_000 ether,
                durationDays: 60,
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
                amountMax: amount,
                interestRateBpsMax: 500,
                collateralAmountMax: 400_000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.Monthly,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    /// @dev The cadence threshold ($100k by default) compares the principal's
    ///      1e18 value: $150k of a 6-decimal principal clears it, $50k does
    ///      not.
    function test_cadenceThreshold_readsTheSharedValue() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        vm.mockCall(mockERC20, abi.encodeWithSignature("decimals()"), abi.encode(uint256(6)));

        _cadenceOffer(150_000e6);

        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        _cadenceOffer(50_000e6);
    }
}
