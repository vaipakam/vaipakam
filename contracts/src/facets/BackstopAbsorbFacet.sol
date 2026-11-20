// src/facets/BackstopAbsorbFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibTreasury} from "../libraries/LibTreasury.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title  BackstopAbsorbFacet
 * @author Vaipakam Developer Team
 * @notice #630 backstop Role B (liquidator-of-last-resort) governance: the
 *         per-pair absorb cap, the treasury seed and withdrawal of the free
 *         absorb-cash bucket, the sweep of warehoused absorb collateral to the
 *         treasury, the realized-cash exposure release, the Role B
 *         kill-switch and the per-pair absorb view.
 *
 * @dev    Split off `BackstopFacet` in #3843, a pure move: the selectors,
 *         events, errors, modifiers and behaviour are unchanged, and only the
 *         runtime bytecode is separate. **These functions are NOT on
 *         BackstopFacet any more.** The absorb itself (the backstop buying a
 *         defaulted position) is not here; it runs from the claim path.
 *
 *         The errors this facet shares with `BackstopFacet` (`ZeroAmount`,
 *         `BackstopNotProvisioned`, `TreasuryInsufficient`,
 *         `VpfiLendingUnsupported`) are re-declared here byte-identical, so
 *         their selectors are unchanged; `TreasuryNotDiamond` is raised by
 *         {LibTreasury.requireDiamond}, the one check both facets use.
 *
 *         Refreshed together with `BackstopFacet`: both govern the one
 *         backstop vault `BackstopFacet` provisions, and both write
 *         `protocolCfg` kill-switches the backstop paths read.
 */
