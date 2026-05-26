// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";

/// @title TestBase — pure scaffolding inherited by every clean-room test base.
/// @notice Holds the user addresses + the BPS / HF constants that every test
///         needs, and nothing else. NO Diamond, NO facet types, NO mock
///         contracts — those live in higher-level mixins so a narrow test that
///         only needs scaffolding doesn't recompile them.
///
/// @dev The slim-base inheritance chain layers compile-cost atomically:
///        TestBase  →  SetupCore  →  SetupOffers / SetupConfig / ...
///        Every level only adds what its scope strictly needs.
///
///        The existing `contracts/test/SetupTest.t.sol` (815 LOC, 39 facets,
///        inherited by 50 test files) is preserved untouched during the
///        staged migration. This clean-room layer lives alongside it under
///        `contracts/test/setup/` until Stage 5 retires the old monolith.
abstract contract TestBase is Test {
    // ─── Universal addresses ──────────────────────────────────────────────
    /// @dev `owner` is `address(this)` — the test contract. Holds every
    ///      privileged role granted during `AccessControlFacet.initializeAccessControl`.
    address internal owner;

    /// @dev Canonical lender / borrower addresses. Built with `makeAddr`
    ///      so they're reproducible across forks and pranks land cleanly.
    address internal lender;
    address internal borrower;

    // ─── Universal constants ──────────────────────────────────────────────
    /// @dev Matches `LibVaipakam.KYC_THRESHOLD_USD`. Surfaced here so a
    ///      test inheriting only TestBase can assert against the threshold
    ///      without pulling in LibVaipakam.
    uint256 internal constant KYC_THRESHOLD_USD = 2000 * 1e18;

    /// @dev BPS denominator (1/10_000). Used in fee / rate calculations
    ///      across the protocol.
    uint256 internal constant BASIS_POINTS = 10_000;

    /// @dev `LibVaipakam.RENTAL_BUFFER_BPS` mirror — NFT rental tests assert
    ///      against this; cheap to surface universally.
    uint256 internal constant RENTAL_BUFFER_BPS = 500;

    /// @dev `LibVaipakam.MIN_HEALTH_FACTOR` mirror (1.5e18). Loan-init
    ///      tests assert against this in numerous places.
    uint256 internal constant MIN_HEALTH_FACTOR = 150 * 1e16;

    // ─── setUp ────────────────────────────────────────────────────────────
    /// @dev `setUp` chain entry point. Higher bases override and call
    ///      `super.setUp()` to chain through this. C3 linearization keeps
    ///      this exactly-once even when a leaf inherits from multiple
    ///      mixins (e.g. SetupAll inheriting SetupLifecycle + SetupRewards
    ///      + ...).
    function setUp() public virtual {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");
    }
}
