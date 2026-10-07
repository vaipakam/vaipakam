// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";
import {TestnetChains} from "../src/compliance/TestnetChains.sol";
import {TestnetSanctionsOverlay} from "../src/compliance/TestnetSanctionsOverlay.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ArtifactRootBase} from "./lib/ArtifactRoot.sol";

/// @dev The Chainalysis oracle's ownership read. Not part of `ISanctionsList`,
///      which is all the Diamond needs; this script uses it only to prove an
///      address is Chainalysis's before pointing a Diamond at it.
interface IChainalysisOracleOwner {
    function owner() external view returns (address);
}

/**
 * @title  ConfigureSanctionsOracle
 * @notice Points a Diamond's sanctions screen at the right oracle for its
 *         chain, and records what it set in the chain's deployment artifact.
 *
 * @dev    #2439, and the setter half of #946 (which also asks for a deploy
 *         phase and a verify-time assertion; those remain open there).
 *
 *         - **Mainnet**: Chainalysis's oracle for the chain, directly. A chain
 *           with no verified Chainalysis address is REFUSED rather than left
 *           silently unscreened; screening a mainnet some other way is a
 *           recorded decision, not a script default.
 *         - **Testnet** (`TestnetChains`): a `TestnetSanctionsOverlay` over
 *           Chainalysis's oracle where the chain has one, or over nothing
 *           where it does not. An overlay already recorded for the chain is
 *           reused when its upstream is still the expected one.
 *
 *         Every Chainalysis address in `chainalysisFor` was read on-chain on
 *         2026-10-07: each reports `owner() == CHAINALYSIS_OWNER`, and the
 *         Base Sepolia contract's runtime bytecode equals the Base mainnet
 *         oracle's. The script re-checks the owner before use, so a table
 *         entry that stops being Chainalysis's fails the run instead of
 *         configuring it. The address is not universal — Base uses its own.
 *
 *         Keys: `DEPLOYER_PRIVATE_KEY` deploys an overlay; `ADMIN_PRIVATE_KEY`
 *         must be the Diamond's owner to set the oracle. A Diamond owned by a
 *         timelock is refused with the call to schedule instead.
 *
 *         Run (dry, then with `--broadcast`):
 *           forge script script/ConfigureSanctionsOracle.s.sol \
 *             --rpc-url "$BASE_SEPOLIA_RPC_URL" [--broadcast --slow]
 */
contract ConfigureSanctionsOracle is Script, ArtifactRootBase {
    /// @notice The owner of every Chainalysis sanctions oracle checked on
    ///         2026-10-07 (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB,
    ///         Base Sepolia).
    address public constant CHAINALYSIS_OWNER = 0xDF900dC8991474ab9d69F2c3b9C900c055fb36CD;
    /// @notice Chainalysis's oracle address on most chains it covers.
    address public constant CHAINALYSIS_DEFAULT = 0x40C57923924B5c5c5455c48D93317139ADDaC8fb;
    /// @notice Chainalysis's oracle address on Base, which differs.
    address public constant CHAINALYSIS_BASE = 0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B;

    string internal constant KIND_CHAINALYSIS = "chainalysis";
    string internal constant KIND_TESTNET_OVERLAY = "testnet-overlay";

    /// @notice Chainalysis's oracle on `chainId`, or `address(0)` where none
    ///         was found (Ethereum Sepolia, Arbitrum Sepolia, OP Sepolia,
    ///         Polygon Amoy, BNB testnet, Anvil, and any chain not listed).
    function chainalysisFor(uint256 chainId) public pure returns (address) {
        if (chainId == 8453) return CHAINALYSIS_BASE;
        if (
            chainId == 1 || chainId == 42161 || chainId == 10 || chainId == 137
                || chainId == 56 || chainId == 84532
        ) return CHAINALYSIS_DEFAULT;
        return address(0);
    }

    function run() external {
        uint256 cid = block.chainid;
        address diamond = Deployments.readDiamond();
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        address owner = IERC173(diamond).owner();

        address chainalysis = chainalysisFor(cid);
        if (chainalysis != address(0)) _assertChainalysis(chainalysis);

        address target;
        string memory kind;
        if (TestnetChains.isTestnet(cid)) {
            target = _overlayFor(chainalysis, admin);
            kind = KIND_TESTNET_OVERLAY;
        } else {
            require(
                chainalysis != address(0),
                "ConfigureSanctionsOracle: no verified Chainalysis oracle on this mainnet; configuring another screen needs a recorded decision"
            );
            target = chainalysis;
            kind = KIND_CHAINALYSIS;
        }

        address current = ProfileFacet(diamond).getSanctionsOracle();
        if (current != target) {
            if (owner != admin) {
                console.log("Diamond owner is not the ADMIN key (timelock?). Schedule through it:");
                console.log("  target :", diamond);
                console.log("  call   : setSanctionsOracle(address)", target);
                revert("ConfigureSanctionsOracle: ADMIN_PRIVATE_KEY is not the Diamond owner");
            }
            vm.startBroadcast(adminKey);
            ProfileFacet(diamond).setSanctionsOracle(target);
            vm.stopBroadcast();
        }

        _verify(diamond, target, admin);

        Deployments.writeSanctionsOracle(target);
        Deployments.writeSanctionsOracleKind(kind);
        if (TestnetChains.isTestnet(cid) && chainalysis != address(0)) {
            Deployments.writeSanctionsUpstream(chainalysis);
        }

        console.log("Sanctions oracle configured:", target);
        console.log("  kind    :", kind);
        console.log("  previous:", current);
        if (chainalysis != address(0)) console.log("  chainalysis:", chainalysis);
    }

    /// @dev The recorded overlay when its upstream is still `chainalysis`;
    ///      otherwise a fresh one, owned by the chain's admin.
    function _overlayFor(address chainalysis, address admin) internal returns (address) {
        address recorded = Deployments.readSanctionsOracleOptional();
        if (recorded != address(0) && recorded.code.length != 0) {
            try TestnetSanctionsOverlay(recorded).upstream() returns (ISanctionsList up) {
                if (address(up) == chainalysis) {
                    console.log("Reusing the recorded overlay:", recorded);
                    return recorded;
                }
            } catch {}
        }
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        TestnetSanctionsOverlay overlay = new TestnetSanctionsOverlay(admin, chainalysis);
        vm.stopBroadcast();
        console.log("Deployed TestnetSanctionsOverlay:", address(overlay));
        return address(overlay);
    }

    /// @dev Refuses an address that is not, on this chain, Chainalysis's
    ///      oracle: wrong owner, or no answer to the screen read.
    function _assertChainalysis(address oracle) internal view {
        require(oracle.code.length != 0, "ConfigureSanctionsOracle: no code at the Chainalysis address on this chain");
        require(
            IChainalysisOracleOwner(oracle).owner() == CHAINALYSIS_OWNER,
            "ConfigureSanctionsOracle: the oracle at the Chainalysis address is not owned by Chainalysis"
        );
        ISanctionsList(oracle).isSanctioned(address(0));
    }

    /// @dev The Diamond now routes to `target`, and both the oracle and the
    ///      Diamond's own screen answer a read.
    function _verify(address diamond, address target, address admin) internal view {
        require(
            ProfileFacet(diamond).getSanctionsOracle() == target,
            "ConfigureSanctionsOracle: the Diamond does not report the configured oracle"
        );
        ISanctionsList(target).isSanctioned(admin);
        ProfileFacet(diamond).isSanctionedAddress(admin);
    }
}
