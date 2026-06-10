// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibTreasuryBuyback} from "../src/libraries/LibTreasuryBuyback.sol";
import {LibBuybackOrderValidation} from "../src/libraries/LibBuybackOrderValidation.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IOrderMixin} from
    "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";

/// @dev Trivial stub for receiver / messenger slots that only need
///      `code.length > 0`.
contract _StubReceiver {}

/// @dev Mock LOP that satisfies the Sub 3.C orderHash recomputation
///      requirement (`DOMAIN_SEPARATOR()` static) and acts as the
///      authorised caller for the diamond's pre/post-interaction
///      hooks during end-to-end simulation.
contract _MockLOP {
    bytes32 public constant DOMAIN_SEPARATOR =
        keccak256("vaipakam.test.lop.e2e");
}

/**
 * @title BuybackEndToEndIntegrationTest
 * @notice T-087 Sub 3.D — end-to-end integration test wiring Sub
 *         3.A (Base-side absorb) + Sub 3.C (validated commit +
 *         partial fill) into a single demonstration of the
 *         buyback flywheel:
 *
 *           1. The Base diamond absorbs a CCIP-delivered remittance
 *              (simulated via the `absorbRemittance` sender gate; the
 *              CCIP delivery itself is unit-covered in
 *              `TreasuryBuybackRemittanceTest`).
 *           2. The operator opens a Sub 3.C validated commit against
 *              a canonical Fusion buyback order template.
 *           3. A simulated Fusion solver runs the per-partial fill
 *              sequence (preInteraction baseline + source-token pull
 *              + VPFI delivery + postInteraction).
 *           4. The end-state of the staking-pool budget proves
 *              fee-revenue → VPFI flywheel completes end-to-end.
 *
 *         This complements the per-feature unit tests by exercising
 *         the storage interactions all three slices share (LOP
 *         allowance counter, intent-live-commit counter, buyback
 *         budget slots, order-kind discriminator).
 */
