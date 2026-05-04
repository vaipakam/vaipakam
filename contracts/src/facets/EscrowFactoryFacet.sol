// src/facets/EscrowFactoryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {VaipakamEscrowImplementation} from "../VaipakamEscrowImplementation.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title EscrowFactoryFacet
 * @author Vaipakam Developer Team
 * @notice This facet manages the creation, initialization, and upgrade of per-user UUPS escrow proxies in the Vaipakam platform.
 * @dev This contract is part of the Diamond Standard (EIP-2535) and uses shared storage from LibVaipakam.
 *      It deploys ERC1967Proxy instances per user, all pointing to a shared upgradable VaipakamEscrowImplementation.
 *      The Diamond owns the implementation and controls upgrades.
 *      Provides public helpers for ERC20, ERC721, and ERC1155 deposit/withdraw, as well as ERC-4907 rental functions (setUser, userOf, userExpires).
 *      All operations forward calls to the user's proxy (delegated to implementation).
 *      Custom errors for gas efficiency and clarity. No reentrancy needed as calls are forwarded or view-based.
 *      Events emitted for key actions like creation and upgrades.
 *      Access to sensitive functions (init/upgrade) restricted to Diamond owner (initially deployer, later multi-sig/governance).
 *      For ERC721 rentals: Assumes operator approval for setUser (NFT may not be held in escrow).
 *      For ERC1155: Assumes tokens are held in escrow for operations.
 */
