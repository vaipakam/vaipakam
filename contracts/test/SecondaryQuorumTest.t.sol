// test/SecondaryQuorumTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/**
 * @title SecondaryQuorumTest
 * @notice Phase 7b.2 — exercises the Soft 2-of-N decision rule in
 *         {OracleFacet._enforceSecondaryQuorum}.
 *
 * Decision rule under test:
 *   - All three secondaries Unavailable → accept Chainlink
 *     (graceful fallback).
 *   - At least one Agree (regardless of Disagree alongside) →
 *     accept (quorum hit by Chainlink + agreeing secondary).
 *   - Some Disagree AND no Agree → revert {OraclePriceDivergence}.
 *
 * Coverage: each per-source Unavailable trigger (zero address,
 * symbol unreadable, no data, stale data, zero value), Agree /
 * Disagree boundaries against the deviation tolerance, the 7
 * meaningful aggregate combinations of Agree/Disagree/Unavailable
 * (skipping symmetric duplicates), and the chain-level deviation /
 * staleness config knobs.
 *
 * Mock strategy: the three oracle interfaces are stubbed with
 * `vm.mockCall` against `makeAddr` sentinels. Lets each test
 * configure exactly the response it wants without deploying
 * concrete mock contracts.
 */
contract SecondaryQuorumTest is Test {
    VaipakamDiamond diamond;
    address owner;

    address mockAsset;
    address mockRegistry;
    address mockFeed;
    address mockWeth;
    address mockEthUsdFeed;
    address mockDenom;

    address mockTellor;
    address mockApi3;
    address mockDia;

    DiamondCutFacet cutFacet;
    OracleFacet oracleFacet;
    OracleAdminFacet oracleAdminFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    // Tolerances chosen so the off-by-tolerance disagreement is at
    // 100bps = 1% (deviation tolerance is 500bps default).
    uint256 constant CHAINLINK_PRICE_8DEC = 2_000_00000000; // $2000 at 8 decimals
    uint256 constant SECONDARY_AGREE_18DEC = 2_000 * 1e18;  // $2000 at 18 decimals
    uint256 constant SECONDARY_DISAGREE_18DEC = 2_500 * 1e18; // 25% off — well above 5% tolerance

    function setUp() public {
        owner = address(this);

        mockAsset = address(new ERC20Mock("WrappedEther", "WETH", 18));
        mockRegistry = makeAddr("registry");
        mockFeed = makeAddr("feed");
        mockWeth = makeAddr("weth");
        mockEthUsdFeed = makeAddr("ethNumeraireFeed");
        mockDenom = makeAddr("denom");

        mockTellor = makeAddr("tellor");
        mockApi3 = makeAddr("api3");
        mockDia = makeAddr("dia");

        cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        oracleFacet = OracleFacet(ArtifactDeploy.deploy(type(OracleFacet).name));
        oracleAdminFacet = OracleAdminFacet(ArtifactDeploy.deploy(type(OracleAdminFacet).name));
        adminFacet = AdminFacet(ArtifactDeploy.deploy(type(AdminFacet).name));
        accessControlFacet = AccessControlFacet(ArtifactDeploy.deploy(type(AccessControlFacet).name));
        helperTest = new HelperTest();

        // Phase 7b.2 — OracleAdminFacet now has 11 selectors:
        //   7 base + 4 (chain-level Tellor / API3 / DIA / deviation /
        //   staleness setters' 6 functions, but 4 distinct setters &
        //   matching getters via getEffective*). We register all the
        //   ones the tests actually call.
        bytes4[] memory oracleAdminSelectors = new bytes4[](14);
        oracleAdminSelectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        oracleAdminSelectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        oracleAdminSelectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        oracleAdminSelectors[3] = OracleAdminFacet.setWethContract.selector;
        oracleAdminSelectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        oracleAdminSelectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        oracleAdminSelectors[6] = OracleAdminFacet.setStableTokenFeed.selector;
        oracleAdminSelectors[7] = OracleAdminFacet.setTellorOracle.selector;
        oracleAdminSelectors[8] = OracleAdminFacet.setApi3ServerV1.selector;
        oracleAdminSelectors[9] = OracleAdminFacet.setDIAOracleV2.selector;
        oracleAdminSelectors[10] = OracleAdminFacet.setSecondaryOracleMaxDeviationBps.selector;
        oracleAdminSelectors[11] = OracleAdminFacet.setSecondaryOracleMaxStaleness.selector;
        oracleAdminSelectors[12] = OracleAdminFacet.getSecondaryOracleMaxDeviationBps.selector;
        oracleAdminSelectors[13] = OracleAdminFacet.getSecondaryOracleMaxStaleness.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(oracleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOracleFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(oracleAdminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: oracleAdminSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();

        vm.warp(7 days);

        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(mockDenom);
        OracleAdminFacet(address(diamond)).setChainlinkRegistry(mockRegistry);
        OracleAdminFacet(address(diamond)).setWethContract(mockWeth);
        OracleAdminFacet(address(diamond)).setEthUsdFeed(mockEthUsdFeed);

        // Default ETH/USD: $2000, 8 decimals, fresh.
        _mockFeedFull(mockEthUsdFeed, int256(2000e8), 8);
        // Wire mockAsset → mockFeed via Feed Registry.
        _mockRegistryFeed(mockAsset, mockFeed);
        // safe: `CHAINLINK_PRICE_8DEC` = uint256(2_000_00000000) — positive,
        // far below int256.max.
        // forge-lint: disable-next-line(unsafe-typecast)
        _mockFeedFull(mockFeed, int256(CHAINLINK_PRICE_8DEC), 8);

        // Default state: all three secondaries DISABLED (zero address).
        // Tests that need active secondaries call set*() to enable.
        // setUp asserts the graceful-fallback baseline.
    }

    // ─── Helpers ───────────────────────────────────────────────────

    function _mockFeedFull(address feed, int256 price, uint8 decimals) internal {
        uint80 roundId = 1;
        uint256 startedAt = block.timestamp;
        uint256 updatedAt = block.timestamp;
        uint80 answeredInRound = 1;
        vm.mockCall(
            feed,
            abi.encodeWithSignature("decimals()"),
            abi.encode(decimals)
        );
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, price, startedAt, updatedAt, answeredInRound)
        );
    }

    function _mockRegistryFeed(address asset, address feed) internal {
        vm.mockCall(
            mockRegistry,
            abi.encodeWithSignature("getFeed(address,address)", asset, mockDenom),
            abi.encode(feed)
        );
    }

    /// @dev Stub Tellor to return the requested price (1e18-scaled per
    ///      Tellor SpotPrice convention) at the current timestamp.
    function _mockTellorAgree() internal {
        bytes memory raw = abi.encode(SECONDARY_AGREE_18DEC);
        vm.mockCall(
            mockTellor,
            abi.encodeWithSignature("getDataBefore(bytes32,uint256)"),
            abi.encode(raw, block.timestamp)
        );
    }

    /// @dev Stub Tellor to return a price disagreeing with Chainlink.
    function _mockTellorDisagree() internal {
        bytes memory raw = abi.encode(SECONDARY_DISAGREE_18DEC);
        vm.mockCall(
            mockTellor,
            abi.encodeWithSignature("getDataBefore(bytes32,uint256)"),
            abi.encode(raw, block.timestamp)
        );
    }

    /// @dev Stub Tellor to return zero data — Unavailable.
    function _mockTellorNoData() internal {
        vm.mockCall(
            mockTellor,
            abi.encodeWithSignature("getDataBefore(bytes32,uint256)"),
            abi.encode(bytes(""), uint256(0))
        );
    }

    function _mockApi3Agree() internal {
        vm.mockCall(
            mockApi3,
            abi.encodeWithSignature("readDataFeedWithDapiNameHash(bytes32)"),
            // safe: `SECONDARY_AGREE_18DEC` is a positive test constant ($2000 in
            // 18-decimal numeraire); well below int256.max.
            // forge-lint: disable-next-line(unsafe-typecast)
            abi.encode(SafeCast.toInt224(int256(SECONDARY_AGREE_18DEC)), uint32(block.timestamp))
        );
    }

    function _mockApi3Disagree() internal {
        vm.mockCall(
            mockApi3,
            abi.encodeWithSignature("readDataFeedWithDapiNameHash(bytes32)"),
            // safe: `SECONDARY_DISAGREE_18DEC` is a positive test constant; well
            // below int256.max.
            // forge-lint: disable-next-line(unsafe-typecast)
            abi.encode(SafeCast.toInt224(int256(SECONDARY_DISAGREE_18DEC)), uint32(block.timestamp))
        );
    }

    function _mockApi3NoData() internal {
        vm.mockCall(
            mockApi3,
            abi.encodeWithSignature("readDataFeedWithDapiNameHash(bytes32)"),
            abi.encode(int224(0), uint32(0))
        );
    }

    function _mockDiaAgree() internal {
        // DIA returns 8-decimal value.
        uint128 value = SafeCast.toUint128(CHAINLINK_PRICE_8DEC);
        vm.mockCall(
            mockDia,
            abi.encodeWithSignature("getValue(string)"),
            abi.encode(value, uint128(block.timestamp))
        );
    }

    function _mockDiaDisagree() internal {
        // 25% disagreement.
        uint128 value = uint128((CHAINLINK_PRICE_8DEC * 125) / 100);
        vm.mockCall(
            mockDia,
            abi.encodeWithSignature("getValue(string)"),
            abi.encode(value, uint128(block.timestamp))
        );
    }

    function _mockDiaNoData() internal {
        vm.mockCall(
            mockDia,
            abi.encodeWithSignature("getValue(string)"),
            abi.encode(uint128(0), uint128(0))
        );
    }

    function _enableTellor() internal {
        OracleAdminFacet(address(diamond)).setTellorOracle(mockTellor);
    }

    function _enableApi3() internal {
        OracleAdminFacet(address(diamond)).setApi3ServerV1(mockApi3);
    }

    function _enableDia() internal {
        OracleAdminFacet(address(diamond)).setDIAOracleV2(mockDia);
    }

    function _readPrice() internal view returns (uint256, uint8) {
        return OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    // ─── Tests ────────────────────────────────────────────────────

    // Baseline: no secondaries enabled — graceful Chainlink-only.

    function testQuorumNoSecondariesConfiguredAcceptsChainlink() public view {
        // setUp leaves all three secondaries unset. getAssetPrice
        // should return the Chainlink primary without reverting.
        (uint256 price, uint8 dec) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
        assertEq(dec, 8);
    }

    // Single source — Tellor only.

    function testQuorumTellorAgreeAcceptsPrice() public {
        _enableTellor();
        _mockTellorAgree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumTellorDisagreeRevertsWhenNoOtherAgreement() public {
        _enableTellor();
        _mockTellorDisagree();
        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testQuorumTellorNoDataAcceptsAsFallback() public {
        // Tellor enabled but reports no data → Unavailable. Same
        // as not configured — graceful fallback to Chainlink.
        _enableTellor();
        _mockTellorNoData();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    // Single source — API3 only.

    function testQuorumApi3AgreeAcceptsPrice() public {
        _enableApi3();
        _mockApi3Agree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumApi3DisagreeReverts() public {
        _enableApi3();
        _mockApi3Disagree();
        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    // Single source — DIA only.

    function testQuorumDIAAgreeAcceptsPrice() public {
        _enableDia();
        _mockDiaAgree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumDIADisagreeReverts() public {
        _enableDia();
        _mockDiaDisagree();
        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    // Two sources.

    function testQuorumTwoAgreeAccepts() public {
        _enableTellor();
        _enableApi3();
        _mockTellorAgree();
        _mockApi3Agree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumOneAgreeOneDisagreeStillAccepts() public {
        // Tellor agrees, API3 disagrees. Quorum hit (Chainlink +
        // Tellor = 2 agreeing sources). Soft 2-of-N accepts.
        _enableTellor();
        _enableApi3();
        _mockTellorAgree();
        _mockApi3Disagree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumBothDisagreeReverts() public {
        _enableTellor();
        _enableApi3();
        _mockTellorDisagree();
        _mockApi3Disagree();
        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testQuorumOneAgreeOneNoDataAccepts() public {
        _enableTellor();
        _enableApi3();
        _mockTellorAgree();
        _mockApi3NoData();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumOneDisagreeOneNoDataReverts() public {
        // No agreement found, but a disagreement was. Revert.
        _enableTellor();
        _enableApi3();
        _mockTellorDisagree();
        _mockApi3NoData();
        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    // Three sources.

    function testQuorumAllThreeAgreeAccepts() public {
        _enableTellor();
        _enableApi3();
        _enableDia();
        _mockTellorAgree();
        _mockApi3Agree();
        _mockDiaAgree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumTwoAgreeOneDisagreeAccepts() public {
        _enableTellor();
        _enableApi3();
        _enableDia();
        _mockTellorAgree();
        _mockApi3Agree();
        _mockDiaDisagree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumOneAgreeTwoDisagreeAccepts() public {
        // 1 agreeing secondary is sufficient under Soft 2-of-N — even
        // when 2 others disagree. Chainlink + the 1 agreeing secondary
        // form the 2-source quorum.
        _enableTellor();
        _enableApi3();
        _enableDia();
        _mockTellorAgree();
        _mockApi3Disagree();
        _mockDiaDisagree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumAllThreeDisagreeReverts() public {
        _enableTellor();
        _enableApi3();
        _enableDia();
        _mockTellorDisagree();
        _mockApi3Disagree();
        _mockDiaDisagree();
        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testQuorumAllThreeNoDataAcceptsAsFallback() public {
        // All enabled, none have data — graceful fallback.
        _enableTellor();
        _enableApi3();
        _enableDia();
        _mockTellorNoData();
        _mockApi3NoData();
        _mockDiaNoData();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumNoAgreesNoDisagreesAcceptsAsFallback() public {
        // 2 enabled, both unavailable. Same as graceful fallback.
        _enableTellor();
        _enableApi3();
        _mockTellorNoData();
        _mockApi3NoData();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    // Per-source unavailability triggers.

    function testQuorumStaleTellorTreatedAsUnavailable() public {
        // Tellor reports the agreement value but at a timestamp older
        // than the chain-level staleness ceiling (default 1h). Should
        // be classified Unavailable, not Agree → graceful fallback.
        _enableTellor();
        bytes memory raw = abi.encode(SECONDARY_AGREE_18DEC);
        vm.mockCall(
            mockTellor,
            abi.encodeWithSignature("getDataBefore(bytes32,uint256)"),
            abi.encode(raw, block.timestamp - 7200) // 2h old
        );
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumStaleApi3TreatedAsUnavailable() public {
        _enableApi3();
        vm.mockCall(
            mockApi3,
            abi.encodeWithSignature("readDataFeedWithDapiNameHash(bytes32)"),
            abi.encode(
                // safe: `SECONDARY_AGREE_18DEC` is a positive test constant ($2000 in
                // 18-decimal numeraire); well below int256.max.
                // forge-lint: disable-next-line(unsafe-typecast)
                SafeCast.toInt224(int256(SECONDARY_AGREE_18DEC)),
                uint32(block.timestamp - 7200)
            )
        );
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumStaleDIATreatedAsUnavailable() public {
        _enableDia();
        vm.mockCall(
            mockDia,
            abi.encodeWithSignature("getValue(string)"),
            abi.encode(
                SafeCast.toUint128(CHAINLINK_PRICE_8DEC),
                uint128(block.timestamp - 7200)
            )
        );
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumZeroValueTreatedAsUnavailable() public {
        _enableTellor();
        bytes memory raw = abi.encode(uint256(0));
        vm.mockCall(
            mockTellor,
            abi.encodeWithSignature("getDataBefore(bytes32,uint256)"),
            abi.encode(raw, block.timestamp)
        );
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumOracleRevertTreatedAsUnavailable() public {
        // The probe wraps each upstream call in try/catch — a
        // reverting upstream is silently classified as Unavailable.
        _enableTellor();
        vm.mockCallRevert(
            mockTellor,
            abi.encodeWithSignature("getDataBefore(bytes32,uint256)"),
            "tellor down"
        );
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testQuorumSymbolUnreadableSilentlySkipsSecondary() public {
        // Token whose symbol() reverts → derived queryId can't be
        // produced. All secondaries treated as Unavailable.
        address brokenToken = makeAddr("brokenToken");
        vm.mockCallRevert(
            brokenToken,
            abi.encodeWithSignature("symbol()"),
            "no symbol"
        );
        // Need a Chainlink feed for this asset to reach the secondary
        // path (otherwise primary errors first).
        _mockRegistryFeed(brokenToken, mockFeed);
        _enableTellor();
        _mockTellorAgree();

        (uint256 price, ) = OracleFacet(address(diamond)).getAssetPrice(brokenToken);
        // Chainlink primary returned; secondary skipped silently
        // because symbol() reverts. Soft fallback applies.
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    // Configuration knobs.

    function testQuorumTighteningDeviationRejectsPriorAgreement() public {
        // 2% off — agrees under default 5% tolerance, disagrees once
        // tolerance is tightened to 100bps (1%, the new T-033 audit
        // floor for `secondaryOracleMaxDeviationBps`).
        _enableTellor();
        bytes memory raw = abi.encode((SECONDARY_AGREE_18DEC * 102) / 100);
        vm.mockCall(
            mockTellor,
            abi.encodeWithSignature("getDataBefore(bytes32,uint256)"),
            abi.encode(raw, block.timestamp)
        );

        // Default tolerance — accepts.
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);

        // Tighten to 100bps (1%) — same 2%-off data now disagrees.
        OracleAdminFacet(address(diamond)).setSecondaryOracleMaxDeviationBps(100);
        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testQuorumLooseningStalenessAcceptsPriorRejection() public {
        // Data 90 minutes old — Unavailable under default 1h ceiling
        // (graceful fallback to Chainlink — already accepts). Loosen
        // to 4h and the data becomes Agree, still accepts but now via
        // genuine quorum. Smoke check that the staleness setter
        // routes through correctly.
        _enableTellor();
        bytes memory raw = abi.encode(SECONDARY_AGREE_18DEC);
        vm.mockCall(
            mockTellor,
            abi.encodeWithSignature("getDataBefore(bytes32,uint256)"),
            abi.encode(raw, block.timestamp - 5400) // 90min
        );

        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);

        OracleAdminFacet(address(diamond)).setSecondaryOracleMaxStaleness(14400); // 4h
        (uint256 price2, ) = _readPrice();
        assertEq(price2, CHAINLINK_PRICE_8DEC);
    }

    // ─── #638 — countLiveSecondaryOracleFeeds ─────────────────────────
    // The read-only live-feed counter the backstop oracle-coverage gate
    // consumes. "Live" = configured + fresh + non-zero (NOT Unavailable),
    // independent of whether the feed agrees with Chainlink.

    function _countLive() internal view returns (uint8) {
        return
            OracleFacet(address(diamond)).countLiveSecondaryOracleFeeds(
                mockAsset
            );
    }

    function testCountLive_noneConfigured_returnsZero() public view {
        // setUp wires none of the three secondaries.
        assertEq(_countLive(), 0, "no secondaries -> 0 live");
    }

    function testCountLive_oneAgreeingFeed_returnsOne() public {
        _enableTellor();
        _mockTellorAgree();
        assertEq(_countLive(), 1, "tellor agree -> 1 live");
    }

    function testCountLive_disagreeingFeedStillCountsLive() public {
        // A configured, fresh, non-zero feed that DISAGREES is still LIVE for
        // coverage purposes — the backstop cares that the asset is multiply
        // priced, not that the feeds currently concur.
        _enableApi3();
        _mockApi3Disagree();
        assertEq(_countLive(), 1, "disagreeing feed still counts as live");
    }

    function testCountLive_noDataFeedNotCounted() public {
        // Configured but reporting zero/no data -> Unavailable -> not counted.
        _enableDia();
        _mockDiaNoData();
        assertEq(_countLive(), 0, "no-data feed not live");
    }

    function testCountLive_allThreeLive_returnsThree() public {
        _enableTellor();
        _mockTellorAgree();
        _enableApi3();
        _mockApi3Agree();
        _enableDia();
        _mockDiaAgree();
        assertEq(_countLive(), 3, "all three live -> 3");
    }

    function testCountLive_mixedLiveAndUnavailable_countsOnlyLive() public {
        _enableTellor();
        _mockTellorAgree(); // live
        _enableApi3();
        _mockApi3NoData(); // Unavailable
        _enableDia();
        _mockDiaDisagree(); // live (disagrees but reports)
        assertEq(_countLive(), 2, "2 live, 1 unavailable -> 2");
    }

    // ─── #666 — the status read names why a price read failed ─────────

    function _status()
        internal
        view
        returns (OracleFacet.PriceStatus status, uint256 price, uint8 dec)
    {
        return OracleFacet(address(diamond)).getAssetPriceStatus(mockAsset);
    }

    function testPriceStatus_quorumHolds_isPriced() public {
        _enableTellor();
        _mockTellorAgree();
        (OracleFacet.PriceStatus st, uint256 price, uint8 dec) = _status();
        assertEq(uint8(st), uint8(OracleFacet.PriceStatus.Priced));
        assertEq(price, CHAINLINK_PRICE_8DEC);
        assertEq(dec, 8);
    }

    function testPriceStatus_everyRespondingSecondaryDisagrees_isDivergent() public {
        _enableTellor();
        _mockTellorDisagree();
        _enableApi3();
        _mockApi3Disagree();
        (OracleFacet.PriceStatus st, uint256 price, uint8 dec) = _status();
        assertEq(uint8(st), uint8(OracleFacet.PriceStatus.Divergent), "distrusted, not missing");
        assertEq(price, 0);
        assertEq(dec, 0);
        // The boolean read keeps its meaning: no usable price.
        (bool ok, , ) = OracleFacet(address(diamond)).tryGetAssetPrice(mockAsset);
        assertFalse(ok, "tryGetAssetPrice still reports no usable price");
    }

    function testPriceStatus_noFeed_isUnavailable() public {
        // The registry has no feed for the asset: there is no price at all.
        _mockRegistryFeed(mockAsset, address(0));
        (OracleFacet.PriceStatus st, , ) = _status();
        assertEq(uint8(st), uint8(OracleFacet.PriceStatus.Unavailable), "missing, not distrusted");
        (bool ok, , ) = OracleFacet(address(diamond)).tryGetAssetPrice(mockAsset);
        assertFalse(ok);
    }

    function testPriceStatus_staleChainlink_isUnavailable() public {
        // A stale primary answer is a missing price, whatever the
        // secondaries would have said.
        _enableTellor();
        _mockTellorDisagree();
        vm.warp(block.timestamp + 30 days);
        (OracleFacet.PriceStatus st, , ) = _status();
        assertEq(uint8(st), uint8(OracleFacet.PriceStatus.Unavailable));
    }

    /// @dev The cross-check divergence as `_validatePythCrossCheck` encodes
    ///      it: the selector and its four words.
    function _crossCheckDivergence() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            OracleFacet.OracleCrossCheckDivergence.selector,
            uint256(2_000_00000000),
            uint256(2_500_00000000),
            uint256(2_500),
            uint256(500)
        );
    }

    /// @notice The other distrust the price read raises: the Pyth cross-check
    ///         of the ETH reference diverged. It is a price the sources
    ///         disagree about, exactly like the quorum's divergence, and is
    ///         classified the same way.
    function testPriceStatus_pythCrossCheckDivergence_isDivergent() public {
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockAsset),
            _crossCheckDivergence()
        );
        (OracleFacet.PriceStatus st, , ) = _status();
        assertEq(uint8(st), uint8(OracleFacet.PriceStatus.Divergent), "cross-check distrust, not missing");
    }

    /// @notice A divergence is recognised at its own encoded length, so data
    ///         that only borrows a divergence selector is not one.
    function testPriceStatus_divergenceSelectorAtTheWrongLength_isUnavailable() public {
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockAsset),
            abi.encodeWithSelector(OracleFacet.OracleCrossCheckDivergence.selector)
        );
        (OracleFacet.PriceStatus st, , ) = _status();
        assertEq(uint8(st), uint8(OracleFacet.PriceStatus.Unavailable));
    }

    // ─── #665 — the Tellor dispute buffer ───────────────────────────────

    function _tellorQueryId() internal pure returns (bytes32) {
        return keccak256(abi.encode("SpotPrice", abi.encode("weth", "usd")));
    }

    function testTellorBuffer_readsOnlyValuesOlderThanTheBuffer() public {
        _enableTellor();
        _mockTellorAgree();
        vm.expectCall(
            mockTellor,
            abi.encodeWithSignature(
                "getDataBefore(bytes32,uint256)",
                _tellorQueryId(),
                block.timestamp - 20 minutes
            )
        );
        _readPrice();
    }

    /// @notice The #665 attack: a reporter's own fresh Tellor value would be
    ///         the one agreeing secondary that overrides a disagreeing one.
    ///         With the buffer the fresh value is not read, so the
    ///         disagreement stands and the price is refused; once the value
    ///         has stood undisputed for the buffer, it counts.
    function testTellorBuffer_freshSubmissionIsNotConsumed() public {
        TellorRecordMock tellor = new TellorRecordMock();
        OracleAdminFacet(address(diamond)).setTellorOracle(address(tellor));
        _enableApi3();
        _mockApi3Disagree();
        tellor.submit(SECONDARY_AGREE_18DEC, block.timestamp);

        vm.expectRevert(OracleFacet.OraclePriceDivergence.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);

        // Twenty minutes and one second later the value is past the buffer
        // and well inside the 1h staleness bound: it is read, and agrees.
        vm.warp(block.timestamp + 20 minutes + 1);
        _refreshFeeds();
        _mockApi3Disagree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC, "the value that stood the buffer forms the quorum");
    }

    function testTellorBuffer_readsTheNewestValueOutsideTheBuffer() public {
        TellorRecordMock tellor = new TellorRecordMock();
        OracleAdminFacet(address(diamond)).setTellorOracle(address(tellor));
        // An agreeing value 30 minutes old, then a disagreeing one 5 minutes
        // old: the buffer hides the newer one, so Tellor agrees.
        tellor.submit(SECONDARY_AGREE_18DEC, block.timestamp - 30 minutes);
        tellor.submit(SECONDARY_DISAGREE_18DEC, block.timestamp - 5 minutes);
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC);
    }

    function testTellorBuffer_youngChainReadsTellorAsUnavailable() public {
        // A timestamp inside the buffer has no value that old to read; the
        // probe reports Unavailable instead of underflowing.
        vm.warp(10 minutes);
        _refreshFeeds();
        _enableTellor();
        _mockTellorDisagree();
        (uint256 price, ) = _readPrice();
        assertEq(price, CHAINLINK_PRICE_8DEC, "Tellor unavailable: Chainlink alone");
    }

    function _refreshFeeds() internal {
        _mockFeedFull(mockEthUsdFeed, int256(2000e8), 8);
        // forge-lint: disable-next-line(unsafe-typecast)
        _mockFeedFull(mockFeed, int256(CHAINLINK_PRICE_8DEC), 8);
    }
}

/// @dev A Tellor oracle that keeps its submissions and answers
///      `getDataBefore` as Tellor does: the newest value reported strictly
///      before the given time. The query id is ignored (one feed).
contract TellorRecordMock {
    struct Entry {
        uint256 value;
        uint256 at;
    }

    Entry[] internal entries;

    function submit(uint256 value, uint256 at) external {
        entries.push(Entry(value, at));
    }

    function getDataBefore(bytes32, uint256 timestamp)
        external
        view
        returns (bytes memory value, uint256 timestampRetrieved)
    {
        for (uint256 i = entries.length; i > 0; --i) {
            Entry memory e = entries[i - 1];
            if (e.at < timestamp) return (abi.encode(e.value), e.at);
        }
        return (bytes(""), 0);
    }
}
