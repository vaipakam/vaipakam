// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OFTAdapterUpgradeable} from "@layerzerolabs/oft-evm-upgradeable/contracts/oft/OFTAdapterUpgradeable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LZGuardianPausable} from "./LZGuardianPausable.sol";

/**
 * @title VPFIOFTAdapter
 * @author Vaipakam Developer Team
 * @notice Canonical-chain LayerZero OFT V2 adapter that wraps the per-chain
 *         VPFIToken (ERC20Capped). Deployed ONCE, on the canonical chain only
 *         — Base mainnet (chainId 8453) in production, Base Sepolia (84532)
 *         during Phase 1 testnet rollout.
 * @dev Phase 1 OFT V2 deployment topology (independent-Diamond per chain
 *      with a shared VPFI-mesh):
 *        - Canonical (Base):    VPFIToken + VPFIOFTAdapter (this contract)
 *        - Mirror (Eth/Poly/ \
 *          Arb/Op):             VPFIMirror (pure OFT, no mint surface)
 *
 *      Bridging semantics:
 *        - OUT (Base → mirror chain): user approves adapter for N VPFI,
 *          calls `send(...)`. Adapter locks N VPFI via `safeTransferFrom`,
 *          emits a LayerZero message, and the mirror's `_credit` mints N
 *          VPFI on the destination chain.
 *        - IN  (mirror → Base): mirror burns N VPFI, adapter's `_credit`
 *          unlocks (transfers) N VPFI from its balance to the recipient.
 *
 *      Total circulating supply across the mesh is bounded by the canonical
 *      `VPFIToken.TOTAL_SUPPLY_CAP` (230M) because every mirrored VPFI is
 *      backed 1:1 by a locked VPFI inside this adapter.
 *
 *      Per project convention (see CLAUDE.md: "contracts outside the Diamond
 *      must use UUPS upgradeable + ERC1967Proxy"), this adapter is UUPS so
 *      LayerZero endpoint upgrades and enforced-options migrations do not
 *      require redeploying the peer mesh.
 */
contract VPFIOFTAdapter is
    Initializable,
    OFTAdapterUpgradeable,
    Ownable2StepUpgradeable,
    LZGuardianPausable,
    UUPSUpgradeable,
    IVaipakamErrors
{
    /// @param vpfiToken  Canonical-chain VPFI ERC20 proxy this adapter locks.
    /// @param lzEndpoint LayerZero V2 endpoint on the canonical chain. Both
    ///                   values are baked into immutables by the upstream
    ///                   adapter; proxies pointing at this implementation
    ///                   inherit them.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        address vpfiToken,
        address lzEndpoint
    ) OFTAdapterUpgradeable(vpfiToken, lzEndpoint) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the adapter proxy.
     * @dev Wires the OApp delegate (typically the protocol's Gnosis Safe
     *      behind a timelock) so it can register DVNs, set peers, and
     *      configure enforced options via the LayerZero endpoint. Also sets
     *      that same address as the Ownable2Step owner guarding UUPS
     *      upgrades. Reverts with InvalidAddress on zero.
     * @param owner_ Owner / OApp delegate (expected: timelock-gated multi-sig).
     */
    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert InvalidAddress();

        __OFTAdapter_init(owner_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __LZGuardianPausable_init();
    }

    /// @dev UUPS authorization hook. Only the owner (timelock/multi-sig)
    ///      may authorize upgrades to a new implementation.
    /// @param newImplementation Candidate implementation address.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Emergency pause ─────────────────────────────────────────────────────

    /// @notice Pause both the outbound lock leg and the inbound release leg
    ///         of the canonical adapter. Intended as the timelock / multi-sig
    ///         emergency lever for a suspected LayerZero-side incident (DVN
    ///         compromise, executor failure, unknown exploit). The April
    ///         2026 cross-chain bridge exploit demonstrated the value of a
    ///         fast pause — a 46-minute pause in that incident blocked
    ///         ~$200M of follow-up drain. Because this adapter holds every
    ///         bridged-out VPFI locked on Base, pausing `_credit` in
    ///         particular protects the canonical honeypot from a fake
    ///         inbound release.
    /// @dev Callable by either the guardian (incident-response multi-sig,
    ///      no timelock) or the owner (timelock-gated multi-sig). The
    ///      guardian path exists so the pause can land inside the
    ///      detect-to-freeze window that a 48h timelock would otherwise
    ///      foreclose. See `_debit` / `_credit` overrides for the
    ///      send/receive guards.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume send / receive paths after an incident has been
    ///         investigated and resolved.
    /// @dev Deliberately owner-only. Recovery must travel the full
    ///      governance path — a compromised or impatient guardian must
    ///      not be able to race the incident team to unpause.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Guards the outbound lock leg. When paused, users cannot initiate
    ///      bridged-out sends from Base — locks are rejected before any
    ///      LayerZero packet is emitted.
    function _debit(
        address _from,
        uint256 _amountLD,
        uint256 _minAmountLD,
        uint32 _dstEid
    )
        internal
        override
        whenNotPaused
        returns (uint256 amountSentLD, uint256 amountReceivedLD)
    {
        return super._debit(_from, _amountLD, _minAmountLD, _dstEid);
    }

    /// @dev Guards the inbound release leg — the high-value path that holds
    ///      the locked canonical supply. When paused, an incoming LayerZero
    ///      packet (even one signed by compromised DVNs) cannot unlock the
    ///      adapter's VPFI. Peer verification still runs first at the OApp
    ///      layer, so legitimate retries after `unpause()` succeed.
    function _credit(
        address _to,
        uint256 _amountLD,
        uint32 _srcEid
    ) internal override whenNotPaused returns (uint256 amountReceivedLD) {
        return super._credit(_to, _amountLD, _srcEid);
    }

    // ─── Ownable MRO Resolution ──────────────────────────────────────────────

    /// @dev OAppCore inherits `OwnableUpgradeable` and we additionally mix in
    ///      `Ownable2StepUpgradeable`. Both define `transferOwnership` and
    ///      `_transferOwnership` with identical signatures, so Solidity
    ///      requires us to disambiguate. Routing to the Ownable2Step versions
    ///      gives us the accept-pattern guard protecting owner rotation
    ///      (matches VPFIToken's ownership model).
    /// @param newOwner Proposed owner (must accept via `acceptOwnership`).
    function transferOwnership(
        address newOwner
    ) public override(OwnableUpgradeable, Ownable2StepUpgradeable) onlyOwner {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    /// @dev Internal counterpart to {transferOwnership} disambiguation.
    /// @param newOwner New owner to persist (pending state is handled by Ownable2Step).
    function _transferOwnership(
        address newOwner
    ) internal override(OwnableUpgradeable, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}