contract EscrowFactoryFacet is DiamondAccessControl, IVaipakamErrors {
    /// @dev Restricts to cross-facet calls only (msg.sender == diamond address).
    /// External users calling through the diamond's fallback have msg.sender = their EOA/contract,
    /// while cross-facet calls via address(this).call(...) have msg.sender = address(this).
    error OnlyDiamondInternal();
    modifier onlyDiamondInternal() {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        _;
    }
    using SafeERC20 for IERC20;

    /// @notice Emitted when a new user escrow proxy is created.
    /// @param user The address of the user for whom the escrow is created.
    /// @param proxy The address of the newly deployed proxy.
    event UserEscrowCreated(address indexed user, address proxy);

    /// @notice Emitted whenever the Vaipakam escrow wrapper's rental state
    ///         changes for (lender, nftContract, tokenId). Mirrors ERC-4907's
    ///         UpdateUser intent but is emitted from the Diamond (a single,
    ///         stable address integrators can subscribe to) and always fires —
    ///         including for NFTs that do not natively implement IERC4907.
    ///         For ERC-1155 with concurrent renters, `quantity` is the delta
    ///         applied for `user`, while `activeTotalQuantity` /
    ///         `minActiveExpires` reflect the post-update aggregate across
    ///         all active renters of the same (nftContract, tokenId).
    event EscrowRentalUpdated(
        address indexed lender,
        address indexed nftContract,
        uint256 indexed tokenId,
        address user,
        uint64 expires,
        uint256 quantity,
        uint256 activeTotalQuantity,
        uint64 minActiveExpires
    );

    /// @notice Emitted when the shared escrow implementation is upgraded.
    /// @param oldImplementation The address of the previous implementation.
    /// @param newImplementation The address of the new implementation.
    /// @param newVersion The bumped `currentEscrowVersion` counter after
    ///        the upgrade. Indexers use this to correlate later per-user
    ///        `upgradeUserEscrow` events with the implementation that
    ///        became current at this moment.
    event EscrowImplementationUpgraded(
        address indexed oldImplementation,
        address indexed newImplementation,
        uint256 indexed newVersion
    );

    // Custom errors for better gas efficiency and clarity.
    error AlreadyInitialized();
    error UpgradeFailed();
    error ProxyCallFailed(string reason);
    error NoEscrow();
    error EscrowUpgradeRequired();
    /// @dev Stuck-recovery rejected: caller-supplied amount is zero.
    error AmountZero();
    /// @dev Stuck-recovery rejected: token has protocol-configured risk
    ///      params (collateral / principal / etc.). Recovery of these
    ///      tokens via the off-flow path could pull live collateral or
    ///      claim entitlement; require a governed code change instead.
    error TokenIsProtocolConfigured();
    /// @dev Stuck-recovery rejected: VPFI must exit via the proper
    ///      `withdrawVPFIFromEscrow` unstake flow that closes the
    ///      time-weighted discount period and the staking checkpoint.
    error CannotRecoverVPFI();
    /// @dev Stuck-recovery rejected: target user has never had an
    ///      escrow created (no proxy address recorded).
    error UserHasNoEscrow();

    /// @notice Emitted when an admin recovers tokens that landed in a
    ///         user's escrow outside the protocol deposit flow (e.g. a
    ///         direct ERC-20 `transfer` from the user's wallet, which
    ///         the EVM gives no opportunity to reject).
    /// @param  user    Escrow owner whose proxy held the tokens.
    /// @param  token   ERC-20 contract being recovered.
    /// @param  amount  Amount returned to `user` (recipient is locked
    ///                 to the user themselves — admin cannot redirect).
    /// @param  admin   `msg.sender` of the recovery call.
    event StuckERC20Recovered(
        address indexed user,
        address indexed token,
        uint256 amount,
        address indexed admin
    );

    /**
     * @notice Initializes the shared escrow implementation by deploying a new VaipakamEscrowImplementation.
     * @dev ESCROW_ADMIN_ROLE-only. Single-shot: reverts AlreadyInitialized
     *      once `vaipakamEscrowTemplate` is set. Deploys a fresh impl,
     *      calls its `initialize(diamond, impl)` and stores both the
     *      template and the diamond self-reference.
     */
    function initializeEscrowImplementation() external onlyRole(LibAccessControl.ESCROW_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.vaipakamEscrowTemplate != address(0)) revert AlreadyInitialized();

        VaipakamEscrowImplementation impl = new VaipakamEscrowImplementation();
        impl.initialize(address(this), address(impl)); // Assume initialize() in impl sets owner to Diamond
        s.vaipakamEscrowTemplate = address(impl);
        s.diamondAddress = address(this);
    }

    /**
     * @notice Gets or creates a user's escrow proxy.
     * @dev Deploys a new ERC1967Proxy if none exists, pointing to the shared implementation.
     *      View function if exists; mutates if creates.
     *      Emits UserEscrowCreated on creation.
     * @param user The user address.
     * @return proxy The user's escrow proxy address.
     */
    function getOrCreateUserEscrow(
        address user
    ) public returns (address proxy) {
        // Tier-1 sanctions gate (Findings 00010 follow-up). Don't
        // create an escrow proxy for a sanctioned wallet — even an
        // empty escrow shouldn't exist for them. See the policy
        // block on `LibVaipakam.isSanctionedAddress` for the full
        // Tier-1 / Tier-2 split. No-op when the oracle is unset.
        LibVaipakam._assertNotSanctioned(user);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        proxy = s.userVaipakamEscrows[user];
        if (proxy == address(0)) {
            bytes memory _data = abi.encodeCall(
                VaipakamEscrowImplementation.initialize, // Function signature
                (s.diamondAddress, s.vaipakamEscrowTemplate) // Arguments
            );
            ERC1967Proxy newProxy = new ERC1967Proxy(
                s.vaipakamEscrowTemplate,
                _data
            );
            proxy = address(newProxy);
            s.userVaipakamEscrows[user] = proxy;
            s.escrowVersion[user] = s.currentEscrowVersion;
            emit UserEscrowCreated(user, proxy);
        } else {
            // Block interactions with outdated escrows when a mandatory upgrade is active
            if (
                s.mandatoryEscrowVersion > 0 &&
                s.escrowVersion[user] < s.mandatoryEscrowVersion
            ) {
                revert EscrowUpgradeRequired();
            }
        }
    }

    /**
     * @notice Marks a mandatory minimum escrow version.
     * @dev ESCROW_ADMIN_ROLE-only. When set, any user whose escrow version is
     *      below this value is blocked from all diamond-driven escrow
     *      interactions (see getOrCreateUserEscrow) until they call
     *      {upgradeUserEscrow}. Set to 0 to clear the requirement.
     * @param version The minimum required escrow version (use currentEscrowVersion).
     */
    function setMandatoryEscrowUpgrade(uint256 version) external onlyRole(LibAccessControl.ESCROW_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.mandatoryEscrowVersion = version;
    }

    /**
     * @notice Upgrades a user's escrow proxy to the latest implementation.
     * @dev Calls UUPS upgradeToAndCall on the user's proxy to point it to the
     *      current vaipakamEscrowTemplate. Updates the user's version stamp.
     *      Callable by anyone (typically the user themselves via frontend).
     * @param user The user whose escrow to upgrade.
     */
    function upgradeUserEscrow(address user) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamEscrows[user];
        if (proxy == address(0)) revert NoEscrow();

        // Call UUPS upgradeToAndCall on the proxy
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                UUPSUpgradeable.upgradeToAndCall.selector,
                s.vaipakamEscrowTemplate,
                "" // No initialization data needed for upgrade
            )
        );
        if (!success) revert UpgradeFailed();
        s.escrowVersion[user] = s.currentEscrowVersion;
    }

    /**
     * @notice Upgrades the shared escrow implementation used by all per-user
     *         proxies going forward.
     * @dev ESCROW_ADMIN_ROLE-only. Rejects non-contract addresses
     *      (`code.length == 0`) but does not verify storage-layout
     *      compatibility — that is the caller's responsibility. Bumps
     *      `currentEscrowVersion`; existing user proxies keep pointing at
     *      the old impl until each user calls {upgradeUserEscrow}, unless
     *      {setMandatoryEscrowUpgrade} forces the upgrade.
     *      Emits EscrowImplementationUpgraded.
     * @param newImplementation The new implementation address (must be a contract).
     */
    function upgradeEscrowImplementation(address newImplementation) external onlyRole(LibAccessControl.ESCROW_ADMIN_ROLE) {
        if (newImplementation.code.length == 0) revert UpgradeFailed();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oldImpl = s.vaipakamEscrowTemplate;
        s.vaipakamEscrowTemplate = newImplementation;
        unchecked {
            ++s.currentEscrowVersion;
        }

        emit EscrowImplementationUpgraded(
            oldImpl,
            newImplementation,
            s.currentEscrowVersion
        );
    }

    /**
     * @notice The single chokepoint for protocol-side ERC-20 deposits
     *         into a user's escrow. Pulls `amount` directly from the
     *         user's wallet (using the Diamond's existing allowance)
     *         to the escrow proxy, AND increments
     *         `protocolTrackedEscrowBalance[user][token]` so the
     *         counter stays correct.
     *
     * @dev    onlyDiamondInternal — every protocol facet that previously
     *         did `IERC20(t).safeTransferFrom(user, escrow, amount)`
     *         directly is migrated to call this instead. That keeps
     *         the counter the load-bearing safety boundary for the
     *         stuck-token recovery flow (T-054) and makes the Asset
     *         Viewer's `min(balanceOf, tracked)` display correct.
     *
     *         Auto-creates the user's escrow proxy if missing. Pulls
     *         from `user` (NOT msg.sender — msg.sender is the
     *         Diamond on the cross-facet call) so the user's
     *         wallet-side approval to the Diamond is what authorises
     *         the transfer. This preserves the existing approval
     *         pattern for callers — a user that approved the
     *         Diamond once can be the funding source for any number
     *         of escrow-deposit operations.
     *
     *         For Permit2-mediated transfers (where the funds movement
     *         happens via the signed permit, not via this allowance
     *         path), use {recordEscrowDepositERC20} instead — it does
     *         the counter increment without re-issuing the transfer.
     *
     * @param user The user whose escrow to credit (also the source
     *             of funds — the Diamond's allowance from this user
     *             is consumed).
     * @param token The ERC-20 token address.
     * @param amount The amount to deposit.
     */
    function escrowDepositERC20(
        address user,
        address token,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserEscrow(user);
        // Direct user → escrow transfer using the Diamond's existing
        // allowance from `user`. Token contract sees msg.sender =
        // Diamond (this facet runs in Diamond's context), checks
        // allowance[user][Diamond] >= amount, and moves amount from
        // user to proxy.
        IERC20(token).safeTransferFrom(user, proxy, amount);
        LibVaipakam.recordEscrowDeposit(user, token, amount);
    }

    /**
     * @notice Cross-payer variant of {escrowDepositERC20}. Pulls
     *         `amount` of `token` from `payer`'s wallet (using the
     *         Diamond's allowance from `payer`) and credits it to
     *         `user`'s escrow — so the source of funds and the
     *         owner of the escrow can differ. The
     *         protocolTrackedEscrowBalance counter ticks up under
     *         `user`, matching where the funds land.
     *
     * @dev    Used by repay / preclose / refinance flows where the
     *         borrower pays the lender — borrower is the payer,
     *         lender owns the escrow that receives. For the more
     *         common offer-creation / staking flows where the same
     *         party is both, prefer the simpler {escrowDepositERC20}.
     *
     *         onlyDiamondInternal.
     *
     * @param payer  Address whose allowance to the Diamond is consumed.
     * @param user   User whose escrow is credited (counter increments
     *               under this address).
     * @param token  ERC-20 token address.
     * @param amount Amount to deposit.
     */
    function escrowDepositERC20From(
        address payer,
        address user,
        address token,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserEscrow(user);
        IERC20(token).safeTransferFrom(payer, proxy, amount);
        LibVaipakam.recordEscrowDeposit(user, token, amount);
    }

    /**
     * @notice Counter-only sibling of {escrowDepositERC20} — records
     *         that `amount` of `token` has just been credited to
     *         `user`'s escrow, without re-issuing the transfer.
     *
     * @dev    Use immediately after a Permit2-mediated pull (or any
     *         other transfer mechanism that already routes funds to
     *         the user's escrow). The caller is responsible for
     *         having actually moved the tokens; this function
     *         updates the counter only. Never invoke without a
     *         matching, just-completed transfer to the user's escrow
     *         — doing so silently inflates the counter and corrupts
     *         the recovery cap.
     *
     *         onlyDiamondInternal — gated to cross-facet callers so
     *         no external party can write to the counter directly.
     */
    function recordEscrowDepositERC20(
        address user,
        address token,
        uint256 amount
    ) external onlyDiamondInternal {
        LibVaipakam.recordEscrowDeposit(user, token, amount);
    }

    /**
     * @notice Withdraws ERC-20 tokens from the specified user's escrow to a recipient.
     * @dev onlyDiamondInternal — cross-facet only. Forwards to
     *      {VaipakamEscrowImplementation.withdrawERC20}. Reverts
     *      ProxyCallFailed("Withdraw ERC20 failed") on proxy revert.
     *      Decrements `protocolTrackedEscrowBalance[user][token]` so
     *      the counter remains the symmetric mirror of all
     *      protocol-side movements. Underflow reverts loudly if a
     *      withdraw fires for more than was tracked — that's an
     *      accounting bug somewhere upstream.
     * @param user The user whose escrow to withdraw from.
     * @param token The ERC-20 token address.
     * @param recipient The recipient address.
     * @param amount The amount to withdraw.
     */
    function escrowWithdrawERC20(
        address user,
        address token,
        address recipient,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserEscrow(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.withdrawERC20.selector,
                token,
                recipient,
                amount
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC20 failed");
        LibVaipakam.recordEscrowWithdraw(user, token, amount);
    }

    /**
     * @notice Returns the per-(user, token) protocol-tracked escrow
     *         balance — i.e. the running sum of every
     *         `escrowDepositERC20` / `recordEscrowDepositERC20`
     *         minus every `escrowWithdrawERC20` for that pair.
     *
     * @dev    Pure view; safe to call externally. Asset Viewer
     *         displays `min(balanceOf(escrow, token), this)` so
     *         unsolicited dust pushed in directly via
     *         `IERC20.transfer` is hidden from the UI. The future
     *         stuck-token recovery flow (T-054) caps recovery at
     *         `max(0, balanceOf - this)`.
     */
    function getProtocolTrackedEscrowBalance(
        address user,
        address token
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().protocolTrackedEscrowBalance[user][token];
    }

    // ─── Stuck-token recovery (T-054 PR-3) ───────────────────────────────────
    //
    // The receiver-hook hardening shipped 2026-05-03 blocks direct
    // user-initiated NFT transfers into a per-user escrow. ERC-20 has
    // no equivalent receiver-side hook (the EVM gives the recipient
    // zero opportunity to reject), so unsolicited ERC-20 transfers
    // CAN land in an escrow proxy. This recovery flow gives the
    // legitimate self-deposit case ("I sent USDC to my escrow address
    // by accident from my own wallet / a CEX") a clean exit, while
    // structurally preventing the recovery path from touching
    // protocol-managed collateral / claims.
    //
    // The cap is the load-bearing safety property:
    //
    //     unsolicited = max(0, balanceOf(escrow, token)
    //                       - protocolTrackedEscrowBalance[user][token])
    //     require(amount <= unsolicited)
    //
    // Counter math forbids draining beyond the truly-unsolicited
    // delta no matter what other check is bypassed. The recipient is
    // hardcoded to `msg.sender` (the escrow owner) so admin / malware
    // / coordination attacks cannot redirect funds.
    //
    // Sanctioned-source declarations trigger an escrow ban under the
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
    // user's escrow on a wrong declaration.
    //
    // Full design: docs/DesignsAndPlans/EscrowStuckRecoveryDesign.md.

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
                " be on the sanctions list, my escrow will be locked under the"
                " protocol's sanctions policy until the address is de-listed."
                " I have read and understood the Advanced User Guide section"
                " on stuck-token recovery."
            )
        );

    /// @notice Emitted when stuck ERC-20 tokens are recovered to the
    ///         user's EOA. Indexed for full audit trail post-deploy.
    /// @param  user            Escrow owner whose escrow was tapped.
    /// @param  token           ERC-20 contract being recovered.
    /// @param  declaredSource  Address the user attested as the
    ///                         transfer's origin.
    /// @param  amount          Amount returned to `user` (recipient
    ///                         is locked to the user themselves —
    ///                         no parameter accepted).
    /// @param  nonce           Recovery nonce consumed by this call.
    event StuckERC20Recovered(
        address indexed user,
        address indexed token,
        address indexed declaredSource,
        uint256 amount,
        uint256 nonce
    );

    /// @notice Emitted when a recovery declaration named a sanctions-
    ///         flagged source — the user's escrow is now locked under
    ///         the existing sanctions policy until the source address
    ///         is de-listed from the oracle. The corresponding
    ///         `recoverStuckERC20` call reverts immediately after
    ///         emitting; tokens stay in the escrow.
    event EscrowBannedFromRecoveryAttempt(
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
    event TokenDisowned(
        address indexed user,
        address indexed token,
        uint256 observedAmount,
        uint256 blockNumber
    );

    /**
     * @notice Recover ERC-20 tokens that landed in your escrow via a
     *         direct `IERC20.transfer` (outside the protocol's
     *         deposit flow). Funds are returned to YOU (the escrow
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
     *      DECLARING A SANCTIONED SOURCE LOCKS YOUR ESCROW. The user
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

        // 4. Resolve user's escrow proxy.
        address proxy = s.userVaipakamEscrows[msg.sender];
        if (proxy == address(0)) revert RecoveryUserHasNoEscrow();

        // 5. Cap = max(0, balanceOf - tracked). Recovery cannot drain
        //    protocol-managed balance under any circumstance.
        uint256 actualBal = IERC20(token).balanceOf(proxy);
        uint256 trackedBal = s.protocolTrackedEscrowBalance[msg.sender][token];
        uint256 unsolicited = actualBal > trackedBal
            ? actualBal - trackedBal
            : 0;
        if (amount > unsolicited) revert RecoveryAmountExceedsUnsolicited();

        // 6. Sanctions oracle check on declaredSource. Failure modes:
        //      - Oracle unset: refuse (fail-safe).
        //      - Oracle reverts: refuse (fail-safe).
        //      - Source flagged: ban escrow + revert.
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
            // stay in escrow under the sanctions-policy lock.
            //
            // Crucially, this branch RETURNS rather than reverting.
            // A revert would roll back the ban-state writes, so the
            // ban would never persist. The transaction succeeds at
            // the EVM level — frontend reads the
            // `EscrowBannedFromRecoveryAttempt` event to surface the
            // banned-as-outcome to the user.
            s.escrowBannedSource[msg.sender] = declaredSource;
            unchecked {
                s.recoveryNonce[msg.sender] = nonce + 1;
            }
            emit EscrowBannedFromRecoveryAttempt(
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
                VaipakamEscrowImplementation.withdrawERC20.selector,
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
     *         escrow without recovering them. Event-only — no state
     *         change. Useful as a public on-chain assertion in
     *         compliance disputes ("the dust isn't mine and I never
     *         touched it").
     *
     * @dev    No funds move; the dust stays locked in the escrow as
     *         before. Any future recovery for this token is
     *         unaffected.
     *
     *         Sanctions-gated: a banned escrow can still call
     *         `disown` because it's purely informational. Tier-2 in
     *         the parlance of LibVaipakam's sanctions policy.
     *
     * @param token The ERC-20 token being disowned.
     */
    function disown(address token) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamEscrows[msg.sender];
        if (proxy == address(0)) revert RecoveryUserHasNoEscrow();
        uint256 actualBal = IERC20(token).balanceOf(proxy);
        uint256 trackedBal = s.protocolTrackedEscrowBalance[msg.sender][token];
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
    ///         `user`'s escrow under recovery (zero ⇒ no recovery-
    ///         induced ban). The ban auto-unlocks when this source
    ///         is de-listed from the oracle, even though the storage
    ///         field stays populated.
    function escrowBannedSource(address user) external view returns (address) {
        return LibVaipakam.storageSlot().escrowBannedSource[user];
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
     * @notice Deposits an ERC-721 NFT into the specified user's escrow.
     * @dev Low-level call to the proxy's depositERC721 function (safeTransferFrom).
     *      Reverts on failure.
     * @param user The user whose escrow to deposit into.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     */
    function escrowDepositERC721(
        address user,
        address nftContract,
        uint256 tokenId
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserEscrow(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.depositERC721.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) revert ProxyCallFailed("Deposit ERC721 failed");
    }

    /**
     * @notice Withdraws an ERC-721 NFT from the specified user's escrow to a recipient.
     * @dev Low-level call to the proxy's withdrawERC721 function.
     *      Reverts on failure.
     * @param user The user whose escrow to withdraw from.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param recipient The recipient address.
     */
    function escrowWithdrawERC721(
        address user,
        address nftContract,
        uint256 tokenId,
        address recipient
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserEscrow(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.withdrawERC721.selector,
                nftContract,
                tokenId,
                recipient
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC721 failed");
    }

    /**
     * @notice Deposits ERC-1155 tokens into the specified user's escrow.
     * @dev Low-level call to the proxy's depositERC1155 function.
     *      Reverts on failure.
     * @param user The user whose escrow to deposit into.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param amount The amount to deposit.
     */
    function escrowDepositERC1155(
        address user,
        address nftContract,
        uint256 tokenId,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserEscrow(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.depositERC1155.selector,
                nftContract,
                tokenId,
                amount
            )
        );
        if (!success) revert ProxyCallFailed("Deposit ERC1155 failed");
    }

    /**
     * @notice Withdraws ERC-1155 tokens from the specified user's escrow to a recipient.
     * @dev Low-level call to the proxy's withdrawERC1155 function.
     *      Reverts on failure.
     * @param user The user whose escrow to withdraw from.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @param amount The amount to withdraw.
     * @param recipient The recipient address.
     */
    function escrowWithdrawERC1155(
        address user,
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserEscrow(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.withdrawERC1155.selector,
                nftContract,
                tokenId,
                amount,
                recipient
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC1155 failed");
    }

    /**
     * @notice Approves the user's escrow as operator for an ERC-721 NFT (for rentals without holding).
     * @dev Low-level call to the proxy's approveERC721 function (IERC721.approve).
     *      Reverts on failure.
     * @param user The user whose escrow to approve from.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     */
    function escrowApproveNFT721(
        address user,
        address nftContract,
        uint256 tokenId
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserEscrow(user);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.approveERC721.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) revert ProxyCallFailed("Approve ERC721 failed");
    }

    /**
     * @notice Sets the temporary user (renter) for a rentable NFT from the specified user's escrow.
     * @dev Low-level call to the proxy's setUser function (IERC4907.setUser).
     *      Enhanced: Explicit proxy existence check. Reverts with reason on failure.
     *      For ERC721: Calls as operator (NFT not held in escrow).
     *      For ERC1155: Calls while holding tokens in escrow. Underlying
     *      IERC4907 support is optional — the escrow maintains its own
     *      wrapper state so third-party integrations can query the escrow
     *      uniformly even when the NFT does not implement ERC-4907.
     *      Callable by facets (e.g., for loan acceptance in OfferFacet).
     * @param user The user whose escrow to operate from (typically the lender).
     * @param nftContract The NFT contract address (must support IERC4907).
     * @param tokenId The token ID.
     * @param renter The temporary renter address (borrower).
     * @param expires The expiration timestamp (end of loan term).
     */
    function escrowSetNFTUser(
        address user,
        address nftContract,
        uint256 tokenId,
        address renter,
        uint64 expires
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamEscrows[user];
        if (proxy == address(0)) revert NoEscrow();

        (bool success, bytes memory returnData) = proxy.call(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.setUser.selector,
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
        emit EscrowRentalUpdated(
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
     * @dev Convenience accessor used by escrow-side integrations that prefer
     *      not to import LibVaipakam directly. For the full offer record
     *      use {OfferFacet.getOffer}.
     * @param offerId The offer ID.
     * @return amount The offer amount (0 if the offer does not exist).
     */
    function getOfferAmount(
        uint256 offerId
    ) external view returns (uint256 amount) {
        LibVaipakam.Offer memory offer = LibVaipakam.storageSlot().offers[offerId];
        return offer.amount;
    }

    /**
     * @notice Returns the Diamond's own address as recorded in LibVaipakam
     *         storage at {initializeEscrowImplementation} time.
     * @dev Used by escrow proxies to verify their authorized caller.
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
     * @notice Returns the existing escrow proxy for `user`, or the zero
     *         address if one has not been deployed yet.
     * @dev Pure read — unlike {getOrCreateUserEscrow} this never deploys,
     *      so it is safe for off-chain callers resolving "does this address
     *      belong to user X's escrow?" (e.g. the frontend treating an
     *      NFT-in-escrow holder as the escrow's user during strategic flows).
     * @param user The user address to resolve.
     * @return proxy The user's escrow proxy, or zero if not yet created.
     */
    function getUserEscrowAddress(address user) external view returns (address proxy) {
        return LibVaipakam.storageSlot().userVaipakamEscrows[user];
    }

    /**
     * @notice Returns the current shared `VaipakamEscrowImplementation`
     *         template address that new per-user proxies are pointed at.
     * @dev Updated by {upgradeEscrowImplementation}. Existing user proxies
     *      keep their previous pointer until {upgradeUserEscrow}.
     * @return vaipakamEscrowTemplate The current escrow implementation address.
     */
    function getVaipakamEscrowImplementationAddress()
        external
        view
        returns (address vaipakamEscrowTemplate)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.vaipakamEscrowTemplate;
    }

    /**
     * @notice Escrow version info a frontend needs to surface the mandatory
     *         upgrade flow (README §"Escrow Upgrades"). Without this, clients
     *         would have to probe `getOrCreateUserEscrow` and parse the
     *         `EscrowUpgradeRequired()` revert to detect blocked accounts.
     * @param user The user address to check.
     * @return userVersion The user's current escrow version (0 if no escrow).
     * @return currentVersion The latest shared implementation version.
     * @return mandatoryVersion The minimum required version (0 = no mandate).
     * @return upgradeRequired True iff the user has an escrow and it is below
     *         the mandatory floor — UI should force an upgrade before any
     *         further diamond-driven escrow interaction.
     */
    function getEscrowVersionInfo(address user)
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
        userVersion = s.escrowVersion[user];
        currentVersion = s.currentEscrowVersion;
        mandatoryVersion = s.mandatoryEscrowVersion;
        upgradeRequired =
            s.userVaipakamEscrows[user] != address(0) &&
            mandatoryVersion > 0 &&
            userVersion < mandatoryVersion;
    }

    /**
     * @notice Gets the current user of a rentable NFT from the specified user's escrow.
     * @dev Low-level staticcall to the proxy's userOf function.
     *      Returns zero address on failure.
     *      View function; callable by anyone.
     * @param user The user whose escrow to query.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @return The current renter address (zero if none or failure).
     */
    function escrowGetNFTUserOf(
        address user,
        address nftContract,
        uint256 tokenId
    ) external view returns (address) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamEscrows[user];
        if (proxy == address(0)) return address(0);

        (bool success, bytes memory result) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.userOf.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) return address(0);
        return abi.decode(result, (address));
    }

    /**
     * @notice Gets the expiration timestamp for a rentable NFT's user from the specified user's escrow.
     * @dev Low-level staticcall to the proxy's userExpires function.
     *      Returns 0 on failure.
     *      View function; callable by anyone.
     * @param user The user whose escrow to query.
     * @param nftContract The NFT contract address.
     * @param tokenId The token ID.
     * @return The expiration timestamp (0 if none or failure).
     */
    function escrowGetNFTUserExpires(
        address user,
        address nftContract,
        uint256 tokenId
    ) external view returns (uint64) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamEscrows[user];
        if (proxy == address(0)) return 0;

        (bool success, bytes memory result) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.userExpires.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) return 0;
        return abi.decode(result, (uint64));
    }

    /**
     * @notice Records an ERC-1155 partial-quantity rental in the lender's
     *         escrow alongside any other concurrent active rentals for the
     *         same (nftContract, tokenId). See
     *         {VaipakamEscrowImplementation.setUser1155}.
     * @dev onlyDiamondInternal. Reverts NoEscrow if the lender's proxy
     *      has not been created yet, or bubbles the proxy's revert data
     *      (or ProxyCallFailed("Set NFT user 1155 failed")) on failure.
     *      Emits EscrowRentalUpdated with the post-update aggregate.
     * @param user         The lender whose escrow holds the 1155 balance.
     * @param nftContract  The ERC-1155 contract.
     * @param tokenId      The token id being rented.
     * @param renter       The borrower receiving rental rights (zero to clear).
     * @param expires      Rental expiry timestamp for this `renter`.
     * @param quantity     Units of `tokenId` to record for `renter`.
     */
    function escrowSetNFTUser1155(
        address user,
        address nftContract,
        uint256 tokenId,
        address renter,
        uint64 expires,
        uint256 quantity
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamEscrows[user];
        if (proxy == address(0)) revert NoEscrow();

        (bool success, bytes memory returnData) = proxy.call(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.setUser1155.selector,
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
        emit EscrowRentalUpdated(
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
    ///      EscrowRentalUpdated. Returns zeros on any call failure so the
    ///      emit never blocks the mutating path.
    function _readAggregate(
        address proxy,
        address nftContract,
        uint256 tokenId
    ) private view returns (uint256 aggQty, uint64 minExp) {
        (bool okQ, bytes memory qData) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.userQuantity.selector,
                nftContract,
                tokenId
            )
        );
        if (okQ) aggQty = abi.decode(qData, (uint256));
        (bool okE, bytes memory eData) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.userExpires.selector,
                nftContract,
                tokenId
            )
        );
        if (okE) minExp = abi.decode(eData, (uint64));
    }

    /**
     * @notice Gets the rented quantity held in the specified user's escrow
     *         for an NFT. For ERC-1155 this is the balance escrowed under
     *         the active rental; for ERC-721 it is 1 while active, else 0.
     * @dev Low-level staticcall to the proxy's userQuantity view. Returns 0
     *      if the escrow is absent or the call fails. Enables the README's
     *      ERC-1155 quantity-read promise as a first-class integration
     *      surface.
     * @param user         The escrow owner (lender).
     * @param nftContract  The NFT contract.
     * @param tokenId      The token id to query.
     * @return quantity    Rented quantity (0 if no active rental or lookup fails).
     */
    function escrowGetNFTQuantity(
        address user,
        address nftContract,
        uint256 tokenId
    ) external view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamEscrows[user];
        if (proxy == address(0)) return 0;

        (bool success, bytes memory result) = proxy.staticcall(
            abi.encodeWithSelector(
                VaipakamEscrowImplementation.userQuantity.selector,
                nftContract,
                tokenId
            )
        );
        if (!success) return 0;
        return abi.decode(result, (uint256));
    }
}
