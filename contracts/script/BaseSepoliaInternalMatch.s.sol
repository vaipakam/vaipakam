// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "../test/helpers/LibAcceptTestSigner.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {RepriceTestnetMock} from "./RepriceTestnetMock.s.sol";
import {IRepriceDiamondViews} from "./lib/RepriceVenueReport.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title BaseSepoliaInternalMatch
 * @notice #2427 live verification — leaves a REAL internally matched ERC-20
 *         loan pair on a testnet Diamond, so the lender's claim card for
 *         `ClaimFacet.getOwedAtInternalMatch` can be seen against chain
 *         state rather than a scaffolded loan.
 *
 *         Why prices have to move. Two opposing loans (A: tLIQ lent against
 *         mUSDC, B: mUSDC lent against tLIQ) have LTVs whose PRODUCT does not
 *         depend on the tLIQ/mUSDC price, and each is born under the
 *         admission cap, so no single price makes both liquidatable. A real
 *         market gets there because the loans were opened at different
 *         prices. The script does the same with {RepriceTestnetMock}'s
 *         coherent feed + pool + venue move:
 *           1. tLIQ at `IM_P0_E8` — open A (lender LENDER, borrower BORROWER),
 *              its mUSDC collateral sized at 2x the principal's value from
 *              the Diamond's own mUSDC price and both tokens' decimals.
 *           2. tLIQ to `IM_P1_E8` — open B (lender NEW_LENDER, borrower
 *              NEW_BORROWER), sized so B's collateral equals A's principal
 *              and B's principal equals A's collateral.
 *           3. tLIQ to `IM_P2_E8` — both legs at/above their liquidation LTV.
 *           4. Only now is internal matching switched on (when it was off),
 *              and in the next transaction the matcher runs
 *              `triggerInternalMatchLiquidation(A, B, 0)`; both loans close
 *              `InternalMatched` in one step.
 *           5. tLIQ back to the price it had BEFORE the run (read at start,
 *              not assumed to be `IM_P0_E8`); the kill-switch back off unless
 *              `IM_KEEP_ENABLED=true`.
 *
 *         Every price move is three non-atomic owner-gated transactions (see
 *         {RepriceTestnetMock}); between steps 2 and 5 every tLIQ loan on the
 *         Diamond sees the moved price, and the run lists each one (all
 *         pages) with its LTV, or says it is unreadable. Broadcast with
 *         `--slow`.
 *
 *         Two races the script cannot close, stated rather than hidden:
 *         between steps 3 and 4 a keeper may liquidate either loan (step 4
 *         then reverts with tLIQ still moved), and between the enable and
 *         the trigger anyone may match an eligible pair. Recovery for both:
 *         re-run {RepriceTestnetMock} to restore the price and
 *         `setInternalMatchEnabled(false)` from the admin.
 *
 *         The kill-switch is never inferred from its current value. A run
 *         that finds it ON refuses unless `IM_ORIGINALLY_ENABLED=true` says
 *         that is the deployment's intended state — otherwise a run after a
 *         partial one would mistake that run's leftover for the original
 *         configuration and leave matching on.
 *
 *         Env (keys from contracts/.env): DEPLOYER_PRIVATE_KEY (mock owner,
 *         matcher), ADMIN_PRIVATE_KEY (kill-switch), LENDER_*, BORROWER_*,
 *         NEW_LENDER_*, NEW_BORROWER_*. Optional: IM_P0_E8 / IM_P1_E8 /
 *         IM_P2_E8, IM_PRINCIPAL_A (tLIQ wei), IM_RATE_BPS, IM_KEEP_ENABLED,
 *         IM_ORIGINALLY_ENABLED.
 */
