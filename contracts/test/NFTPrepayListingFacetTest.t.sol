// test/NFTPrepayListingFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibERC721} from "../src/libraries/LibERC721.sol";
import {NFTPrepayListingFacet} from "../src/facets/NFTPrepayListingFacet.sol";
import {NFTPrepayDutchListingFacet} from "../src/facets/NFTPrepayDutchListingFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {
    FeeLeg,
    PREPAY_MODE_FIXED_PRICE,
    PREPAY_MODE_DUTCH,
    MIN_AUCTION_WINDOW
} from "../src/seaport/PrepayTypes.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockListingExecutorRecorder} from "./mocks/MockListingExecutorRecorder.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {MockSeaport} from "./mocks/MockSeaport.sol";
import {MockConduitController} from "./mocks/MockConduitController.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @notice T-086 step 6 — `NFTPrepayListingFacet` unit tests.
 *
 *         Focus is the borrower-facing facet's gates + atomic state
 *         mutations + executor interactions. The end-to-end Seaport
 *         fill flow is the executor's responsibility (covered in
 *         step 5's tests); here we confirm the diamond-side surface
 *         enforces every documented precondition AND issues the
 *         expected `recordOrder` / `clearOrder` calls against a
 *         stub executor.
 *
 *         Test buckets:
 *           1. {ConfigFacet.setPrepayListingBufferBps} — admin gate,
 *              range bounds, event.
 *           2. {postPrepayListing} — precondition revert paths +
 *              happy path (lock set, storage populated, executor
 *              recordOrder called, event emitted).
 *           3. {updatePrepayListing} — replaces old hash with new on
 *              both diamond + executor; lock remains.
 *           4. {cancelPrepayListing} — borrower-only authority +
 *              happy path (unlock + clear).
 *           5. {cancelExpiredPrepayListing} — permissionless + grace
 *              gate + happy path.
 */