contract BuybackEndToEndIntegrationTest is SetupTest {
    ERC20Mock internal usdc;
    ERC20Mock internal vpfi;
    address internal receiver;
    _MockLOP internal lopContract;
    address internal lop;
    bytes32 internal lopDomain;

    uint96 internal constant AMOUNT_IN = 1_000e6;     // 1,000 USDC
    uint128 internal constant MIN_VPFI_OUT = 100e18;  // 100 VPFI floor

    function setUp() public {
        setupHelper();
        vm.warp(1_000_000);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vpfi = new ERC20Mock("VPFI", "VPFI", 18);
        receiver = address(new _StubReceiver());
        lopContract = new _MockLOP();
        lop = address(lopContract);
        lopDomain = lopContract.DOMAIN_SEPARATOR();

        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        IntentConfigFacet(address(diamond)).setFusionLimitOrderProtocol(lop);
        TreasuryFacet(address(diamond)).setBuybackRemittanceReceiver(receiver);
    }

    function _t() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    function _d() internal view returns (IntentDispatchFacet) {
        return IntentDispatchFacet(address(diamond));
    }

    function _buildValidatedTemplate(uint64 expiresAt)
        internal
        view
        returns (
            LibBuybackOrderValidation.BuybackOrderTemplate memory tpl,
            bytes32 orderHash
        )
    {
        bytes memory ext = LibBuybackOrderValidation.canonicalBuybackExtension(address(diamond));
        uint256 salt = uint256(uint160(uint256(keccak256(ext))));
        uint256 mt = LibBuybackOrderValidation.HAS_EXTENSION_FLAG
            | LibBuybackOrderValidation.PRE_INTERACTION_CALL_FLAG
            | LibBuybackOrderValidation.POST_INTERACTION_CALL_FLAG
            | LibBuybackOrderValidation.ALLOW_MULTIPLE_FILLS_FLAG
            | (uint256(expiresAt) << LibBuybackOrderValidation.EXPIRATION_OFFSET);

        tpl = LibBuybackOrderValidation.BuybackOrderTemplate({
            salt: salt,
            maker: address(diamond),
            receiver: address(diamond),
            makerAsset: address(usdc),
            takerAsset: address(vpfi),
            makingAmount: AMOUNT_IN,
            takingAmount: MIN_VPFI_OUT,
            makerTraits: mt,
            extension: ext
        });
        bytes32 structHash = keccak256(abi.encode(
            LibBuybackOrderValidation.LIMIT_ORDER_TYPEHASH,
            tpl.salt,
            uint256(uint160(tpl.maker)),
            uint256(uint160(tpl.receiver)),
            uint256(uint160(tpl.makerAsset)),
            uint256(uint160(tpl.takerAsset)),
            tpl.makingAmount,
            tpl.takingAmount,
            tpl.makerTraits
        ));
        orderHash = keccak256(
            abi.encodePacked(bytes2(0x1901), lopDomain, structHash)
        );
    }

    // ─── 1. Absorb: Base-side delivered remittance ────────────────

    function _absorbRemittance() internal {
        // Simulate CCIP delivering AMOUNT_IN of USDC into the diamond
        // and the BuybackRemittanceReceiver forwarding to absorb.
        usdc.mint(address(diamond), AMOUNT_IN);
        vm.prank(receiver);
        _t().absorbRemittance(address(usdc), AMOUNT_IN, 11_155_111);
    }

    // ─── 2. Simulate Fusion solver: one partial fill ──────────────

    function _simulateFusionFill(
        bytes32 orderHash,
        uint96 consumed,
        uint256 vpfiDelivered
    ) internal {
        IOrderMixin.Order memory order;
        // preInteraction snapshots baselines.
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");
        // Solver pulls the source token (LOP uses the diamond's
        // aggregate allowance granted at commit time).
        vm.prank(address(diamond));
        usdc.transfer(lop, consumed);
        // Solver delivers VPFI to the diamond (Fusion's makerAsset
        // → takerAsset swap).
        vpfi.mint(address(diamond), vpfiDelivered);
        // postInteraction settles.
        vm.prank(lop);
        _d().postInteraction(order, "", orderHash, address(0), consumed, 0, 0, "");
    }

    // ─── E2E: absorb → validated commit → two partial fills ───────

    function test_EndToEnd_AbsorbCommitFillCycle() public {
        // ─── (1) Absorb ──────────────────────────────────────────
        _absorbRemittance();
        assertEq(
            _t().getBaseBuybackBudget(address(usdc)), AMOUNT_IN,
            "1: budget after absorb"
        );

        // ─── (2) Validated commit ────────────────────────────────
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildValidatedTemplate(expiresAt);
        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT_IN, uint256(MIN_VPFI_OUT), expiresAt
        );

        // Sub 3.C invariants: budget drained → reserved; LOP allowance
        // granted; isValidSignature returns magic.
        assertEq(_t().getBaseBuybackBudget(address(usdc)), 0, "2a: budget drained");
        assertEq(
            usdc.allowance(address(diamond), lop), AMOUNT_IN,
            "2b: LOP allowance"
        );
        assertEq(
            _d().isValidSignature(orderHash, ""),
            IERC1271.isValidSignature.selector,
            "2c: ERC-1271 magic"
        );

        // ─── (3) First partial fill — 40% ─────────────────────────
        uint96 firstFill = (AMOUNT_IN * 40) / 100;
        uint256 firstVpfi = 50e18;  // exceeds pro-rata floor of 40e18.
        uint256 stakingPre = _t().getStakingPoolBuybackBudget();
        _simulateFusionFill(orderHash, firstFill, firstVpfi);
        assertEq(
            uint256(_t().getBuybackConsumedSoFar(orderHash)), uint256(firstFill),
            "3a: consumed after first"
        );
        assertEq(
            _t().getStakingPoolBuybackBudget(), stakingPre + firstVpfi,
            "3b: staking credit"
        );
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(orderHash);
        assertEq(
            uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_PENDING),
            "3c: still pending after first partial"
        );

        // ─── (4) Second partial fill — completes the order ───────
        uint96 secondFill = AMOUNT_IN - firstFill;
        uint256 secondVpfi = 60e18; // 50 + 60 = 110 ≥ 100 min cumulative floor
        _simulateFusionFill(orderHash, secondFill, secondVpfi);

        // ─── (5) Terminal invariants ─────────────────────────────
        info = _t().getBuybackOrder(orderHash);
        assertEq(
            uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_FILLED),
            "5a: Filled at terminal"
        );
        assertEq(
            _t().getOrderHashKind(orderHash), bytes32(0),
            "5b: kind cleared at terminal"
        );
        assertFalse(_t().isBuybackValidated(orderHash), "5c: validated cleared");
        assertEq(
            _t().getStakingPoolBuybackBudget(), stakingPre + firstVpfi + secondVpfi,
            "5d: total VPFI to staking pool"
        );
        assertEq(
            usdc.allowance(address(diamond), lop), 0,
            "5e: LOP allowance fully released"
        );
        assertEq(
            _d().isValidSignature(orderHash, ""), bytes4(0xffffffff),
            "5f: signature invalid after settlement"
        );
    }

    // ─── Negative: expire after partial returns unconsumed only ───

    function test_EndToEnd_ExpireAfterPartial_ReturnsUnconsumed() public {
        _absorbRemittance();
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildValidatedTemplate(expiresAt);
        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT_IN, uint256(MIN_VPFI_OUT), expiresAt
        );

        // 30% partial — leaves 70% reserved.
        uint96 partialFill = (AMOUNT_IN * 30) / 100;
        _simulateFusionFill(orderHash, partialFill, 30e18);

        // Warp past expiry.
        vm.warp(uint256(expiresAt) + 1);

        // Expire releases the unconsumed 70%.
        uint96 unconsumed = AMOUNT_IN - partialFill;
        _t().expireBuybackIntent(orderHash);

        assertEq(
            _t().getBaseBuybackBudget(address(usdc)), unconsumed,
            "unconsumed returned to budget"
        );
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(orderHash);
        assertEq(
            uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_EXPIRED),
            "Expired"
        );
        // Already-swapped portion stays settled.
        assertEq(
            _t().getStakingPoolBuybackBudget(), 30e18,
            "partial proceeds preserved"
        );
    }
}
