// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {OFTUpgradeable} from "@layerzerolabs/oft-evm-upgradeable/contracts/oft/OFTUpgradeable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title VPFIMirror
 * @author Vaipakam Developer Team
 * @notice Non-canonical-chain VPFI representation — a pure LayerZero OFT V2
 *         token that mints on inbound bridge and burns on outbound bridge,
 *         with no independent minter surface.
 * @dev Phase 1 OFT V2 deployment topology (independent-Diamond per chain
 *      with a shared VPFI-mesh):
 *        - Canonical (Base):    VPFIToken + VPFIOFTAdapter
 *        - Mirror (Eth/Poly/ \
 *          Arb/Op):             VPFIMirror (this contract, one per chain)
 *
 *      Key properties vs. the canonical VPFIToken:
 *        - No hard cap: supply on this chain = currently-bridged-in VPFI.
 *          The global cap is enforced by the canonical adapter's lock-set.
 *        - No `mint(to, amount)` minter surface: the ONLY way VPFI can be
 *          minted here is via `_credit` from an authenticated LayerZero
 *          message originating at an authorized peer (the canonical adapter
 *          or another mirror), gated by OApp's peer registry.
 *        - Same name, symbol, decimals (18) as the canonical token so
 *          wallets and block explorers present a unified token identity.
 *
 *      Per project convention (see CLAUDE.md: "contracts outside the Diamond
 *      must use UUPS upgradeable + ERC1967Proxy"), this mirror is UUPS so
 *      future LayerZero endpoint migrations or bug-fix upgrades do not
 *      require redeploying the peer mesh.
 */
contract VPFIMirror is
    Initializable,
    OFTUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    IVaipakamErrors
{
    /// @param lzEndpoint LayerZero V2 endpoint address for the chain this
    ///                   implementation will back. Baked into immutables by
    ///                   OFTUpgradeable; proxies pointing at this
    ///                   implementation inherit the wired endpoint.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address lzEndpoint) OFTUpgradeable(lzEndpoint) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the mirror proxy.
     * @dev Wires the OApp delegate (typically the protocol's Gnosis Safe
     *      behind a timelock) so it can register DVNs, set peers, and
     *      configure enforced options via the LayerZero endpoint. Also sets
     *      that same address as the Ownable2Step owner guarding UUPS
     *      upgrades. Reverts with InvalidAddress on zero.
     * @param owner_ Owner / OApp delegate (expected: timelock-gated multi-sig).
     */
    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert InvalidAddress();

        __OFT_init("Vaipakam DeFi Token", "VPFI", owner_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __Pausable_init();
    }

    // ─── Emergency pause ─────────────────────────────────────────────────────

    /// @notice Pause both the outbound-burn and inbound-mint legs of this
    ///         mirror. Intended as the timelock / multi-sig emergency lever
    ///         for a suspected LayerZero-side incident (DVN compromise,
    ///         executor failure, unknown exploit). The April 2026 cross-
    ///         chain bridge exploit demonstrated the value of a fast pause
    ///         — a 46-minute pause in that incident blocked ~$200M of
    ///         follow-up drain.
    /// @dev Only the owner (OApp delegate — timelock-gated multi-sig) may
    ///      call. See `_debit` / `_credit` overrides for the send/receive
    ///      guards.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume send / receive paths after an incident has been
    ///         investigated and resolved.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Guards the outbound burn leg. When paused, users cannot initiate
    ///      bridged-out sends from this chain — burns are rejected before
    ///      any LayerZero packet is emitted.
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

    /// @dev Guards the inbound mint leg. When paused, incoming LayerZero
    ///      packets are rejected at the OFT layer — no new VPFI is minted
    ///      on this chain until `unpause()` is called. Peer verification
    ///      still runs first (OApp trust model), so legit retries after
    ///      unpause succeed.
    function _credit(
        address _to,
        uint256 _amountLD,
        uint32 _srcEid
    ) internal override whenNotPaused returns (uint256 amountReceivedLD) {
        return super._credit(_to, _amountLD, _srcEid);
    }

    /// @dev UUPS authorization hook. Only the owner (timelock/multi-sig)
    ///      may authorize upgrades to a new implementation.
    /// @param newImplementation Candidate implementation address.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Ownable MRO Resolution ──────────────────────────────────────────────

    /// @dev OAppCore inherits `OwnableUpgradeable` and we additionally mix in
    ///      `Ownable2StepUpgradeable`. Both define `transferOwnership` and
    ///      `_transferOwnership` with identical signatures, so Solidity
    ///      requires us to disambiguate. Routing to the Ownable2Step versions
    ///      gives us the accept-pattern guard protecting owner rotation
    ///      (matches the canonical-side adapter's ownership model).
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
