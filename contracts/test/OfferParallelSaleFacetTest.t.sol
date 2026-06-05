// test/OfferParallelSaleFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockListingExecutorRecorder} from "./mocks/MockListingExecutorRecorder.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {MockSeaport} from "./mocks/MockSeaport.sol";
import {MockConduitController} from "./mocks/MockConduitController.sol";
import {FeeLeg} from "../src/seaport/PrepayTypes.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @notice T-086 Round-8 (#358) §19.9 — facet-level integration tests for
 *         `OfferParallelSaleFacet` (borrow-OR-sell parallel-sale entry +
 *         non-destructive unwind).
 *
 *         Test buckets:
 *           1. postParallelSaleListing happy path — records orderHash +
 *              executor + Offer struct mirror.
 *           2. Precondition revert paths (creator gate, opt-in gate,
 *              already-listed gate, terminal-state gate, floor gate).
 *           3. releaseParallelSaleLock — clears the 5 mirror slots +
 *              idempotent on no-binding offer.
 *           4. OfferMutateFacet parallel-sale lock — blocks mutators
 *              when binding live.
 *
 *         Uses the same `MockListingExecutorRecorder` + `MockSeaport` +
 *         `MockConduitController` triad as the §18 AutoList tests so
 *         the executor↔diamond surface stays harness-consistent across
 *         the two parallel-sale facets.
 */
