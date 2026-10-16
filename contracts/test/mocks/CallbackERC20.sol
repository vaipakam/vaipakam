// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {ERC20Mock} from "./ERC20Mock.sol";

/**
 * @title  CallbackERC20
 * @notice An ERC-20 that, once armed, makes ONE arbitrary call from inside a matching balance
 *         update -- the shape of an ERC-777-style token hook -- and records how that call ended
 *         instead of letting it bubble.
 *
 * @dev    Why: #1566 slice 3 pulls the intent lot out of the borrower's vault inside the fill, and
 *         the design requires a callback-token cell that reenters the Diamond DURING the LOP's
 *         transfers (maker-to-taker, taker-to-maker) and proves the reentry is refused. Recording
 *         the result rather than reverting is what lets one cell assert the exact refusal selector
 *         while the fill around it still completes (or still reverts for its own reason).
 *
 *         The hook fires AFTER the balance update, filtered on `from`/`to` (zero matches any; a
 *         mint has `from == 0`), and disarms itself before calling so it cannot recurse. A non-zero
 *         `caller` pranks the call so it arrives as that party (a borrower, a keeper) rather than as
 *         the token. Test-only: it reaches the cheatcode address directly.
 */
contract CallbackERC20 is ERC20Mock {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Hook {
        address from;
        address to;
        address target;
        address caller;
        bool armed;
        bytes data;
    }

    Hook private _hook;

    /// @notice How many hooked calls have run.
    uint256 public callbacks;
    /// @notice Whether the last hooked call returned without reverting.
    bool public lastCallOk;
    /// @notice The first four bytes of the last hooked call's revert data (zero when it succeeded).
    bytes4 public lastRevertSelector;
    /// @notice The last hooked call's raw return or revert data.
    bytes public lastReturnData;

    event CallbackRan(address indexed target, address indexed caller, bool ok, bytes4 revertSelector);

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20Mock(name_, symbol_, decimals_)
    {}

    /// @notice Arm the one-shot hook.
    /// @param from   Fire only on a transfer from this address (zero: any).
    /// @param to     Fire only on a transfer to this address (zero: any).
    /// @param target The contract the hook calls.
    /// @param caller The `msg.sender` the hooked call arrives with (zero: this token).
    /// @param data   The calldata of the hooked call.
    function arm(address from, address to, address target, address caller, bytes calldata data) external {
        _hook = Hook({from: from, to: to, target: target, caller: caller, armed: true, data: data});
    }

    function disarm() external {
        _hook.armed = false;
    }

    function isArmed() external view returns (bool) {
        return _hook.armed;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        Hook storage h = _hook;
        if (!h.armed) return;
        if (h.from != address(0) && from != h.from) return;
        if (h.to != address(0) && to != h.to) return;
        h.armed = false;
        address target = h.target;
        address caller = h.caller;
        bytes memory data = h.data;
        if (caller != address(0)) VM.prank(caller);
        (bool ok, bytes memory ret) = target.call(data);
        ++callbacks;
        lastCallOk = ok;
        lastReturnData = ret;
        lastRevertSelector = (!ok && ret.length >= 4) ? bytes4(ret) : bytes4(0);
        emit CallbackRan(target, caller, ok, lastRevertSelector);
    }
}
