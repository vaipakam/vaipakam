// src/facets/VaultFactoryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";

import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/// @dev The payout gate's host (protected account mode), reached by self-call.
interface IPayoutGate {
    function applyPayoutGate(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external returns (bool held);
}

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

    /// @dev Protected account mode — whether this payout must not be paid
    ///      now (queued, or kept in a locked account's vault). Only an
    ///      account with the mode on pays for the self-call into the gate's
    ///      host (`VaultPayoutFacet.applyPayoutGate`, the rule in
    ///      `LibProtectedAccount.gate`).
    function _payoutHeld(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) private returns (bool) {
        if (!LibVaipakam.storageSlot().protectedAccount[user].enabled) return false;
        return IPayoutGate(address(this)).applyPayoutGate(user, kind, asset, tokenId, amount, recipient);
    }

    /// @dev Protected account mode, the RECIPIENT side: where a payout from
    ///      `user`'s vault to `recipient` must land instead of `recipient`'s
    ///      wallet. A payment the protocol makes to a protected account's
    ///      wallet from anywhere but that account's own vault is credited to
    ///      its vault, so it leaves only through the delay; the source side
    ///      ({_payoutHeld}) covers the account's own vault. Zero when the
    ///      payout goes where it was addressed: `recipient` is `user`, or has
    ///      the mode off. An account with the mode on always has a vault
    ///      (enabling creates it).
    function _protectedRecipientVault(address user, address recipient) private view returns (address) {
        if (recipient == user) return address(0);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protectedAccount[recipient].enabled) return address(0);
        return s.userVaipakamVaults[recipient];
    }

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
    ///         `loanId` (#902) names the one rental the update is for, which
    ///         is how a subscriber tells concurrent ERC-1155 rentals of the
    ///         same token apart, a revoke (zero `user` and `quantity`)
    ///         included. `user`, `expires` and `quantity` are that rental's
    ///         record after the update (its rented units, zero on a revoke),
    ///         while `activeTotalQuantity` / `minActiveExpires` reflect the
    ///         post-update aggregate across all active rentals of the same
    ///         (nftContract, tokenId) in the lender's vault.
    /// @custom:event-category state-change/vault-mutation
    event VaultRentalUpdated(
        address indexed lender,
        address indexed nftContract,
        uint256 indexed tokenId,
        uint256 loanId,
        address user,
        uint64 expires,
        uint256 quantity,
        uint256 activeTotalQuantity,
        uint64 minActiveExpires
    );

    /// @notice Emitted when the mandatory minimum vault version changes
    ///         (#2363). Every user whose vault is stamped below `version` is
    ///         refused the vault-dependent entry points until they (or
    ///         anyone) call {upgradeUserVault}; zero clears the requirement.
    /// @custom:event-category informational/config
    event MandatoryVaultVersionSet(uint256 previousVersion, uint256 version);

    /// @notice Emitted when the shared vault implementation is upgraded.
    /// @param oldImplementation The address of the previous implementation.
    /// @param newImplementation The address of the new implementation.
    /// @param newVersion The bumped `currentVaultVersion` counter after
    ///        the upgrade. Indexers use this to correlate later per-user
    ///        `upgradeUserVault` events with the implementation that
    ///        became current at this moment.
    /// @param newCodehash `extcodehash` of the new implementation (#897), so
    ///        a reviewer can match the queued Timelock operation against
    ///        audited bytecode — the address alone says nothing about what
    ///        it runs.
    /// @custom:event-category state-change/vault-mutation
    event VaultImplementationUpgraded(
        address indexed oldImplementation,
        address indexed newImplementation,
        uint256 indexed newVersion,
        bytes32 newCodehash
    );

    /// @notice RL-2 (VpfiRecyclingLoopClosureDesign §6) — emitted whenever
    ///         protocol-tracked VPFI leaves a user's vault through the
    ///         tracked-balance decrement chokepoint,
    ///         `LibVaipakam.recordVaultWithdraw`, through its two callers:
    ///         {vaultWithdrawERC20} (wallet withdrawals, notification tariff
    ///         pulls, fee pulls, and future perk spends all route through it)
    ///         and, since #1566 S3e, {recordVaultOutflowERC20} (a
    ///         swap-to-repay fill's lot, which the 1inch LOP moves itself). The RL-2 reward-retention ledger consumes this:
    ///         debits spend reward-delivered VPFI FIRST, so without this
    ///         event vault VPFI outflows would be invisible off-chain and
    ///         `rewardRetained` would overstate loop closure.
    /// @dev    VPFI-only by design — the loop-closure metric tracks the
    ///         protocol token, not general vault traffic (other tokens keep
    ///         their existing per-flow events). The ledger never consults
    ///         `recipient` (ANY debit decrements); it is observability
    ///         metadata distinguishing wallet withdrawals from
    ///         treasury/fee destinations. Any further caller of
    ///         `recordVaultWithdraw` MUST emit this event too.
    /// @param user      Vault owner whose tracked VPFI decreased.
    /// @param amount    VPFI wei debited from the tracked balance.
    /// @param recipient Where the debited VPFI was sent (for a swap-to-repay
    ///                  fill, the fill's taker; the LOP may deliver to a target
    ///                  the taker names).
    /// @custom:event-category state-change/vault-mutation
    event VaultVpfiDebited(
        address indexed user,
        uint256 amount,
        address recipient
    );

    // Custom errors for better gas efficiency and clarity.
    error AlreadyInitialized();
    error UpgradeFailed();
    error ProxyCallFailed(string reason);
    error NoVault();
    /// @dev #902 — {vaultSetRentalUser} was asked to set the renter of an
    ///      ERC-20 loan, which rents nothing.
    error NotRentalLoan();
    error VaultUpgradeRequired();
    /// @dev Depository vault — `user` pinned their vault's implementation, so
    ///      only `user` may upgrade it.
    error VaultPinned(address user);
    /// @notice Depository vault — `user`'s pin was cleared (by their own
    ///         upgrade, or by an unpin).
    /// @custom:event-category state-change/vault-mutation
    event VaultUnpinned(address indexed account);
    /// @dev #2363 — a mandatory vault version above `currentVaultVersion`
    ///      is a bar no user can clear: {upgradeUserVault} can only stamp a
    ///      user at `currentVaultVersion`, so every existing-vault user
    ///      would be refused until an admin acted again.
    error MandatoryVaultVersionUnreachable(uint256 version, uint256 currentVersion);
    /// @notice #821 — a wind-down close-out tried to deposit a flagged
    ///         recipient's locked share but the recipient has no existing vault,
    ///         and the receive-side exemption refuses to mint one for a
    ///         sanctioned wallet. Unreachable for real loan parties (they all
    ///         have a vault by close-out time); a defensive backstop.
    error SanctionedRecipientHasNoVault(address recipient);

    /**
     * @notice Initializes the shared vault implementation by deploying a new VaipakamVaultImplementation.
     * @dev VAULT_ADMIN_ROLE-only. Single-shot: reverts AlreadyInitialized
     *      once `vaipakamVaultTemplate` is set. Deploys a fresh impl and
     *      stores both the template and the diamond self-reference. The
     *      impl is not initialized: its constructor locks it (#905), and
     *      only the per-user proxies are ever initialized.
     */
    function initializeVaultImplementation() external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.vaipakamVaultTemplate != address(0)) revert AlreadyInitialized();

        VaipakamVaultImplementation impl = new VaipakamVaultImplementation();
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
        bool moveOutExempt = exemptUser != address(0) && user == exemptUser;
        // #821 — receive-side exemption: a wind-down close-out depositing the
        // flagged recipient's LOCKED share into their EXISTING vault. Skip the
        // screen for the exact pinned recipient (the proceeds are claim-gated —
        // see the `sanctionedDepositExemptUser` natspec), but NEVER mint a new
        // vault for a sanctioned wallet under it (guard below).
        address depositExempt = s.sanctionedDepositExemptUser;
        bool receiveExempt = depositExempt != address(0) && user == depositExempt;
        if (!moveOutExempt && !receiveExempt) {
            LibVaipakam._assertNotSanctioned(user);
        }
        proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) {
            // #821 — under the receive-side exemption, refuse to CREATE a vault
            // for a SANCTIONED recipient (policy: no vault for a flagged wallet).
            // A clean recipient with no vault yet still gets one created normally;
            // every real loan party already has a vault by close-out time, so
            // this revert is a defensive backstop, not a routine path.
            if (receiveExempt && LibVaipakam.isSanctionedAddress(user)) {
                revert SanctionedRecipientHasNoVault(user);
            }
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
            s.vaultUserOf[proxy] = user;
            s.vaultVersion[user] = s.currentVaultVersion;
            emit UserVaultCreated(user, proxy);
        } else {
            // Block interactions with outdated vaults when a mandatory upgrade
            // is active. Depository vault: an owner who PINNED their vault to
            // the implementation they chose may still deposit, withdraw,
            // release and escape on it (the depository steps set the context);
            // every loan step still needs the upgrade.
            if (
                LibVaipakam.vaultUpgradeRequired(user)
                    && !(s.vaultPinnedImplementation[user] != address(0)
                        && LibProtectedAccount.inDepositoryContext())
            ) revert VaultUpgradeRequired();
        }
    }

    /**
     * @notice Marks a mandatory minimum vault version.
     * @dev VAULT_ADMIN_ROLE-only. When set, any user whose vault version is
     *      below this value is blocked from all diamond-driven vault
     *      interactions (see getOrCreateUserVault) until they call
     *      {upgradeUserVault}. Set to 0 to clear the requirement.
     *      Refuses a version above `currentVaultVersion` (#2363): the
     *      permissionless repair stamps users at `currentVaultVersion` and
     *      no higher, so such a bar would halt every existing-vault user
     *      with no way for them to clear it.
     * @param version The minimum required vault version (at most
     *        currentVaultVersion; normally exactly it).
     */
    function setMandatoryVaultUpgrade(uint256 version) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (version > s.currentVaultVersion) {
            revert MandatoryVaultVersionUnreachable(version, s.currentVaultVersion);
        }
        emit MandatoryVaultVersionSet(s.mandatoryVaultVersion, version);
        s.mandatoryVaultVersion = version;
    }

    /**
     * @notice Upgrades a user's vault proxy to the latest implementation.
     * @dev Calls UUPS upgradeToAndCall on the user's proxy to point it to the
     *      current vaipakamVaultTemplate. Updates the user's version stamp.
     *      Callable by anyone (typically the user themselves via frontend),
     *      except for a vault its owner has pinned
     *      (`VaultDepositoryFacet.pinVaultImplementation`): only the owner
     *      upgrades a pinned vault, which also clears the pin.
     * @param user The user whose vault to upgrade.
     */
    function upgradeUserVault(address user) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) revert NoVault();
        if (s.vaultPinnedImplementation[user] != address(0)) {
            if (msg.sender != user) revert VaultPinned(user);
            delete s.vaultPinnedImplementation[user];
            emit VaultUnpinned(user);
        }
        _upgradeVault(s, user, proxy);
    }

    /// @dev Points `user`'s vault `proxy` at the current shared template and
    ///      stamps the current version. The one upgrade step, shared by
    ///      {upgradeUserVault} and the rental route's catch-up. It refuses a
    ///      PINNED vault, so no path reaching it can move a vault its owner
    ///      pinned: the owner's own upgrade clears the pin before calling it,
    ///      and the rental catch-up skips a pinned vault instead.
    function _upgradeVault(
        LibVaipakam.Storage storage s,
        address user,
        address proxy
    ) private {
        if (s.vaultPinnedImplementation[user] != address(0)) revert VaultPinned(user);
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
     * @dev VAULT_ADMIN_ROLE-only — the Timelock after handover, and since
     *      #934 / D1 that role can no longer be re-granted to a hot key
     *      without the Timelock delay either (DEFAULT_ADMIN_ROLE is
     *      Timelock-held). This IS a lever over every user vault: a new
     *      implementation, plus {setMandatoryVaultUpgrade} and the
     *      permissionless {upgradeUserVault}, can change what every vault's
     *      code does, including how it releases funds (#897). The
     *      protection is that the change is public and delayed — queued in
     *      the Timelock for its full delay, with the implementation's
     *      codehash in the event — not that it is impossible.
     *      Rejects non-contract addresses
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
            s.currentVaultVersion,
            newImplementation.codehash
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
        // #667 — measured at the proxy and refused unless it arrived in
        // full, so the tracked balance (and every lien and offer amount set
        // from `amount`) never exceeds what the vault holds.
        LibDelivery.pullExact(token, user, proxy, amount);
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
        // #1281-011 — measured and refused unless it arrived in full, so a
        // repayment can never record a lender's due above what reached the
        // lender's vault.
        LibDelivery.pullExact(token, payer, proxy, amount);
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
     * @notice RL-1 (VpfiRecyclingLoopClosureDesign §6) — the Diamond-funded
     *         vault credit primitive. Transfers `amount` of `token` from the
     *         DIAMOND's own balance into `user`'s vault proxy, then runs the
     *         same recording tail the user-funded deposit chokepoint runs:
     *         the `protocolTrackedVaultBalance` increment, which for VPFI
     *         refreshes the user's tier record (#1820) — so the credit counts
     *         toward fee-discount standing instead of being clamped out as
     *         unsolicited dust.
     *
     * @dev    NOT a variant of {vaultDepositERC20}: that chokepoint is
     *         user-funded (`safeTransferFrom(user, proxy, amount)` against
     *         the claimant's wallet allowance), while this pays from the
     *         Diamond's pre-funded balance — routing a protocol payout
     *         through the user-funded pull would revert for claimants with
     *         no matching wallet balance/allowance, or silently move the
     *         user's own tokens instead of the payout.
     *
     *         Vault resolution is READ-ONLY on purpose: never
     *         {getOrCreateUserVault}, which both mints vaults and reverts
     *         `VaultUpgradeRequired`. A payout path must not mint a vault as
     *         a side effect, and callers (the reward claim) treat any revert
     *         here as "fall back to wallet delivery" — so `NoVault` /
     *         `VaultUpgradeRequired` below are the fallback triggers, not
     *         hard failures. The whole body runs in the caller's
     *         revert-isolated cross-facet frame: a failure at ANY step
     *         (transfer, record) rolls back every vault-side effect
     *         before the caller's fallback pays.
     *
     *         The tier push this credit causes is not sent here: the claim
     *         holds the reentrancy guard, so the user is queued and pushed
     *         when the claim ends (#1820). Sanctions posture is the CALLER's concern
     *         (the claim entry point Tier-1-gates `msg.sender` already);
     *         onlyDiamondInternal keeps external parties out.
     *
     * @param user   User whose vault is credited (counter increments under
     *               this address).
     * @param token  ERC-20 token address (the tier record is refreshed only
     *               when this is the registered VPFI token).
     * @param amount Amount to credit from the Diamond's balance.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultCreditFromDiamondERC20(
        address user,
        address token,
        uint256 amount
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = _currentVault(s, user);
        IERC20(token).safeTransfer(proxy, amount);
        LibVaipakam.recordVaultDeposit(user, token, amount);
    }

    /**
     * @notice #1566 slice 4 PR B — the HOLDER-sourced sibling of
     *         {vaultCreditFromDiamondERC20}: pay a reward claim into the
     *         claimant's vault out of the delivered reward custody, debiting
     *         the holder's live-fresh and recycled rows by exactly the two
     *         components and releasing their sum from the holder to the
     *         vault proxy, measured at both ends — then the same tracked-
     *         balance record (and tier refresh) as the Diamond-funded route.
     * @dev    ONE revert-isolated frame (design §5d): the caller invokes this
     *         through the Diamond's fallback, so a failure at ANY step — no
     *         vault, the mandatory-upgrade gate, a row that cannot cover its
     *         component, a release either end cannot account for, the record,
     *         the tier refresh — rolls back the row debits AND the holder release
     *         before the caller's wallet fallback pays. Exactly one
     *         destination is ever paid. Same fallback triggers as the sibling
     *         (`NoVault` / `VaultUpgradeRequired` are not failures); same
     *         onlyDiamondInternal posture. The token must be the configured
     *         VPFI: that is the only asset the holder's rows describe.
     * @param user     Claimant whose vault is credited.
     * @param token    The configured VPFI token.
     * @param fresh    The FRESH component, debited from the live-fresh row.
     * @param recycled The RECYCLED component, debited from the recycled row.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultCreditFromRewardCustodyERC20(
        address user,
        address token,
        uint256 fresh,
        uint256 recycled,
        uint256 epoch
    ) external onlyDiamondInternal {
        _vaultCreditFromRewardCustody(user, token, fresh, recycled, epoch);
    }

    /// @notice The four-argument vault credit the custody cutover shipped,
    ///         kept as a COMPATIBILITY entry (Codex #2276 r3 P1, r14 P2): on
    ///         a Diamond refreshed one facet at a time, a settle facet from
    ///         before the epoch leg still reaches the credit through this
    ///         signature, and it must land in the refreshed implementation —
    ///         with no epoch leg, since such a caller has none — rather than
    ///         in the previous one, or fall to wallet delivery once the route
    ///         is gone. Part of the facet's surface, so every refresh routes
    ///         it here; retiring it would need every caller cut atomically.
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultCreditFromRewardCustodyERC20(
        address user,
        address token,
        uint256 fresh,
        uint256 recycled
    ) external onlyDiamondInternal {
        _vaultCreditFromRewardCustody(user, token, fresh, recycled, 0);
    }

    function _vaultCreditFromRewardCustody(
        address user,
        address token,
        uint256 fresh,
        uint256 recycled,
        uint256 epoch
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = _currentVault(s, user);
        (address holder, address vpfi) = LibRewardCustody.boundHolderAndToken(s);
        if (token != vpfi) revert IVaipakamErrors.RewardCustodyPayoutTokenMismatch(vpfi, token);
        LibRewardCustody.debit(s, LibVaipakam.RewardCustodyRow.LiveFresh, fresh, proxy);
        LibRewardCustody.debit(s, LibVaipakam.RewardCustodyRow.Recycled, recycled, proxy);
        // #1566 transport epochs PR 3b-ii-A — the claim's epoch-paid legs,
        // released from the `Unclassified` row where an epoch's value rests.
        LibRewardCustody.debit(s, LibVaipakam.RewardCustodyRow.Unclassified, epoch, proxy);
        uint256 amount = fresh + recycled + epoch;
        LibRewardCustody.releaseMeasured(vpfi, holder, proxy, amount);
        LibVaipakam.recordVaultDeposit(user, token, amount);
    }

    /// @dev READ-ONLY resolution of an EXISTING vault on a current implementation
    ///      (`NoVault` / `VaultUpgradeRequired` otherwise), with no sanctions
    ///      screen. Shared by both protocol-payout credits (see
    ///      {vaultCreditFromDiamondERC20} for why it never mints) and, since
    ///      #1566 S3e, the swap fill's {recordVaultOutflowERC20}: a mandatory
    ///      upgrade holds the fill until anyone runs {upgradeUserVault}, as the
    ///      vault withdraw it replaced did.
    function _currentVault(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (address proxy) {
        proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) revert NoVault();
        if (LibVaipakam.vaultUpgradeRequired(user)) revert VaultUpgradeRequired();
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
     *
     *      #2440 — the one place a vault's ERC-20 outflow is measured: the
     *      vault always sends `amount` (its tracked balance falls by exactly
     *      that), and the return value is what `recipient`'s balance actually
     *      rose by, never more than `amount` ({LibDelivery.measured}). When
     *      `recipient` is this same vault (two positions one user holds, as
     *      after a consolidation), the balance cannot rise, and the return
     *      value is what the vault kept: `amount` for an ordinary token. A token
     *      that delivers less than it sends (a fee switched on after the token
     *      entered, a rebase) makes the two differ. The withdraw itself never
     *      refuses on that: a payout to a wallet books nothing, and refusing
     *      it would trap the owner's funds. A caller that BOOKS the arrival
     *      (the Diamond selling or forwarding it, a vault credited with it)
     *      decides with the returned figure — a voluntary flow refuses a
     *      short arrival, a forced close-out acts on it (see {LibDelivery}).
     * @param user The user whose vault to withdraw from.
     * @param token The ERC-20 token address.
     * @param recipient The recipient address.
     * @param amount The amount to withdraw.
     * @return delivered What `recipient` received, capped at `amount`.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultWithdrawERC20(
        address user,
        address token,
        address recipient,
        uint256 amount
    ) external onlyDiamondInternal returns (uint256 delivered) {
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
        uint256 trackedBalance = LibVaipakam.trackedHolding(user, token, 0);
        uint256 proxyBefore = IERC20(token).balanceOf(proxy);
        uint256 rawForGuard = proxyBefore;
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
        // Protected account mode — a payout to the owner's own wallet is
        // queued (or, while the account is locked, kept in the vault) instead
        // of paid; nothing moves and the tracked balance is unchanged until a
        // release pays it through this same route.
        if (_payoutHeld(user, uint8(LibVaipakam.AssetType.ERC20), token, 0, amount, recipient)) {
            return amount;
        }
        // A protected recipient's wallet is paid into its vault instead.
        address creditTo = _protectedRecipientVault(user, recipient);
        address dest = creditTo == address(0) ? recipient : creditTo;
        uint256 recipientBefore = IERC20(token).balanceOf(dest);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.withdrawERC20.selector,
                token,
                dest,
                amount
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC20 failed");
        // #2440 — the vault must lose no more than `amount`: the tracked
        // balance below falls by exactly that, and a token charging its sender
        // on top would take the excess from the holder's other positions.
        LibDelivery.requireNoOverDebit(token, proxy, proxyBefore, amount);
        delivered = LibDelivery.measured(token, proxy, dest, recipientBefore, amount);
        LibVaipakam.recordVaultWithdraw(user, token, amount);
        if (creditTo != address(0)) {
            LibProtectedAccount.creditPayment(recipient, token, 0, amount, delivered);
        }
        // RL-2 — VPFI outflow observability for the reward-retention
        // ledger. This and {recordVaultOutflowERC20} are the two
        // recordVaultWithdraw callers and both emit it, so every tracked
        // VPFI debit is covered (see the event natspec).
        if (token == LibVaipakam.storageSlot().vpfiToken) {
            emit VaultVpfiDebited(user, amount, recipient);
        }
    }

    /**
     * @notice #1566 S3e — record an outflow a third party performs on the vault's own approval:
     *         the 1inch LOP taking a swap-to-repay intent's lot from `user`'s vault (the order's
     *         maker) straight to the taker. The tracked balance, the lien guard and the RL-2 debit
     *         event of {vaultWithdrawERC20}, without the token move, which the LOP makes right after.
     * @dev    Diamond-internal: the swap pre-hook self-calls it, under the fill lock, after lowering
     *         the loan's lien by `amount`, so the guard (the outflow may not dip into what is still
     *         encumbered) reads the post-decrement lien. The vault is resolved by {_currentVault}:
     *         an existing vault on a current implementation, with no sanctions screen (the full
     *         swap-to-repay is a must-complete close-out).
     *         COUNTER-ONLY: it records an outflow it does not perform, so it is sound only because
     *         its one caller requires, in the same fill, that the vault's balance dropped by
     *         exactly `amount` (the post-hook's check); a new caller must carry the same check.
     * @param user      The vault's owner (`loan.borrower`).
     * @param token     The ERC-20 the LOP takes.
     * @param amount    The lot.
     * @param recipient The fill's taker, named on the RL-2 event (the LOP delivers to the taker
     *                  or to a target the taker names).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function recordVaultOutflowERC20(
        address user,
        address token,
        uint256 amount,
        address recipient
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address proxy = _currentVault(s, user);
        uint256 trackedBalance = LibVaipakam.trackedHolding(user, token, 0);
        uint256 rawForGuard = IERC20(token).balanceOf(proxy);
        if (trackedBalance < rawForGuard) {
            rawForGuard = trackedBalance;
        }
        _assertWithdrawAllowed(user, token, /*tokenId=*/0, amount, rawForGuard);
        LibVaipakam.recordVaultWithdraw(user, token, amount);
        if (token == s.vpfiToken) {
            emit VaultVpfiDebited(user, amount, recipient);
        }
    }

    /**
     * @notice The tracked holding of `asset` / `tokenId` in `user`'s vault:
     *         what the protocol put in and has not taken out (zero `tokenId`
     *         for an ERC-20, the unit count for an ERC-1155, one for an
     *         ERC-721 the vault holds through the protocol).
     * @dev    The one ledger every vault withdraw route is bounded by. An
     *         asset that reached the vault outside the protocol is not in it
     *         until its owner adopts it (`VaultDepositoryFacet.adoptUntracked`).
     *         Display `min(chain balance, this)` to hide unsolicited assets.
     */
    function getTrackedHolding(
        address user,
        address asset,
        uint256 tokenId
    ) external view returns (uint256) {
        return LibVaipakam.trackedHolding(user, asset, tokenId);
    }

    /**
     * @notice Deposits ERC-721 `tokenId` from `from` into `user`'s vault and
     *         records it in the tracked ledger.
     * @dev    The Diamond moves the token as `from`'s approved operator
     *         (the vault's receive hook accepts the Diamond as operator), then
     *         checks the vault owns it.
     * @param user        Whose vault is credited.
     * @param from        Who the token comes from (usually `user`).
     * @param nftContract The NFT contract address.
     * @param tokenId     The token ID.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultDepositERC721(
        address user,
        address from,
        address nftContract,
        uint256 tokenId
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        IERC721(nftContract).safeTransferFrom(from, proxy, tokenId);
        if (IERC721(nftContract).ownerOf(tokenId) != proxy) revert ProxyCallFailed("Deposit ERC721 failed");
        LibVaipakam.recordVaultDeposit(user, nftContract, tokenId, 1);
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
        //
        // Depository vault — bounded by the tracked ledger: a token the
        // protocol never put in this vault (one that arrived by a plain
        // transfer) is not withdrawable until its owner adopts it.
        _assertWithdrawAllowed(
            user,
            nftContract,
            tokenId,
            1,
            LibVaipakam.trackedHolding(user, nftContract, tokenId)
        );
        if (_payoutHeld(user, uint8(LibVaipakam.AssetType.ERC721), nftContract, tokenId, 1, recipient)) {
            return;
        }
        address creditTo = _protectedRecipientVault(user, recipient);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.withdrawERC721.selector,
                nftContract,
                tokenId,
                creditTo == address(0) ? recipient : creditTo
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC721 failed");
        LibVaipakam.recordVaultWithdraw(user, nftContract, tokenId, 1);
        if (creditTo != address(0)) {
            LibProtectedAccount.creditPayment(recipient, nftContract, tokenId, 1, 1);
        }
    }

    /**
     * @notice Deposits `amount` units of ERC-1155 `tokenId` from `from` into
     *         `user`'s vault and records what arrived in the tracked ledger.
     * @dev    Measured: refused unless the vault's balance rose by `amount`.
     * @param user        Whose vault is credited.
     * @param from        Who the units come from (usually `user`).
     * @param nftContract The ERC-1155 contract address.
     * @param tokenId     The token ID.
     * @param amount      Units to deposit.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultDepositERC1155(
        address user,
        address from,
        address nftContract,
        uint256 tokenId,
        uint256 amount
    ) external onlyDiamondInternal {
        address proxy = getOrCreateUserVault(user);
        uint256 before = IERC1155(nftContract).balanceOf(proxy, tokenId);
        IERC1155(nftContract).safeTransferFrom(from, proxy, tokenId, amount, "");
        if (IERC1155(nftContract).balanceOf(proxy, tokenId) - before != amount) {
            revert ProxyCallFailed("Deposit ERC1155 failed");
        }
        LibVaipakam.recordVaultDeposit(user, nftContract, tokenId, amount);
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
        // #407 PR 4 — encumbrance guard, keyed on the specific tokenId,
        // over the tracked units (never more than the vault holds), so units
        // that arrived outside the protocol stay out of reach until adopted.
        uint256 units = IERC1155(nftContract).balanceOf(proxy, tokenId);
        uint256 trackedUnits = LibVaipakam.trackedHolding(user, nftContract, tokenId);
        _assertWithdrawAllowed(
            user,
            nftContract,
            tokenId,
            amount,
            trackedUnits < units ? trackedUnits : units
        );
        if (_payoutHeld(user, uint8(LibVaipakam.AssetType.ERC1155), nftContract, tokenId, amount, recipient)) {
            return;
        }
        address creditTo = _protectedRecipientVault(user, recipient);
        (bool success, ) = proxy.call(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.withdrawERC1155.selector,
                nftContract,
                tokenId,
                amount,
                creditTo == address(0) ? recipient : creditTo
            )
        );
        if (!success) revert ProxyCallFailed("Withdraw ERC1155 failed");
        LibVaipakam.recordVaultWithdraw(user, nftContract, tokenId, amount);
        if (creditTo != address(0)) {
            LibProtectedAccount.creditPayment(recipient, nftContract, tokenId, amount, amount);
        }
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
     * @notice Assigns, updates or revokes the renter of loan `loanId`'s
     *         rented NFT, in the lender's vault where the NFT is held. The one
     *         route every rental lifecycle step uses (#902): origination,
     *         each expiry refresh, an obligation handover and every close.
     * @dev onlyDiamondInternal. Reads the loan for the vault owner
     *      (`loan.lender`), the NFT, the token id and the asset type, so a
     *      caller cannot pass a quantity or token that disagrees with the loan.
     *      An ERC-721 rental goes to {VaipakamVaultImplementation.setUser},
     *      the token's single slot (forwarded to IERC4907 when supported). An
     *      ERC-1155 rental goes to {VaipakamVaultImplementation.setRental1155}
     *      as its own row keyed by `loanId` with the loan's `quantity`, so
     *      concurrent rentals of the same token from one vault coexist and
     *      closing one leaves the others' rights in place. `renter == 0`
     *      revokes this rental only. A lender vault stamped below
     *      `currentVaultVersion` is first upgraded to the current template
     *      (the same step {upgradeUserVault} lets anyone take), so a vault
     *      left on a pre-#902 implementation cannot block a rental's accept or
     *      close. Reverts `NotRentalLoan` for an ERC-20
     *      loan, `NoVault` if the lender has no vault, or bubbles the vault's
     *      revert (else `ProxyCallFailed("Set rental user failed")`), which
     *      includes the vault's `TooManyConcurrentRentals` when a new ERC-1155
     *      rental would pass its per-token bound. Emits {VaultRentalUpdated}
     *      with `loanId` and the post-update aggregate.
     * @param loanId  The rental loan.
     * @param renter  The renter to record, or zero to revoke this rental.
     * @param expires When the renter's rights end (ignored on a revoke).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultSetRentalUser(
        uint256 loanId,
        address renter,
        uint64 expires
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.assetType == LibVaipakam.AssetType.ERC20) revert NotRentalLoan();
        address lender = loan.lender;
        address proxy = s.userVaipakamVaults[lender];
        if (proxy == address(0)) revert NoVault();
        // A vault on an older implementation is brought to the current one
        // first, so no rental step (a close included) depends on its lender
        // having upgraded since the facets were refreshed. A vault its owner
        // PINNED is left on the implementation the owner chose: only the
        // owner upgrades a pinned vault, and the rental step runs on it.
        if (
            s.vaultVersion[lender] < s.currentVaultVersion
                && s.vaultPinnedImplementation[lender] == address(0)
        ) {
            _upgradeVault(s, lender, proxy);
        }
        address nftContract = loan.principalAsset;
        uint256 tokenId = loan.tokenId;

        uint256 quantity;
        bytes memory vaultCall;
        if (loan.assetType == LibVaipakam.AssetType.ERC1155) {
            quantity = renter == address(0) ? 0 : loan.quantity;
            vaultCall = abi.encodeWithSelector(
                VaipakamVaultImplementation.setRental1155.selector,
                nftContract,
                tokenId,
                loanId,
                renter,
                expires,
                quantity
            );
        } else {
            quantity = renter == address(0) ? 0 : 1;
            vaultCall = abi.encodeWithSelector(
                VaipakamVaultImplementation.setUser.selector,
                nftContract,
                tokenId,
                renter,
                expires
            );
        }
        (bool success, bytes memory returnData) = proxy.call(vaultCall);
        if (!success) {
            // Decode revert reason if available
            if (returnData.length > 0) {
                assembly {
                    let returndata_size := mload(returnData)
                    revert(add(32, returnData), returndata_size)
                }
            } else {
                revert ProxyCallFailed("Set rental user failed");
            }
        }
        (uint256 aggQty, uint64 minExp) = _readAggregate(proxy, nftContract, tokenId);
        emit VaultRentalUpdated(
            lender,
            nftContract,
            tokenId,
            loanId,
            renter,
            expires,
            quantity,
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