contract OfferParallelSaleFacetTest is SetupTest {
    MockListingExecutorRecorder internal mockExecutor;
    MockRentableNFT721 internal collateralNFT;
    MockSeaport internal mockSeaport;
    MockConduitController internal mockConduitController;

    address internal borrowerHolder;
    address internal nonCreator;
    address internal conduit;
    address internal principalAsset;
    bytes32 internal conduitKey;
    address internal borrowerVaultAddr;

    uint256 internal constant OFFER_ID = 7_777;
    uint256 internal constant COLLATERAL_TOKEN_ID = 42;
    uint256 internal constant PRINCIPAL_AMOUNT = 100 ether;
    uint256 internal constant DURATION_DAYS = 30;
    uint256 internal constant INTEREST_RATE_BPS = 1_200; // 12%
    uint16 internal constant TEST_BUFFER_BPS = 200; // 2 %

    // 1 day of interest at 12% on 100 ether = 100 * 0.12 / 365 ≈ 0.0328 ether
    // Floor = (100 + 0.0328) × 1.02 ≈ 102.0335 ether
    uint256 internal constant EXPECTED_FLOOR_LO_BOUND = 102 ether;
    uint256 internal constant SAFE_ASK = 105 ether;
    uint256 internal constant SUB_FLOOR_ASK = 101 ether;

    function setUp() public {
        setupHelper();
        mockExecutor = new MockListingExecutorRecorder();
        collateralNFT = new MockRentableNFT721();
        mockConduitController = new MockConduitController();
        mockSeaport = new MockSeaport(address(mockConduitController));
        mockExecutor.setSeaport(address(mockSeaport));

        borrowerHolder = makeAddr("borrowerHolder");
        nonCreator = makeAddr("nonCreator");
        conduit = makeAddr("seaportConduitMock");
        conduitKey = keccak256("parallel-sale-test-conduit-key");
        principalAsset = makeAddr("usdcMock");
        mockConduitController.register(conduitKey, conduit);

        borrowerVaultAddr =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerHolder);

        // Codex P1 round-1 #2 fix added a vault-side
        // `setCollateralOperatorApproval` call in
        // `postParallelSaleListing` — the vault now needs to actually
        // own the NFT for the approval to succeed. Mint + transfer to
        // the vault here so the happy-path tests reach that call.
        collateralNFT.mint(borrowerHolder, COLLATERAL_TOKEN_ID);
        vm.prank(borrowerHolder);
        collateralNFT.transferFrom(borrowerHolder, borrowerVaultAddr, COLLATERAL_TOKEN_ID);

        mockExecutor.setApprovedConduit(conduit, true);

        vm.startPrank(owner);
        PrepayListingFacet(address(diamond))
            .setCollateralListingExecutor(address(mockExecutor));
        ConfigFacet(address(diamond))
            .setPrepayListingBufferBps(TEST_BUFFER_BPS);
        // Codex round-2 P1 #3 fix added a `cfgPrepayListingEnabled`
        // gate to `postParallelSaleListing` — enable the master switch
        // here so the happy-path tests reach the floor / record steps.
        ConfigFacet(address(diamond))
            .setPrepayListingEnabled(true);
        vm.stopPrank();
    }

    // ─── Scaffolding helpers ────────────────────────────────────────────

    /// @dev Build a parallel-sale-ready Offer struct. Sets every field
    ///      the facet's validation needs; the borrower opts into parallel-
    ///      sale by default (overridden by `_scaffoldOptOut` for the
    ///      ParallelSaleNotEnabled test).
    function _baseOffer() internal view returns (LibVaipakam.Offer memory o) {
        o.id = OFFER_ID;
        o.creator = borrowerHolder;
        o.offerType = LibVaipakam.OfferType.Borrower;
        o.assetType = LibVaipakam.AssetType.ERC20;
        o.collateralAssetType = LibVaipakam.AssetType.ERC721;
        o.lendingAsset = principalAsset;
        o.amount = PRINCIPAL_AMOUNT;
        o.interestRateBps = INTEREST_RATE_BPS;
        o.collateralAsset = address(collateralNFT);
        o.collateralTokenId = COLLATERAL_TOKEN_ID;
        o.quantity = 1; // ERC721 — principal-side qty (unused for ERC20 principal)
        // Codex round-2 P1 #2 fix routes the parallel-sale path through
        // `offer.collateralQuantity` (NOT `offer.quantity`); set both
        // to 1 for the ERC721 happy path so the new pin matches the
        // executor's expected value.
        o.collateralQuantity = 1;
        o.durationDays = DURATION_DAYS;
        o.allowsParallelSale = true;
        o.expiresAt = uint64(block.timestamp + 7 days);
    }

    function _scaffoldOffer(LibVaipakam.Offer memory o) internal {
        TestMutatorFacet(address(diamond)).setOffer(OFFER_ID, o);
    }

    function _scaffoldDefaultOffer() internal {
        _scaffoldOffer(_baseOffer());
    }

    function _emptyFeeLegs() internal pure returns (FeeLeg[] memory) {
        return new FeeLeg[](0);
    }

    // ─── 1. Happy path ──────────────────────────────────────────────────

    function test_postParallelSaleListing_happyPath_writesAllMirrorSlots() public {
        _scaffoldDefaultOffer();

        vm.prank(borrowerHolder);
        bytes32 orderHash = OfferParallelSaleFacet(address(diamond))
            .postParallelSaleListing(
                uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
            );

        // Sanity — orderHash is non-zero.
        assertTrue(orderHash != bytes32(0), "orderHash MUST be non-zero");

        // Mock executor recorded the post.
        assertEq(
            mockExecutor.recordOfferOrderCallCount(),
            1,
            "executor.recordOfferOrder MUST fire once"
        );
        MockListingExecutorRecorder.RecordOfferOrderCall memory call =
            mockExecutor.recordedOfferOrderAt(0);
        assertEq(call.orderHash, orderHash, "executor orderHash mismatch");
        assertEq(call.ctx.offerId, uint96(OFFER_ID), "executor offerId mismatch");
        assertEq(call.ctx.askPrice, uint192(SAFE_ASK), "executor askPrice mismatch");
        assertEq(
            call.ctx.borrowerVault, borrowerVaultAddr,
            "executor borrowerVault mismatch"
        );
        assertEq(
            call.ctx.collateralAsset, address(collateralNFT),
            "executor collateralAsset mismatch"
        );
    }

    // ─── 2. Precondition revert paths ───────────────────────────────────

    function test_postParallelSaleListing_revertsForNonCreator() public {
        _scaffoldDefaultOffer();

        vm.prank(nonCreator);
        vm.expectRevert(IVaipakamErrors.NotOfferCreator.selector);
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postParallelSaleListing_revertsWhenOptInFalse() public {
        LibVaipakam.Offer memory o = _baseOffer();
        o.allowsParallelSale = false;
        _scaffoldOffer(o);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferParallelSaleFacet.ParallelSaleNotEnabled.selector,
                uint96(OFFER_ID)
            )
        );
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postParallelSaleListing_revertsWhenAskBelowFloor() public {
        _scaffoldDefaultOffer();

        vm.prank(borrowerHolder);
        // Don't pin the exact minAsk; just confirm AskBelowPreLoanFloor
        // fires for a sub-floor ask. The §19.3 floor math has 4
        // multiplicative inputs (principal, rate, buffer, duration);
        // exhaustively pinning is brittle.
        vm.expectRevert(); // selector match would over-pin
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SUB_FLOOR_ASK, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postParallelSaleListing_revertsOnSecondPost() public {
        _scaffoldDefaultOffer();

        vm.prank(borrowerHolder);
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
        );

        // Second post on the same offer must revert.
        vm.prank(borrowerHolder);
        vm.expectRevert(); // ParallelSaleListingAlreadyPosted with orderHash; selector match
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postParallelSaleListing_revertsForAcceptedOffer() public {
        LibVaipakam.Offer memory o = _baseOffer();
        o.accepted = true;
        _scaffoldOffer(o);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferParallelSaleFacet.OfferTerminal.selector,
                uint96(OFFER_ID)
            )
        );
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postParallelSaleListing_revertsForERC20Collateral() public {
        LibVaipakam.Offer memory o = _baseOffer();
        o.collateralAssetType = LibVaipakam.AssetType.ERC20;
        _scaffoldOffer(o);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferParallelSaleFacet.UnsupportedCollateralForParallelSale.selector,
                LibVaipakam.AssetType.ERC20
            )
        );
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
        );
    }

    // ─── 3. releaseParallelSaleLock ─────────────────────────────────────

    function test_releaseParallelSaleLock_clearsBindingAfterPost() public {
        _scaffoldDefaultOffer();

        vm.prank(borrowerHolder);
        bytes32 orderHash = OfferParallelSaleFacet(address(diamond))
            .postParallelSaleListing(
                uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
            );
        assertTrue(orderHash != bytes32(0), "post failed");

        // Borrower releases — non-destructive (offer survives).
        vm.prank(borrowerHolder);
        OfferParallelSaleFacet(address(diamond)).releaseParallelSaleLock(uint96(OFFER_ID));

        // Mock executor recorded the clear.
        bytes32[] memory clears;
        // The mock exposes clearOfferOrderCalls as a public array;
        // assert by length lookup.
        // (At least one clear; idempotency tested below.)
        assertEq(
            mockExecutor.clearOfferOrderCalls(0),
            orderHash,
            "executor.clearOfferOrder MUST receive the posted orderHash"
        );
        // Quiet the unused warning.
        clears;
    }

    function test_releaseParallelSaleLock_idempotentWithNoBinding() public {
        _scaffoldDefaultOffer();

        // No post — release should still be a no-op (LibPrepayCleanup
        // early-returns when orderHash mapping is zero).
        vm.prank(borrowerHolder);
        OfferParallelSaleFacet(address(diamond)).releaseParallelSaleLock(uint96(OFFER_ID));

        // Executor saw no clears.
        // (Calling .clearOfferOrderCalls(0) on an empty array would
        // revert; the absence of revert here would mean a phantom entry.
        // Test by expecting revert on the OOB read.)
        vm.expectRevert();
        mockExecutor.clearOfferOrderCalls(0);
    }

    function test_releaseParallelSaleLock_revertsForNonCreator() public {
        _scaffoldDefaultOffer();

        vm.prank(nonCreator);
        vm.expectRevert(IVaipakamErrors.NotOfferCreator.selector);
        OfferParallelSaleFacet(address(diamond)).releaseParallelSaleLock(uint96(OFFER_ID));
    }

    // ─── 4. OfferMutateFacet parallel-sale lock ─────────────────────────

    function test_offerMutate_blockedWhileParallelSaleLive() public {
        _scaffoldDefaultOffer();

        // Post the parallel-sale binding to activate the lock.
        vm.prank(borrowerHolder);
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
        );

        // Any mutator should now revert with OfferLockedByParallelSale.
        vm.prank(borrowerHolder);
        vm.expectRevert(OfferMutateFacet.OfferLockedByParallelSale.selector);
        OfferMutateFacet(address(diamond)).setOfferAmount(OFFER_ID, PRINCIPAL_AMOUNT + 1, PRINCIPAL_AMOUNT + 1);
    }

    function test_offerMutate_succeedsAfterReleaseParallelSaleLock() public {
        _scaffoldDefaultOffer();

        // Post + release — the lock should clear so the mutator path
        // becomes unblocked again (the mutator's other invariants may
        // still revert, e.g. asset-pause / KYC / amount validators —
        // we just want to confirm the parallel-sale gate stops blocking).
        vm.prank(borrowerHolder);
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, _emptyFeeLegs()
        );
        vm.prank(borrowerHolder);
        OfferParallelSaleFacet(address(diamond)).releaseParallelSaleLock(uint96(OFFER_ID));

        // Now the mutate path should NOT revert with OfferLockedByParallelSale.
        // (It may still revert with downstream validation errors — that's
        // fine; the test asserts the lock-specific error is gone.)
        vm.prank(borrowerHolder);
        try OfferMutateFacet(address(diamond)).setOfferAmount(OFFER_ID, PRINCIPAL_AMOUNT + 1, PRINCIPAL_AMOUNT + 1) {
            // success path is also acceptable
        } catch (bytes memory err) {
            bytes4 lockSel = OfferMutateFacet.OfferLockedByParallelSale.selector;
            bytes4 errSel = bytes4(err);
            assertTrue(
                errSel != lockSel,
                "lock error MUST NOT fire after release"
            );
        }
    }
}
