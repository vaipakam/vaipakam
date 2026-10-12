// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
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
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3.sol";
import {MockSwapAdapter} from "../test/mocks/MockSwapAdapter.sol";

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
 *         coherent feed + pool + venue move.
 *
 *         The run is FOUR STAGES, one `forge script` invocation each, chosen
 *         by `IM_STAGE`. `forge script` simulates a whole body and then sends
 *         its transactions later, so any value a body reads — a loan id a
 *         call returns, the kill-switch, the book — is a simulation result
 *         by the time the broadcast lands. A stage boundary is where the
 *         chain is read again: each stage takes the ids the previous one
 *         actually produced (from its receipts, passed as env) and verifies
 *         them against the live chain before it sends anything.
 *
 *           `open-a`  Switch matching OFF (queued unconditionally — the
 *                     setter is idempotent, and the simulated value can be
 *                     stale by broadcast time). Print the three pre-run
 *                     price surfaces as the env line every later stage
 *                     needs. tLIQ to `IM_P0_E8`; open A (LENDER / BORROWER),
 *                     its mUSDC collateral worth 2x the principal at p0.
 *                     Ends at p0, where A is healthy.
 *           `open-b`  Verify `IM_LOAN_A` live (Active, parties, assets).
 *                     tLIQ to `IM_P1_E8`; open B (NEW_LENDER / NEW_BORROWER)
 *                     mirroring A's LIVE principal and collateral; tLIQ to
 *                     `IM_P2_E8`, where both legs sit at the same LTV.
 *                     Ends at p2 with matching still OFF.
 *           `match`   Verify `IM_LOAN_A` and `IM_LOAN_B` live. Matching ON,
 *                     `triggerInternalMatchLiquidation(A, B, 0)`, matching
 *                     OFF, the three price surfaces back to the `open-a`
 *                     snapshot exactly, then the kill-switch to the DECLARED
 *                     original state (ON only with `IM_ORIGINALLY_ENABLED`
 *                     or `IM_KEEP_ENABLED`).
 *           `restore` Recovery from any failed stage: matching OFF, the
 *                     snapshot restored, the switch to its declared state.
 *
 *         Every price move is three non-atomic owner-gated transactions (see
 *         {RepriceTestnetMock}) and every tLIQ position on the Diamond sees
 *         it. Each move lists every other tLIQ loan (LTV, or "unreadable";
 *         flagged when inside the external-liquidation priority window) and
 *         every open tLIQ offer (what is still fillable). Those lists are a
 *         snapshot taken at that STAGE's simulation: a position created
 *         after it is affected and not listed. Broadcast with `--slow`.
 *
 *         Races the script cannot close, stated rather than hidden:
 *           - Between stages the price stays moved: at p0 (after `open-a`)
 *             A is healthy; at p2 (after `open-b`) both A and B are at
 *             their liquidation LTV and a keeper may liquidate either, and
 *             every other tLIQ position sits at p2 until `match` or
 *             `restore` runs. Run the stages back to back.
 *           - Inside `open-a` / `open-b`, an offer created by someone else
 *             between the simulation and the accept takes the offer id the
 *             accept was signed for; the borrower's signed terms then do not
 *             match that offer and the accept reverts, leaving this run's
 *             offer open (cancel it). The loan id a stage prints is that
 *             stage's prediction; read the real one from the receipt's
 *             `LoanInitiated` before the next stage.
 *           - Between the enable and the trigger anyone may match an
 *             eligible pair (one transaction wide).
 *           - Open tLIQ offers may be accepted at a moved price; a loan born
 *             that way can be unsafe once the price is restored.
 *
 *         The kill-switch is never inferred from its current value. `open-a`
 *         refuses to start with it ON unless `IM_ORIGINALLY_ENABLED=true`
 *         says that is the deployment's intended state, and every stage that
 *         ends the run restores the declared state, not an observed one.
 *
 *         Env (keys from contracts/.env): DEPLOYER_PRIVATE_KEY (mock owner,
 *         matcher), ADMIN_PRIVATE_KEY (kill-switch), LENDER_*, BORROWER_*,
 *         NEW_LENDER_*, NEW_BORROWER_*; `IM_STAGE`. Stage inputs: IM_LOAN_A,
 *         IM_LOAN_B, and the snapshot IM_RESTORE_PRICE_E8 /
 *         IM_RESTORE_SPOT_X96 / IM_RESTORE_VENUE_E8 (printed by `open-a`).
 *         Optional: IM_P0_E8 / IM_P1_E8 / IM_P2_E8, IM_PRINCIPAL_A (tLIQ wei),
 *         IM_RATE_BPS, IM_KEEP_ENABLED, IM_ORIGINALLY_ENABLED.
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
        RepriceTarget memory t = _resolveTarget("liquidToken");
        address mUsdc = _resolveTarget("liquidToken2").asset;
        _preflight(t, vm.addr(a.deployerKey));

        string memory stage = vm.envString("IM_STAGE");
        bytes32 s = keccak256(bytes(stage));
        console.log("=== Base Sepolia internal-match scenario (#2427), stage:", stage);
        console.log("Diamond / tLIQ / mUSDC:", t.diamond, t.asset, mUsdc);
        _logMatchConfig(t.diamond);

        if (s == keccak256("open-a")) _stageOpenA(t, a, mUsdc);
        else if (s == keccak256("open-b")) _stageOpenB(t, a, mUsdc);
        else if (s == keccak256("match")) _stageMatch(t, a, mUsdc);
        else if (s == keccak256("restore")) _endRun(t, a, 0, 0);
        else revert("BaseSepoliaInternalMatch: IM_STAGE must be open-a, open-b, match or restore");
    }

    function _stageOpenA(RepriceTarget memory t, Actors memory a, address mUsdc) internal {
        uint256 p0 = vm.envOr("IM_P0_E8", uint256(2_000e8));
        uint256 principalA = vm.envOr("IM_PRINCIPAL_A", uint256(1e18)); // 1 tLIQ
        (bool wasEnabled,,) = ConfigFacet(t.diamond).getInternalMatchConfigBundle();
        require(
            !wasEnabled || vm.envOr("IM_ORIGINALLY_ENABLED", false),
            "BaseSepoliaInternalMatch: internal matching is already ON - if a partial run left it on, switch it off first; set IM_ORIGINALLY_ENABLED=true only if ON is the intended state"
        );
        // All three surfaces a move writes, for the stage that restores them.
        _priceE8(t.diamond, t.asset); // refuses a price that does not convert exactly to e8
        PriceReading memory before = _read(t);
        console.log("internalMatchEnabled before:", wasEnabled);
        console.log("Pass to `match` / `restore` - the pre-run price surfaces:");
        console.log(
            string.concat(
                "  IM_RESTORE_PRICE_E8=",
                vm.toString(_priceE8(t.diamond, t.asset)),
                " IM_RESTORE_SPOT_X96=",
                vm.toString(uint256(before.poolSpot)),
                " IM_RESTORE_VENUE_E8=",
                vm.toString(before.venuePrice8)
            )
        );

        // OFF before the first move, whatever the simulation read.
        _setMatching(t.diamond, a.adminKey, false);
        _reportExposure(t, 0, 0);
        _reprice(t, a.deployerKey, p0, 0, 0);
        uint256 collateralA = _collateralWorthTwice(t.diamond, t.asset, principalA, p0, mUsdc);
        uint256 loanA = _openLoan(
            t.diamond, a.lenderKey, a.borrowerKey, t.asset, principalA, mUsdc, collateralA, _rate()
        );
        _logLoan("A (predicted id - read LoanInitiated from the receipt)", t.diamond, loanA);
    }

    function _stageOpenB(RepriceTarget memory t, Actors memory a, address mUsdc) internal {
        uint256 loanA = vm.envUint("IM_LOAN_A");
        LibVaipakam.Loan memory la = _requireLeg(t.diamond, loanA, a.lenderKey, a.borrowerKey, t.asset, mUsdc);
        _requireMatchingOff(t.diamond);
        _reprice(t, a.deployerKey, vm.envOr("IM_P1_E8", uint256(8_000e8)), loanA, 0);
        // B mirrors A's LIVE terms: principal = A's collateral, collateral =
        // A's principal, so at p2 = sqrt(p0 * p1) both legs sit at one LTV.
        uint256 loanB = _openLoan(
            t.diamond, a.newLenderKey, a.newBorrowerKey, mUsdc, la.collateralAmount, t.asset, la.principal, _rate()
        );
        _logLoan("B (predicted id - read LoanInitiated from the receipt)", t.diamond, loanB);
        _reprice(t, a.deployerKey, vm.envOr("IM_P2_E8", uint256(4_000e8)), loanA, loanB);
        _logLoan("A @p2", t.diamond, loanA);
        _logLoan("B @p2", t.diamond, loanB);
    }

    function _stageMatch(RepriceTarget memory t, Actors memory a, address mUsdc) internal {
        uint256 loanA = vm.envUint("IM_LOAN_A");
        uint256 loanB = vm.envUint("IM_LOAN_B");
        LibVaipakam.Loan memory la = _requireLeg(t.diamond, loanA, a.lenderKey, a.borrowerKey, t.asset, mUsdc);
        LibVaipakam.Loan memory lb =
            _requireLeg(t.diamond, loanB, a.newLenderKey, a.newBorrowerKey, mUsdc, t.asset);
        require(
            lb.principal == la.collateralAmount && lb.collateralAmount == la.principal,
            "BaseSepoliaInternalMatch: IM_LOAN_B does not mirror IM_LOAN_A"
        );
        _requireMatchingOff(t.diamond);
        _reportExposure(t, loanA, loanB);
        // What each lender gives the matcher, from the live config and the
        // live principals - the deduction the claim card should reflect.
        (, , uint256 incentiveBps) = ConfigFacet(t.diamond).getInternalMatchConfigBundle();
        console.log("matcher incentive from lender A (tLIQ wei, at most):", (la.principal * incentiveBps) / 10_000);
        console.log("matcher incentive from lender B (mUSDC raw, at most):", (lb.principal * incentiveBps) / 10_000);
        // On one transaction before the trigger, off right after it.
        _setMatching(t.diamond, a.adminKey, true);
        vm.startBroadcast(a.deployerKey);
        RiskMatchLiquidationFacet(t.diamond).triggerInternalMatchLiquidation(loanA, loanB, 0);
        vm.stopBroadcast();
        _endRun(t, a, loanA, loanB);
        _logRecord("A", t.diamond, loanA);
        _logRecord("B", t.diamond, loanB);
    }

    /// @dev Matching OFF, the `open-a` snapshot restored exactly, then the
    ///      kill-switch to the DECLARED original state — never an observed
    ///      one, which after an interrupted originally-on run reads OFF.
    function _endRun(RepriceTarget memory t, Actors memory a, uint256 skipA, uint256 skipB) internal {
        PriceReading memory snap;
        snap.poolSpot = SafeCast.toUint160(vm.envUint("IM_RESTORE_SPOT_X96"));
        snap.venuePrice8 = vm.envUint("IM_RESTORE_VENUE_E8");
        uint256 price8 = vm.envUint("IM_RESTORE_PRICE_E8");
        _setMatching(t.diamond, a.adminKey, false);
        _restorePrices(t, a.deployerKey, price8, snap, skipA, skipB);
        if (vm.envOr("IM_ORIGINALLY_ENABLED", false) || vm.envOr("IM_KEEP_ENABLED", false)) {
            _setMatching(t.diamond, a.adminKey, true);
        }
        (bool endEnabled,,) = ConfigFacet(t.diamond).getInternalMatchConfigBundle();
        console.log("internalMatchEnabled after:", endEnabled);
    }

    /// @dev A stage's input loan, checked against the live chain before the
    ///      stage sends anything: Active, the expected parties, the expected
    ///      principal and collateral assets.
    function _requireLeg(
        address diamond,
        uint256 loanId,
        uint256 lenderKey,
        uint256 borrowerKey,
        address principalAsset,
        address collateralAsset
    ) internal view returns (LibVaipakam.Loan memory l) {
        l = LoanFacet(diamond).getLoanDetails(loanId);
        require(l.status == LibVaipakam.LoanStatus.Active, "BaseSepoliaInternalMatch: input loan is not Active");
        require(
            l.lender == vm.addr(lenderKey) && l.borrower == vm.addr(borrowerKey),
            "BaseSepoliaInternalMatch: input loan's parties are not this run's"
        );
        require(
            l.principalAsset == principalAsset && l.collateralAsset == collateralAsset,
            "BaseSepoliaInternalMatch: input loan's assets are not this run's"
        );
    }

    function _requireMatchingOff(address diamond) internal view {
        (bool on,,) = ConfigFacet(diamond).getInternalMatchConfigBundle();
        require(!on, "BaseSepoliaInternalMatch: internal matching is ON mid-run - run `restore`, or switch it off");
    }

    function _rate() internal view returns (uint256) {
        return vm.envOr("IM_RATE_BPS", uint256(1_000)); // 10% APR
    }

    /// @dev The deployment's own internal-match settings, before anything is
    ///      enabled: the window that blocks external liquidation while
    ///      matching is on, and the incentive each lender gives the matcher.
    function _logMatchConfig(address diamond) internal view {
        (, uint256 windowBps, uint256 incentiveBps) = ConfigFacet(diamond).getInternalMatchConfigBundle();
        // While matching is ON, a liquid loan whose LTV sits in
        // [liq floor, liq floor + window) cannot be liquidated externally
        // (RiskFacet: InternalMatchOnlyBand) - flagged per loan in each report.
        console.log("external-liquidation priority window while matching is on (bps above each loan's floor):", windowBps);
        console.log("internal-match incentive per leg (bps of each lender's principal):", incentiveBps);
    }

    /// @dev The internal-match kill-switch, from the admin.
    function _setMatching(address diamond, uint256 adminKey, bool on) internal {
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setInternalMatchEnabled(on);
        vm.stopBroadcast();
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

    /// @dev One coherent tLIQ move, then the exposure it leaves on every
    ///      loan this run does not own. Reporting here rather than at chosen
    ///      call sites means no price state the run creates goes unreported.
    function _reprice(RepriceTarget memory t, uint256 ownerKey, uint256 price8, uint256 skipA, uint256 skipB)
        internal
    {
        uint160 spot = _targetSpot(t, price8);
        vm.startBroadcast(ownerKey);
        _applyReprice(t, price8, spot);
        vm.stopBroadcast();
        _verifyReprice(t, price8);
        console.log("tLIQ repriced to (e8):", price8);
        _reportExposure(t, skipA, skipB);
    }

    /// @dev Puts the three surfaces back to the snapshot taken at start —
    ///      feed, pool spot and venue price each to its own recorded value —
    ///      and requires the Diamond to read exactly that back.
    function _restorePrices(
        RepriceTarget memory t,
        uint256 ownerKey,
        uint256 price8,
        PriceReading memory before,
        uint256 skipA,
        uint256 skipB
    ) internal {
        vm.startBroadcast(ownerKey);
        MockChainlinkFeed(t.feed).setPrice(SafeCast.toInt256(price8));
        MockUniswapV3Pool(t.pool).setSqrtPriceX96(before.poolSpot);
        if (t.venue.code.length != 0) MockSwapAdapter(t.venue).setTokenPrice(t.asset, before.venuePrice8);
        vm.stopBroadcast();
        PriceReading memory r = _read(t);
        require(
            _priceE8(t.diamond, t.asset) == price8,
            "BaseSepoliaInternalMatch: oracle did not read the pre-run price back"
        );
        require(r.poolSpot == before.poolSpot, "BaseSepoliaInternalMatch: pool spot did not return to its pre-run value");
        require(r.venuePrice8 == before.venuePrice8, "BaseSepoliaInternalMatch: venue price did not return to its pre-run value");
        console.log("tLIQ restored to its pre-run feed, pool spot and venue price (e8):", price8);
        _reportExposure(t, skipA, skipB);
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

    /// @dev Every OTHER matchable (Active or FallbackPending) loan touching
    ///      tLIQ, with its LTV at the price now in force, then every open
    ///      offer touching tLIQ — what the excursion does to positions this
    ///      run does not own. Walks every page of the active list. A loan whose LTV cannot
    ///      be read is listed as unreadable, never as a number.
    ///      Simulation-time log only; writes nothing.
    function _reportExposure(RepriceTarget memory t, uint256 skipA, uint256 skipB) internal view {
        uint256 pageSize = 200;
        (, uint256 windowBps,) = ConfigFacet(t.diamond).getInternalMatchConfigBundle();
        console.log("[simulation-time snapshot - positions created after it are not listed]");
        console.log("Other matchable tLIQ loans - Active and FallbackPending (id, status, LTV bps, liq floor bps):");
        for (uint256 offset;; offset += pageSize) {
            uint256[] memory ids = MetricsFacet(t.diamond).getActiveLoansPaginated(offset, pageSize);
            for (uint256 i; i < ids.length; ++i) {
                if (ids[i] == skipA || ids[i] == skipB) continue;
                LibVaipakam.Loan memory l = LoanFacet(t.diamond).getLoanDetails(ids[i]);
                if (l.principalAsset != t.asset && l.collateralAsset != t.asset) continue;
                // The active list carries Active AND FallbackPending loans,
                // and internal matching can settle both (a FallbackPending
                // leg skips the LTV-floor gate), so both are exposure.
                string memory status;
                if (l.status == LibVaipakam.LoanStatus.Active) status = "Active";
                else if (l.status == LibVaipakam.LoanStatus.FallbackPending) status = "FallbackPending";
                else continue;
                (bool ok, bytes memory ret) =
                    t.diamond.staticcall(abi.encodeWithSelector(RiskFacet.calculateLTV.selector, ids[i]));
                if (ok && ret.length == 32) {
                    uint256 ltv = abi.decode(ret, (uint256));
                    uint256 floorBps = uint256(l.liquidationLtvBpsAtInit);
                    bool inWindow = floorBps > 0 && ltv >= floorBps && ltv < floorBps + windowBps;
                    console.log(
                        string.concat(
                            "   id ",
                            vm.toString(ids[i]),
                            " ",
                            status,
                            inWindow ? " [IN PRIORITY WINDOW: no external liquidation while matching is on]" : "",
                            ": LTV bps"
                        ),
                        ltv,
                        "liq floor bps",
                        floorBps
                    );
                } else {
                    console.log(
                        string.concat("   id ", vm.toString(ids[i]), " ", status, ": LTV unreadable (calculateLTV reverted); liq floor bps"),
                        uint256(l.liquidationLtvBpsAtInit)
                    );
                }
            }
            if (ids.length < pageSize) break;
        }
        // Open offers see the moved price as well: an accept now is admitted
        // at it. Listed so a loan born during the excursion can be traced.
        console.log("Open tLIQ offers (id, side, principal still fillable = amountMax - amountFilled, collateral still fillable = collateralAmountMax - collateralAmountFilled):");
        for (uint256 offset;; offset += pageSize) {
            uint256[] memory ids = MetricsFacet(t.diamond).getActiveOffersPaginated(offset, pageSize);
            for (uint256 i; i < ids.length; ++i) {
                LibVaipakam.Offer memory o = OfferCancelFacet(t.diamond).getOffer(ids[i]);
                if (o.lendingAsset != t.asset && o.collateralAsset != t.asset) continue;
                console.log(
                    string.concat("   offer ", vm.toString(ids[i]), o.lendingAsset == t.asset ? " lends tLIQ" : " takes tLIQ as collateral"),
                    o.amountMax > o.amountFilled ? o.amountMax - o.amountFilled : 0,
                    o.collateralAmountMax > o.collateralAmountFilled ? o.collateralAmountMax - o.collateralAmountFilled : 0
                );
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
