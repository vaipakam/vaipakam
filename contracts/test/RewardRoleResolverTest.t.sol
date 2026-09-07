// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/// @notice #1566 closure 3 — the reward-mesh role resolver.
///
///         The role used to be inferred from two fields
///         (`!isCanonicalRewardChain && baseChainId != 0`), which left the
///         non-canonical/no-base case unnamed. That case is not one state but
///         TWO, wanting opposite behaviour:
///
///           - a chain DETACHED from a role has spent delivery backing it can
///             no longer re-earn, so it must fail closed at bound `0`;
///           - a chain that was NEVER configured is a single-chain deploy with
///             no delivery, no residual and no counterparty, and keeps the
///             canonical semantics it has always had.
///
///         Both present identically in the two raw fields. The separating bit
///         is `rewardRoleConfigured`, stamped by the only two sites that can
///         mutate the role.
///
///         This is not a theoretical distinction. When it was implemented,
///         `arb-sepolia` and `bnb-testnet` were both live in the
///         `!canonical && baseChainId == 0` state — so collapsing the two
///         states into a fail-closed `Detached` would have frozen every reward
///         consumer on both chains. The `Unconfigured` assertions below are
///         what hold that open.
contract RewardRoleResolverTest is SetupTest {
    uint8 private constant CANONICAL = 0;
    uint8 private constant MIRROR = 1;
    uint8 private constant UNCONFIGURED = 2;
    uint8 private constant DETACHED = 3;

    uint32 private constant BASE = 84532;

    function setUp() public {
        setupHelper();
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _role() internal view returns (uint8) {
        return _rep().getRewardRole();
    }

    // ─── The enum's wire values are load-bearing ─────────────────────────────

    /// @dev `getRewardRole` returns `uint8`, so an off-chain reader decodes
    ///      positions, not names. Pin them: a reordering of the enum would
    ///      silently re-label every operator dashboard and deploy check that
    ///      consumes this view, turning "Detached" into "Canonical".
    function test_RoleEnumWireValuesArePinned() public pure {
        assertEq(uint8(LibVaipakam.RewardRole.Canonical), CANONICAL);
        assertEq(uint8(LibVaipakam.RewardRole.Mirror), MIRROR);
        assertEq(uint8(LibVaipakam.RewardRole.Unconfigured), UNCONFIGURED);
        assertEq(uint8(LibVaipakam.RewardRole.Detached), DETACHED);
    }

    // ─── The state that must NOT change ──────────────────────────────────────

    /// @dev A freshly deployed Diamond that nobody has configured is
    ///      `Unconfigured` — NOT `Detached`. This is the assertion that keeps
    ///      the two live testnet deployments working.
    function test_FreshDeployIsUnconfiguredNotDetached() public view {
        assertEq(_role(), UNCONFIGURED, "fresh deploy must be Unconfigured");
    }

    // ─── Straddling the boundary in BOTH directions ──────────────────────────

    /// @dev Unconfigured -> Mirror -> Detached. The last leg is the one the
    ///      old predicate could not express: after `setBaseChainId(0)` the two
    ///      raw fields are byte-identical to a fresh deploy, and only the
    ///      stamped bit separates them.
    function test_MirrorDetachesToDetachedNotUnconfigured() public {
        assertEq(_role(), UNCONFIGURED);

        _rep().setBaseChainId(BASE);
        assertEq(_role(), MIRROR, "configured base => Mirror");

        _rep().setBaseChainId(0);
        assertEq(_role(), DETACHED, "detaching must NOT read as Unconfigured");

        // The discriminating evidence: the raw fields now match a fresh
        // deploy exactly, so anything reading only those two would classify
        // this chain as Unconfigured and hand it an unbounded allowance.
        (, , uint32 baseChainId, bool isCanonical, ) =
            _rep().getRewardReporterConfig();
        assertEq(baseChainId, 0, "raw field matches a fresh deploy");
        assertFalse(isCanonical, "raw field matches a fresh deploy");
    }

    /// @dev Canonical -> Detached. The other mutator reaches the same state,
    ///      so it must stamp the same bit. Guarding only one setter is the
    ///      one-fix-two-sites defect this codebase has already booked twice.
    function test_CanonicalDemotionWithNoBaseIsDetached() public {
        _rep().setIsCanonicalRewardChain(true);
        assertEq(_role(), CANONICAL, "canonical flag dominates");

        _rep().setIsCanonicalRewardChain(false);
        assertEq(
            _role(), DETACHED, "demoting with no base must reach Detached"
        );
    }

    /// @dev Leaving `Detached` resolves forward again — the role is not a
    ///      one-way latch, and reattachment must restore Mirror.
    function test_DetachedReattachesToMirror() public {
        _rep().setBaseChainId(BASE);
        _rep().setBaseChainId(0);
        assertEq(_role(), DETACHED);

        _rep().setBaseChainId(BASE);
        assertEq(_role(), MIRROR, "reattachment restores Mirror");
    }

    /// @dev The canonical flag dominates a configured base, in both orders.
    ///      A canonical chain that also carries a `baseChainId` (Base stores
    ///      its own id on some deploys) must never resolve to Mirror.
    function test_CanonicalDominatesAConfiguredBase() public {
        _rep().setBaseChainId(BASE);
        _rep().setIsCanonicalRewardChain(true);
        assertEq(_role(), CANONICAL, "canonical wins over a set base");

        _rep().setIsCanonicalRewardChain(false);
        assertEq(_role(), MIRROR, "and falls back to Mirror, not Detached");
    }

    // ─── The stamp is what carries the distinction ───────────────────────────

    /// @dev Stamping is unconditional, including on a write that does not
    ///      change the role. `setBaseChainId(0)` on a fresh deploy is a no-op
    ///      for the raw fields but IS a configuration act, so the chain leaves
    ///      the never-configured state and fails closed from then on.
    ///
    ///      This is the deliberate reading: an operator who explicitly wrote a
    ///      zero base has configured this chain as having no base, which is
    ///      not the same as never having been asked.
    function test_ExplicitZeroBaseOnFreshDeployIsDetached() public {
        assertEq(_role(), UNCONFIGURED);
        _rep().setBaseChainId(0);
        assertEq(
            _role(),
            DETACHED,
            "an explicit zero base is a configuration act"
        );
    }
}
