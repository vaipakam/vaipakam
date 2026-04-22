// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20BurnableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import {ERC20CappedUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20CappedUpgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {IVPFIToken} from "../interfaces/IVPFIToken.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title VPFIToken
 * @author Vaipakam Developer Team
 * @notice UUPS-upgradeable canonical-chain implementation of the Vaipakam
 *         DeFi Token (VPFI).
 * @dev Phase 1 tokenomics token, deployed ONCE behind an ERC1967Proxy on
 *      the canonical chain (Base mainnet / Base Sepolia testnet). Per
 *      docs/TokenomicsTechSpec.md:
 *        - name "Vaipakam DeFi Token", symbol "VPFI", decimals 18
 *        - hard cap of 230_000_000 VPFI
 *        - one-time initial mint of 23_000_000 VPFI (10% of cap)
 *        - all further mints routed through a single `minter` address,
 *          expected to be the TreasuryFacet (or a dedicated distributor)
 *          behind the protocol's Gnosis Safe + timelock
 *        - no direct EOA minting
 *
 *      The cap is enforced natively by ERC20CappedUpgradeable's _update
 *      override (reverts with ERC20ExceededCap). Pausing freezes all
 *      transfers including mints, providing an emergency brake.
 *
 *      Cross-chain role in the Phase 1 mesh: this contract lives on the
 *      canonical chain only. Its sibling `VPFIOFTAdapter` (also on the
 *      canonical chain) wraps balances here and bridges them via
 *      LayerZero OFT V2 to per-chain `VPFIMirror` OFTs on every other
 *      Diamond deploy (Polygon / Arbitrum / Optimism / Ethereum mainnet,
 *      plus Sepolia testnet). Because the adapter locks rather than burns
 *      on outbound sends, the 230M cap enforced on this contract is the
 *      global cap across the whole mesh — one locked VPFI = one minted
 *      mirror VPFI somewhere else.
 *
 *      This implementation is UUPS-upgradeable and uses namespaced
 *      (ERC-7201) storage from OpenZeppelin v5, so future upgrades
 *      (e.g. enforced-options tweaks surfaced through the adapter) are
 *      storage-safe without requiring reserved gaps.
 */
contract VPFIToken is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20CappedUpgradeable,
    ERC20PausableUpgradeable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    IVPFIToken,
    IVaipakamErrors
{
    /// @inheritdoc IVPFIToken
    uint256 public constant TOTAL_SUPPLY_CAP = 230_000_000 ether;

    /// @inheritdoc IVPFIToken
    uint256 public constant INITIAL_MINT = 23_000_000 ether;

    /// @notice Address authorized to call `mint(...)`.
    /// @dev Expected to be the TreasuryFacet or a dedicated distributor
    ///      contract. Rotated via `setMinter` by the owner (timelock +
    ///      multi-sig).
    address public minter;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the VPFI token proxy.
     * @dev Mints the 23M VPFI initial supply to `initialMintRecipient` and
     *      wires the initial `minter`. The `owner_` is expected to be the
     *      timelock-gated multi-sig; it is the only address that can
     *      authorize subsequent UUPS upgrades and minter rotations.
     *      Reverts with InvalidAddress if any of the three arguments is
     *      zero.
     * @param owner_                  Owner (expected: timelock/multi-sig).
     * @param initialMintRecipient    Recipient of the 23M initial mint
     *                                (expected: Gnosis Safe / treasury).
     * @param initialMinter           First authorized `mint(...)` caller.
     */
    function initialize(
        address owner_,
        address initialMintRecipient,
        address initialMinter
    ) external initializer {
        if (
            owner_ == address(0) ||
            initialMintRecipient == address(0) ||
            initialMinter == address(0)
        ) revert InvalidAddress();

        __ERC20_init("Vaipakam DeFi Token", "VPFI");
        __ERC20Burnable_init();
        __ERC20Capped_init(TOTAL_SUPPLY_CAP);
        __ERC20Pausable_init();
        __Ownable_init(owner_);
        __Ownable2Step_init();

        minter = initialMinter;
        emit MinterUpdated(address(0), initialMinter);

        _mint(initialMintRecipient, INITIAL_MINT);
        emit Minted(initialMintRecipient, INITIAL_MINT);
    }

    // ─── Mint / Minter Management ────────────────────────────────────────────

    /// @inheritdoc IVPFIToken
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        _mint(to, amount);
        emit Minted(to, amount);
    }

    /// @inheritdoc IVPFIToken
    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert InvalidAddress();

        address previous = minter;
        minter = newMinter;
        emit MinterUpdated(previous, newMinter);
    }

    // ─── Pause Controls ──────────────────────────────────────────────────────

    /// @notice Pause all transfers (including mints and burns).
    /// @dev Owner-only emergency brake. Transfers revert with EnforcedPause
    ///      while paused.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Lift the pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── UUPS Authorization ──────────────────────────────────────────────────

    /// @dev UUPS authorization hook. Only the owner (timelock/multi-sig)
    ///      may authorize upgrades to a new implementation.
    /// @param newImplementation Address of the candidate implementation.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Override Resolution ─────────────────────────────────────────────────

    /// @dev Combines cap enforcement and pause checks. Resolution order is
    ///      linearized by Solidity; `super._update` walks the MRO and
    ///      applies both checks before the core ERC20 state update.
    /// @param from  Source address (zero on mint).
    /// @param to    Destination address (zero on burn).
    /// @param value Token amount being moved.
    function _update(
        address from,
        address to,
        uint256 value
    )
        internal
        override(ERC20Upgradeable, ERC20CappedUpgradeable, ERC20PausableUpgradeable)
    {
        super._update(from, to, value);
    }
}