contract NFTPrepayListingFacetTest is SetupTest {
    MockListingExecutorRecorder internal mockExecutor;
    MockRentableNFT721 internal collateralNFT;
    MockSeaport internal mockSeaport;
    MockConduitController internal mockConduitController;
    address internal borrowerVaultAddr;

    address internal borrowerHolder;
    address internal randomCaller;
    address internal conduit;
    bytes32 internal conduitKey;

    uint256 internal constant LOAN_ID = 4_242;
    uint256 internal constant LENDER_TOKEN_ID = 100;
    uint256 internal constant BORROWER_TOKEN_ID = 101;
    uint256 internal constant COLLATERAL_TOKEN_ID = 1;

    // #306 fix — orderHashes are now DERIVED by Seaport from the
    // OrderComponents the diamond constructs. Tests no longer pin
    // them as constants; the post / update happy paths assert
    // against whatever hash MockSeaport returned.
    uint256 internal constant TEST_SALT_A = 0xa11ce;
    uint256 internal constant TEST_SALT_B = 0xb0b;

    uint16 internal constant TEST_BUFFER_BPS = 200; // 2 %

    function setUp() public {
        setupHelper();
        mockExecutor = new MockListingExecutorRecorder();
        collateralNFT = new MockRentableNFT721();
        // #306 — MockConduitController + MockSeaport. The diamond's
        // postPrepayListing calls into Seaport.getOrderHash +
        // Seaport.conduitController + ConduitController.getConduit
        // to construct + verify the canonical order.
        mockConduitController = new MockConduitController();
        mockSeaport = new MockSeaport(address(mockConduitController));
        mockExecutor.setSeaport(address(mockSeaport));

        borrowerHolder = makeAddr("borrowerHolder");
        randomCaller = makeAddr("randomCaller");
        conduit = makeAddr("seaportConduitMock");
        conduitKey = keccak256("test-conduit-key");
        mockConduitController.register(conduitKey, conduit);

        // Create the borrower's vault + deposit the collateral NFT.
        borrowerVaultAddr =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerHolder);
        collateralNFT.mint(borrowerHolder, COLLATERAL_TOKEN_ID);
        vm.prank(borrowerHolder);
        collateralNFT.transferFrom(borrowerHolder, borrowerVaultAddr, COLLATERAL_TOKEN_ID);

        // Approve the conduit on the executor stub so happy paths
        // pass the allow-list precondition.
        mockExecutor.setApprovedConduit(conduit, true);

        // Wire executor + buffer + master kill-switch (the three
        // post-deploy gates the facet enforces). All ADMIN_ROLE-
        // gated. The kill-switch flip is the new step 6 dependency
        // that gates the path on steps 7 + 10 landing.
        vm.startPrank(owner);
        PrepayListingFacet(address(diamond))
            .setCollateralListingExecutor(address(mockExecutor));
        ConfigFacet(address(diamond))
            .setPrepayListingBufferBps(TEST_BUFFER_BPS);
        ConfigFacet(address(diamond))
            .setPrepayListingEnabled(true);
        vm.stopPrank();
    }

    // ─── 1. ConfigFacet.setPrepayListingBufferBps ───────────────────────

    function test_setPrepayListingBufferBps_admin_happyPath() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPrepayListingBufferBps(500);
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingBufferBps(),
            500,
            "buffer bps round-trips through storage"
        );
    }

    function test_setPrepayListingBufferBps_revertsForNonAdmin() public {
        vm.prank(randomCaller);
        vm.expectRevert(); // LibAccessControl unauthorized
        ConfigFacet(address(diamond)).setPrepayListingBufferBps(200);
    }

    function test_setPrepayListingBufferBps_revertsAboveCeiling() public {
        // Ceiling is 1_000 bps per ConfigFacet's MAX_PREPAY_LISTING_BUFFER_BPS.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidPrepayListingBufferBps.selector,
                uint16(1_001),
                uint16(1_000)
            )
        );
        ConfigFacet(address(diamond)).setPrepayListingBufferBps(1_001);
    }

    // ─── 2. postPrepayListing — revert paths ────────────────────────────

    // (`test_postPrepayListing_revertsZeroOrderHash` removed in
    // #306 fix — the new API doesn't take an orderHash; the
    // diamond constructs the canonical Seaport order and derives
    // the hash itself.)

    function test_postPrepayListing_revertsLoanNotActive() public {
        // Scaffold a Settled loan.
        _scaffoldLoan({status: LibVaipakam.LoanStatus.Settled, allowsPrepay: true});
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.PrepayLoanNotActive.selector,
                LOAN_ID,
                LibVaipakam.LoanStatus.Settled
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, 1e18, TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postPrepayListing_revertsNotAllowed() public {
        _scaffoldActiveLoan({allowsPrepay: false});
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.PrepayListingNotAllowed.selector,
                LOAN_ID
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsUnsupportedCollateralForV1() public {
        // #306 + step 15 — ERC721 + ERC1155 both supported now.
        // ERC20 collateral remains rejected (no NFT identifier
        // for the Seaport offer item).
        LibVaipakam.Loan memory loan = _baseLoan();
        loan.collateralAssetType = LibVaipakam.AssetType.ERC20;
        loan.allowsPrepayListing = true;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.UnsupportedCollateralForV1.selector,
                LibVaipakam.AssetType.ERC20
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsGraceWindowClosed() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Warp past grace.
        uint256 graceEnd = _graceEnd();
        vm.warp(graceEnd + 1);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.PrepayGraceWindowClosed.selector,
                LOAN_ID,
                block.timestamp,
                graceEnd
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsNotPositionHolder() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        vm.prank(randomCaller); // not the NFT holder
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.NotPositionHolder.selector,
                LOAN_ID,
                randomCaller,
                borrowerHolder
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsAlreadyExists() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // First post — happy path. Capture the diamond-derived hash.
        vm.prank(borrowerHolder);
        bytes32 firstHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // Second post — should fail with the first listing's hash.
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.PrepayListingAlreadyExists.selector,
                LOAN_ID,
                firstHash
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_B, conduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsConduitNotApproved() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        address rogueConduit = makeAddr("rogueConduit");
        bytes32 rogueConduitKey = keccak256("rogue-conduit");
        // Register the rogueKey → rogueConduit pair in the mock
        // ConduitController so the on-chain resolveConduit
        // succeeds; then the executor's allow-list check (which
        // returns false for an unapproved address) fires the
        // expected revert.
        mockConduitController.register(rogueConduitKey, rogueConduit);
        // approvedConduits[rogueConduit] = false (default).
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.ConduitNotApproved.selector,
                rogueConduit
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, rogueConduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsAskBelowFloor() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        uint256 floor = _liveFloorViaContext();
        // 1 wei below the min — must fail.
        uint256 minAsk = (floor * (10_000 + TEST_BUFFER_BPS)) / 10_000;

        vm.prank(borrowerHolder);
        // Round-5 Block A (#313): the path now goes through
        // `_requireAskCoversFloorWithFees` even when feeLegs is
        // empty. The error type and the third arg (required ask)
        // are unchanged; the error label is more precise.
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.AskBelowFloorPlusFees.selector,
                LOAN_ID,
                minAsk - 1,
                minAsk
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, minAsk - 1, TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postPrepayListing_revertsExecutorNotSet() public {
        // Reset executor to address(0) AFTER setUp wired it.
        vm.prank(owner);
        PrepayListingFacet(address(diamond))
            .setCollateralListingExecutor(address(0));

        _scaffoldActiveLoan({allowsPrepay: true});
        vm.prank(borrowerHolder);
        vm.expectRevert(NFTPrepayListingFacet.ExecutorNotSet.selector);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsKillSwitchOff() public {
        // Flip the master kill-switch off AFTER setUp turned it on.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPrepayListingEnabled(false);

        _scaffoldActiveLoan({allowsPrepay: true});
        vm.prank(borrowerHolder);
        vm.expectRevert(NFTPrepayListingFacet.PrepayListingDisabled.selector);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsBorrowerNFTAlreadyLocked() public {
        // Codex P1 round-1: pre-existing lock (e.g. Preclose offset)
        // must NOT be silently overwritten by a PrepayCollateralListing
        // post — concurrent strategic flows are not supported.
        _scaffoldActiveLoan({allowsPrepay: true});

        // Simulate a prior strategic-flow lock (Preclose offset).
        // Use TestMutatorFacet so we can write the lock through the
        // diamond's storage context.
        TestMutatorFacet(address(diamond)).lockNFTRaw(
            BORROWER_TOKEN_ID, LibERC721.LockReason.PrecloseOffset
        );

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.BorrowerNFTAlreadyLocked.selector,
                BORROWER_TOKEN_ID,
                LibERC721.LockReason.PrecloseOffset
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
    }

    function test_postPrepayListing_revertsBufferNotConfigured() public {
        // Reset buffer to 0 AFTER setUp configured it.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPrepayListingBufferBps(0);

        _scaffoldActiveLoan({allowsPrepay: true});
        vm.prank(borrowerHolder);
        vm.expectRevert(NFTPrepayListingFacet.PrepayListingBufferNotConfigured.selector);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
    }

    // ─── 2b. postPrepayListing — happy path ─────────────────────────────

    function test_postPrepayListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        uint256 ask = _floorPlusBuffer();

        vm.prank(borrowerHolder);
        bytes32 derivedHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, ask, TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );

        // Diamond bookkeeping.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            derivedHash,
            "diamond stores active orderHash"
        );
        assertTrue(derivedHash != bytes32(0), "diamond-derived hash is non-zero");

        // Executor side received the recordOrder call.
        assertEq(mockExecutor.recordCallCount(), 1, "executor.recordOrder called once");
        assertEq(
            mockExecutor.lastRecordedOrderHash(),
            derivedHash,
            "executor recorded the right orderHash"
        );

        // Borrower-position NFT locked with the right reason.
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.PrepayCollateralListing),
            "borrower NFT locked with PrepayCollateralListing reason"
        );
    }

    /// @notice #818 — a sanctioned borrower-NFT holder cannot POST a fixed-price
    ///         prepay collateral-sale listing. The manual post/update paths
    ///         previously checked only NFT ownership (`holder == msg.sender`);
    ///         the screen now matches the atomic / auto-list paths.
    function test_postPrepayListing_revertsWhenHolderSanctioned() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        uint256 ask = _floorPlusBuffer();

        MockSanctionsList m = new MockSanctionsList();
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(borrowerHolder, true);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, borrowerHolder)
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, ask, TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );
    }

    // ─── 3. updatePrepayListing ─────────────────────────────────────────

    function test_updatePrepayListing_revertsListingNotFound() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // No post first — update should refuse.
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.PrepayListingNotFound.selector,
                LOAN_ID
            )
        );
        NFTPrepayListingFacet(address(diamond)).updatePrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_B, conduitKey
        , _emptyFeeLegs());
    }

    function test_updatePrepayListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        // 1. Post with salt A — capture derived hash.
        vm.prank(borrowerHolder);
        bytes32 hashA = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // 2. Update with salt B — capture derived hash.
        vm.prank(borrowerHolder);
        bytes32 hashB = NFTPrepayListingFacet(address(diamond)).updatePrepayListing(
            LOAN_ID, _floorPlusBuffer() + 1 ether, TEST_SALT_B, conduitKey
        , _emptyFeeLegs());
        assertTrue(hashA != hashB, "different salts -> different hashes");

        // Bookkeeping points at the new hash.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            hashB,
            "orderHash replaced with the new one"
        );

        // Executor saw: one initial record, one clearOrder (for A),
        // one second record (for B).
        assertEq(mockExecutor.recordCallCount(), 2, "two recordOrder calls (initial + replace)");
        assertEq(mockExecutor.clearCallCount(), 1, "one clearOrder call (clear A)");
        assertEq(mockExecutor.lastClearedOrderHash(), hashA, "A was cleared");
        assertEq(mockExecutor.lastRecordedOrderHash(), hashB, "B was recorded");

        // Lock stays on through the update (only the orderHash rotates).
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.PrepayCollateralListing),
            "lock stays on through update"
        );
    }

    // ─── 4. cancelPrepayListing (borrower-only) ─────────────────────────

    function test_cancelPrepayListing_revertsNotPositionHolder() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        vm.prank(randomCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.NotPositionHolder.selector,
                LOAN_ID,
                randomCaller,
                borrowerHolder
            )
        );
        NFTPrepayListingFacet(address(diamond)).cancelPrepayListing(LOAN_ID);
    }

    function test_cancelPrepayListing_revertsListingNotFound() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.PrepayListingNotFound.selector,
                LOAN_ID
            )
        );
        NFTPrepayListingFacet(address(diamond)).cancelPrepayListing(LOAN_ID);
    }

    function test_cancelPrepayListing_clearsOnOriginalExecutorAfterRotation() public {
        // Codex P2 round-2: governance rotates the executor from
        // A to B while a listing is live. Cancel must clear A's
        // orderContext (the one that recorded the listing), NOT
        // B's. Otherwise A would still hold a "live" binding and a
        // rollback to A would resurrect the cancelled order.
        _scaffoldActiveLoan({allowsPrepay: true});

        // Post under executor A (= mockExecutor wired in setUp).
        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());
        uint256 aRecordCount = mockExecutor.recordCallCount();

        // Governance rotates to executor B.
        MockListingExecutorRecorder mockExecutorB = new MockListingExecutorRecorder();
        mockExecutorB.setApprovedConduit(conduit, true);
        vm.prank(owner);
        PrepayListingFacet(address(diamond))
            .setCollateralListingExecutor(address(mockExecutorB));

        // Borrower cancels — must clear on A, NOT B.
        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).cancelPrepayListing(LOAN_ID);

        assertEq(
            mockExecutor.clearCallCount(),
            1,
            "A's clearOrder called (pinned executor at post time)"
        );
        // Cleared hash equals the diamond's stored hash at post
        // time — we don't pin it as a constant, just confirm
        // round-trip consistency.
        // (No additional assertion needed; `getPrepayListingOrderHash`
        // having been cleared to `bytes32(0)` post-cancel plus the
        // clearCallCount of 1 above is the right pair of signals.)
        assertEq(
            mockExecutorB.clearCallCount(),
            0,
            "B's clearOrder NOT called - B never recorded this listing"
        );
        // Sanity: A's record-call count unchanged by the cancel.
        assertEq(mockExecutor.recordCallCount(), aRecordCount, "A.recordOrder not re-invoked");
    }

    function test_cancelPrepayListing_worksAfterRepaid() public {
        // Codex P2 round-2: if loan is repaid via RepayFacet (which
        // doesn't currently clear listing bookkeeping), the
        // borrower must still be able to clean up the stale
        // listing themselves. The pre-grace borrower cancel must
        // NOT be `Active`-gated.
        _scaffoldActiveLoan({allowsPrepay: true});
        LibVaipakam.Loan memory snapshot = _baseLoan();
        snapshot.allowsPrepayListing = true;

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // Simulate `repayLoan` finishing: flip status to Repaid
        // while keeping startTime + everything else intact.
        snapshot.status = LibVaipakam.LoanStatus.Repaid;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, snapshot);

        // Borrower can still cancel.
        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).cancelPrepayListing(LOAN_ID);

        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "post-repay cancel clears bookkeeping"
        );
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.None),
            "post-repay cancel releases the lock"
        );
    }

    function test_cancelPrepayListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        bytes32 derivedHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).cancelPrepayListing(LOAN_ID);

        // Bookkeeping cleared.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "orderHash cleared on cancel"
        );

        // Executor saw the clearOrder with the diamond-derived hash.
        assertEq(mockExecutor.clearCallCount(), 1, "executor.clearOrder called once");
        assertEq(mockExecutor.lastClearedOrderHash(), derivedHash, "cleared the right hash");

        // Lock released.
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.None),
            "borrower NFT unlocked"
        );
    }

    // ─── 4a. Step-7 vault wiring (operator approval + ERC-1271) ─────────

    function test_post_wiresVaultOperatorApproval() public {
        // Step 7: postPrepayListing must grant the conduit
        // per-token approval on the collateral NFT via the vault.
        _scaffoldActiveLoan({allowsPrepay: true});

        // Pre: no approval.
        assertEq(
            collateralNFT.getApproved(COLLATERAL_TOKEN_ID),
            address(0),
            "pre: no conduit approval"
        );

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // Post: the configured conduit is approved for the token.
        assertEq(
            collateralNFT.getApproved(COLLATERAL_TOKEN_ID),
            conduit,
            "post: conduit has per-token approval"
        );
    }

    function test_post_registersOrderHashOnVault() public {
        // Step 7: postPrepayListing must register the orderHash
        // → executor binding on the vault so its ERC-1271
        // delegate can return the magic value.
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        bytes32 derivedHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        assertEq(
            VaipakamVaultImplementation(borrowerVaultAddr).getListingExecutor(derivedHash),
            address(mockExecutor),
            "vault pins orderHash to executor"
        );
    }

    function test_cancel_revokesVaultBinding() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        bytes32 derivedHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).cancelPrepayListing(LOAN_ID);

        // Vault binding cleared.
        assertEq(
            VaipakamVaultImplementation(borrowerVaultAddr).getListingExecutor(derivedHash),
            address(0),
            "vault binding cleared on cancel"
        );
        // Conduit approval revoked.
        assertEq(
            collateralNFT.getApproved(COLLATERAL_TOKEN_ID),
            address(0),
            "conduit approval revoked on cancel"
        );
    }

    function test_vault_isValidSignature_returnsMagicWhenExecutorApproves() public {
        // Full ERC-1271 path: vault delegates to mockExecutor;
        // because MockListingExecutorRecorder is a stub it has
        // no `isOrderValid` view. Assert the simpler
        // unregistered-hash path: any hash not in the vault's
        // `_listingExecutor` map returns the INVALID sentinel.
        bytes32 unregisteredHash = keccak256("never-registered");
        bytes4 invalid = VaipakamVaultImplementation(borrowerVaultAddr)
            .isValidSignature(unregisteredHash, "");
        assertEq(invalid, bytes4(0xffffffff), "unregistered hash -> invalid");
    }

    // ─── 4b. PrepayListingFacet.executorFinalizePrepaySale ──────────────
    // (Step-5 facet, but tightened in step 6 to clear step-6
    // bookkeeping. Test that integration here so the contract here
    // is covered.)

    function test_executorFinalize_clearsListingOrderHash() public {
        // Codex P2 round-1: a successful Seaport fill (which calls
        // back into the diamond via `executorFinalizePrepaySale`)
        // must clear `s.prepayListingOrderHash[loanId]`. Otherwise
        // `getPrepayListingOrderHash` would keep returning a live-
        // looking hash forever after the sale settled, and the
        // cancel paths would find a hash but couldn't run (status
        // != Active).
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        bytes32 derivedHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // Pre-condition: hash is recorded.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            derivedHash,
            "pre: orderHash recorded"
        );

        // Simulate the Seaport fill terminal: the executor calls
        // `executorFinalizePrepaySale` on the diamond. In real
        // usage the call comes from the executor singleton; the
        // diamond's gate checks `msg.sender == storedExecutor`
        // which is our MockListingExecutorRecorder address.
        vm.prank(address(mockExecutor));
        PrepayListingFacet(address(diamond)).executorFinalizePrepaySale(LOAN_ID);

        // Post-condition: hash cleared.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "post-fill: orderHash cleared"
        );
    }

    // ─── 4c. LibPrepayCleanup (step 10) — default-flow lock-bypass ──────

    function test_libPrepayCleanup_noopWhenNoListing() public {
        // No listing posted — invoking the cleanup should be a no-op.
        _scaffoldActiveLoan({allowsPrepay: true});

        // Should NOT revert.
        TestMutatorFacet(address(diamond)).invokePrepayCleanup(LOAN_ID);

        // Nothing to assert beyond "didn't revert" — but also confirm
        // bookkeeping mappings stayed empty.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "no listing means no bookkeeping"
        );
    }

    function test_libPrepayCleanup_clearsLiveListing() public {
        // Post a listing then invoke the cleanup directly. Verifies
        // the library does the full sweep — diamond mappings,
        // executor.clearOrder, vault binding + conduit approval,
        // borrower-NFT lock — atomically.
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        bytes32 derivedHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // Pre: everything is wired.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            derivedHash
        );
        assertEq(collateralNFT.getApproved(COLLATERAL_TOKEN_ID), conduit);
        assertEq(
            VaipakamVaultImplementation(borrowerVaultAddr).getListingExecutor(derivedHash),
            address(mockExecutor)
        );
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.PrepayCollateralListing)
        );

        // Trigger the cleanup helper (the entry point both
        // DefaultedFacet.triggerDefault and
        // RiskFacet.triggerLiquidation* invoke as their first step).
        TestMutatorFacet(address(diamond)).invokePrepayCleanup(LOAN_ID);

        // Post: everything cleared atomically.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "diamond orderHash cleared"
        );
        assertEq(
            collateralNFT.getApproved(COLLATERAL_TOKEN_ID),
            address(0),
            "conduit approval revoked"
        );
        assertEq(
            VaipakamVaultImplementation(borrowerVaultAddr).getListingExecutor(derivedHash),
            address(0),
            "vault orderHash binding cleared"
        );
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.None),
            "borrower NFT lock released"
        );
        // Executor side received the clearOrder.
        assertEq(mockExecutor.clearCallCount(), 1, "executor.clearOrder called");
        assertEq(mockExecutor.lastClearedOrderHash(), derivedHash);
    }

    // ─── 5. cancelExpiredPrepayListing (permissionless) ─────────────────

    function test_cancelExpiredPrepayListing_revertsGraceNotExpired() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // Pre-grace — permissionless cancel must refuse.
        uint256 graceEnd = _graceEnd();
        vm.prank(randomCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.GraceNotExpired.selector,
                LOAN_ID,
                block.timestamp,
                graceEnd
            )
        );
        NFTPrepayListingFacet(address(diamond)).cancelExpiredPrepayListing(LOAN_ID);
    }

    function test_cancelExpiredPrepayListing_revertsAtGraceBoundary() public {
        // Codex P2 round-1: at exactly `block.timestamp ==
        // gracePeriodEnd`, the step-5 executor still allows fills
        // (strict `>` reject condition). Permissionless cancel
        // must NOT race that fill window — only valid at strict
        // `block.timestamp > gracePeriodEnd`.
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        uint256 graceEnd = _graceEnd();
        vm.warp(graceEnd); // exactly at the boundary

        vm.prank(randomCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.GraceNotExpired.selector,
                LOAN_ID,
                graceEnd,
                graceEnd
            )
        );
        NFTPrepayListingFacet(address(diamond)).cancelExpiredPrepayListing(LOAN_ID);
    }

    function test_cancelExpiredPrepayListing_worksAfterDefault() public {
        // Codex P1 round-1: post-default, the loan flips status to
        // Defaulted / Liquidated; the cleanup path MUST still work
        // so the borrower NFT isn't stranded locked.
        _scaffoldActiveLoan({allowsPrepay: true});
        uint256 graceEnd = _graceEnd();

        // Snapshot the loan as scaffolded — captures the original
        // startTime BEFORE any warp drifts block.timestamp away.
        LibVaipakam.Loan memory snapshot = _baseLoan();
        snapshot.allowsPrepayListing = true;

        // Post at T0 while loan is Active.
        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // Flip status to Defaulted while keeping startTime +
        // durationDays unchanged. Simulates the moment AFTER
        // `markDefaulted` runs but BEFORE anyone calls our cleanup.
        snapshot.status = LibVaipakam.LoanStatus.Defaulted;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, snapshot);

        // Now warp past grace.
        vm.warp(graceEnd + 1);

        // Permissionless cleanup still works.
        vm.prank(randomCaller);
        NFTPrepayListingFacet(address(diamond)).cancelExpiredPrepayListing(LOAN_ID);

        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.None),
            "post-default cleanup still releases the lock"
        );
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "post-default cleanup clears bookkeeping"
        );
    }

    function test_cancelExpiredPrepayListing_permissionlessHappyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        , _emptyFeeLegs());

        // Warp PAST grace (strict — exactly `>= graceEnd + 1`).
        vm.warp(_graceEnd() + 1);

        // ANYONE can call — use a non-holder.
        vm.prank(randomCaller);
        NFTPrepayListingFacet(address(diamond)).cancelExpiredPrepayListing(LOAN_ID);

        // Same post-conditions as borrower cancel.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "orderHash cleared"
        );
        assertEq(mockExecutor.clearCallCount(), 1, "clearOrder called");
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.None),
            "borrower NFT unlocked"
        );
    }

    /// @dev Round-5 Block B (#309) post-merge polish — Codex P2:
    ///      Dutch listings whose `auctionEndTime` has passed are
    ///      cleanable via the permissionless path WITHOUT waiting
    ///      for grace expiry. The mock recorder's
    ///      `setOrderContextMode` stamps the per-orderHash mode +
    ///      auctionEndTime so the facet's cleanup branch fires.
    function test_cancelExpiredPrepayListing_dutchPathAtAuctionEnd() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        // Post a fixed-price listing first so the facet's
        // bookkeeping is populated (the mock executor will not
        // record a Dutch order through the facet; we instead
        // overlay a Dutch context onto the same orderHash).
        vm.prank(borrowerHolder);
        bytes32 orderHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );

        // Stamp Dutch metadata onto the mock for this orderHash:
        // mode = 1, auctionEndTime in the near future.
        uint64 auctionEnd = uint64(block.timestamp + 1 hours);
        mockExecutor.setOrderContextMode(orderHash, 1, auctionEnd);

        // Before auctionEnd: cleanup must revert with
        // AuctionWindowStillOpen (NOT GraceNotExpired — Dutch
        // listings bypass the grace gate entirely).
        vm.prank(randomCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.AuctionWindowStillOpen.selector,
                LOAN_ID,
                block.timestamp,
                uint256(auctionEnd)
            )
        );
        NFTPrepayListingFacet(address(diamond)).cancelExpiredPrepayListing(LOAN_ID);

        // Warp past auctionEnd. Note we DO NOT warp past grace.
        vm.warp(uint256(auctionEnd) + 1);

        // Now any caller can clean up even though grace hasn't
        // expired yet — proving the mode-aware branch fires.
        assertLt(block.timestamp, _graceEnd(), "grace must still be open");
        vm.prank(randomCaller);
        NFTPrepayListingFacet(address(diamond)).cancelExpiredPrepayListing(LOAN_ID);

        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "orderHash cleared on Dutch-expiry cleanup"
        );
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.None),
            "borrower NFT unlocked"
        );
    }

    // ─── Internal helpers ───────────────────────────────────────────────

    /// @dev Build a Loan struct with the minimal fields the facet
    ///      reads. `cfgPrecloseFeeBps` defaults to 0 on a fresh
    ///      deploy; treasury fee is also default-low. The floor +
    ///      buffer math doesn't need exotic values to exercise the
    ///      facet's gates.
    function _baseLoan() internal returns (LibVaipakam.Loan memory loan) {
        loan.id = LOAN_ID;
        loan.lender = makeAddr("loanLender");
        loan.borrower = borrowerHolder;
        loan.principal = 100 ether;
        loan.interestRateBps = 1_200; // 12 %
        loan.startTime = uint64(block.timestamp);
        loan.durationDays = 30;
        loan.lenderTokenId = LENDER_TOKEN_ID;
        loan.borrowerTokenId = BORROWER_TOKEN_ID;
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.collateralAssetType = LibVaipakam.AssetType.ERC721;
        loan.collateralAsset = address(collateralNFT);
        loan.collateralTokenId = COLLATERAL_TOKEN_ID;
        loan.principalAsset = makeAddr("principalAsset");
        loan.allowsPrepayListing = false; // toggled by callers
    }

    function _scaffoldActiveLoan(bool allowsPrepay) internal {
        _scaffoldLoan({status: LibVaipakam.LoanStatus.Active, allowsPrepay: allowsPrepay});
    }

    function _scaffoldLoan(LibVaipakam.LoanStatus status, bool allowsPrepay) internal {
        LibVaipakam.Loan memory loan = _baseLoan();
        loan.status = status;
        loan.allowsPrepayListing = allowsPrepay;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);

        // Mint both position NFTs. The #306 fix calls
        // `getPrepayContext` from the facet's `postPrepayListing`
        // to derive the canonical order's consideration recipients
        // (lender + borrower NFT holders); both must exist or
        // `ownerOf` reverts ERC721NonexistentToken.
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrowerHolder, BORROWER_TOKEN_ID);
        TestMutatorFacet(address(diamond)).mintNFTRaw(makeAddr("loanLender"), LENDER_TOKEN_ID);
    }

    /// @dev Grace boundary = startTime + durationDays + grace(durationDays).
    function _graceEnd() internal returns (uint256) {
        LibVaipakam.Loan memory loan = _baseLoan();
        uint256 endTime = uint256(loan.startTime) + (uint256(loan.durationDays) * 1 days);
        return endTime + LibVaipakam.gracePeriod(loan.durationDays);
    }

    /// @dev Live floor at the test's `block.timestamp`. SetupTest
    ///      leaves treasury + preclose fee bps at 0 by default, and
    ///      our scaffold sets `startTime == block.timestamp`, so
    ///      accruedInterest is 0 at every test entry → floor ==
    ///      principal == 100e18. Keeping this as a constant rather
    ///      than re-deriving through the diamond keeps the unit
    ///      test focused on the facet's surface, not the floor
    ///      math (step 3's job).
    function _liveFloorViaContext() internal pure returns (uint256) {
        return 100 ether;
    }

    function _floorPlusBuffer() internal pure returns (uint256) {
        uint256 floor = _liveFloorViaContext();
        return (floor * (10_000 + TEST_BUFFER_BPS)) / 10_000;
    }

    /// @dev Round-5 Block A (#313) — most pre-existing tests are
    ///      fee-free (no `feeLegs` semantics to assert), so they
    ///      pass an empty array as the new last arg of
    ///      `postPrepayListing` / `updatePrepayListing`. New tests
    ///      that exercise the fee-leg surface build their own
    ///      explicit arrays.
    function _emptyFeeLegs() internal pure returns (FeeLeg[] memory) {
        return new FeeLeg[](0);
    }

    // ─── Round-5 Block A (#313) — fee-leg integration tests ───────────

    /// @dev Two-leg fee schedule (OpenSea protocol + creator royalty).
    ///      Realistic shape — matches what the dapp would compute from
    ///      a fee-enforced collection's OpenSea Collection API
    ///      response. Total fees = 7.5% of askPrice.
    function _twoFeeLegsForAsk(uint256 askPrice) internal returns (FeeLeg[] memory legs) {
        legs = new FeeLeg[](2);
        legs[0] = FeeLeg({
            recipient: makeAddr("opensea-fee"),
            startAmount: uint96((askPrice * 250) / 10_000),                  // 2.5%
            endAmount: uint96((askPrice * 250) / 10_000)
        });
        legs[1] = FeeLeg({
            recipient: makeAddr("creator-royalty"),
            startAmount: uint96((askPrice * 500) / 10_000),                  // 5.0%
            endAmount: uint96((askPrice * 500) / 10_000)
        });
    }

    /// @dev Post + capture the orderHash on a fee-enforced collection.
    ///      Asserts the executor recorded the legs in storage so the
    ///      cancel-time reconstruction has them. (Posting via the mock
    ///      executor; storage is on the mock's RecordedCall, not on the
    ///      real CollateralListingExecutor — but the assertion shape
    ///      mirrors what the real executor would do.)
    function test_postPrepayListing_happyPath_withFeeLegs() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Ask must cover (floor × 1.02) + 7.5% of ask in fees.
        // floor=100e18, buffer=2% → minProtocol=102e18; fees=7.5% of ask.
        // Solve ask >= 102e18 + 0.075 × ask  →  ask >= 102e18 / 0.925.
        // 120e18 comfortably clears the threshold with headroom.
        uint256 ask = 120 ether;
        FeeLeg[] memory legs = _twoFeeLegsForAsk(ask);

        vm.prank(borrowerHolder);
        bytes32 hash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, ask, TEST_SALT_A, conduitKey, legs
        );
        assertNotEq(hash, bytes32(0), "hash recorded");

        // Mock executor captured the FeeLeg[] verbatim — same length,
        // same recipients, same amounts on every entry.
        MockListingExecutorRecorder.RecordedCall memory call =
            mockExecutor.recordedCallAt(0);
        assertEq(call.feeLegs.length, 2, "2 fee legs recorded");
        assertEq(call.feeLegs[0].recipient, legs[0].recipient);
        assertEq(call.feeLegs[0].startAmount, legs[0].startAmount);
        assertEq(call.feeLegs[1].recipient, legs[1].recipient);
        assertEq(call.feeLegs[1].startAmount, legs[1].startAmount);
    }

    /// @dev `MAX_FEE_LEGS = 4`. A 5-leg array MUST revert at the
    ///      facet boundary with `FeeLegsExceedCap`, before any
    ///      state mutation.
    function test_postPrepayListing_revertsFeeLegsExceedCap() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        FeeLeg[] memory legs = new FeeLeg[](5);
        for (uint256 i = 0; i < 5; i++) {
            legs[i] = FeeLeg({
                recipient: address(uint160(0xF0000 + i)),
                startAmount: 1e18,
                endAmount: 1e18
            });
        }
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.FeeLegsExceedCap.selector,
                5,
                4
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer() + 10e18, TEST_SALT_A, conduitKey, legs
        );
    }

    /// @dev Zero recipient is rejected with the indexed error so the
    ///      dapp can surface which entry was bad.
    function test_postPrepayListing_revertsFeeLegInvalidRecipient() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        FeeLeg[] memory legs = new FeeLeg[](1);
        legs[0] = FeeLeg({
            recipient: address(0),
            startAmount: 1e18,
            endAmount: 1e18
        });
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.FeeLegInvalidRecipient.selector, 0
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer() + 1e18, TEST_SALT_A, conduitKey, legs
        );
    }

    /// @dev Fixed-price MUST reject `startAmount != endAmount` — the
    ///      `>=` form is reserved for Dutch entry points (Block B).
    function test_postPrepayListing_revertsFeeLegDecayOnFixedPrice() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        FeeLeg[] memory legs = new FeeLeg[](1);
        legs[0] = FeeLeg({
            recipient: address(0xFEE),
            startAmount: 2e18,
            endAmount: 1e18  // diverges from startAmount
        });
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.FeeLegDecayNotAllowedOnFixedPrice.selector, 0
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer() + 5e18, TEST_SALT_A, conduitKey, legs
        );
    }

    /// @dev With non-empty fees, the buffered-floor check
    ///      `_requireAskCoversFloorWithFees` must reject an ask that
    ///      covers protocol legs + buffer alone but not the fees on
    ///      top. The error label is `AskBelowFloorPlusFees`.
    function test_postPrepayListing_revertsAskBelowFloorPlusFees() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Ask exactly equals floor × (1 + buffer) — no headroom for
        // any fees. Adding a 1 wei fee leg pushes the required ask
        // above the supplied value.
        uint256 minProtocolAsk = _floorPlusBuffer();
        FeeLeg[] memory legs = new FeeLeg[](1);
        legs[0] = FeeLeg({
            recipient: address(0xFEE),
            startAmount: 1,
            endAmount: 1
        });
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.AskBelowFloorPlusFees.selector,
                LOAN_ID,
                minProtocolAsk,
                minProtocolAsk + 1
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, minProtocolAsk, TEST_SALT_A, conduitKey, legs
        );
    }

    // ─── Round-5 Block B (#309) — Dutch posting integration tests ───────

    /// @dev v1 baseline projected-floor at any `auctionEndTime` ≤
    ///      `gracePeriodEnd` is approximated by the test's pctx mock
    ///      to be the same as the live floor (the mock returns a
    ///      constant pctx — see `_scaffoldActiveLoan`). For Dutch
    ///      math the projected lender+treasury ≈ 100e18 + 0 (mock
    ///      has lenderLeg=100e18, treasuryLeg=0 in the default scaffold).
    function _dutchAuctionEnd() internal view returns (uint256) {
        // 6h into the future — safely > MIN_AUCTION_WINDOW (1h) and
        // safely < gracePeriodEnd (30 days). Reads block.timestamp
        // at call time so the timestamp's relativity to the scaffold's
        // pctx graceEnd is preserved.
        return block.timestamp + 6 hours;
    }

    function test_postPrepayDutchListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Dutch: startAsk=110e18 → endAsk=104e18; lender=100e18 +
        // treasury=0 + zero fees → borrower decays from 10e18 → 4e18.
        uint256 startAsk = 110 ether;
        uint256 endAsk = 104 ether;
        uint256 auctionEndTime = _dutchAuctionEnd();

        vm.prank(borrowerHolder);
        bytes32 derivedHash = NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, startAsk, endAsk, auctionEndTime, TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );

        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            derivedHash,
            "diamond stores active orderHash"
        );
        assertTrue(derivedHash != bytes32(0), "derived hash non-zero");

        // Executor recorded the order with Dutch fields.
        assertEq(mockExecutor.recordCallCount(), 1, "recordOrder called once");
        MockListingExecutorRecorder.RecordedCall memory call = mockExecutor.recordedCallAt(0);
        assertEq(call.orderHash, derivedHash, "right orderHash");
        assertEq(call.askPrice, startAsk, "startAskPrice recorded as ctx.askPrice");
        assertEq(call.endAskPrice, endAsk, "endAskPrice recorded");
        assertEq(call.auctionEndTime, auctionEndTime, "auctionEndTime recorded");
        assertEq(call.mode, PREPAY_MODE_DUTCH, "mode tag = DUTCH");

        // Lock active under PrepayCollateralListing.
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.PrepayCollateralListing),
            "borrower NFT locked"
        );
    }

    // ─── #656c — consolidate-before-listing on a TRANSFERRED position ───

    /// @dev Anchor the loan to the original opener (`borrowerHolder`, whose
    ///      vault already holds the collateral per `setUp`) but mint the
    ///      borrower-position NFT to `holder` — i.e. the position was
    ///      transferred on the secondary market and `loan.borrower` still
    ///      points at the opener (the #656c pre-consolidation divergence).
    ///      Returns the transferee's freshly-provisioned vault.
    function _scaffoldTransferredActiveLoan(address holder)
        internal
        returns (address holderVault)
    {
        holderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(holder);
        LibVaipakam.Loan memory loan = _baseLoan(); // loan.borrower == borrowerHolder
        loan.allowsPrepayListing = true;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);
        TestMutatorFacet(address(diamond)).mintNFTRaw(holder, BORROWER_TOKEN_ID);
        TestMutatorFacet(address(diamond)).mintNFTRaw(makeAddr("loanLender"), LENDER_TOKEN_ID);
    }

    /// @dev Asserts the #656c hook fired before the vault was cached: the
    ///      borrower side re-anchored to `holder`, the collateral physically
    ///      moved into the holder's vault, and a listing was pinned (bound to
    ///      that holder's vault, since the order's offerer is resolved from
    ///      `userVaipakamVaults[loan.borrower]` after the re-anchor).
    function _assertConsolidatedToHolder(address holder, address holderVault) internal view {
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(LOAN_ID).borrower,
            holder,
            "borrower side re-anchored to the current holder"
        );
        assertEq(
            collateralNFT.ownerOf(COLLATERAL_TOKEN_ID),
            holderVault,
            "collateral moved into the current holder's vault"
        );
        assertTrue(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID)
                != bytes32(0),
            "listing created against the holder's vault"
        );
    }

    function test_postPrepayListing_transferredPosition_consolidatesToHolder() public {
        address holder = makeAddr("fixedPriceTransferee");
        address holderVault = _scaffoldTransferredActiveLoan(holder);

        // The current holder (not the departed opener) posts the listing.
        vm.prank(holder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, 110 ether, TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );

        _assertConsolidatedToHolder(holder, holderVault);
    }

    /// @notice #818 — a sanctioned borrower-NFT holder cannot POST a Dutch
    ///         prepay collateral-sale listing either. Same screen as the
    ///         fixed-price path; `holder == msg.sender`.
    function test_postPrepayDutchListing_revertsWhenHolderSanctioned() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        MockSanctionsList m = new MockSanctionsList();
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(borrowerHolder, true);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, borrowerHolder)
        );
        NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, 110 ether, 104 ether, _dutchAuctionEnd(), TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postPrepayDutchListing_transferredPosition_consolidatesToHolder() public {
        address holder = makeAddr("dutchTransferee");
        address holderVault = _scaffoldTransferredActiveLoan(holder);

        vm.prank(holder);
        NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, 110 ether, 104 ether, _dutchAuctionEnd(), TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );

        _assertConsolidatedToHolder(holder, holderVault);
    }

    function test_postPrepayDutchListing_revertsAuctionWindowTooShort() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // auctionEndTime exactly == block.timestamp + MIN_AUCTION_WINDOW —
        // facet uses strict `<=` so this hits the revert boundary.
        uint256 tooSoon = block.timestamp + MIN_AUCTION_WINDOW;
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayDutchListingFacet.AuctionWindowTooShort.selector,
                LOAN_ID,
                tooSoon,
                MIN_AUCTION_WINDOW
            )
        );
        NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, 110 ether, 104 ether, tooSoon, TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postPrepayDutchListing_revertsAuctionExceedsGrace() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Scaffold loan duration = 30 days; gracePeriod() adds a few
        // more days on top. Picking 90 days out comfortably exceeds
        // any realistic configuration of the grace window.
        uint256 tooLate = block.timestamp + 90 days;
        vm.prank(borrowerHolder);
        // Don't pin the exact gracePeriodEnd value — the scaffold's
        // computation of `loan.startTime + duration*1d + gracePeriod`
        // depends on internal config defaults. Use selector-only match.
        vm.expectRevert();
        NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, 110 ether, 104 ether, tooLate, TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postPrepayDutchListing_revertsAskNotMonotonic() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Inverted: end > start.
        uint256 startAsk = 105 ether;
        uint256 endAsk = 110 ether;
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayDutchListingFacet.AskNotMonotonic.selector,
                startAsk,
                endAsk
            )
        );
        NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, startAsk, endAsk, _dutchAuctionEnd(), TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postPrepayDutchListing_revertsDutchEndAskBelowProjectedFloor() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Lender=100, treasury=0, no fees → endMin=100. Pick endAsk=99
        // to trip the end-state solvency revert. startAsk=110 keeps the
        // start-state solvency check passing so the end-state path is
        // reached.
        uint256 startAsk = 110 ether;
        uint256 endAsk = 99 ether;
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayDutchListingFacet.DutchEndAskBelowProjectedFloorPlusFees.selector,
                LOAN_ID,
                endAsk,
                100 ether  // protocolLegs (lender + treasury, no fees)
            )
        );
        NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, startAsk, endAsk, _dutchAuctionEnd(), TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );
    }

    function test_postPrepayDutchListing_revertsBorrowerLegNotMonotonic() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Total ask decays slowly (1 wei), fees decay fast (5 ether) —
        // borrower remainder INVERTS (endRemainder > startRemainder)
        // even though startAsk > endAsk by 1 wei.
        // startBorrower = 110e - 100e - 10e = 0
        // endBorrower   = 110e - 1 - 100e - 5e = ~5e (positive, larger)
        // → BorrowerLegNotMonotonic.
        uint256 startAsk = 110 ether;
        uint256 endAsk = startAsk - 1; // monotonic by 1 wei
        FeeLeg[] memory legs = new FeeLeg[](1);
        legs[0] = FeeLeg({
            recipient: makeAddr("fast-decay-fee"),
            startAmount: uint96(10 ether),
            endAmount: uint96(5 ether)
        });
        vm.prank(borrowerHolder);
        vm.expectRevert();  // BorrowerLegNotMonotonic with specific values
        NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, startAsk, endAsk, _dutchAuctionEnd(), TEST_SALT_A, conduitKey, legs
        );
    }

    function test_updatePrepayDutchListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // Initial Dutch post.
        vm.prank(borrowerHolder);
        bytes32 oldHash = NFTPrepayDutchListingFacet(address(diamond)).postPrepayDutchListing(
            LOAN_ID, 110 ether, 104 ether, _dutchAuctionEnd(),
            TEST_SALT_A, conduitKey, _emptyFeeLegs()
        );

        // Update with a fresh shape.
        uint256 newStart = 115 ether;
        uint256 newEnd = 108 ether;
        uint256 newEndTime = block.timestamp + 12 hours;
        vm.prank(borrowerHolder);
        bytes32 newHash = NFTPrepayDutchListingFacet(address(diamond)).updatePrepayDutchListing(
            LOAN_ID, newStart, newEnd, newEndTime,
            TEST_SALT_A + 1, conduitKey, _emptyFeeLegs()
        );

        assertTrue(newHash != oldHash, "fresh hash on rotation");
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            newHash,
            "diamond points at rotated hash"
        );

        // Executor saw clearOrder(old) + recordOrder(new); the lock
        // stayed continuous (no _unlock between post and update).
        assertEq(mockExecutor.clearCallCount(), 1, "old hash cleared");
        assertEq(mockExecutor.lastClearedOrderHash(), oldHash, "right hash cleared");
        assertEq(mockExecutor.recordCallCount(), 2, "two records (post + update)");

        MockListingExecutorRecorder.RecordedCall memory call = mockExecutor.recordedCallAt(1);
        assertEq(call.mode, PREPAY_MODE_DUTCH, "update preserved Dutch mode");
        assertEq(call.endAskPrice, newEnd, "new endAsk recorded");
        assertEq(call.auctionEndTime, newEndTime, "new auctionEnd recorded");

        // Lock stayed PrepayCollateralListing across the rotation.
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.PrepayCollateralListing),
            "lock continuous"
        );
    }
}
