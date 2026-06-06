// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "../SetupTest.t.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibPrepayOrder} from "../../src/libraries/LibPrepayOrder.sol";
import {ISeaportOrderHash, OrderComponents} from "../../src/seaport/ISeaportOrderHash.sol";
import {
    OrderParameters,
    AdvancedOrder,
    CriteriaResolver,
    OfferItem as MatchOfferItem,
    ConsiderationItem as MatchConsiderationItem,
    OrderType as MatchOrderType
} from "../../src/seaport/ISeaportMatch.sol";
import {ItemType} from "../../src/seaport/ISeaportZone.sol";
import {IVaipakamPrepayContext} from "../../src/seaport/IVaipakamPrepayContext.sol";
import {FeeLeg} from "../../src/seaport/PrepayTypes.sol";
import {CollateralListingExecutor} from "../../src/seaport/CollateralListingExecutor.sol";
import {NFTPrepayListingFacet} from "../../src/facets/NFTPrepayListingFacet.sol";
import {PrepayListingFacet} from "../../src/facets/PrepayListingFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {MockRentableNFT721} from "../mocks/MockRentableNFT721.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {IERC20} from "../../lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "../../lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
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

    /// @notice Opens (or closes) a channel on a conduit so that channel
    ///         can execute transfers through it. Required for any
    ///         counter-party (including Seaport itself) to actually
    ///         transfer tokens via the conduit.
    function updateChannel(address conduit, address channel, bool isOpen) external;
}

/// @dev Minimal interface for `Seaport.fulfillAdvancedOrder` — the
///      single function Phase-2c calls into to drive a real buyer
///      fulfillment against the live prepay listing. Seaport's full
///      ABI is large; we vendor only the slice we use.
interface ISeaportFulfill {
    function fulfillAdvancedOrder(
        AdvancedOrder calldata advancedOrder,
        CriteriaResolver[] calldata criteriaResolvers,
        bytes32 fulfillerConduitKey,
        address recipient
    ) external payable returns (bool fulfilled);
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

    // Conduit key — built at runtime in setUp from
    // `address(this) << 96 | TEST_CONDUIT_SALT`. Codex round-1 P1:
    // real Seaport's `ConduitController.createConduit` requires the
    // FIRST 20 BYTES of the conduit key to equal `msg.sender`; a
    // fixed-tag constant would revert the call before any fork
    // test ran.
    bytes32 internal testConduitKey;
    uint96 internal constant TEST_CONDUIT_SALT = 0xfafae570acba1d;

    uint256 internal constant TEST_SALT = 0xa11ce;

    /// @dev Toggle from the env-gating check below. Every test
    ///      function early-returns when this is false so a CI run
    ///      without an archive URL silently passes the whole
    ///      contract.
    bool internal forkEnabled;

    address internal phase2Borrower;
    address internal phase2Lender;
    address internal phase2Buyer;
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
        phase2Buyer = makeAddr("phase2-buyer");

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
        // Real Seaport's createConduit requires conduitKey[0:20] ==
        // msg.sender (`createConduit` reverts InvalidCreator otherwise).
        // Pack address(this) into the top 20 bytes + a unique salt in
        // the bottom 12 so the same test contract can mint distinct
        // conduits across runs if needed.
        testConduitKey =
            bytes32((uint256(uint160(address(this))) << 96) | uint256(TEST_CONDUIT_SALT));
        forkConduit = IConduitController(forkConduitController).createConduit(
            testConduitKey,
            address(this)
        );

