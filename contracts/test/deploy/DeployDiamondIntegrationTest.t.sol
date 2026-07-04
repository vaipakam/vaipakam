// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {DiamondFacetNames} from "./DiamondFacetNames.sol";
import {DiamondLoupeFacet} from "../../src/facets/DiamondLoupeFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";

/**
 * @title  DeployDiamondIntegrationTest
 * @notice Issue #72 — the deploy-integration test. Runs the real
 *         `DeployDiamond.run()` end-to-end inside a `forge test` invocation
 *         (env vars stubbed via `vm.setEnv`, addresses.json writes
 *         suppressed via `DEPLOY_SKIP_ARTIFACTS=true`) and asserts the
 *         resulting Diamond against the live loupe — not against a
 *         hand-maintained mirror.
 *
 * @dev    Why this exists, in two findings folded in from the
 *         predeploy-check work (#75):
 *
 *         1. **Selector ownership** — the static `SelectorCoverageTest`
 *            guardrail proves every facet selector is cut into the
 *            Diamond *somewhere*, but it never asserts each selector is
 *            routed to the *correct* facet's address. A cut list could
 *            silently overwrite an earlier facet's selector route and
 *            the static check would still pass. `DeployDiamond.run()`
 *            now contains a per-selector ownership assertion (added in
 *            the same PR as this test) that walks the `cuts[]` array
 *            after diamondCut completes and requires
 *            `loupe.facetAddress(sel) == cut.facetAddress` for every
 *            selector in every cut. This test exercises that assertion
 *            in CI by invoking `run()` directly — so a mis-routed
 *            selector reverts the test, not the testnet deploy.
 *
 *         2. **Derive coverage from the real deploy** — `SelectorCoverageTest`
 *            unions every `_get<Facet>Selectors()` list and checks coverage
 *            against compiled artifact selectors. That is a static check
 *            against the hand-maintained cut lists; it does not exercise
 *            the actual diamondCut. This test does, and additionally walks
 *            the loupe to confirm: facet count matches the cuts array
 *            length, every facet address is non-zero, the diamond is
 *            unpaused, ownership and roles are on the configured admin
 *            (post-handover), and the vault implementation is
 *            initialized.
 *
 *         Three reasons this is in `test/deploy/` and not `test/`:
 *
 *           - It is a deploy-sanity check, not a feature test — pre-deploy
 *             gating (`script/predeploy-check.sh`) runs the
 *             `test/deploy/` suite to validate the pipeline.
 *           - It naturally pairs with `FacetSizeLimitTest` (every facet
 *             under EIP-170) and `SelectorCoverageTest` (every facet's
 *             selectors cut) — together they cover size, coverage, and
 *             routing-ownership.
 *           - The runtime cost is high (one full deploy per test
 *             function), so it sits with the other gating tests rather
 *             than with the per-feature unit tests.
 *
 *         Side-effect safety: `DEPLOY_SKIP_ARTIFACTS=true` suppresses
 *         the Step-7 `addresses.json` writes inside `DeployDiamond.run()`,
 *         so the test does not clobber the committed
 *         `deployments/anvil/addresses.json`. The flag is read with
 *         `vm.envOr(..., false)`, so production deploys (which never set
 *         it) write artifacts as before — no behaviour change on any
 *         testnet or mainnet broadcast.
 *
 * @custom:audit-priority HIGH — touches the actual Diamond construction
 *         path. Drift in `run()` (e.g. someone bypassing the per-selector
 *         ownership assertion to "speed up the script") would be caught
 *         here.
 */
