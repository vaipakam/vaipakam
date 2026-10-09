// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {IntentDispatchFacet} from "../../src/facets/IntentDispatchFacet.sol";

/**
 * @title  SwapFillDriver
 * @notice Test-only stand-in for the 1inch Limit Order Protocol's settlement of ONE swap-to-repay
 *         fill, inside a single call: the pre-hook (which, since #1566 slice 3, takes the fill lock
 *         and pulls the lot out of the borrower's vault), the maker-to-taker transfer of the lot,
 *         the taker-to-maker transfer of the principal, and the post-hook (which releases the lock
 *         and settles).
 *
 * @dev    Why one call: the fill lock and the principal baseline live in TRANSIENT storage, which
 *         is right for the real protocol -- the LOP runs both hooks inside one fill -- and newer
 *         forge clears transient storage between a test's top-level calls. Two separately pranked
 *         hooks would meet no lock at the post-hook. The sibling {BuybackFillDriver} does the same
 *         for the buyback arm; for the full LOP fill order, including the taker interaction and the
 *         native branch, use `test/mocks/MockLopFill.sol`.
 *
 *         Runs AT the LOP's address (see {LibOneTxSwapFill}), so the hooks see the caller they gate
 *         on and the lot moves on the Diamond's existing allowance to the LOP. The principal is held
 *         by the LOP and transferred in. It keeps no storage.
 */
contract SwapFillDriver {
    function fill(
        IntentDispatchFacet diamond,
        bytes32 orderHash,
        IERC20 makerAsset,
        uint256 lot,
        address taker,
        IERC20 takerAsset,
        uint256 takingAmount
    ) external {
        IOrderMixin.Order memory order;
        diamond.preInteraction(order, "", orderHash, taker, lot, takingAmount, lot, "");
        require(makerAsset.transferFrom(address(diamond), taker, lot), "maker to taker failed");
        require(takerAsset.transfer(address(diamond), takingAmount), "taker to maker failed");
        diamond.postInteraction(order, "", orderHash, taker, lot, takingAmount, 0, "");
    }
}

/**
 * @title  LibOneTxSwapFill
 * @notice Runs {SwapFillDriver} at the LOP's address for one call and puts the LOP's own code back.
 *
 * @dev    The caller funds the principal first by minting `takingAmount` to `lop`. An expected
 *         revert set immediately before {fill} applies to the driver call, which bubbles the hooks'
 *         revert data unchanged.
 */
library LibOneTxSwapFill {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function fill(
        address lop,
        address diamond,
        bytes32 orderHash,
        address makerAsset,
        uint256 lot,
        address taker,
        address takerAsset,
        uint256 takingAmount
    ) internal {
        bytes memory lopCode = lop.code;
        vm.etch(lop, type(SwapFillDriver).runtimeCode);
        SwapFillDriver(lop).fill(
            IntentDispatchFacet(diamond), orderHash, IERC20(makerAsset), lot, taker, IERC20(takerAsset), takingAmount
        );
        vm.etch(lop, lopCode);
    }
}
