// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {GuardianPausable} from "../../src/crosschain/GuardianPausable.sol";

// Stand-ins for the authority shapes the governance handover moves: a
// GuardianPausable cross-chain contract, an OpenZeppelin Ownable2Step target
// (VPFIToken, the rate governor), CHAINLINK's two-step ownership (the CCIP
// TokenPool) and the CCT TokenAdminRegistry. Shared by
// `test/GovernanceHandover.t.sol` and `test/deploy/HandoverGateTest.t.sol`,
// so the handover readback and the live gate are exercised against the same
// shapes.

/**
 * @dev Minimal UUPS contract that mixes in {GuardianPausable} — the same
 *      guardian + Ownable2Step surface every Vaipakam cross-chain contract
 *      (CcipMessenger, VaipakamRewardMessenger) carries. Used as their stand-in for the
 *      handover invariant checks.
 */
contract CrossChainGuardianHarness is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    UUPSUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _guardianPausableInit();
    }

    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function transferOwnership(
        address newOwner
    ) public override(OwnableUpgradeable, Ownable2StepUpgradeable) onlyOwner {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    function _transferOwnership(
        address newOwner
    ) internal override(OwnableUpgradeable, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}

/**
 * @dev Minimal Ownable2Step contract used as a VPFIToken stand-in for the
 *      handover test. Exposes the same two-step ownership surface the real
 *      token uses, without pulling in the full ERC20 / OFT / UUPS stack.
 */
contract OwnableERC20Stub is Ownable2StepUpgradeable {
    constructor(address owner_) {
        // Direct storage init — we're not behind a proxy, so the
        // upgradeable initializers are overkill. The Ownable2Step
        // transfer/accept semantics still work against this direct-
        // initialized owner.
        _transferOwnership(owner_);
    }
}

/**
 * @dev A handover target with NO guardian — `VpfiPoolRateGovernor`'s shape.
 *      It exists because scoping the ownership assertions to "the
 *      GuardianPausable contracts" silently exempted the one contract whose
 *      owner sets every lane's rate limits and authorizes UUPS upgrades
 *      (Codex #1941 r4). Without a non-guardian target in this harness, that
 *      scoping bug passes the gate.
 */
contract PlainOwnable2StepHarness is Ownable2StepUpgradeable {
    constructor(address owner_) {
        _transferOwnership(owner_);
    }
}

/**
 * @dev CHAINLINK's two-step ownership shape, which the CCIP `TokenPool` uses
 *      via `Ownable2StepMsgSender`: the pending owner is PRIVATE and there is
 *      no `pendingOwner()` getter, so an OZ-style readback REVERTS on it and
 *      the state is only observable from the events (Codex #1941 r5).
 *
 *      Deliberately a re-implementation rather than an import: the point is to
 *      pin the SHAPE the runbook must cope with — a target whose pending owner
 *      cannot be read — so the gate fails if someone "simplifies" the runbook
 *      back to a blanket `pendingOwner()` call.
 */
contract ChainlinkStyleOwnable2StepHarness {
    address private s_owner;
    address private s_pendingOwner;

    event OwnershipTransferRequested(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error MustBeProposedOwner();
    error OnlyCallableByOwner();
    error CannotTransferToSelf();

    constructor(address owner_) {
        s_owner = owner_;
    }

    function owner() external view returns (address) {
        return s_owner;
    }

    function transferOwnership(address to) external {
        if (msg.sender != s_owner) revert OnlyCallableByOwner();
        if (to == msg.sender) revert CannotTransferToSelf();
        // NOTE: zero is PERMITTED — that is how an outstanding transfer is
        // cancelled, and it emits a Requested event that can never be
        // followed by a Transferred.
        s_pendingOwner = to;
        emit OwnershipTransferRequested(s_owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != s_pendingOwner) revert MustBeProposedOwner();
        address old = s_owner;
        s_owner = msg.sender;
        s_pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }
}

/**
 * @dev The CCIP `TokenAdminRegistry` administrator surface. A SEPARATE
 *      two-step transfer from any ownership handover, with its own accept
 *      function on a different contract — which is exactly why it was missed
 *      (Codex #1941 r5/r6).
 */
contract TokenAdminRegistryStub {
    /// @dev Same three fields as the real registry's `TokenConfig`, so a
    ///      reader that decodes the real struct decodes this one too.
    struct TokenConfig {
        address administrator;
        address pendingAdministrator;
        address tokenPool;
    }

    mapping(address => TokenConfig) private configs;

    error OnlyAdministrator();
    error OnlyPendingAdministrator();

    function seed(address token, address administrator_) external {
        configs[token].administrator = administrator_;
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory) {
        return configs[token];
    }

    function transferAdminRole(address token, address to) external {
        if (msg.sender != configs[token].administrator) revert OnlyAdministrator();
        configs[token].pendingAdministrator = to;
    }

    function acceptAdminRole(address token) external {
        if (msg.sender != configs[token].pendingAdministrator) revert OnlyPendingAdministrator();
        configs[token].administrator = msg.sender;
        configs[token].pendingAdministrator = address(0);
    }
}
