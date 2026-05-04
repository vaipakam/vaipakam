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
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
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
    address diamond;
    address diamondCutFacet;

    function run() external virtual {
        // ── Configuration ───────────────────────────────────────────────
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
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
        EscrowFactoryFacet escrowFactoryFacet = new EscrowFactoryFacet();
        OfferFacet offerFacet = new OfferFacet();
        // Range Orders Phase 1 EIP-170 split: matchOffers + previewMatch
        // live on a separate facet to keep OfferFacet under the
        // 24576-byte runtime-bytecode ceiling.
        OfferMatchFacet offerMatchFacet = new OfferMatchFacet();
        // Same EIP-170 pressure split out cancelOffer + read views into
        // OfferCancelFacet. Selectors land on the diamond identically;
        // frontend / keeper-bot bindings unaffected by the move.
        OfferCancelFacet offerCancelFacet = new OfferCancelFacet();
        LoanFacet loanFacet = new LoanFacet();
        RepayFacet repayFacet = new RepayFacet();
        DefaultedFacet defaultedFacet = new DefaultedFacet();
        RiskFacet riskFacet = new RiskFacet();
        ClaimFacet claimFacet = new ClaimFacet();
        AddCollateralFacet addCollateralFacet = new AddCollateralFacet();
        TreasuryFacet treasuryFacet = new TreasuryFacet();
        EarlyWithdrawalFacet earlyWithdrawalFacet = new EarlyWithdrawalFacet();
        PartialWithdrawalFacet partialWithdrawalFacet = new PartialWithdrawalFacet();
        PrecloseFacet precloseFacet = new PrecloseFacet();
        RefinanceFacet refinanceFacet = new RefinanceFacet();
        MetricsFacet metricsFacet = new MetricsFacet();
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

        console.log("All 33 facets deployed.");

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
        // 32 facets (DiamondCutFacet already added by constructor)
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](32);

        cuts[0] = _buildCut(address(loupeFacet), _getLoupeSelectors());
        cuts[1] = _buildCut(address(ownershipFacet), _getOwnershipSelectors());
        cuts[2] = _buildCut(address(accessControlFacet), _getAccessControlSelectors());
        cuts[3] = _buildCut(address(adminFacet), _getAdminSelectors());
        cuts[4] = _buildCut(address(profileFacet), _getProfileSelectors());
        cuts[5] = _buildCut(address(oracleFacet), _getOracleSelectors());
        cuts[6] = _buildCut(address(oracleAdminFacet), _getOracleAdminSelectors());
        cuts[7] = _buildCut(address(nftFacet), _getNFTSelectors());
        cuts[8] = _buildCut(address(escrowFactoryFacet), _getEscrowFactorySelectors());
        cuts[9] = _buildCut(address(offerFacet), _getOfferSelectors());
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

        // ── Step 4: Execute diamond cut ─────────────────────────────────
        // Split into two halves to stay under Base Sepolia's per-tx
        // gas cap (~18M observed) — a single 32-facet cut estimates at
        // ~17M, and forge's default 1.3× multiplier pushes the sent
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
        IDiamondCut(diamond).diamondCut(secondHalf, address(0), "");
        console.log("Diamond cut 2/2 complete:", cuts.length - mid, "facets added.");

        // ── Step 5: Post-deployment initialization ──────────────────────
        // 5a. Initialize access control (grants all roles to admin)
        AccessControlFacet(diamond).initializeAccessControl();
        console.log("AccessControl initialized.");

        // 5b. Set treasury address
        AdminFacet(diamond).setTreasury(treasury);
        console.log("Treasury set:", treasury);

        // 5c. Initialize escrow implementation (deploys template)
        EscrowFactoryFacet(diamond).initializeEscrowImplementation();
        console.log("Escrow implementation initialized.");

        // 5d. Initialize NFT metadata
        VaipakamNFTFacet(diamond).initializeNFT();
        console.log("NFT initialized.");

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
        // Write the Diamond + escrow-impl addresses to
        // `deployments/<chain-slug>/addresses.json`. Every subsequent
        // script (Configure*, Wire*, Upgrade*, seeders, smoke tests)
        // reads from this file via `Deployments.readDiamond()` etc.
        // — operators no longer need to chain-prefix env vars across
        // every follow-on broadcast. The file is committed and is the
        // canonical source of truth post-deploy. Writes happen OUTSIDE
        // the broadcast (no on-chain effect) so a missing FS-write
        // permission only fails the file step, not the deploy.
        Deployments.writeChainHeader();
        Deployments.writeDiamond(diamond);

        // Per-chain context that downstream scripts (and the frontend
        // env builder) consume directly from addresses.json:
        //   - chainSlug:   stable identifier matching the directory
        //   - lzEndpoint:  LayerZero V2 EndpointV2 for this chain
        //   - lzEid:       LayerZero V2 endpoint id
        //   - deployBlock: block in which the Diamond proxy was created
        //                  (frontend uses this as the lower-bound for
        //                  log scans — `eth_getLogs(fromBlock=deployBlock)`)
        //   - escrowImpl:  per-user UUPS escrow template the factory
        //                  clones; surfaced via `getVaipakamEscrowImplementationAddress()`
        //   - weth/treasury/admin: shared addresses every operator UI
        //                  cross-references against the .env they hold
        //
        // All of these are stable for the lifetime of this Diamond
        // deploy; rewriting them on each run is idempotent.
        Deployments.writeChainSlug();
        Deployments.writeLzEid(Deployments.lzEidForChain());
        Deployments.writeDeployBlock(block.number);
        Deployments.writeEscrowImpl(
            EscrowFactoryFacet(diamond)
                .getVaipakamEscrowImplementationAddress()
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
        Deployments.writeFacet("escrowFactoryFacet",      address(escrowFactoryFacet));
        Deployments.writeFacet("offerFacet",              address(offerFacet));
        Deployments.writeFacet("offerMatchFacet",         address(offerMatchFacet));
        Deployments.writeFacet("offerCancelFacet",        address(offerCancelFacet));
        Deployments.writeFacet("loanFacet",               address(loanFacet));
        Deployments.writeFacet("repayFacet",              address(repayFacet));
        Deployments.writeFacet("defaultedFacet",          address(defaultedFacet));
        Deployments.writeFacet("riskFacet",               address(riskFacet));
        Deployments.writeFacet("claimFacet",              address(claimFacet));
        Deployments.writeFacet("addCollateralFacet",      address(addCollateralFacet));
        Deployments.writeFacet("treasuryFacet",           address(treasuryFacet));
        Deployments.writeFacet("earlyWithdrawalFacet",    address(earlyWithdrawalFacet));
        Deployments.writeFacet("partialWithdrawalFacet",  address(partialWithdrawalFacet));
        Deployments.writeFacet("precloseFacet",           address(precloseFacet));
        Deployments.writeFacet("refinanceFacet",          address(refinanceFacet));
        Deployments.writeFacet("metricsFacet",            address(metricsFacet));
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
        console.log("EscrowFactoryFacet:   ", address(escrowFactoryFacet));
        console.log("OfferFacet:           ", address(offerFacet));
        console.log("OfferMatchFacet:      ", address(offerMatchFacet));
        console.log("OfferCancelFacet:     ", address(offerCancelFacet));
        console.log("LoanFacet:            ", address(loanFacet));
        console.log("RepayFacet:           ", address(repayFacet));
        console.log("DefaultedFacet:       ", address(defaultedFacet));
        console.log("RiskFacet:            ", address(riskFacet));
        console.log("ClaimFacet:           ", address(claimFacet));
        console.log("AddCollateralFacet:   ", address(addCollateralFacet));
        console.log("TreasuryFacet:        ", address(treasuryFacet));
        console.log("EarlyWithdrawalFacet: ", address(earlyWithdrawalFacet));
        console.log("PartialWithdrawalFacet:", address(partialWithdrawalFacet));
        console.log("PrecloseFacet:        ", address(precloseFacet));
        console.log("RefinanceFacet:       ", address(refinanceFacet));
        console.log("MetricsFacet:         ", address(metricsFacet));
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
        console.log("   - RewardReporterFacet.setRewardOApp / setLocalEid / setBaseEid");
        console.log("   - RewardReporterFacet.setIsCanonicalRewardChain (true only on Base)");
        console.log("   - RewardAggregatorFacet.setExpectedSourceEids (Base only)");
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
        s = new bytes4[](14);
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
        s[12] = AccessControlFacet.ESCROW_ADMIN_ROLE.selector;
        // Hot-path role-revoke for incident response. Distinct from
        // the timelocked `revokeRole` so a Pauser (or other emergency
        // role-holder) can pull a compromised key without waiting
        // 48h. See AccessControlFacet implementation for the role
        // gate that scopes this.
        s[13] = AccessControlFacet.emergencyRevokeRole.selector;
    }

    function _getAdminSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](22);
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
        s = new bytes4[](9);
        s[0] = OracleFacet.checkLiquidity.selector;
        s[1] = OracleFacet.getAssetPrice.selector;
        s[2] = OracleFacet.calculateLTV.selector;
        s[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
        s[4] = OracleFacet.getAssetRiskProfile.selector;
        s[5] = OracleFacet.getIlliquidAssets.selector;
        s[6] = OracleFacet.isAssetSupported.selector;
        s[7] = OracleFacet.getSequencerUptimeFeed.selector;
        s[8] = OracleFacet.sequencerHealthy.selector;
    }

    function _getOracleAdminSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](30);
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

    function _getEscrowFactorySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](31);
        s[0] = EscrowFactoryFacet.initializeEscrowImplementation.selector;
        s[1] = EscrowFactoryFacet.getOrCreateUserEscrow.selector;
        s[2] = EscrowFactoryFacet.upgradeEscrowImplementation.selector;
        s[3] = EscrowFactoryFacet.escrowDepositERC20.selector;
        s[4] = EscrowFactoryFacet.escrowWithdrawERC20.selector;
        s[5] = EscrowFactoryFacet.escrowDepositERC721.selector;
        s[6] = EscrowFactoryFacet.escrowWithdrawERC721.selector;
        s[7] = EscrowFactoryFacet.escrowDepositERC1155.selector;
        s[8] = EscrowFactoryFacet.escrowWithdrawERC1155.selector;
        s[9] = EscrowFactoryFacet.escrowApproveNFT721.selector;
        s[10] = EscrowFactoryFacet.escrowSetNFTUser.selector;
        s[11] = EscrowFactoryFacet.escrowGetNFTUserOf.selector;
        s[12] = EscrowFactoryFacet.escrowGetNFTUserExpires.selector;
        s[13] = EscrowFactoryFacet.getOfferAmount.selector;
        s[14] = EscrowFactoryFacet.getVaipakamEscrowImplementationAddress.selector;
        s[15] = EscrowFactoryFacet.getDiamondAddress.selector;
        s[16] = EscrowFactoryFacet.setMandatoryEscrowUpgrade.selector;
        s[17] = EscrowFactoryFacet.upgradeUserEscrow.selector;
        s[18] = EscrowFactoryFacet.getUserEscrowAddress.selector;
        s[19] = EscrowFactoryFacet.getEscrowVersionInfo.selector;
        s[20] = EscrowFactoryFacet.escrowSetNFTUser1155.selector;
        s[21] = EscrowFactoryFacet.escrowGetNFTQuantity.selector;
        // T-051 / T-054 — chokepoint deposit + counter-only companions.
        // `escrowDepositERC20From` is the third-party-payer variant
        // RepayFacet uses to pull repayment funds from the borrower
        // into the lender's escrow; without this selector cut, every
        // ERC-20 loan repayment reverts with FunctionDoesNotExist.
        s[22] = EscrowFactoryFacet.escrowDepositERC20From.selector;
        s[23] = EscrowFactoryFacet.recordEscrowDepositERC20.selector;
        s[24] = EscrowFactoryFacet.getProtocolTrackedEscrowBalance.selector;
        // T-054 PR-3 — stuck-token recovery EIP-712 surface.
        s[25] = EscrowFactoryFacet.recoverStuckERC20.selector;
        s[26] = EscrowFactoryFacet.disown.selector;
        s[27] = EscrowFactoryFacet.recoveryDomainSeparator.selector;
        s[28] = EscrowFactoryFacet.recoveryAckTextHash.selector;
        s[29] = EscrowFactoryFacet.recoveryNonce.selector;
        s[30] = EscrowFactoryFacet.escrowBannedSource.selector;
    }

    function _getOfferSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = OfferFacet.createOffer.selector;
        s[1] = OfferFacet.acceptOffer.selector;
        s[2] = OfferFacet.getUserEscrow.selector;
        // Phase 8b.1 Permit2 additions.
        s[3] = OfferFacet.createOfferWithPermit.selector;
        s[4] = OfferFacet.acceptOfferWithPermit.selector;
        // Cross-facet entry point used exclusively by
        // `OfferMatchFacet.matchOffers` to invoke the same
        // `_acceptOffer` plumbing without re-acquiring the shared
        // nonReentrant lock that the outer matchOffers already
        // holds. Gated to `msg.sender == address(this)` inside the
        // facet body — EOAs cannot call it directly through the
        // diamond fallback. (Range Orders Phase 1 EIP-170 split.)
        s[5] = OfferFacet.acceptOfferInternal.selector;
        // Cross-facet entry used by `PrecloseFacet.offsetWithNewOffer`
        // (Option 3) to mint a new lender offer without colliding on
        // the shared diamond reentrancy guard the caller already
        // holds. Same `address(this)`-only gating as
        // `acceptOfferInternal`.
        s[6] = OfferFacet.createOfferInternal.selector;
        // `cancelOffer`, `getCompatibleOffers`, `getOffer`, and
        // `getOfferDetails` moved to `OfferCancelFacet` as part of
        // the second EIP-170 split — see `_getOfferCancelSelectors`.
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

    function _getLoanSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = LoanFacet.initiateLoan.selector;
        s[1] = LoanFacet.getLoanDetails.selector;
        s[2] = LoanFacet.getLoanConsents.selector;
        // T-032 — notification-bill writer entry. NOTIF_BILLER_ROLE-gated.
        s[3] = LoanFacet.markNotifBilled.selector;
    }

    function _getRepaySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = RepayFacet.repayLoan.selector;
        s[1] = RepayFacet.repayPartial.selector;
        s[2] = RepayFacet.autoDeductDaily.selector;
        s[3] = RepayFacet.calculateRepaymentAmount.selector;
    }

    function _getDefaultedSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = DefaultedFacet.triggerDefault.selector;
        s[1] = DefaultedFacet.isLoanDefaultable.selector;
    }

    function _getRiskSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = RiskFacet.updateRiskParams.selector;
        s[1] = RiskFacet.calculateLTV.selector;
        s[2] = RiskFacet.calculateHealthFactor.selector;
        s[3] = RiskFacet.isCollateralValueCollapsed.selector;
        s[4] = RiskFacet.triggerLiquidation.selector;
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
        s = new bytes4[](3);
        s[0] = TreasuryFacet.claimTreasuryFees.selector;
        s[1] = TreasuryFacet.getTreasuryBalance.selector;
        s[2] = TreasuryFacet.mintVPFI.selector;
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
        s[1] = VPFIDiscountFacet.depositVPFIToEscrow.selector;
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
        s[15] = VPFIDiscountFacet.withdrawVPFIFromEscrow.selector;
        s[16] = VPFIDiscountFacet.setBridgedBuyReceiver.selector;
        s[17] = VPFIDiscountFacet.getBridgedBuyReceiver.selector;
        s[18] = VPFIDiscountFacet.processBridgedBuy.selector;
        s[19] = VPFIDiscountFacet.quoteFixedRateBuy.selector;
        s[20] = VPFIDiscountFacet.getUserVpfiDiscountState.selector;
        // Phase 8b.1 Permit2 addition.
        s[21] = VPFIDiscountFacet.depositVPFIToEscrowWithPermit.selector;
        // #00010 fix — per-(buyer, originEid) wallet-cap reader. The
        // canonical Diamond debits the cap bucket keyed by origin
        // chain; the frontend reads via this getter so direct buys
        // and bridged buys see consistent remaining-allowance values.
        s[22] = VPFIDiscountFacet.getVPFISoldToByEid.selector;
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
        s = new bytes4[](12);
        s[0] = RewardReporterFacet.closeDay.selector;
        s[1] = RewardReporterFacet.onRewardBroadcastReceived.selector;
        s[2] = RewardReporterFacet.setRewardOApp.selector;
        s[3] = RewardReporterFacet.setLocalEid.selector;
        s[4] = RewardReporterFacet.setBaseEid.selector;
        s[5] = RewardReporterFacet.setIsCanonicalRewardChain.selector;
        s[6] = RewardReporterFacet.setRewardGraceSeconds.selector;
        s[7] = RewardReporterFacet.getLocalChainInterestNumeraire18.selector;
        s[8] = RewardReporterFacet.getChainReportSentAt.selector;
        s[9] = RewardReporterFacet.getRewardReporterConfig.selector;
        s[10] = RewardReporterFacet.getKnownGlobalInterestNumeraire18.selector;
        // Single-field getter for the protocol-console knob registry.
        s[11] = RewardReporterFacet.getRewardGraceSeconds.selector;
    }

    function _getConfigSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](55);
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
    }

    function _getRewardAggregatorSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](12);
        s[0] = RewardAggregatorFacet.onChainReportReceived.selector;
        s[1] = RewardAggregatorFacet.finalizeDay.selector;
        s[2] = RewardAggregatorFacet.forceFinalizeDay.selector;
        s[3] = RewardAggregatorFacet.broadcastGlobal.selector;
        s[4] = RewardAggregatorFacet.setExpectedSourceEids.selector;
        s[5] = RewardAggregatorFacet.isChainReported.selector;
        s[6] = RewardAggregatorFacet.getChainReport.selector;
        s[7] = RewardAggregatorFacet.getChainDailyReportCount.selector;
        s[8] = RewardAggregatorFacet.getDailyFirstReportAt.selector;
        s[9] = RewardAggregatorFacet.getDailyGlobalInterest.selector;
        s[10] = RewardAggregatorFacet.getExpectedSourceEids.selector;
        s[11] = RewardAggregatorFacet.isDayReadyToFinalize.selector;
    }

    function _getMetricsSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](34);
        s[0] = MetricsFacet.getProtocolTVL.selector;
        s[1] = MetricsFacet.getProtocolStats.selector;
        s[2] = MetricsFacet.getUserCount.selector;
        s[3] = MetricsFacet.getActiveLoansCount.selector;
        s[4] = MetricsFacet.getActiveOffersCount.selector;
        s[5] = MetricsFacet.getTotalInterestEarnedNumeraire.selector;
        s[6] = MetricsFacet.getTreasuryMetrics.selector;
        s[7] = MetricsFacet.getRevenueStats.selector;
        s[8] = MetricsFacet.getActiveLoansPaginated.selector;
        s[9] = MetricsFacet.getActiveOffersByAsset.selector;
        s[10] = MetricsFacet.getLoanSummary.selector;
        s[11] = MetricsFacet.getEscrowStats.selector;
        s[12] = MetricsFacet.getNFTRentalDetails.selector;
        s[13] = MetricsFacet.getTotalNFTsInEscrowByCollection.selector;
        s[14] = MetricsFacet.getUserSummary.selector;
        s[15] = MetricsFacet.getUserActiveLoans.selector;
        s[16] = MetricsFacet.getUserActiveOffers.selector;
        s[17] = MetricsFacet.getUserNFTsInEscrow.selector;
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
