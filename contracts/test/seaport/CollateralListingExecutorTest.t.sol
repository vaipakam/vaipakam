// test/seaport/CollateralListingExecutorTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {CollateralListingExecutor} from "../../src/seaport/CollateralListingExecutor.sol";
import {
    ISeaportZone,
    ZoneParameters,
    ReceivedItem,
    SpentItem,
    ItemType
} from "../../src/seaport/ISeaportZone.sol";
import {IVaipakamPrepayContext} from "../../src/seaport/IVaipakamPrepayContext.sol";
import {IVaipakamPrepayCallbacks} from "../../src/seaport/IVaipakamPrepayCallbacks.sol";

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/// @notice Mock diamond implementing the two interfaces the executor
///         calls into. Test can configure the returned `PrepayContext`
///         + assert that `executorFinalizePrepaySale` was invoked with
///         the right loanId.
contract MockVaipakamDiamond is IVaipakamPrepayContext, IVaipakamPrepayCallbacks {
    IVaipakamPrepayContext.PrepayContext public ctx;
    bool public finalizeCalled;
    uint256 public finalizeLoanId;
    address public finalizeCaller;

    function setContext(IVaipakamPrepayContext.PrepayContext memory c) external {
        ctx = c;
    }

    function getPrepayContext(uint256, uint256)
        external
        view
        override
        returns (IVaipakamPrepayContext.PrepayContext memory)
    {
        return ctx;
    }

    function executorFinalizePrepaySale(uint256 loanId) external override {
        finalizeCalled = true;
        finalizeLoanId = loanId;
        finalizeCaller = msg.sender;
    }
}

