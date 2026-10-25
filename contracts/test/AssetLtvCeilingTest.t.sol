// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferBounds} from "../src/libraries/LibOfferBounds.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";

/// @title AssetLtvCeilingTest
/// @notice #2696: the per-asset init-LTV value is an OPTIONAL ceiling. Any
///         ERC-20 that passes the liquidity test may back a loan, and a fresh
///         deployment needs no per-asset LTV setting, so an asset nobody has
///         configured is not refused: the admission health-factor floor (or
///         the tier cap in the depth-tiered regime) is what binds. A ceiling
///         governance sets still tightens. The risk-profile view says whether
///         a ceiling was set instead of reporting an unset row as a number.
contract AssetLtvCeilingTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;

    /// @dev `Storage.assetRiskParams` is slot 22 of the Diamond's namespace
    ///      (region 22 of the vaipakam namespace in the storage-layout golden file).
    uint256 internal constant ASSET_RISK_PARAMS_SLOT = 22;

    function setUp() public {
        setupHelper();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Return `asset`'s row to its never-configured state. The setter
    ///      cannot write a zero ceiling, so a fresh deployment's row is only
    ///      reachable by clearing storage.
    function _clearCeiling(address asset) internal {
        bytes32 row = keccak256(
            abi.encode(asset, uint256(LibVaipakam.VANGKI_STORAGE_POSITION) + ASSET_RISK_PARAMS_SLOT)
        );
        vm.store(address(diamond), row, bytes32(0)); // loanInitMaxLtvBps
    }

    function _params(uint256 collateral) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: collateral,
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
            amountMax: PRINCIPAL,
            interestRateBpsMax: 500,
            collateralAmountMax: collateral,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _profile(address asset)
        internal
        view
        returns (bool ceilingSet, uint256 ceilingBps)
    {
        (, , ceilingSet, ceilingBps, ) = OracleFacet(address(diamond)).getAssetRiskProfile(asset);
    }

    // ─── The unset row ───────────────────────────────────────────────────────

    /// @dev The fixture is live: SetupTest configures an 80% ceiling.
    function test_fixture_configuredCeilingIsReported() public view {
        (bool set, uint256 bps) = _profile(mockCollateralERC20);
        assertTrue(set, "fixture-live: the collateral has a ceiling");
        assertEq(bps, 8000);
    }

    function test_unsetCeiling_isDisclosedAsUnset() public {
        _clearCeiling(mockCollateralERC20);
        (bool set, uint256 bps) = _profile(mockCollateralERC20);
        assertFalse(set, "an unset row is reported as unset");
        assertEq(bps, LibVaipakam.BASIS_POINTS, "and as no ceiling, not as 0%");
    }

    /// @dev Before #2696 an unset row read as a 0% ceiling and every liquid
    ///      loan against the asset was refused (`LTVExceeded`).
    function test_unsetCeiling_liquidLoanOpens() public {
        _clearCeiling(mockCollateralERC20);
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(_params(2000 ether));
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "a loan against an unconfigured liquid asset opens"
        );
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).initLtvCapBpsAtInit,
            LibVaipakam.BASIS_POINTS,
            "the loan records that no per-asset ceiling applied"
        );
    }

    /// @dev No ceiling is not no bound: at $1 / $1 the 1.5 admission floor
    ///      needs at least 1,667 of collateral per 1,000 borrowed even at the
    ///      highest (90%) tier liquidation threshold, so 1,500 is refused.
    function test_unsetCeiling_healthFactorFloorStillBinds() public {
        _clearCeiling(mockCollateralERC20);
        vm.prank(lender);
        vm.expectPartialRevert(LibOfferBounds.MinCollateralBelowFloor.selector);
        OfferCreateFacet(address(diamond)).createOffer(_params(1500 ether));
    }

    // ─── A set ceiling ───────────────────────────────────────────────────────

    /// @dev A ceiling governance sets is still enforced: at 40% a 50% loan is
    ///      refused even though its health factor would pass.
    function test_setCeiling_stillTightens() public {
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 4000, 300);
        vm.prank(lender);
        vm.expectPartialRevert(LibOfferBounds.MinCollateralBelowFloor.selector);
        OfferCreateFacet(address(diamond)).createOffer(_params(2000 ether));
    }

    /// @dev The setter takes no reserve factor any more (retired, #2696), and
    ///      its event carries only the two values it stores.
    function test_setter_emitsTwoValues() public {
        vm.expectEmit(address(diamond));
        emit RiskFacet.RiskParamsUpdated(mockCollateralERC20, 7000, 200);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 7000, 200);
        (bool set, uint256 bps) = _profile(mockCollateralERC20);
        assertTrue(set);
        assertEq(bps, 7000);
    }
}
