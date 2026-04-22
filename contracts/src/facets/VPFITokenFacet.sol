// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IVPFIToken} from "../interfaces/IVPFIToken.sol";

/**
 * @title VPFITokenFacet
 * @author Vaipakam Developer Team
 * @notice Lightweight Diamond facet that registers the VPFI token proxy
 *         and exposes transparency views over its current state.
 * @dev Phase 1 tokenomics (docs/TokenomicsTechSpec.md §9 calls for "a
 *      lightweight VPFITokenFacet"). VPFI itself is a standalone
 *      UUPS-upgradeable contract outside the Diamond. Which VPFI lives
 *      on this chain depends on where the Diamond is deployed:
 *        - Canonical (Base mainnet / Base Sepolia testnet): the token is
 *          `VPFIToken` (ERC20Capped + minter + pause), sibling to
 *          `VPFIOFTAdapter` which bridges it via LayerZero OFT V2.
 *        - Mirror (Polygon / Arbitrum / Optimism / Ethereum mainnet +
 *          Sepolia testnet): the token is `VPFIMirror`, a pure OFT
 *          without a cap or a mint surface — supply arrives exclusively
 *          via the LZ peer mesh from the canonical adapter.
 *
 *      The facet's responsibilities are:
 *        1. Bind the Diamond to a specific VPFI proxy address
 *           (`setVPFIToken`, ADMIN_ROLE).
 *        2. Flip the `isCanonicalVPFIChain` flag exactly once, on the
 *           canonical deploy (`setCanonicalVPFIChain`, ADMIN_ROLE). This
 *           flag gates `TreasuryFacet.mintVPFI` so mirrors cannot mint.
 *        3. Provide gas-cheap view functions so the frontend and other
 *           facets can read cap headroom, minter, total supply, and
 *           balances without needing to know the token address directly.
 *
 *      Cap- and minter-specific views (`getVPFICap`, `getVPFICapHeadroom`,
 *      `getVPFIMinter`) return zero on mirror chains because the mirror
 *      token doesn't implement those getters — they're meaningful only
 *      where the canonical `VPFIToken` is the bound contract. Total
 *      supply and balanceOf are ERC20-standard and return real values on
 *      every chain.
 *
 *      The facet does NOT wrap mint/pause/setMinter. Those remain on the
 *      token contract itself under its own owner (timelock/multi-sig) so
 *      that accidentally giving the Diamond broad mint authority would
 *      require an explicit `token.setMinter(diamond)` call first — no
 *      implicit back-door through a Diamond cut.
 */
