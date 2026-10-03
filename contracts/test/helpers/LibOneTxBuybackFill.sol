// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {IntentDispatchFacet} from "../../src/facets/IntentDispatchFacet.sol";

/**
 * @title  BuybackFillDriver
 * @notice Test-only stand-in for the 1inch Limit Order Protocol's settlement
 *         of ONE buyback fill: pre-interaction, the taker's pull of the source
 *         token, the VPFI delivery and post-interaction, inside a single call.
 *
 * @dev    The buyback path keeps its pre-fill balance snapshot in TRANSIENT
 *         storage, which is correct for the real protocol: the LOP runs both
 *         hooks inside the one fill transaction, so the snapshot exists exactly
 *         as long as the fill. Tests that drove the two hooks as separate
 *         top-level calls only worked while forge kept transient storage
 *         alive across a test's calls. Forge 1.8 clears it between them, so
 *         the post-interaction found no snapshot and reverted
 *         `BuybackPreNotFired`. Driving the fill the way the protocol does is
 *         right on every forge version, rather than depending on one.
 *
 *         Runs AT the LOP's address (see {LibOneTxBuybackFill}), so the hooks
 *         see the caller they gate on and the source pull uses the Diamond's
 *         existing allowance to the LOP. The VPFI is held by the LOP and
 *         transferred in, which leaves the Diamond-balance delta the
 *         post-interaction measures exactly what a mint would have produced.
 *         It keeps no storage, so the LOP's own storage is untouched.
 */
contract BuybackFillDriver {
    function fill(
        IntentDispatchFacet diamond,
        bytes32 orderHash,
        uint256 makingAmount,
        IERC20 sourceToken,
        uint256 pull,
        IERC20 vpfi,
        uint256 deliver
    ) external {
        IOrderMixin.Order memory order;
        diamond.preInteraction(order, "", orderHash, address(0), 0, 0, 0, "");
        if (pull != 0) {
            require(sourceToken.transferFrom(address(diamond), address(this), pull), "pull failed");
        }
        if (deliver != 0) require(vpfi.transfer(address(diamond), deliver), "deliver failed");
        diamond.postInteraction(order, "", orderHash, address(0), makingAmount, 0, 0, "");
    }
}

/**
 * @title  LibOneTxBuybackFill
 * @notice Runs {BuybackFillDriver} at the LOP's address for one call and puts
 *         the LOP's own code back afterwards.
 *
 * @dev    The caller funds the delivery first by minting `deliver` VPFI to
 *         `lop`. An expected revert set immediately before {fill} applies to
 *         the driver call, which bubbles the post-interaction's revert data
 *         unchanged; the code is restored on that path too.
 */
library LibOneTxBuybackFill {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function fill(
        address lop,
        address diamond,
        bytes32 orderHash,
        uint256 makingAmount,
        address sourceToken,
        uint256 pull,
        address vpfi,
        uint256 deliver
    ) internal {
        bytes memory lopCode = lop.code;
        vm.etch(lop, type(BuybackFillDriver).runtimeCode);
        BuybackFillDriver(lop).fill(
            IntentDispatchFacet(diamond),
            orderHash,
            makingAmount,
            IERC20(sourceToken),
            pull,
            IERC20(vpfi),
            deliver
        );
        vm.etch(lop, lopCode);
    }
}
