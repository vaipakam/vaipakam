// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VaipakamVestingWallet} from "../src/token/VaipakamVestingWallet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployFounderVesting
 * @notice Deploys a `VaipakamVestingWallet` (cliff + linear) for a single
 *         grantee — the founder, a developer/team hire, or an early
 *         contributor — and OPTIONALLY mints the VPFI grant into it
 *         (T-600).
 *
 * @dev **Legal gating.** Deploying the wallet is harmless and may be done
 *      any time. *Funding* it (the `mintVPFI` call) is a TGE / genesis-
 *      allocation action that the founder-compensation design
 *      (`docs/DesignsAndPlans/TreasuryAndFounderDistribution.md` §6)
 *      gates on a securities-lawyer sign-off. The mint step therefore
 *      only runs when `CONFIRM_TGE_FUNDING=YES` is explicitly set —
 *      mirroring the `CONFIRM_HANDOVER` gate in `TransferAdminToTimelock`.
 *      Without it the script deploys the (empty) wallet and stops.
 *
 *      The minting caller (the broadcasting key) must hold `ADMIN_ROLE`
 *      on the Diamond, and the Diamond must be the registered VPFI
 *      minter on the canonical chain (see `TreasuryFacet.mintVPFI`).
 *
 *      Required env vars:
 *        - DEPLOYER_PRIVATE_KEY   : broadcasting key
 *        - VESTING_BENEFICIARY    : grantee address (receives released VPFI)
 *        - VESTING_GRANT_VPFI     : grant size, 18-dec VPFI wei
 *      Optional env vars:
 *        - VESTING_START          : unix start; default = now
 *        - VESTING_DURATION_DAYS  : linear duration; default 1460 (4 yr)
 *        - VESTING_CLIFF_DAYS     : cliff length;   default 365  (1 yr)
 *        - CONFIRM_TGE_FUNDING    : set to "YES" to also mint the grant
 */
contract DeployFounderVesting is Script {
    uint64 internal constant DEFAULT_DURATION_DAYS = 1460; // 4 years
    uint64 internal constant DEFAULT_CLIFF_DAYS = 365; // 1 year

    function run() external returns (address vestingWallet) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address beneficiary = vm.envAddress("VESTING_BENEFICIARY");
        uint256 grantVpfi = vm.envUint("VESTING_GRANT_VPFI");

        uint64 start = uint64(vm.envOr("VESTING_START", block.timestamp));
        uint64 durationSeconds =
            uint64(vm.envOr("VESTING_DURATION_DAYS", uint256(DEFAULT_DURATION_DAYS))) * 1 days;
        uint64 cliffSeconds =
            uint64(vm.envOr("VESTING_CLIFF_DAYS", uint256(DEFAULT_CLIFF_DAYS))) * 1 days;

        require(beneficiary != address(0), "DeployFounderVesting: beneficiary required");
        require(grantVpfi > 0, "DeployFounderVesting: grant amount required");
        require(cliffSeconds <= durationSeconds, "DeployFounderVesting: cliff > duration");

        bool fund = keccak256(bytes(vm.envOr("CONFIRM_TGE_FUNDING", string(""))))
            == keccak256(bytes("YES"));

        console.log("=== Deploy Founder / Contributor Vesting Wallet ===");
        console.log("Chain id:        ", block.chainid);
        console.log("Beneficiary:     ", beneficiary);
        console.log("Grant (VPFI wei):", grantVpfi);
        console.log("Start:           ", start);
        console.log("Duration (s):    ", durationSeconds);
        console.log("Cliff (s):       ", cliffSeconds);
        console.log("Fund now:        ", fund);

        vm.startBroadcast(deployerKey);
        VaipakamVestingWallet wallet = new VaipakamVestingWallet(
            beneficiary,
            start,
            durationSeconds,
            cliffSeconds
        );
        vestingWallet = address(wallet);

        if (fund) {
            address diamond = Deployments.readDiamond();
            require(diamond != address(0), "DeployFounderVesting: diamond not deployed");
            TreasuryFacet(diamond).mintVPFI(vestingWallet, grantVpfi);
            console.log("Grant minted into the vesting wallet.");
        }
        vm.stopBroadcast();

        console.log("VestingWallet:   ", vestingWallet);
        if (!fund) {
            console.log(
                "Wallet deployed EMPTY. After the securities-lawyer sign-off,"
            );
            console.log(
                "re-run with CONFIRM_TGE_FUNDING=YES to mint the VPFI grant."
            );
        }
    }
}
