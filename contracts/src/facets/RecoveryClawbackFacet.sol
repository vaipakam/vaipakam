// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibPriceGuard} from "../libraries/LibPriceGuard.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {VaultOutflowTypes, OutflowReason} from "../vault/VaultOutflowTypes.sol";

/**
 * @title  RecoveryClawbackFacet
 * @author Vaipakam Developer Team
 * @notice #3246 part 2 — the Diamond's half of the clawback, the one exit
 *         from a locked protected account
 *         (`docs/DesignsAndPlans/RecoveryAddressClawbackDesign.md`). The
 *         account's own vault decides a clawback (who may trigger it, the
 *         recovery address in force, the recovered state, which never
 *         clears) and then calls {applyClawback}, which moves the named
 *         assets' free balance to that address. A recovered account's later
 *         free balance (a loan repaid, a position settled, an offer's
 *         backing released) follows the same way through the permissionless
 *         {sweepRecovered}.
 * @dev    Every move goes through the one outflow policy in its own class
 *         (`OutflowClass.Recovery`): the policy host reads the recovery
 *         address from the paying vault's record, the vault checks it again
 *         against the same record, and neither the payout queue nor the
 *         outflow brake applies. Only what the owner could withdraw moves
 *         (`VaultDepositoryFacet.withdrawableNow`, the depository rule): a
 *         lien, a claim's custody or an open offer's backing stays until it
 *         is released. A recovery address that is itself a protected account
 *         is paid into its own vault. The trigger never names the recipient.
 *
 *         Pause: refused while the Diamond is paused, unless the escape
 *         route is open (the same rule the escape route and the payout
 *         release follow). A clawback run by a recovery claim (#3756) is
 *         refused while paused even with the escape route open, and until
 *         {CLAIM_OUTAGE_WAIT} after the latest sequencer outage window ended,
 *         so a claim never completes while the owner could not answer it.
 */
