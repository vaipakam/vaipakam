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
import {IOrderMixin} from
    "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";

contract _Stub {}
contract _MockLOP {
    bytes32 public constant DOMAIN_SEPARATOR =
        keccak256("vaipakam.test.lop.priority-router");
}

/// @title BuybackPriorityRouterTest
/// @notice T-087 Sub 3 add-on #472 — priority cascade tests.
///         rewardEmissionsBudget → keeperRewardBudget. #687-C removed the
///         third staking-pool overflow tier; any remainder past both top-up
///         targets now reverts (BuybackOverflowNotAllowed) instead of
///         stranding VPFI in an unspendable budget.
contract BuybackPriorityRouterTest is SetupTest {
    ERC20Mock internal usdc;
    ERC20Mock internal vpfi;
    address internal receiver;
    _MockLOP internal lopContract;
    address internal lop;
    bytes32 internal lopDomain;

    uint96 internal constant AMOUNT_IN = 1_000e6;

    function setUp() public {
        setupHelper();
        vm.warp(1_000_000);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vpfi = new ERC20Mock("VPFI", "VPFI", 18);
        receiver = address(new _Stub());
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

    function _seed() internal {
        usdc.mint(address(diamond), AMOUNT_IN);
        vm.prank(receiver);
        _t().absorbRemittance(address(usdc), AMOUNT_IN, 11_155_111);
    }

    function _build(uint64 expiresAt, uint128 minVpfiOut, uint96 saltUpper)
        internal
        view
        returns (
            LibBuybackOrderValidation.BuybackOrderTemplate memory tpl,
            bytes32 orderHash
        )
    {
        bytes memory ext = LibBuybackOrderValidation.canonicalBuybackExtension(address(diamond));
        // Salt low-160 bits MUST equal the extension hash (LOP v4
        // extension-binding rule); the upper 96 bits are free to vary
        // for uniqueness across multiple commits in one test.
        uint256 salt = (uint256(saltUpper) << 160)
            | uint256(uint160(uint256(keccak256(ext))));
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
            takingAmount: minVpfiOut,
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

    uint96 internal _saltNonce;

    function _commitAndFill(uint256 delivered) internal returns (bytes32) {
        _seed();
        _saltNonce++;
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _build(expiresAt, 1, _saltNonce);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT_IN, 1, expiresAt
        );

        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");
        vm.prank(lop);
        usdc.transferFrom(address(diamond), lop, AMOUNT_IN);
        vpfi.mint(address(diamond), delivered);
        vm.prank(lop);
        _d().postInteraction(order, "", orderHash, address(0), AMOUNT_IN, 0, 0, "");
        return orderHash;
    }

    /// @dev #687-C — like `_commitAndFill` but asserts the final
    ///      `postInteraction` reverts `BuybackOverflowNotAllowed` because the
    ///      delivered VPFI exceeds the rewards + keeper top-up gaps (the former
    ///      staking-pool overflow sink is gone).
    function _commitAndFillExpectOverflow(uint256 delivered) internal {
        _seed();
        _saltNonce++;
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _build(expiresAt, 1, _saltNonce);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT_IN, 1, expiresAt
        );

        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");
        vm.prank(lop);
        usdc.transferFrom(address(diamond), lop, AMOUNT_IN);
        vpfi.mint(address(diamond), delivered);
        vm.prank(lop);
        // Selector-only match — the error carries (delivered, toRewards,
        // toKeepers, overflow) args that vary per test config.
        vm.expectPartialRevert(LibTreasuryBuyback.BuybackOverflowNotAllowed.selector);
        _d().postInteraction(order, "", orderHash, address(0), AMOUNT_IN, 0, 0, "");
    }

    // ─── #687-C: zero targets → any delivery overflows → revert ───

    function test_Routing_ZeroTargets_OverflowReverts() public {
        // Both top-up targets default to 0 (dormant Phase-1 config). A fill
        // that delivers VPFI has no sink — the former staking-pool overflow
        // was removed — so postInteraction reverts BuybackOverflowNotAllowed.
        _commitAndFillExpectOverflow(100e18);

        assertEq(_t().getRewardEmissionsBudget(), 0, "no rewards");
        assertEq(_t().getKeeperRewardBudget(), 0, "no keepers");
    }

    // ─── Both targets filled exactly → no overflow ────────────────

    function test_Routing_BothTargetsFillExactly() public {
        uint256 rewardsTarget = 30e18;
        uint256 keepersTarget = 20e18;
        _t().setRewardEmissionsTopUpTarget(rewardsTarget);
        _t().setKeeperRewardTopUpTarget(keepersTarget);

        // Deliver exactly the sum of the two gaps — no remainder.
        _commitAndFill(rewardsTarget + keepersTarget);

        assertEq(_t().getRewardEmissionsBudget(), rewardsTarget, "rewards full");
        assertEq(_t().getKeeperRewardBudget(), keepersTarget, "keepers full");
    }

    // ─── Overflow past both targets → revert ──────────────────────

    function test_Routing_OverflowPastBothTargets_Reverts() public {
        _t().setRewardEmissionsTopUpTarget(30e18);
        _t().setKeeperRewardTopUpTarget(20e18);

        // 50 fills both gaps; the extra 1 has nowhere to go → revert.
        _commitAndFillExpectOverflow(51e18);
    }

    // ─── Rewards step partially exhausts the delivery ─────────────

    function test_Routing_PartialCascade_RewardsConsumesAll() public {
        uint256 rewardsTarget = 500e18;
        uint256 keepersTarget = 100e18;
        _t().setRewardEmissionsTopUpTarget(rewardsTarget);
        _t().setKeeperRewardTopUpTarget(keepersTarget);

        uint256 delivered = 200e18; // less than rewards target → no overflow

        _commitAndFill(delivered);

        assertEq(_t().getRewardEmissionsBudget(), delivered, "all to rewards");
        assertEq(_t().getKeeperRewardBudget(), 0, "no keepers");
    }

    // ─── Rewards at target → cascades to keepers (no overflow) ────

    function test_Routing_RewardsAtTarget_SkipsToKeepers() public {
        uint256 rewardsTarget = 30e18;
        uint256 keepersTarget = 20e18;
        _t().setRewardEmissionsTopUpTarget(rewardsTarget);
        _t().setKeeperRewardTopUpTarget(keepersTarget);

        // First fill tops up rewards exactly; keepers still empty.
        _commitAndFill(rewardsTarget);
        assertEq(_t().getRewardEmissionsBudget(), rewardsTarget, "rewards full");
        assertEq(_t().getKeeperRewardBudget(), 0, "keepers still empty");

        // Second fill — rewards at target → all to keepers (exact gap).
        _commitAndFill(keepersTarget);
        assertEq(
            _t().getRewardEmissionsBudget(), rewardsTarget, "rewards unchanged"
        );
        assertEq(_t().getKeeperRewardBudget(), keepersTarget, "keepers full");
    }

    // ─── Sum invariant (rewards + keepers == delivered) ───────────

    function test_Routing_SumInvariant() public {
        _t().setRewardEmissionsTopUpTarget(10e18);
        _t().setKeeperRewardTopUpTarget(5e18);
        uint256 delivered = 15e18; // exactly fills both gaps

        _commitAndFill(delivered);

        uint256 toRewards = _t().getRewardEmissionsBudget();
        uint256 toKeepers = _t().getKeeperRewardBudget();
        assertEq(toRewards + toKeepers, delivered, "sum invariant");
    }

    // ─── Setter access control ────────────────────────────────────

    function test_SetRewardEmissionsTopUpTarget_RevertWhen_NotAdmin() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        _t().setRewardEmissionsTopUpTarget(100e18);
    }

    function test_SetKeeperRewardTopUpTarget_RevertWhen_NotAdmin() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        _t().setKeeperRewardTopUpTarget(100e18);
    }

    function test_SetRewardEmissionsTopUpTarget_ZeroDisables() public {
        _t().setRewardEmissionsTopUpTarget(100e18);
        _t().setRewardEmissionsTopUpTarget(0);
        assertEq(_t().getRewardEmissionsTopUpTarget(), 0);
    }

    // #687-C: test_Routing_StakingPoolCap_WidensWithBuybackBudget removed with
    // the staking pool + its buyback-overflow accumulator (5% yield gone).
}
