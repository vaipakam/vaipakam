// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";

/**
 * @title IntentConfigFacet
 * @author Vaipakam Developer Team
 * @notice T-090 v1.1 (#389) — intent-based swap-to-repay
 *         configuration surface. Hosts the 8 setter/getter pairs +
 *         events for the v1.1 master switch, HF gate, output buffer,
 *         auction-window bounds, cancel-grace, Fusion `LimitOrderProtocol`
 *         address rotation (with the round-10 P1 #6 live-commit
 *         block), and the per-token principal + collateral allowlists.
 *
 *         Carved off `ConfigFacet` after the round-2 PR #420 CI block
 *         pushed `ConfigFacet`'s bytecode size to 25,549 bytes
 *         (> EIP-170's 24,576-byte ceiling). Same admin model
 *         (ADMIN_ROLE pre-handover, governance-timelock post-handover);
 *         same top-level `LibVaipakam.Storage` slot layout (NOT the
 *         nested `protocolCfg` — Codex round-7 P1 #5).
 *
 *         Storage layout note: every v1.1 cfg slot lives on the
 *         top-level `LibVaipakam.Storage` struct. Growing the nested
 *         `ProtocolConfig` would shift every subsequent slot on
 *         upgrade and corrupt deployed `borrowerLifRebate` / swap-
 *         adapter state.
 *
 *         See `docs/DesignsAndPlans/SwapToRepayIntentBased.md` §5.6
 *         for the full surface + rationale.
 */
