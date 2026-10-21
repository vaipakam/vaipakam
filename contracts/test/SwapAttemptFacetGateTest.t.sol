// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {ISwapAttemptHost} from "../src/interfaces/ISwapAttemptHost.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  SwapAttemptFacetGateTest
 * @notice #2472: the access gate on {SwapAttemptFacet.swapAttempt}, and its
 *         routing in the Diamond the shared setup builds.
 * @dev    Why this file exists. Before #2472 an adapter attempt ran inline in
 *         the facet that sold, reachable only through that facet's own
 *         entry and its checks. It is now a routed selector the failover
 *         self-calls, and it sells the Diamond's OWN balance of whatever
 *         input token it is handed, through a registered adapter, to a
 *         recipient the caller names. The `address(this)` gate is the only
 *         thing between an outside caller and that balance. Every other cell
 *         reaches the selector only through the facets that sell, so if a
 *         refactor dropped the gate the rest of the suite would stay green
 *         and these cells would not.
 *
 *         Mutations killed: drop or weaken the gate and the outside call sees
 *         a sale instead of `UnauthorizedCrossFacetCall`. The refusal is
 *         straddled by the same call succeeding with the Diamond as the
 *         caller, so the refusal is the gate's and not some other check's.
 */
contract SwapAttemptFacetGateTest is SetupTest {
    uint256 internal constant HELD = 1000 ether;

    address internal attacker;
    address internal sink;

    function setUp() public {
        setupHelper();
        attacker = makeAddr("swap-attempt-attacker");
        sink = makeAddr("swap-attempt-sink");
        // A balance the Diamond holds that a reachable attempt would sell.
        // The setup's 0x proxy mock holds the output side.
        ERC20Mock(mockCollateralERC20).mint(address(diamond), HELD);
    }

    function _sale() internal view returns (LibSwap.Sale memory) {
        return LibSwap.Sale({
            loanId: 0,
            inputToken: mockCollateralERC20,
            outputToken: mockERC20,
            inputAmount: HELD,
            minOutputAmount: 0,
            recipient: sink,
            exactInput: true
        });
    }

    /// @notice The shared setup routes the selector to the facet, so every
    ///         facet that sells through the failover reaches a host.
    function test_SwapAttempt_IsRoutedToItsFacet() public view {
        assertEq(
            IDiamondLoupe(address(diamond)).facetAddress(ISwapAttemptHost.swapAttempt.selector),
            address(swapAttemptFacet)
        );
    }

    /// @notice An outside caller cannot sell the Diamond's balance.
    function test_SwapAttempt_RefusesAnOutsideCaller() public {
        vm.prank(attacker);
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        ISwapAttemptHost(address(diamond)).swapAttempt(_sale(), 0, "");

        assertEq(IERC20(mockCollateralERC20).balanceOf(address(diamond)), HELD, "nothing sold");
        assertEq(IERC20(mockERC20).balanceOf(sink), 0, "nothing delivered");
    }

    /// @notice Straddle: the identical call with the Diamond as the caller
    ///         sells, so the refusal above is the gate's.
    function test_SwapAttempt_RunsForTheDiamondItself() public {
        vm.prank(address(diamond));
        (uint256 out_, uint256 spent) =
            ISwapAttemptHost(address(diamond)).swapAttempt(_sale(), 0, "");

        assertEq(spent, HELD, "the whole input was spent");
        assertEq(IERC20(mockCollateralERC20).balanceOf(address(diamond)), 0);
        assertEq(IERC20(mockERC20).balanceOf(sink), out_, "proceeds reached the recipient");
        assertGt(out_, 0);
    }
}
