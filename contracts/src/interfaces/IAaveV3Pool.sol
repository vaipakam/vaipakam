// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @title IAaveV3Pool
/// @notice Minimal Aave V3 Pool surface used by
///         {FlashLoanLiquidator} — just the simple flash-loan
///         entry. Same interface across every chain Aave V3 is
///         deployed on (Ethereum, Arbitrum, Optimism, Base, BNB
///         Chain, Polygon PoS).
/// @dev    Aave V3's `flashLoanSimple` is the preferred single-
///         asset flash-loan entry point — it has the lowest gas
///         overhead and no receiver-interface constraint on
///         multi-asset slots. The `params` blob is opaque to Aave;
///         it's whatever calldata the receiver wants its
///         `executeOperation` callback to see. `referralCode` is
///         the Aave-protocol referral identifier; pass `0` for "no
///         referral" — Aave V3 currently doesn't honour referral
///         fees but the field stays in the ABI.
interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @notice Read the per-asset flash-loan premium (in BPS,
    ///         1e4 scale). Aave V3 default is 5 BPS (0.05%); some
    ///         chain deployments tune it lower. Used by the
    ///         keeper-bot's profitability simulation to budget
    ///         the repayment.
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

/// @title IFlashLoanSimpleReceiver
/// @notice Aave V3 receiver interface — required shape for any
///         contract that wants to receive a `flashLoanSimple`
///         payout. The Pool calls `executeOperation` synchronously
///         inside the loan; on return-true the Pool sweeps
///         `amount + premium` back from the receiver via
///         `transferFrom` (the receiver must have approved the
///         Pool for that exact amount before returning).
/// @dev    Aave validates `initiator == address(this)` is NOT a
///         security check — the security comes from the Pool
///         calling only after a deposit, so an attacker can't
///         spoof. The receiver checks `msg.sender == pool` and
///         `initiator == address(this)` to harden against
///         someone-else-calling-our-callback attacks.
interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}
