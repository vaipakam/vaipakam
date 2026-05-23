// script/DeployDiamond.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../src/facets/DiamondLoupeFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {PayrollFacet} from "../src/facets/PayrollFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {MetricsDashboardFacet} from "../src/facets/MetricsDashboardFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {StakingRewardsFacet} from "../src/facets/StakingRewardsFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {Deployments} from "./lib/Deployments.sol";

contract DeployDiamond is Script {
    // ── Deployed addresses (logged at the end) ──────────────────────────
    // `public` so the deploy-integration test (Issue #72) can read the
    // built Diamond after calling `run()` — the script's own
    // `Deployments.writeDiamond(...)` artifact path is FS-write and only
    // useful for downstream operator scripts; an in-process test reads
    // the storage var directly.
    address public diamond;
    address public diamondCutFacet;

    /// @notice Operator entry point — reads `ADMIN_ADDRESS`,
    ///         `TREASURY_ADDRESS`, `DEPLOYER_PRIVATE_KEY` from env and
    ///         delegates to `runWith(...)`. Foundry's `forge script
    ///         DeployDiamond --broadcast` invokes this.
    function run() external virtual {
        runWith(
            vm.envAddress("ADMIN_ADDRESS"),
            vm.envAddress("TREASURY_ADDRESS"),
            vm.envUint("DEPLOYER_PRIVATE_KEY")
        );
    }

    /// @notice Parameterised entry point — same deploy logic, but admin /
    ///         treasury / deployer-key are passed directly instead of read
    ///         from env vars.
    /// @dev    Issue #72 — env-var-driven invocation races under Foundry's
    ///         default-parallel test runner (`vm.setEnv` writes to the
    ///         PROCESS env, shared across every test thread, so two tests
    ///         calling `run()` concurrently with different admins can
    ///         clobber each other's `ADMIN_ADDRESS` mid-broadcast). The
    ///         deploy-integration test calls `runWith(...)` directly to
    ///         pass admin / treasury / deployer-key as Solidity args — no
    ///         env-var round-trip, no parallel-test race. Production
    ///         `forge script` invocations keep using `run()` and are
    ///         unaffected.
    function runWith(
        address admin,
        address treasury,
        uint256 deployerKey
    ) public virtual {
        address deployerAddr = vm.addr(deployerKey);

        console.log("=== Vaipakam Diamond Deployment ===");
        console.log("Admin:   ", admin);
        console.log("Treasury:", treasury);
        console.log("Deployer:", deployerAddr);

        vm.startBroadcast(deployerKey);

        // ── Step 1: Deploy all facets ───────────────────────────────────
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        DiamondLoupeFacet loupeFacet = new DiamondLoupeFacet();
        OwnershipFacet ownershipFacet = new OwnershipFacet();
        AccessControlFacet accessControlFacet = new AccessControlFacet();
        AdminFacet adminFacet = new AdminFacet();
        ProfileFacet profileFacet = new ProfileFacet();
        OracleFacet oracleFacet = new OracleFacet();
        OracleAdminFacet oracleAdminFacet = new OracleAdminFacet();
        VaipakamNFTFacet nftFacet = new VaipakamNFTFacet();
        VaultFactoryFacet vaultFactoryFacet = new VaultFactoryFacet();
        OfferCreateFacet offerCreateFacet = new OfferCreateFacet();
        OfferAcceptFacet offerAcceptFacet = new OfferAcceptFacet();
        // Range Orders Phase 1 EIP-170 split: matchOffers + previewMatch
        // live on a separate facet to keep OfferFacet under the
        // 24576-byte runtime-bytecode ceiling.
        OfferMatchFacet offerMatchFacet = new OfferMatchFacet();
        // Same EIP-170 pressure split out cancelOffer + read views into
        // OfferCancelFacet. Selectors land on the diamond identically;
        // frontend / keeper-bot bindings unaffected by the move.
        OfferCancelFacet offerCancelFacet = new OfferCancelFacet();
        // #193 — in-place offer modification surface. Carved into its
        // own facet for the same EIP-170 reason the cancel + match
        // halves were; selectors land on the diamond identically.
        OfferMutateFacet offerMutateFacet = new OfferMutateFacet();
        LoanFacet loanFacet = new LoanFacet();
        RepayFacet repayFacet = new RepayFacet();
        DefaultedFacet defaultedFacet = new DefaultedFacet();
        RiskFacet riskFacet = new RiskFacet();
        RiskMatchLiquidationFacet riskMatchLiquidationFacet =
            new RiskMatchLiquidationFacet();
        ClaimFacet claimFacet = new ClaimFacet();
        AddCollateralFacet addCollateralFacet = new AddCollateralFacet();
        TreasuryFacet treasuryFacet = new TreasuryFacet();
        PayrollFacet payrollFacet = new PayrollFacet();
        EarlyWithdrawalFacet earlyWithdrawalFacet = new EarlyWithdrawalFacet();
        PartialWithdrawalFacet partialWithdrawalFacet = new PartialWithdrawalFacet();
        PrecloseFacet precloseFacet = new PrecloseFacet();
        RefinanceFacet refinanceFacet = new RefinanceFacet();
        MetricsFacet metricsFacet = new MetricsFacet();
        MetricsDashboardFacet metricsDashboardFacet = new MetricsDashboardFacet();
        VPFITokenFacet vpfiTokenFacet = new VPFITokenFacet();
        VPFIDiscountFacet vpfiDiscountFacet = new VPFIDiscountFacet();
        StakingRewardsFacet stakingRewardsFacet = new StakingRewardsFacet();
        InteractionRewardsFacet interactionRewardsFacet = new InteractionRewardsFacet();
        RewardReporterFacet rewardReporterFacet = new RewardReporterFacet();
        RewardAggregatorFacet rewardAggregatorFacet = new RewardAggregatorFacet();
        ConfigFacet configFacet = new ConfigFacet();
        // LegalFacet — Phase 4.1 Terms-of-Service acceptance gate. The
        // gate stays disabled until governance writes a non-zero
        // `currentTosVersion` via `LegalFacet.setCurrentTos`; cutting
        // the facet now keeps that surface reachable on the deployed
        // Diamond instead of leaving it as dead code.
        LegalFacet legalFacet = new LegalFacet();

        console.log("All 35 facets deployed.");

        // ── Step 2: Deploy Diamond ──────────────────────────────────────
        // Deployer is the initial ERC-173 owner so it can execute the
        // diamondCut below. If admin != deployer, Step 6 transfers ownership
        // + every role to admin and renounces them from deployer, leaving
        // the post-script topology (owner=admin, all roles on admin) matching
        // the Phase-1 runbook.
        VaipakamDiamond vaipakamDiamond = new VaipakamDiamond(
            deployerAddr,
            address(cutFacet)
        );
        diamond = address(vaipakamDiamond);
        diamondCutFacet = address(cutFacet);
        console.log("Diamond deployed at:", diamond);

        // ── Step 3: Build facet cuts ────────────────────────────────────
        // 36 facets (DiamondCutFacet already added by constructor)
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](37);

        cuts[0] = _buildCut(address(loupeFacet), _getLoupeSelectors());
        cuts[1] = _buildCut(address(ownershipFacet), _getOwnershipSelectors());
        cuts[2] = _buildCut(address(accessControlFacet), _getAccessControlSelectors());
        cuts[3] = _buildCut(address(adminFacet), _getAdminSelectors());
        cuts[4] = _buildCut(address(profileFacet), _getProfileSelectors());
        cuts[5] = _buildCut(address(oracleFacet), _getOracleSelectors());
        cuts[6] = _buildCut(address(oracleAdminFacet), _getOracleAdminSelectors());
        cuts[7] = _buildCut(address(nftFacet), _getNFTSelectors());
        cuts[8] = _buildCut(address(vaultFactoryFacet), _getVaultFactorySelectors());
        cuts[9] = _buildCut(address(offerCreateFacet), _getOfferCreateSelectors());
        cuts[10] = _buildCut(address(loanFacet), _getLoanSelectors());
        cuts[11] = _buildCut(address(repayFacet), _getRepaySelectors());
        cuts[12] = _buildCut(address(defaultedFacet), _getDefaultedSelectors());
        cuts[13] = _buildCut(address(riskFacet), _getRiskSelectors());
        cuts[14] = _buildCut(address(claimFacet), _getClaimSelectors());
        cuts[15] = _buildCut(address(addCollateralFacet), _getAddCollateralSelectors());
        cuts[16] = _buildCut(address(treasuryFacet), _getTreasurySelectors());
        cuts[17] = _buildCut(address(earlyWithdrawalFacet), _getEarlyWithdrawalSelectors());
        cuts[18] = _buildCut(address(partialWithdrawalFacet), _getPartialWithdrawalSelectors());
        cuts[19] = _buildCut(address(precloseFacet), _getPrecloseSelectors());
        cuts[20] = _buildCut(address(refinanceFacet), _getRefinanceSelectors());
        cuts[21] = _buildCut(address(metricsFacet), _getMetricsSelectors());
        cuts[22] = _buildCut(address(vpfiTokenFacet), _getVPFITokenSelectors());
        cuts[23] = _buildCut(address(vpfiDiscountFacet), _getVPFIDiscountSelectors());
        cuts[24] = _buildCut(address(stakingRewardsFacet), _getStakingRewardsSelectors());
        cuts[25] = _buildCut(address(interactionRewardsFacet), _getInteractionRewardsSelectors());
        cuts[26] = _buildCut(address(rewardReporterFacet), _getRewardReporterSelectors());
        cuts[27] = _buildCut(address(rewardAggregatorFacet), _getRewardAggregatorSelectors());
        cuts[28] = _buildCut(address(configFacet), _getConfigSelectors());
        cuts[29] = _buildCut(address(legalFacet), _getLegalSelectors());
        cuts[30] = _buildCut(address(offerMatchFacet), _getOfferMatchSelectors());
        cuts[31] = _buildCut(address(offerCancelFacet), _getOfferCancelSelectors());
        cuts[32] = _buildCut(address(metricsDashboardFacet), _getMetricsDashboardSelectors());
        cuts[33] = _buildCut(address(payrollFacet), _getPayrollSelectors());
        cuts[34] = _buildCut(
            address(riskMatchLiquidationFacet),
            _getRiskMatchLiquidationSelectors()
        );
        // Issue #67 — OfferFacet's accept half. The create half is
        // cuts[9]; both replace the former single `offerFacet` cut.
        cuts[35] = _buildCut(
            address(offerAcceptFacet),
            _getOfferAcceptSelectors()
        );
        // #193 — in-place offer modification facet, sibling of the
        // create / accept / cancel / match facets above.
        cuts[36] = _buildCut(
            address(offerMutateFacet),
            _getOfferMutateSelectors()
        );

        // ── Step 4: Execute diamond cut ─────────────────────────────────
        // Split into two halves to stay under Base Sepolia's per-tx
        // gas cap (~18M observed) — a single all-facets cut estimates
        // at ~17M, and forge's default 1.3× multiplier pushes the sent
        // gas-limit over the cap. Two halves @ ~8.5M each, padded to
        // ~11M, land well under. Any chain that can take the single
        // cut will also accept two halves; this is strictly safer.
        uint256 mid = cuts.length / 2;
        IDiamondCut.FacetCut[] memory firstHalf = new IDiamondCut.FacetCut[](mid);
        IDiamondCut.FacetCut[] memory secondHalf = new IDiamondCut.FacetCut[](cuts.length - mid);
        for (uint256 i = 0; i < mid; i++) {
            firstHalf[i] = cuts[i];
        }
        for (uint256 i = mid; i < cuts.length; i++) {
            secondHalf[i - mid] = cuts[i];
        }
        IDiamondCut(diamond).diamondCut(firstHalf, address(0), "");
        console.log("Diamond cut 1/2 complete:", mid, "facets added.");
        // Post-cut-1 sanity: the loupe should now report every facet
        // added in the first half. The constructor-installed
        // DiamondCutFacet is intentionally NOT in `facetAddresses[]`
        // — `VaipakamDiamond.constructor` calls `LibDiamond.diamondCut`
        // with an empty array and then writes the cut selector
        // mapping directly into `selectorToFacetAndPosition` without
        // touching the loupe-visible registry. So the count is
        // exactly `mid` here, not `mid + 1`. If a facet write
        // reverted silently inside the cut, the count is off and the
        // in-flight script bails BEFORE dispatching cut-2 (which
        // would otherwise complete and leave a misleadingly-finished
        // broadcast log).
        uint256 expectedAfterCut1 = mid;
        uint256 actualAfterCut1 = DiamondLoupeFacet(diamond)
            .facetAddresses()
            .length;
        require(
            actualAfterCut1 == expectedAfterCut1,
            "DeployDiamond: cut 1/2 did not register all facets"
        );

        IDiamondCut(diamond).diamondCut(secondHalf, address(0), "");
        console.log("Diamond cut 2/2 complete:", cuts.length - mid, "facets added.");
        // Post-cut-2 sanity: every facet added across both cuts must
        // now be loupe-visible. The DiamondCutFacet stays out of
        // `facetAddresses[]` (constructor-installed, not cut), so the
        // expected loupe count is exactly `cuts.length`. The selector
        // for `diamondCut` itself is still callable; it just isn't
        // enumerated by the loupe walk.
        uint256 expectedAfterCut2 = cuts.length;
        uint256 actualAfterCut2 = DiamondLoupeFacet(diamond)
            .facetAddresses()
            .length;
        require(
            actualAfterCut2 == expectedAfterCut2,
            "DeployDiamond: cut 2/2 did not register all facets"
        );

        // Issue #72 — per-selector ownership assertion. The count check
        // above only proves "N distinct facet addresses are registered";
        // it would still pass if any selector got mis-routed (e.g. two
        // facets share a selector and the second cut overwrote the
        // first's route silently). Walk `cuts[]` — the source of truth
        // for what we just dispatched — and assert each selector resolves
        // on the live diamond to *that cut's* facet address. Catches:
        //   - Selector collisions where the later cut clobbered an
        //     earlier facet's selector without any per-cut revert.
        //   - A facet that compiled but whose runtime bytecode didn't
        //     register the expected selector set (impossible in well-
        //     formed Solidity, but the assertion is cheap and the failure
        //     mode silent without it).
        //   - Drift between the script's `_getXSelectors()` list and the
        //     actual on-chain routing (catches mismatches that the static
        //     SelectorCoverageTest would miss when run against the live
        //     deploy rather than its mirror).
        //
        // O(total selectors) — same loop the diamondCut itself walked,
        // run again as read-only loupe queries against the just-built
        // diamond. Reverts the entire broadcast if any selector is
        // mis-routed; no half-state is persisted because Foundry rolls
        // back the broadcast on require failure.
        DiamondLoupeFacet loupe = DiamondLoupeFacet(diamond);
        for (uint256 i = 0; i < cuts.length; i++) {
            for (uint256 j = 0; j < cuts[i].functionSelectors.length; j++) {
                bytes4 sel = cuts[i].functionSelectors[j];
                address routed = loupe.facetAddress(sel);
                require(
                    routed == cuts[i].facetAddress,
                    "DeployDiamond: selector routed to wrong facet"
                );
            }
        }

        // ── Step 5: Post-deployment initialization ──────────────────────
        // 5a. Initialize access control (grants all roles to admin)
        AccessControlFacet(diamond).initializeAccessControl();
        console.log("AccessControl initialized.");

        // 5b. Set treasury address
        AdminFacet(diamond).setTreasury(treasury);
        console.log("Treasury set:", treasury);

        // 5c. Initialize vault implementation (deploys template)
        VaultFactoryFacet(diamond).initializeVaultImplementation();
        console.log("Vault implementation initialized.");

        // 5d. Initialize NFT metadata
        VaipakamNFTFacet(diamond).initializeNFT();
        console.log("NFT initialized.");

        // 5e. Unpause the protocol. The Diamond is born paused (see
        //     `VaipakamDiamond.constructor` — `LibPausable.pause()` is
        //     the last constructor write) so the half-cut window
        //     between `diamondCut 1/2` and `diamondCut 2/2` cannot be
        //     exploited via half-2 selectors. By this point every
        //     facet in `cuts` is cut, every init call above has
        //     landed, and the post-cut facet-count assertion
        //     (`actualAfterCut2 == cuts.length`) has passed — safe
        //     to flip the bit back. The deployer holds PAUSER_ROLE
        //     from Step 5a's `initializeAccessControl`, so this call
        //     succeeds without an extra grant. Mainnet operators that
        //     want a multi-eye review window before unpausing can
        //     comment this line out and run a separate manual
        //     `setPaused(false)` after `--phase verify` confirms the
        //     post-cut state.
        AdminFacet(diamond).unpause();
        console.log("Protocol unpaused.");

        // 5f. Enable the canonical-limit-order (GTC) master flags
        //     (Issue #102 / ADR-0010). Each is governance-tunable via
        //     ConfigFacet.set*Enabled and defaults `false` at the
        //     contract level — the kill-switch convention from ADR-0005.
        //     Fresh Vaipakam deploys come up in GTC mode (lender ceiling
        //     / borrower floor, partial-fill both sides, full range on
        //     amount + rate + collateral) by FLIPPING THESE HERE rather
        //     than changing the storage default. Operators that want a
        //     conservative bake on a brand-new deployment can comment
        //     these four lines out and call them manually after a
        //     review window.
        //
        //     The deployer holds ADMIN_ROLE (granted by
        //     initializeAccessControl at Step 5a above), so these calls
        //     succeed before the Step 6 handover.
        ConfigFacet(diamond).setRangeAmountEnabled(true);
        ConfigFacet(diamond).setRangeRateEnabled(true);
        ConfigFacet(diamond).setRangeCollateralEnabled(true);
        ConfigFacet(diamond).setPartialFillEnabled(true);
        console.log("GTC master flags enabled (range amount/rate/collateral + partial-fill).");

        // ── Step 6: Handover to admin (only when admin != deployer) ─────
        // Phase-1 testnet pattern: deployer EOA signs the deploy but the
        // long-lived privileged EOA is a separate admin address. After the
        // handover below, deployer holds NO roles and NO ERC-173 ownership;
        // admin holds DEFAULT_ADMIN + every sub-role + ERC-173 ownership.
        // When admin == deployer (single-EOA anvil / CI setup) this block
        // is a no-op and the deployer retains everything.
        if (admin != deployerAddr) {
            // Single source of truth — the library exposes the canonical
            // role list (Findings 00010). Adding a new role to
            // `LibAccessControl.grantableRoles()` automatically flows
            // here AND through `initializeAccessControl`, so the deploy
            // script can never grant a strict subset of what the
            // library granted (which used to leave roles unowned or on
            // the deployer post-handover).
            bytes32[] memory roles = LibAccessControl.grantableRoles();

            // 6a. Grant every role to admin (deployer holds DEFAULT_ADMIN
            //     from initializeAccessControl above, which is the role
            //     admin for every other role).
            for (uint256 i = 0; i < roles.length; i++) {
                AccessControlFacet(diamond).grantRole(roles[i], admin);
            }
            console.log("All roles granted to admin:", roles.length);

            // 6b. Transfer ERC-173 ownership (gates future diamondCut).
            OwnershipFacet(diamond).transferOwnership(admin);
            console.log("ERC-173 ownership transferred to:", admin);

            // 6c. Renounce every role from deployer. DEFAULT_ADMIN_ROLE
            //     (index 0 by the library's convention) is renounced
            //     LAST so if any earlier step had reverted the deployer
            //     still holds the root admin and can recover.
            for (uint256 i = roles.length; i > 0; i--) {
                AccessControlFacet(diamond).renounceRole(
                    roles[i - 1],
                    deployerAddr
                );
            }
            console.log("Deployer renounced all roles:", roles.length);
        } else {
            console.log("admin == deployer, skipping handover.");
        }

        vm.stopBroadcast();

        // ── Step 7: Persist deployment artifact ─────────────────────────
        // Write the Diamond + vault-impl addresses to
        // `deployments/<chain-slug>/addresses.json`. Every subsequent
        // script (Configure*, Wire*, Upgrade*, seeders, smoke tests)
        // reads from this file via `Deployments.readDiamond()` etc.
        // — operators no longer need to chain-prefix env vars across
        // every follow-on broadcast. The file is committed and is the
        // canonical source of truth post-deploy. Writes happen OUTSIDE
        // the broadcast (no on-chain effect) so a missing FS-write
        // permission only fails the file step, not the deploy.
        //
        // Issue #72 — operator/test escape hatch: set
        // `DEPLOY_SKIP_ARTIFACTS=true` to bypass the addresses.json
        // writes entirely. The deploy-integration test sets this so a
        // `forge test` run can exercise `run()` end-to-end (Steps 1–6
        // including the per-selector ownership assertion above) without
        // clobbering the committed `deployments/anvil/addresses.json`
        // every CI invocation. Also useful for dry-run-style local
        // experiments where the operator wants to deploy + inspect the
        // diamond without overwriting the artifact in their working tree.
        if (vm.envOr("DEPLOY_SKIP_ARTIFACTS", false)) {
            console.log("DEPLOY_SKIP_ARTIFACTS=true -- skipping addresses.json writes.");
            return;
        }

        Deployments.writeChainHeader();
        Deployments.writeDiamond(diamond);

        // Issue #69 — record the authoritative facet count into
        // addresses.json so the shell verify phase exact-matches the
        // live diamond against it. This is the single source of truth:
        // no hardcoded facet count drifts in the deploy scripts.
        // Written here, after `vm.stopBroadcast()` and alongside the
        // other artifact writes — never mid-broadcast — so a revert in
        // Step 5/6 can't leave a `.facetCount` that disagrees with the
        // `.diamond` / facet-address keys still describing the prior
        // deploy.
        Deployments.writeUint(".facetCount", cuts.length);

        // Per-chain context that downstream scripts (and the frontend
        // env builder) consume directly from addresses.json:
        //   - chainSlug:   stable identifier matching the directory
        //   - lzEndpoint:  LayerZero V2 EndpointV2 for this chain
        //   - lzEid:       LayerZero V2 endpoint id
        //   - deployBlock: L2 block in which the Diamond proxy was created
        //                  (frontend uses this as the lower-bound for
        //                  log scans — `eth_getLogs(fromBlock=deployBlock)`).
        //                  On Arbitrum chains the EVM `block.number` opcode
        //                  returns the L1 block (sequencer-approximate),
        //                  NOT the L2 block where the deploy actually
        //                  landed. `Deployments.writeDeployBlock()` (no
        //                  arg) reads ArbSys.arbBlockNumber() on Arb
        //                  chains and falls through to block.number
        //                  elsewhere. Do NOT pass block.number directly
        //                  from this script.
        //   - vaultImpl:  per-user UUPS vault template the factory
        //                  clones; surfaced via `getVaipakamVaultImplementationAddress()`
        //   - weth/treasury/admin: shared addresses every operator UI
        //                  cross-references against the .env they hold
        //
        // All of these are stable for the lifetime of this Diamond
        // deploy; rewriting them on each run is idempotent.
        Deployments.writeChainSlug();
        Deployments.writeLzEid(Deployments.lzEidForChain());
        Deployments.writeDeployBlock();
        Deployments.writeVaultImpl(
            VaultFactoryFacet(diamond)
                .getVaipakamVaultImplementationAddress()
        );
        Deployments.writeTreasury(treasury);
        Deployments.writeAdmin(admin);

        // Per-facet addresses — written under `.facets.<key>`. The
        // Diamond proxy is the only address frontend / dApp callers
        // need at runtime, but per-facet addresses are surfaced so
        // explorer-link UIs (PublicDashboard "Transparency" block) can
        // deep-link to the actual implementation contract for each
        // selector group, and so post-deploy upgrade scripts have a
        // stable handle without re-reading the broadcast log.
        Deployments.writeFacet("diamondCutFacet",         address(cutFacet));
        Deployments.writeFacet("diamondLoupeFacet",       address(loupeFacet));
        Deployments.writeFacet("ownershipFacet",          address(ownershipFacet));
        Deployments.writeFacet("accessControlFacet",      address(accessControlFacet));
        Deployments.writeFacet("adminFacet",              address(adminFacet));
        Deployments.writeFacet("profileFacet",            address(profileFacet));
        Deployments.writeFacet("oracleFacet",             address(oracleFacet));
        Deployments.writeFacet("oracleAdminFacet",        address(oracleAdminFacet));
        Deployments.writeFacet("vaipakamNFTFacet",        address(nftFacet));
        Deployments.writeFacet("vaultFactoryFacet",      address(vaultFactoryFacet));
        Deployments.writeFacet("offerCreateFacet",        address(offerCreateFacet));
        Deployments.writeFacet("offerAcceptFacet",        address(offerAcceptFacet));
        Deployments.writeFacet("offerMatchFacet",         address(offerMatchFacet));
        Deployments.writeFacet("offerCancelFacet",        address(offerCancelFacet));
        Deployments.writeFacet("loanFacet",               address(loanFacet));
        Deployments.writeFacet("repayFacet",              address(repayFacet));
        Deployments.writeFacet("defaultedFacet",          address(defaultedFacet));
        Deployments.writeFacet("riskFacet",               address(riskFacet));
        Deployments.writeFacet("riskMatchLiquidationFacet", address(riskMatchLiquidationFacet));
        Deployments.writeFacet("claimFacet",              address(claimFacet));
        Deployments.writeFacet("addCollateralFacet",      address(addCollateralFacet));
        Deployments.writeFacet("treasuryFacet",           address(treasuryFacet));
        Deployments.writeFacet("payrollFacet",            address(payrollFacet));
        Deployments.writeFacet("earlyWithdrawalFacet",    address(earlyWithdrawalFacet));
        Deployments.writeFacet("partialWithdrawalFacet",  address(partialWithdrawalFacet));
        Deployments.writeFacet("precloseFacet",           address(precloseFacet));
        Deployments.writeFacet("refinanceFacet",          address(refinanceFacet));
        Deployments.writeFacet("metricsFacet",            address(metricsFacet));
        Deployments.writeFacet("metricsDashboardFacet",   address(metricsDashboardFacet));
        Deployments.writeFacet("vpfiTokenFacet",          address(vpfiTokenFacet));
        Deployments.writeFacet("vpfiDiscountFacet",       address(vpfiDiscountFacet));
        Deployments.writeFacet("stakingRewardsFacet",     address(stakingRewardsFacet));
        Deployments.writeFacet("interactionRewardsFacet", address(interactionRewardsFacet));
        Deployments.writeFacet("rewardReporterFacet",     address(rewardReporterFacet));
        Deployments.writeFacet("rewardAggregatorFacet",   address(rewardAggregatorFacet));
        Deployments.writeFacet("configFacet",             address(configFacet));
        Deployments.writeFacet("legalFacet",              address(legalFacet));

        console.log(
            "Wrote addresses to deployments/",
            Deployments.chainSlug(),
            "/addresses.json"
        );

        // ── Summary ─────────────────────────────────────────────────────
        console.log("");
        console.log("=== Deployment Summary ===");
        console.log("Diamond:              ", diamond);
        console.log("DiamondCutFacet:      ", address(cutFacet));
        console.log("DiamondLoupeFacet:    ", address(loupeFacet));
        console.log("OwnershipFacet:       ", address(ownershipFacet));
        console.log("AccessControlFacet:   ", address(accessControlFacet));
        console.log("AdminFacet:           ", address(adminFacet));
        console.log("ProfileFacet:         ", address(profileFacet));
        console.log("OracleFacet:          ", address(oracleFacet));
        console.log("OracleAdminFacet:     ", address(oracleAdminFacet));
        console.log("VaipakamNFTFacet:     ", address(nftFacet));
        console.log("VaultFactoryFacet:   ", address(vaultFactoryFacet));
        console.log("OfferCreateFacet:     ", address(offerCreateFacet));
        console.log("OfferAcceptFacet:     ", address(offerAcceptFacet));
        console.log("OfferMatchFacet:      ", address(offerMatchFacet));
        console.log("OfferCancelFacet:     ", address(offerCancelFacet));
        console.log("OfferMutateFacet:     ", address(offerMutateFacet));
        console.log("LoanFacet:            ", address(loanFacet));
        console.log("RepayFacet:           ", address(repayFacet));
        console.log("DefaultedFacet:       ", address(defaultedFacet));
        console.log("RiskFacet:            ", address(riskFacet));
        console.log("RiskMatchLiquidationFacet:", address(riskMatchLiquidationFacet));
        console.log("ClaimFacet:           ", address(claimFacet));
        console.log("AddCollateralFacet:   ", address(addCollateralFacet));
        console.log("TreasuryFacet:        ", address(treasuryFacet));
        console.log("PayrollFacet:         ", address(payrollFacet));
        console.log("EarlyWithdrawalFacet: ", address(earlyWithdrawalFacet));
        console.log("PartialWithdrawalFacet:", address(partialWithdrawalFacet));
        console.log("PrecloseFacet:        ", address(precloseFacet));
        console.log("RefinanceFacet:       ", address(refinanceFacet));
        console.log("MetricsFacet:         ", address(metricsFacet));
        console.log("MetricsDashboardFacet:", address(metricsDashboardFacet));
        console.log("VPFITokenFacet:       ", address(vpfiTokenFacet));
        console.log("VPFIDiscountFacet:    ", address(vpfiDiscountFacet));
        console.log("StakingRewardsFacet:  ", address(stakingRewardsFacet));
        console.log("InteractionRewardsFacet:", address(interactionRewardsFacet));
        console.log("RewardReporterFacet:  ", address(rewardReporterFacet));
        console.log("RewardAggregatorFacet:", address(rewardAggregatorFacet));
        console.log("ConfigFacet:          ", address(configFacet));
        console.log("Admin:                ", admin);
        console.log("Treasury:             ", treasury);
        console.log("");
        console.log("!! Cross-chain reward plumbing still requires per-chain wiring:");
        console.log("   - RewardReporterFacet.setRewardOApp / setBaseChainId");
        console.log("   - RewardReporterFacet.setIsCanonicalRewardChain (true only on Base)");
        console.log("   - RewardAggregatorFacet.setExpectedSourceChainIds (Base only)");
        console.log("   See docs/ops/DeploymentRunbook.md section 3.");
    }

    // ── Helper: build a FacetCut struct ─────────────────────────────────
    function _buildCut(
        address facet,
        bytes4[] memory selectors
    ) internal pure returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    // ── Selector arrays (mirrors HelperTest.sol) ────────────────────────

    function _getLoupeSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = bytes4(keccak256("facets()"));
        s[1] = bytes4(keccak256("facetFunctionSelectors(address)"));
        s[2] = bytes4(keccak256("facetAddresses()"));
        s[3] = bytes4(keccak256("facetAddress(bytes4)"));
        s[4] = bytes4(keccak256("supportsInterface(bytes4)"));
    }

    function _getOwnershipSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = OwnershipFacet.transferOwnership.selector;
        s[1] = OwnershipFacet.owner.selector;
    }

    function _getAccessControlSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](15);
        s[0] = AccessControlFacet.initializeAccessControl.selector;
        s[1] = AccessControlFacet.grantRole.selector;
        s[2] = AccessControlFacet.revokeRole.selector;
        s[3] = AccessControlFacet.renounceRole.selector;
        s[4] = AccessControlFacet.hasRole.selector;
        s[5] = AccessControlFacet.getRoleAdmin.selector;
        s[6] = AccessControlFacet.DEFAULT_ADMIN_ROLE.selector;
        s[7] = AccessControlFacet.ADMIN_ROLE.selector;
        s[8] = AccessControlFacet.PAUSER_ROLE.selector;
        s[9] = AccessControlFacet.KYC_ADMIN_ROLE.selector;
        s[10] = AccessControlFacet.ORACLE_ADMIN_ROLE.selector;
        s[11] = AccessControlFacet.RISK_ADMIN_ROLE.selector;
        s[12] = AccessControlFacet.VAULT_ADMIN_ROLE.selector;
        // Hot-path role-revoke for incident response. Distinct from
        // the timelocked `revokeRole` so a Pauser (or other emergency
        // role-holder) can pull a compromised key without waiting
        // 48h. See AccessControlFacet implementation for the role
        // gate that scopes this.
        s[13] = AccessControlFacet.emergencyRevokeRole.selector;
        // Atomic role + ERC-173 ownership handover (Item 3 of the
        // 2026-05-06 rehearsal follow-ups). Replaces the legacy
        // 23-tx grant + transferOwnership + renounce sequence.
        // Gated by `onlyRole(DEFAULT_ADMIN_ROLE)`.
        s[14] = AccessControlFacet.transferAdmin.selector;
    }

    function _getAdminSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](28);
        s[0] = AdminFacet.setTreasury.selector;
        s[1] = AdminFacet.getTreasury.selector;
        s[2] = AdminFacet.setZeroExProxy.selector;
        s[3] = AdminFacet.setallowanceTarget.selector;
        s[4] = AdminFacet.pause.selector;
        s[5] = AdminFacet.unpause.selector;
        s[6] = AdminFacet.paused.selector;
        s[7] = AdminFacet.setKYCEnforcement.selector;
        s[8] = AdminFacet.isKYCEnforcementEnabled.selector;
        s[9] = AdminFacet.pauseAsset.selector;
        s[10] = AdminFacet.unpauseAsset.selector;
        s[11] = AdminFacet.isAssetPaused.selector;
        s[12] = AdminFacet.addSwapAdapter.selector;
        s[13] = AdminFacet.removeSwapAdapter.selector;
        s[14] = AdminFacet.reorderSwapAdapters.selector;
        s[15] = AdminFacet.getSwapAdapters.selector;
        s[16] = AdminFacet.setPancakeswapV3Factory.selector;
        s[17] = AdminFacet.getPancakeswapV3Factory.selector;
        s[18] = AdminFacet.setSushiswapV3Factory.selector;
        s[19] = AdminFacet.getSushiswapV3Factory.selector;
        // Auto-pause primitive (Phase 1 follow-up): WATCHER_ROLE-gated
        // entry that freezes the protocol for
        // `cfgAutoPauseDurationSeconds` while humans investigate. Plus
        // a `pausedUntil` view for the frontend countdown.
        s[20] = AdminFacet.autoPause.selector;
        s[21] = AdminFacet.pausedUntil.selector;
        // Depth-tiered LTV (Piece B follow-up b) — Uni-V2-fork family
        // setters/getters consulted by `OracleFacet.getLiquidityTier`'s
        // route search alongside the V3 trio. Zero ⇒ that leg skipped.
        s[22] = AdminFacet.setUniswapV2Factory.selector;
        s[23] = AdminFacet.getUniswapV2Factory.selector;
        s[24] = AdminFacet.setSushiswapV2Factory.selector;
        s[25] = AdminFacet.getSushiswapV2Factory.selector;
        s[26] = AdminFacet.setPancakeswapV2Factory.selector;
        s[27] = AdminFacet.getPancakeswapV2Factory.selector;
    }

    function _getProfileSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](25);
        s[0] = ProfileFacet.updateKYCStatus.selector;
        s[1] = ProfileFacet.getUserCountry.selector;
        s[2] = ProfileFacet.isKYCVerified.selector;
        s[3] = ProfileFacet.setTradeAllowance.selector;
        s[4] = ProfileFacet.setUserCountry.selector;
        s[5] = ProfileFacet.updateKYCTier.selector;
        s[6] = ProfileFacet.getKYCTier.selector;
        s[7] = ProfileFacet.meetsKYCRequirement.selector;
        s[8] = ProfileFacet.updateKYCThresholds.selector;
        s[9] = ProfileFacet.getKYCThresholds.selector;
        s[10] = ProfileFacet.setKeeperAccess.selector;
        s[11] = ProfileFacet.getKeeperAccess.selector;
        s[12] = ProfileFacet.approveKeeper.selector;
        s[13] = ProfileFacet.revokeKeeper.selector;
        s[14] = ProfileFacet.getApprovedKeepers.selector;
        s[15] = ProfileFacet.setLoanKeeperEnabled.selector;
        s[16] = ProfileFacet.isApprovedKeeper.selector;
        // Phase 6 additions
        s[17] = ProfileFacet.setOfferKeeperEnabled.selector;
        s[18] = ProfileFacet.setKeeperActions.selector;
        s[19] = ProfileFacet.getKeeperActions.selector;
        s[20] = ProfileFacet.isLoanKeeperEnabled.selector;
        s[21] = ProfileFacet.isOfferKeeperEnabled.selector;
        // Phase 4.3 sanctions-screen surface. The oracle is set per
        // chain (Chainalysis-style); when unset the on-chain
        // `isSanctionedAddress` returns false and offer-create /
        // offer-accept simply skip the screen.
        s[22] = ProfileFacet.setSanctionsOracle.selector;
        s[23] = ProfileFacet.getSanctionsOracle.selector;
        s[24] = ProfileFacet.isSanctionedAddress.selector;
    }

    function _getOracleSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](17);
        s[0] = OracleFacet.checkLiquidity.selector;
        s[1] = OracleFacet.getAssetPrice.selector;
        s[2] = OracleFacet.calculateLTV.selector;
        s[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
        s[4] = OracleFacet.getAssetRiskProfile.selector;
        s[5] = OracleFacet.getIlliquidAssets.selector;
        s[6] = OracleFacet.isAssetSupported.selector;
        s[7] = OracleFacet.getSequencerUptimeFeed.selector;
        s[8] = OracleFacet.sequencerHealthy.selector;
        // AnalyticalGettersDesign §3.4 — daily price-snapshot ring
        // buffer for historical TVL reconstruction.
        s[9] = OracleFacet.captureDailyPriceSnapshot.selector;
        s[10] = OracleFacet.getHistoricalAssetPrice.selector;
        // Depth-tiered LTV (Piece B) — the on-chain liquidity-tier
        // authority + the keeper-min effective tier the loan-init LTV
        // cap consults. See
        // docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md §4.2.
        s[11] = OracleFacet.getLiquidityTier.selector;
        s[12] = OracleFacet.getEffectiveLiquidityTier.selector;
        // Phase 2 of AutonomousLtvAndOracleFallback.md — try-wrapped
        // `getAssetPrice` for callers (LibFallback) that need to detect
        // oracle-quorum unavailability without reverting.
        s[13] = OracleFacet.tryGetAssetPrice.selector;
        // Phase 4 of AutonomousLtvAndOracleFallback.md — autonomous
        // tier-LTV cache. Permissionless refresh + the two views the
        // loan-init gate / protocol-console consume.
        s[14] = OracleFacet.refreshTierLtvCache.selector;
        s[15] = OracleFacet.getTierLtvCacheEntry.selector;
        s[16] = OracleFacet.getEffectiveTierMaxInitLtvBps.selector;
    }

    function _getOracleAdminSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](34);
        s[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        s[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        s[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        s[3] = OracleAdminFacet.setWethContract.selector;
        s[4] = OracleAdminFacet.setEthUsdFeed.selector;
        s[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        s[6] = OracleAdminFacet.setStableTokenFeed.selector;
        s[7] = OracleAdminFacet.setSequencerUptimeFeed.selector;
        // Phase 3.1 — per-feed override: tighten staleness or set a
        // minimum-valid-answer floor for a specific Chainlink
        // aggregator. Only ever stricter than the global default;
        // the override never loosens.
        s[8] = OracleAdminFacet.setFeedOverride.selector;
        s[9] = OracleAdminFacet.getFeedOverride.selector;
        // Phase 7b.2 — Soft 2-of-N secondary oracle quorum across
        // Tellor + API3 + DIA. Each address can be unset on chains
        // where the secondary isn't deployed; when EVERY secondary
        // is unavailable the protocol falls back to Chainlink-only
        // (graceful) per OracleFacet._enforceSecondaryQuorum.
        s[10] = OracleAdminFacet.setTellorOracle.selector;
        s[11] = OracleAdminFacet.getTellorOracle.selector;
        s[12] = OracleAdminFacet.setApi3ServerV1.selector;
        s[13] = OracleAdminFacet.getApi3ServerV1.selector;
        s[14] = OracleAdminFacet.setDIAOracleV2.selector;
        s[15] = OracleAdminFacet.getDIAOracleV2.selector;
        s[16] = OracleAdminFacet.setSecondaryOracleMaxDeviationBps.selector;
        s[17] = OracleAdminFacet.getSecondaryOracleMaxDeviationBps.selector;
        s[18] = OracleAdminFacet.setSecondaryOracleMaxStaleness.selector;
        s[19] = OracleAdminFacet.getSecondaryOracleMaxStaleness.selector;
        // Phase 7b.3 — Pyth cross-check + per-knob single-value getters
        // consumed by the protocol-console knob registry.
        s[20] = OracleAdminFacet.setPythOracle.selector;
        s[21] = OracleAdminFacet.getPythOracle.selector;
        s[22] = OracleAdminFacet.setPythCrossCheckFeedId.selector;
        s[23] = OracleAdminFacet.getPythNumeraireFeedId.selector;
        s[24] = OracleAdminFacet.setPythMaxStalenessSeconds.selector;
        s[25] = OracleAdminFacet.getPythMaxStalenessSeconds.selector;
        s[26] = OracleAdminFacet.setPythCrossCheckMaxDeviationBps.selector;
        s[27] = OracleAdminFacet.getPythNumeraireMaxDeviationBps.selector;
        s[28] = OracleAdminFacet.setPythConfidenceMaxBps.selector;
        s[29] = OracleAdminFacet.getPythConfidenceMaxBps.selector;
        // Phase 3 of AutonomousLtvAndOracleFallback.md — per-chain
        // peer-lending-protocol addresses the autonomous tier-LTV cache
        // reads (Aave V3 PoolDataProvider, Compound V3 Comet, Morpho-Blue).
        // Set via owner-only setter; Phase 4 builds the refresh function
        // on top of these addresses.
        s[30] = OracleAdminFacet.setPeerProtocolAddresses.selector;
        s[31] = OracleAdminFacet.getPeerProtocolAddresses.selector;
        // Phase 4 of AutonomousLtvAndOracleFallback.md — per-tier
        // reference asset list (constitution-level governance set).
        s[32] = OracleAdminFacet.setTierReferenceAssets.selector;
        s[33] = OracleAdminFacet.getTierReferenceAssets.selector;
    }

    function _getNFTSelectors() internal pure returns (bytes4[] memory s) {
        // supportsInterface is intentionally omitted — DiamondLoupeFacet owns
        // that selector. _registerNFTInterfaces() writes the ERC-721 / metadata
        // interface IDs into LibDiamond storage so the Loupe's implementation
        // returns true for them.
        s = new bytes4[](29);
        s[0] = VaipakamNFTFacet.mintNFT.selector;
        s[1] = VaipakamNFTFacet.updateNFTStatus.selector;
        s[2] = VaipakamNFTFacet.burnNFT.selector;
        s[3] = VaipakamNFTFacet.tokenURI.selector;
        s[4] = VaipakamNFTFacet.initializeNFT.selector;
        s[5] = bytes4(keccak256("ownerOf(uint256)"));
        s[6] = VaipakamNFTFacet.contractURI.selector;
        s[7] = VaipakamNFTFacet.setContractImageURI.selector;
        s[8] = VaipakamNFTFacet.royaltyInfo.selector;
        s[9] = VaipakamNFTFacet.setDefaultRoyalty.selector;
        // Status-keyed image URI scheme (replaces the prior 4-slot
        // setLoanImageURIs). Granular per-(LoanPositionStatus,
        // isLender) overrides + per-side defaults + a read-back view.
        s[10] = VaipakamNFTFacet.setImageURIForStatus.selector;
        // Native ERC-721 + lock API added in the transfer-lock refactor.
        s[11] = VaipakamNFTFacet.name.selector;
        s[12] = VaipakamNFTFacet.symbol.selector;
        s[13] = VaipakamNFTFacet.balanceOf.selector;
        s[14] = VaipakamNFTFacet.approve.selector;
        s[15] = VaipakamNFTFacet.getApproved.selector;
        s[16] = VaipakamNFTFacet.setApprovalForAll.selector;
        s[17] = VaipakamNFTFacet.isApprovedForAll.selector;
        s[18] = VaipakamNFTFacet.transferFrom.selector;
        // `safeTransferFrom` is overloaded, so we hash the full signatures.
        s[19] = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        s[20] = bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
        s[21] = VaipakamNFTFacet.positionLock.selector;
        // IERC721Enumerable — enumerable without event scans.
        s[22] = bytes4(keccak256("totalSupply()"));
        s[23] = bytes4(keccak256("tokenByIndex(uint256)"));
        s[24] = bytes4(keccak256("tokenOfOwnerByIndex(address,uint256)"));
        s[25] = VaipakamNFTFacet.nftStatusOf.selector;
        // OpenSea `external_url` admin config — sets the base URL
        // emitted in tokenURI's JSON for marketplace deep-links.
        s[26] = VaipakamNFTFacet.setExternalUrlBase.selector;
        // Status-keyed image URI scheme companions:
        s[27] = VaipakamNFTFacet.setDefaultImage.selector;
        s[28] = VaipakamNFTFacet.getImageURIFor.selector;
    }

    function _getVaultFactorySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](31);
        s[0] = VaultFactoryFacet.initializeVaultImplementation.selector;
        s[1] = VaultFactoryFacet.getOrCreateUserVault.selector;
        s[2] = VaultFactoryFacet.upgradeVaultImplementation.selector;
        s[3] = VaultFactoryFacet.vaultDepositERC20.selector;
        s[4] = VaultFactoryFacet.vaultWithdrawERC20.selector;
        s[5] = VaultFactoryFacet.vaultDepositERC721.selector;
        s[6] = VaultFactoryFacet.vaultWithdrawERC721.selector;
        s[7] = VaultFactoryFacet.vaultDepositERC1155.selector;
        s[8] = VaultFactoryFacet.vaultWithdrawERC1155.selector;
        s[9] = VaultFactoryFacet.vaultApproveNFT721.selector;
        s[10] = VaultFactoryFacet.vaultSetNFTUser.selector;
        s[11] = VaultFactoryFacet.vaultGetNFTUserOf.selector;
        s[12] = VaultFactoryFacet.vaultGetNFTUserExpires.selector;
        s[13] = VaultFactoryFacet.getOfferAmount.selector;
        s[14] = VaultFactoryFacet.getVaipakamVaultImplementationAddress.selector;
        s[15] = VaultFactoryFacet.getDiamondAddress.selector;
        s[16] = VaultFactoryFacet.setMandatoryVaultUpgrade.selector;
        s[17] = VaultFactoryFacet.upgradeUserVault.selector;
        s[18] = VaultFactoryFacet.getUserVaultAddress.selector;
        s[19] = VaultFactoryFacet.getVaultVersionInfo.selector;
        s[20] = VaultFactoryFacet.vaultSetNFTUser1155.selector;
        s[21] = VaultFactoryFacet.vaultGetNFTQuantity.selector;
        // T-051 / T-054 — chokepoint deposit + counter-only companions.
        // `vaultDepositERC20From` is the third-party-payer variant
        // RepayFacet uses to pull repayment funds from the borrower
        // into the lender's vault; without this selector cut, every
        // ERC-20 loan repayment reverts with FunctionDoesNotExist.
        s[22] = VaultFactoryFacet.vaultDepositERC20From.selector;
        s[23] = VaultFactoryFacet.recordVaultDepositERC20.selector;
        s[24] = VaultFactoryFacet.getProtocolTrackedVaultBalance.selector;
        // T-054 PR-3 — stuck-token recovery EIP-712 surface.
        s[25] = VaultFactoryFacet.recoverStuckERC20.selector;
        s[26] = VaultFactoryFacet.disown.selector;
        s[27] = VaultFactoryFacet.recoveryDomainSeparator.selector;
        s[28] = VaultFactoryFacet.recoveryAckTextHash.selector;
        s[29] = VaultFactoryFacet.recoveryNonce.selector;
        s[30] = VaultFactoryFacet.vaultBannedSource.selector;
    }

    /// @dev Issue #67 — `OfferFacet` was split into `OfferCreateFacet`
    ///      and `OfferAcceptFacet` for EIP-170 headroom. The former
    ///      `_getOfferSelectors()` seven entries are partitioned across
    ///      the two getters below; selector VALUES are unchanged.
    function _getOfferCreateSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = OfferCreateFacet.createOffer.selector;
        s[1] = OfferCreateFacet.getUserVault.selector;
        // Phase 8b.1 Permit2 addition.
        s[2] = OfferCreateFacet.createOfferWithPermit.selector;
        // Cross-facet entry used by `PrecloseFacet.offsetWithNewOffer`
        // (Option 3) to mint a new lender offer without colliding on
        // the shared diamond reentrancy guard the caller already holds.
        // `address(this)`-only gated inside the facet body.
        s[3] = OfferCreateFacet.createOfferInternal.selector;
    }

    function _getOfferAcceptSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = OfferAcceptFacet.acceptOffer.selector;
        // Phase 8b.1 Permit2 addition.
        s[1] = OfferAcceptFacet.acceptOfferWithPermit.selector;
        // Cross-facet entry point used exclusively by
        // `OfferMatchFacet.matchOffers` to invoke the same
        // `_acceptOffer` plumbing without re-acquiring the shared
        // nonReentrant lock. `address(this)`-only gated inside the
        // facet body — EOAs cannot call it through the fallback.
        s[2] = OfferAcceptFacet.acceptOfferInternal.selector;
        // #196 — contract-side dry-run for the frontend / indexer /
        // keeper. Pure view; mirrors the `_acceptOffer` precondition
        // chain and the `LoanFacet` direct-accept role-aware mapping.
        s[3] = OfferAcceptFacet.previewAccept.selector;
        // `cancelOffer`, `getCompatibleOffers`, `getOffer`, and
        // `getOfferDetails` live on `OfferCancelFacet` — see
        // `_getOfferCancelSelectors`.
    }

    /// @dev OfferMatchFacet — Range Orders Phase 1 bot-driven offer
    ///      matching surface. Carved out of OfferFacet to bring it
    ///      under EIP-170; same selectors, separate facet.
    function _getOfferMatchSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        // `matchOffers` is the write entry bots submit; `previewMatch`
        // is the structured-error view they consult before
        // submitting. Both gated on the `partialFillEnabled` master
        // flag inside the facet body.
        s[0] = OfferMatchFacet.matchOffers.selector;
        s[1] = OfferMatchFacet.previewMatch.selector;
    }

    /// @dev OfferCancelFacet — cancellation + read views carved out of
    ///      `OfferFacet` to bring it under EIP-170. Same selectors,
    ///      separate facet — frontend and keeper-bot bindings
    ///      unaffected by the move.
    function _getOfferCancelSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = OfferCancelFacet.cancelOffer.selector;
        s[1] = OfferCancelFacet.getCompatibleOffers.selector;
        s[2] = OfferCancelFacet.getOffer.selector;
        s[3] = OfferCancelFacet.getOfferDetails.selector;
    }

    /// @dev OfferMutateFacet — #193 in-place modification surface
    ///      (setOfferAmount / setOfferRate / setOfferCollateral +
    ///      combined modifyOffer). Sibling of OfferCancel / OfferMatch.
    function _getOfferMutateSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = OfferMutateFacet.setOfferAmount.selector;
        s[1] = OfferMutateFacet.setOfferRate.selector;
        s[2] = OfferMutateFacet.setOfferCollateral.selector;
        s[3] = OfferMutateFacet.modifyOffer.selector;
    }

    function _getLoanSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = LoanFacet.initiateLoan.selector;
        s[1] = LoanFacet.getLoanDetails.selector;
        s[2] = LoanFacet.getLoanConsents.selector;
        // T-032 — notification-bill writer entry. NOTIF_BILLER_ROLE-gated.
        s[3] = LoanFacet.markNotifBilled.selector;
    }

    function _getRepaySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = RepayFacet.repayLoan.selector;
        s[1] = RepayFacet.repayPartial.selector;
        s[2] = RepayFacet.autoDeductDaily.selector;
        s[3] = RepayFacet.calculateRepaymentAmount.selector;
        // T-034 — Periodic Interest Payment: the permissionless settler
        // entry point plus its two companion views. These were added to
        // RepayFacet in the T-034 PR2 work and wired into HelperTest's
        // test-diamond list, but this production cut list was missed —
        // so a real deploy shipped a Diamond where they revert
        // `FunctionDoesNotExist`. Surfaced by the Issue #71
        // selector-coverage guardrail.
        s[4] = RepayFacet.previewPeriodicSettle.selector;
        s[5] = RepayFacet.nextPeriodCheckpoint.selector;
        s[6] = RepayFacet.settlePeriodicInterest.selector;
    }

    function _getDefaultedSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = DefaultedFacet.triggerDefault.selector;
        s[1] = DefaultedFacet.isLoanDefaultable.selector;
    }

    function _getRiskSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](8);
        s[0] = RiskFacet.updateRiskParams.selector;
        s[1] = RiskFacet.calculateLTV.selector;
        s[2] = RiskFacet.calculateHealthFactor.selector;
        s[3] = RiskFacet.isCollateralValueCollapsed.selector;
        s[4] = RiskFacet.triggerLiquidation.selector;
        // Higher-LTV-aware liquidator (Piece B follow-up — split-route).
        // Sum-to-input multi-route swap via `LibSwap.swapWithSplit`;
        // atomic-revert-on-leg-failure (no soft-failure fallback path).
        s[5] = RiskFacet.triggerLiquidationSplit.selector;
        // Partial HF-restore liquidator (Piece B follow-up — partials).
        // Sweeps only `fractionBps` of remaining collateral, leaves loan
        // Active with reduced size and unchanged maturity. Strict
        // HF-improves + HF>=1 post-mutation gates.
        s[6] = RiskFacet.triggerPartialLiquidation.selector;
        // FlashLoanLiquidationPath.md — liquidator-buys-at-discount.
        // Caller pays `totalDebt` in principal-asset; protocol seizes
        // collateral at per-tier discount and delivers to `recipient`.
        // Master kill-switch `discountPathEnabled` off by default — the
        // selector is wired but the entry-point reverts
        // `DiscountPathDisabled` until governance flips it on per chain.
        s[7] = RiskFacet.triggerLiquidationDiscounted.selector;
    }

    /// @dev Selectors for `RiskMatchLiquidationFacet` — the internal-match
    ///      liquidation cluster extracted from `RiskFacet` (Issue #66) so
    ///      neither facet exceeds the EIP-170 size limit.
    ///        - `triggerInternalMatchLiquidation` — permissionless 2-loan
    ///          or 3-loan internal match. Kill-switch `internalMatchEnabled`
    ///          defaults `false`, so the selector is dormant on a fresh
    ///          deploy.
    ///        - `attemptInternalMatchAutoDispatch` — `onlyDiamondInternal`
    ///          auto-dispatch hook the HF-liquidation / default / claim
    ///          entry points call before falling through to the
    ///          aggregator path. Wired for cross-facet routing; not
    ///          EOA-callable.
    function _getRiskMatchLiquidationSelectors()
        internal
        pure
        returns (bytes4[] memory s)
    {
        s = new bytes4[](2);
        s[0] = RiskMatchLiquidationFacet.triggerInternalMatchLiquidation.selector;
        s[1] = RiskMatchLiquidationFacet.attemptInternalMatchAutoDispatch.selector;
    }

    function _getClaimSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = ClaimFacet.claimAsLender.selector;
        s[1] = ClaimFacet.claimAsBorrower.selector;
        s[2] = ClaimFacet.getClaimableAmount.selector;
        s[3] = ClaimFacet.getClaimable.selector;
        s[4] = ClaimFacet.getBorrowerLifRebate.selector;
        s[5] = ClaimFacet.claimAsLenderWithRetry.selector;
        s[6] = ClaimFacet.getFallbackSnapshot.selector;
    }

    function _getAddCollateralSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = AddCollateralFacet.addCollateral.selector;
    }

    function _getTreasurySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = TreasuryFacet.claimTreasuryFees.selector;
        s[1] = TreasuryFacet.getTreasuryBalance.selector;
        s[2] = TreasuryFacet.mintVPFI.selector;
        s[3] = TreasuryFacet.convertTreasuryAsset.selector;
    }

    function _getPayrollSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](8);
        s[0] = PayrollFacet.createPayrollStream.selector;
        s[1] = PayrollFacet.fundPayrollStream.selector;
        s[2] = PayrollFacet.setPayrollRate.selector;
        s[3] = PayrollFacet.setPayrollStreamPaused.selector;
        s[4] = PayrollFacet.withdrawSalary.selector;
        s[5] = PayrollFacet.getPayrollStream.selector;
        s[6] = PayrollFacet.getWithdrawableSalary.selector;
        s[7] = PayrollFacet.getPayrollStreamCount.selector;
    }

    function _getEarlyWithdrawalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = EarlyWithdrawalFacet.sellLoanViaBuyOffer.selector;
        s[1] = EarlyWithdrawalFacet.createLoanSaleOffer.selector;
        s[2] = EarlyWithdrawalFacet.completeLoanSale.selector;
    }

    function _getPartialWithdrawalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = PartialWithdrawalFacet.partialWithdrawCollateral.selector;
        s[1] = PartialWithdrawalFacet.calculateMaxWithdrawable.selector;
    }

    function _getPrecloseSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = PrecloseFacet.precloseDirect.selector;
        s[1] = PrecloseFacet.offsetWithNewOffer.selector;
        s[2] = PrecloseFacet.completeOffset.selector;
        s[3] = PrecloseFacet.transferObligationViaOffer.selector;
        // Cross-facet entry consumed by `OfferFacet._acceptOffer`'s
        // auto-link block when a third party accepts an offset offer.
        // Same `address(this)`-only gate as `acceptOfferInternal`.
        s[4] = PrecloseFacet.completeOffsetInternal.selector;
    }

    function _getRefinanceSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = RefinanceFacet.refinanceLoan.selector;
    }

    function _getVPFITokenSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](10);
        s[0] = VPFITokenFacet.setVPFIToken.selector;
        s[1] = VPFITokenFacet.getVPFIToken.selector;
        s[2] = VPFITokenFacet.getVPFITotalSupply.selector;
        s[3] = VPFITokenFacet.getVPFICap.selector;
        s[4] = VPFITokenFacet.getVPFICapHeadroom.selector;
        s[5] = VPFITokenFacet.getVPFIMinter.selector;
        s[6] = VPFITokenFacet.getVPFIBalanceOf.selector;
        s[7] = VPFITokenFacet.setCanonicalVPFIChain.selector;
        s[8] = VPFITokenFacet.isCanonicalVPFIChain.selector;
        s[9] = VPFITokenFacet.getVPFISnapshot.selector;
    }

    function _getVPFIDiscountSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](23);
        s[0] = VPFIDiscountFacet.buyVPFIWithETH.selector;
        s[1] = VPFIDiscountFacet.depositVPFIToVault.selector;
        s[2] = VPFIDiscountFacet.quoteVPFIDiscount.selector;
        s[3] = VPFIDiscountFacet.getVPFIBuyConfig.selector;
        s[4] = VPFIDiscountFacet.getVPFISoldTo.selector;
        s[5] = VPFIDiscountFacet.setVPFIBuyRate.selector;
        s[6] = VPFIDiscountFacet.setVPFIBuyCaps.selector;
        s[7] = VPFIDiscountFacet.setVPFIBuyEnabled.selector;
        s[8] = VPFIDiscountFacet.setVPFIDiscountETHPriceAsset.selector;
        s[9] = VPFIDiscountFacet.emitDiscountApplied.selector;
        s[10] = VPFIDiscountFacet.setVPFIDiscountConsent.selector;
        s[11] = VPFIDiscountFacet.getVPFIDiscountConsent.selector;
        s[12] = VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector;
        s[13] = VPFIDiscountFacet.quoteVPFIDiscountFor.selector;
        s[14] = VPFIDiscountFacet.getVPFIDiscountTier.selector;
        s[15] = VPFIDiscountFacet.withdrawVPFIFromVault.selector;
        s[16] = VPFIDiscountFacet.setBridgedBuyReceiver.selector;
        s[17] = VPFIDiscountFacet.getBridgedBuyReceiver.selector;
        s[18] = VPFIDiscountFacet.processBridgedBuy.selector;
        s[19] = VPFIDiscountFacet.quoteFixedRateBuy.selector;
        s[20] = VPFIDiscountFacet.getUserVpfiDiscountState.selector;
        // Phase 8b.1 Permit2 addition.
        s[21] = VPFIDiscountFacet.depositVPFIToVaultWithPermit.selector;
        // #00010 fix — per-(buyer, originChainId) wallet-cap reader. The
        // canonical Diamond debits the cap bucket keyed by origin
        // chain; the frontend reads via this getter so direct buys
        // and bridged buys see consistent remaining-allowance values.
        s[22] = VPFIDiscountFacet.getVPFISoldToByChainId.selector;
    }

    function _getStakingRewardsSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](9);
        s[0] = StakingRewardsFacet.claimStakingRewards.selector;
        s[1] = StakingRewardsFacet.previewStakingRewards.selector;
        s[2] = StakingRewardsFacet.getUserStakedVPFI.selector;
        s[3] = StakingRewardsFacet.getTotalStakedVPFI.selector;
        s[4] = StakingRewardsFacet.getStakingPoolRemaining.selector;
        s[5] = StakingRewardsFacet.getStakingPoolPaidOut.selector;
        s[6] = StakingRewardsFacet.getStakingAPRBps.selector;
        s[7] = StakingRewardsFacet.getStakingSnapshot.selector;
        // Off-chain analytics view: returns the cumulative
        // reward-per-token accumulator without requiring the caller
        // to know a specific user. Used by the staking dashboard for
        // chain-wide accrual rate display.
        s[8] = StakingRewardsFacet.getStakingRewardPerTokenStored.selector;
    }

    function _getInteractionRewardsSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](18);
        s[0] = InteractionRewardsFacet.claimInteractionRewards.selector;
        s[1] = InteractionRewardsFacet.setInteractionLaunchTimestamp.selector;
        s[2] = InteractionRewardsFacet.getInteractionLaunchTimestamp.selector;
        s[3] = InteractionRewardsFacet.getInteractionCurrentDay.selector;
        s[4] = InteractionRewardsFacet.getInteractionAnnualRateBps.selector;
        s[5] = InteractionRewardsFacet.getInteractionHalfPoolForDay.selector;
        s[6] = InteractionRewardsFacet.getInteractionLastClaimedDay.selector;
        s[7] = InteractionRewardsFacet.getInteractionDayEntry.selector;
        s[8] = InteractionRewardsFacet.previewInteractionRewards.selector;
        s[9] = InteractionRewardsFacet.getInteractionPoolRemaining.selector;
        s[10] = InteractionRewardsFacet.getInteractionPoolPaidOut.selector;
        s[11] = InteractionRewardsFacet.getInteractionSnapshot.selector;
        s[12] = InteractionRewardsFacet.getInteractionClaimability.selector;
        s[13] = InteractionRewardsFacet.setInteractionCapVpfiPerEth.selector;
        s[14] = InteractionRewardsFacet.getInteractionCapVpfiPerEth.selector;
        s[15] = InteractionRewardsFacet.getInteractionCapVpfiPerEthRaw.selector;
        s[16] = InteractionRewardsFacet.sweepForfeitedInteractionRewards.selector;
        s[17] = InteractionRewardsFacet.getUserRewardEntries.selector;
    }

    function _getRewardReporterSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](11);
        s[0] = RewardReporterFacet.closeDay.selector;
        s[1] = RewardReporterFacet.onRewardBroadcastReceived.selector;
        s[2] = RewardReporterFacet.setRewardOApp.selector;
        // T-068: `setLocalEid` removed — a chain's own identity is
        // `block.chainid`, no longer a settable endpoint id.
        s[3] = RewardReporterFacet.setBaseChainId.selector;
        s[4] = RewardReporterFacet.setIsCanonicalRewardChain.selector;
        s[5] = RewardReporterFacet.setRewardGraceSeconds.selector;
        s[6] = RewardReporterFacet.getLocalChainInterestNumeraire18.selector;
        s[7] = RewardReporterFacet.getChainReportSentAt.selector;
        s[8] = RewardReporterFacet.getRewardReporterConfig.selector;
        s[9] = RewardReporterFacet.getKnownGlobalInterestNumeraire18.selector;
        // Single-field getter for the protocol-console knob registry.
        s[10] = RewardReporterFacet.getRewardGraceSeconds.selector;
    }

    function _getConfigSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](81);
        // Setters
        s[0] = ConfigFacet.setFeesConfig.selector;
        s[1] = ConfigFacet.setLiquidationConfig.selector;
        s[2] = ConfigFacet.setRiskConfig.selector;
        s[3] = ConfigFacet.setStakingApr.selector;
        s[4] = ConfigFacet.setVpfiTierThresholds.selector;
        s[5] = ConfigFacet.setVpfiTierDiscountBps.selector;
        // Abnormal-market fallback: lender-bonus + treasury bps split
        // applied when every swap adapter fails / under-fills. Default
        // 3% / 2% per LibVaipakam constants, governance-tunable.
        s[6] = ConfigFacet.setFallbackSplit.selector;
        // Getters
        s[7] = ConfigFacet.getFeesConfig.selector;
        s[8] = ConfigFacet.getLiquidationConfig.selector;
        s[9] = ConfigFacet.getRiskConfig.selector;
        s[10] = ConfigFacet.getStakingAprBps.selector;
        s[11] = ConfigFacet.getFallbackSplit.selector;
        s[12] = ConfigFacet.getVpfiTierThresholds.selector;
        s[13] = ConfigFacet.getVpfiTierDiscountBps.selector;
        s[14] = ConfigFacet.getProtocolConfigBundle.selector;
        s[15] = ConfigFacet.getProtocolConstants.selector;
        // Range Orders Phase 1 master kill-switch flags. Default false
        // on a fresh deploy; governance flips them via the setters
        // below. See docs/RangeOffersDesign.md §15 for the staged-
        // enablement rationale (each flag can be toggled
        // independently to roll out range / partial-fill behavior).
        s[16] = ConfigFacet.setRangeAmountEnabled.selector;
        s[17] = ConfigFacet.setRangeRateEnabled.selector;
        s[18] = ConfigFacet.setPartialFillEnabled.selector;
        s[19] = ConfigFacet.getMasterFlags.selector;
        // Range Orders Phase 1 — governance-tunable matcher BPS.
        s[20] = ConfigFacet.setLifMatcherFeeBps.selector;
        // Auto-pause window duration setter (Phase 1 follow-up).
        s[21] = ConfigFacet.setAutoPauseDurationSeconds.selector;
        // Findings 00025 — governance-tunable max loan duration.
        s[22] = ConfigFacet.setMaxOfferDurationDays.selector;
        // T-032 / Numeraire generalization (Phase 1) — notification fee knob (now in
        // numeraire-units) + bundled getter. The per-knob
        // `setNotificationFeeUsdOracle` was retired; the protocol's
        // reference currency is the global numeraireOracle (set via
        // setNumeraire on the T-034 surface).
        s[23] = ConfigFacet.setNotificationFee.selector;
        s[24] = ConfigFacet.getNotificationFeeConfig.selector;
        // Single-field fee getters added for the protocol-console knob
        // schema (which expects per-knob single-value getters; the
        // tuple-returning getFeesConfig doesn't fit). See
        // frontend/src/lib/protocolConsoleKnobs.ts.
        s[25] = ConfigFacet.getTreasuryFeeBps.selector;
        s[26] = ConfigFacet.getLoanInitiationFeeBps.selector;
        s[27] = ConfigFacet.getLifMatcherFeeBps.selector;
        // Single-field master-flag getters (companion of getMasterFlags).
        s[28] = ConfigFacet.getRangeAmountEnabled.selector;
        s[29] = ConfigFacet.getRangeRateEnabled.selector;
        s[30] = ConfigFacet.getPartialFillEnabled.selector;
        // T-044 admin-configurable loan-default grace schedule.
        s[31] = ConfigFacet.setGraceBuckets.selector;
        s[32] = ConfigFacet.clearGraceBuckets.selector;
        s[33] = ConfigFacet.getGraceBuckets.selector;
        s[34] = ConfigFacet.getEffectiveGraceSeconds.selector;
        s[35] = ConfigFacet.getGraceSlotBounds.selector;
        // T-034 Periodic Interest Payment knobs + master kill-switches +
        // per-knob single-value getters consumed by the protocol-console
        // knob registry.
        s[36] = ConfigFacet.setNumeraire.selector;
        s[37] = ConfigFacet.setMinPrincipalForFinerCadence.selector;
        s[38] = ConfigFacet.setPreNotifyDays.selector;
        s[39] = ConfigFacet.setPeriodicInterestEnabled.selector;
        s[40] = ConfigFacet.setNumeraireSwapEnabled.selector;
        s[41] = ConfigFacet.getPeriodicInterestConfig.selector;
        s[42] = ConfigFacet.getNumeraireSymbol.selector;
        s[43] = ConfigFacet.getEthNumeraireFeed.selector;
        s[44] = ConfigFacet.getMinPrincipalForFinerCadence.selector;
        s[45] = ConfigFacet.getPreNotifyDays.selector;
        s[46] = ConfigFacet.getPeriodicInterestEnabled.selector;
        s[47] = ConfigFacet.getNumeraireSwapEnabled.selector;
        // T-048 Predominantly Available Denominator (PAD) — atomic
        // rotation setter + per-asset numeraire-direct override setter
        // + 5 individual getters consumed by the protocol-console
        // knob registry.
        s[48] = ConfigFacet.setPredominantDenominator.selector;
        s[49] = ConfigFacet.setAssetNumeraireDirectFeedOverride.selector;
        s[50] = ConfigFacet.getPredominantDenominator.selector;
        s[51] = ConfigFacet.getPredominantDenominatorSymbol.selector;
        s[52] = ConfigFacet.getEthPadFeed.selector;
        s[53] = ConfigFacet.getPadNumeraireRateFeed.selector;
        s[54] = ConfigFacet.getAssetNumeraireDirectFeedOverride.selector;
        // Depth-tiered LTV (Piece B) — governance globals (all default
        // to library constants until set; the master kill-switch
        // `depthTieredLtvEnabled` defaults false) + the off-chain
        // liquidity-confidence relay write (`setKeeperTier`, KEEPER_ROLE)
        // + the frontend bundle / single-field getters. See
        // docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md §4.2.
        s[55] = ConfigFacet.setDepthTieredLtvEnabled.selector;
        s[56] = ConfigFacet.setLiquiditySlippageBps.selector;
        s[57] = ConfigFacet.setTwapGuard.selector;
        s[58] = ConfigFacet.setLiquidityTierSizes.selector;
        s[59] = ConfigFacet.setTierMaxInitLtvBps.selector;
        s[60] = ConfigFacet.setPaaAssets.selector;
        s[61] = ConfigFacet.setKeeperTier.selector;
        s[62] = ConfigFacet.getDepthTieredLtvEnabled.selector;
        s[63] = ConfigFacet.getPaaAssets.selector;
        s[64] = ConfigFacet.getKeeperTier.selector;
        s[65] = ConfigFacet.getDepthTierConfigBundle.selector;
        // Liquidator hardening (item 2) — close-factor ceiling setter
        // for `RiskFacet.triggerPartialLiquidation`. Default 10_000 = no
        // cap (the keeper picks the smallest fraction that restores
        // HF>=1); governance may tighten to Aave-style 5_000 (50%) etc.
        s[66] = ConfigFacet.setMaxPartialLiquidationCloseFactorBps.selector;
        // Phase 7 of AutonomousLtvAndOracleFallback.md — per-tier
        // LTV safety-box parameters: atomic setter (all three tiers
        // updated in one call so the cross-tier monotonic invariant
        // is never temporarily broken) + bundle getter.
        s[67] = ConfigFacet.setTierLtvParams.selector;
        s[68] = ConfigFacet.getTierLtvParams.selector;
        // FlashLoanLiquidationPath.md — per-tier liquidator-discount
        // governance: master kill-switch + atomic per-tier setter +
        // effective-value bundle view. The kill-switch defaults
        // `false` so a fresh deploy ships with the discount path
        // inert; governance flips on per chain after audit sign-off.
        s[69] = ConfigFacet.setDiscountPathEnabled.selector;
        s[70] = ConfigFacet.setTierLiqDiscountBps.selector;
        s[71] = ConfigFacet.getTierLiqDiscountBps.selector;
        // PR2 of internal-match work (2026-05-14) — per-tier
        // LIQUIDATION threshold setter + view. Replaces the retired
        // per-asset `RiskParams.liqThresholdBps`. See
        // InternalLiquidationLedger.md §0.
        s[72] = ConfigFacet.setTierLiquidationLtvBps.selector;
        s[73] = ConfigFacet.getTierLiquidationLtvBps.selector;
        // PR3 of internal-match work (2026-05-15) — kill-switch +
        // priority-window + bot-incentive setters + bundle view for
        // the internal-liquidation match path. See
        // InternalLiquidationLedger.md §0.
        s[74] = ConfigFacet.setInternalMatchEnabled.selector;
        s[75] = ConfigFacet.setInternalMatchConfig.selector;
        s[76] = ConfigFacet.getInternalMatchConfigBundle.selector;
        // T-600 — treasury-conversion knobs.
        s[77] = ConfigFacet.setTreasuryConvertTargets.selector;
        s[78] = ConfigFacet.setTreasuryConvertThresholds.selector;
        s[79] = ConfigFacet.getTreasuryConvertConfig.selector;
        // Issue #164 — borrower-side collateral range master flag.
        // Defaults `false` on a fresh deploy; flipped on by governance
        // via the setter below. See docs/RangeOffersDesign.md §3.
        s[80] = ConfigFacet.setRangeCollateralEnabled.selector;
    }

    function _getRewardAggregatorSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](12);
        s[0] = RewardAggregatorFacet.onChainReportReceived.selector;
        s[1] = RewardAggregatorFacet.finalizeDay.selector;
        s[2] = RewardAggregatorFacet.forceFinalizeDay.selector;
        s[3] = RewardAggregatorFacet.broadcastGlobal.selector;
        s[4] = RewardAggregatorFacet.setExpectedSourceChainIds.selector;
        s[5] = RewardAggregatorFacet.isChainReported.selector;
        s[6] = RewardAggregatorFacet.getChainReport.selector;
        s[7] = RewardAggregatorFacet.getChainDailyReportCount.selector;
        s[8] = RewardAggregatorFacet.getDailyFirstReportAt.selector;
        s[9] = RewardAggregatorFacet.getDailyGlobalInterest.selector;
        s[10] = RewardAggregatorFacet.getExpectedSourceChainIds.selector;
        s[11] = RewardAggregatorFacet.isDayReadyToFinalize.selector;
    }

    function _getMetricsSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](42);
        s[0] = MetricsFacet.getProtocolTVL.selector;
        s[1] = MetricsFacet.getProtocolStats.selector;
        s[2] = MetricsFacet.getUserCount.selector;
        s[3] = MetricsFacet.getActiveLoansCount.selector;
        s[4] = MetricsFacet.getActiveOffersCount.selector;
        s[5] = MetricsFacet.getTotalInterestEarnedNumeraire.selector;
        s[6] = MetricsFacet.getTreasuryMetrics.selector;
        // Legacy overload — disambiguated by full signature now that
        // the per-asset overload (added in §A.2) shares the name.
        s[7] = bytes4(keccak256("getRevenueStats(uint256)"));
        s[8] = MetricsFacet.getActiveLoansPaginated.selector;
        s[9] = MetricsFacet.getActiveOffersByAsset.selector;
        s[10] = MetricsFacet.getLoanSummary.selector;
        s[11] = MetricsFacet.getVaultStats.selector;
        s[12] = MetricsFacet.getNFTRentalDetails.selector;
        s[13] = MetricsFacet.getTotalNFTsInVaultByCollection.selector;
        s[14] = MetricsFacet.getUserSummary.selector;
        s[15] = MetricsFacet.getUserActiveLoans.selector;
        s[16] = MetricsFacet.getUserActiveOffers.selector;
        s[17] = MetricsFacet.getUserNFTsInVault.selector;
        s[18] = MetricsFacet.getProtocolHealth.selector;
        s[19] = MetricsFacet.getBlockTimestamp.selector;
        // Reverse-index enumeration (no event-scan dependency).
        s[20] = MetricsFacet.getGlobalCounts.selector;
        s[21] = MetricsFacet.getUserLoanCount.selector;
        s[22] = MetricsFacet.getUserOfferCount.selector;
        s[23] = MetricsFacet.isOfferCancelled.selector;
        s[24] = MetricsFacet.getUserLoansPaginated.selector;
        s[25] = MetricsFacet.getUserOffersPaginated.selector;
        s[26] = MetricsFacet.getUserLoansByStatusPaginated.selector;
        s[27] = MetricsFacet.getUserOffersByStatePaginated.selector;
        s[28] = MetricsFacet.getAllLoansPaginated.selector;
        s[29] = MetricsFacet.getAllOffersPaginated.selector;
        s[30] = MetricsFacet.getLoansByStatusPaginated.selector;
        s[31] = MetricsFacet.getOffersByStatePaginated.selector;
        // Range Orders Phase 1 — asset-agnostic paginated active-offer
        // scan, symmetric with `getActiveLoansPaginated`. Consumed by
        // the keeper-bot's `offerMatcher` detector to enumerate the
        // order book each tick.
        s[32] = MetricsFacet.getActiveOffersPaginated.selector;
        // Position-NFT live summary — single source of truth for
        // marketplace `tokenURI` rendering AND the frontend's NFT
        // verifier UI. Returns realized loan terms, locked collateral,
        // and claim state in one structured read.
        s[33] = MetricsFacet.getNFTPositionSummary.selector;
        // AnalyticalGettersDesign §3.2 — rolling-window per-asset
        // treasury accrual. Overload of the legacy
        // `getRevenueStats(uint256)` at index 7; selector hashed
        // explicitly because `.selector` is ambiguous on overloads.
        s[34] = bytes4(keccak256("getRevenueStats(address,uint16)"));
        s[35] = MetricsFacet.getActiveOffersByAssetPair.selector;
        // Struct-array variant of getUserOffersPaginated — one round
        // trip returns full Offer rows so the frontend skips the
        // multicall fan-out for per-user offer detail tables.
        s[36] = MetricsFacet.getUserAllOffersWithDetails.selector;
        // OfferBook 2-filter UX skinny-ranking view — surfaces the
        // sort-relevant subset of every active offer in a
        // (lending, collateral) pair so the frontend can sort across
        // the entire bucket without per-offer hydration. Pairs with
        // {getActiveOffersByAssetPair} (id-only) and {getOffer}
        // (full struct, single id).
        s[37] = MetricsFacet.getActiveOffersByAssetPairRanked.selector;

        // §8b — NFT-holder-keyed enumeration (secondary-market-safe).
        // Mirrors `userLoanIds`/`userOfferIds` views above but uses
        // ERC721Enumerable + reverse maps so secondary-market recipients
        // are included. See MetricsFacet:734-ish "§8b" block.
        s[38] = MetricsFacet.getUserPositionLoans.selector;
        s[39] = MetricsFacet.getUserPositionOffers.selector;
        // PR3 of internal-match work (2026-05-15) — paginated
        // active-loan view filtered by current LTV. Internal-match
        // bots use this per block to discover candidates; returns
        // empty while `internalMatchEnabled == false`.
        s[40] = MetricsFacet.getMatchEligibleLoans.selector;
        // EC-003 Phase 2 — O(K) opposing-pair lookup. Off-chain callers
        // pre-flight before submitting `triggerInternalMatchLiquidation`;
        // Phase 3 auto-dispatch in triggerLiquidation / triggerDefault /
        // claimAsLenderWithRetry consults this view internally.
        s[41] = MetricsFacet.hasInternalMatchCandidate.selector;
    }

    /// AnalyticalGettersDesign §3.1 — per-user dashboard surface. One
    /// scalar snapshot + three paginated list views collapse the
    /// frontend Dashboard's 13-RPC first-load into 3 calls.
    function _getMetricsDashboardSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](6);
        s[0] = MetricsDashboardFacet.getUserDashboardSnapshot.selector;
        s[1] = MetricsDashboardFacet.getUserDashboardLoans.selector;
        s[2] = MetricsDashboardFacet.getUserDashboardOffers.selector;
        s[3] = MetricsDashboardFacet.getUserDashboardClaimables.selector;
        s[4] = MetricsDashboardFacet.getUserDashboardLoansBothSides.selector;
        // Public pagination cap — exposed on the Diamond so a UI can
        // size its page requests. Was missed in this cut list; surfaced
        // by the Issue #71 selector-coverage guardrail. `MAX_PAGE_LIMIT`
        // is a `public constant`; its auto-getter has no type-level
        // `.selector`, so the signature is hashed directly.
        s[5] = bytes4(keccak256("MAX_PAGE_LIMIT()"));
    }

    /// Phase 4.1 — Terms-of-Service acceptance gate. The gate stays
    /// disabled while `currentTosVersion == 0` (default at deploy);
    /// once governance writes a non-zero version + content hash via
    /// `setCurrentTos`, the frontend requires every wallet to call
    /// `acceptTerms(version, hash)` before reaching `/app/*` routes.
    function _getLegalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = LegalFacet.acceptTerms.selector;
        s[1] = LegalFacet.setCurrentTos.selector;
        s[2] = LegalFacet.hasAcceptedCurrentTerms.selector;
        s[3] = LegalFacet.getCurrentTos.selector;
        s[4] = LegalFacet.getUserTosAcceptance.selector;
    }
}
