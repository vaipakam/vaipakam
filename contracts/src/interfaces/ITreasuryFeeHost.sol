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
    /// @notice What a fee is, for the treasury floor split (#3649 stage 3,
    ///         `ShortfallReserveDesign.md` section 8). Two fees feed the
    ///         reserve: the initiation fee and the treasury share of an
    ///         ERC-20 loan's interest. Each keeps a treasury floor, and the
    ///         part above it is the reserve's. An extension's added
    ///         initiation fee takes no floor and is the reserve's whole.
    ///         Every other fee (rental shares, handling fees, the fallback
    ///         split's treasury share, buffers) is the treasury's whole.
    ///         `Released` is a treasury share that a token refused to
    ///         deliver at settlement (#3669) and that was released later: its
    ///         treasury floor was fixed when the share was parked, from the
    ///         share's own kind, and travels in `base`.
    /// @dev    `Other` is first so a zero value is the treasury-whole case.
    enum FeeKind {
        Other,
        Initiation,
        Interest,
        Extension,
        Released
    }

    /// @notice What a fee leg is and what its floor is measured on (#3649
    ///         stage 3). Built with the constructors in `LibFeeFloor`.
    /// @param kind     What the fee is (the floor split's rule).
    /// @param base     The floor's base: the loan's principal for
    ///                 `Initiation`, the interest the share was taken from
    ///                 for `Interest`, the treasury floor itself (an amount)
    ///                 for `Released`; ignored otherwise.
    /// @param shareBps For `Interest` only: the treasury share of interest
    ///                 the loan was opened with (`treasuryFeeBpsAtInit`,
    ///                 resolved). The floor is capped at half of that share
    ///                 of the interest, so a loan opened at a lower share
    ///                 still sends at least half its undiscounted fee to the
    ///                 reserve after the share and the floor are raised.
    struct FeeBasis {
        FeeKind kind;
        uint256 base;
        uint256 shareBps;
    }

    /// @notice A reserve-feeding fee arrived and was split: `treasuryPart` up
    ///         to the floor, `reservePart` above it. Until a registry names a
    ///         reserve, the reserve part is sent to the treasury as well and
    ///         counted in `getReservePartHeldByTreasury(asset)`. Not emitted
    ///         for `FeeKind.Other`.
    event TreasuryFeeSplit(
        address indexed asset,
        FeeKind indexed kind,
        uint256 treasuryPart,
        uint256 reservePart
    );

    /// @notice Collect `amount` of `asset` from `payer`'s wallet into the
    ///         treasury, refused by name unless all of it arrived, and accrue
    ///         it. No-op on zero.
    /// @param payer  The wallet the fee is drawn from (it approved the Diamond).
    /// @param asset  The ERC-20 the fee is paid in.
    /// @param amount The fee.
    /// @param basis  What the fee is and its floor's base ({FeeBasis}).
    function collectFeeFromPayer(address payer, address asset, uint256 amount, FeeBasis calldata basis)
        external;

    /// @notice Collect `amount` of `asset` from `user`'s vault into the
    ///         treasury and accrue what arrived. Never refuses a short
    ///         delivery. Returns 0 without moving anything when `amount` is 0.
    /// @param user   The vault owner the fee is drawn from.
    /// @param asset  The ERC-20 the fee is paid in.
    /// @param amount The fee requested from the vault.
    /// @param basis  What the fee is and its floor's base ({FeeBasis}).
    /// @return accrued What the treasury received and was credited with.
    function collectFeeFromVault(address user, address asset, uint256 amount, FeeBasis calldata basis)
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
    /// @param basis  What the fee is and its floor's base ({FeeBasis}).
    /// @return accrued What the treasury received and was credited with.
    function collectFeeFromDiamond(address asset, uint256 amount, FeeBasis calldata basis)
        external
        returns (uint256 accrued);
}
