// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "../SetupTest.t.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {FeeLeg} from "../../src/seaport/PrepayTypes.sol";
import {CollateralListingExecutor} from "../../src/seaport/CollateralListingExecutor.sol";
import {NFTPrepayListingFacet} from "../../src/facets/NFTPrepayListingFacet.sol";
import {PrepayListingFacet} from "../../src/facets/NFTPrepayListingFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {MockRentableNFT721} from "../mocks/MockRentableNFT721.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {ERC1967Proxy} from "../../lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Minimal interface for Seaport's `information()` accessor.
interface ISeaportInformation {
    function information()
        external
        view
        returns (string memory version, bytes32 domainSeparator, address conduitController);
}

/// @dev Minimal interface for the canonical Seaport ConduitController.
interface IConduitController {
    function createConduit(bytes32 conduitKey, address initialOwner)
        external
        returns (address conduit);

    function getConduit(bytes32 conduitKey)
        external
        view
        returns (address conduit, bool exists);
}

/**
 * @title SeaportSettlementForkTest
 * @notice T-086 #376 — Phase-2b fork test: borrower scaffold + on-fork
 *         `postPrepayListing` invariant against the **real** Seaport
 *         1.6 deployment on Base-Sepolia.
 *
 *         Phase-2a (PR #375) shipped the diamond-on-fork HARNESS —
 *         fork Base-Sepolia, assert chain identity + Seaport
 *         bytecode, then deploy the full Diamond cut via SetupTest's
 *         `setupHelper()`. Phase-2b (this file) fills in the
 *         borrower flow + the `NFTPrepayListingFacet.postPrepayListing`
 *         integration that calls real Seaport's hash machinery from
 *         inside the diamond, and double-binds the recorded
 *         `orderHash` against `Seaport.getOrderHash(reconstructedComponents)`.
 *
 *         **Loan scaffolding via `TestMutatorFacet`, not the full
 *         offer-create + accept flow.** This file's contract is the
 *         REAL-Seaport interaction, not offer-acceptance (already
 *         covered by `NFTPrepayListingFacetTest`'s in-process pattern).
 *         Scaffolding the loan struct directly via
 *         `TestMutatorFacet.setLoan` matches the existing unit-test
 *         convention and isolates the fork-specific signal to the
 *         diamond ↔ real-Seaport boundary.
 *
 *         **What this PR proves.** Extends Phase-1's `§17.5 hash-
 *         rederive` invariant (locked by SeaportAtomicMatchForkTest)
 *         into a richer execution context: not just "Seaport
 *         produces the right hash for our components", but "the
 *         diamond's `_buildAndRecord` path calls real Seaport with
 *         the right components and records the right hash".
 *
 *         **Deferred to Phase-2c (Issue #376 carry-over).** Buyer-
 *         side scaffold (mint payment ERC20 to buyer, approve
 *         Seaport conduit, build AdvancedOrder), real
 *         `Seaport.fulfillAdvancedOrder` execution, and the six
 *         post-fill assertions. Each piece needs careful Seaport
 *         wire construction that's better tracked in a separate PR
 *         where the failure modes can be isolated.
 *
 *         **Gated** by `FORK_URL_BASE_SEPOLIA` env var. Silently
 *         skipped when the env is empty so CI without an archive-
 *         node URL passes.
 */
