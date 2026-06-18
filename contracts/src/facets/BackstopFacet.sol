// src/facets/BackstopFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {BackstopVaultImplementation} from "../BackstopVaultImplementation.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title  BackstopFacet
 * @author Vaipakam Developer Team
 * @notice #399 backstop v0 (Role A — counterparty-of-last-resort). Governs the
 *         single treasury-seeded `BackstopVault` and drives its Role-A auto-fill.
 *         All policy (kill-switches, the on-chain `backstopEligibleAfter` trigger,
 *         treasury seeding, caps) lives here, where storage is directly
 *         accessible; the vault is a thin owner-gated executor of as-self Diamond
 *         calls (owner = this Diamond). Role B (liquidator-of-last-resort) is a
 *         separate PR (#630). See docs/DesignsAndPlans/BackstopVaultV0Design.md.
 */
contract BackstopFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    DiamondAccessControl
{
    using SafeERC20 for IERC20;

    /// @notice The shared backstop-vault implementation was published.
    event BackstopVaultImplementationSet(address indexed implementation);
    /// @notice The single backstop vault was provisioned.
    event BackstopVaultProvisioned(address indexed vault);
    /// @notice A per-asset-pair backstop intent (caps/rate/LTV) was set.
    event BackstopIntentSet(
        address indexed lend,
        address indexed coll,
        uint256 maxExposure,
        uint256 minRateBps
    );
    /// @notice Treasury capital was seeded into a backstop origination intent.
    event BackstopSeeded(
        address indexed lend,
        address indexed coll,
        uint256 amount
    );
    /// @notice Idle backstop capital was returned to treasury.
    event BackstopWithdrawnToTreasury(
        address indexed lend,
        address indexed coll,
        uint256 amount
    );
    /// @notice The backstop auto-filled an unmatched offer.
    event BackstopFilled(
        uint256 indexed offerId,
        uint256 indexed loanId,
        uint256 fillAmount
    );
    /// @notice A backstop loan's proceeds were claimed back to treasury.
    event BackstopLoanClaimed(
        uint256 indexed loanId,
        address indexed asset,
        uint256 recovered
    );
    /// @notice A borrower opted their offer into backstop eligibility.
    event OfferBackstopEligibilitySet(
        uint256 indexed offerId,
        uint64 eligibleAfter
    );

    error BackstopTemplateNotSet();
    error BackstopAlreadyInitialized();
    error BackstopNotProvisioned();
    error BackstopAlreadyProvisioned();
    error TreasuryNotDiamond();
    error TreasuryInsufficient();
    error BackstopIntentInactive();
    error NotBackstopLoan();
    error ZeroAmount();
    error NotOfferCreator();
    error OfferNotBorrowerType();
    error InvalidBackstopDeadline();
    error OfferNotBackstopFillable();
    error BackstopDisabled();
    error UpgradeFailed();

    // ─── Provisioning + impl (VAULT_ADMIN / timelock) ───────────────────────

    /// @notice Publish the shared `BackstopVaultImplementation` (once).
    function initializeBackstopVaultImplementation()
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.backstopVaultTemplate != address(0)) {
            revert BackstopAlreadyInitialized();
        }
        s.backstopVaultTemplate = address(new BackstopVaultImplementation());
        emit BackstopVaultImplementationSet(s.backstopVaultTemplate);
    }

    /// @notice Provision the single backstop vault proxy over the shared impl.
    /// @dev NOT `nonReentrant`: the proxy `initialize` callback runs in the
    ///      Diamond's shared-lock context (mirrors the adapter factory).
    function provisionBackstopVault()
        external
        whenNotPaused
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
        returns (address vault)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.backstopVaultTemplate == address(0)) revert BackstopTemplateNotSet();
        if (s.backstopVault != address(0)) revert BackstopAlreadyProvisioned();
        bytes memory data = abi.encodeCall(
            BackstopVaultImplementation.initialize,
            (s.diamondAddress)
        );
        vault = address(new ERC1967Proxy(s.backstopVaultTemplate, data));
        s.backstopVault = vault;
        emit BackstopVaultProvisioned(vault);
    }

    /// @notice Publish a new backstop-vault impl + migrate the proxy (governance
    ///         upgrades the protocol-owned vault directly — no aggregator-pull).
    function upgradeBackstopVault(address newImplementation)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        if (newImplementation.code.length == 0) revert UpgradeFailed();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.backstopVault == address(0)) revert BackstopNotProvisioned();
        s.backstopVaultTemplate = newImplementation;
        (bool ok, ) = s.backstopVault.call(
            abi.encodeWithSignature(
                "upgradeToAndCall(address,bytes)",
                newImplementation,
                ""
            )
        );
        if (!ok) revert UpgradeFailed();
        emit BackstopVaultImplementationSet(newImplementation);
    }

    // ─── Per-asset intent caps / posted rate (VAULT_ADMIN / timelock) ───────

    /// @notice Register/update a per-asset-pair backstop intent: the governance
    ///         capacity cap (`maxExposure`), posted backstop rate (`minRateBps`),
    ///         and conservative init-LTV ceiling. The vault registers it self-only.
    function setBackstopIntent(
        address lend,
        address coll,
        uint256 maxExposure,
        uint256 minRateBps,
        uint16 maxInitLtvBps,
        uint32 maxDurationDays,
        uint256 minFillAmount
    ) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        address vault = LibVaipakam.getBackstopVault();
        if (vault == address(0)) revert BackstopNotProvisioned();
        BackstopVaultImplementation(vault).setIntent(
            lend,
            coll,
            maxExposure,
            minRateBps,
            maxInitLtvBps,
            maxDurationDays,
            minFillAmount
        );
        emit BackstopIntentSet(lend, coll, maxExposure, minRateBps);
    }

    // ─── Treasury seed / withdraw (VAULT_ADMIN / timelock) ──────────────────

    /// @notice Seed treasury capital into a backstop origination intent.
    /// @dev Dedicated treasury-seed primitive (the design's §3): debit
    ///      `treasuryBalances` → transfer the Diamond-held ERC20 into the backstop
    ///      vault's per-user vault → record the tracked deposit → lien it as intent
    ///      capital. NOT `fundLenderIntent` (which wallet-pulls from msg.sender).
    ///      Requires Diamond-as-treasury + an active intent for the pair.
    function seedBackstopOrigination(
        address lend,
        address coll,
        uint256 amount
    ) external nonReentrant onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        if (!s.lenderIntent[vault][lend][coll].active) {
            revert BackstopIntentInactive();
        }
        uint256 bal = s.treasuryBalances[lend];
        if (bal < amount) revert TreasuryInsufficient();
        s.treasuryBalances[lend] = bal - amount;
        address proxy = VaultFactoryFacet(address(this)).getOrCreateUserVault(
            vault
        );
        IERC20(lend).safeTransfer(proxy, amount);
        LibVaipakam.recordVaultDeposit(vault, lend, amount);
        LibEncumbrance.lienIntentCapital(vault, lend, coll, amount);
        emit BackstopSeeded(lend, coll, amount);
    }

    /// @notice Return idle (un-lent) backstop capital to treasury.
    /// @dev NOT `nonReentrant`: calls the vault, which re-enters the Diamond's
    ///      own `nonReentrant` `withdrawLenderIntentCapital` — the shared Diamond
    ///      lock would collide. That inner function is the real guard (mirrors
    ///      `createAggregatorAdapter`). The `treasuryBalances` credit happens
    ///      after the vault call returns (lock released), with no external call
    ///      in between.
    function withdrawBackstopToTreasury(
        address lend,
        address coll,
        uint256 amount
    ) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        uint256 returned = BackstopVaultImplementation(vault)
            .withdrawIdleToDiamond(lend, coll, amount);
        // Diamond-side record (the vault forwarded the raw tokens to the Diamond).
        if (returned > 0) s.treasuryBalances[lend] += returned;
        emit BackstopWithdrawnToTreasury(lend, coll, returned);
    }

    // ─── Borrower opt-in (offer creator) ────────────────────────────────────

    /// @notice Borrower opt-in: mark `offerId` backstop-eligible after
    ///         `eligibleAfter`. Creator-only. Validated against a future mandatory
    ///         delay + the offer's own expiry + intent-fillability terms — so an
    ///         offer that could never be backstop-filled fails here, not after the
    ///         deadline. Set as an Offer struct field (not via CreateOfferParams).
    function setOfferBackstopEligible(uint256 offerId, uint64 eligibleAfter)
        external
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (o.creator != msg.sender) revert NotOfferCreator();
        if (o.offerType != LibVaipakam.OfferType.Borrower) {
            revert OfferNotBorrowerType();
        }
        // Future deadline past the mandatory floor, strictly before expiry
        // (so a fill has a real window before the offer dies; expiresAt must
        // be set). And intent-fillable (matchIntent rejects otherwise).
        uint256 floor = block.timestamp + LibVaipakam.cfgMinBackstopDelay();
        if (
            eligibleAfter < floor ||
            o.expiresAt == 0 ||
            uint256(eligibleAfter) >= uint256(o.expiresAt) ||
            !o.useFullTermInterest ||
            o.allowsPartialRepay
        ) revert InvalidBackstopDeadline();
        o.backstopEligibleAfter = eligibleAfter;
        emit OfferBackstopEligibilitySet(offerId, eligibleAfter);
    }

    // ─── Role A — auto-fill (permissionless; gates are on-chain facts) ──────

    /// @notice Auto-fill a still-valid-but-unmatched borrower offer the borrower
    ///         opted into, past its `backstopEligibleAfter`. Permissionless: every
    ///         gate is an on-chain fact. The vault (self-only intent) executes
    ///         `matchIntent`, so loan.lender = the backstop.
    /// @dev NOT `nonReentrant`: the vault's `executeFill` re-enters the Diamond's
    ///      own `nonReentrant` `matchIntent` (the real guard) — the shared lock
    ///      would otherwise collide. This wrapper writes no facet state; a
    ///      re-entry would itself hit `matchIntent`'s held lock and revert.
    function backstopFill(uint256 offerId)
        external
        whenNotPaused
        returns (uint256 loanId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            !s.protocolCfg.backstopEnabled || !s.protocolCfg.backstopFillEnabled
        ) revert BackstopDisabled();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        LibVaipakam.Offer storage o = s.offers[offerId];
        // On-chain-provable trigger (§4): borrower offer, opted-in + past the
        // deadline, still valid, not terminal, unfilled remainder, liquid
        // collateral (re-assert §5b).
        if (
            o.offerType != LibVaipakam.OfferType.Borrower ||
            o.backstopEligibleAfter == 0 ||
            block.timestamp < o.backstopEligibleAfter ||
            LibVaipakam.isOfferExpired(o) ||
            o.accepted
        ) revert OfferNotBackstopFillable();
        uint256 remainder = o.amount - o.amountFilled; // borrower offer: single amount
        if (remainder == 0) revert OfferNotBackstopFillable();
        if (
            OracleFacet(address(this)).checkLiquidity(o.collateralAsset) !=
            LibVaipakam.LiquidityStatus.Liquid
        ) revert OfferNotBackstopFillable();
        loanId = BackstopVaultImplementation(vault).executeFill(
            o.lendingAsset,
            o.collateralAsset,
            offerId,
            remainder
        );
        emit BackstopFilled(offerId, loanId, remainder);
    }

    /// @notice Claim a resolved backstop loan's proceeds back to treasury.
    /// @dev Own-loan guarded (`loan.lender == backstopVault`). The vault claims +
    ///      forwards the raw proceeds to the Diamond; this records the treasury
    ///      credit. NOT `nonReentrant`: the vault's `executeClaim` re-enters the
    ///      Diamond's own `nonReentrant` `claimAsLenderWithRetry` (the real guard);
    ///      the `treasuryBalances` credit happens after that returns.
    function backstopClaim(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    ) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        if (s.loans[loanId].lender != vault) revert NotBackstopLoan();
        (address asset, uint256 recovered) = BackstopVaultImplementation(vault)
            .executeClaim(loanId, retryCalls);
        if (recovered > 0 && s.treasury == address(this)) {
            s.treasuryBalances[asset] += recovered;
        }
        emit BackstopLoanClaimed(loanId, asset, recovered);
    }

    // ─── Kill-switches + config (VAULT_ADMIN / timelock) ────────────────────

    function setBackstopEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.backstopEnabled = enabled;
    }

    function setBackstopFillEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.backstopFillEnabled = enabled;
    }

    function setMinBackstopDelay(uint64 delaySeconds)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.minBackstopDelay = delaySeconds;
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    function getBackstopVault() external view returns (address) {
        return LibVaipakam.getBackstopVault();
    }
}
