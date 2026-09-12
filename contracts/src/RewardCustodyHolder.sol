// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RewardCustodyHolder — the Diamond-owned custody address for
 *        delivered reward funding (#1566 slice 4, design §5b / §5d)
 *
 * The delivered reward funding a chain holds used to sit in the Diamond's
 * own token balance, next to every other VPFI the Diamond touches — user
 * collateral in transit, grandfathered peg custody, the recycle bucket.
 * Slice 4 moves it to this dedicated address so that "what backs reward
 * payouts" is one balance an observer can read, and so no other path can
 * spend it by accident.
 *
 * **This contract keeps no ledger.** Which part of its balance is live
 * fresh funding, which is recycled, which is a stranded recovery and so on
 * is recorded in Diamond storage (`LibVaipakam.Storage.rewardCustodyRows`),
 * credited and debited only by the Diamond. The holder exposes exactly one
 * mutating surface — {release} — and only the Diamond can call it. Keeping
 * the ledger out of the holder is what makes the holder replaceable at any
 * size: a successor is deployed, the whole balance moves in one call, the
 * Diamond's pointer flips in the same transaction, and the ledger (untouched)
 * now describes the new custody. Nothing unbounded is ever copied.
 *
 * @dev Deliberately NOT upgradeable, unlike the project's other non-Diamond
 *      contracts. The replacement ceremony above IS the upgrade lever, and a
 *      proxy in front of a custody balance would add an admin surface the
 *      design does not need. `DIAMOND` is immutable for the same reason: the
 *      only party that may move value out is fixed at construction, so a
 *      holder can never be re-pointed at a different controller.
 *
 *      The token is a call parameter rather than an immutable. The identity
 *      of the VPFI token a deployment recognises lives in Diamond storage
 *      (`s.vpfiToken`, set through `VPFITokenFacet`) and is the Diamond's to
 *      decide; the holder does not carry a second copy that could drift from
 *      it. Only the Diamond can call {release}, so the parameter widens
 *      nothing: whatever the Diamond may move, it moves under its own gate.
 */
contract RewardCustodyHolder {
    using SafeERC20 for IERC20;

    /// @notice The only address allowed to move value out of this holder.
    address public immutable DIAMOND;

    /// @notice A release was executed by the Diamond.
    /// @param token  The ERC-20 moved.
    /// @param to     The recipient.
    /// @param amount The amount moved.
    event RewardCustodyReleased(
        address indexed token,
        address indexed to,
        uint256 amount
    );

    /// @notice The caller is not the bound Diamond.
    error RewardCustodyHolderOnlyDiamond(address caller);
    /// @notice A construction or release parameter was the zero address.
    error RewardCustodyHolderZeroAddress();

    /// @param diamond_ The Vaipakam Diamond this holder answers to.
    constructor(address diamond_) {
        if (diamond_ == address(0)) revert RewardCustodyHolderZeroAddress();
        DIAMOND = diamond_;
    }

    /// @notice Move `amount` of `token` from this holder to `to`.
    /// @dev    Diamond-gated. The Diamond decides the attribution (which
    ///         ledger row the debit comes from) BEFORE calling this; the
    ///         holder only executes the transfer. `SafeERC20` so a
    ///         non-standard token that returns nothing still settles, and a
    ///         token that returns false reverts here rather than reporting
    ///         a move that did not happen.
    /// @param token  The ERC-20 to move.
    /// @param to     The recipient. Zero is refused so a mistaken call cannot
    ///               burn custody.
    /// @param amount The amount to move.
    function release(address token, address to, uint256 amount) external {
        if (msg.sender != DIAMOND) {
            revert RewardCustodyHolderOnlyDiamond(msg.sender);
        }
        if (to == address(0)) revert RewardCustodyHolderZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit RewardCustodyReleased(token, to, amount);
    }
}
