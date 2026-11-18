// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibIntegrator} from "../libraries/LibIntegrator.sol";
import {LibFeeShares} from "../libraries/LibFeeShares.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  IntegratorFacet
 * @author Vaipakam Developer Team
 * @notice #3682 / #3720 — the integrator registry and the delivery of an
 *         integrator's share of the initiation fee
 *         (`docs/DesignsAndPlans/IntegratorFeeShareDesign.md`).
 *
 *         A front end the platform has registered as an integrator may be
 *         named by a borrower's own action. When that loan opens, the
 *         integrator receives a bounded part of the initiation fee's part
 *         above the treasury floor, into the vault of its payout account. The
 *         borrower's fee is the same with or without an integrator.
 *
 *         - Adding or changing an entry, restoring a suspended one and
 *           removing one are ADMIN steps (the Timelock, so they wait its
 *           delay). The guardian (PAUSER_ROLE) suspends at once.
 *         - "Registered" means it earns a share and accepted the terms. It is
 *           never a statement that an integrator is approved, verified or
 *           safe.
 *         - An integrator's status never blocks a user: an unknown, removed,
 *           suspended or flagged integrator is paid nothing and its share
 *           goes to the reserve.
 *         - Nothing is held for an integrator in the Diamond at any time.
 * @dev    The share is sized in the acceptance charge
 *         (`OfferAcceptFeeFacet`) through {LibIntegrator} and
 *         {LibFeeShares}; the delivery runs here, behind
 *         {deliverIntegratorShare}, which the charge calls as one isolated
 *         step allowed to fail alone.
 */
