// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {SetupTest} from "../SetupTest.t.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {LibTestTiming} from "../helpers/LibTestTiming.sol";
import {LibTestPriceGuard} from "../helpers/LibTestPriceGuard.sol";

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
 *         - `guardReads`: calls the Diamond makes to the price guard. The
 *           guard is answered by mocks here, so the check adds the guard's
 *           full read budget for each one where a rule counts it
 *           (instant borrow's source bound).
 *
 *         One file per action is written to `out-gas-suite/<action>.json`,
 *         so tests running in parallel never write the same file.
 *         `contracts/script/check-gas-budgets.mjs` compares them with
 *         `contracts/gas-suite/budgets.json`.
 *
 * @dev    What the figures do NOT include, stated so a reader does not take
 *         them for more: the shared test Diamond answers oracle prices and
 *         liquidity tiers through `vm.mockCall` (SetupTest), so a price
 *         read costs almost nothing here, and the swap venue is a mock. An
 *         action that reads prices measures LOW by the cost of those reads.
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
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        mockOraclePrice(mockIlliquidERC20, 1e8, 8);
    }

    struct Measured {
        uint256 gas;
        uint256 slotsWritten;
        uint256 slotsRead;
        uint256 facetCalls;
        uint256 events;
        uint256 guardReads;
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
        m.guardReads = _guardReads(acc);
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

    /// @dev Calls from the Diamond to the price guard, mocked or not.
    function _guardReads(VmSafe.AccountAccess[] memory acc) internal view returns (uint256 n) {
        address guard = LibTestPriceGuard.guardOf(address(diamond));
        for (uint256 i; i < acc.length; i++) {
            VmSafe.AccountAccess memory a = acc[i];
            if (
                a.account == guard && a.accessor == address(diamond)
                    && (a.kind == VmSafe.AccountAccessKind.Call || a.kind == VmSafe.AccountAccessKind.StaticCall)
            ) n++;
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
