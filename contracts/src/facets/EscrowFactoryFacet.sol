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
contract EscrowFactoryFacet is DiamondAccessControl {
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
