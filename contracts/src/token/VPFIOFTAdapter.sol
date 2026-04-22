// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OFTAdapterUpgradeable} from "@layerzerolabs/oft-evm-upgradeable/contracts/oft/OFTAdapterUpgradeable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

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
