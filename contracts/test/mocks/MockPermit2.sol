// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ISignatureTransfer} from "../../src/libraries/LibPermit2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockPermit2
 * @notice Test-only stand-in for Uniswap's Permit2 at the canonical
 *         address. Skips signature verification — tests just verify
 *         that Vaipakam's Permit2 paths call this contract with the
 *         expected arguments and that the pull moves tokens from the
 *         owner (who approves the mock directly in the test) to the
 *         requested `to`. Full signature-flow coverage belongs in a
 *         fork test against real Permit2 once one is fixtured; this
 *         mock is enough to prove the wiring.
 *
 * @dev Install at the canonical Permit2 address in `setUp()`:
 *        vm.etch(
 *          0x000000000022D473030F116dDEE9F6B43aC78BA3,
 *          address(new MockPermit2()).code
 *        );
 *      Subsequent calls to `LibPermit2.pull(...)` then route through
 *      the mock's `permitTransferFrom`, which performs a plain
 *      `safeTransferFrom(owner, to, requested)` — so the owner just
 *      needs to have pre-approved the canonical address via
 *      `IERC20.approve(PERMIT2, type(uint256).max)` in the test body.
 */
contract MockPermit2 is ISignatureTransfer {
    using SafeERC20 for IERC20;

    // Last-call record for assertions. Tests read these to confirm
    // the facet forwarded the right values.
    PermitTransferFrom public lastPermit;
    SignatureTransferDetails public lastTransferDetails;
    address public lastOwner;
    uint256 public callCount;

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata /* signature */
    ) external override {
        lastPermit = permit;
        lastTransferDetails = transferDetails;
        lastOwner = owner;
        callCount += 1;

        // Execute the transfer so the facet's post-pull assertions
        // (escrow balances, offer state, etc.) behave as they would
        // under real Permit2.
        IERC20(permit.permitted.token).safeTransferFrom(
            owner,
            transferDetails.to,
            transferDetails.requestedAmount
        );
    }

    function nonceBitmap(address, uint256) external pure override returns (uint256) {
        return 0;
    }
}