contract RecoveryClawbackFacet is DiamondReentrancyGuard {
    /// @notice Most assets one clawback or sweep names.
    uint256 internal constant MAX_ASSETS = 32;

    /// @notice #3756 — the trigger a recovery claim runs with
    ///         (`VaultProtectionBase.TRIGGER_RECOVERY_CLAIM`).
    uint8 internal constant TRIGGER_RECOVERY_CLAIM = 3;

    /// @notice #3756 — how long after the price guard's latest sequencer
    ///         outage window ended a recovery claim may run
    ///         (`RecoveryClaimDesign.md` 4.5). The window already ends after
    ///         the guard's own grace, so the wait favours the owner.
    uint256 internal constant CLAIM_OUTAGE_WAIT = 24 hours;

    /**
     * @notice `account` was clawed back to `recovery`: each asset listed and
     *         what of it arrived there (0 = none was free). Emitted beside the
     *         vault's `AccountRecovered` (first clawback only) and one
     *         `VaultOutflow` per asset moved, reason CLAWBACK.
     * @param by   The key that triggered it.
     * @param role 0 = the owner, 1 = a signer, 3 = the recovery address
     *             running a matured recovery claim (`VaultProtectionBase.TRIGGER_*`).
     * @custom:event-category state-change/vault-mutation
     */
    event AccountClawedBack(
        address indexed account,
        address indexed recovery,
        address indexed by,
        uint8 role,
        VaultOutflowTypes.ClawbackAsset[] assets,
        uint256[] amounts
    );

    /**
     * @notice A recovered account's free balance was swept on to its recovery
     *         address (a payout that reached the account after its clawback),
     *         by `by`. One `VaultOutflow` per asset moved, reason
     *         RECOVERY_SWEEP.
     * @custom:event-category state-change/vault-mutation
     */
    event RecoveredBalanceSwept(
        address indexed account,
        address indexed recovery,
        address indexed by,
        VaultOutflowTypes.ClawbackAsset[] assets,
        uint256[] amounts
    );

    /// @notice Only the account's own vault applies its clawback.
    error NotAccountVault(address account, address caller);
    /// @notice The account has not been clawed back.
    error AccountNotRecovered(address account);
    /// @notice A sweep found nothing free to move.
    error NothingToSweep(address account);
    /// @notice More assets than {MAX_ASSETS}.
    error TooManyAssets(uint256 count, uint256 max);
    /// @notice The account's record names no recovery address in force.
    error NoRecoveryAddress(address account);
    /// @notice #3756 — a recovery claim's run waits until `until`, 24 hours
    ///         after the latest sequencer outage window ended.
    error ClaimRunAfterOutage(uint256 until);
    /// @notice #3756 — the sequencer outage window could not be read, so a
    ///         recovery claim's run is refused (fail closed).
    error ClaimOutageUnreadable();

    /**
     * @notice Move the free balance of `assets` from `account`'s vault to its
     *         recovery address in force. Called by the account's vault, in the
     *         clawback the vault has just authorized and recorded.
     * @param account The account (the vault's creation owner).
     * @param by      The key that triggered the clawback.
     * @param role    Its role (0 owner, 1 signer, 3 recovery claim).
     * @param assets  The assets to move.
     * @dev    A recovery claim's run (role 3) is refused while the platform is
     *         paused, escape window or not, and until {CLAIM_OUTAGE_WAIT}
     *         after the latest sequencer outage; the owner's and the signers'
     *         own clawback is unchanged.
     */
    function applyClawback(
        address account,
        address by,
        uint8 role,
        VaultOutflowTypes.ClawbackAsset[] calldata assets
    ) external nonReentrant {
        address vault = LibVaipakam.storageSlot().userVaipakamVaults[account];
        if (vault == address(0) || msg.sender != vault) revert NotAccountVault(account, msg.sender);
        if (role == TRIGGER_RECOVERY_CLAIM) _requireClaimRunOpen();
        (address recovery, bool recovered) = _recoveryOf(account);
        if (!recovered) revert AccountNotRecovered(account);
        uint256[] memory amounts = _move(account, recovery, assets, OutflowReason.CLAWBACK);
        emit AccountClawedBack(account, recovery, by, role, assets, amounts);
    }

    /**
     * @notice Sweep a recovered account's free balance of `assets` on to its
     *         recovery address in force. Permissionless: it moves only what
     *         the account could withdraw, only from an account already clawed
     *         back, and only to the address its own record names, so it
     *         steers nothing (design ruling 2026-11-18). A keeper pass backs
     *         it.
     */
    function sweepRecovered(address account, VaultOutflowTypes.ClawbackAsset[] calldata assets)
        external
        nonReentrant
    {
        (address recovery, bool recovered) = _recoveryOf(account);
        if (!recovered) revert AccountNotRecovered(account);
        uint256[] memory amounts = _move(account, recovery, assets, OutflowReason.RECOVERY_SWEEP);
        bool any;
        for (uint256 i; i < amounts.length; ++i) {
            if (amounts[i] != 0) any = true;
        }
        if (!any) revert NothingToSweep(account);
        emit RecoveredBalanceSwept(account, recovery, msg.sender, assets, amounts);
    }

    /**
     * @notice What a clawback or a sweep of `account` would move of each of
     *         `assets` now (the depository rule; one for a free ERC-721), the
     *         recovery address in force, and whether the account is
     *         recovered. A view for the account page and the keeper.
     */
    function recoveryMovable(address account, VaultOutflowTypes.ClawbackAsset[] calldata assets)
        external
        view
        returns (uint256[] memory amounts, address recovery, bool recovered)
    {
        (recovery, recovered) = _recoveryOf(account);
        amounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            (amounts[i],) = _movable(account, assets[i]);
        }
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /// @dev #3756 4.5 — a recovery claim runs only while the platform is not
    ///      paused, and not until {CLAIM_OUTAGE_WAIT} after the price guard's
    ///      latest sequencer outage window ended. Fail closed: a guard that
    ///      cannot be reached or read refuses the run. A guard with no
    ///      sequencer feed (an L1) reports no window, and the check passes.
    function _requireClaimRunOpen() private view {
        if (LibPausable.paused()) revert LibPausable.EnforcedPause();
        (bool ok, IPriceGuard g) = LibPriceGuard.tryGuardForRead();
        if (!ok) revert ClaimOutageUnreadable();
        uint256 windowEnd;
        try g.sequencerOutageWindow{gas: LibPriceGuard.GUARD_READ_GAS}() returns (uint256, uint256 e) {
            windowEnd = e;
        } catch {
            revert ClaimOutageUnreadable();
        }
        if (windowEnd != 0 && block.timestamp < windowEnd + CLAIM_OUTAGE_WAIT) {
            revert ClaimRunAfterOutage(windowEnd + CLAIM_OUTAGE_WAIT);
        }
    }

    function _recoveryOf(address account) private view returns (address recovery, bool recovered) {
        (recovery, recovered) = LibProtectedAccount.recoveryOf(account);
    }

    function _move(
        address account,
        address recovery,
        VaultOutflowTypes.ClawbackAsset[] calldata assets,
        uint8 reason
    ) private returns (uint256[] memory amounts) {
        if (LibPausable.paused() && !LibProtectedAccount.escapeOpen()) revert LibPausable.EnforcedPause();
        if (recovery == address(0)) revert NoRecoveryAddress(account);
        if (assets.length > MAX_ASSETS) revert TooManyAssets(assets.length, MAX_ASSETS);
        // Funds out: a barred recovery address receives nothing.
        LibVaipakam.assertRecipientNotBarred(recovery);
        amounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            VaultOutflowTypes.ClawbackAsset calldata a = assets[i];
            (uint256 amount, uint256 tokenId) = _movable(account, a);
            if (amount == 0) continue;
            // Debited like an owner withdrawal: the depository holding is
            // what the account may take out, and this is it leaving.
            LibDepositoryLedger.debit(account, a.asset, tokenId, amount);
            amounts[i] = LibVaultOutflow.toRecovery(account, uint8(a.kind), a.asset, tokenId, amount, reason);
        }
    }

    /// @dev The depository rule (`VaultDepositoryFacet.withdrawableNow`, read
    ///      by self-call so there is one copy): what the owner could
    ///      withdraw now. An ERC-20 has token id 0.
    function _movable(address account, VaultOutflowTypes.ClawbackAsset calldata a)
        private
        view
        returns (uint256 amount, uint256 tokenId)
    {
        tokenId = a.kind == VaultOutflowTypes.AssetKind.ERC20 ? 0 : a.tokenId;
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSignature(
                "withdrawableNow(address,uint8,address,uint256)", account, uint8(a.kind), a.asset, tokenId
            )
        );
        if (!ok || ret.length < 32) return (0, tokenId);
        amount = abi.decode(ret, (uint256));
    }
}
