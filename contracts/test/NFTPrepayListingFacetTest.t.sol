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
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
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
            LOAN_ID, 1e18, TEST_SALT_A, conduitKey
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
        );
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
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
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
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        );
    }

    function test_postPrepayListing_revertsAlreadyExists() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        // First post — happy path. Capture the diamond-derived hash.
        vm.prank(borrowerHolder);
        bytes32 firstHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        );

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
        );
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
            LOAN_ID, minAsk - 1, TEST_SALT_A, conduitKey
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
        );
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
        );
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
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        );
    }

    // ─── 2b. postPrepayListing — happy path ─────────────────────────────

    function test_postPrepayListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});
        uint256 ask = _floorPlusBuffer();

        vm.prank(borrowerHolder);
        bytes32 derivedHash = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, ask, TEST_SALT_A, conduitKey
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
        );
    }

    function test_updatePrepayListing_happyPath() public {
        _scaffoldActiveLoan({allowsPrepay: true});

        // 1. Post with salt A — capture derived hash.
        vm.prank(borrowerHolder);
        bytes32 hashA = NFTPrepayListingFacet(address(diamond)).postPrepayListing(
            LOAN_ID, _floorPlusBuffer(), TEST_SALT_A, conduitKey
        );

        // 2. Update with salt B — capture derived hash.
        vm.prank(borrowerHolder);
        bytes32 hashB = NFTPrepayListingFacet(address(diamond)).updatePrepayListing(
            LOAN_ID, _floorPlusBuffer() + 1 ether, TEST_SALT_B, conduitKey
        );
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
        );
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
        );

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
        );

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
        );

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
        );

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
        );

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
        );

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
        );

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
        );

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
        );

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
        );

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
}
