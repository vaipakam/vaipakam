// test/NFTPrepayListingFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibERC721} from "../src/libraries/LibERC721.sol";
import {NFTPrepayListingFacet} from "../src/facets/NFTPrepayListingFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockListingExecutorRecorder} from "./mocks/MockListingExecutorRecorder.sol";

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

    address internal borrowerHolder;
    address internal randomCaller;
    address internal conduit;

    uint256 internal constant LOAN_ID = 4_242;
    uint256 internal constant LENDER_TOKEN_ID = 100;
    uint256 internal constant BORROWER_TOKEN_ID = 101;

    bytes32 internal constant ORDER_HASH_A = bytes32(uint256(0xa11ce));
    bytes32 internal constant ORDER_HASH_B = bytes32(uint256(0xb0b));

    uint16 internal constant TEST_BUFFER_BPS = 200; // 2 %

    function setUp() public {
        setupHelper();
        mockExecutor = new MockListingExecutorRecorder();
        borrowerHolder = makeAddr("borrowerHolder");
        randomCaller = makeAddr("randomCaller");
        conduit = makeAddr("seaportConduitMock");

        // Approve the conduit on the executor stub so happy paths
        // pass the allow-list precondition.
        mockExecutor.setApprovedConduit(conduit, true);

        // Wire executor + buffer (the two post-deploy gates the
        // facet enforces). Both ADMIN_ROLE-gated.
        vm.startPrank(owner);
        PrepayListingFacet(address(diamond))
            .setCollateralListingExecutor(address(mockExecutor));
        ConfigFacet(address(diamond))
            .setPrepayListingBufferBps(TEST_BUFFER_BPS);
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

    function test_postPrepayListing_revertsZeroOrderHash() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        vm.prank(borrowerHolder);
        vm.expectRevert(NFTPrepayListingFacet.ZeroOrderHash.selector);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), bytes32(0), conduit
        );
    }

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
            LOAN_ID, 1e18, ORDER_HASH_A, conduit
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
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );
    }

    function test_postPrepayListing_revertsUnsupportedCollateralForV1() public {
        // Build an Active loan with ERC1155 collateral (step 6 = ERC721 only).
        LibVaipakam.Loan memory loan = _baseLoan();
        loan.collateralAssetType = LibVaipakam.AssetType.ERC1155;
        loan.allowsPrepayListing = true;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, loan);

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.UnsupportedCollateralForV1.selector,
                LibVaipakam.AssetType.ERC1155
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );
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
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );
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
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );
    }

    function test_postPrepayListing_revertsAlreadyExists() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // First post — happy path.
        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );

        // Second post — should fail.
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.PrepayListingAlreadyExists.selector,
                LOAN_ID,
                ORDER_HASH_A
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_B, conduit
        );
    }

    function test_postPrepayListing_revertsConduitNotApproved() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        address rogueConduit = makeAddr("rogueConduit");
        // approvedConduits[rogueConduit] = false (default).
        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.ConduitNotApproved.selector,
                rogueConduit
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, rogueConduit
        );
    }

    function test_postPrepayListing_revertsAskBelowFloor() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        uint256 floor = _liveFloorViaContext();
        // 1 wei below the min — must fail.
        uint256 minAsk = (floor * (10_000 + TEST_BUFFER_BPS)) / 10_000;

        vm.prank(borrowerHolder);
        vm.expectRevert(
            abi.encodeWithSelector(
                NFTPrepayListingFacet.AskBelowFloor.selector,
                LOAN_ID,
                minAsk - 1,
                minAsk
            )
        );
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, minAsk - 1, ORDER_HASH_A, conduit
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
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );
    }

    function test_postPrepayListing_revertsBufferNotConfigured() public {
        // Reset buffer to 0 AFTER setUp configured it.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPrepayListingBufferBps(0);

        _scaffoldActiveLoan({allowsPrepay: true});
        vm.prank(borrowerHolder);
        vm.expectRevert(NFTPrepayListingFacet.PrepayListingBufferNotConfigured.selector);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );
    }

    // ─── 2b. postPrepayListing — happy path ─────────────────────────────

    function test_postPrepayListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        uint256 ask = _floorPlusBuffer();

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, ask, ORDER_HASH_A, conduit
        );

        // Diamond bookkeeping.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            ORDER_HASH_A,
            "diamond stores active orderHash"
        );

        // Executor side received the recordOrder call.
        assertEq(mockExecutor.recordCallCount(), 1, "executor.recordOrder called once");
        assertEq(
            mockExecutor.lastRecordedOrderHash(),
            ORDER_HASH_A,
            "executor recorded the right orderHash"
        );

        // Borrower-position NFT locked with the right reason.
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.PrepayCollateralListing),
            "borrower NFT locked with PrepayCollateralListing reason"
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
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_B, conduit
        );
    }

    function test_updatePrepayListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        // 1. Post with hash A.
        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );

        // 2. Update to hash B.
        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).updatePrepayListing(
            LOAN_ID, _floorPlusBuffer() + 1 ether, ORDER_HASH_B, conduit
        );

        // Bookkeeping points at the new hash.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            ORDER_HASH_B,
            "orderHash replaced with the new one"
        );

        // Executor saw: one initial record, one clearOrder (for A),
        // one second record (for B).
        assertEq(mockExecutor.recordCallCount(), 2, "two recordOrder calls (initial + replace)");
        assertEq(mockExecutor.clearCallCount(), 1, "one clearOrder call (clear A)");
        assertEq(mockExecutor.lastClearedOrderHash(), ORDER_HASH_A, "A was cleared");
        assertEq(mockExecutor.lastRecordedOrderHash(), ORDER_HASH_B, "B was recorded");

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
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );

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

    function test_cancelPrepayListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).cancelPrepayListing(LOAN_ID);

        // Bookkeeping cleared.
        assertEq(
            NFTPrepayListingFacet(address(diamond)).getPrepayListingOrderHash(LOAN_ID),
            bytes32(0),
            "orderHash cleared on cancel"
        );

        // Executor saw the clearOrder.
        assertEq(mockExecutor.clearCallCount(), 1, "executor.clearOrder called once");
        assertEq(mockExecutor.lastClearedOrderHash(), ORDER_HASH_A, "cleared the right hash");

        // Lock released.
        assertEq(
            uint8(VaipakamNFTFacet(address(diamond)).positionLock(BORROWER_TOKEN_ID)),
            uint8(LibERC721.LockReason.None),
            "borrower NFT unlocked"
        );
    }

    // ─── 5. cancelExpiredPrepayListing (permissionless) ─────────────────

    function test_cancelExpiredPrepayListing_revertsGraceNotExpired() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );

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

    function test_cancelExpiredPrepayListing_permissionlessHappyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        vm.prank(borrowerHolder);
        NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), ORDER_HASH_A, conduit
        );

        // Warp past grace.
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
        loan.collateralAsset = makeAddr("collateralNFT");
        loan.collateralTokenId = 1;
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

        // Mint the borrower-position NFT to the holder so the
        // authority gate passes. Lender NFT mint isn't needed for
        // step 6's surface (the executor's zone callback at step 5
        // re-checks lender recipient at fill time, not here).
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrowerHolder, BORROWER_TOKEN_ID);
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
}