        // Codex round-2 P2 #1 — open `SEAPORT_ADDR` as a channel on
        // the new conduit. Without this, real Seaport's transfer
        // attempt through the conduit at fulfillment time would
        // revert `ChannelClosed`, masking that Phase-2c's later
        // settlement assertions exercise the actual transfer path.
        // The conduit's owner (= `address(this)`, per the
        // createConduit call above) is the only caller authorised
        // for `updateChannel`.
        IConduitController(forkConduitController).updateChannel(
            forkConduit,
            SEAPORT_ADDR,
            true
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
            .getConduit(testConduitKey);
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
        bytes32 conduitKey = testConduitKey;
        FeeLeg[] memory feeLegs = _emptyFeeLegs();

        // Codex round-2 P2 #2 — warp time forward so
        // `loan.startTime` ≠ `block.timestamp`-at-listing. The
        // production `_buildAndRecord` stamps `block.timestamp` into
        // the Seaport components' `startTime` slot, while
        // `loan.startTime` is the loan ORIGINATION stamp set at
        // `initiateLoan`. Same-block scaffolding would mask a real
        // bug where the rederive accidentally uses loan-start
        // instead of listing-post time; warping by an arbitrary
        // amount keeps the two distinct and makes the rederive
        // assertion below load-bearing.
        vm.warp(block.timestamp + 1 days);
        uint256 listingTimestamp = block.timestamp;

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

        // Codex round-2 P2 #3 — assert the two settlement-prerequisite
        // side effects too: the vault's ERC-1271 binding (so Seaport
        // accepts the order as authorised) and the executor's order-
        // context record (so the zone callback at fill time can
        // resolve loanId / conduit / askPrice / mode). Without these
        // the Phase-2c fulfillment would revert even though the
        // diamond mirror slot looked correct.
        assertEq(
            VaipakamVaultImplementation(phase2BorrowerVault).getListingExecutor(recordedHash),
            address(forkExecutor),
            "vault's ERC-1271 binding must point at the executor for the recorded orderHash"
        );
        (
            uint96 ctxLoanId,
            address ctxConduit,
            bytes32 ctxConduitKey,
            uint256 ctxSalt,
            uint64 ctxStartTime,
            uint192 ctxAskPrice,
            ,
            ,
            uint8 ctxMode
        ) = forkExecutor.orderContext(recordedHash);
        assertEq(uint256(ctxLoanId), LOAN_ID, "executor.orderContext.loanId must equal LOAN_ID");
        assertEq(ctxConduit, forkConduit, "executor.orderContext.conduit must equal forkConduit");
        assertEq(ctxConduitKey, conduitKey, "executor.orderContext.conduitKey must round-trip");
        assertEq(ctxSalt, TEST_SALT, "executor.orderContext.salt must equal TEST_SALT");
        assertEq(uint256(ctxStartTime), listingTimestamp, "executor.orderContext.startTime must equal listing block.timestamp");
        assertEq(uint256(ctxAskPrice), askPrice, "executor.orderContext.askPrice must equal askPrice");
        assertEq(uint256(ctxMode), 0, "executor.orderContext.mode must be PREPAY_MODE_FIXED_PRICE (0)");

        // Codex round-1 P2 — extend the assertion: reconstruct the
        // canonical OrderComponents off-chain via the same
        // `LibPrepayOrder.componentsForCancel` builder the executor's
        // cancel path uses, then call real `Seaport.getOrderHash`
        // and assert the result MATCHES the recorded hash. This is
        // the §17.5 hash-rederive invariant in its fullest form:
        // not just "Seaport produces the right hash for our
        // components" (Phase-1) and not just "the diamond records
        // the same hash it returned" (storage round-trip), but
        // "the diamond's `_buildAndRecord` path constructs THE SAME
        // OrderComponents that the off-chain reconstruction builds".
        // A drift in either side would surface here as a hash
        // mismatch.
        // Codex round-2 P2 #2 — context evaluated AS-OF the listing
        // timestamp (the `block.timestamp` captured immediately
        // before the post call). Loan-start would be wrong and
        // would mask a bug if the production path accidentally
        // used loan-start instead.
        IVaipakamPrepayContext.PrepayContext memory pctx = IVaipakamPrepayContext(
            address(diamond)
        ).getPrepayContext(LOAN_ID, listingTimestamp);
        uint256 counter = ISeaportOrderHash(SEAPORT_ADDR).getCounter(phase2BorrowerVault);
        OrderComponents memory components = LibPrepayOrder.componentsForCancel(
            pctx,
            address(forkExecutor),
            askPrice,
            conduitKey,
            TEST_SALT,
            listingTimestamp,
            counter,
            feeLegs
        );
        bytes32 rederivedHash = ISeaportOrderHash(SEAPORT_ADDR).getOrderHash(components);
        assertEq(
            recordedHash,
            rederivedHash,
            "diamond-recorded hash must match independently-reconstructed Seaport hash"
        );
    }

