// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title ITreasuryFeeHost
 * @notice The Diamond-internal entries that move a fee into the treasury and
 *         record its accrual (#2440). `LibFacet.transferFromPayerToTreasury`,
 *         `LibFacet.vaultFeeToTreasury` and `LibFacet.transferToTreasury`
 *         reach them through the Diamond's own fallback, so the measured transfer and the accrual live once,
 *         in {TreasuryFeeFacet}, instead of inside every settlement facet
 *         that charges a fee. Callable only by the Diamond itself.
 */
interface ITreasuryFeeHost {
    /// @notice Collect `amount` of `asset` from `payer`'s wallet into the
    ///         treasury, refused by name unless all of it arrived, and accrue
    ///         it. No-op on zero.
    /// @param payer  The wallet the fee is drawn from (it approved the Diamond).
    /// @param asset  The ERC-20 the fee is paid in.
    /// @param amount The fee.
    function collectFeeFromPayer(address payer, address asset, uint256 amount) external;

    /// @notice Collect `amount` of `asset` from `user`'s vault into the
    ///         treasury and accrue what arrived. Never refuses a short
    ///         delivery. Returns 0 without moving anything when `amount` is 0.
    /// @param user   The vault owner the fee is drawn from.
    /// @param asset  The ERC-20 the fee is paid in.
    /// @param amount The fee requested from the vault.
    /// @return accrued What the treasury received and was credited with.
    function collectFeeFromVault(address user, address asset, uint256 amount)
        external
        returns (uint256 accrued);

    /// @notice Push `amount` of `asset` that the Diamond already holds (a
    ///         treasury share of proceeds it swapped or pulled in) to the
    ///         treasury and accrue what arrived. Never refuses a short
    ///         delivery; refuses only a move that cost the Diamond more than
    ///         `amount`. Where the Diamond is the treasury nothing moves and
    ///         all of `amount` accrues, since the share is already there.
    ///         Returns 0 without moving anything when `amount` is 0.
    /// @param asset  The ERC-20 the fee is paid in.
    /// @param amount The fee the Diamond pushes.
    /// @return accrued What the treasury received and was credited with.
    function collectFeeFromDiamond(address asset, uint256 amount)
        external
        returns (uint256 accrued);
}