contract VPFITokenFacet is DiamondAccessControl, IVaipakamErrors {
    /// @notice Emitted when the VPFI token address registered on the
    ///         Diamond is updated.
    /// @param previousToken The address previously registered (zero if unset).
    /// @param newToken      The newly-registered VPFI token address.
    event VPFITokenSet(address indexed previousToken, address indexed newToken);

    /// @notice Emitted when the canonical-chain flag flips. Expected exactly
    ///         once in the protocol's lifetime — during the Base canonical
    ///         Diamond's deploy script. Any flip observed in production on
    ///         other chains indicates misconfiguration.
    /// @param isCanonical The new value.
    event CanonicalVPFIChainSet(bool isCanonical);

    /// @notice Register the VPFI token proxy address with the Diamond.
    /// @dev ADMIN_ROLE-only. Reverts with {InvalidAddress} on zero. Does
    ///      not validate that the target implements IVPFIToken — the
    ///      admin is expected to pass the ERC1967Proxy for the canonical
    ///      VPFIToken deployment. Emits {VPFITokenSet}.
    /// @param newToken The VPFI token proxy address (must be non-zero).
    function setVPFIToken(address newToken) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (newToken == address(0)) revert InvalidAddress();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address previous = s.vpfiToken;
        if (previous == newToken) return; // No-op: skip SSTORE + event on idempotent writes.
        s.vpfiToken = newToken;

        emit VPFITokenSet(previous, newToken);
    }

    /// @notice Returns the VPFI token proxy address registered with the
    ///         Diamond, or zero if not yet registered.
    /// @return The registered VPFI token proxy address (zero if unset).
    function getVPFIToken() external view returns (address) {
        return LibVaipakam.storageSlot().vpfiToken;
    }

    /// @notice Flag this Diamond as hosting the canonical VPFI + OFT adapter.
    /// @dev ADMIN_ROLE-only. Flips `isCanonicalVPFIChain` in Diamond storage.
    ///      Must be set to TRUE exactly once across the whole mesh — on the
    ///      Base (mainnet) / Base Sepolia (testnet) deploy where VPFIToken
    ///      and VPFIOFTAdapter live. Leaving this false on the other four
    ///      Diamond deploys (Polygon/Arbitrum/Optimism/Ethereum mainnet and
    ///      Sepolia testnet) is what prevents those Diamonds from minting
    ///      VPFI locally — they can only receive bridged supply via the LZ
    ///      peer mesh. Emits {CanonicalVPFIChainSet}.
    /// @param isCanonical New flag value.
    function setCanonicalVPFIChain(
        bool isCanonical
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.isCanonicalVPFIChain == isCanonical) return; // No-op guard.
        s.isCanonicalVPFIChain = isCanonical;
        emit CanonicalVPFIChainSet(isCanonical);
    }

    /// @notice Whether this Diamond is deployed on the canonical VPFI chain
    ///         (Base mainnet / Base Sepolia). True on exactly one chain in
    ///         the mesh; false on every mirror chain.
    /// @return True on the canonical Diamond deploy, false on every mirror.
    function isCanonicalVPFIChain() external view returns (bool) {
        return LibVaipakam.storageSlot().isCanonicalVPFIChain;
    }

    /// @notice Total VPFI in circulation across all holders on this chain.
    /// @dev Returns zero if the token is not yet registered.
    /// @return Total ERC20 supply on this chain, or zero if no token bound.
    function getVPFITotalSupply() external view returns (uint256) {
        address token = LibVaipakam.storageSlot().vpfiToken;
        if (token == address(0)) return 0;
        return IVPFIToken(token).totalSupply();
    }

    /// @notice Hard cap on VPFI total supply (230M * 1e18).
    /// @dev Only meaningful on the canonical chain where `VPFIToken` is
    ///      bound. On mirror chains the bound contract is `VPFIMirror`
    ///      (pure OFT, no cap surface) and this returns zero — the cap
    ///      is enforced globally by the canonical-side lock-set, not by
    ///      any mirror. Also returns zero if no token is registered yet.
    /// @return The hard supply cap (230M * 1e18) on the canonical chain; zero elsewhere.
    function getVPFICap() external view returns (uint256) {
        address token = _canonicalToken();
        if (token == address(0)) return 0;
        return IVPFIToken(token).TOTAL_SUPPLY_CAP();
    }

    /// @notice Remaining headroom under the cap (`cap - totalSupply`).
    /// @dev Used by the public transparency UI so users can see how much
    ///      of the 230M supply is still mintable. Meaningful only on the
    ///      canonical chain; returns zero on mirror chains (see
    ///      `getVPFICap`) and when no token is registered.
    /// @return Remaining mintable supply on the canonical chain; zero elsewhere.
    function getVPFICapHeadroom() external view returns (uint256) {
        address token = _canonicalToken();
        if (token == address(0)) return 0;
        IVPFIToken t = IVPFIToken(token);
        return t.TOTAL_SUPPLY_CAP() - t.totalSupply();
    }

    /// @notice The single address currently authorized to mint VPFI.
    /// @dev Only meaningful on the canonical chain. Mirror chains have no
    ///      mint surface (supply bridges in via the LZ peer mesh), so
    ///      this returns zero there and when no token is registered.
    /// @return The authorized minter address on the canonical chain; zero elsewhere.
    function getVPFIMinter() external view returns (address) {
        address token = _canonicalToken();
        if (token == address(0)) return address(0);
        return IVPFIToken(token).minter();
    }

    /// @notice Batch snapshot: token address, canonical flag, totalSupply, cap,
    ///         headroom, minter — in a single call. Used by the transparency UI
    ///         so the dashboard doesn't fan out six separate eth_calls just to
    ///         render one panel.
    /// @dev On mirror chains or when the token is not yet registered, the
    ///      cap/headroom/minter fields come back as zero (matches the
    ///      individual getters). totalSupply still resolves on both chains
    ///      because it's plain ERC20.
    /// @return token        The registered VPFI proxy (zero if unset).
    /// @return canonical    True iff this Diamond is flagged canonical.
    /// @return totalSupply  ERC20 total supply on this chain.
    /// @return cap          Hard supply cap on canonical chain; zero on mirrors.
    /// @return headroom     `cap - totalSupply` on canonical chain; zero on mirrors.
    /// @return minter       Authorized minter on canonical chain; zero on mirrors.
    function getVPFISnapshot()
        external
        view
        returns (
            address token,
            bool canonical,
            uint256 totalSupply,
            uint256 cap,
            uint256 headroom,
            address minter
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        token = s.vpfiToken;
        canonical = s.isCanonicalVPFIChain;
        if (token == address(0)) return (token, canonical, 0, 0, 0, address(0));

        IVPFIToken t = IVPFIToken(token);
        totalSupply = t.totalSupply();
        if (canonical) {
            cap = t.TOTAL_SUPPLY_CAP();
            headroom = cap - totalSupply;
            minter = t.minter();
        }
    }

    /// @dev Return the bound VPFI token iff this is the canonical chain, else
    ///      zero — shared guard for getVPFICap / getVPFICapHeadroom /
    ///      getVPFIMinter so their canonical checks don't drift apart.
    /// @return The bound token address when `isCanonicalVPFIChain`, else zero.
    function _canonicalToken() internal view returns (address) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.isCanonicalVPFIChain) return address(0);
        return s.vpfiToken;
    }

    /// @notice VPFI balance of `account`, normalized to token decimals (18).
    /// @dev Returns zero if the token is not registered (matches balance
    ///      semantics: an unregistered token has no holders from the
    ///      Diamond's perspective).
    /// @param account Holder address to query.
    /// @return        ERC20 balance of `account`, or zero if no token bound.
    function getVPFIBalanceOf(address account) external view returns (uint256) {
        address token = LibVaipakam.storageSlot().vpfiToken;
        if (token == address(0)) return 0;
        return IVPFIToken(token).balanceOf(account);
    }
}