contract IntegratorFacet is DiamondAccessControl, IVaipakamErrors {
    /// @notice An entry was added or changed. `oldName` is empty on an add.
    event IntegratorSet(
        address indexed integrator, address indexed payout, uint16 rateBps, string oldName, string newName
    );
    /// @notice An entry's declared contracts were replaced.
    event IntegratorContractsDeclared(address indexed integrator, address[] declared);
    /// @notice The guardian suspended an entry: it is paid nothing until restored.
    event IntegratorSuspended(address indexed integrator);
    /// @notice A suspended entry was restored after the delay.
    event IntegratorRestored(address indexed integrator);
    /// @notice An entry was removed.
    event IntegratorRemoved(address indexed integrator);
    /// @notice #3719 — the owner of a standing lender intent named the
    ///         integrator it set the intent through. Attribution only: a
    ///         lender's action earns no share.
    event LenderIntentIntegratorNamed(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset,
        uint8 slot,
        address integrator
    );
    /// @notice The default rate changed (0 restores the built-in default).
    event IntegratorDefaultRateSet(uint256 rateBps);

    error IntegratorInvalid(address integrator);
    error IntegratorNameInvalid();
    error IntegratorNameTaken(address holder);
    error IntegratorAddressTaken(address account, address holder);
    error IntegratorRateInvalid(uint256 rateBps);
    error IntegratorNotRegistered(address integrator);
    error IntegratorNotSuspended(address integrator);
    error LenderIntentNotActive();

    /// @notice One entry as the public list reports it.
    struct IntegratorView {
        address integrator;
        address payout;
        string name;
        LibVaipakam.IntegratorStatus status;
        uint256 rateBps;
        uint32 loansBrought;
        uint32 loansWarned;
        uint32 loansEarlyDefaulted;
        address[] declared;
    }

    // ── Governance ───────────────────────────────────────────────────────

    /**
     * @notice Add integrator `integrator`, or change its entry. A new entry
     *         is active; a change keeps the entry's status, so it never
     *         restores a suspended one.
     * @param integrator The id a borrower names.
     * @param payout     The account whose platform vault receives the share.
     * @param rateBps    Its rate, in basis points of the fee's above-floor
     *                   part; 0 = the default. At most 50%.
     * @param name       1 to 32 printable ASCII characters, unique without
     *                   regard to letter case.
     * @param declared   The contracts it operates. A loan whose borrower is
     *                   the id, the payout account or one of these pays it
     *                   nothing. None may belong to another integrator.
     */
    function setIntegrator(
        address integrator,
        address payout,
        uint16 rateBps,
        string calldata name,
        address[] calldata declared
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (integrator == address(0) || payout == address(0) || integrator == address(this) || payout == address(this))
        {
            revert IntegratorInvalid(integrator);
        }
        if (rateBps > LibVaipakam.INTEGRATOR_SHARE_BPS_MAX) revert IntegratorRateInvalid(rateBps);
        bytes32 nameKey = _nameKey(name);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntegratorEntry storage e = s.integrators[integrator];

        address nameHolder = s.integratorByName[nameKey];
        if (nameHolder != address(0) && nameHolder != integrator) revert IntegratorNameTaken(nameHolder);

        string memory oldName = e.name;
        if (e.status == LibVaipakam.IntegratorStatus.None) {
            e.status = LibVaipakam.IntegratorStatus.Active;
            s.integratorIds.push(integrator);
        } else {
            delete s.integratorByName[_nameKey(oldName)];
            _unbindAddresses(s, integrator, e);
        }

        e.payout = payout;
        e.rateBps = rateBps;
        e.name = name;
        s.integratorByName[nameKey] = integrator;

        _bind(s, integrator, integrator);
        _bind(s, payout, integrator);
        delete e.declared;
        for (uint256 i; i < declared.length; ++i) {
            if (declared[i] == address(0)) revert IntegratorInvalid(declared[i]);
            _bind(s, declared[i], integrator);
            e.declared.push(declared[i]);
        }
        emit IntegratorSet(integrator, payout, rateBps, oldName, name);
        emit IntegratorContractsDeclared(integrator, declared);
    }

    /// @notice Remove an entry. Its name and addresses are freed.
    function removeIntegrator(address integrator) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntegratorEntry storage e = s.integrators[integrator];
        if (e.status == LibVaipakam.IntegratorStatus.None) revert IntegratorNotRegistered(integrator);
        delete s.integratorByName[_nameKey(e.name)];
        _unbindAddresses(s, integrator, e);
        address[] storage ids = s.integratorIds;
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == integrator) {
                ids[i] = ids[ids.length - 1];
                ids.pop();
                break;
            }
        }
        delete s.integrators[integrator];
        emit IntegratorRemoved(integrator);
    }

    /// @notice The guardian suspends an entry at once: it is paid nothing,
    ///         and keeps its name and record, until restored.
    function suspendIntegrator(address integrator) external onlyRole(LibAccessControl.PAUSER_ROLE) {
        LibVaipakam.IntegratorEntry storage e = LibVaipakam.storageSlot().integrators[integrator];
        if (e.status == LibVaipakam.IntegratorStatus.None) revert IntegratorNotRegistered(integrator);
        e.status = LibVaipakam.IntegratorStatus.Suspended;
        emit IntegratorSuspended(integrator);
    }

    /// @notice Restore a suspended entry (an ADMIN step, so it waits the delay).
    function restoreIntegrator(address integrator) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.IntegratorEntry storage e = LibVaipakam.storageSlot().integrators[integrator];
        if (e.status != LibVaipakam.IntegratorStatus.Suspended) revert IntegratorNotSuspended(integrator);
        e.status = LibVaipakam.IntegratorStatus.Active;
        emit IntegratorRestored(integrator);
    }

    /// @notice Set the default rate for entries carrying none (0 restores
    ///         10%). At most 50%. Applies to loans opened after it.
    function setIntegratorDefaultRate(uint16 rateBps) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (rateBps > LibVaipakam.INTEGRATOR_SHARE_BPS_MAX) revert IntegratorRateInvalid(rateBps);
        LibVaipakam.storageSlot().feeShareCfg.integratorDefaultBps = rateBps;
        emit IntegratorDefaultRateSet(rateBps);
    }

    // ── Attribution ──────────────────────────────────────────────────────

    /**
     * @notice #3719 — name the integrator through which `owner` set its
     *         standing lender intent, so the platform's alert can name the
     *         door. Pure attribution: a lender's action never earns a share,
     *         and nothing reads it to set a rate, an amount or a recipient.
     *         Called by the intent's owner or the account's current manager,
     *         in the same batch as the intent's set. `integrator` must be
     *         registered, or address(0) to state that none was used.
     */
    function nameLenderIntentIntegrator(
        address owner,
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        address integrator
    ) external {
        // The owner wallet, or its controller once a replacement retired it.
        LibProtectedAccount.requireManager(owner);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.lenderIntent[owner][lendingAsset][collateralAsset][slot].active) revert LenderIntentNotActive();
        if (integrator != address(0) && s.integrators[integrator].status == LibVaipakam.IntegratorStatus.None) {
            revert IntegratorNotRegistered(integrator);
        }
        emit LenderIntentIntegratorNamed(owner, lendingAsset, collateralAsset, slot, integrator);
    }

    // ── Delivery ─────────────────────────────────────────────────────────

    /**
     * @notice Diamond-internal: deliver `amount` of `asset` from `lender`'s
     *         vault into the vault of integrator `integrator`'s payout
     *         account, for the accept of offer `offerId`. Reverts unless all of
     *         it arrived, so the caller, which runs this as one isolated step,
     *         undoes it and sends the share to the reserve instead.
     */
    function deliverIntegratorShare(address lender, address asset, uint256 amount, address integrator, uint256 offerId)
        external
    {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        uint256 delivered = LibVaultOutflow.toIntegratorShare(lender, asset, amount, integrator, offerId);
        if (delivered != amount) revert TokenDeliveryShort(asset, amount, delivered);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @notice One entry; `status` is None when not registered.
    function getIntegrator(address integrator) external view returns (IntegratorView memory) {
        return _view(integrator);
    }

    /// @notice Every registered entry with its status and record: the list
    ///         anyone can check. A name is not a verification.
    function getIntegrators() external view returns (IntegratorView[] memory list) {
        address[] storage ids = LibVaipakam.storageSlot().integratorIds;
        list = new IntegratorView[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            list[i] = _view(ids[i]);
        }
    }

    /// @notice The integrator, if any, that `account` belongs to (its id,
    ///         payout account or a declared contract).
    function integratorOf(address account) external view returns (address) {
        return LibVaipakam.storageSlot().integratorOfAddress[account];
    }

    /// @notice The platform's own contracts on this chain, so a user or a
    ///         wallet can check whether a contract is the platform's: this
    ///         Diamond, the vault beacon (every user vault runs its code), the
    ///         position NFT and the protocol registry.
    function getPlatformContracts()
        external
        view
        returns (address diamond, address vaultBeacon, address positionNft, address protocolRegistry)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (address(this), s.vaultBeacon, address(LibPositionNFT.core()), s.protocolRegistry);
    }

    /// @notice The share rules in force: the default integrator rate and the
    ///         per-loan ceiling on the parts taken from the fee's above-floor
    ///         part, in basis points.
    function getIntegratorShareSettings() external view returns (uint256 defaultRateBps, uint256 ceilingBps) {
        return (LibIntegrator.defaultRateBps(), LibFeeShares.ceilingBps());
    }

    /// @notice The rate integrator `integrator` would be paid at on a loan
    ///         borrowed by `borrower` now, and 0 with the reason it is not
    ///         paid (an unregistered, suspended or flagged integrator, or a
    ///         borrower that is one of its addresses). The ceiling is applied
    ///         per loan, at acceptance.
    function integratorRateFor(address integrator, address borrower)
        external
        view
        returns (uint256 rateBps, LibIntegrator.Refusal refusal)
    {
        return LibIntegrator.rateFor(integrator, borrower);
    }

    // ── Internals ────────────────────────────────────────────────────────

    function _view(address integrator) private view returns (IntegratorView memory v) {
        LibVaipakam.IntegratorEntry storage e = LibVaipakam.storageSlot().integrators[integrator];
        v.integrator = integrator;
        v.payout = e.payout;
        v.name = e.name;
        v.status = e.status;
        v.rateBps = e.status == LibVaipakam.IntegratorStatus.None ? 0 : LibIntegrator.rateOf(e);
        v.loansBrought = e.loansBrought;
        v.loansWarned = e.loansWarned;
        v.loansEarlyDefaulted = e.loansEarlyDefaulted;
        v.declared = e.declared;
    }

    function _bind(LibVaipakam.Storage storage s, address account, address integrator) private {
        address holder = s.integratorOfAddress[account];
        if (holder != address(0) && holder != integrator) revert IntegratorAddressTaken(account, holder);
        s.integratorOfAddress[account] = integrator;
    }

    function _unbindAddresses(LibVaipakam.Storage storage s, address integrator, LibVaipakam.IntegratorEntry storage e)
        private
    {
        delete s.integratorOfAddress[integrator];
        delete s.integratorOfAddress[e.payout];
        for (uint256 i; i < e.declared.length; ++i) {
            delete s.integratorOfAddress[e.declared[i]];
        }
    }

    /// @dev The name's uniqueness key: its lower-case hash. Refuses a name
    ///      outside 1 to 32 printable ASCII characters.
    function _nameKey(string memory name) private pure returns (bytes32) {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 32) revert IntegratorNameInvalid();
        bytes memory lower = new bytes(b.length);
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x20 || c > 0x7e) revert IntegratorNameInvalid();
            lower[i] = (c >= 0x41 && c <= 0x5a) ? bytes1(c + 32) : b[i];
        }
        return keccak256(lower);
    }
}
