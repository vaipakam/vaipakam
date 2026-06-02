// src/seaport/PrepayTypes.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title PrepayTypes
 * @author Vaipakam Developer Team
 * @notice T-086 Round-5 Block A (Issue #313) — shared struct vocabulary
 *         for the extended N-leg prepay-listing surface. Lives in its
 *         own file so the diamond facet, the canonical order builder
 *         (`LibPrepayOrder`), the recorder interface
 *         (`IListingExecutorRecorder`), and the executor's storage
 *         layout (`CollateralListingExecutor`) can ALL import the
 *         same shape without a library / interface cyclic-import
 *         awkwardness.
 *
 *         Round 5 design ratified at
 *         `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §14.5.
 */

/// @notice Hard cap on the number of marketplace-required fee legs
///         allowed per prepay-collateral listing. Round-5 Block A
///         (#313) sets this at 4 — covering the realistic worst
///         case of OpenSea's protocol fee + up to 3 creator-side
///         recipients for collections with artist splits / DAO
///         shares. The executor's `_assertOrderContent` length
///         cap is `3 + MAX_FEE_LEGS = 7` (3 protocol legs + up to
///         4 fee legs); the facet's posting validations enforce
///         the same bound at sign time. If OpenSea's schedule ever
///         requires more than 4 required legs the cap is lifted in
///         a follow-up. See §14.5 of the design doc.
uint256 constant MAX_FEE_LEGS = 4;

/// @notice One marketplace-required fee leg in a prepay-collateral
///         listing. Borrower-supplied at post time, sourced from
///         OpenSea's Collection API by the dapp.
/// @dev    Packed across 2 storage slots:
///           slot 0: `address recipient` (20B) + `uint96 startAmount` (12B)
///           slot 1: `uint96 endAmount`   (12B) + 20B padding
///
///         `uint96` covers 7.9 × 10^28 wei — vastly above any realistic
///         fee amount in any ERC20. The facet's bounds-checked
///         narrowing casts on input fail-loud on overflow, mirroring
///         the existing `LoanIdOverflow` / `AskPriceOverflow` pattern
///         in {CollateralListingExecutor}.
///
///         For **fixed-price** listings the facet enforces
///         `startAmount == endAmount` so each fee leg flows into a
///         constant `ConsiderationItem`. The `≥` form is reserved
///         for the Dutch posting path (§15.2 / Block B), where
///         Seaport's native interpolation between
///         (`startAmount`, `endAmount`) produces the decayed amount
///         at fill time.
struct FeeLeg {
    address recipient;
    uint96 startAmount;
    uint96 endAmount;
}
