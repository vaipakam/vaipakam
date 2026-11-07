// src/facets/VaultDepositoryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable, LibPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultBeacon} from "../VaultBeacon.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";

/// @dev The vault deposit and withdraw routes, reached by self-call.
interface IVaultRoutes {
    function vaultDepositERC20(address user, address token, uint256 amount) external;
    function vaultDepositERC721(address user, address from, address nftContract, uint256 tokenId) external;
    function vaultDepositERC1155(address user, address from, address nftContract, uint256 tokenId, uint256 amount)
        external;
    function vaultWithdrawERC20(address user, address token, address recipient, uint256 amount)
        external
        returns (uint256 delivered);
    function vaultWithdrawERC721(address user, address nftContract, uint256 tokenId, address recipient) external;
    function vaultWithdrawERC1155(
        address user,
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external;
    function getOrCreateUserVault(address user) external returns (address proxy);
}

/**
 * @title VaultDepositoryFacet
 * @author Vaipakam Developer Team
 * @notice The vault as plain storage, for every user whether or not they
 *         run protected account mode: deposit, withdraw, adopt an asset that
 *         arrived outside the protocol, disown one, and pin the vault's
 *         implementation.
 * @dev    The withdraw is bounded twice: by the depository ledger
 *         (`LibDepositoryLedger`: what the owner deposited, adopted or was
 *         paid into the vault, less what they withdrew or spent), and by the
 *         free-holding rule the protocol's own payouts use (the tracked
 *         holding minus every lien minus the protected-mode earmark). A
 *         balance a loan, an offer, a claim or a reserve holds never enters
 *         the depository ledger, so it cannot leave through this facet
 *         whether or not it is liened.
 *
 *         Deposits come only from the depositor's own wallet into the
 *         depositor's own vault. An asset that arrives in a vault any other
 *         way is not tracked and cannot leave until its owner ADOPTS it:
 *         declares where it came from, signs the acknowledgement, and passes
 *         the on-chain sanctions screen of that source (a flagged source
 *         bans the vault instead). Adoption credits the tracked ledger and
 *         moves nothing; the asset then leaves only through
 *         {withdrawFromVault}, like any other. This replaces the T-054
 *         recovery, whose exit paid the wallet directly outside every
 *         payout rule (see VaultStuckRecoveryDesign.md, superseded).
 */
contract VaultDepositoryFacet is DiamondReentrancyGuard, DiamondPausable {
    error AmountZero();
    error InvalidAssetKind(uint8 kind);
    error NotUntracked(address asset, uint256 tokenId);
    /// @notice #3204 — `account` has no vault to pin or unpin.
    error NoVaultToPin(address account);

    /// @notice `amount` of `asset` / `tokenId` entered `account`'s vault from
    ///         the account's own wallet.
    /// @custom:event-category state-change/vault-mutation
    event VaultDeposited(address indexed account, address indexed asset, uint8 kind, uint256 tokenId, uint256 amount);
    /// @notice A free asset left `account`'s vault at the owner's request
    ///         (paid at once, or queued when protected mode is on: see
    ///         `PayoutQueued` in the same transaction).
    /// @custom:event-category state-change/vault-mutation
    event VaultWithdrawRequested(
        address indexed account,
        address indexed asset,
        uint8 kind,
        uint256 tokenId,
        uint256 amount,
        address recipient,
        bool queued
    );
    /// @notice An untracked asset in `account`'s vault was adopted: credited
    ///         to the tracked ledger on the owner's declaration of
    ///         `declaredSource`. Nothing moved.
    /// @custom:event-category state-change/vault-mutation
    event UntrackedAdopted(
        address indexed account,
        address indexed asset,
        address indexed declaredSource,
        uint8 kind,
        uint256 tokenId,
        uint256 amount,
        uint256 nonce
    );
    /// @notice An adoption declared a sanctions-flagged source: the vault is
    ///         banned under the sanctions policy until the source is
    ///         de-listed. Nothing was credited and nothing moved.
    /// @custom:event-category informational/admin
    event VaultBannedFromAdoption(
        address indexed account,
        address indexed asset,
        address indexed declaredSource,
        uint256 tokenId,
        uint256 amount
    );
    /// @notice The owner disowned an untracked asset. Event-only.
    /// @custom:event-category state-change/vault-mutation
    event UntrackedDisowned(
        address indexed account,
        address indexed asset,
        uint256 tokenId,
        uint256 observedAmount,
        uint256 blockNumber
    );

    /// @dev EIP-712 domain for the adoption acknowledgement, separate from
    ///      every other domain the Diamond signs under.
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_DOMAIN_NAME_HASH = keccak256("Vaipakam Vault Adoption");
    bytes32 private constant EIP712_DOMAIN_VERSION_HASH = keccak256("1");

    /// @dev The signed acknowledgement, bound to the exact warning text.
    bytes32 private constant ADOPTION_TYPEHASH = keccak256(
        "AdoptionAcknowledgment(address user,address asset,uint8 kind,uint256 tokenId,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
    );

    /// @dev keccak256 of the warning the app shows and the wallet signs.
    bytes32 internal constant ADOPTION_ACK_TEXT_HASH = keccak256(
        bytes(
            "I am declaring that the source address belongs to a wallet I"
            " control or authorized. The asset will be credited to my vault"
            " and will leave it only through an ordinary vault withdrawal."
            " If the source is on the sanctions list, my vault will be locked"
            " under the protocol's sanctions policy until the address is"
            " de-listed."
        )
    );

    // ─── Deposit and withdraw ────────────────────────────────────────────

    /**
     * @notice Deposit an asset from your own wallet into your own vault.
     * @dev    ERC-20: `amount` units, pulled on the Diamond's allowance and
     *         refused unless all of it arrives. ERC-721: `tokenId`, `amount`
     *         ignored (one). ERC-1155: `amount` units of `tokenId`. The
     *         Diamond needs the matching approval. Tier-1. Records the
     *         tracked ledger (and the VPFI fee tier for VPFI).
     * @param kind    `AssetType` as a uint8.
     */
    function depositToVault(uint8 kind, address asset, uint256 tokenId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam._assertNotSanctioned(msg.sender);
        // A retired wallet funds nothing: what it deposited would be its
        // controller's to withdraw, never its own.
        LibProtectedAccount.requireManager(msg.sender);
        IVaultRoutes routes = IVaultRoutes(address(this));
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) {
            if (amount == 0) revert AmountZero();
            tokenId = 0;
            routes.vaultDepositERC20(msg.sender, asset, amount);
        } else if (kind == uint8(LibVaipakam.AssetType.ERC721)) {
            amount = 1;
            routes.vaultDepositERC721(msg.sender, msg.sender, asset, tokenId);
        } else if (kind == uint8(LibVaipakam.AssetType.ERC1155)) {
            if (amount == 0) revert AmountZero();
            routes.vaultDepositERC1155(msg.sender, msg.sender, asset, tokenId, amount);
        } else {
            revert InvalidAssetKind(kind);
        }
        LibDepositoryLedger.credit(msg.sender, asset, tokenId, amount);
        emit VaultDeposited(msg.sender, asset, kind, tokenId, amount);
    }

