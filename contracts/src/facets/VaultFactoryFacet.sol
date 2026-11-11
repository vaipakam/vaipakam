// src/facets/VaultFactoryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";

import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {VaultBeacon} from "../VaultBeacon.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";


/**
 * @title VaultFactoryFacet
 * @author Vaipakam Developer Team
 * @notice This facet manages the creation, initialization, and upgrade of per-user UUPS vault proxies in the Vaipakam platform.
 * @dev This contract is part of the Diamond Standard (EIP-2535) and uses shared storage from LibVaipakam.
 *      It deploys one BeaconProxy per user; every proxy resolves its code through the VaultBeacon (#3204).
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

    /// @notice #3204 — the VaultBeacon new vaults point at was recorded.
    /// @custom:event-category informational/config
    event VaultBeaconSet(address indexed beacon);


    // Custom errors for better gas efficiency and clarity.
    error AlreadyInitialized();
    error UpgradeFailed();
    error ProxyCallFailed(string reason);
    /// @notice #3539 — an ERC-721 transfer into `vault` returned without the
    ///         vault owning `tokenId` afterwards.
    error NftNotDelivered(address asset, uint256 tokenId, address vault);
    /// @notice #3539 — an ERC-1155 transfer into a vault raised its balance by
    ///         `received` instead of the `quantity` asked for.
    error NftShortDelivery(address asset, uint256 tokenId, uint256 quantity, uint256 received);
    error NoVault();
    /// @dev #902 — {vaultSetRentalUser} was asked to set the renter of an
    ///      ERC-20 loan, which rents nothing.
    error NotRentalLoan();
    /// @dev #3204 — the beacon handed to {initializeVaultBeacon} does not
    ///      name this Diamond.
    error VaultBeaconMismatch(address beacon);
    /// @notice #821 — a wind-down close-out tried to deposit a flagged
    ///         recipient's locked share but the recipient has no existing vault,
    ///         and the receive-side exemption refuses to mint one for a
    ///         sanctioned wallet. Unreachable for real loan parties (they all
    ///         have a vault by close-out time); a defensive backstop.
    error SanctionedRecipientHasNoVault(address recipient);

    /**
     * @notice Records the VaultBeacon every user vault resolves its code
     *         through (#3204). One-shot, at deploy.
     * @dev VAULT_ADMIN_ROLE-only. The beacon must name this Diamond. Which
     *      code a vault runs is decided by the beacon (Timelock-owned, not
     *      upgradeable), never by Diamond storage: this pointer only tells
     *      the factory which beacon new vaults point at.
     */
    function initializeVaultBeacon(address beacon) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.vaultBeacon != address(0)) revert AlreadyInitialized();
        if (beacon.code.length == 0 || VaultBeacon(beacon).diamond() != address(this)) {
            revert VaultBeaconMismatch(beacon);
        }
        s.vaultBeacon = beacon;
        s.diamondAddress = address(this);
        emit VaultBeaconSet(beacon);
    }

    /**
     * @notice Gets or creates a user's vault proxy.
     * @dev Deploys a new BeaconProxy (pointing at the VaultBeacon) if none exists.
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
            // #3204 — a BeaconProxy: on every call it asks the VaultBeacon
            // which code to run, so one timelocked change reaches every vault.
            // The vault records its owner wallet here, once; the beacon checks
            // every pin signature against that record.
            bytes memory _data = abi.encodeCall(
                VaipakamVaultImplementation.initialize,
                (s.diamondAddress, user)
            );
            proxy = address(new BeaconProxy(s.vaultBeacon, _data));
            s.userVaipakamVaults[user] = proxy;
            s.vaultUserOf[proxy] = user;
            emit UserVaultCreated(user, proxy);
        }
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
     * @notice #3178 — a CLOSE-OUT's payer-funded delivery into `user`'s vault
     *         (an early close's lender due): {vaultDepositERC20From} with
     *         `user`'s vault resolved as a RECEIVER, inside the receive-side
     *         window, so neither `user`'s vault version nor a sanctions flag on
     *         `user` can block the payer's close-out. A flagged `user`'s share
     *         is announced as locked proceeds, as every other close-out
     *         delivery's is.
     * @dev    onlyDiamondInternal. Kept apart from {vaultDepositERC20From},
     *         which also funds a party's OWN position (a collateral top-up)
     *         that must still pass the gate. Refused unless all of `amount`
     *         arrived.
     * @param loanId The loan whose close-out this is (named on the lock event).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function vaultDeliverERC20From(
        address payer,
        address user,
        address token,
        uint256 amount,
        uint256 loanId
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.sanctionedDepositExemptUser = user;
        address proxy = getOrCreateUserVault(user);
        s.sanctionedDepositExemptUser = address(0);
        LibDelivery.pullExact(token, payer, proxy, amount);
        LibVaipakam.recordVaultDeposit(user, token, amount);
        if (LibVaipakam.isSanctionedAddress(user)) {
            emit LibSanctionedLock.SanctionedProceedsLocked(loanId, user, token, amount);
        }
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
     *         {getOrCreateUserVault}, which mints vaults. A payout path must
     *         not mint a vault as a side effect, and callers (the reward
     *         claim) treat any revert here as "fall back to wallet delivery"
     *         — so `NoVault` below is the fallback trigger, not
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
        // A reward paid into the vault is the owner's, free: it joins the
        // depository holding, so the owner (or a replacement controller)
        // can withdraw it like a deposit.
        LibDepositoryLedger.credit(user, token, 0, amount);
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
     *         vault, a row that cannot cover its
     *         component, a release either end cannot account for, the record,
     *         the tier refresh — rolls back the row debits AND the holder release
     *         before the caller's wallet fallback pays. Exactly one
     *         destination is ever paid. Same fallback triggers as the sibling
     *         (`NoVault` is not a failure); same
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
        LibDepositoryLedger.credit(user, token, 0, amount);
    }

    /// @dev READ-ONLY resolution of an EXISTING vault (`NoVault` otherwise),
    ///      with no sanctions screen. Shared by both protocol-payout credits
    ///      (see {vaultCreditFromDiamondERC20} for why it never mints) and,
    ///      since #1566 S3e, the swap fill's {recordVaultOutflowERC20}.
    function _currentVault(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (address proxy) {
        proxy = s.userVaipakamVaults[user];
        if (proxy == address(0)) revert NoVault();
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
        if (IERC721(nftContract).ownerOf(tokenId) != proxy) revert NftNotDelivered(nftContract, tokenId, proxy);
        LibVaipakam.recordVaultDeposit(user, nftContract, tokenId, 1);
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
        uint256 received = IERC1155(nftContract).balanceOf(proxy, tokenId) - before;
        if (received != amount) revert NftShortDelivery(nftContract, tokenId, amount, received);
        LibVaipakam.recordVaultDeposit(user, nftContract, tokenId, amount);
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
     *      revokes this rental only. Every vault resolves its code through
     *      the VaultBeacon (#3204), so no per-vault catch-up upgrade is
     *      needed here. Reverts `NotRentalLoan` for an ERC-20
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
     *         storage at {initializeVaultBeacon} time.
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
     * @notice The VaultBeacon every user vault resolves its code through
     *         (#3204). Which version a vault runs, whether it is pinned and
     *         whether a code change is pending are read from the beacon itself.
     */
    function getVaultBeacon() external view returns (address) {
        return LibVaipakam.storageSlot().vaultBeacon;
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