contract BaseSepoliaInternalMatch is RepriceTestnetMock {
    struct Actors {
        uint256 deployerKey;
        uint256 adminKey;
        uint256 lenderKey;
        uint256 borrowerKey;
        uint256 newLenderKey;
        uint256 newBorrowerKey;
    }

    function run() external override {
        require(block.chainid == 84532 || block.chainid == 31337, "BaseSepoliaInternalMatch: Base Sepolia only");

        Actors memory a = Actors({
            deployerKey: vm.envUint("DEPLOYER_PRIVATE_KEY"),
            adminKey: vm.envUint("ADMIN_PRIVATE_KEY"),
            lenderKey: vm.envUint("LENDER_PRIVATE_KEY"),
            borrowerKey: vm.envUint("BORROWER_PRIVATE_KEY"),
            newLenderKey: vm.envUint("NEW_LENDER_PRIVATE_KEY"),
            newBorrowerKey: vm.envUint("NEW_BORROWER_PRIVATE_KEY")
        });
        uint256 p0 = vm.envOr("IM_P0_E8", uint256(2_000e8));
        uint256 p1 = vm.envOr("IM_P1_E8", uint256(8_000e8));
        uint256 p2 = vm.envOr("IM_P2_E8", uint256(4_000e8));
        uint256 principalA = vm.envOr("IM_PRINCIPAL_A", uint256(1e18)); // 1 tLIQ
        uint256 rateBps = vm.envOr("IM_RATE_BPS", uint256(1_000)); // 10% APR
        bool keepEnabled = vm.envOr("IM_KEEP_ENABLED", false);
        bool originallyEnabled = vm.envOr("IM_ORIGINALLY_ENABLED", false);

        RepriceTarget memory t = _resolveTarget("liquidToken");
        address mUsdc = _resolveTarget("liquidToken2").asset;
        _preflight(t, vm.addr(a.deployerKey));

        // A's collateral is worth 2x its principal at p0 (LTV 50%). B mirrors
        // it: principal = A's collateral, collateral = A's principal, so at
        // p2 = sqrt(p0 * p1) both legs sit at the same LTV and one step
        // closes both.
        uint256 collateralA = _collateralWorthTwice(t.diamond, t.asset, principalA, p0, mUsdc);
        uint256 priceBefore = _priceE8(t.diamond, t.asset);

        (bool wasEnabled,,) = ConfigFacet(t.diamond).getInternalMatchConfigBundle();
        require(
            !wasEnabled || originallyEnabled,
            "BaseSepoliaInternalMatch: internal matching is already ON - if a partial run left it on, switch it off first; set IM_ORIGINALLY_ENABLED=true only if ON is the intended state"
        );
        console.log("=== Base Sepolia internal-match scenario (#2427) ===");
        console.log("Diamond:            ", t.diamond);
        console.log("tLIQ:               ", t.asset);
        console.log("mUSDC:              ", mUsdc);
        console.log("internalMatchEnabled before:", wasEnabled);
        console.log("tLIQ price before (e8):", priceBefore);
        console.log("A: principal (tLIQ wei) / collateral (mUSDC wei):", principalA, collateralA);

        _reportExposure(t, 0, 0);
        _reprice(t, a.deployerKey, p0);
        uint256 loanA = _openLoan(
            t.diamond, a.lenderKey, a.borrowerKey, t.asset, principalA, mUsdc, collateralA, rateBps
        );
        _logLoan("A", t.diamond, loanA);

        _reprice(t, a.deployerKey, p1);
        uint256 loanB = _openLoan(
            t.diamond, a.newLenderKey, a.newBorrowerKey, mUsdc, collateralA, t.asset, principalA, rateBps
        );
        _logLoan("B", t.diamond, loanB);
        _reportExposure(t, loanA, loanB);

        _reprice(t, a.deployerKey, p2);
        _reportExposure(t, loanA, loanB);
        _logLoan("A @p2", t.diamond, loanA);
        _logLoan("B @p2", t.diamond, loanB);

        // Switched on only now, one transaction before the trigger, so the
        // permissionless match path is open for the shortest window the
        // script can give it.
        if (!wasEnabled) {
            vm.startBroadcast(a.adminKey);
            ConfigFacet(t.diamond).setInternalMatchEnabled(true);
            vm.stopBroadcast();
        }
        vm.startBroadcast(a.deployerKey);
        RiskMatchLiquidationFacet(t.diamond).triggerInternalMatchLiquidation(loanA, loanB, 0);
        vm.stopBroadcast();

        _reprice(t, a.deployerKey, priceBefore);
        if (!wasEnabled && !keepEnabled) {
            vm.startBroadcast(a.adminKey);
            ConfigFacet(t.diamond).setInternalMatchEnabled(false);
            vm.stopBroadcast();
        }

        _logRecord("A", t.diamond, loanA);
        _logRecord("B", t.diamond, loanB);
    }

    /// @dev The Diamond's own price for `asset`, in the 8-decimal scale the
    ///      reprice writes. Refuses a price that does not convert exactly,
    ///      rather than restoring an approximation of it.
    function _priceE8(address diamond, address asset) internal view returns (uint256) {
        (uint256 price, uint8 dec) = IRepriceDiamondViews(diamond).getAssetPrice(asset);
        require(price != 0, "BaseSepoliaInternalMatch: the oracle reads no price");
        if (dec >= 8) {
            require(price % 10 ** (dec - 8) == 0, "BaseSepoliaInternalMatch: price does not convert exactly to e8");
            return price / 10 ** (dec - 8);
        }
        return price * 10 ** (8 - dec);
    }

    /// @dev Raw `collAsset` worth twice `principal` of `lendAsset` at
    ///      `lendPrice8`, using the Diamond's live price for `collAsset` and
    ///      both tokens' own decimals.
    function _collateralWorthTwice(
        address diamond,
        address lendAsset,
        uint256 principal,
        uint256 lendPrice8,
        address collAsset
    ) internal view returns (uint256) {
        uint256 collPrice8 = _priceE8(diamond, collAsset);
        uint256 lendDec = IERC20Metadata(lendAsset).decimals();
        uint256 collDec = IERC20Metadata(collAsset).decimals();
        return (principal * lendPrice8 * 2 * 10 ** collDec) / (collPrice8 * 10 ** lendDec);
    }

    function _reprice(RepriceTarget memory t, uint256 ownerKey, uint256 price8) internal {
        uint160 spot = _targetSpot(t, price8);
        vm.startBroadcast(ownerKey);
        _applyReprice(t, price8, spot);
        vm.stopBroadcast();
        _verifyReprice(t, price8);
        console.log("tLIQ repriced to (e8):", price8);
    }

    /// @dev Lender offers `principal` of `lendAsset` against `collateral` of
    ///      `collAsset`; the borrower accepts. Mints both legs (faucet mocks).
    function _openLoan(
        address diamond,
        uint256 lenderKey,
        uint256 borrowerKey,
        address lendAsset,
        uint256 principal,
        address collAsset,
        uint256 collateral,
        uint256 rateBps
    ) internal returns (uint256 loanId) {
        address borrower = vm.addr(borrowerKey);
        vm.startBroadcast(lenderKey);
        ERC20Mock(lendAsset).mint(vm.addr(lenderKey), principal);
        ERC20Mock(lendAsset).approve(diamond, principal);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(
            _offerParams(lendAsset, principal, collAsset, collateral, rateBps)
        );
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory terms =
            LibAcceptTestSigner.buildTerms(diamond, borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(diamond, terms, borrowerKey);
        vm.startBroadcast(borrowerKey);
        ERC20Mock(collAsset).mint(borrower, collateral);
        ERC20Mock(collAsset).approve(diamond, collateral);
        loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, terms, sig);
        vm.stopBroadcast();
    }

    function _offerParams(address lendAsset, uint256 amount, address collAsset, uint256 collateral, uint256 rateBps)
        internal
        pure
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: lendAsset,
            amount: amount,
            interestRateBps: rateBps,
            collateralAsset: collAsset,
            collateralAmount: collateral,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: lendAsset,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amount,
            interestRateBpsMax: rateBps,
            collateralAmountMax: collateral,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    /// @dev Every OTHER Active loan touching tLIQ, with its LTV at the price
    ///      now in force — what the excursion does to loans this run does not
    ///      own. Walks every page of the active list. A loan whose LTV cannot
    ///      be read is listed as unreadable, never as a number.
    ///      Simulation-time log only; writes nothing.
    function _reportExposure(RepriceTarget memory t, uint256 skipA, uint256 skipB) internal view {
        uint256 pageSize = 200;
        console.log("Other Active tLIQ loans (id, LTV bps, liq floor bps):");
        for (uint256 offset;; offset += pageSize) {
            uint256[] memory ids = MetricsFacet(t.diamond).getActiveLoansPaginated(offset, pageSize);
            for (uint256 i; i < ids.length; ++i) {
                if (ids[i] == skipA || ids[i] == skipB) continue;
                LibVaipakam.Loan memory l = LoanFacet(t.diamond).getLoanDetails(ids[i]);
                if (l.principalAsset != t.asset && l.collateralAsset != t.asset) continue;
                if (l.status != LibVaipakam.LoanStatus.Active) continue;
                (bool ok, bytes memory ret) =
                    t.diamond.staticcall(abi.encodeWithSelector(RiskFacet.calculateLTV.selector, ids[i]));
                if (ok && ret.length == 32) {
                    console.log("  ", ids[i], abi.decode(ret, (uint256)), uint256(l.liquidationLtvBpsAtInit));
                } else {
                    console.log("   id %s: LTV unreadable (calculateLTV reverted); liq floor bps %s", ids[i], uint256(l.liquidationLtvBpsAtInit));
                }
            }
            if (ids.length < pageSize) break;
        }
    }

    function _logLoan(string memory tag, address diamond, uint256 loanId) internal view {
        LibVaipakam.Loan memory l = LoanFacet(diamond).getLoanDetails(loanId);
        console.log(string.concat("Loan ", tag, " id:"), loanId);
        console.log("  status / principal:", uint256(l.status), l.principal);
        console.log("  collateral / liqLtvBpsAtInit:", l.collateralAmount, uint256(l.liquidationLtvBpsAtInit));
        if (l.status == LibVaipakam.LoanStatus.Active) {
            console.log("  current LTV bps:", RiskFacet(diamond).calculateLTV(loanId));
        }
    }

    function _logRecord(string memory tag, address diamond, uint256 loanId) internal view {
        (uint256 principal, uint256 interest, uint256 lateFee, uint256 proceeds, uint64 at, bool incomplete) =
            ClaimFacet(diamond).getOwedAtInternalMatch(loanId);
        console.log(string.concat("getOwedAtInternalMatch(", tag, ") id:"), loanId);
        console.log("  status:", uint256(LoanFacet(diamond).getLoanDetails(loanId).status));
        console.log("  principal / interest:", principal, interest);
        console.log("  lateFee / lenderProceeds:", lateFee, proceeds);
        console.log("  recordedAt / incomplete:", uint256(at), incomplete);
    }
}
