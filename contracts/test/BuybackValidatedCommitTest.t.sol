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

/// @dev Trivial stub contract.
contract _Stub {}

/// @dev Mock LOP — exposes DOMAIN_SEPARATOR() static for the
///      on-chain orderHash recomputation path.
contract _MockLOPWithDomain {
    bytes32 public constant DOMAIN_SEPARATOR =
        keccak256("vaipakam.test.lop.domain.separator");
}

/// @title BuybackValidatedCommitTest
/// @notice T-087 Sub 3.C — validated commit path + TWAP partial fills.
contract BuybackValidatedCommitTest is SetupTest {
    ERC20Mock internal token;
    ERC20Mock internal vpfi;
    address internal receiver;
    _MockLOPWithDomain internal lopContract;
    address internal lop;
    bytes32 internal lopDomain;
    uint96 internal constant AMOUNT = 1_000e6;

    function setUp() public {
        setupHelper();
        vm.warp(1_000_000);
        token = new ERC20Mock("USDC", "USDC", 6);
        vpfi = new ERC20Mock("VPFI", "VPFI", 18);
        receiver = address(new _Stub());
        lopContract = new _MockLOPWithDomain();
        lop = address(lopContract);
        lopDomain = lopContract.DOMAIN_SEPARATOR();

        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        IntentConfigFacet(address(diamond)).setFusionLimitOrderProtocol(lop);
    }

    function _t() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    function _d() internal view returns (IntentDispatchFacet) {
        return IntentDispatchFacet(address(diamond));
    }

    function _seedBaseBudget(uint256 amount) internal {
        _t().setBuybackRemittanceReceiver(receiver);
        token.mint(address(diamond), amount);
        vm.prank(receiver);
        _t().absorbRemittance(address(token), amount, 11_155_111);
    }

    /// @dev Build a canonical buyback Fusion order template.
    function _buildTemplate(uint64 expiresAt, uint128 minVpfiOut)
        internal
        view
        returns (
            LibBuybackOrderValidation.BuybackOrderTemplate memory tpl,
            bytes32 orderHash
        )
    {
        // Canonical extension bytes (must match `LibBuybackOrderValidation.canonicalBuybackExtension`).
        bytes memory ext = LibBuybackOrderValidation.canonicalBuybackExtension(address(diamond));
        bytes32 extensionHash = keccak256(ext);
        // salt's low 160 bits = uint160 of the extensionHash.
        uint256 salt = uint256(uint160(uint256(extensionHash)));
        // makerTraits: HAS_EXTENSION + PRE_INTERACTION + POST_INTERACTION
        // + ALLOW_MULTIPLE_FILLS (for TWAP) + NO partial fills bit
        // CLEAR (partial fills allowed) + expiration sub-field.
        uint256 mt = 0;
        mt |= LibBuybackOrderValidation.HAS_EXTENSION_FLAG;
        mt |= LibBuybackOrderValidation.PRE_INTERACTION_CALL_FLAG;
        mt |= LibBuybackOrderValidation.POST_INTERACTION_CALL_FLAG;
        mt |= LibBuybackOrderValidation.ALLOW_MULTIPLE_FILLS_FLAG;
        // expiration in bits 80-119
        mt |= (uint256(expiresAt) << LibBuybackOrderValidation.EXPIRATION_OFFSET);

        tpl = LibBuybackOrderValidation.BuybackOrderTemplate({
            salt: salt,
            maker: address(diamond),
            receiver: address(diamond),
            makerAsset: address(token),
            takerAsset: address(vpfi),
            makingAmount: AMOUNT,
            takingAmount: minVpfiOut,
            makerTraits: mt,
            extension: ext
        });

        // Recompute orderHash on-chain-style.
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

    // ─── commitBuybackIntentValidated ─────────────────────────────

    function test_CommitValidated_HappyPath() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        uint128 minVpfiOut = 100e18;
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, minVpfiOut);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, uint256(minVpfiOut), expiresAt
        );

        // Validated flag set.
        assertTrue(_t().isBuybackValidated(orderHash));
        // Ledger entry recorded.
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(orderHash);
        assertEq(info.token, address(token));
        assertEq(uint256(info.amountIn), uint256(AMOUNT));
        // isValidSignature returns magic.
        assertEq(
            _d().isValidSignature(orderHash, ""),
            IERC1271.isValidSignature.selector,
            "magic for validated"
        );
    }

    function test_CommitValidated_RevertWhen_ZeroMinVpfiOut() public {
        // Codex round-2 P2 #2 — minVpfiOut must be positive.
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, 0);

        vm.expectRevert(LibTreasuryBuyback.BuybackZeroAmount.selector);
        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, 0, expiresAt
        );
    }

    function test_CommitValidated_RevertWhen_TwapWindowExceeded() public {
        _seedBaseBudget(AMOUNT);
        // Window > 30 min default.
        uint64 expiresAt = uint64(block.timestamp + 60 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, 100e18);

        vm.expectRevert(); // BuybackTwapWindowOutOfBounds
        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, 100e18, expiresAt
        );
    }

    function test_CommitValidated_RevertWhen_FieldMismatch() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, 100e18);
        // Tamper: change makerAsset.
        tpl.makerAsset = makeAddr("wrongToken");

        vm.expectRevert();
        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, 100e18, expiresAt
        );
    }

    function test_CommitValidated_RevertWhen_NoPartialFillsBitSet() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, 100e18);
        // Tamper: set NO_PARTIAL_FILLS bit (forbidden for TWAP buyback).
        tpl.makerTraits |= LibBuybackOrderValidation.NO_PARTIAL_FILLS_FLAG;

        vm.expectRevert(
            abi.encodeWithSelector(
                LibBuybackOrderValidation.BuybackOrderMakerTraitsMismatch.selector,
                LibBuybackOrderValidation.REASON_PARTIAL_FILLS_REQUIRED
            )
        );
        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, 100e18, expiresAt
        );
    }

    // ─── canonical extension view ───────────────────────────────

    function test_CanonicalBuybackExtension_MatchesLibrary() public view {
        bytes memory ext = _t().canonicalBuybackExtension();
        bytes memory libExt = LibBuybackOrderValidation.canonicalBuybackExtension(address(diamond));
        assertEq(keccak256(ext), keccak256(libExt));
    }

    // ─── TWAP partial fills ─────────────────────────────────────

    function test_PostInteraction_PartialFill_AccumulatesAndFinalizes() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        uint128 minVpfiOut = 100e18;
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, minVpfiOut);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, uint256(minVpfiOut), expiresAt
        );

        uint96 firstFill = AMOUNT / 2;
        uint96 secondFill = AMOUNT - firstFill;

        IOrderMixin.Order memory order;

        // ── First partial fill ──────────────────────────────────
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");

        // Deliver VPFI proportional + simulate source-token pull.
        vpfi.mint(address(diamond), 50e18);
        vm.prank(address(diamond));
        token.transfer(lop, firstFill);

        vm.prank(lop);
        _d().postInteraction(order, "", orderHash, address(0), firstFill, 0, 0, "");

        // Still Pending after partial.
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(orderHash);
        assertEq(uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_PENDING));
        assertEq(uint256(_t().getBuybackConsumedSoFar(orderHash)), uint256(firstFill));
        assertEq(_t().getOrderHashKind(orderHash), LibVaipakam.ORDER_KIND_BUYBACK);

        // ── Second (final) partial fill ─────────────────────────
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");

        vpfi.mint(address(diamond), 51e18);
        vm.prank(address(diamond));
        token.transfer(lop, secondFill);

        vm.prank(lop);
        _d().postInteraction(order, "", orderHash, address(0), secondFill, 0, 0, "");

        // Now Filled.
        info = _t().getBuybackOrder(orderHash);
        assertEq(uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_FILLED));
        assertEq(_t().getOrderHashKind(orderHash), bytes32(0), "kind cleared");
        assertFalse(_t().isBuybackValidated(orderHash), "validated cleared");
    }

    function test_Expire_AfterPartial_ReleasesOnlyUnconsumed() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        uint128 minVpfiOut = 1; // smallest positive floor (round-2 P2 #2)
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, minVpfiOut);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, uint256(minVpfiOut), expiresAt
        );

        // One partial fill of 40% of AMOUNT.
        uint96 partialAmount = (AMOUNT * 40) / 100;
        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");
        vpfi.mint(address(diamond), 40e18);
        vm.prank(address(diamond));
        token.transfer(lop, partialAmount);
        vm.prank(lop);
        _d().postInteraction(order, "", orderHash, address(0), partialAmount, 0, 0, "");

        // Warp past expiry.
        vm.warp(uint256(expiresAt) + 1);

        // Expire releases the unconsumed 60%.
        uint96 expectedUnconsumed = AMOUNT - partialAmount;
        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibTreasuryBuyback.BuybackIntentExpired(
            orderHash, address(token), expectedUnconsumed
        );

        _t().expireBuybackIntent(orderHash);

        assertEq(_t().getBaseBuybackBudget(address(token)), expectedUnconsumed);
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(orderHash);
        assertEq(uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_EXPIRED));
    }

    // ─── isValidSignature ─────────────────────────────────────────

    function test_IsValidSignature_NotValidated_ReturnsInvalid() public {
        // Sub 3.B-style commit (no validation).
        _seedBaseBudget(AMOUNT);
        bytes32 stray = keccak256("unvalidated");
        _t().commitBuybackIntent(
            stray, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );

        // No validated flag → invalid.
        assertEq(_d().isValidSignature(stray, ""), bytes4(0xffffffff));
    }

    function test_IsValidSignature_AfterFinalFill_ReturnsInvalid() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, 1);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, 1, expiresAt
        );

        // Full fill.
        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");
        vpfi.mint(address(diamond), 100e18);
        vm.prank(address(diamond));
        token.transfer(lop, AMOUNT);
        vm.prank(lop);
        _d().postInteraction(order, "", orderHash, address(0), AMOUNT, 0, 0, "");

        // Filled → invalid.
        assertEq(_d().isValidSignature(orderHash, ""), bytes4(0xffffffff));
    }

    // ─── TWAP window admin ───────────────────────────────────────

    function test_SetBuybackTwapMaxWindowSec_HappyPath() public {
        _t().setBuybackTwapMaxWindowSec(900);
        assertEq(_t().getBuybackTwapMaxWindowSec(), 900);
    }

    function test_SetBuybackTwapMaxWindowSec_RevertWhen_BelowMin() public {
        vm.expectRevert();
        _t().setBuybackTwapMaxWindowSec(100); // < 600
    }

    function test_SetBuybackTwapMaxWindowSec_RevertWhen_AboveMax() public {
        vm.expectRevert();
        _t().setBuybackTwapMaxWindowSec(7200); // > 3600
    }

    function test_GetBuybackTwapMaxWindowSec_DefaultsTo1800() public view {
        assertEq(_t().getBuybackTwapMaxWindowSec(), 1800);
    }

    // ─── Round-1 P2 — cumulative VPFI floor ──────────────────────

    function test_PartialFill_CumulativeFloorEnforced() public {
        // Codex round-1 P2 — many small partials with per-partial
        // floor-division would round each requirement to 0 and let
        // total delivered VPFI fall below minVpfiOut. Cumulative
        // check rejects.
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        uint128 minVpfiOut = 100e18;
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _buildTemplate(expiresAt, minVpfiOut);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT, uint256(minVpfiOut), expiresAt
        );

        IOrderMixin.Order memory order;

        // First half — deliver 60 VPFI. Cumulative required for half:
        // floor(100e18 * 500e6 / 1000e6) = 50e18. 60e18 >= 50e18. OK.
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");
        vpfi.mint(address(diamond), 60e18);
        vm.prank(address(diamond));
        token.transfer(lop, AMOUNT / 2);
        vm.prank(lop);
        _d().postInteraction(order, "", orderHash, address(0), AMOUNT / 2, 0, 0, "");

        // Second half — deliver only 30 VPFI. Cumulative required at
        // full consumed: floor(100e18 * 1000e6 / 1000e6) = 100e18.
        // Total delivered: 60 + 30 = 90e18. 90e18 < 100e18 → reject.
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");
        vpfi.mint(address(diamond), 30e18);
        vm.prank(address(diamond));
        token.transfer(lop, AMOUNT / 2);

        vm.prank(lop);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackBelowMinVpfiOut.selector,
                uint256(90e18),
                uint128(100e18)
            )
        );
        _d().postInteraction(order, "", orderHash, address(0), AMOUNT / 2, 0, 0, "");
    }
}