contract BackstopAbsorbFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    DiamondAccessControl
{
    /// @notice Role B per-pair absorb cap was set.
    event BackstopAbsorbCapSet(
        address indexed principal,
        address indexed collateral,
        uint256 cap
    );
    /// @notice Treasury cash was seeded into the per-pair absorb-cash bucket.
    event BackstopAbsorbSeeded(
        address indexed principal,
        address indexed collateral,
        uint256 amount
    );
    /// @notice Unused absorb cash was returned from the bucket to treasury.
    event BackstopAbsorbWithdrawn(
        address indexed principal,
        address indexed collateral,
        uint256 amount
    );
    /// @notice Warehoused absorb collateral was swept out of the backstop vault.
    event BackstopAbsorbCollateralSwept(
        address indexed collateral,
        address indexed to,
        uint256 amount
    );
    /// @notice Outstanding absorb exposure was released on realized-cash sale /
    ///         governance write-off (§5.1).
    event BackstopAbsorbExposureReleased(
        address indexed principal,
        address indexed collateral,
        uint256 released
    );
    /// @notice #2685 — the Role B (absorb) kill-switch changed.
    /// @custom:event-category informational/config
    event BackstopAbsorbEnabledSet(bool enabled);

    error BackstopNotProvisioned();
    error TreasuryInsufficient();
    error ZeroAmount();
    error VpfiLendingUnsupported();
    error BackstopAbsorbCollateralInsufficient();

    // ─── Role B — kill-switch (VAULT_ADMIN / timelock) ──────────────────────

    /// @notice Role B (liquidator-of-last-resort) kill-switch — independent of
    ///         Role A's `backstopFillEnabled` so the riskier absorb path can be
    ///         staged/paused on its own. Subordinate to the master pause.
    function setBackstopAbsorbEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.backstopAbsorbEnabled = enabled;
        emit BackstopAbsorbEnabledSet(enabled);
    }

    // ─── Role B — absorb governance (VAULT_ADMIN / timelock) ────────────────

    /// @notice Set the per-(principal, collateral) absorb cap that bounds the
    ///         `backstopAbsorbExposure` counter (distinct from Role A's
    ///         origination `maxExposure`). 0 ⇒ absorb disabled for the pair.
    /// @dev Asymmetric governance (§6): a RAISE should be timelocked +
    ///      guardian-revocable, a LOWER instant — enforced by the calling
    ///      governance batch, like the Role-A caps. The setter itself is
    ///      VAULT_ADMIN. Lowering below the live exposure is allowed: it just
    ///      blocks new absorbs until exposure is released back under the cap.
    function setBackstopAbsorbCap(
        address principal,
        address collateral,
        uint256 cap
    ) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        LibVaipakam.storageSlot().backstopAbsorbCap[principal][collateral] = cap;
        emit BackstopAbsorbCapSet(principal, collateral, cap);
    }

    /// @notice Seed treasury capital into the per-pair FREE absorb-cash bucket
    ///         (Role B). Same §3 treasury-seed primitive as
    ///         {seedBackstopOrigination} but the capital is NOT liened — Role B
    ///         spends free cash to BUY collateral, it does not originate loans, so
    ///         there is no intent to lien against. Tracked in `backstopAbsorbCash`.
    /// @dev VAULT_ADMIN. Requires Diamond-as-treasury; rejects VPFI-denominated
    ///      cash (consistent with the origination seed + the absorb pays cash in
    ///      the principal asset); honors asset pauses on both legs.
    function seedBackstopAbsorb(
        address principal,
        address collateral,
        uint256 amount
    ) external nonReentrant onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        LibTreasury.requireDiamond();
        if (principal == s.vpfiToken) revert VpfiLendingUnsupported();
        LibFacet.requireAssetNotPaused(principal);
        LibFacet.requireAssetNotPaused(collateral);
        uint256 bal = s.treasuryBalances[principal];
        if (bal < amount) revert TreasuryInsufficient();
        s.treasuryBalances[principal] = bal - amount;
        address proxy = VaultFactoryFacet(address(this)).getOrCreateUserVault(
            vault
        );
        // #2440 — the tracked balance, the absorb bucket and the event record
        // what the backstop vault received (the treasury gave up `amount`).
        amount = LibDelivery.pushMeasured(principal, proxy, amount);
        // Record the tracked deposit but DO NOT lien — this is free absorb cash,
        // not intent capital.
        LibVaipakam.recordVaultDeposit(vault, principal, amount);
        s.backstopAbsorbCash[principal][collateral] += amount;
        emit BackstopAbsorbSeeded(principal, collateral, amount);
    }

    /// @notice Return UNUSED absorb cash from the bucket back to treasury (Role B).
    /// @dev VAULT_ADMIN. The counterpart to {seedBackstopAbsorb}: debits
    ///      `backstopAbsorbCash` and withdraws the free (un-spent) principal from
    ///      the backstop vault to the Diamond, re-crediting `treasuryBalances` —
    ///      so over-seeded / paused / retired-pair cash is recoverable by
    ///      governance, not stuck until an upgrade. Requires Diamond-as-treasury.
    ///      `nonReentrant`: the withdrawal is a vault move, which runs only
    ///      inside a guarded action (#3432).
    function withdrawBackstopAbsorbToTreasury(
        address principal,
        address collateral,
        uint256 amount
    ) external nonReentrant onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        LibTreasury.requireDiamond();
        uint256 bucket = s.backstopAbsorbCash[principal][collateral];
        if (amount > bucket) revert TreasuryInsufficient();
        s.backstopAbsorbCash[principal][collateral] = bucket - amount;
        // Pull the free cash from the vault back to the Diamond (treasury custody).
        // #2440 — the treasury is credited with what reached the Diamond: the
        // bucket gave up `amount`, and a token's own charge on the move is the
        // treasury's, never drawn from the Diamond's other holdings.
        // #3205 part 2 — the treasury class (the Diamond is the treasury here).
        (uint256 received, address treasury) =
            LibVaultOutflow.toTreasury(vault, principal, amount, 0, OutflowReason.BACKSTOP);
        LibFacet.recordTreasuryAccrual(principal, received, treasury);
        emit BackstopAbsorbWithdrawn(principal, collateral, received);
    }

    /// @notice Sweep WAREHOUSED absorb collateral out of the backstop vault to
    ///         the treasury (for an off-protocol sale the treasury runs, or a
    ///         write-off). Does NOT touch the `backstopAbsorbExposure` counter —
    ///         per §5.1 moving unsold collateral is not a realized-cash return.
    /// @dev VAULT_ADMIN. Withdraws from the backstop vault's tracked balance.
    ///      #3205 part 2 (decided default 2026-11-08) — the destination is the
    ///      treasury the vault code names (#3569), never an address the caller
    ///      picks: a VAULT_ADMIN key can move warehoused collateral only to
    ///      that treasury, which moves only with new vault code.
    ///      `nonReentrant`: the sweep is a vault move, which runs only inside a
    ///      guarded action (#3432).
    function sweepBackstopAbsorbCollateral(
        address collateral,
        uint256 amount
    ) external nonReentrant onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        // Bound the sweep to WAREHOUSED absorb collateral for this token — the
        // backstop vault also holds seeded absorb CASH, which (when one pair's
        // collateral token equals another pair's principal) shares the same vault
        // balance. Without this bound a sweep could withdraw that cash without
        // debiting `backstopAbsorbCash`, overstating the bucket.
        uint256 warehoused = s.backstopWarehousedCollateral[collateral];
        if (amount > warehoused) revert BackstopAbsorbCollateralInsufficient();
        s.backstopWarehousedCollateral[collateral] = warehoused - amount;
        // #2440 — what the treasury received; the accrual books that (it
        // credits `treasuryBalances` only in Diamond-as-treasury mode).
        (uint256 received, address treasury) =
            LibVaultOutflow.toTreasury(vault, collateral, amount, 0, OutflowReason.BACKSTOP);
        LibFacet.recordTreasuryAccrual(collateral, received, treasury);
        emit BackstopAbsorbCollateralSwept(collateral, treasury, amount);
    }

    /// @notice Release `realizedPrincipal` of absorb exposure for a pair — the
    ///         §5.1 realized-cash-sale / governance-write-off entry point. Call
    ///         AFTER the warehoused collateral was sold back to cash (the proceeds
    ///         funded to treasury separately) or written off; this decrements the
    ///         outstanding `backstopAbsorbExposure` counter so the freed headroom
    ///         can be re-used. Decrementing on a plain collateral move (without
    ///         realized cash) is exactly what §5.1 forbids — the counter must
    ///         track still-unsold risk.
    /// @dev VAULT_ADMIN / timelock (a governance attestation of realized cash or
    ///      an explicit write-off). Clamped to the live exposure.
    function releaseBackstopAbsorbExposure(
        address principal,
        address collateral,
        uint256 realizedPrincipal
    ) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        if (realizedPrincipal == 0) revert ZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 outstanding = s.backstopAbsorbExposure[principal][collateral];
        uint256 released = realizedPrincipal > outstanding
            ? outstanding
            : realizedPrincipal;
        s.backstopAbsorbExposure[principal][collateral] = outstanding - released;
        emit BackstopAbsorbExposureReleased(principal, collateral, released);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Role B per-pair accounting: free absorb cash, outstanding absorb
    ///         exposure, and the governance cap.
    function getBackstopAbsorbInfo(address principal, address collateral)
        external
        view
        returns (uint256 cash, uint256 exposure, uint256 cap)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        cash = s.backstopAbsorbCash[principal][collateral];
        exposure = s.backstopAbsorbExposure[principal][collateral];
        cap = s.backstopAbsorbCap[principal][collateral];
    }
}
