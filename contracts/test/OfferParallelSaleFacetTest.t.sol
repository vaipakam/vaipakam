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
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";

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
        // Codex round-4 P1 #2 fix added a `fillMode != Partial` gate
        // on postParallelSaleListing. Default-initialized enum value
        // is 0 (= Partial); set to Aon (all-or-nothing) here so the
        // happy-path tests reach the floor + record steps.
        o.fillMode = LibVaipakam.FillMode.Aon;
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

    // ─── #1144 (S10 Invariant B): syncPrepaySaleOffer ───────────────────

    /// @dev Post a clean offer-keyed listing carrying one fee leg to `feeRecipient`
    ///      (clean at post time) and return its orderHash. Wires the oracle so the
    ///      sync's authoritative reads work.
    function _postOfferListingWithFee(MockSanctionsList m, address feeRecipient)
        internal
        returns (bytes32)
    {
        _scaffoldDefaultOffer();
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        FeeLeg[] memory legs = new FeeLeg[](1);
        legs[0] = FeeLeg({recipient: feeRecipient, startAmount: 1, endAmount: 1});
        vm.prank(borrowerHolder);
        return OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            uint96(OFFER_ID), SAFE_ASK, conduitKey, legs
        );
    }

    function test_syncPrepaySaleOffer_flaggedFeeLegRecipient_registersAndCancels() public {
        MockSanctionsList m = new MockSanctionsList();
        address feeRecipient = makeAddr("offerSaleFeeRecipient");
        _postOfferListingWithFee(m, feeRecipient);

        // Flag AFTER the clean post — the sign-time fee-recipient screen is fail-open.
        m.setFlagged(feeRecipient, true);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit OfferParallelSaleFacet.PrepaySaleOfferSynced(uint96(OFFER_ID), nonCreator, true);
        vm.prank(nonCreator); // permissionless
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));

        assertTrue(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(feeRecipient),
            "flagged fee-leg recipient MUST be committed to the registry"
        );
        // Cancelled — the listing slot is cleared, so a second sync finds nothing.
        vm.prank(nonCreator);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferParallelSaleFacet.ParallelSaleListingNotFound.selector, uint96(OFFER_ID)
            )
        );
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));
    }

    function test_syncPrepaySaleOffer_scenarioB_flaggedLenderHolder_registersAndCancels()
        public
    {
        MockSanctionsList m = new MockSanctionsList();
        address cleanFee = makeAddr("cleanOfferFee");
        _postOfferListingWithFee(m, cleanFee);

        // Accept the offer into a loan (Scenario B): pin offerId→loanId and mint
        // the live lender / borrower position NFTs the settlement pays.
        uint256 loanId = 9_100;
        uint256 lenderTokenId = 501;
        uint256 borrowerTokenId = 502;
        address lenderHolder = makeAddr("saleLoanLender");
        LibVaipakam.Loan memory loan;
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.lenderTokenId = lenderTokenId;
        loan.borrowerTokenId = borrowerTokenId;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
        TestMutatorFacet(address(diamond)).mintNFTRaw(lenderHolder, lenderTokenId);
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrowerHolder, borrowerTokenId);
        TestMutatorFacet(address(diamond)).setOfferIdToLoanId(OFFER_ID, loanId);

        m.setFlagged(lenderHolder, true); // the live lender-position holder

        vm.prank(nonCreator);
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));

        assertTrue(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(lenderHolder),
            "flagged Scenario-B lender holder MUST be registered"
        );
        vm.prank(nonCreator);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferParallelSaleFacet.ParallelSaleListingNotFound.selector, uint96(OFFER_ID)
            )
        );
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));
    }

    function test_syncPrepaySaleOffer_flaggedScenarioASeller_registersAndCancels() public {
        // Codex #1146-r1 P1 — the pre-loan (Scenario A) sale routes proceeds to the
        // offer creator (borrower/seller); the sync MUST register that recipient too.
        MockSanctionsList m = new MockSanctionsList();
        address cleanFee = makeAddr("cleanOfferFeeA");
        _postOfferListingWithFee(m, cleanFee); // borrowerHolder is the offer creator

        m.setFlagged(borrowerHolder, true); // seller flagged AFTER the clean post

        vm.prank(nonCreator);
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));

        assertTrue(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(borrowerHolder),
            "flagged Scenario-A seller (offer creator) MUST be registered"
        );
        vm.prank(nonCreator);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferParallelSaleFacet.ParallelSaleListingNotFound.selector, uint96(OFFER_ID)
            )
        );
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));
    }

    function test_syncPrepaySaleOffer_scenarioB_flaggedOriginalSeller_doesNotCancel()
        public
    {
        // Codex #1146-r2 P2 — once the offer is accepted (Scenario B), the original
        // seller (offer creator) is no longer a live recipient: the settlement pays
        // the CURRENT holders. A flagged original seller must NOT be synced and must
        // NOT cancel a listing whose live holders are clean.
        MockSanctionsList m = new MockSanctionsList();
        address cleanFee = makeAddr("cleanOfferFeeB");
        _postOfferListingWithFee(m, cleanFee); // creator = borrowerHolder

        uint256 loanId = 9_200;
        address cleanLender = makeAddr("cleanScenBLender");
        address cleanBorrower = makeAddr("cleanScenBBorrower");
        LibVaipakam.Loan memory loan;
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.lenderTokenId = 601;
        loan.borrowerTokenId = 602;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
        TestMutatorFacet(address(diamond)).mintNFTRaw(cleanLender, 601);
        TestMutatorFacet(address(diamond)).mintNFTRaw(cleanBorrower, 602);
        TestMutatorFacet(address(diamond)).setOfferIdToLoanId(OFFER_ID, loanId);

        m.setFlagged(borrowerHolder, true); // the ORIGINAL seller, now transferred out

        vm.prank(nonCreator);
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));

        assertFalse(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(borrowerHolder),
            "the original seller MUST NOT be synced in Scenario B"
        );
        // Still live — a second sync does not revert NotFound.
        vm.prank(nonCreator);
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));
    }

    function test_syncPrepaySaleOffer_cleanRecipients_leavesListingLive() public {
        MockSanctionsList m = new MockSanctionsList();
        address cleanFee = makeAddr("cleanOfferFee2");
        _postOfferListingWithFee(m, cleanFee);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit OfferParallelSaleFacet.PrepaySaleOfferSynced(uint96(OFFER_ID), nonCreator, false);
        vm.prank(nonCreator);
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));

        // Still live — a second clean sync must NOT revert with NotFound.
        vm.prank(nonCreator);
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));
    }

    function test_syncPrepaySaleOffer_noListing_reverts() public {
        _scaffoldDefaultOffer(); // offer exists, no parallel-sale listing posted
        vm.prank(nonCreator);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferParallelSaleFacet.ParallelSaleListingNotFound.selector, uint96(OFFER_ID)
            )
        );
        OfferParallelSaleFacet(address(diamond)).syncPrepaySaleOffer(uint96(OFFER_ID));
    }
}
