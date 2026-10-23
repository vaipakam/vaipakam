// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @title IAaveV3Pool
/// @notice The one Aave V3 Pool surface the protocol uses: the simple
///         flash-loan entry {FlashLoanLiquidator} needs, and the
///         supply / withdraw / provider reads the productive treasury
///         reserve (`LibTreasuryYield`) needs. Same interface across every
///         chain Aave V3 is deployed on (Ethereum, Arbitrum, Optimism,
///         Base, BNB Chain, Polygon PoS). One declaration, so the two
///         users cannot drift onto different shapes (#965).
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
    // forge-lint: disable-next-line(mixed-case-function)
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);

    /// @notice Supply `amount` of `asset`, crediting aTokens to `onBehalfOf`.
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /// @notice Withdraw `amount` of `asset` to `to`; returns the amount
    ///         withdrawn (`amount`, unless `type(uint256).max` was passed).
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @notice The `PoolAddressesProvider` this Pool was registered by.
    // forge-lint: disable-next-line(mixed-case-function)
    function ADDRESSES_PROVIDER() external view returns (address);
}

/// @title IPoolAddressesProvider
/// @notice Aave V3's registry for one market. Its `getPool()` names the
///         market's canonical Pool proxy, so a Pool whose own provider
///         points back at it is the market's Pool and not a look-alike.
interface IPoolAddressesProvider {
    function getPool() external view returns (address);
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