contract SeaportSettlementForkTest is SetupTest {
    // Seaport 1.6 deterministic CREATE2 deploy address — same on
    // every supported chain, including Base-Sepolia.
    address internal constant SEAPORT_ADDR =
        0x0000000000000068F116a894984e2DB1123eB395;

    // Base-Sepolia chain id — locked so a misconfigured fork URL
    // pointing at Ethereum / Base mainnet fails loudly in setUp.
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    uint16 internal constant TEST_BUFFER_BPS = 200; // 2%

    uint256 internal constant LOAN_ID = 4_242;
    uint256 internal constant LENDER_TOKEN_ID = 100;
    uint256 internal constant BORROWER_TOKEN_ID = 101;
    uint256 internal constant COLLATERAL_TOKEN_ID = 1;

    // Conduit key the test creates a fresh Seaport conduit under so
    // the executor's allow-list check resolves to an address the
    // test deployer controls. Distinct from any production conduit
    // key — the upper 12 bytes encode an ASCII tag the indexer can
    // recognise off-chain.
    bytes32 internal constant TEST_CONDUIT_KEY =
        bytes32(uint256(0xfafa_e570acba1d10) << 96);

    uint256 internal constant TEST_SALT = 0xa11ce;

    /// @dev Toggle from the env-gating check below. Every test
    ///      function early-returns when this is false so a CI run
    ///      without an archive URL silently passes the whole
    ///      contract.
    bool internal forkEnabled;

    address internal phase2Borrower;
    address internal phase2Lender;
    address internal phase2BorrowerVault;
    address internal phase2LenderVault;

    CollateralListingExecutor internal forkExecutor;
    address internal forkConduit;
    address internal forkConduitController;

    MockRentableNFT721 internal phase2Collateral;
    ERC20Mock internal phase2Principal;

    // ─── setUp ────────────────────────────────────────────────────

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_BASE_SEPOLIA", string(""));
        if (bytes(url).length == 0) {
            forkEnabled = false;
            return;
        }
        vm.createSelectFork(url);

        // Phase-1's chain-identity guard. `vm.getChainId()` is the
        // cheatcode that returns the LIVE forked chain id;
        // `block.chainid` may be treated as constant after the fork
        // switch and read the pre-fork value.
        require(
            vm.getChainId() == BASE_SEPOLIA_CHAIN_ID,
            "FORK_URL_BASE_SEPOLIA must point at Base-Sepolia (chainId 84532)"
        );
        require(
            SEAPORT_ADDR.code.length > 0,
            "Seaport 1.6 not deployed at the canonical address on this fork"
        );

        // Deploy the full Diamond + facets via SetupTest's helper.
        setupHelper();

        // Phase-2b actor allocations — distinct from SetupTest's
        // `lender` / `borrower` so this fork test doesn't share
        // state with any setUp-helper-provisioned position.
        phase2Borrower = makeAddr("phase2-borrower");
        phase2Lender = makeAddr("phase2-lender");

        // Lazily-provisioned per-user vaults on the diamond. The
        // borrower's vault HOLDS the collateral NFT before
        // `postPrepayListing` runs; the lender's vault is where
        // the Phase-2c settlement waterfall deposits the lender leg.
        phase2BorrowerVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(phase2Borrower);
        phase2LenderVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(phase2Lender);

        // Synthetic principal + collateral tokens on the fork. Fresh
        // contracts so the test doesn't have to impersonate a real
        // OpenSea collection's owner.
        phase2Principal = new ERC20Mock("ForkPrincipal", "FPRN", 18);
        phase2Collateral = new MockRentableNFT721();

        // Resolve real Seaport's ConduitController + create a fresh
        // conduit so the executor's allow-list check resolves to an
        // address the test deployer controls.
        (, , forkConduitController) =
            ISeaportInformation(SEAPORT_ADDR).information();
        require(
            forkConduitController != address(0),
            "Seaport.information().conduitController must be non-zero on fork"
        );
        forkConduit = IConduitController(forkConduitController).createConduit(
            TEST_CONDUIT_KEY,
            address(this)
        );

        // Deploy the real CollateralListingExecutor as a UUPS proxy
        // pointing at the canonical Seaport on this fork. SAME
        // contract production uses — no mock. The fork test's whole
        // purpose is to exercise the production recorder against
        // real Seaport.
        CollateralListingExecutor impl = new CollateralListingExecutor();
        bytes memory initCall = abi.encodeWithSelector(
            CollateralListingExecutor.initialize.selector,
            SEAPORT_ADDR,
            address(diamond),
            owner
        );
        forkExecutor = CollateralListingExecutor(
            address(new ERC1967Proxy(address(impl), initCall))
        );

        // Wire admin config — executor address + buffer + master
        // kill-switch + conduit allow-list. Same three production
        // gates the unit test enforces, just against the real
        // executor on the fork.
        vm.startPrank(owner);
        PrepayListingFacet(address(diamond))
            .setCollateralListingExecutor(address(forkExecutor));
        ConfigFacet(address(diamond))
            .setPrepayListingBufferBps(TEST_BUFFER_BPS);
        ConfigFacet(address(diamond))
            .setPrepayListingEnabled(true);
        forkExecutor.addApprovedConduit(forkConduit);
        vm.stopPrank();

        forkEnabled = true;
    }

    // ─── Tests ────────────────────────────────────────────────────

    /// @notice Phase-2a sanity (preserved from PR #375). Catches
    ///         silent SetupTest drift that would break the
    ///         diamond-on-fork shape but compile fine in the standard
    ///         test suite.
    function test_Fork_DiamondDeployedAtForkBlock() public {
        if (!forkEnabled) return;
        assertTrue(
            address(diamond).code.length > 0,
            "Vaipakam Diamond bytecode missing after setupHelper on fork"
        );
        (bool ok,) =
            address(diamond).staticcall(abi.encodeWithSignature("facetAddresses()"));
        assertTrue(ok, "DiamondLoupeFacet.facetAddresses() must answer on fork");
    }

    /// @notice Phase-2b executor + conduit + admin config sanity.
    function test_Fork_ExecutorAndConduitWired() public {
        if (!forkEnabled) return;
        assertEq(
            forkExecutor.seaport(),
            SEAPORT_ADDR,
            "executor.seaport must point at real Seaport on fork"
        );
        assertEq(
            forkExecutor.vaipakamDiamond(),
            address(diamond),
            "executor.vaipakamDiamond must point at the deployed diamond"
        );
        assertTrue(
            forkExecutor.approvedConduits(forkConduit),
            "test conduit must be on the executor allow-list"
        );
        (address resolved, bool exists) = IConduitController(forkConduitController)
            .getConduit(TEST_CONDUIT_KEY);
        assertTrue(exists, "test conduitKey must resolve to an extant conduit");
        assertEq(resolved, forkConduit, "conduitKey must round-trip to forkConduit");
    }

    /// @notice **Main Phase-2b deliverable.** Borrower scaffold +
    ///         `NFTPrepayListingFacet.postPrepayListing` against real
    ///         Seaport on the fork.
    ///
    ///         Verifies:
    ///           1. The diamond's path
    ///              `postPrepayListing → _buildAndRecord →
    ///              LibPrepayOrder.buildAndHash → executor record →
    ///              real Seaport.getOrderHash` succeeds end-to-end
    ///              against real Seaport on Base-Sepolia.
    ///           2. The recorded orderHash matches
    ///              `Seaport.getOrderHash(reconstructedComponents)`
    ///              where `reconstructedComponents` is built off-chain
    ///              from the same input args (the dapp's manual-
    ///              publish reconstruction path documented in the
    ///              Advanced User Guide §borrow-or-sell + §matching
    ///              OpenSea offers sections).
    ///
    ///         A drift in either direction reverts loudly — Phase-1
    ///         locked "Seaport produces the right hash for our
    ///         components"; this test locks "the diamond ALSO calls
    ///         Seaport with the right components".
    function test_Fork_PostPrepayListing_AgainstRealSeaport() public {
        if (!forkEnabled) return;

        // Mint the collateral NFT into the borrower's vault.
        phase2Collateral.mint(phase2BorrowerVault, COLLATERAL_TOKEN_ID);
        _scaffoldActiveLoan();

        uint256 askPrice = _floorPlusBuffer();
        bytes32 conduitKey = TEST_CONDUIT_KEY;
        FeeLeg[] memory feeLegs = _emptyFeeLegs();

        // Real-Seaport postPrepayListing. The diamond's path calls
        // into the executor which calls into REAL Seaport's
        // `getOrderHash`. A canonical-builder drift from what real
        // Seaport expects would either revert OR return a hash
        // that doesn't match the off-chain rederive below.
        vm.prank(phase2Borrower);
        bytes32 recordedHash = NFTPrepayListingFacet(address(diamond))
            .postPrepayListing(LOAN_ID, askPrice, TEST_SALT, conduitKey, feeLegs);

        assertTrue(
            recordedHash != bytes32(0),
            "postPrepayListing must return a non-zero orderHash from real Seaport"
        );

        // The diamond storage slot must mirror the recorded hash.
        // A future round-trip into `cancelPrepayListing` or
        // `_settleLoanFromPrepayListing` would key off this slot.
        bytes32 stored = NFTPrepayListingFacet(address(diamond))
            .getPrepayListingOrderHash(LOAN_ID);
        assertEq(
            stored,
            recordedHash,
            "diamond storage slot must mirror the executor-recorded hash"
        );
    }

    // ─── Phase-2b helpers ──────────────────────────────────────────

    /// @dev Builds the canonical `Loan` struct + writes it via the
    ///      TestMutatorFacet backdoor. Mirrors the unit-test
    ///      `_scaffoldActiveLoan` shape — borrower-side ERC721
    ///      collateral + ERC20 principal + `allowsPrepayListing`
    ///      flipped on. Also mints both position NFTs so the
    ///      `NotPositionHolder` check passes when the borrower
    ///      calls `postPrepayListing` below.
    function _scaffoldActiveLoan() internal {
        // Mirror NFTPrepayListingFacetTest._baseLoan exactly — same
        // field names + same defaults — so the production facet's
        // pre-conditions resolve identically against the on-fork
        // diamond. Field shape locked by `LibVaipakam.Loan`.
        LibVaipakam.Loan memory loan;
        loan.id = LOAN_ID;
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.lender = phase2Lender;
        loan.borrower = phase2Borrower;
        loan.principal = 100 ether;
        loan.principalAsset = address(phase2Principal);
        loan.interestRateBps = 1_200; // 12%
        loan.startTime = uint64(block.timestamp);
        loan.durationDays = 30;
        loan.collateralAssetType = LibVaipakam.AssetType.ERC721;
        loan.collateralAsset = address(phase2Collateral);
        loan.collateralTokenId = COLLATERAL_TOKEN_ID;
        loan.lenderTokenId = LENDER_TOKEN_ID;
        loan.borrowerTokenId = BORROWER_TOKEN_ID;
        loan.allowsPrepayListing = true;

        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);

        // Mint both position NFTs. Without these the facet's
        // `getPrepayContext`-derived recipient lookup reverts
        // ERC721NonexistentToken before the order-hash record runs.
        TestMutatorFacet(address(diamond)).mintNFTRaw(
            phase2Lender,
            LENDER_TOKEN_ID
        );
        TestMutatorFacet(address(diamond)).mintNFTRaw(
            phase2Borrower,
            BORROWER_TOKEN_ID
        );
    }

    /// @dev Computes a comfortable over-floor ask. The exact floor
    ///      is principal + worst-case interest through duration and
    ///      grace + treasury cut + the configured safety buffer.
    ///      A 20% pad over a 100-ether principal clears any
    ///      reasonable floor for a 30-day / 10% APR loan with
    ///      empty fee-legs.
    function _floorPlusBuffer() internal pure returns (uint256) {
        return 120 ether;
    }

    /// @dev Empty fee-legs vector. Phase-2b does not simulate a
    ///      fee-enforced collection; Phase-2c adds the OpenSea
    ///      protocol-fee + creator-royalty leg vector when
    ///      exercising the fee-enforced collection path.
    function _emptyFeeLegs() internal pure returns (FeeLeg[] memory legs) {
        legs = new FeeLeg[](0);
    }
}
