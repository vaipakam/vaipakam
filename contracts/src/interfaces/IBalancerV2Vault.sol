// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IBalancerV2Vault
/// @notice Minimal Balancer V2 Vault surface used by
///         {FlashLoanLiquidator} as the Aave-V3 fallback flash-loan
///         provider.
/// @dev    Balancer V2's flash-loan is **fee-less** on assets
///         already in the Vault (the protocol charges only its
///         normal swap fee model). That makes it the natural
///         backstop for chains where Aave V3 doesn't list the
///         principal asset or has reached its `flashLoanPremium`
///         cap. The callback shape differs from Aave's:
///         multi-asset arrays + a different receiver interface
///         (`IFlashLoanRecipient`).
interface IBalancerV2Vault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

/// @title IFlashLoanRecipient
/// @notice Balancer V2 callback interface — required shape for
///         any contract that wants to receive a `flashLoan`.
///         Vault calls `receiveFlashLoan` synchronously inside the
///         loan; receiver must transfer `amount + feeAmount` of
///         each token back to the Vault by the end of the
///         callback (no return-bool, no approve-and-sweep — just
///         direct transfer).
/// @dev    The receiver MUST validate `msg.sender == vault` and
///         (for our use) that the call originated from one of
///         our owner-gated entry points (we use a transient
///         in-flight flag set BEFORE initiating the flash loan
///         and cleared AFTER).
interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}
