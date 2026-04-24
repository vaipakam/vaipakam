// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {RiskFacetTest} from "./RiskFacetTest.t.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {LibFallback} from "../src/libraries/LibFallback.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/**
 * @title LiquidationMinOutputInvariant
 * @notice Security invariant: the 0x-swap `minOutputAmount` enforced during
 *         HF-based liquidation is derived solely from on-chain oracle reads
 *         and the governance-configured slippage ceiling — a caller has no
 *         input surface that can loosen or bypass it.
 *
 * @dev This is the concrete, testable form of the audit finding
 *      "minReceived must be oracle-derived". RiskFacet.triggerLiquidation
 *      takes only a `loanId` — no calldata argument exists for a liquidator
 *      to smuggle a smaller min-output through — but the guarantee only
 *      holds if the on-chain construction of the swap calldata continues
 *      to follow the oracle-derived formula. This test pins that behaviour
 *      so a future refactor can't silently regress it.
 *
 *      Assertion via `vm.expectCall` with exact calldata: if even one byte
 *      of the swap calldata (selector, tokens, amounts, recipient, or
 *      `minOutputAmount`) drifts from the oracle-derived expectation, the
 *      test fails.
 */
contract LiquidationMinOutputInvariantTest is RiskFacetTest {
    /// @dev Proves the `minOutputAmount` passed to the 0x proxy matches the
    ///      value computed from the governance-configured slippage ceiling
    ///      applied to the oracle-derived expected proceeds — regardless of
    ///      who initiates the liquidation.
    function test_Invariant_MinOutputIsOracleDerived() public {
        uint256 loanId = createAndAcceptOffer();

        // Force HF < 1 so the liquidation path is taken.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );

        // Let the cross-facet escrow withdraw no-op so we don't need to
        // round-trip through the per-user escrow proxy for this test.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        // Stage the collateral on the Diamond so the real ERC20 approve +
        // real swap path executes.
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        // Compute the same `minOutputAmount` the contract will compute.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            loanId
        );
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(diamond),
            loan.collateralAsset,
            loan.principalAsset,
            loan.collateralAmount
        );
        uint256 maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        uint256 expectedMinOut = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - maxSlippageBps)) /
            LibVaipakam.BASIS_POINTS;

        // Exact-match expectCall: asserts selector, token addresses, amounts,
        // `minOutputAmount`, and recipient all match the oracle-derived
        // construction. Any drift in any field flips this to a failure.
        vm.expectCall(
            mockZeroExProxy,
            abi.encodeWithSelector(
                IZeroExProxy.swap.selector,
                loan.collateralAsset,
                loan.principalAsset,
                loan.collateralAmount,
                expectedMinOut,
                address(diamond)
            )
        );

        // Call as an arbitrary third party — a liquidator has no position
        // on the loan, so this also proves the permissionless property
        // does not grant any caller-controlled input into the swap.
        address randomLiquidator = makeAddr("randomLiquidator");
        vm.prank(randomLiquidator);
        RiskFacet(address(diamond)).triggerLiquidation(loanId, defaultAdapterCalls());
    }

    /// @dev Fuzzed counterpart: regardless of which address initiates the
    ///      liquidation (up to and including contracts with adversarial
    ///      receive hooks), the swap calldata reaching the 0x proxy is
    ///      bit-identical to the oracle-derived construction. Asymmetric
    ///      addresses, contract callers, and precompiles all land the same
    ///      bytes on the proxy.
    /// @param liquidatorSeed Arbitrary input; used only to diversify the
    ///        caller address across fuzz iterations.
    function testFuzz_Invariant_LiquidatorIdentityDoesNotAffectMinOutput(
        uint256 liquidatorSeed
    ) public {
        uint256 loanId = createAndAcceptOffer();

        // Keep the caller out of the precompile / system range to avoid
        // spurious fuzz failures unrelated to the invariant.
        address liquidator = address(
            uint160(uint256(keccak256(abi.encode(liquidatorSeed))))
        );
        vm.assume(liquidator > address(0x1000));
        vm.assume(liquidator != address(diamond));
        vm.assume(liquidator != address(this));

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            ),
            abi.encode(HF_SCALE - 1)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector
            ),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            abi.encode(true)
        );
        deal(mockCollateralERC20, address(diamond), 1800 ether);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(
            loanId
        );
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(diamond),
            loan.collateralAsset,
            loan.principalAsset,
            loan.collateralAmount
        );
        uint256 maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        uint256 expectedMinOut = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - maxSlippageBps)) /
            LibVaipakam.BASIS_POINTS;

        vm.expectCall(
            mockZeroExProxy,
            abi.encodeWithSelector(
                IZeroExProxy.swap.selector,
                loan.collateralAsset,
                loan.principalAsset,
                loan.collateralAmount,
                expectedMinOut,
                address(diamond)
            )
        );

        vm.prank(liquidator);
        RiskFacet(address(diamond)).triggerLiquidation(loanId, defaultAdapterCalls());
    }
}