contract CollateralListingExecutorTest is Test {
    CollateralListingExecutor internal executor;
    MockVaipakamDiamond internal diamond;
    address internal seaport;
    address internal owner;
    address internal conduit;
    address internal lenderHolder;
    address internal borrowerHolder;
    address internal treasury;
    address internal principalAsset;
    address internal collateralAsset;
    address internal buyer;

    bytes32 internal constant TEST_ORDER_HASH = keccak256("test-order");
    uint256 internal constant TEST_LOAN_ID = 4242;
    uint256 internal constant TEST_COLLATERAL_TOKEN_ID = 777;

    function setUp() public {
        seaport = makeAddr("seaport");
        owner = makeAddr("owner");
        conduit = makeAddr("conduit");
        lenderHolder = makeAddr("lenderHolder");
        borrowerHolder = makeAddr("borrowerHolder");
        treasury = makeAddr("treasury");
        principalAsset = makeAddr("principalAsset");
        collateralAsset = makeAddr("collateralAsset");
        buyer = makeAddr("buyer");

        diamond = new MockVaipakamDiamond();

        // Deploy the executor behind an ERC1967 proxy + initialize.
        CollateralListingExecutor implementation = new CollateralListingExecutor();
        bytes memory initData = abi.encodeCall(
            CollateralListingExecutor.initialize,
            (seaport, address(diamond), owner)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        executor = CollateralListingExecutor(address(proxy));

        // Seed an approved conduit + a default context state.
        vm.prank(owner);
        executor.addApprovedConduit(conduit);

        _setDefaultContext();
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _setDefaultContext() internal {
        IVaipakamPrepayContext.PrepayContext memory c;
        c.status = LibVaipakam.LoanStatus.Active;
        c.assetType = LibVaipakam.AssetType.ERC20;
        c.collateralAssetType = LibVaipakam.AssetType.ERC721;
        c.principalAsset = principalAsset;
        c.collateralAsset = collateralAsset;
        c.collateralTokenId = TEST_COLLATERAL_TOKEN_ID;
        c.collateralQuantity = 1;
        c.lenderLeg = 100e18;
        c.treasuryLeg = 1e18;
        c.graceEnd = block.timestamp + 30 days;
        c.lenderNftOwner = lenderHolder;
        c.borrowerNftOwner = borrowerHolder;
        c.treasury = treasury;
        // #306 fix — executor's _checkOrderPreconditions verifies
        // `params.offerer == pctx.borrowerVault`. Test's
        // `_validZoneParams` sets `p.offerer` to this same address.
        c.borrowerVault = makeAddr("mockBorrowerVault");
        diamond.setContext(c);
    }

    function _validZoneParams() internal returns (ZoneParameters memory p) {
        p.orderHash = TEST_ORDER_HASH;
        p.fulfiller = buyer;
        // #306 fix — must match `pctx.borrowerVault` set in
        // `_setDefaultContext`. Same makeAddr seed.
        p.offerer = makeAddr("mockBorrowerVault");

        // Single ERC721 offered item matching loan's collateral.
        p.offer = new SpentItem[](1);
        p.offer[0] = SpentItem({
            itemType: ItemType.ERC721,
            token: collateralAsset,
            identifier: TEST_COLLATERAL_TOKEN_ID,
            amount: 1
        });

        // Three consideration legs in [lender, treasury, borrower] order.
        p.consideration = new ReceivedItem[](3);
        p.consideration[0] = ReceivedItem({
            itemType: ItemType.ERC20,
            token: principalAsset,
            identifier: 0,
            amount: 110e18, // ≥ 100e18 lenderLeg
            recipient: payable(lenderHolder)
        });
        p.consideration[1] = ReceivedItem({
            itemType: ItemType.ERC20,
            token: principalAsset,
            identifier: 0,
            amount: 1e18, // ≥ 1e18 treasuryLeg
            recipient: payable(treasury)
        });
        p.consideration[2] = ReceivedItem({
            itemType: ItemType.ERC20,
            token: principalAsset,
            identifier: 0,
            amount: 5e18,
            recipient: payable(borrowerHolder)
        });

        p.startTime = block.timestamp;
        p.endTime = block.timestamp + 1 days;
    }

    function _recordValidOrder() internal {
        vm.prank(address(diamond));
        executor.recordOrder(TEST_ORDER_HASH, TEST_LOAN_ID, conduit);
    }

    // ─── Admin: conduit allow-list ──────────────────────────────────────

    function test_addApprovedConduit_onlyOwner() public {
        address other = makeAddr("other");
        vm.prank(buyer);
        vm.expectRevert();
        executor.addApprovedConduit(other);

        vm.prank(owner);
        executor.addApprovedConduit(other);
        assertTrue(executor.approvedConduits(other));
    }

    function test_addApprovedConduit_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(CollateralListingExecutor.ZeroAddress.selector);
        executor.addApprovedConduit(address(0));
    }

    function test_removeApprovedConduit_clears() public {
        vm.prank(owner);
        executor.removeApprovedConduit(conduit);
        assertFalse(executor.approvedConduits(conduit));
    }

    // ─── recordOrder ───────────────────────────────────────────────────

    function test_recordOrder_onlyDiamond() public {
        vm.prank(buyer);
        vm.expectRevert(CollateralListingExecutor.NotDiamond.selector);
        executor.recordOrder(TEST_ORDER_HASH, TEST_LOAN_ID, conduit);
    }

    function test_recordOrder_rejectsUnapprovedConduit() public {
        address rogue = makeAddr("rogueConduit");
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(CollateralListingExecutor.ConduitNotApproved.selector, rogue)
        );
        executor.recordOrder(TEST_ORDER_HASH, TEST_LOAN_ID, rogue);
    }

    function test_recordOrder_alreadyRecorded() public {
        _recordValidOrder();
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.AlreadyRecorded.selector, TEST_ORDER_HASH
            )
        );
        executor.recordOrder(TEST_ORDER_HASH, TEST_LOAN_ID, conduit);
    }

    function test_recordOrder_uint96Overflow() public {
        uint256 tooBig = uint256(type(uint96).max) + 1;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(CollateralListingExecutor.LoanIdOverflow.selector, tooBig)
        );
        executor.recordOrder(TEST_ORDER_HASH, tooBig, conduit);
    }

    function test_recordOrder_happyPath() public {
        _recordValidOrder();
        (uint96 storedLoanId, address storedConduit) = executor.orderContext(TEST_ORDER_HASH);
        assertEq(uint256(storedLoanId), TEST_LOAN_ID);
        assertEq(storedConduit, conduit);
    }

    // ─── clearOrder ─────────────────────────────────────────────────────

    function test_clearOrder_onlyDiamond() public {
        _recordValidOrder();
        vm.prank(buyer);
        vm.expectRevert(CollateralListingExecutor.NotDiamond.selector);
        executor.clearOrder(TEST_ORDER_HASH);
    }

    function test_clearOrder_happyPath() public {
        _recordValidOrder();
        vm.prank(address(diamond));
        executor.clearOrder(TEST_ORDER_HASH);
        (uint96 storedLoanId, ) = executor.orderContext(TEST_ORDER_HASH);
        assertEq(uint256(storedLoanId), 0);
    }

    // ─── ERC-1271 isValidSignature ──────────────────────────────────────

    function test_isValidSignature_unknownOrder_invalid() public view {
        bytes4 result = executor.isValidSignature(keccak256("nope"), "");
        assertEq(result, bytes4(0xffffffff));
    }

    function test_isValidSignature_revokedConduit_invalid() public {
        _recordValidOrder();
        vm.prank(owner);
        executor.removeApprovedConduit(conduit);
        bytes4 result = executor.isValidSignature(TEST_ORDER_HASH, "");
        assertEq(result, bytes4(0xffffffff));
    }

    function test_isValidSignature_loanNotActive_invalid() public {
        _recordValidOrder();
        IVaipakamPrepayContext.PrepayContext memory c;
        c.status = LibVaipakam.LoanStatus.Settled;
        diamond.setContext(c);
        bytes4 result = executor.isValidSignature(TEST_ORDER_HASH, "");
        assertEq(result, bytes4(0xffffffff));
    }

    function test_isValidSignature_happyPath_returnsMagic() public {
        _recordValidOrder();
        bytes4 result = executor.isValidSignature(TEST_ORDER_HASH, "");
        assertEq(result, IERC1271.isValidSignature.selector);
    }

    // ─── Seaport zone: msg.sender gate ──────────────────────────────────

    function test_authorizeOrder_revertsNotSeaport() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        vm.prank(buyer);
        vm.expectRevert(CollateralListingExecutor.NotSeaport.selector);
        executor.authorizeOrder(p);
    }

    function test_validateOrder_revertsNotSeaport() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        vm.prank(buyer);
        vm.expectRevert(CollateralListingExecutor.NotSeaport.selector);
        executor.validateOrder(p);
    }

    // ─── Precondition stack (via validateOrder for assertion coverage) ──

    function test_validateOrder_unknownOrder() public {
        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.UnknownOrder.selector, p.orderHash
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_conduitRevoked() public {
        _recordValidOrder();
        vm.prank(owner);
        executor.removeApprovedConduit(conduit);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.ConduitNotApproved.selector, conduit
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_loanNotActive() public {
        _recordValidOrder();
        IVaipakamPrepayContext.PrepayContext memory c;
        c.status = LibVaipakam.LoanStatus.Settled;
        diamond.setContext(c);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.LoanNotActive.selector, TEST_LOAN_ID
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_graceExpired() public {
        _recordValidOrder();
        // Default ctx graceEnd was block.timestamp + 30 days at setUp.
        vm.warp(block.timestamp + 31 days);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.GraceExpired.selector, TEST_LOAN_ID
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongOfferCount() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.offer = new SpentItem[](2); // wrong count

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(CollateralListingExecutor.WrongOfferCount.selector, 1, 2)
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongOfferToken() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.offer[0].token = makeAddr("decoyNFT");

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongOfferToken.selector,
                collateralAsset,
                p.offer[0].token
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongOfferIdentifier() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.offer[0].identifier = TEST_COLLATERAL_TOKEN_ID + 1;

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongOfferIdentifier.selector,
                TEST_COLLATERAL_TOKEN_ID,
                TEST_COLLATERAL_TOKEN_ID + 1
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_unsupportedLendingAssetType() public {
        _recordValidOrder();
        IVaipakamPrepayContext.PrepayContext memory c;
        c.status = LibVaipakam.LoanStatus.Active;
        c.assetType = LibVaipakam.AssetType.ERC721; // NFT-rental → unsupported
        c.collateralAssetType = LibVaipakam.AssetType.ERC721;
        c.principalAsset = principalAsset;
        c.collateralAsset = collateralAsset;
        c.collateralTokenId = TEST_COLLATERAL_TOKEN_ID;
        c.collateralQuantity = 1;
        c.graceEnd = block.timestamp + 30 days;
        c.lenderNftOwner = lenderHolder;
        c.borrowerNftOwner = borrowerHolder;
        c.treasury = treasury;
        c.borrowerVault = makeAddr("mockBorrowerVault");
        diamond.setContext(c);

        ZoneParameters memory p = _validZoneParams();
        vm.prank(seaport);
        vm.expectRevert(CollateralListingExecutor.UnsupportedLendingAssetType.selector);
        executor.validateOrder(p);
    }

    function test_validateOrder_lenderShortPaid() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[0].amount = 50e18; // < 100e18 lenderLeg

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.LenderShortPaid.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_treasuryShortPaid() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[1].amount = 0; // < 1e18 treasuryLeg

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.TreasuryShortPaid.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongLenderRecipient() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[0].recipient = payable(buyer); // not lenderHolder

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongLenderRecipient.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongTreasuryRecipient() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[1].recipient = payable(buyer); // not the diamond treasury

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongTreasuryRecipient.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    function test_validateOrder_wrongBorrowerRecipient() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();
        p.consideration[2].recipient = payable(buyer); // not borrowerHolder

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralListingExecutor.WrongBorrowerRecipient.selector, TEST_ORDER_HASH
            )
        );
        executor.validateOrder(p);
    }

    // ─── Happy paths ────────────────────────────────────────────────────

    function test_authorizeOrder_happyPath_returnsMagic() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();

        vm.prank(seaport);
        bytes4 result = executor.authorizeOrder(p);
        assertEq(result, ISeaportZone.authorizeOrder.selector);
        // authorizeOrder does NOT call the finalize callback.
        assertFalse(diamond.finalizeCalled());
    }

    function test_validateOrder_happyPath_callsFinalizeAndClears() public {
        _recordValidOrder();
        ZoneParameters memory p = _validZoneParams();

        vm.prank(seaport);
        bytes4 result = executor.validateOrder(p);

        assertEq(result, ISeaportZone.validateOrder.selector);
        assertTrue(diamond.finalizeCalled());
        assertEq(diamond.finalizeLoanId(), TEST_LOAN_ID);
        assertEq(diamond.finalizeCaller(), address(executor));

        // orderContext entry MUST be cleared so a Seaport-validated
        // re-fill on the same hash can't slip through.
        (uint96 storedLoanId, ) = executor.orderContext(TEST_ORDER_HASH);
        assertEq(uint256(storedLoanId), 0);
    }
}