contract DeployDiamondIntegrationTest is Test, DiamondFacetNames {
    // ─── Fixtures ─────────────────────────────────────────────────────

    /// @dev Test-stable deployer key. `vm.addr(1)` gives a deterministic
    ///      EOA the test exercises both with-handover and without:
    ///      `_deploy(adminEqDeployer=true)` keeps deployer==admin (no
    ///      handover branch); `_deploy(adminEqDeployer=false)` sets a
    ///      separate admin address so the handover path executes.
    uint256 internal constant DEPLOYER_KEY = 1;

    /// @dev Anything non-deployer for the with-handover path. Address-3
    ///      keeps the value derivable and distinct from any role-zero.
    address internal constant ADMIN_FOR_HANDOVER = address(0xA11CE);

    /// @dev Treasury address. Distinct from admin so the post-deploy
    ///      `Diamond.treasury() == admin` check would fail loudly if
    ///      AdminFacet.setTreasury() somehow stored the wrong address.
    address internal constant TREASURY = address(0xBEEF);

    // ─── Helpers ──────────────────────────────────────────────────────

    /// @dev Invoke the deploy script's parameterised entry. `adminEqDeployer`
    ///      toggles the post-deploy handover branch: when true, deployer
    ///      keeps every role (anvil / CI single-EOA pattern); when false,
    ///      all roles transfer to `ADMIN_FOR_HANDOVER` and deployer
    ///      renounces them (the testnet / mainnet pattern).
    ///
    ///      Uses `runWith(admin, treasury, deployerKey)` rather than
    ///      `run()` to avoid the env-var race: Foundry runs tests in
    ///      parallel by default, and `vm.setEnv` writes to the PROCESS
    ///      env shared across every thread — two tests calling `run()`
    ///      concurrently with different admins clobber each other's
    ///      `ADMIN_ADDRESS` mid-broadcast. Passing args directly is
    ///      thread-local by construction.
    ///
    ///      `DEPLOY_SKIP_ARTIFACTS` still goes through env (one shared
    ///      string value across every test — no race risk since every
    ///      test wants the same "true"). This skips Step-7
    ///      addresses.json writes so the test does not clobber the
    ///      committed `deployments/anvil/addresses.json`. Production
    ///      deploys never set this; the gate is `vm.envOr(..., false)`.
    function _deploy(bool adminEqDeployer)
        internal
        returns (address diamond, address admin, address deployer)
    {
        deployer = vm.addr(DEPLOYER_KEY);
        admin = adminEqDeployer ? deployer : ADMIN_FOR_HANDOVER;

        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");

        DeployDiamond script = new DeployDiamond();
        script.runWith(admin, TREASURY, DEPLOYER_KEY);
        diamond = script.diamond();
    }

    // ─── 1. End-to-end deploy succeeds ────────────────────────────────

    /// @notice Deploying with `admin == deployer` (no handover) succeeds
    ///         and the resulting Diamond is loupe-walkable.
    /// @dev    This is the anvil / CI single-EOA path. The per-selector
    ///         ownership assertion inside `run()` runs as part of this
    ///         test — a regression in the cut wiring reverts here.
    function test_DeployDiamond_RunSucceeds_SingleEOA() public {
        (address diamond, address admin, address deployer) = _deploy(true);

        assertTrue(diamond != address(0), "diamond not deployed");
        assertEq(admin, deployer, "single-EOA path: admin should equal deployer");
    }

    /// @notice Deploying with `admin != deployer` runs the handover branch
    ///         and the resulting Diamond is owned by admin, not deployer.
    function test_DeployDiamond_RunSucceeds_WithHandover() public {
        (address diamond, address admin, address deployer) = _deploy(false);

        assertTrue(diamond != address(0), "diamond not deployed");
        assertTrue(admin != deployer, "handover path: admin must differ from deployer");

        // ERC-173 ownership transferred to admin.
        assertEq(
            OwnershipFacet(diamond).owner(),
            admin,
            "post-handover owner should be admin"
        );

        // Every role transferred — deployer holds nothing, admin holds all.
        bytes32[] memory roles = LibAccessControl.grantableRoles();
        AccessControlFacet ac = AccessControlFacet(diamond);
        for (uint256 i = 0; i < roles.length; i++) {
            assertTrue(
                ac.hasRole(roles[i], admin),
                "admin should hold every role post-handover"
            );
            assertFalse(
                ac.hasRole(roles[i], deployer),
                "deployer should hold no role post-handover"
            );
        }
    }

    // ─── 2. Facet count + every cut facet present in the loupe ────────

    /// @notice The live diamond's facet count equals the cuts-array length
    ///         from `DeployDiamond.run()` (currently 36 — the value the
    ///         script's own post-cut-2 assertion enforces). Belt-and-
    ///         suspenders for the in-script require so the same property
    ///         is observable from outside the deploy script.
    function test_DeployedDiamond_HasExactCutFacetCount() public {
        (address diamond,,) = _deploy(true);
        string[63] memory names = cutFacetNames();
        uint256 observed = DiamondLoupeFacet(diamond).facetAddresses().length;
        assertEq(
            observed,
            names.length,
            "loupe facet count must equal cutFacetNames().length"
        );
    }

    /// @notice Every facet address registered by the loupe is non-zero
    ///         and has runtime bytecode at that address. A facet that
    ///         compiled but failed to deploy would surface here as a
    ///         zero-code address.
    function test_DeployedDiamond_EveryFacetAddressHasCode() public {
        (address diamond,,) = _deploy(true);
        address[] memory faddrs = DiamondLoupeFacet(diamond).facetAddresses();
        for (uint256 i = 0; i < faddrs.length; i++) {
            assertTrue(faddrs[i] != address(0), "facet address must be non-zero");
            assertGt(faddrs[i].code.length, 0, "facet must have deployed bytecode");
        }
    }

    /// @notice #730 r7 — the legacy single-call terms-bump selectors must NOT be
    ///         routed. Risk-terms changes are now a two-step commit-reveal; a
    ///         routed `bumpRiskTermsVersion()` / `(bytes32)` (re-introduced, or
    ///         left behind by an upgrade that didn't Remove it) would let
    ///         governance advance the version WITHOUT changing the anchor, reviving
    ///         a stale acceptance ack once a user re-affirms only their tier. This
    ///         automated guard makes the legacy path provably unreachable on every
    ///         built diamond (the concrete equivalent of a Remove migration).
    function test_DeployedDiamond_LegacyTermsBumpSelectorsUnrouted() public {
        (address diamond,,) = _deploy(true);
        assertEq(
            DiamondLoupeFacet(diamond).facetAddress(
                bytes4(keccak256("bumpRiskTermsVersion()"))
            ),
            address(0),
            "legacy bumpRiskTermsVersion() must not be routed"
        );
        assertEq(
            DiamondLoupeFacet(diamond).facetAddress(
                bytes4(keccak256("bumpRiskTermsVersion(bytes32)"))
            ),
            address(0),
            "legacy bumpRiskTermsVersion(bytes32) must not be routed"
        );
    }

    // ─── 3. Selector routing — derived from the LIVE diamond ──────────

    /// @notice Every selector the live diamond actually routes resolves
    ///         back to one of the facet addresses the loupe enumerates
    ///         (consistency between `facets()` and `facetAddress(sel)`).
    /// @dev    This is the "derive coverage from the real deploy" check
    ///         (the second of the two #75 findings folded into #72) — the
    ///         routed-selector set is read from the deployed diamond's
    ///         own loupe, not from any hand-maintained mirror. If a future
    ///         refactor broke the bijection between `facets[i].selectors`
    ///         and `facetAddress(selector)`, that mismatch surfaces here.
    function test_DeployedDiamond_AllRoutedSelectorsResolveConsistently()
        public
    {
        (address diamond,,) = _deploy(true);
        DiamondLoupeFacet loupe = DiamondLoupeFacet(diamond);
        DiamondLoupeFacet.Facet[] memory facets = loupe.facets();

        assertEq(
            facets.length,
            cutFacetNames().length,
            "facets() length must equal cutFacetNames().length"
        );

        // For every (facetAddress, selectors[]) pair the loupe enumerates,
        // each selector must resolve to that same facet address via
        // facetAddress(selector). This catches a half-state where one
        // loupe call says facet F owns selector S but the per-selector
        // lookup returns a different address.
        for (uint256 i = 0; i < facets.length; i++) {
            address fAddr = facets[i].facetAddress;
            bytes4[] memory sels = facets[i].functionSelectors;
            for (uint256 j = 0; j < sels.length; j++) {
                assertEq(
                    loupe.facetAddress(sels[j]),
                    fAddr,
                    "selector resolves to a different facet than facets() reports"
                );
            }
        }
    }

    // ─── 4. Post-deploy initialization landed correctly ───────────────

    /// @notice The diamond is unpaused after `run()` completes.
    /// @dev    `VaipakamDiamond.constructor` paused the diamond; Step 5e
    ///         unpauses it. A revert anywhere in Steps 1–5 would leave it
    ///         paused, making this a smoke check that the full init
    ///         sequence reached Step 5e.
    function test_DeployedDiamond_Unpaused() public {
        (address diamond,,) = _deploy(true);
        assertFalse(
            AdminFacet(diamond).paused(),
            "diamond should be unpaused after Step 5e"
        );
    }

    /// @notice Treasury was wired in Step 5b.
    function test_DeployedDiamond_TreasurySet() public {
        (address diamond,,) = _deploy(true);
        assertEq(
            AdminFacet(diamond).getTreasury(),
            TREASURY,
            "treasury address must match TREASURY_ADDRESS env"
        );
    }

    /// @notice Vault implementation was deployed by Step 5c (factory's
    ///         `initializeVaultImplementation`) and surfaces a non-zero
    ///         template address with code.
    function test_DeployedDiamond_VaultImplInitialized() public {
        (address diamond,,) = _deploy(true);
        address impl = VaultFactoryFacet(diamond)
            .getVaipakamVaultImplementationAddress();
        assertTrue(impl != address(0), "vault impl not initialized");
        assertGt(impl.code.length, 0, "vault impl has no code");
    }

    // ─── 5. Skip-artifacts gate is purely opt-in ──────────────────────

    /// @notice Suppressing artifacts in this test does not leak into any
    ///         subsequent forge test invocation: the env var only lives
    ///         for the duration of the current process, and production
    ///         deploys (which never set it) write artifacts as before.
    /// @dev    Sanity-only — documents the invariant that the gate is
    ///         opt-in. `vm.envOr` returns the default (false) when unset.
    function test_SkipArtifactsGate_DefaultsOff() public {
        // Don't set DEPLOY_SKIP_ARTIFACTS. envOr(..., false) returns
        // false. Smoke-test the helper: a missing env var must read as
        // false, not revert.
        bool skip = vm.envOr("DEPLOY_SKIP_ARTIFACTS_UNSET_SENTINEL", false);
        assertFalse(skip, "envOr should return false for an unset key");
    }
}