    /// @notice **Phase-2c deliverable.** Real buyer fulfillment +
    ///         the six settlement assertions Issue #378 specified.
    ///
    ///         Drives:
    ///           1. Borrower scaffold + on-fork `postPrepayListing`
    ///              (same path Phase-2b exercises).
    ///           2. Buyer-side scaffold: mint payment ERC20 + approve
    ///              real Seaport for the listing's ask amount.
    ///           3. Build `AdvancedOrder` matching the on-chain order
    ///              shape. Signature is the EMPTY BYTES `0x` — the
    ///              vault's ERC-1271 `isValidSignature(orderHash, "")`
    ///              callback returns the EIP-1271 magic value for any
    ///              orderHash the executor previously bound via
    ///              `wire`.
    ///           4. Real `Seaport.fulfillAdvancedOrder` from the buyer.
    ///           5. Asserts six post-fill state changes (per #378):
    ///              a. Lender vault balance ↑ by `pctx.lenderLeg`.
    ///              b. Treasury balance ↑ by `pctx.treasuryLeg`.
    ///              c. Borrower vault balance ↑ by the remainder.
    ///              d. Loan transitioned to `Settled`.
    ///              e. Borrower-NFT lock released.
    ///              f. Buyer holds the collateral NFT.
    function test_Fork_BuyerFulfillsAndSettles() public {
        if (!forkEnabled) return;

        // ── Borrower scaffold + post (same as Phase-2b) ──────────
        phase2Collateral.mint(phase2BorrowerVault, COLLATERAL_TOKEN_ID);
        _scaffoldActiveLoan();
        vm.warp(block.timestamp + 1 days);
        uint256 listingTimestamp = block.timestamp;
        uint256 askPrice = _floorPlusBuffer();
        bytes32 conduitKey = testConduitKey;
        FeeLeg[] memory feeLegs = _emptyFeeLegs();

        vm.prank(phase2Borrower);
        bytes32 recordedHash = NFTPrepayListingFacet(address(diamond))
            .postPrepayListing(LOAN_ID, askPrice, TEST_SALT, conduitKey, feeLegs);

        // ── Reconstruct the canonical OrderComponents off-chain ───
        IVaipakamPrepayContext.PrepayContext memory pctx = IVaipakamPrepayContext(
            address(diamond)
        ).getPrepayContext(LOAN_ID, listingTimestamp);
        uint256 counter = ISeaportOrderHash(SEAPORT_ADDR).getCounter(phase2BorrowerVault);
        OrderComponents memory components = LibPrepayOrder.componentsForCancel(
            pctx,
            address(forkExecutor),
            askPrice,
            conduitKey,
            TEST_SALT,
            listingTimestamp,
            counter,
            feeLegs
        );

        // ── Buyer-side scaffold: mint payment + approve Seaport ───
        ERC20Mock(address(phase2Principal)).mint(phase2Buyer, askPrice);
        vm.prank(phase2Buyer);
        IERC20(address(phase2Principal)).approve(SEAPORT_ADDR, askPrice);

        // ── Snapshot balances + state BEFORE fulfillment ─────────
        address treasury = AdminFacet(address(diamond)).getTreasury();
        uint256 lenderVaultBefore =
            IERC20(address(phase2Principal)).balanceOf(phase2LenderVault);
        uint256 treasuryBefore =
            IERC20(address(phase2Principal)).balanceOf(treasury);
        uint256 borrowerVaultBefore =
            IERC20(address(phase2Principal)).balanceOf(phase2BorrowerVault);

        // ── Build AdvancedOrder from OrderComponents ─────────────
        // `OrderParameters` is `OrderComponents` minus `counter` plus
        // `totalOriginalConsiderationItems`. Signature stays empty
        // bytes — the vault's ERC-1271 callback accepts any
        // orderHash the diamond previously registered via `wire`.
        // numerator/denominator = 1/1 for a full fill.
        // `OrderComponents` (from ISeaportOrderHash) and `OrderParameters`
        // (from ISeaportMatch) use STRUCTURALLY-IDENTICAL but
        // type-distinct nested types (OfferItem / ConsiderationItem /
        // OrderType). Solidity rejects the implicit cross-interface
        // conversion even though the wire layouts match exactly, so
        // we copy the arrays element-by-element with the explicit
        // target-interface types.
        MatchOfferItem[] memory matchOffer = new MatchOfferItem[](components.offer.length);
        for (uint256 i = 0; i < components.offer.length; i++) {
            matchOffer[i] = MatchOfferItem({
                itemType: ItemType(uint8(components.offer[i].itemType)),
                token: components.offer[i].token,
                identifierOrCriteria: components.offer[i].identifierOrCriteria,
                startAmount: components.offer[i].startAmount,
                endAmount: components.offer[i].endAmount
            });
        }
        MatchConsiderationItem[] memory matchConsideration =
            new MatchConsiderationItem[](components.consideration.length);
        for (uint256 i = 0; i < components.consideration.length; i++) {
            matchConsideration[i] = MatchConsiderationItem({
                itemType: ItemType(uint8(components.consideration[i].itemType)),
                token: components.consideration[i].token,
                identifierOrCriteria: components.consideration[i].identifierOrCriteria,
                startAmount: components.consideration[i].startAmount,
                endAmount: components.consideration[i].endAmount,
                recipient: components.consideration[i].recipient
            });
        }
        AdvancedOrder memory advanced = AdvancedOrder({
            parameters: OrderParameters({
                offerer: components.offerer,
                zone: components.zone,
                offer: matchOffer,
                consideration: matchConsideration,
                orderType: MatchOrderType(uint8(components.orderType)),
                startTime: components.startTime,
                endTime: components.endTime,
                zoneHash: components.zoneHash,
                salt: components.salt,
                conduitKey: components.conduitKey,
                totalOriginalConsiderationItems: components.consideration.length
            }),
            numerator: 1,
            denominator: 1,
            signature: hex"",
            extraData: hex""
        });

        // ── Real Seaport fulfillAdvancedOrder ────────────────────
        // `fulfillerConduitKey = bytes32(0)` — buyer pays via
        // Seaport directly (the buyer's ERC20 approval is on
        // Seaport, not on a buyer-side conduit). `recipient =
        // phase2Buyer` — the NFT goes to the buyer.
        CriteriaResolver[] memory noResolvers = new CriteriaResolver[](0);
        vm.prank(phase2Buyer);
        bool ok = ISeaportFulfill(SEAPORT_ADDR).fulfillAdvancedOrder(
            advanced,
            noResolvers,
            bytes32(0),
            phase2Buyer
        );
        assertTrue(ok, "Seaport.fulfillAdvancedOrder must return true on a full fill");

        // ── Six post-fill assertions (per Issue #378) ────────────
        // 1. Lender vault balance ↑ by lender leg.
        uint256 lenderVaultAfter =
            IERC20(address(phase2Principal)).balanceOf(phase2LenderVault);
        assertEq(
            lenderVaultAfter - lenderVaultBefore,
            pctx.lenderLeg,
            "lender vault balance must increase by pctx.lenderLeg"
        );
        // 2. Treasury balance ↑ by treasury leg.
        uint256 treasuryAfter =
            IERC20(address(phase2Principal)).balanceOf(treasury);
        assertEq(
            treasuryAfter - treasuryBefore,
            pctx.treasuryLeg,
            "treasury balance must increase by pctx.treasuryLeg"
        );
        // 3. Borrower vault balance ↑ by remainder.
        uint256 borrowerVaultAfter =
            IERC20(address(phase2Principal)).balanceOf(phase2BorrowerVault);
        uint256 expectedRemainder = askPrice - pctx.lenderLeg - pctx.treasuryLeg;
        assertEq(
            borrowerVaultAfter - borrowerVaultBefore,
            expectedRemainder,
            "borrower vault balance must increase by ask minus lender+treasury legs"
        );
        // 4. Loan transitioned to Settled.
        LibVaipakam.Loan memory loanAfter =
            LoanFacet(address(diamond)).getLoanDetails(LOAN_ID);
        assertEq(
            uint256(loanAfter.status),
            uint256(LibVaipakam.LoanStatus.Settled),
            "loan.status must be Settled after fulfillment"
        );
        // 5. Borrower-NFT lock released. Diamond storage clears the
        //    prepay-listing slot at settlement; assert it's zero.
        bytes32 storedAfter = NFTPrepayListingFacet(address(diamond))
            .getPrepayListingOrderHash(LOAN_ID);
        assertEq(
            storedAfter,
            bytes32(0),
            "prepayListingOrderHash slot must clear at settlement"
        );
        // 6. Buyer holds the collateral NFT.
        assertEq(
            IERC721(address(phase2Collateral)).ownerOf(COLLATERAL_TOKEN_ID),
            phase2Buyer,
            "buyer must hold the collateral NFT after fulfillment"
        );

        // Silence unused-var warning for the recordedHash captured at
        // the post call. We don't directly assert against it here
        // (the Phase-2b test already locked the hash-rederive
        // invariant); the storedAfter assertion above confirms the
        // diamond slot cleared, which is the load-bearing settlement
        // signal.
        recordedHash;
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