contract IntentConfigFacet is DiamondAccessControl {
    /// @notice Emitted whenever the v1.1 intent surface master switch
    ///         flips. Surfaces in the indexer for audit + UI rollout.
    event IntentSwapToRepayEnabledSet(bool enabled);
    /// @notice Emitted on rotation of the per-chain commit-time HF
    ///         gate. HF_SCALE-scaled (1e18); default 1.2e18 = 120%.
    event IntentMinCommitHFSet(uint256 newHfScaleValue);
    /// @notice Emitted on rotation of the floor-buffer above
    ///         (lenderLeg + treasuryLeg + lateFee).
    event IntentMinOutputBufferBpsSet(uint16 newBps);
    /// @notice Emitted on rotation of the auction-window bounds.
    event IntentAuctionSecondsBoundsSet(uint32 minSec, uint32 maxSec);
    /// @notice Emitted on rotation of the cancelExpired grace window.
    event IntentCancelGraceSecondsSet(uint32 newSec);
    /// @notice Emitted on rotation of the Fusion `LimitOrderProtocol`
    ///         address. Blocked while any commit is live (per
    ///         `IntentLOPRotationWhileCommitsLive`).
    event FusionLimitOrderProtocolSet(address newProtocol);
    /// @notice Emitted on toggle of the per-principal-token allowlist.
    event IntentAllowedPrincipalTokenSet(address indexed token, bool allowed);
    /// @notice Emitted on toggle of the per-collateral-token allowlist.
    event IntentAllowedCollateralTokenSet(address indexed token, bool allowed);

    /// @notice `setFusionLimitOrderProtocol` rotation is refused while
    ///         any v1.1 intent commit is live. Defense-in-depth
    ///         alongside the per-commit `lopAtCommit` pin: even if a
    ///         caller bypassed this guard, the live commits would
    ///         still resolve their cancel + fill paths against the
    ///         original LOP address. Codex round-10 P1 #6.
    error IntentLOPRotationWhileCommitsLive(uint256 liveCount);
    /// @notice Auction-window bounds setter requires min <= max
    ///         and both strictly > 0.
    error IntentAuctionSecondsBoundsInvalid(uint32 minSec, uint32 maxSec);
    /// @notice `setIntentMinOutputBufferBps` capped at the shared
    ///         protocol slippage ceiling.
    error InvalidSlippageBps(uint256 provided, uint256 maxAllowed);

    /// @dev Mirror of `ConfigFacet.MAX_SLIPPAGE_BPS` — the protocol-
    ///      wide slippage ceiling used to cap the v1.1 buffer.
    uint16 internal constant MAX_SLIPPAGE_BPS = 2_500;

    /// @notice §5.6 master switch. Default OFF on every chain.
    function setIntentSwapToRepayEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().cfgIntentSwapToRepayEnabled = enabled;
        emit IntentSwapToRepayEnabledSet(enabled);
    }

    /// @notice §5.1 step 4 pre-commit lender-protection gate.
    function setIntentMinCommitHF(uint256 hfScaleValue)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().cfgIntentMinCommitHF = hfScaleValue;
        emit IntentMinCommitHFSet(hfScaleValue);
    }

    /// @notice §5.4 buffer above (lenderLeg + treasuryLeg + lateFee)
    ///         the borrower's takerAmount must clear.
    function setIntentMinOutputBufferBps(uint16 bps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (bps > MAX_SLIPPAGE_BPS) revert InvalidSlippageBps(bps, MAX_SLIPPAGE_BPS);
        LibVaipakam.storageSlot().cfgIntentMinOutputBufferBps = bps;
        emit IntentMinOutputBufferBpsSet(bps);
    }

    /// @notice §5.1 step 2 auction-window bounds.
    function setIntentAuctionSecondsBounds(uint32 minSec, uint32 maxSec)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (minSec == 0 || maxSec == 0 || minSec > maxSec) {
            revert IntentAuctionSecondsBoundsInvalid(minSec, maxSec);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.cfgIntentMinAuctionSeconds = minSec;
        s.cfgIntentMaxAuctionSeconds = maxSec;
        emit IntentAuctionSecondsBoundsSet(minSec, maxSec);
    }

    /// @notice §5.5 grace window after Fusion `deadline` before the
    ///         permissionless `cancelExpiredIntent` path opens.
    function setIntentCancelGraceSeconds(uint32 sec)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().cfgIntentCancelGraceSeconds = sec;
        emit IntentCancelGraceSecondsSet(sec);
    }

    /// @notice §5.1 pinned per-chain Fusion `LimitOrderProtocol`
    ///         address. Codex round-10 P1 #6 — rotation REFUSED
    ///         while any commit is live.
    function setFusionLimitOrderProtocol(address protocol)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.intentLiveCommitCount != 0) {
            revert IntentLOPRotationWhileCommitsLive(s.intentLiveCommitCount);
        }
        s.cfgFusionLimitOrderProtocol = protocol;
        emit FusionLimitOrderProtocolSet(protocol);
    }

    /// @notice §5.1 step 1 + Codex round-8 P1 #6 — per-principal-token
    ///         allowlist. Default-OFF on every token.
    function setIntentAllowedPrincipalToken(address token, bool allowed)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().cfgIntentAllowedPrincipalTokens[token] = allowed;
        emit IntentAllowedPrincipalTokenSet(token, allowed);
    }

    /// @notice §5.1 step 1 + Codex round-8 P1 #6 — per-collateral-token
    ///         allowlist.
    function setIntentAllowedCollateralToken(address token, bool allowed)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().cfgIntentAllowedCollateralTokens[token] = allowed;
        emit IntentAllowedCollateralTokenSet(token, allowed);
    }

    // ── Read surface (Codex round-2 PR #420 P2 — return EFFECTIVE
    //    values so observed state matches protocol-enforced state) ──

    function getIntentSwapToRepayEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().cfgIntentSwapToRepayEnabled;
    }

    function getIntentMinCommitHF() external view returns (uint256) {
        return LibVaipakam.cfgIntentMinCommitHFEffective();
    }

    function getIntentMinOutputBufferBps() external view returns (uint16) {
        return LibVaipakam.cfgIntentMinOutputBufferBpsEffective();
    }

    function getIntentAuctionSecondsBounds()
        external
        view
        returns (uint32 minSec, uint32 maxSec)
    {
        return (
            LibVaipakam.cfgIntentMinAuctionSecondsEffective(),
            LibVaipakam.cfgIntentMaxAuctionSecondsEffective()
        );
    }

    function getIntentCancelGraceSeconds() external view returns (uint32) {
        return LibVaipakam.cfgIntentCancelGraceSecondsEffective();
    }

    function getFusionLimitOrderProtocol() external view returns (address) {
        return LibVaipakam.storageSlot().cfgFusionLimitOrderProtocol;
    }

    function getIntentAllowedPrincipalToken(address token)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().cfgIntentAllowedPrincipalTokens[token];
    }

    function getIntentAllowedCollateralToken(address token)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().cfgIntentAllowedCollateralTokens[token];
    }
}
