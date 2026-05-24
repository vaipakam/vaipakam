// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";

import {GuardianPausable} from "./GuardianPausable.sol";

/**
 * @title VPFIMirrorToken — the non-canonical-chain VPFI representation
 *        under Chainlink CCIP (T-068 Phase 2)
 *
 * The CCIP **Cross-Chain Token (CCT)** model separates the *token* from
 * the *pool*. The old `VPFIMirror` fused the token with LayerZero OFT
 * transport logic; this contract is the de-fused half — a plain
 * burn/mint ERC20 with NO transport logic of its own. CCIP's
 * `BurnMintTokenPool` is the transport adapter: it is the sole address
 * permitted to {mint} (on inbound delivery) and {burn} (on outbound send).
 *
 * Invariant preserved from the LayerZero design: this chain's VPFI supply
 * equals the VPFI currently bridged in. There is **no admin / EOA mint
 * surface** — the only minter is the registered CCIP pool, and the only
 * burner likewise. The 230M global cap stays enforced on the canonical
 * `VPFIToken` (Base); one VPFI locked in the canonical `LockReleaseTokenPool`
 * backs exactly one mirror VPFI minted somewhere across the mesh.
 *
 * Same name / symbol / decimals (18) as the canonical token, so wallets
 * and explorers present one unified VPFI identity.
 *
 * @dev Targets CCIP's `BurnMintTokenPool` — the `burn(amount)` pool
 *      variant — so only `mint(address,uint256)` and `burn(uint256)` are
 *      exposed; the `burnFrom` / `burn(address,uint256)` variants used by
 *      the other stock pools are intentionally not implemented. The
 *      contract is NOT declared `is IBurnMintERC20` because that interface
 *      drags in Chainlink's vendored OZ-v4 `IERC20`, which collides with
 *      OZ-v5's `IERC20` that {ERC20Upgradeable} already provides; the pool
 *      reaches it via an `IBurnMintERC20(address(token))` cast, which only
 *      needs the two function selectors to exist — and they do.
 *
 *      UUPS-upgradeable per the project convention for non-Diamond
 *      contracts; guardian + owner emergency pause freezes every transfer,
 *      mint and burn.
 */
contract VPFIMirrorToken is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    UUPSUpgradeable
{
    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice The CCIP `BurnMintTokenPool` for this chain — the ONLY
    ///         address allowed to {mint} or {burn}. Zero until
    ///         {setTokenPool} is called post-deploy (the pool's address is
    ///         only known after the pool itself is deployed).
    address public tokenPool;

    /// @dev Reserved storage for upgrade-safe appends (1 slot used above).
    uint256[49] private __gap;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @notice Emitted when the authorized CCIP pool is set or rotated.
    /// @custom:event-category informational/config
    event TokenPoolUpdated(address indexed previousPool, address indexed newPool);

    // ─── Errors ─────────────────────────────────────────────────────────────

    /// @notice A zero address was supplied where a contract is required.
    error ZeroAddress();
    /// @notice {mint} / {burn} called by an address other than {tokenPool}.
    error NotTokenPool(address caller);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the mirror-token proxy.
    /// @param owner_ Owner (the admin multi-sig initially, the governance
    ///        timelock later) — sets the token pool, the guardian, pauses,
    ///        and authorizes upgrades.
    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __ERC20_init("Vaipakam DeFi Token", "VPFI");
        __ERC20Pausable_init();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _guardianPausableInit();
    }

    // ─── Pool management ────────────────────────────────────────────────────

    /// @notice Set (or rotate) the CCIP pool authorized to mint and burn.
    /// @dev Owner-only. Rotation support exists for the CCT pool-upgrade
    ///      path (CCIP swaps a pool via the `TokenAdminRegistry`); the new
    ///      pool must be installed here in the same governance action.
    /// @param newPool The `BurnMintTokenPool` deployed for this chain.
    function setTokenPool(address newPool) external onlyOwner {
        if (newPool == address(0)) revert ZeroAddress();
        address previous = tokenPool;
        tokenPool = newPool;
        emit TokenPoolUpdated(previous, newPool);
    }

    /// @dev Extracted modifier body — the modifier itself stays a thin
    ///      wrapper so each call site inlines a single function call
    ///      instead of the full check, deduping bytecode.
    function _checkTokenPool() private view {
        if (msg.sender != tokenPool) revert NotTokenPool(msg.sender);
    }

    /// @dev Restricts a call to the registered CCIP pool.
    modifier onlyTokenPool() {
        _checkTokenPool();
        _;
    }

    // ─── Mint / burn — CCIP pool only ───────────────────────────────────────

    /// @notice Mint mirror VPFI to `account`. Called by the CCIP pool when
    ///         a cross-chain transfer is delivered to this chain.
    /// @dev Pool-gated — there is no other mint path. `whenNotPaused` is
    ///      inherited via {_update}; a paused token rejects the mint.
    function mint(address account, uint256 amount) external onlyTokenPool {
        _mint(account, amount);
    }

    /// @notice Burn `amount` of mirror VPFI from the caller's balance.
    ///         Called by the CCIP pool (which holds the user's tokens by
    ///         the time it burns) when a cross-chain transfer leaves this
    ///         chain.
    /// @dev Pool-gated: restricting burn to the pool keeps this chain's
    ///      `totalSupply` exactly equal to the VPFI bridged in — a holder
    ///      cannot unilaterally destroy mirror supply and strand the
    ///      backing VPFI locked on the canonical chain.
    function burn(uint256 amount) external onlyTokenPool {
        _burn(msg.sender, amount);
    }

    // ─── Emergency pause ────────────────────────────────────────────────────

    /// @notice Freeze every transfer, mint and burn. Guardian or owner —
    ///         the fast detect-to-freeze lever.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume. Owner-only — recovery travels the governance path.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── UUPS / MRO resolution ──────────────────────────────────────────────

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    /// @dev Pause enforcement on every balance change (transfer/mint/burn).
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._update(from, to, value);
    }

    /// @dev `transferOwnership` is defined by both {OwnableUpgradeable}
    ///      (reached via {GuardianPausable}) and {Ownable2StepUpgradeable};
    ///      resolve to the two-step variant.
    function transferOwnership(
        address newOwner
    ) public override(OwnableUpgradeable, Ownable2StepUpgradeable) onlyOwner {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    /// @dev MRO resolution for the internal counterpart.
    function _transferOwnership(
        address newOwner
    ) internal override(OwnableUpgradeable, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}
