// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "../lib/IERC20.sol";
import {IERC721} from "../lib/IERC721.sol";
import {SafeERC20} from "../lib/SafeERC20.sol";
import {LibDelivery} from "./libraries/LibDelivery.sol";

// Fixture — every way the check must see a raw move, and the ones it must
// not count. The em dash at the start of this line is deliberate: solc's
// offsets count bytes, so a line number read by string index would drift.
contract Raw {
    using SafeERC20 for IERC20;

    function viaUsing(IERC20 t, address to) external {
        t.safeTransfer(to, 1);
    }

    function viaLibrary(IERC20 t, address from) external {
        SafeERC20.safeTransferFrom(t, from, address(this), 1);
    }

    function direct(address t, address to) external {
        IERC20(t).transfer(to, 1);
    }

    function bySelector(address t, address to) external returns (bool ok) {
        (ok, ) = t.call(abi.encodeWithSelector(IERC20.transfer.selector, to, 1));
    }

    function twice(IERC20 t, address to) external {
        t.safeTransfer(to, 1);
        t.safeTransfer(to, 2);
    }

    function nft(address n, address to) external {
        IERC721(n).transferFrom(address(this), to, 1);
    }

    function measured(address t, address to) external {
        LibDelivery.pushOut(t, to, 1);
    }

    function approveOnly(IERC20 t, address spender) external pure {
        SafeERC20.forceApprove(t, spender, 1);
    }

    modifier sweeps(IERC20 t) {
        t.safeTransfer(msg.sender, 1);
        _;
    }

    function guarded(IERC20 t) external sweeps(t) {}
}
