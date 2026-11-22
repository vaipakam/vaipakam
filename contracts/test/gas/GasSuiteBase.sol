// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {SetupTest} from "../SetupTest.t.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {LibTestTiming} from "../helpers/LibTestTiming.sol";
import {LibTestPriceGuard} from "../helpers/LibTestPriceGuard.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IFeedRegistryPairBase} from "../../src/interfaces/IFeedRegistryPairBase.sol";
import {PriceGuard} from "../../src/oracle/PriceGuard.sol";
import {PriceGuardState} from "../../src/oracle/PriceGuardState.sol";

/// @dev A price feed that is always fresh: the gas suite moves time across a
///      loan's term, and a feed stamped once would go stale under it.
contract GasSuiteFeed {
    int256 public answer;

    constructor(int256 a) {
        answer = a;
    }

    function setAnswer(int256 a) external {
        answer = a;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}

/// @dev Measures, inside one frame, what a repeated (warm) call costs: the
///      first call warms the target's code and slots, the second is timed.
///      The gas suite's figures already carry each guard read at what the
///      suite's guard charged; the check takes this figure off the
///      mainnet-shaped cost so a read is not counted twice.
contract GasSuiteWarmCallProbe {
    function warmCost(address target, bytes calldata data) external view returns (uint256 used) {
        (bool ok,) = target.staticcall(data);
        require(ok, "first call failed");
        uint256 before = gasleft();
        (ok,) = target.staticcall(data);
        used = before - gasleft();
        require(ok, "second call failed");
    }
}

/**
 * @title  GasSuiteBase
 * @notice The gas suite's measuring step (#3915, RefactorRulesDesign §5.1).
 *         Each suite test arranges the state one user action needs, then
 *         calls {_measure} ONCE for the action itself. The call is a
 *         top-level call from the test contract, and the suite runs with
 *         `isolate = true`, so the action is its own transaction: cold
 *         accounts and slots, refunds settled the way a network settles
 *         them. A call made inside a longer test body without isolation
 *         reads warm storage and low; {GasSuiteTest.test_isolation_*} shows it.
 *
 *         Per action it records:
 *         - `gas`: the transaction's gas as forge reports it for the call
 *           (`vm.lastCallGas().gasTotalUsed`), which includes the 21,000
 *           base cost of a transaction;
 *         - `slotsWritten`: distinct (account, slot) pairs written;
 *         - `slotsRead`: distinct (account, slot) pairs read and not written;
 *         - `facetCalls`: calls the Diamond makes to itself (each one a
 *           routed call between facets through the fallback);
 *         - `events`: logs emitted;
 *         - `guardReads`: calls the Diamond makes to the price guard, a
 *           real guard here whose feed registry and feeds are mocks, so
 *           each call runs the guard's own code;
 *         - `guardDistinctCalls`: of those, the distinct calls (selector
 *           and arguments);
 *         - `guardPriceReads` / `guardPriceAssets`: the calls that price an
 *           asset, and the distinct assets they price. With one price per
 *           asset per transaction (#3987) the price reads would fall to
 *           about `guardPriceAssets` per guard and price version.
 *           The check adds the measured mainnet-shaped read cost for each
 *           read where a rule counts it (instant borrow's source bound).
 *
 *         One file per action is written to `out-gas-suite/<action>.json`,
 *         so tests running in parallel never write the same file.
 *         `contracts/script/check-gas-budgets.mjs` compares them with
 *         `contracts/gas-suite/budgets.json`.
 *
 * @dev    What the figures do NOT include, stated so a reader does not take
 *         them for more: liquidity tiers are answered through `vm.mockCall`
 *         (SetupTest), prices come from the real guard reading mocked feeds
 *         (one feed per asset, no sequencer, Pyth or secondary sources), and
 *         the swap venue is a mock. An action that reads prices measures LOW
 *         by what a mainnet guard's sources add to each read.
 *         The figures are for comparing one tree with the next, not a
 *         network gas quote.
 *
 *         The health factor and the loan-to-value ratio are NOT faked here.
 *         SetupTest answers both with fixed figures for every suite; the gas
 *         suite clears those answers in {_setUpGasSuite}, so every borrow,
 *         liquidation and top-up pays for the real computation and reaches
 *         the state it measures from real prices.
 */
abstract contract GasSuiteBase is SetupTest {
    string internal constant OUT_DIR = "./out-gas-suite/";

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant DURATION_DAYS = 30;
    uint256 internal constant RATE_BPS = 500;

    /// @dev SetupTest's setup, then its fixed health-factor and LTV answers
    ///      removed. Forge cannot clear one mock, so every mock is cleared and
    ///      the oracle answers (liquidity and price, SetupTest's values) are
    ///      put back. A suite adds its own mocks after this.
    function _setUpGasSuite() internal {
        setupHelper();
        _clearRiskMocks();
    }

    /// @dev The second half of {_setUpGasSuite}, for a suite whose base runs
    ///      `setupHelper` itself. Re-apply that base's own mocks after it.
    function _clearRiskMocks() internal {
        vm.clearMockedCalls();
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(mockNft721, LibVaipakam.LiquidityStatus.Illiquid);
        mockOracleLiquidity(mockIlliquidERC20, LibVaipakam.LiquidityStatus.Illiquid);
        _priceOnGuard(mockERC20, 1e8);
        _priceOnGuard(mockCollateralERC20, 1e8);
        _priceOnGuard(mockIlliquidERC20, 1e8);
    }

    /// @dev Each asset's price feed on the real guard, by asset.
    mapping(address => GasSuiteFeed) internal feedOf;

    /// @dev The feed registry the suite's guard reads: an address with code,
    ///      answered by mocks. Mocks downstream of the guard are fine: the
    ///      check counts the Diamond's calls into the guard, which are real.
    address internal constant SUITE_FEED_REGISTRY = address(uint160(uint256(keccak256("gas-suite.feed-registry"))));

    /// @dev Prices `asset` at `price` (8 decimals, numeraire) through the
    ///      real guard: the guard's feed registry names a feed for the asset
    ///      against the numeraire, so every price read the Diamond makes runs
    ///      the guard's own code and is counted. A mock on the guard would
    ///      answer before the guard ran and, succeeding, would be left out of
    ///      the state diff. The registry mocks are set on every call because
    ///      {_clearRiskMocks} clears every mock first.
    function _priceOnGuard(address asset, int256 price) internal {
        address guard = LibTestPriceGuard.guardOf(address(diamond));
        if (SUITE_FEED_REGISTRY.code.length == 0) vm.etch(SUITE_FEED_REGISTRY, hex"00");
        if (PriceGuard(guard).feedRegistry() != SUITE_FEED_REGISTRY) {
            LibTestPriceGuard.setAddress(address(diamond), PriceGuardState.Kind.FeedRegistry, SUITE_FEED_REGISTRY);
        }
        GasSuiteFeed f = feedOf[asset];
        if (address(f) == address(0)) {
            f = new GasSuiteFeed(price);
            feedOf[asset] = f;
        } else {
            f.setAnswer(price);
        }
        vm.mockCall(SUITE_FEED_REGISTRY, abi.encodeWithSignature("epoch()"), abi.encode(uint64(0)));
        vm.mockCall(SUITE_FEED_REGISTRY, abi.encodeWithSelector(IFeedRegistryPairBase.pairBase.selector), abi.encode(bytes32("SYM")));
        vm.mockCall(
            SUITE_FEED_REGISTRY,
            abi.encodeWithSignature("getFeed(address,address)", asset, LibTestPriceGuard.USD),
            abi.encode(address(f))
        );
    }

    struct Measured {
        uint256 gas;
        uint256 slotsWritten;
        uint256 slotsRead;
        uint256 facetCalls;
        uint256 events;
        uint256 guardReads;
        uint256 guardDistinctCalls;
        uint256 guardPriceReads;
        string guardBySelector;
        uint256 guardPriceAssets;
    }

    /// @dev Calls `data` on the Diamond as `actor`, requires success, and
    ///      records the five figures under `action`.
    function _measure(string memory action, address actor, bytes memory data) internal returns (Measured memory m) {
        return _measureAt(action, actor, address(diamond), data);
    }

    function _measureAt(string memory action, address actor, address target, bytes memory data)
        internal
        returns (Measured memory m)
    {
        vm.recordLogs();
        vm.startStateDiffRecording();
        vm.prank(actor);
        (bool ok, bytes memory ret) = target.call(data);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        m.gas = vm.lastCallGas().gasTotalUsed;
        m.events = logs.length;
        (m.slotsWritten, m.slotsRead, m.facetCalls) = _count(acc);
        (m.guardReads, m.guardDistinctCalls, m.guardPriceReads, m.guardPriceAssets) = _guardReads(acc);
        m.guardBySelector = _guardSelectors(acc);
        _write(action, m);
    }

    function _count(VmSafe.AccountAccess[] memory acc)
        internal
        view
        returns (uint256 written, uint256 readOnly, uint256 facetCalls)
    {
        // Distinct keys, by a linear scan: an action touches at most a few
        // hundred slots, so quadratic work here is a few milliseconds.
        uint256 total;
        for (uint256 i; i < acc.length; i++) total += acc[i].storageAccesses.length;
        bytes32[] memory wKeys = new bytes32[](total);
        bytes32[] memory rKeys = new bytes32[](total);
        uint256 nw;
        uint256 nr;
        for (uint256 i; i < acc.length; i++) {
            VmSafe.AccountAccess memory a = acc[i];
            if (
                a.account == address(diamond) && a.accessor == address(diamond)
                    && (a.kind == VmSafe.AccountAccessKind.Call || a.kind == VmSafe.AccountAccessKind.StaticCall)
            ) facetCalls++;
            for (uint256 j; j < a.storageAccesses.length; j++) {
                VmSafe.StorageAccess memory s = a.storageAccesses[j];
                if (s.reverted) continue;
                bytes32 k = keccak256(abi.encode(s.account, s.slot));
                if (s.isWrite) {
                    if (!_has(wKeys, nw, k)) wKeys[nw++] = k;
                } else if (!_has(rKeys, nr, k)) {
                    rKeys[nr++] = k;
                }
            }
        }
        written = nw;
        for (uint256 i; i < nr; i++) if (!_has(wKeys, nw, rKeys[i])) readOnly++;
    }

    /// @dev Calls from the Diamond to the price guard: every call, the
    ///      distinct calls (same calldata), and the distinct assets among the
    ///      calls that price an asset. The last is what a rule of one price
    ///      per asset per transaction (#3987) would leave of the price reads.
    /// @dev The Diamond's calls into the guard by selector, as
    ///      `0x<selector>:<count>` joined by commas, in first-seen order.
    function _guardSelectors(VmSafe.AccountAccess[] memory acc) internal view returns (string memory out) {
        address guard = LibTestPriceGuard.guardOf(address(diamond));
        bytes4[] memory sels = new bytes4[](acc.length);
        uint256[] memory counts = new uint256[](acc.length);
        uint256 k;
        for (uint256 i; i < acc.length; i++) {
            VmSafe.AccountAccess memory a = acc[i];
            if (
                a.account != guard || a.accessor != address(diamond) || a.data.length < 4
                    || (a.kind != VmSafe.AccountAccessKind.Call && a.kind != VmSafe.AccountAccessKind.StaticCall)
            ) continue;
            bytes4 sel = bytes4(a.data);
            uint256 j;
            while (j < k && sels[j] != sel) j++;
            if (j == k) sels[k++] = sel;
            counts[j]++;
        }
        for (uint256 j; j < k; j++) {
            out = string.concat(out, j == 0 ? "" : ",", vm.toString(abi.encodePacked(sels[j])), ":", vm.toString(counts[j]));
        }
    }

    function _guardReads(VmSafe.AccountAccess[] memory acc)
        internal
        view
        returns (uint256 n, uint256 distinctCalls, uint256 priceReads, uint256 priceAssets)
    {
        address guard = LibTestPriceGuard.guardOf(address(diamond));
        bytes32[] memory calls = new bytes32[](acc.length);
        bytes32[] memory assets = new bytes32[](acc.length);
        for (uint256 i; i < acc.length; i++) {
            VmSafe.AccountAccess memory a = acc[i];
            if (
                a.account != guard || a.accessor != address(diamond)
                    || (a.kind != VmSafe.AccountAccessKind.Call && a.kind != VmSafe.AccountAccessKind.StaticCall)
            ) continue;
            n++;
            bytes32 k = keccak256(a.data);
            if (!_has(calls, distinctCalls, k)) calls[distinctCalls++] = k;
            if (a.data.length >= 36 && _pricesAnAsset(bytes4(a.data))) {
                priceReads++;
                bytes32 asset = bytes32(_word(a.data, 4));
                if (!_has(assets, priceAssets, asset)) assets[priceAssets++] = asset;
            }
        }
    }

    function _pricesAnAsset(bytes4 sel) private pure returns (bool) {
        return sel == IPriceGuard.getAssetPrice.selector || sel == IPriceGuard.getAssetPriceStatus.selector
            || sel == IPriceGuard.tryGetAssetPrice.selector || sel == IPriceGuard.countLiveSecondaryOracleFeeds.selector
            || sel == IPriceGuard.getAssetPriceAt.selector || sel == IPriceGuard.getAssetPriceStatusAt.selector
            || sel == IPriceGuard.tryGetAssetPriceAt.selector;
    }

    function _word(bytes memory b, uint256 at) private pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), at))
        }
    }

    function _has(bytes32[] memory keys, uint256 n, bytes32 k) private pure returns (bool) {
        for (uint256 i; i < n; i++) if (keys[i] == k) return true;
        return false;
    }

    function _write(string memory action, Measured memory m) internal {
        string memory o = action;
        vm.serializeString(o, "action", action);
        vm.serializeUint(o, "gas", m.gas);
        vm.serializeUint(o, "slotsWritten", m.slotsWritten);
        vm.serializeUint(o, "slotsRead", m.slotsRead);
        vm.serializeUint(o, "facetCalls", m.facetCalls);
        vm.serializeUint(o, "guardReads", m.guardReads);
        vm.serializeUint(o, "guardDistinctCalls", m.guardDistinctCalls);
        vm.serializeUint(o, "guardPriceReads", m.guardPriceReads);
        vm.serializeString(o, "guardBySelector", m.guardBySelector);
        vm.serializeUint(o, "guardPriceAssets", m.guardPriceAssets);
        string memory json = vm.serializeUint(o, "events", m.events);
        // The folder is removed before a full run (predeploy-check), and
        // writeJson creates no folder.
        vm.createDir(OUT_DIR, true);
        vm.writeJson(json, string.concat(OUT_DIR, action, ".json"));
    }

    // ─── Common arrangements ─────────────────────────────────────────────

    function _params(LibVaipakam.OfferType kind) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: kind,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: RATE_BPS,
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
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: PRINCIPAL,
            interestRateBpsMax: RATE_BPS,
            collateralAmountMax: COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false,
            linkKind: 0,
            linkMarginBps: 0,
            rateFarFromAverageAcknowledged: false
        });
    }

    function _createOffer(address who, LibVaipakam.CreateOfferParams memory p) internal returns (uint256 offerId) {
        vm.prank(who);
        offerId = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        LibTestTiming.backdateTerms(address(diamond), offerId);
    }

    function _openLoan() internal returns (uint256 loanId) {
        uint256 offerId = _createOffer(lender, _params(LibVaipakam.OfferType.Lender));
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    /// @dev Advances the clock from the VM's own reading (viaIR may reuse a
    ///      cached `block.timestamp` across two warps in one test).
    function _skip(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }
}
