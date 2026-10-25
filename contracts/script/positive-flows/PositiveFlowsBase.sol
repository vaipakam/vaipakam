// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../../test/mocks/ERC20Mock.sol";
import {ERC4907Mock} from "../../test/mocks/ERC4907Mock.sol";
import {ERC1155RentableMock} from "../../test/mocks/ERC1155RentableMock.sol";
import {MockSanctionsList} from "../../test/mocks/MockSanctionsList.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "../../test/helpers/LibAcceptTestSigner.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {TreasuryFacet} from "../../src/facets/TreasuryFacet.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "../mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory, MockUniswapV3Pool} from "../mocks/MockUniswapV3.sol";
import {Deployments} from "../lib/Deployments.sol";
import {MockPoolPricing} from "../lib/MockPoolPricing.sol";
import {FixedRateSwapAdapter} from "../mocks/FixedRateSwapAdapter.sol";
import {RevertProbe} from "../lib/RevertProbe.sol";

/**
 * @title PositiveFlowsBase
 * @notice The one fixture, actor set and scenario runner every positive-flow
 *         module shares (#848 Phase 1). A module names its scenarios and runs
 *         them; everything a scenario stands on (who signs, which mocks exist,
 *         how the Diamond's oracle is pointed at them, how a scenario is
 *         selected, logged and counted) lives here once, so two modules cannot
 *         build the market two ways.
 *
 *         Each module is a standalone `forge script` and builds the fixture
 *         itself, so it does not depend on another module having run first:
 *
 *             forge script script/positive-flows/PositiveFlowsBasicLifecycle.s.sol \
 *               --rpc-url <rpc> --broadcast --slow --disable-block-gas-limit
 *
 *         `script/PositiveFlows.s.sol` runs every module in turn. The two flags
 *         and the fresh block it documents apply to a single module too.
 *
 *         SCENARIO IDS. Each scenario carries the `PF-###` flow ID of its
 *         primary row in `docs/TestScopes/PositiveFlowCoverage.md`, plus the
 *         other rows it also walks, and logs both:
 *
 *             [PF-090] Borrower accepts a lender ERC-20 offer, repays, both claim
 *             [PF-090]   flows: PF-040, PF-090, PF-110, PF-112, PF-113
 *             [PF-090] PASS
 *
 *         Where two scenarios share a primary row the second carries a suffix
 *         (`PF-230-floor`). `ONLY_SCENARIO=<id>` runs that one scenario, on its
 *         own fixture. A scenario that cannot run in the current deployment
 *         says `SKIP` and why, and the module summary counts it as a skip,
 *         never as a pass.
 *
 *         Earlier scripts numbered these scenarios `1`-`15` (the Sepolia
 *         lifecycle suite) and `N1`-`N26` (the newer-features suite). Issues,
 *         release notes and comments still use those labels; this is the map:
 *
 *             1  PF-090         7  PF-210        13 PF-141      N7  PF-280
 *             2  PF-111         8  (dropped: same flow as N15)   N8  PF-281
 *             3  PF-091         9  PF-094        14 PF-096      N9  PF-282
 *             4  PF-160         10 PF-092        15 PF-095      N10+N14 PF-250
 *             5  PF-045         11 PF-093        N1 PF-053      N11 PF-008
 *             6  PF-046         12 PF-140        N3 PF-114      N12 PF-300
 *             N4  PF-214        N5  PF-211       N6 PF-212      N15 PF-230
 *             N18 PF-323        N19 PF-322       N20 PF-329     N22 PF-324
 *             N25 PF-230-floor  N26 PF-231
 *
 *         WHERE IT MAY RUN. The fixture re-points the target Diamond at mocks
 *         it deploys itself: the Chainlink registry and ETH/USD feed, the v3
 *         factory, the PAA quote set, WETH, the sanctions oracle, and risk
 *         parameters for its own tokens. Scenarios also pause and unpause the
 *         Diamond and change its fee and treasury settings. Pointed at a
 *         shared testnet Diamond, that replaces the chain's live price and
 *         sanctions sources. So a
 *         module refuses any chain but a local Anvil (31337) unless
 *         `POSITIVE_FLOWS_ALLOW_CHAIN_ID` names the chain it is pointed at,
 *         which is meant for a Diamond deployed for the rehearsal.
 *
 *         Broadcast rule (#1646): never wrap a call made under
 *         `vm.startBroadcast` in try/catch. Forge records every call the
 *         simulation issues, a swallowed revert included, and replays it on
 *         the broadcast pass, where the same revert aborts the whole run
 *         before anything is mined. Decide from a view read instead, or let
 *         the call revert the scenario. To prove a call REVERTS, probe it with
 *         `RevertProbe.call`, never with a bare `vm.prank`: a pranked call
 *         spends a nonce of that account the chain never sees, so its next
 *         broadcast is signed one nonce ahead and never mines.
 *
 *         Env vars: DEPLOYER_PRIVATE_KEY, ADMIN_PRIVATE_KEY, ADMIN_ADDRESS,
 *         LENDER_PRIVATE_KEY, LENDER_ADDRESS, BORROWER_PRIVATE_KEY,
 *         BORROWER_ADDRESS, NEW_LENDER_PRIVATE_KEY, NEW_LENDER_ADDRESS,
 *         NEW_BORROWER_PRIVATE_KEY, NEW_BORROWER_ADDRESS. Optional:
 *         ONLY_SCENARIO, POSITIVE_FLOWS_ALLOW_CHAIN_ID. The Diamond is read
 *         from the chain's deployment artifact via {Deployments}.
 */
