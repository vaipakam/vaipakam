// test/SanctionsGateGuardrailTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {FeeLeg} from "../src/seaport/PrepayTypes.sol";

/**
 * @title SanctionsGateGuardrailTest
 * @notice #921 item 2 (#954) — a regression guardrail for the Tier-1 sanctions
 *         gates surfaced by the coverage sweep. #921 item 1 proved the
 *         Tier-1/Tier-2 classification is NOT self-enforcing: a
 *         state-creating / fund-receiving facet method can be added (or lose
 *         its gate in a refactor) and nothing catches it. This pins the
 *         entry-gated Tier-1 methods that the sweep fixed — each must revert
 *         `SanctionedAddress` when the flagged caller hits it. A future edit
 *         that drops one of these gates fails here.
 *
 *         See docs/DesignsAndPlans/SanctionsGateCoverageMatrix.md for the full
 *         classification rule + per-facet matrix. When you add a new
 *         state-creating / fund-receiving facet method, classify it (Tier-1 /
 *         Tier-2 / N/A) per that rule, gate it accordingly, and — if Tier-1
 *         with a caller-side entry screen — extend the curated list below.
 *
 *         Each gate here is the FIRST statement of its function, so the flagged
 *         caller reverts before any argument validation — no valid downstream
 *         state is needed to exercise the screen.
 */
contract SanctionsGateGuardrailTest is SetupTest {
    MockSanctionsList internal oracle;
    address internal sanctioned;

    function setUp() public {
        setupHelper();
        oracle = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
        sanctioned = makeAddr("sanctioned");
        oracle.setFlagged(sanctioned, true);
    }

    /// @dev #954 gap #1 — treasury-backed backstop opt-in must screen the caller.
    function testGuardrail_setOfferBackstopEligible() public {
        vm.prank(sanctioned);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, sanctioned)
        );
        BackstopFacet(address(diamond)).setOfferBackstopEligible(
            1, uint64(block.timestamp + 1)
        );
    }

    /// @dev #954 gap #2 — discretionary collateral withdrawal must screen the caller.
    function testGuardrail_partialWithdrawCollateral() public {
        vm.prank(sanctioned);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, sanctioned)
        );
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(1, 1);
    }

    /// @dev #954 gap #3 — parallel-sale listing must screen the caller (fee-leg
    ///      recipients are screened too; here the caller screen fires first).
    function testGuardrail_postParallelSaleListing() public {
        FeeLeg[] memory feeLegs = new FeeLeg[](0);
        vm.prank(sanctioned);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, sanctioned)
        );
        OfferParallelSaleFacet(address(diamond)).postParallelSaleListing(
            1, 1, bytes32(0), feeLegs
        );
    }

    /// @dev Sanity: a clean caller is NOT blocked by the sanctions screen (it
    ///      reverts later on the missing/invalid state instead, never
    ///      `SanctionedAddress`). Guards against an over-broad gate.
    function testGuardrail_cleanCallerNotSanctionBlocked() public {
        address clean = makeAddr("clean");
        vm.prank(clean);
        // Any revert EXCEPT SanctionedAddress is acceptable — the point is the
        // sanctions screen does not fire for an unflagged caller.
        try PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(1, 1) {
            // no-op: a success is also fine (it means state happened to be valid)
        } catch (bytes memory err) {
            bytes4 sel;
            assembly {
                sel := mload(add(err, 0x20))
            }
            assertTrue(
                sel != LibVaipakam.SanctionedAddress.selector,
                "clean caller must not hit the sanctions screen"
            );
        }
    }
}