    /**
     * @notice Withdraw an asset that is yours from `account`'s vault to
     *         `recipient`.
     * @dev    Caller: the account's own wallet, or, for a retired protected
     *         account, its controller. Bounded by {withdrawableNow}: the
     *         depository holding, never more than the free holding (tracked
     *         minus liens minus earmark). Anything a loan, offer, claim,
     *         intent or reserve holds is refused. Without protected mode the asset is paid at once to
     *         any `recipient`. With it, the payout is QUEUED: `recipient`
     *         must be the manager wallet or an allowlisted destination, the
     *         account must not be locked, and the asset leaves after the delay
     *         through `VaultPayoutFacet.releasePayout`. Not pause-gated for a
     *         protected account during an open escape window, so its owner can
     *         still queue. Tier-1.
     * @return queuedId The pending payout id, or zero when paid at once.
     */
    function withdrawFromVault(
        address account,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external nonReentrant returns (uint256 queuedId) {
        if (
            LibPausable.paused()
                && !(LibProtectedAccount.isEnabled(account)
                    && LibProtectedAccount.escapeOpen())
        ) revert LibPausable.EnforcedPause();
        LibProtectedAccount.requireManager(account);
        LibVaipakam._assertNotSanctioned(msg.sender);
        // Funds out to a caller-chosen address: the recipient is screened
        // too, whether it is paid now or queued (a queued payout is
        // screened again at release).
        LibVaipakam.assertRecipientNotBarred(recipient);
        if (kind > uint8(LibVaipakam.AssetType.ERC1155)) revert InvalidAssetKind(kind);
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) tokenId = 0;
        if (kind == uint8(LibVaipakam.AssetType.ERC721)) amount = 1;
        if (amount == 0) revert AmountZero();
        {
            uint256 free = withdrawableNow(account, kind, asset, tokenId);
            if (amount > free) revert LibProtectedAccount.AmountExceedsFree(amount, free);
        }
        // Debited when asked for, paid or queued: a queued payout that is
        // later cancelled is credited back (`LibProtectedAccount.cancelPayout`).
        LibDepositoryLedger.debit(account, asset, tokenId, amount);
        if (LibProtectedAccount.isEnabled(account)) {
            queuedId = LibProtectedAccount.queuePayout(account, kind, asset, tokenId, amount, recipient);
            emit VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, true);
            return queuedId;
        }
        IVaultRoutes routes = IVaultRoutes(address(this));
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) {
            routes.vaultWithdrawERC20(account, asset, recipient, amount);
        } else if (kind == uint8(LibVaipakam.AssetType.ERC721)) {
            routes.vaultWithdrawERC721(account, asset, tokenId, recipient);
        } else {
            routes.vaultWithdrawERC1155(account, asset, tokenId, amount, recipient);
        }
        emit VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, false);
    }

    // ─── Adopt and disown ────────────────────────────────────────────────

    /**
     * @notice Adopt an asset that reached your vault outside the protocol
     *         (a plain transfer from your wallet or an exchange, a
     *         hook-skipping mint): declare its source, sign the
     *         acknowledgement, and have it credited to your tracked holding.
     * @dev    Nothing moves: the asset is already in the vault. The cap is
     *         the untracked part only (chain balance minus tracked; for an
     *         ERC-721, a token the vault owns and the ledger does not), so an
     *         adoption can never reach a protocol-managed balance. The
     *         declared source is screened on-chain and fail-closed: oracle
     *         unset or failing refuses; a flagged source BANS the vault under
     *         the sanctions policy (recorded, not reverted, so the ban
     *         persists) and credits nothing. Replay-protected by a nonce and
     *         a deadline. Tier-1.
     * @param kind           `AssetType` as a uint8.
     * @param asset          The token.
     * @param tokenId        Zero for an ERC-20.
     * @param amount         Units (one for an ERC-721).
     * @param declaredSource Where the caller says the asset came from.
     * @param deadline       Signature deadline.
     * @param signature      EIP-712 signature by the caller over the
     *                       acknowledgement (see {adoptionDigest}).
     */
    function adoptUntracked(
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address declaredSource,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam._assertNotSanctioned(msg.sender);
        // A replaced wallet lost every right over its account, adoption
        // included (an adoption from a flagged source would ban the vault).
        LibProtectedAccount.requireManager(msg.sender);
        if (kind > uint8(LibVaipakam.AssetType.ERC1155)) revert InvalidAssetKind(kind);
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) tokenId = 0;
        if (kind == uint8(LibVaipakam.AssetType.ERC721)) amount = 1;
        if (amount == 0) revert IVaipakamErrors.RecoveryAmountZero();
        if (block.timestamp > deadline) revert IVaipakamErrors.RecoveryDeadlineExpired();

        uint256 nonce = s.recoveryNonce[msg.sender];
        bytes32 digest = adoptionDigest(msg.sender, kind, asset, tokenId, declaredSource, amount, nonce, deadline);
        if (ECDSA.recover(digest, signature) != msg.sender) revert IVaipakamErrors.RecoverySignatureInvalid();

        if (s.userVaipakamVaults[msg.sender] == address(0)) revert IVaipakamErrors.RecoveryUserHasNoVault();
        if (amount > untrackedHolding(msg.sender, kind, asset, tokenId)) {
            revert IVaipakamErrors.RecoveryAmountExceedsUnsolicited();
        }

        address oracle = s.sanctionsOracle;
        if (oracle == address(0)) revert IVaipakamErrors.SanctionsOracleUnavailable();
        bool sourceFlagged;
        try ISanctionsList(oracle).isSanctioned(declaredSource) returns (bool flagged) {
            sourceFlagged = flagged;
        } catch {
            revert IVaipakamErrors.SanctionsOracleUnavailable();
        }
        unchecked {
            s.recoveryNonce[msg.sender] = nonce + 1;
        }
        if (sourceFlagged) {
            // Returns rather than reverts so the ban persists. Registered in
            // the confirmed-flagged registry too, from this authoritative
            // read, so a later oracle outage cannot let the holder move a
            // position (#1123).
            s.vaultBannedSource[msg.sender] = declaredSource;
            s.sanctionsConfirmedFlagged[msg.sender] = true;
            emit VaultBannedFromAdoption(msg.sender, asset, declaredSource, tokenId, amount);
            return;
        }
        LibVaipakam.recordVaultDeposit(msg.sender, asset, tokenId, amount);
        LibDepositoryLedger.credit(msg.sender, asset, tokenId, amount);
        emit UntrackedAdopted(msg.sender, asset, declaredSource, kind, tokenId, amount, nonce);
    }

    /**
     * @notice Publicly disown an untracked asset in your vault, without
     *         adopting it. Event-only; nothing changes or moves. Tier-2: a
     *         banned vault may still disown.
     */
    function disownUntracked(uint8 kind, address asset, uint256 tokenId) external {
        if (LibVaipakam.storageSlot().userVaipakamVaults[msg.sender] == address(0)) {
            revert IVaipakamErrors.RecoveryUserHasNoVault();
        }
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) tokenId = 0;
        uint256 observed = untrackedHolding(msg.sender, kind, asset, tokenId);
        emit UntrackedDisowned(msg.sender, asset, tokenId, observed, block.number);
    }

    // ─── Version pin (#3204) ─────────────────────────────────────────────

    /**
     * @notice Request pinning your vault to version `id` of the vault code:
     *         your vault then runs that version until you change the pin, or
     *         until governance revokes it. Caller: the vault's manager.
     * @dev    The VaultBeacon holds the pin, verifies `signature` (the vault
     *         owner's, over vault, id and the beacon's nonce) against the
     *         owner wallet the vault recorded, and applies the change at once,
     *         or after the vault's pin delay (raised by protected mode).
     *         Refused here while the account is locked or in a new
     *         controller's cool-down; the beacon's own delay holds regardless.
     */
    function pinVaultVersion(uint256 id, bytes calldata signature) external nonReentrant whenNotPaused {
        LibProtectedAccount.requireManager(msg.sender);
        address vault = IVaultRoutes(address(this)).getOrCreateUserVault(msg.sender);
        _requirePinnable(msg.sender);
        VaultBeacon(LibVaipakam.storageSlot().vaultBeacon).requestPin(vault, id, signature);
    }

    /**
     * @notice Request removing `account`'s vault pin, so the vault runs the
     *         current version again. Caller: the account's manager. Same
     *         beacon rules as {pinVaultVersion}.
     */
    function unpinVaultVersion(address account, bytes calldata signature) external nonReentrant whenNotPaused {
        LibProtectedAccount.requireManager(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.userVaipakamVaults[account];
        if (vault == address(0)) revert NoVaultToPin(account);
        _requirePinnable(account);
        VaultBeacon(s.vaultBeacon).requestUnpin(vault, signature);
    }

    /// @dev A protected account asks for no pin change while locked or during
    ///      a new controller's cool-down. A faulty facet could skip this
    ///      refusal, but never the beacon's delay or a direct cancel there.
    function _requirePinnable(address account) private view {
        LibVaipakam.ProtectedAccount storage a = LibVaipakam.storageSlot().protectedAccount[account];
        if (!a.enabled) return;
        if (block.timestamp < a.cooldownUntil) revert LibProtectedAccount.PrimaryInCooldown(a.cooldownUntil);
        if (a.locked) revert LibProtectedAccount.ProtectedVaultLocked(account);
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /// @notice What of `asset` / `tokenId` in `user`'s vault
    ///         {withdrawFromVault} may take now: the depository holding, never
    ///         more than {freeHolding}.
    function withdrawableNow(address user, uint8 kind, address asset, uint256 tokenId)
        public
        view
        returns (uint256)
    {
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) tokenId = 0;
        return LibDepositoryLedger.withdrawable(user, asset, tokenId, freeHolding(user, kind, asset, tokenId));
    }

    /// @notice `user`'s depository holding of `asset` / `tokenId`: what they
    ///         deposited, adopted or were paid into the vault, less what they
    ///         withdrew or spent from it (see `LibDepositoryLedger`). Part of
    ///         it may be committed for now (an earmarked payout, a vault-backed
    ///         offer); {withdrawableNow} is what may leave.
    function getDepositoryHolding(address user, address asset, uint256 tokenId) external view returns (uint256) {
        return LibDepositoryLedger.holding(user, asset, tokenId);
    }

    /// @notice The user `vault` was created for, or zero if `vault` is not a
    ///         Vaipakam vault. A vault reads it to accept an NFT delivered by
    ///         another Vaipakam vault (only the Diamond can make a vault move
    ///         anything, so such a delivery is always a protocol move).
    function getVaultOwner(address vault) external view returns (address user) {
        return LibVaipakam.storageSlot().vaultUserOf[vault];
    }

    /// @notice A page of the asset contracts ever credited to `user`'s
    ///         depository holding (deposits, adoptions, payments into the
    ///         vault), in first-credit order, and the list's length. Lets the
    ///         app find a deposited asset that no loan or offer names. An
    ///         asset stays listed after its holding returns to zero; read the
    ///         holding for what is there now. The list names the contract
    ///         only, not an NFT's token ids.
    function getDepositoryAssets(address user, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 total)
    {
        return LibDepositoryLedger.assets(user, offset, limit);
    }

    /// @notice What of `asset` / `tokenId` in `user`'s vault is not held by a
    ///         lien or an earmark: the tracked holding (never more than the
    ///         vault holds) minus liens minus earmark. It counts balances the
    ///         protocol keeps there for a loan, offer or claim without a lien,
    ///         so it is an upper bound, not what the owner may withdraw (that
    ///         is {withdrawableNow}).
    function freeHolding(address user, uint8 kind, address asset, uint256 tokenId) public view returns (uint256) {
        uint256 tracked = LibVaipakam.trackedHolding(user, asset, tokenId);
        uint256 held = _chainHolding(user, kind, asset, tokenId);
        return LibEncumbrance.freeBalance(user, asset, tokenId, tracked < held ? tracked : held);
    }

    /// @notice What of `asset` / `tokenId` sits in `user`'s vault outside the
    ///         tracked ledger (adoptable or disownable).
    function untrackedHolding(address user, uint8 kind, address asset, uint256 tokenId)
        public
        view
        returns (uint256)
    {
        uint256 held = _chainHolding(user, kind, asset, tokenId);
        uint256 tracked = LibVaipakam.trackedHolding(user, asset, tokenId);
        return held > tracked ? held - tracked : 0;
    }

    function _chainHolding(address user, uint8 kind, address asset, uint256 tokenId) private view returns (uint256) {
        address proxy = LibVaipakam.storageSlot().userVaipakamVaults[user];
        if (proxy == address(0)) return 0;
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) return IERC20(asset).balanceOf(proxy);
        if (kind == uint8(LibVaipakam.AssetType.ERC721)) {
            try IERC721(asset).ownerOf(tokenId) returns (address o) {
                return o == proxy ? 1 : 0;
            } catch {
                return 0;
            }
        }
        return IERC1155(asset).balanceOf(proxy, tokenId);
    }

    /// @notice The EIP-712 domain separator of the adoption acknowledgement.
    function adoptionDomainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, EIP712_DOMAIN_NAME_HASH, EIP712_DOMAIN_VERSION_HASH, block.chainid, address(this)
            )
        );
    }

    /// @notice keccak256 of the warning text the acknowledgement binds.
    function adoptionAckTextHash() external pure returns (bytes32) {
        return ADOPTION_ACK_TEXT_HASH;
    }

    /// @notice `user`'s next adoption nonce.
    function adoptionNonce(address user) external view returns (uint256) {
        return LibVaipakam.storageSlot().recoveryNonce[user];
    }

    /// @notice The sanctioned source that banned `user`'s vault through an
    ///         adoption (zero if none). The ban lifts when it is de-listed.
    function vaultBannedSource(address user) external view returns (address) {
        return LibVaipakam.storageSlot().vaultBannedSource[user];
    }

    /// @notice The digest `user` signs to adopt.
    function adoptionDigest(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        address declaredSource,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ADOPTION_TYPEHASH,
                user,
                asset,
                kind,
                tokenId,
                declaredSource,
                amount,
                nonce,
                deadline,
                ADOPTION_ACK_TEXT_HASH
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", adoptionDomainSeparator(), structHash));
    }
}