abstract contract PositiveFlowsBase is Script {
    // ── Actors ──────────────────────────────────────────────────────────
    // deployerKey funds nothing on the Diamond and holds no role after the
    // handover; it deploys and mints the mocks. adminKey signs every
    // role-gated call and funds the participants' gas.
    address internal diamond;
    address internal admin;
    address internal lender;
    address internal borrower;
    address internal newLender;
    address internal newBorrower;
    uint256 internal deployerKey;
    uint256 internal adminKey;
    uint256 internal lenderKey;
    uint256 internal borrowerKey;
    uint256 internal newLenderKey;
    uint256 internal newBorrowerKey;

    // ── Fixture (deployed by {_deployFixture}) ───────────────────────────
    ERC20Mock internal usdc;            // liquid ERC-20, 6 decimals: the lending asset
    ERC20Mock internal weth;            // liquid ERC-20, 18 decimals: the collateral
    ERC20Mock internal illiquidToken;   // no feed, no pool: an illiquid collateral
    ERC20Mock internal illiquidLending; // no feed, no pool: an illiquid lending asset
    ERC4907Mock internal nft721;        // rentable ERC-721
    ERC1155RentableMock internal nft1155; // rentable ERC-1155
    MockSanctionsList internal sanctions; // the Diamond's sanctions oracle; flags nobody until a scenario does
    /// @dev Kept so a scenario can move the collateral price; move it only
    ///      through {_setWethPriceConsistently}.
    MockChainlinkFeed internal wethFeedRef;
    /// @dev The mock USDC/WETH pool, kept so a feed move can re-price its spot
    ///      in the same step.
    MockUniswapV3Pool internal mockPoolRef;
    /// @dev The mock feed registry and v3 factory the Diamond is pointed at,
    ///      kept so {_pointDiamond} can point it at them again on attach.
    MockChainlinkRegistry internal registryRef;
    MockUniswapV3Factory internal univ3Ref;

    /// @dev Every mock the fixture deploys, by address: what a staged run
    ///      records after its first stage and binds again in its second
    ///      ({_attachFixture}).
    struct FixtureAddresses {
        address usdc;
        address weth;
        address illiquidToken;
        address illiquidLending;
        address nft721;
        address nft1155;
        address sanctions;
        address registry;
        address wethFeed;
        address univ3;
        address pool;
    }

    // ── Sizing ──────────────────────────────────────────────────────────
    // Chosen so every scenario's debt and collateral sit well above dust
    // thresholds and the loan opens at HF >= 1.5e18.
    uint256 internal constant LOAN_AMOUNT = 1000e6;      // 1000 USDC
    uint256 internal constant COLLATERAL_AMOUNT = 1e18;  // 1 WETH
    uint256 internal constant DAILY_FEE = 10e6;          // 10 USDC daily rental fee
    uint256 internal constant INTEREST_BPS = 500;        // 5% APR
    uint256 internal constant DURATION_DAYS = 30;
    /// @dev Duration of a replacement position that must END by the running
    ///      loan's maturity: the obligation handover's incoming borrower offer
    ///      and the offset vehicle. Both are refused once `now + duration`
    ///      passes the loan's maturity, so a full-term duration is acceptable
    ///      only in the loan's first second. That holds in simulation, where
    ///      every call shares one timestamp, and fails on a real broadcast,
    ///      where each transaction is its own block (#1646). One day shorter
    ///      gives each a one-day window.
    uint256 internal constant HANDOVER_DURATION_DAYS = DURATION_DAYS - 1;
    int256 internal constant USDC_PRICE_E8 = 1e8;     // $1.00
    int256 internal constant WETH_PRICE_E8 = 2000e8;  // $2000.00
    address internal constant USD_DENOMINATION = 0x0000000000000000000000000000000000000348;

    // ── Scenario registry ───────────────────────────────────────────────
    /// @dev One scenario of a module.
    /// @param id     Its `PF-###` primary row, suffixed when two scenarios share one.
    /// @param title  What the scenario does, in the catalog's words.
    /// @param flows  Every catalog row it walks, the primary included.
    struct Scenario {
        string id;
        string title;
        string flows;
    }

    /// @dev Set by {_skip} while a scenario runs; read and cleared by the runner.
    string private _skipReason;

    /// @notice The module's name, for its log lines and summary.
    function moduleName() public pure virtual returns (string memory);

    /// @notice The module's scenarios, in the order a full run takes them.
    function scenarios() public pure virtual returns (Scenario[] memory);

    /// @dev Runs scenario `index` of {scenarios}.
    function _runScenario(uint256 index) internal virtual;

    /// @notice Standalone entry: every scenario of this module, or the one
    ///         `ONLY_SCENARIO` names. An `ONLY_SCENARIO` this module does not
    ///         carry is refused rather than run as nothing.
    function run() external returns (uint256 passed, uint256 skipped) {
        string memory only = vm.envOr("ONLY_SCENARIO", string(""));
        if (bytes(only).length != 0 && !hasScenario(only)) {
            revert(string.concat(moduleName(), ": unknown ONLY_SCENARIO ", only));
        }
        return runSelected(only);
    }

    /// @notice True when `id` is one of this module's scenarios.
    function hasScenario(string memory id) public pure returns (bool) {
        Scenario[] memory list = scenarios();
        for (uint256 i = 0; i < list.length; i++) {
            if (_eq(list[i].id, id)) return true;
        }
        return false;
    }

    /// @notice Runs every scenario (`only` empty) or the one `only` names,
    ///         after building the fixture. Returns without touching the chain
    ///         when `only` names none of this module's scenarios, which is how
    ///         {PositiveFlows} hands one selection to every module.
    function runSelected(string memory only) public returns (uint256 passed, uint256 skipped) {
        if (bytes(only).length != 0 && !hasScenario(only)) return (0, 0);

        _beginModule("");
        _deployFixture();
        return _runEach(only, _runScenario, "");
    }

    /// @dev Everything a module does before its fixture: the chain guard, the
    ///      actors, the Diamond, and the module's header line. `stage` names a
    ///      staged run's stage in that header (empty for a one-pass run).
    function _beginModule(string memory stage) internal {
        _requireRehearsalChain();
        _loadEnv();
        diamond = Deployments.readDiamond();
        console.log("");
        console.log(string.concat("=== ", moduleName(), _stageSuffix(stage), " ==="));
        console.log("Diamond:    ", diamond);
    }

    /// @dev Runs `step` for every scenario (`only` empty) or the one `only`
    ///      names, logging each one's id, title, flows and outcome, and
    ///      counting a {_skip} as a skip, never as a pass. `step` is
    ///      {_runScenario} for a one-pass run, or one stage of a staged one.
    function _runEach(string memory only, function(uint256) internal step, string memory stage)
        internal
        returns (uint256 passed, uint256 skipped)
    {
        Scenario[] memory list = scenarios();
        for (uint256 i = 0; i < list.length; i++) {
            if (bytes(only).length != 0 && !_eq(list[i].id, only)) continue;
            string memory tag = string.concat("[", list[i].id, "] ");
            console.log("");
            console.log(string.concat(tag, list[i].title));
            console.log(string.concat(tag, "  flows: ", list[i].flows));
            step(i);
            if (bytes(_skipReason).length != 0) {
                console.log(string.concat(tag, "SKIP ", _skipReason));
                delete _skipReason;
                skipped++;
            } else {
                console.log(string.concat(tag, "PASS"));
                passed++;
            }
        }

        console.log("");
        console.log(string.concat("=== ", moduleName(), _stageSuffix(stage), ": ", vm.toString(passed),
            " passed, ", vm.toString(skipped), " skipped ==="));
    }

    function _stageSuffix(string memory stage) private pure returns (string memory) {
        return bytes(stage).length == 0 ? "" : string.concat(" (", stage, " stage)");
    }

    /// @dev Marks the running scenario as skipped, with the reason the log
    ///      prints. The scenario returns right after calling it.
    function _skip(string memory reason) internal {
        _skipReason = reason;
    }

    // ─── Setup ────────────────────────────────────────────────────────────

    /// @dev Refuses every chain but a local Anvil unless the operator names
    ///      the target chain in `POSITIVE_FLOWS_ALLOW_CHAIN_ID`. See "WHERE IT
    ///      MAY RUN" in the contract notice for what the fixture overwrites.
    function _requireRehearsalChain() internal view {
        if (block.chainid == 31337) return;
        uint256 allowed = vm.envOr("POSITIVE_FLOWS_ALLOW_CHAIN_ID", uint256(0));
        if (allowed != block.chainid) {
            revert(string.concat(
                "positive flows: chain ", vm.toString(block.chainid),
                " is not a local Anvil. The fixture re-points the Diamond's oracle,",
                " sanctions oracle and risk parameters at its own mocks; set",
                " POSITIVE_FLOWS_ALLOW_CHAIN_ID to this chain id only for a Diamond",
                " deployed for the rehearsal"
            ));
        }
    }

    function _loadEnv() internal {
        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        admin = vm.envAddress("ADMIN_ADDRESS");
        lenderKey = vm.envUint("LENDER_PRIVATE_KEY");
        lender = vm.envAddress("LENDER_ADDRESS");
        borrowerKey = vm.envUint("BORROWER_PRIVATE_KEY");
        borrower = vm.envAddress("BORROWER_ADDRESS");
        newLenderKey = vm.envUint("NEW_LENDER_PRIVATE_KEY");
        newLender = vm.envAddress("NEW_LENDER_ADDRESS");
        newBorrowerKey = vm.envUint("NEW_BORROWER_PRIVATE_KEY");
        newBorrower = vm.envAddress("NEW_BORROWER_ADDRESS");
    }

    /// @dev Deploys the module's own mocks, mints to every participant, and
    ///      points the Diamond at them. Every module calls it, and each call
    ///      deploys NEW token addresses and re-points the Diamond, so a module
    ///      never inherits another module's market.
    ///
    ///      Oracle: one price per asset, read by the feed AND the pool, so the
    ///      two sources the liquidity classifier compares cannot drift apart.
    ///      `OracleFacet`'s value-balance guard refuses a pool whose
    ///      feed-valued reserves do not balance (#856), and the floor-slippage
    ///      probe finds the pool only through the PAA quote set, which is why
    ///      that set names this fixture's WETH (#856, #848). The illiquid
    ///      tokens get neither a feed nor a pool, so they classify Illiquid.
    function _deployFixture() internal {
        _deployMocks();
        _pointDiamond();
    }

    /// @dev Binds the mocks a staged run's first stage deployed
    ///      ({fixtureAddresses}) and points the Diamond at them again. A
    ///      module run between its stages re-points the Diamond at its
    ///      own mocks, so the second stage cannot assume the Diamond still
    ///      reads the first stage's; every write in {_pointDiamond} is
    ///      idempotent, so pointing it again is safe either way. The mock
    ///      feeds report the block's own timestamp, so a clock step between
    ///      the stages leaves no price stale.
    function _attachFixture(FixtureAddresses memory f) internal {
        usdc = ERC20Mock(f.usdc);
        weth = ERC20Mock(f.weth);
        illiquidToken = ERC20Mock(f.illiquidToken);
        illiquidLending = ERC20Mock(f.illiquidLending);
        nft721 = ERC4907Mock(f.nft721);
        nft1155 = ERC1155RentableMock(f.nft1155);
        sanctions = MockSanctionsList(f.sanctions);
        registryRef = MockChainlinkRegistry(f.registry);
        wethFeedRef = MockChainlinkFeed(f.wethFeed);
        univ3Ref = MockUniswapV3Factory(f.univ3);
        mockPoolRef = MockUniswapV3Pool(f.pool);
        for (uint256 i = 0; i < 11; i++) {
            require(_fixtureAddressAt(f, i).code.length != 0,
                "positive flows: a recorded fixture address has no code on this chain");
        }
        console.log("Fixture attached: the first stage's mocks.");
        _pointDiamond();
    }

    /// @dev The fixture this run deployed or attached, by address.
    function fixtureAddresses() public view returns (FixtureAddresses memory) {
        return FixtureAddresses({
            usdc: address(usdc),
            weth: address(weth),
            illiquidToken: address(illiquidToken),
            illiquidLending: address(illiquidLending),
            nft721: address(nft721),
            nft1155: address(nft1155),
            sanctions: address(sanctions),
            registry: address(registryRef),
            wethFeed: address(wethFeedRef),
            univ3: address(univ3Ref),
            pool: address(mockPoolRef)
        });
    }

    function _fixtureAddressAt(FixtureAddresses memory f, uint256 i) private pure returns (address) {
        address[11] memory all = [f.usdc, f.weth, f.illiquidToken, f.illiquidLending, f.nft721, f.nft1155,
            f.sanctions, f.registry, f.wethFeed, f.univ3, f.pool];
        return all[i];
    }

    /// @dev Deploys the module's own mocks and mints to every participant.
    function _deployMocks() private {
        // ── Mocks and mints (deployer) ───────────────────────────────────
        // Every deploy is here, before any scenario: forge's broadcast
        // pre-check must see each token's CREATE before a later call
        // approves it, or it aborts with "transaction to address with no
        // code".
        vm.startBroadcast(deployerKey);
        usdc = new ERC20Mock("Mock USDC", "mUSDC", 6);
        weth = new ERC20Mock("Mock WETH", "mWETH", 18);
        illiquidToken = new ERC20Mock("Illiquid Token", "ILLIQ", 18);
        illiquidLending = new ERC20Mock("Illiquid Lending", "ILLEND", 18);
        nft721 = new ERC4907Mock("Rentable NFT 721", "rNFT");
        nft1155 = new ERC1155RentableMock();
        sanctions = new MockSanctionsList();
        console.log("MockUSDC:         ", address(usdc));
        console.log("MockWETH:         ", address(weth));
        console.log("IlliquidToken:    ", address(illiquidToken));
        console.log("IlliquidLending:  ", address(illiquidLending));
        console.log("NFT721:           ", address(nft721));
        console.log("NFT1155:          ", address(nft1155));
        console.log("MockSanctionsList:", address(sanctions));

        address[4] memory users = [lender, borrower, newLender, newBorrower];
        for (uint256 u = 0; u < users.length; u++) {
            usdc.mint(users[u], 500_000e6);
            weth.mint(users[u], 100e18);
            illiquidToken.mint(users[u], 10_000e18);
            // ERC-721 ids: 100-109 lender, 110-119 borrower, 120-129
            // newLender, 130-139 newBorrower.
            for (uint256 i = 0; i < 10; i++) {
                nft721.mint(users[u], 100 + 10 * u + i);
            }
            nft1155.forceMint(users[u], 1, 100);
        }
        usdc.mint(admin, 100_000e6);
        illiquidLending.mint(lender, 10_000e18);
        illiquidLending.mint(borrower, 10_000e18);

        registryRef = new MockChainlinkRegistry();
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(USDC_PRICE_E8, 8);
        wethFeedRef = new MockChainlinkFeed(WETH_PRICE_E8, 8);
        registryRef.setFeed(address(usdc), USD_DENOMINATION, address(usdcFeed));
        registryRef.setFeed(address(weth), USD_DENOMINATION, address(wethFeedRef));

        univ3Ref = new MockUniswapV3Factory();
        mockPoolRef = MockUniswapV3Pool(univ3Ref.createPool(
            address(usdc), address(weth), 3000, _mockPoolSqrtPriceX96At(uint256(WETH_PRICE_E8)), 1e24
        ));
        vm.stopBroadcast();
    }

    /// @dev Points the Diamond at the bound mocks: oracle, PAA set, risk
    ///      parameters, sanctions oracle, KYC tiers and countries, and funds
    ///      every participant's gas. Every write is idempotent.
    function _pointDiamond() private {
        // ── Role-gated config and gas (admin) ────────────────────────────
        vm.startBroadcast(adminKey);
        // 0.05 ETH covers a full module on an L2 or a local Anvil.
        _fundIfNeeded(lender, 0.05 ether);
        _fundIfNeeded(borrower, 0.05 ether);
        _fundIfNeeded(newLender, 0.05 ether);
        _fundIfNeeded(newBorrower, 0.05 ether);

        OracleAdminFacet(diamond).setChainlinkRegistry(address(registryRef));
        OracleAdminFacet(diamond).setUsdChainlinkDenominator(USD_DENOMINATION);
        OracleAdminFacet(diamond).setWethContract(address(weth));
        OracleAdminFacet(diamond).setEthUsdFeed(address(wethFeedRef));
        OracleAdminFacet(diamond).setUniswapV3Factory(address(univ3Ref));
        address[] memory paa = new address[](1);
        paa[0] = address(weth);
        ConfigFacet(diamond).setPaaAssets(paa);

        RiskFacet(diamond).updateRiskParams(address(usdc), 8000, 300);
        RiskFacet(diamond).updateRiskParams(address(weth), 8000, 300);

        // KYC enforcement is off on retail; the tiers and the trade pair are
        // set defensively so the drive also runs on a deploy that has it on.
        ProfileFacet(diamond).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(newLender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(newBorrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).setTradeAllowance("US", "US", true);
        ProfileFacet(diamond).setSanctionsOracle(address(sanctions));
        vm.stopBroadcast();

        _setCountryIfUnset(lenderKey, lender, "US");
        _setCountryIfUnset(borrowerKey, borrower, "US");
        _setCountryIfUnset(newLenderKey, newLender, "US");
        _setCountryIfUnset(newBorrowerKey, newBorrower, "US");

        console.log("Fixture ready: mocks, oracle, PAA, risk params, KYC, sanctions oracle, countries.");
    }

    /// @dev The mock pool's sqrtPriceX96 for a WETH feed price of `pWethE8`,
    ///      priced so the pool's feed-valued reserves balance. The derivation
    ///      is {MockPoolPricing}'s, the one rule every mock-pool script shares.
    function _mockPoolSqrtPriceX96At(uint256 pWethE8) internal view returns (uint160) {
        return MockPoolPricing.sqrtPriceX96(
            address(usdc), uint256(USDC_PRICE_E8), usdc.decimals(), address(weth), pWethE8, weth.decimals()
        );
    }

    /// @dev Move the mock WETH price on BOTH sources the Diamond consults: the
    ///      Chainlink feed (which drives health factors) and the mock pool's
    ///      spot (which the liquidity classifier compares against that feed).
    ///
    ///      Moving only the feed silently de-prices the OTHER leg. The mock
    ///      USDC and WETH share one pool, and `OracleFacet`'s value-balance
    ///      guard requires the pool's reserves, valued at feed prices, to
    ///      balance. A 25% feed move ($2000 -> $1500) against a pool still
    ///      quoting $2000 fails that guard, the pool stops being a discoverable
    ///      route, and mock USDC (whose only route is this pool) classifies
    ///      Illiquid. A sale scenario then hits the #1655 unpriceable-leg
    ///      refusal (`SaleLegUnpriceable`) on the PRINCIPAL leg instead of the
    ///      solvency floor it exists to exercise.
    ///
    ///      Health factors are unaffected by the pool spot, so the drift a
    ///      scenario engineers still happens exactly as intended.
    function _setWethPriceConsistently(uint256 pWethE8) internal {
        wethFeedRef.setPrice(int256(pWethE8));
        mockPoolRef.setSqrtPriceX96(_mockPoolSqrtPriceX96At(pWethE8));
    }

    function _fundIfNeeded(address acct, uint256 amount) internal {
        if (acct.balance < amount) {
            payable(acct).transfer(amount);
            console.log("Funded", acct);
        }
    }

    function _setCountryIfUnset(uint256 key, address user, string memory country) internal {
        string memory cur = ProfileFacet(diamond).getUserCountry(user);
        if (bytes(cur).length == 0) {
            vm.startBroadcast(key);
            ProfileFacet(diamond).setUserCountry(country);
            vm.stopBroadcast();
        }
    }

    // ─── Shared flow helpers ──────────────────────────────────────────────

    /// @dev The single-value USDC-for-WETH lender offer most scenarios open with.
    function _lenderOfferStandard() internal view returns (LibVaipakam.CreateOfferParams memory) {
        return _offerStandard(LibVaipakam.OfferType.Lender);
    }

    /// @dev The borrower-side twin of {_lenderOfferStandard}.
    function _borrowerOfferStandard() internal view returns (LibVaipakam.CreateOfferParams memory) {
        return _offerStandard(LibVaipakam.OfferType.Borrower);
    }

    function _offerStandard(LibVaipakam.OfferType offerType)
        private
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: offerType,
            lendingAsset: address(usdc),
            amount: LOAN_AMOUNT,
            interestRateBps: INTEREST_BPS,
            collateralAsset: address(weth),
            collateralAmount: COLLATERAL_AMOUNT,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: LOAN_AMOUNT,
            interestRateBpsMax: INTEREST_BPS,
            collateralAmountMax: COLLATERAL_AMOUNT,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    /// @dev Accepts `offerId` as the holder of `key`: signs the acceptance
    ///      terms, approves `approveAmount` of `approveAsset`, and accepts.
    function _acceptAs(uint256 key, uint256 offerId, address approveAsset, uint256 approveAmount)
        internal
        returns (uint256 loanId)
    {
        LibAcceptTerms.AcceptTerms memory terms =
            LibAcceptTestSigner.buildTerms(diamond, vm.addr(key), offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(diamond, terms, key);
        vm.startBroadcast(key);
        if (approveAmount != 0) ERC20Mock(approveAsset).approve(diamond, approveAmount);
        loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, terms, sig);
        vm.stopBroadcast();
    }

    /// @dev `key` posts the standard lender offer (`LOAN_AMOUNT` USDC).
    function _createLenderOffer(uint256 key) internal returns (uint256 offerId) {
        vm.startBroadcast(key);
        usdc.approve(diamond, LOAN_AMOUNT);
        offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        console.log("Lender offer created:", offerId);
    }

    /// @dev `key` repays the whole USDC debt of `loanId`.
    function _repayInFull(uint256 key, uint256 loanId) internal {
        vm.startBroadcast(key);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        console.log("Loan repaid:", repayAmt);
    }

    /// @dev Both sides claim a settled loan. Every caller reaches this right
    ///      after a full repayment, where each side has a claim, so a claim
    ///      that reverts is a failed scenario and must stop the run. These
    ///      were try/catch-swallowed once, which hid such a failure in
    ///      simulation and then aborted the broadcast pass on it (#1646).
    function _claimBoth(uint256 lKey, uint256 bKey, uint256 loanId) internal {
        vm.startBroadcast(lKey);
        ClaimFacet(diamond).claimAsLender(loanId);
        vm.stopBroadcast();
        vm.startBroadcast(bKey);
        ClaimFacet(diamond).claimAsBorrower(loanId);
        vm.stopBroadcast();
        console.log("Both parties claimed for loanId:", loanId);
    }

    /// @dev Deploys a {FixedRateSwapAdapter} priced at the fixture's oracle
    ///      rate, funds it with the lending asset, and appends it to the
    ///      Diamond's swap list. Returns it and a route that names only it.
    ///      Because it sells at the oracle rate, a scenario knows a swap's
    ///      proceeds before it calls. Remove it with {_removeFixedRateAdapter}
    ///      before the scenario ends.
    function _registerFixedRateAdapter()
        internal
        returns (FixedRateSwapAdapter adapter, LibSwap.AdapterCall[] memory route)
    {
        vm.startBroadcast(deployerKey);
        adapter = new FixedRateSwapAdapter(vm.addr(deployerKey), diamond);
        // 1e18 WETH at WETH_PRICE_E8 (8 decimals) buys that many 6-decimal USDC.
        adapter.setRate(address(weth), address(usdc), uint256(WETH_PRICE_E8) * 1e6 / 1e8, 1e18);
        usdc.mint(address(adapter), 10 * LOAN_AMOUNT);
        vm.stopBroadcast();

        vm.startBroadcast(adminKey);
        AdminFacet(diamond).addSwapAdapter(address(adapter));
        vm.stopBroadcast();
        address[] memory adapters = AdminFacet(diamond).getSwapAdapters();
        require(adapters[adapters.length - 1] == address(adapter), "the adapter should be appended to the swap list");
        route = _swapRouteFor(address(adapter));
    }

    /// @dev Whether `adapter` is on the Diamond's swap list now.
    function _isSwapAdapter(address adapter) internal view returns (bool) {
        address[] memory adapters = AdminFacet(diamond).getSwapAdapters();
        for (uint256 i = 0; i < adapters.length; i++) {
            if (adapters[i] == adapter) return true;
        }
        return false;
    }

    /// @dev A route naming only `adapter`, at its index in the swap list as
    ///      it stands now. The index is read, not remembered: other runs add
    ///      and remove adapters, so it can move between a staged run's stages.
    function _swapRouteFor(address adapter) internal view returns (LibSwap.AdapterCall[] memory route) {
        address[] memory adapters = AdminFacet(diamond).getSwapAdapters();
        for (uint256 i = 0; i < adapters.length; i++) {
            if (adapters[i] != adapter) continue;
            route = new LibSwap.AdapterCall[](1);
            route[0] = LibSwap.AdapterCall({adapterIdx: i, data: ""});
            return route;
        }
        revert("the adapter is not on the Diamond's swap list");
    }

    function _removeFixedRateAdapter(FixedRateSwapAdapter adapter) internal {
        vm.startBroadcast(adminKey);
        AdminFacet(diamond).removeSwapAdapter(address(adapter));
        vm.stopBroadcast();
    }

    /// @dev The treasury's USDC, under either topology: what the Diamond
    ///      records as held when it is its own treasury, otherwise the
    ///      external treasury's wallet balance.
    function _treasuryUsdc() internal view returns (uint256) {
        address treasury = AdminFacet(diamond).getTreasury();
        if (treasury == diamond) return TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        return usdc.balanceOf(treasury);
    }

    /// @dev Requires `data`, sent to the Diamond as `caller`, to be refused
    ///      with exactly `expectedRevert` (an error's selector and arguments;
    ///      `abi.encodeWithSelector(E.selector)` for an argument-free one).
    ///      Probed in the simulation only ({RevertProbe}), so the refusal
    ///      neither aborts the broadcast nor spends a nonce the chain never
    ///      sees; it still runs the deployed bytecode against chain state.
    function _requireRefused(address caller, bytes memory data, bytes memory expectedRevert, string memory failure)
        internal
    {
        (bool ok, bytes memory ret) = RevertProbe.call(caller, diamond, data);
        require(!ok && keccak256(ret) == keccak256(expectedRevert), failure);
    }

    /// @dev {_requireRefused} on the error's selector alone, for an error
    ///      whose arguments the scenario cannot know in advance.
    function _requireRefusedWithSelector(address caller, bytes memory data, bytes4 selector, string memory failure)
        internal
    {
        (bool ok, bytes memory ret) = RevertProbe.call(caller, diamond, data);
        require(!ok && ret.length >= 4 && bytes4(ret) == selector, failure);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
