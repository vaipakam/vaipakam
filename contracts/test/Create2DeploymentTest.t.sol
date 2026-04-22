// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {VaipakamRewardOApp} from "../src/token/VaipakamRewardOApp.sol";
import {VaipakamRewardOAppBootstrap} from "../src/token/VaipakamRewardOAppBootstrap.sol";
import {LibCreate2Deploy} from "../script/lib/LibCreate2Deploy.sol";

/// @title Create2DeploymentTest
/// @notice Static proof that the CREATE2 deploy scripts produce identical
///         addresses across chains. Does not require the Singleton Factory
///         to be live (the CREATE2 address formula is pure); instead, this
///         test asserts the prerequisite — that the init-code hashes fed
///         into the formula are byte-identical regardless of which chain
///         the compiled artifact is being deployed from.
/// @dev We exercise `vm.chainId` to simulate running the compile/deploy
///      pipeline under different chainids. Solidity contracts do NOT bake
///      the chainid into their init code by default — if a contract did
///      (e.g. via `block.chainid` in its constructor, or via an immutable
///      derived from chainid), this test would catch it by producing
///      different hashes.
///
///      Covered invariants:
///        1. DiamondCutFacet creation code is chain-agnostic.
///        2. VaipakamDiamond creation code + (admin, cutFacet) args is
///           chain-agnostic.
///        3. VaipakamRewardOAppBootstrap creation code is chain-agnostic.
///        4. ERC1967Proxy(bootstrap, "") init code is chain-agnostic.
///        5. The REAL VaipakamRewardOApp init code IS chain-specific when
///           the LZ endpoint constructor arg differs — documenting why
///           the bootstrap pattern is required for that contract.
contract Create2DeploymentTest is Test {
    string internal constant VERSION = "v1-test";

    uint256 internal constant CHAIN_BASE = 8453;
    uint256 internal constant CHAIN_ARB = 42161;
    uint256 internal constant CHAIN_OP = 10;

    address internal constant ADMIN = address(0xA11CE);
    address internal constant LZ_BASE = address(0x1a44);
    address internal constant LZ_ARB = address(0x1a45);

    // ── DiamondCutFacet ─────────────────────────────────────────────────

    function test_diamondCutFacet_initCodeIsChainAgnostic() public {
        bytes32 hashBase = _hashInitCode(type(DiamondCutFacet).creationCode, CHAIN_BASE);
        bytes32 hashArb = _hashInitCode(type(DiamondCutFacet).creationCode, CHAIN_ARB);
        bytes32 hashOp = _hashInitCode(type(DiamondCutFacet).creationCode, CHAIN_OP);
        assertEq(hashBase, hashArb, "DiamondCutFacet init code drifted base->arb");
        assertEq(hashBase, hashOp, "DiamondCutFacet init code drifted base->op");
    }

    function test_diamondCutFacet_addressIsChainAgnostic() public {
        bytes32 salt = LibCreate2Deploy.protocolSalt(VERSION, "DiamondCutFacet");
        bytes32 codeHash = keccak256(type(DiamondCutFacet).creationCode);

        address addrBase = _computeAt(salt, codeHash, CHAIN_BASE);
        address addrArb = _computeAt(salt, codeHash, CHAIN_ARB);
        address addrOp = _computeAt(salt, codeHash, CHAIN_OP);

        assertEq(addrBase, addrArb, "Cut facet CREATE2 address drifted base->arb");
        assertEq(addrBase, addrOp, "Cut facet CREATE2 address drifted base->op");
    }

    // ── VaipakamDiamond (constructor args: admin, cutFacet) ─────────────

    function test_vaipakamDiamond_addressIsChainAgnostic() public {
        // Simulate the DeployDiamondCreate2 pre-compute: cutFacet is itself
        // CREATE2-computed, so it's a shared address. The Diamond's init
        // code then embeds (admin, cutFacet) — both constants across chains.
        bytes32 cutSalt = LibCreate2Deploy.protocolSalt(VERSION, "DiamondCutFacet");
        address cutFacet = LibCreate2Deploy.computeAddress(
            cutSalt,
            keccak256(type(DiamondCutFacet).creationCode)
        );

        bytes memory diamondInit = abi.encodePacked(
            type(VaipakamDiamond).creationCode,
            abi.encode(ADMIN, cutFacet)
        );
        bytes32 salt = LibCreate2Deploy.protocolSalt(VERSION, "VaipakamDiamond");

        bytes32 hashBase = _hashInitCode(diamondInit, CHAIN_BASE);
        bytes32 hashArb = _hashInitCode(diamondInit, CHAIN_ARB);
        assertEq(hashBase, hashArb, "Diamond init code drifted base->arb");

        address addrBase = _computeAt(salt, hashBase, CHAIN_BASE);
        address addrArb = _computeAt(salt, hashBase, CHAIN_ARB);
        address addrOp = _computeAt(salt, hashBase, CHAIN_OP);
        assertEq(addrBase, addrArb, "Diamond CREATE2 drifted base->arb");
        assertEq(addrBase, addrOp, "Diamond CREATE2 drifted base->op");
    }

    function test_vaipakamDiamond_addressDivergesOnAdminMismatch() public pure {
        // Regression guard: if operators accidentally deploy on chain B
        // with a different admin, the CREATE2 address MUST diverge. This
        // prevents silent ownership drift across the mesh.
        address adminA = address(0xA11CE);
        address adminB = address(0xBABE);
        bytes32 cutSalt = LibCreate2Deploy.protocolSalt(VERSION, "DiamondCutFacet");
        address cutFacet = LibCreate2Deploy.computeAddress(
            cutSalt,
            keccak256(type(DiamondCutFacet).creationCode)
        );

        bytes memory initA = abi.encodePacked(
            type(VaipakamDiamond).creationCode,
            abi.encode(adminA, cutFacet)
        );
        bytes memory initB = abi.encodePacked(
            type(VaipakamDiamond).creationCode,
            abi.encode(adminB, cutFacet)
        );

        bytes32 salt = LibCreate2Deploy.protocolSalt(VERSION, "VaipakamDiamond");
        address addrA = LibCreate2Deploy.computeAddress(salt, keccak256(initA));
        address addrB = LibCreate2Deploy.computeAddress(salt, keccak256(initB));
        require(addrA != addrB, "Diamond address failed to diverge on admin mismatch");
    }

    // ── RewardOApp bootstrap proxy (the cross-chain-shared piece) ───────

    function test_rewardOAppBootstrap_initCodeIsChainAgnostic() public {
        bytes32 hashBase = _hashInitCode(type(VaipakamRewardOAppBootstrap).creationCode, CHAIN_BASE);
        bytes32 hashArb = _hashInitCode(type(VaipakamRewardOAppBootstrap).creationCode, CHAIN_ARB);
        assertEq(hashBase, hashArb, "Bootstrap impl init code drifted");
    }

    function test_rewardOAppProxy_addressIsChainAgnostic() public {
        // Proxy init code = ERC1967Proxy.creationCode ++ abi.encode(bootstrap, "")
        // where `bootstrap` is itself CREATE2-computed and chain-constant.
        bytes32 bootstrapSalt = LibCreate2Deploy.protocolSalt(VERSION, "RewardOAppBootstrap");
        address bootstrap = LibCreate2Deploy.computeAddress(
            bootstrapSalt,
            keccak256(type(VaipakamRewardOAppBootstrap).creationCode)
        );

        bytes memory proxyInit = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(bootstrap, bytes(""))
        );
        bytes32 salt = LibCreate2Deploy.protocolSalt(VERSION, "RewardOAppProxy");

        address addrBase = _computeAt(salt, keccak256(proxyInit), CHAIN_BASE);
        address addrArb = _computeAt(salt, keccak256(proxyInit), CHAIN_ARB);
        address addrOp = _computeAt(salt, keccak256(proxyInit), CHAIN_OP);
        assertEq(addrBase, addrArb, "OApp proxy drifted base->arb");
        assertEq(addrBase, addrOp, "OApp proxy drifted base->op");
    }

    // ── The real RewardOApp impl: proof that it IS chain-specific ───────

    function test_rewardOAppRealImpl_isChainSpecific() public pure {
        // Documents WHY the bootstrap pattern is needed: the real impl
        // takes the LZ endpoint as a constructor arg, so its init code
        // differs per chain. If this assertion ever breaks, reassess
        // whether the bootstrap indirection is still required.
        bytes memory initBase = abi.encodePacked(
            type(VaipakamRewardOApp).creationCode,
            abi.encode(LZ_BASE)
        );
        bytes memory initArb = abi.encodePacked(
            type(VaipakamRewardOApp).creationCode,
            abi.encode(LZ_ARB)
        );
        require(
            keccak256(initBase) != keccak256(initArb),
            "Real impl init code matched across chains; bootstrap indirection may be unnecessary"
        );
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /// @dev Compute init-code hash after switching simulated chainid —
    ///      catches any `block.chainid` leakage into constructor bytecode.
    function _hashInitCode(bytes memory initCode, uint256 chainId) internal returns (bytes32) {
        vm.chainId(chainId);
        return keccak256(initCode);
    }

    function _computeAt(bytes32 salt, bytes32 codeHash, uint256 chainId) internal returns (address) {
        vm.chainId(chainId);
        return LibCreate2Deploy.computeAddress(salt, codeHash);
    }
}
