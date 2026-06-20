// src/facets/VaultFactoryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title VaultFactoryFacet
 * @author Vaipakam Developer Team
 * @notice This facet manages the creation, initialization, and upgrade of per-user UUPS vault proxies in the Vaipakam platform.
 * @dev This contract is part of the Diamond Standard (EIP-2535) and uses shared storage from LibVaipakam.
 *      It deploys ERC1967Proxy instances per user, all pointing to a shared upgradable VaipakamVaultImplementation.
 *      The Diamond owns the implementation and controls upgrades.
 *      Provides public helpers for ERC20, ERC721, and ERC1155 deposit/withdraw, as well as ERC-4907 rental functions (setUser, userOf, userExpires).
 *      All operations forward calls to the user's proxy (delegated to implementation).
 *      Custom errors for gas efficiency and clarity. No reentrancy needed as calls are forwarded or view-based.
 *      Events emitted for key actions like creation and upgrades.
 *      Access to sensitive functions (init/upgrade) restricted to Diamond owner (initially deployer, later multi-sig/governance).
 *      For ERC721 rentals: Assumes operator approval for setUser (NFT may not be held in vault).
 *      For ERC1155: Assumes tokens are held in vault for operations.
 */
contract VaultFactoryFacet is DiamondAccessControl, IVaipakamErrors {
    /// @dev Restricts to cross-facet calls only (msg.sender == diamond address).
    /// External users calling through the diamond's fallback have msg.sender = their EOA/contract,
    /// while cross-facet calls via address(this).call(...) have msg.sender = address(this).
    error OnlyDiamondInternal();
    /// @dev Extracted modifier body — keeps the modifier a thin wrapper
    ///      so each call site inlines one function call, deduping bytecode.
    function _checkDiamondInternal() private view {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
    }
    modifier onlyDiamondInternal() {
        _checkDiamondInternal();
        _;
    }

    /// @notice #407 PR 4 (T-407-B, 2026-06-12) — raised by the vault
    ///         withdraw guard when the requested withdraw amount
    ///         exceeds the FREE balance (raw vault balance minus the
    ///         active encumbrance sub-ledger for `(user, asset,
    ///         tokenId)`). The encumbrance sub-ledger is fed by
    ///         {LibEncumbrance.createCollateralLien} at loan-init and
    ///         drained on every loan-lifecycle terminal — see
    ///         `docs/DesignsAndPlans/PerLoanCollateralLien.md` §3.4 for
    ///         the full rationale. The error fires when a release wire
    ///         is missing or out of order on any of the loan-lifecycle
    ///         terminal paths.
    /// @dev    The `(user, asset, tokenId)` triple is the
    ///         encumbrance-aggregate key; `requested` and `free` give
    ///         the operator enough to pinpoint which lien is binding
    ///         without an extra view-call.
    error WithdrawWouldUnderflowLien(
        address user,
        address asset,
        uint256 tokenId,
        uint256 requested,
        uint256 free
    );

    /// @dev    Extracted shared body — same shape as
    ///         {_checkDiamondInternal} above. Keeps each call site to
    ///         one function call so the guard cost stays small even
    ///         when inlined three times (ERC20 / ERC721 / ERC1155 with-
    ///         draw paths). Each withdraw site already has the proxy
    ///         address in scope and a known asset shape, so this helper
    ///         takes only the encumbrance-key triple + amount + the
    ///         pre-computed raw balance.
    function _assertWithdrawAllowed(
        address user,
        address asset,
        uint256 tokenId,
        uint256 amount,
        uint256 rawBalance
    ) private view {
        uint256 free = LibEncumbrance.freeBalance(user, asset, tokenId, rawBalance);
        if (amount > free) {
            revert WithdrawWouldUnderflowLien(user, asset, tokenId, amount, free);
        }
    }
    using SafeERC20 for IERC20;

    /// @notice Emitted when a new user vault proxy is created.
    /// @param user The address of the user for whom the vault is created.
    /// @param proxy The address of the newly deployed proxy.
    /// @custom:event-category state-change/vault-mutation
    event UserVaultCreated(address indexed user, address proxy);

    /// @notice Emitted whenever the Vaipakam vault wrapper's rental state
    ///         changes for (lender, nftContract, tokenId). Mirrors ERC-4907's
    ///         UpdateUser intent but is emitted from the Diamond (a single,
    ///         stable address integrators can subscribe to) and always fires —
    ///         including for NFTs that do not natively implement IERC4907.
    ///         For ERC-1155 with concurrent renters, `quantity` is the delta
    ///         applied for `user`, while `activeTotalQuantity` /
    ///         `minActiveExpires` reflect the post-update aggregate across
    ///         all active renters of the same (nftContract, tokenId).
    /// @custom:event-category state-change/vault-mutation
    event VaultRentalUpdated(
        address indexed lender,
        address indexed nftContract,
        uint256 indexed tokenId,
        address user,
        uint64 expires,
        uint256 quantity,
        uint256 activeTotalQuantity,
        uint64 minActiveExpires
    );

    /// @notice Emitted when the shared vault implementation is upgraded.
    /// @param oldImplementation The address of the previous implementation.
    /// @param newImplementation The address of the new implementation.
    /// @param newVersion The bumped `currentVaultVersion` counter after
    ///        the upgrade. Indexers use this to correlate later per-user
    ///        `upgradeUserVault` events with the implementation that
    ///        became current at this moment.
    /// @custom:event-category state-change/vault-mutation
    event VaultImplementationUpgraded(
        address indexed oldImplementation,
        address indexed newImplementation,
        uint256 indexed newVersion
    );

    // Custom errors for better gas efficiency and clarity.
    error AlreadyInitialized();
    error UpgradeFailed();
    error ProxyCallFailed(string reason);
    error NoVault();
    error VaultUpgradeRequired();
    /// @dev Stuck-recovery rejected: caller-supplied amount is zero.
    error AmountZero();
    /// @dev Stuck-recovery rejected: token has protocol-configured risk
    ///      params (collateral / principal / etc.). Recovery of these
    ///      tokens via the off-flow path could pull live collateral or
    ///      claim entitlement; require a governed code change instead.
    error TokenIsProtocolConfigured();
    /// @dev Stuck-recovery rejected: VPFI must exit via the proper
    ///      `withdrawVPFIFromVault` unstake flow that closes the
    ///      time-weighted discount period and the staking checkpoint.
    error CannotRecoverVPFI();
    /// @dev Stuck-recovery rejected: target user has never had an
    ///      vault created (no proxy address recorded).
    error UserHasNoVault();

    /// @notice Emitted when an admin recovers tokens that landed in a
    ///         user's vault outside the protocol deposit flow (e.g. a
    ///         direct ERC-20 `transfer` from the user's wallet, which
    ///         the EVM gives no opportunity to reject).
    /// @param  user    Vault owner whose proxy held the tokens.
    /// @param  token   ERC-20 contract being recovered.
    /// @param  amount  Amount returned to `user` (recipient is locked
    ///                 to the user themselves — admin cannot redirect).
    /// @param  admin   `msg.sender` of the recovery call.
    /// @custom:event-category state-change/vault-mutation
    event StuckERC20Recovered(
        address indexed user,
        address indexed token,
        uint256 amount,
        address indexed admin
    );

    /**
     * @notice Initializes the shared vault implementation by deploying a new VaipakamVaultImplementation.
     * @dev VAULT_ADMIN_ROLE-only. Single-shot: reverts AlreadyInitialized
     *      once `vaipakamVaultTemplate` is set. Deploys a fresh impl,
     *      calls its `initialize(diamond, impl)` and stores both the
     *      template and the diamond self-reference.
     */
    function initializeVaultImplementation() external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.vaipakamVaultTemplate != address(0)) revert AlreadyInitialized();

        VaipakamVaultImplementation impl = new VaipakamVaultImplementation();
        impl.initialize(address(this), address(impl)); // Assume initialize() in impl sets owner to Diamond
        s.vaipakamVaultTemplate = address(impl);
        s.diamondAddress = address(this);
    }

    /**
     * @notice Gets or creates a user's vault proxy.
     * @dev Deploys a new ERC1967Proxy if none exists, pointing to the shared implementation.
     *      View function if exists; mutates if creates.
     *      Emits UserVaultCreated on creation.
     * @param user The user address.
     * @return proxy The user's vault proxy address.
     */
    function getOrCreateUserVault(
        address user
    ) public returns (address proxy) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Tier-1 sanctions gate (Findings 00010 follow-up). Don't
        // create an vault proxy for a sanctioned wallet — even an
        // empty vault shouldn't exist for them. See the policy
        // block on `LibVaipakam.isSanctionedAddress` for the full
        // Tier-1 / Tier-2 split. No-op when the oracle is unset.
        //
        // #594 Codex #659 P1/P2 — skipped ONLY for the EXACT departed (stored)
        // owner whose vault a consolidation move is currently resolving to push
        // their asset OUT to the already-sanctions-checked current holder.
        // Without this, a stored anchor flagged AFTER the position transferred
        // would brick the Tier-2 close-out here. The stored party is losing
        // custody, not receiving, so the receive-side gate does not apply; their
        // vault already exists so no proxy is created for a flagged wallet.
        //
        // Round-3: matched on the exact address (not a blanket flag) so a token
        // transfer that reenters mid-move cannot resolve a DIFFERENT flagged
        // wallet's vault through this exemption. `address(0)` exempts no one.
        // See the `consolidationMoveFromUser` natspec.
        address exemptUser = s.consolidationMoveFromUser;
        if (!(exemptUser != address(0) && user == exemptUser)) {
            LibVaipakam._assertNotSanctioned(user);
        }
        proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) {
            bytes memory _data = abi.encodeCall(
                VaipakamVaultImplementation.initialize, // Function signature
                (s.diamondAddress, s.vaipakamVaultTemplate) // Arguments
            );
            ERC1967Proxy newProxy = new ERC1967Proxy(
                s.vaipakamVaultTemplate,
                _data
            );
            proxy = address(newProxy);
            s.userVaipakamVaults[user] = proxy;
            s.vaultVersion[user] = s.currentVaultVersion;
            emit UserVaultCreated(user, proxy);
        } else {
            // Block interactions with outdated vaults when a mandatory upgrade is active
            if (
                s.mandatoryVaultVersion > 0 &&
                s.vaultVersion[user] < s.mandatoryVaultVersion
            ) {
                revert VaultUpgradeRequired();
            }
        }
    }

    /**
     * @notice Marks a mandatory minimum vault version.
     * @dev VAULT_ADMIN_ROLE-only. When set, any user whose vault version is
     *      below this value is blocked from all diamond-driven vault
     *      interactions (see getOrCreateUserVault) until they call
     *      {upgradeUserVault}. Set to 0 to clear the requirement.
     * @param version The minimum required vault version (use currentVaultVersion).
     */
    function setMandatoryVaultUpgrade(uint256 version) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.mandatoryVaultVersion = version;
    }

    /**
     * @notice Upgrades a user's vault proxy to the latest implementation.
     * @dev Calls UUPS upgradeToAndCall on the user's proxy to point it to the
     *      current vaipakamVaultTemplate. Updates the user's version stamp.
     *      Callable by anyone (typically the user themselves via frontend).
     * @param user The user whose vault to upgrade.
     */
    function upgradeUserVault(address user) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) revert NoVault();

        // Call UUPS upgradeToAndCall on the proxy
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                UUPSUpgradeable.upgradeToAndCall.selector,
                s.vaipakamVaultTemplate,
                "" // No initialization data needed for upgrade
            )
        );
        if (!success) revert UpgradeFailed();
        s.vaultVersion[user] = s.currentVaultVersion;
    }

    /**
     * @notice Upgrades the shared vault implementation used by all per-user
     *         proxies going forward.
     * @dev VAULT_ADMIN_ROLE-only. Rejects non-contract addresses
     *      (`code.length == 0`) but does not verify storage-layout
     *      compatibility — that is the caller's responsibility. Bumps
     *      `currentVaultVersion`; existing user proxies keep pointing at
     *      the old impl until each user calls {upgradeUserVault}, unless
     *      {setMandatoryVaultUpgrade} forces the upgrade.
     *      Emits VaultImplementationUpgraded.
     * @param newImplementation The new implementation address (must be a contract).
     */
    function upgradeVaultImplementation(address newImplementation) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        if (newImplementation.code.length == 0) revert UpgradeFailed();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oldImpl = s.vaipakamVaultTemplate;
        s.vaipakamVaultTemplate = newImplementation;
        unchecked {
            ++s.currentVaultVersion;
        }

        emit VaultImplementationUpgraded(
            oldImpl,
            newImplementation,
            s.currentVaultVersion
        );
    }

    /**
     * @notice The single chokepoint for protocol-side ERC-20 deposits
     *         into a user's vault. Pulls `amount` directly from the
     *         user's wallet (using the Diamond's existing allowance)
     *         to the vault proxy, AND increments
     *         `protocolTrackedVaultBalance[user][token]` so the
     *         counter stays correct.
     *
     * @dev    onlyDiamondInternal — every protocol facet that previously
     *         did `IERC20(t).safeTransferFrom(user, vault, amount)`
     *         directly is migrated to call this instead. That keeps
     *         the counter the load-bearing safety boundary for the
     *         stuck-token recovery flow (T-054) and makes the Asset
     *         Viewer's `min(balanceOf, tracked)` display correct.
     *
     *         Auto-creates the user's vault proxy if missing. Pulls
     *         from `user` (NOT msg.sender — msg.sender is the
     *         Diamond on the cross-facet call) so the user's
     *         wallet-side approval to the Diamond is what authorises
     *         the transfer. This preserves the existing approval
     *         pattern for callers — a user that approved the
     *         Diamond once can be the funding source for any number
     *         of vault-deposit operations.
     *
     *         For Permit2-mediated transfers (where the funds movement
     *         happens via the signed permit, not via this allowance
     *         path), use {recordVaultDepositERC20} instead — it does
     *         the counter increment without re-issuing the transfer.
     *
     * @param user The user whose vault to credit (also the source
     *             of funds — the Diamond's allowance from this user
     *             is consumed).
     * @param token The ERC-20 token address.
     * @param amount The amount to deposit.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultDepositERC20(
        address user,
        address token,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        // Direct user → vault transfer using the Diamond's existing
        // allowance from `user`. Token contract sees msg.sender =
        // Diamond (this facet runs in Diamond's context), checks
        // allowance[user][Diamond] >= amount, and moves amount from
        // user to proxy.
        // Slither flags `transferFrom` with non-msg.sender `from` as
        // "arbitrary-send-erc20", but `user` here is gated by the
        // Diamond's allowance: the user must have called
        // `IERC20.approve(diamond, ≥amount)` first, so they consented
        // to the move. The vault proxy receiving the funds is the
        // user's own vault (one-per-user, deterministic). Not a vuln.
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(token).safeTransferFrom(user, proxy, amount);
        LibVaipakam.recordVaultDeposit(user, token, amount);
    }

    /**
     * @notice Cross-payer variant of {vaultDepositERC20}. Pulls
     *         `amount` of `token` from `payer`'s wallet (using the
     *         Diamond's allowance from `payer`) and credits it to
     *         `user`'s vault — so the source of funds and the
     *         owner of the vault can differ. The
     *         protocolTrackedVaultBalance counter ticks up under
     *         `user`, matching where the funds land.
     *
     * @dev    Used by repay / preclose / refinance flows where the
     *         borrower pays the lender — borrower is the payer,
     *         lender owns the vault that receives. For the more
     *         common offer-creation / staking flows where the same
     *         party is both, prefer the simpler {vaultDepositERC20}.
     *
     *         onlyDiamondInternal.
     *
     * @param payer  Address whose allowance to the Diamond is consumed.
     * @param user   User whose vault is credited (counter increments
     *               under this address).
     * @param token  ERC-20 token address.
     * @param amount Amount to deposit.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultDepositERC20From(
        address payer,
        address user,
        address token,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        // Same shape as `vaultDepositERC20` — see the rationale block
        // there. `payer` consented via `IERC20.approve(diamond,≥amount)`;
        // the proxy receiving the funds is `user`'s own vault.
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(token).safeTransferFrom(payer, proxy, amount);
        LibVaipakam.recordVaultDeposit(user, token, amount);
    }

    /**
     * @notice Counter-only sibling of {vaultDepositERC20} — records
     *         that `amount` of `token` has just been credited to
     *         `user`'s vault, without re-issuing the transfer.
     *
     * @dev    Use immediately after a Permit2-mediated pull (or any
     *         other transfer mechanism that already routes funds to
     *         the user's vault). The caller is responsible for
     *         having actually moved the tokens; this function
     *         updates the counter only. Never invoke without a
     *         matching, just-completed transfer to the user's vault
     *         — doing so silently inflates the counter and corrupts
     *         the recovery cap.
     *
     *         onlyDiamondInternal — gated to cross-facet callers so
     *         no external party can write to the counter directly.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function recordVaultDepositERC20(
        address user,
        address token,
        uint256 amount
    ) external onlyDiamondInternal {
        LibVaipakam.recordVaultDeposit(user, token, amount);
    }

    /**
     * @notice Withdraws ERC-20 tokens from the specified user's vault to a recipient.
     * @dev onlyDiamondInternal — cross-facet only. Forwards to
     *      {VaipakamVaultImplementation.withdrawERC20}. Reverts
     *      ProxyCallFailed("Withdraw ERC20 failed") on proxy revert.
     *      Decrements `protocolTrackedVaultBalance[user][token]` so
     *      the counter remains the symmetric mirror of all
     *      protocol-side movements. Underflow reverts loudly if a
     *      withdraw fires for more than was tracked — that's an
     *      accounting bug somewhere upstream.
     * @param user The user whose vault to withdraw from.
     * @param token The ERC-20 token address.
     * @param recipient The recipient address.
     * @param amount The amount to withdraw.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultWithdrawERC20(
        address user,
        address token,
        address recipient,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        // #407 PR 4 (T-407-B, 2026-06-12) — encumbrance guard. Block
        // any withdraw whose amount would dip into the active lien
        // aggregate for `(user, token, tokenId=0)`. Loan-lifecycle
        // terminals release their lien BEFORE calling the withdraw
        // selector (see RepayFacet / PrecloseFacet / RefinanceFacet /
        // DefaultedFacet release wires), so legitimate post-close flows
        // pass cleanly. A drifted release-wire path fails loud here.
        //
        // #569 Codex #572 round-2 P2 — cap the raw vault balance by the
        // protocol-tracked balance before the lien subtraction.
        // `balanceOf` includes UNSOLICITED dust (direct ERC-20 transfers
        // the EVM can't reject); counting it as free would let a fully-
        // encumbered user withdraw a dust-sized amount, and the post-
        // withdraw `recordVaultWithdraw` decrement would then drive
        // `protocolTrackedVaultBalance` BELOW the still-active lien —
        // stranding/underflowing the eventual collateral return. The
        // tracked counter excludes dust, so capping by it keeps free
        // balance honest.
        uint256 trackedBalance =
            LibVaipakam.storageSlot().protocolTrackedVaultBalance[user][token];
        uint256 rawForGuard = IERC20(token).balanceOf(proxy);
        if (trackedBalance < rawForGuard) {
            rawForGuard = trackedBalance;
        }
        _assertWithdrawAllowed(
            user,
            token,
            /*tokenId=*/0,
            amount,
            rawForGuard
        );
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.withdrawERC20.selector,
                token,
                recipient,
                amount
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC20 failed");
        LibVaipakam.recordVaultWithdraw(user, token, amount);
    }

    /**
     * @notice Returns the per-(user, token) protocol-tracked vault
     *         balance — i.e. the running sum of every
     *         `vaultDepositERC20` / `recordVaultDepositERC20`
     *         minus every `vaultWithdrawERC20` for that pair.
     *
     * @dev    Pure view; safe to call externally. Asset Viewer
     *         displays `min(balanceOf(vault, token), this)` so
     *         unsolicited dust pushed in directly via
     *         `IERC20.transfer` is hidden from the UI. The future
     *         stuck-token recovery flow (T-054) caps recovery at
     *         `max(0, balanceOf - this)`.
     */
    function getProtocolTrackedVaultBalance(
        address user,
        address token
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().protocolTrackedVaultBalance[user][token];
    }

    // ─── Stuck-token recovery (T-054 PR-3) ───────────────────────────────────
    //
    // The receiver-hook hardening shipped 2026-05-03 blocks direct
    // user-initiated NFT transfers into a per-user vault. ERC-20 has
    // no equivalent receiver-side hook (the EVM gives the recipient
    // zero opportunity to reject), so unsolicited ERC-20 transfers
    // CAN land in an vault proxy. This recovery flow gives the
    // legitimate self-deposit case ("I sent USDC to my vault address
    // by accident from my own wallet / a CEX") a clean exit, while
    // structurally preventing the recovery path from touching
    // protocol-managed collateral / claims.
    //
    // The cap is the load-bearing safety property:
    //
    //     unsolicited = max(0, balanceOf(vault, token)
    //                       - protocolTrackedVaultBalance[user][token])
    //     require(amount <= unsolicited)
    //
    // Counter math forbids draining beyond the truly-unsolicited
    // delta no matter what other check is bypassed. The recipient is
    // hardcoded to `msg.sender` (the vault owner) so admin / malware
    // / coordination attacks cannot redirect funds.
    //
    // Sanctioned-source declarations trigger an vault ban under the
    // protocol's existing sanctions semantics: every Tier-1 entry
    // point starts reverting `SanctionedAddress` for the user's EOA.
    // The ban tracks the SOURCE wallet's current oracle status — if
    // the address is later de-listed, the ban auto-unlocks. See
    // `LibVaipakam.isSanctionedAddress` for the source-tracked
    // delegation logic.
    //
    // EIP-712 acknowledgment + nonce + deadline are replay-protected
    // and provide a portable cryptographic record of explicit
    // consent. Combined with a frontend `type CONFIRM` modal (PR-4),
    // this is defense-in-depth for an action that could lock the
    // user's vault on a wrong declaration.
    //
    // Full design: docs/DesignsAndPlans/VaultStuckRecoveryDesign.md.

    /// @dev EIP-712 domain typehash. Domain name = "Vaipakam Recovery"
    ///      (separate from any other domain the diamond uses, e.g. Permit2,
    ///      so signatures can't be cross-domain replayed).
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant EIP712_DOMAIN_NAME_HASH = keccak256("Vaipakam Recovery");
    bytes32 private constant EIP712_DOMAIN_VERSION_HASH = keccak256("1");

    /// @dev Typehash for the recovery acknowledgment payload. The
    ///      `ackTextHash` field anchors the signed payload to the
    ///      exact warning text the user agreed to — a future change
    ///      to the wording bumps the constant and breaks the old
    ///      hash so historical signatures can't be used against new
    ///      warning text.
    bytes32 private constant RECOVERY_TYPEHASH =
        keccak256(
            "RecoveryAcknowledgment(address user,address token,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
        );

    /// @dev keccak256 of the canonical recovery warning text shown to
    ///      the user in the wallet popup + confirmation modal. Constant
    ///      so the contract can verify the user signed against the
    ///      EXACT text we display, not a manipulated variant.
    bytes32 internal constant RECOVERY_ACK_TEXT_HASH =
        keccak256(
            bytes(
                "I am declaring that the source address belongs to a wallet I"
                " control or authorized. If the source is later determined to"
                " be on the sanctions list, my vault will be locked under the"
                " protocol's sanctions policy until the address is de-listed."
                " I have read and understood the Advanced User Guide section"
                " on stuck-token recovery."
            )
        );

    /// @notice Emitted when stuck ERC-20 tokens are recovered to the
    ///         user's EOA. Indexed for full audit trail post-deploy.
    /// @param  user            Vault owner whose vault was tapped.
    /// @param  token           ERC-20 contract being recovered.
    /// @param  declaredSource  Address the user attested as the
    ///                         transfer's origin.
    /// @param  amount          Amount returned to `user` (recipient
    ///                         is locked to the user themselves —
    ///                         no parameter accepted).
    /// @param  nonce           Recovery nonce consumed by this call.
    /// @custom:event-category state-change/vault-mutation
    event StuckERC20Recovered(
        address indexed user,
        address indexed token,
        address indexed declaredSource,
        uint256 amount,
        uint256 nonce
    );

    /// @notice Emitted when a recovery declaration named a sanctions-
    ///         flagged source — the user's vault is now locked under
    ///         the existing sanctions policy until the source address
    ///         is de-listed from the oracle. The corresponding
    ///         `recoverStuckERC20` call reverts immediately after
    ///         emitting; tokens stay in the vault.
    /// @custom:event-category informational/admin
    event VaultBannedFromRecoveryAttempt(
        address indexed user,
        address indexed token,
        address indexed declaredSource,
        uint256 amount
    );

    /// @notice Emitted by {disown} when the user formally asserts
    ///         that some unsolicited token balance is not theirs.
    ///         Event-only — changes no on-chain state. Provides a
    ///         compliance audit trail useful for individual user
    ///         disputes with CEXs / regulators ("here's the on-chain
    ///         record of my disowning the suspicious deposit").
    /// @custom:event-category state-change/vault-mutation
    event TokenDisowned(
        address indexed user,
        address indexed token,
        uint256 observedAmount,
        uint256 blockNumber
    );

    /**
     * @notice Recover ERC-20 tokens that landed in your vault via a
     *         direct `IERC20.transfer` (outside the protocol's
     *         deposit flow). Funds are returned to YOU (the vault
     *         owner) — recipient is hardcoded, no parameter accepted.
     *
     * @dev Cap math is the load-bearing safety property:
     *
     *          unsolicited = max(0, balanceOf - tracked)
     *          require(amount <= unsolicited)
     *
     *      No matter what other check is bypassed, the arithmetic
     *      forbids draining beyond the truly-unsolicited delta.
     *
     *      DECLARING A SANCTIONED SOURCE LOCKS YOUR VAULT. The user
     *      attests via signature that the declared source is theirs.
     *      If the sanctions oracle flags it, the protocol applies the
     *      same Tier-1 / Tier-2 semantics as any other sanctioned
     *      address — Tier-1 entry points (createOffer, acceptOffer,
     *      VPFI deposit, this function, etc.) revert; Tier-2
     *      close-outs (repay, mark default) stay open so the
     *      unflagged counterparty can be made whole. Auto-unlocks
     *      when the source is de-listed.
     *
     *      EIP-712 acknowledgment binds the call to the user's
     *      explicit consent. Nonce + deadline are replay-protected.
     *
     *      Discoverability gating is enforced at the frontend — this
     *      page is reachable ONLY via a deep link from the Advanced
     *      User Guide (`noindex,nofollow`), so naive users dust-
     *      poisoned by a third party can't accidentally trip the
     *      sanctions-source ban.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function recoverStuckERC20(
        address token,
        address declaredSource,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // 1. Sanctions check on caller. If the user is already
        //    flagged (oracle or recovery-induced ban), Tier-1
        //    semantics block recovery entirely.
        LibVaipakam._assertNotSanctioned(msg.sender);

        // 2. Validate basic args.
        if (amount == 0) revert RecoveryAmountZero();
        if (block.timestamp > deadline) revert RecoveryDeadlineExpired();

        // 3. Validate the EIP-712 signature recovers to msg.sender.
        //    `nonce` is captured pre-mutation; the increment AFTER
        //    successful verification is the replay-protection gate.
        uint256 nonce = s.recoveryNonce[msg.sender];
        bytes32 digest = _recoveryDigest(
            msg.sender,
            token,
            declaredSource,
            amount,
            nonce,
            deadline
        );
        address signer = ECDSA.recover(digest, signature);
        if (signer != msg.sender) revert RecoverySignatureInvalid();

        // 4. Resolve user's vault proxy.
        address proxy = s.userVaipakamVaults[msg.sender];
        if (proxy == address(0)) revert RecoveryUserHasNoVault();

        // 5. Cap = max(0, balanceOf - tracked). Recovery cannot drain
        //    protocol-managed balance under any circumstance.
        uint256 actualBal = IERC20(token).balanceOf(proxy);
        uint256 trackedBal = s.protocolTrackedVaultBalance[msg.sender][token];
        uint256 unsolicited = actualBal > trackedBal
            ? actualBal - trackedBal
            : 0;
        if (amount > unsolicited) revert RecoveryAmountExceedsUnsolicited();

        // 6. Sanctions oracle check on declaredSource. Failure modes:
        //      - Oracle unset: refuse (fail-safe).
        //      - Oracle reverts: refuse (fail-safe).
        //      - Source flagged: ban vault + revert.
        //      - Source clean: proceed.
        address oracle = s.sanctionsOracle;
        if (oracle == address(0)) revert SanctionsOracleUnavailable();
        bool sourceFlagged;
        try ISanctionsList(oracle).isSanctioned(declaredSource) returns (bool flagged) {
            sourceFlagged = flagged;
        } catch {
            revert SanctionsOracleUnavailable();
        }
        if (sourceFlagged) {
            // Record source-tracked ban; auto-unlocks if oracle later
            // de-lists. Bump nonce so the same signature can't be
            // replayed once the ban lifts. Tokens DO NOT MOVE — they
            // stay in vault under the sanctions-policy lock.
            //
            // Crucially, this branch RETURNS rather than reverting.
            // A revert would roll back the ban-state writes, so the
            // ban would never persist. The transaction succeeds at
            // the EVM level — frontend reads the
            // `VaultBannedFromRecoveryAttempt` event to surface the
            // banned-as-outcome to the user.
            s.vaultBannedSource[msg.sender] = declaredSource;
            unchecked {
                s.recoveryNonce[msg.sender] = nonce + 1;
            }
            emit VaultBannedFromRecoveryAttempt(
                msg.sender,
                token,
                declaredSource,
                amount
            );
            return;
        }

        // 7. Bump nonce BEFORE the external transfer. Standard
        //    checks-effects-interactions ordering — even though the
        //    proxy's `withdrawERC20` is trusted, we don't want the
        //    nonce-bump to be reorderable across re-entry.
        unchecked {
            s.recoveryNonce[msg.sender] = nonce + 1;
        }

        // 8. Transfer to user's EOA via the proxy. Recipient is
        //    hardcoded to msg.sender — no caller-supplied recipient.
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.withdrawERC20.selector,
                token,
                msg.sender,
                amount
            )
        );
        if (!success) revert ProxyCallFailed("Recovery withdraw failed");

        emit StuckERC20Recovered(msg.sender, token, declaredSource, amount, nonce);
    }

    /**
     * @notice Formally disown unsolicited tokens sitting in your
     *         vault without recovering them. Event-only — no state
     *         change. Useful as a public on-chain assertion in
     *         compliance disputes ("the dust isn't mine and I never
     *         touched it").
     *
     * @dev    No funds move; the dust stays locked in the vault as
     *         before. Any future recovery for this token is
     *         unaffected.
     *
     *         Sanctions-gated: a banned vault can still call
     *         `disown` because it's purely informational. Tier-2 in
     *         the parlance of LibVaipakam's sanctions policy.
     *
     * @param token The ERC-20 token being disowned.
     */
    function disown(address token) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamVaults[msg.sender];
        if (proxy == address(0)) revert RecoveryUserHasNoVault();
        uint256 actualBal = IERC20(token).balanceOf(proxy);
        uint256 trackedBal = s.protocolTrackedVaultBalance[msg.sender][token];
        uint256 observed = actualBal > trackedBal ? actualBal - trackedBal : 0;
        emit TokenDisowned(msg.sender, token, observed, block.number);
    }

    /// @notice View — returns the EIP-712 domain separator for the
    ///         recovery flow. Frontend reads this to construct the
    ///         exact digest the wallet will sign over.
    function recoveryDomainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    /// @notice View — returns the keccak256 of the canonical warning
    ///         text. Frontend MUST use the same text (verified by hash)
    ///         when constructing the EIP-712 payload, or the
    ///         signature won't recover correctly.
    function recoveryAckTextHash() external pure returns (bytes32) {
        return RECOVERY_ACK_TEXT_HASH;
    }

    /// @notice View — current recovery nonce for `user`. Frontend
    ///         reads this to fill in the EIP-712 payload's `nonce`
    ///         field.
    function recoveryNonce(address user) external view returns (uint256) {
        return LibVaipakam.storageSlot().recoveryNonce[user];
    }

    /// @notice View — the sanctioned source address that locked
    ///         `user`'s vault under recovery (zero ⇒ no recovery-
    ///         induced ban). The ban auto-unlocks when this source
    ///         is de-listed from the oracle, even though the storage
    ///         field stays populated.
    function vaultBannedSource(address user) external view returns (address) {
        return LibVaipakam.storageSlot().vaultBannedSource[user];
    }

    /// @dev Compute the EIP-712 domain separator. View (depends on
    ///      block.chainid which can change in a hard fork; we
    ///      recompute on every call rather than caching).
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    EIP712_DOMAIN_NAME_HASH,
                    EIP712_DOMAIN_VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
    }

    /// @dev Compute the digest the user signs over for a recovery
    ///      acknowledgment. Layout matches EIP-712 §7.
    function _recoveryDigest(
        address user,
        address token,
        address declaredSource,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECOVERY_TYPEHASH,
                user,
                token,
                declaredSource,
                amount,
                nonce,
                deadline,
                RECOVERY_ACK_TEXT_HASH
            )
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
            );
    }

    /**
     * @notice Deposits an ERC-721 NFT into the specified user's vault.
     * @dev Low-level call to the proxy's depositERC721 function (safeTransferFrom).
     *      Reverts on failure.
     * @param user The user whose vault to deposit into.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultDepositERC721(
        address user,
        address nftContract,
        uint256 tokenId
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.depositERC721.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) revert ProxyCallFailed("Deposit ERC721 failed");
    }

    /**
     * @notice Withdraws an ERC-721 NFT from the specified user's vault to a recipient.
     * @dev Low-level call to the proxy's withdrawERC721 function.
     *      Reverts on failure.
     * @param user The user whose vault to withdraw from.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param recipient The recipient address.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultWithdrawERC721(
        address user,
        address nftContract,
        uint256 tokenId,
        address recipient
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        // #407 PR 4 — encumbrance guard. For ERC721 the lien semantic
        // is "this specific tokenId is locked" — any encumbrance > 0
        // means a loan-lifecycle terminal hasn't released yet. We read
        // the aggregate directly rather than calling
        // `ownerOf(tokenId)` (which would revert on a non-existent
        // tokenId and mask the legitimate `ProxyCallFailed` revert
        // path the underlying proxy provides for the not-owned case).
        if (LibVaipakam.storageSlot().encumbered[user][nftContract][tokenId] > 0) {
            revert WithdrawWouldUnderflowLien(user, nftContract, tokenId, 1, 0);
        }
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.withdrawERC721.selector,
                nftContract,
                tokenId,
                recipient
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC721 failed");
    }

    /**
     * @notice Deposits ERC-1155 tokens into the specified user's vault.
     * @dev Low-level call to the proxy's depositERC1155 function.
     *      Reverts on failure.
     * @param user The user whose vault to deposit into.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param amount The amount to deposit.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultDepositERC1155(
        address user,
        address nftContract,
        uint256 tokenId,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.depositERC1155.selector,
                nftContract,
                tokenId,
                amount
            )
        );
        if (!success) revert ProxyCallFailed("Deposit ERC1155 failed");
    }

    /**
     * @notice Withdraws ERC-1155 tokens from the specified user's vault to a recipient.
     * @dev Low-level call to the proxy's withdrawERC1155 function.
     *      Reverts on failure.
     * @param user The user whose vault to withdraw from.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param amount The amount to withdraw.
     * @param recipient The recipient address.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultWithdrawERC1155(
        address user,
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        // #407 PR 4 — encumbrance guard, keyed on the specific tokenId.
        _assertWithdrawAllowed(
            user,
            nftContract,
            tokenId,
            amount,
            IERC1155(nftContract).balanceOf(proxy, tokenId)
        );
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.withdrawERC1155.selector,
                nftContract,
                tokenId,
                amount,
                recipient
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC1155 failed");
    }

    /**
     * @notice Approves the user's vault as operator for an ERC-721 NFT (for rentals without holding).
     * @dev Low-level call to the proxy's approveERC721 function (IERC721.approve).
     *      Reverts on failure.
     * @param user The user whose vault to approve from.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultApproveNFT721(
        address user,
        address nftContract,
        uint256 tokenId
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.approveERC721.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) revert ProxyCallFailed("Approve ERC721 failed");
    }

    /**
     * @notice Sets the temporary user (renter) for a rentable NFT from the specified user's vault.
     * @dev Low-level call to the proxy's setUser function (IERC4907.setUser).
     *      Enhanced: Explicit proxy existence check. Reverts with reason on failure.
     *      For ERC721: Calls as operator (NFT not held in vault).
     *      For ERC1155: Calls while holding tokens in vault. Underlying
     *      IERC4907 support is optional — the vault maintains its own
     *      wrapper state so third-party integrations can query the vault
     *      uniformly even when the NFT does not implement ERC-4907.
     *      Callable by facets (e.g., for loan acceptance in OfferFacet).
     * @param user The user whose vault to operate from (typically the lender).
     * @param nftContract The NFT contract address (must support IERC4907).
     * @param tokenId The token ID.
     * @param renter The temporary renter address (borrower).
     * @param expires The expiration timestamp (end of loan term).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultSetNFTUser(
        address user,
        address nftContract,
        uint256 tokenId,
        address renter,
        uint64 expires
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) revert NoVault();

        (bool success, bytes memory returnData) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.setUser.selector,
                nftContract,
                tokenId,
                renter,
                expires
            )
        );
        if (!success) {
            // Decode revert reason if available
            if (returnData.length > 0) {
                assembly {
                    let returndata_size := mload(returnData)
                    revert(add(32, returnData), returndata_size)
                }
            } else {
                revert ProxyCallFailed("Set NFT user failed");
            }
        }
        (uint256 aggQty, uint64 minExp) = _readAggregate(proxy, nftContract, tokenId);
        emit VaultRentalUpdated(
            user,
            nftContract,
            tokenId,
            renter,
            expires,
            renter == address(0) ? 0 : 1,
            aggQty,
            minExp
        );
    }

    /**
     * @notice Returns the stored amount for `offerId` from LibVaipakam storage.
     * @dev Convenience accessor used by vault-side integrations that prefer
     *      not to import LibVaipakam directly. For the full offer record
     *      use {OfferFacet.getOffer}.
     * @param offerId The offer ID.
     * @return amount The offer amount (0 if the offer does not exist).
     */
    function getOfferAmount(
        uint256 offerId
    ) external view returns (uint256 amount) {
        // Issue #169 follow-up — direct field SLOAD via storage pointer.
        // The previous shape (`LibVaipakam.Offer memory offer = ...;
        // return offer.amount;`) copied the FULL Offer struct into
        // memory just to return one field; on a non-existent offer that
        // was a cold SLOAD per struct slot. After #164 added slots 18
        // (`collateralAmountMax`) + 19 (`collateralAmountFilled`), that
        // showed up as the +8.3% gas regression on
        // `testGetOfferAmountReturnsZeroForNonExistent`. Collapsing to a
        // single SLOAD of the field actually read recovers that and
        // trims gas off the happy path too.
        return LibVaipakam.storageSlot().offers[offerId].amount;
    }

    /**
     * @notice Returns the Diamond's own address as recorded in LibVaipakam
     *         storage at {initializeVaultImplementation} time.
     * @dev Used by vault proxies to verify their authorized caller.
     * @return diamondAddress The Diamond proxy address.
     */
    function getDiamondAddress()
        external
        view
        returns (address diamondAddress)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.diamondAddress;
    }

    /**
     * @notice Returns the existing vault proxy for `user`, or the zero
     *         address if one has not been deployed yet.
     * @dev Pure read — unlike {getOrCreateUserVault} this never deploys,
     *      so it is safe for off-chain callers resolving "does this address
     *      belong to user X's vault?" (e.g. the frontend treating an
     *      NFT-in-vault holder as the vault's user during strategic flows).
     * @param user The user address to resolve.
     * @return proxy The user's vault proxy, or zero if not yet created.
     */
    function getUserVaultAddress(address user) external view returns (address proxy) {
        return LibVaipakam.storageSlot().userVaipakamVaults[user];
    }

    /**
     * @notice Returns the current shared `VaipakamVaultImplementation`
     *         template address that new per-user proxies are pointed at.
     * @dev Updated by {upgradeVaultImplementation}. Existing user proxies
     *      keep their previous pointer until {upgradeUserVault}.
     * @return vaipakamVaultTemplate The current vault implementation address.
     */
    function getVaipakamVaultImplementationAddress()
        external
        view
        returns (address vaipakamVaultTemplate)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.vaipakamVaultTemplate;
    }

    /**
     * @notice Vault version info a frontend needs to surface the mandatory
     *         upgrade flow (README §"Vault Upgrades"). Without this, clients
     *         would have to probe `getOrCreateUserVault` and parse the
     *         `VaultUpgradeRequired()` revert to detect blocked accounts.
     * @param user The user address to check.
     * @return userVersion The user's current vault version (0 if no vault).
     * @return currentVersion The latest shared implementation version.
     * @return mandatoryVersion The minimum required version (0 = no mandate).
     * @return upgradeRequired True iff the user has an vault and it is below
     *         the mandatory floor — UI should force an upgrade before any
     *         further diamond-driven vault interaction.
     */
    function getVaultVersionInfo(address user)
        external
        view
        returns (
            uint256 userVersion,
            uint256 currentVersion,
            uint256 mandatoryVersion,
            bool upgradeRequired
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        userVersion = s.vaultVersion[user];
        currentVersion = s.currentVaultVersion;
        mandatoryVersion = s.mandatoryVaultVersion;
        upgradeRequired =
            s.userVaipakamVaults[user] != address(0) &&
            mandatoryVersion > 0 &&
            userVersion < mandatoryVersion;
    }

    /**
     * @notice Gets the current user of a rentable NFT from the specified user's vault.
     * @dev Low-level staticcall to the proxy's userOf function.
     *      Returns zero address on failure.
     *      View function; callable by anyone.
     * @param user The user whose vault to query.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @return The current renter address (zero if none or failure).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultGetNFTUserOf(
        address user,
        address nftContract,
        uint256 tokenId
    ) external view returns (address) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) return address(0);

        (bool success, bytes memory result) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.userOf.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) return address(0);
        return abi.decode(result, (address));
    }

    /**
     * @notice Gets the expiration timestamp for a rentable NFT's user from the specified user's vault.
     * @dev Low-level staticcall to the proxy's userExpires function.
     *      Returns 0 on failure.
     *      View function; callable by anyone.
     * @param user The user whose vault to query.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @return The expiration timestamp (0 if none or failure).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultGetNFTUserExpires(
        address user,
        address nftContract,
        uint256 tokenId
    ) external view returns (uint64) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) return 0;

        (bool success, bytes memory result) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.userExpires.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) return 0;
        return abi.decode(result, (uint64));
    }

    /**
     * @notice Records an ERC-1155 partial-quantity rental in the lender's
     *         vault alongside any other concurrent active rentals for the
     *         same (nftContract, tokenId). See
     *         {VaipakamVaultImplementation.setUser1155}.
     * @dev onlyDiamondInternal. Reverts NoVault if the lender's proxy
     *      has not been created yet, or bubbles the proxy's revert data
     *      (or ProxyCallFailed("Set NFT user 1155 failed")) on failure.
     *      Emits VaultRentalUpdated with the post-update aggregate.
     * @param user         The lender whose vault holds the 1155 balance.
     * @param nftContract  The ERC-1155 contract.
     * @param tokenId      The token id being rented.
     * @param renter       The borrower receiving rental rights (zero to clear).
     * @param expires      Rental expiry timestamp for this `renter`.
     * @param quantity     Units of `tokenId` to record for `renter`.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultSetNFTUser1155(
        address user,
        address nftContract,
        uint256 tokenId,
        address renter,
        uint64 expires,
        uint256 quantity
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) revert NoVault();

        (bool success, bytes memory returnData) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.setUser1155.selector,
                nftContract,
                tokenId,
                renter,
                expires,
                quantity
            )
        );
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    let returndata_size := mload(returnData)
                    revert(add(32, returnData), returndata_size)
                }
            } else {
                revert ProxyCallFailed("Set NFT user 1155 failed");
            }
        }
        (uint256 aggQty, uint64 minExp) = _readAggregate(proxy, nftContract, tokenId);
        emit VaultRentalUpdated(
            user,
            nftContract,
            tokenId,
            renter,
            expires,
            quantity,
            aggQty,
            minExp
        );
    }

    /// @dev Staticcalls the proxy for post-update aggregate state used in
    ///      VaultRentalUpdated. Returns zeros on any call failure so the
    ///      emit never blocks the mutating path.
    function _readAggregate(
        address proxy,
        address nftContract,
        uint256 tokenId
    ) private view returns (uint256 aggQty, uint64 minExp) {
        (bool okQ, bytes memory qData) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.userQuantity.selector,
                nftContract,
                tokenId
            )
        );
        if (okQ) aggQty = abi.decode(qData, (uint256));
        (bool okE, bytes memory eData) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.userExpires.selector,
                nftContract,
                tokenId
            )
        );
        if (okE) minExp = abi.decode(eData, (uint64));
    }

    /**
     * @notice Gets the rented quantity held in the specified user's vault
     *         for an NFT. For ERC-1155 this is the balance vaulted under
     *         the active rental; for ERC-721 it is 1 while active, else 0.
     * @dev Low-level staticcall to the proxy's userQuantity view. Returns 0
     *      if the vault is absent or the call fails. Enables the README's
     *      ERC-1155 quantity-read promise as a first-class integration
     *      surface.
     * @param user         The vault owner (lender).
     * @param nftContract  The NFT contract.
     * @param tokenId      The token id to query.
     * @return quantity    Rented quantity (0 if no active rental or lookup fails).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultGetNFTQuantity(
        address user,
        address nftContract,
        uint256 tokenId
    ) external view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) return 0;

        (bool success, bytes memory result) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.userQuantity.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) return 0;
        return abi.decode(result, (uint256));
    }
}
