// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal Aave V3 Pool interface — only the supply + withdraw
///      methods Phase 0 of the productive treasury reserve needs.
interface IAaveV3Pool {
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256);
}

/// @dev Minimal Lido staking interface — the canonical
///      `submit(referral) payable returns (uint256)` shape returns
///      stETH shares (1:1 with stETH wei at submission time).
interface ILidoStaking {
    function submit(address _referral) external payable returns (uint256);
}

/**
 * @title LibTreasuryYield — T-087 Sub 3 add-on #473
 *
 * Phase-0 productive treasury reserve: routes a portion of the
 * diamond's treasury balance into external yield venues.
 *
 * Phase 0 supports:
 *   - Aave V3 supply for ERC20 assets (WBTC, USDC, etc.).
 *   - Lido stETH staking for ETH.
 *
 * Phase 1 (future): adds VAIPAKAM_INTERNAL venue.
 *
 * The library is storage-aware (reads / writes
 * `s.treasuryDeployedExternal[token]`) and trust-aware (rejects
 * deployments that would exceed the configured BPS ceiling).
 * Auth + reentrancy are the calling facet's responsibility.
 */
library LibTreasuryYield {
    using SafeERC20 for IERC20;

    // ─── Errors ──────────────────────────────────────────────────────

    /// @notice The configured venue for the token is NONE.
    error VenueNotConfigured(address token);
    /// @notice Codex Sub 3 add-on #473 round-1 P1 — the Lido venue
    ///         is configured but Phase 0 doesn't implement the
    ///         WETH-unwrap + native-ETH-submit path. Until Phase 1
    ///         wires that, calling `deployTreasuryYield` for a
    ///         Lido-configured token reverts.
    error LidoVenueNotYetSupported();
    /// @notice The configured venue doesn't match the operation:
    ///         e.g., `supplyToAave` called for a Lido-configured
    ///         token or vice-versa.
    error WrongVenue(address token, uint8 configured, uint8 expected);
    /// @notice The deployment would push the token's externally-
    ///         deployed amount above the `cfgTreasuryExternalYieldMaxBps`
    ///         share of its treasury balance.
    error ExternalYieldCapExceeded(
        address token,
        uint256 wouldDeploy,
        uint256 maxAllowed
    );
    /// @notice Aave V3 pool / Lido staking address not configured.
    error VenueAddressNotSet(uint8 venue);
    /// @notice The requested withdraw / unstake exceeds the
    ///         currently-deployed amount.
    error InsufficientDeployedBalance(uint256 requested, uint256 deployed);

    // ─── Events ──────────────────────────────────────────────────────

    /// @custom:event-category state-change/treasury-yield
    event TreasuryYieldDeployed(
        address indexed token,
        uint8 venue,
        uint256 amount
    );
    /// @custom:event-category state-change/treasury-yield
    event TreasuryYieldHarvested(
        address indexed token,
        uint8 venue,
        uint256 principalWithdrawn,
        uint256 interestHarvested
    );

    // ─── Constants ───────────────────────────────────────────────────

    /// @dev Default ceiling — 70% of treasury balance can be
    ///      deployed externally; at least 30% stays liquid for
    ///      operational + audit reasons.
    uint16 internal constant DEFAULT_EXTERNAL_YIELD_MAX_BPS = 7000;
    /// @dev Hard upper bound — even if governance bumps the ceiling,
    ///      we refuse to deploy more than 80% (counterparty-risk
    ///      floor: always retain 20% in the diamond).
    uint16 internal constant MAX_EXTERNAL_YIELD_BPS = 8000;
    /// @dev Basis points denominator.
    uint16 internal constant BPS_DENOM = 10000;

    // ─── Deployment ──────────────────────────────────────────────────

    /**
     * @dev Supply `amount` of `token` to the configured external
     *      yield venue. Reads venue from
     *      `s.cfgTreasuryYieldVenue[token]`; routes to the matching
     *      adapter call. Updates `treasuryDeployedExternal[token]`
     *      and emits.
     *
     *      Enforces:
     *        - Venue configured (≠ NONE).
     *        - Deployment + already-deployed ≤
     *          `(treasuryBalance * cfgTreasuryExternalYieldMaxBps) / 10000`,
     *          using `treasuryBalance` BEFORE this deployment as
     *          the denominator (so the cap is on TOTAL deployed
     *          fraction).
     *        - Venue address configured.
     */
    function deployTreasuryYield(
        address token,
        uint256 amount
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint8 venue = s.cfgTreasuryYieldVenue[token];
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_NONE) {
            revert VenueNotConfigured(token);
        }
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_LIDO_STETH) {
            // Codex round-1 P1 — Phase 0 deferral; fail fast before
            // any accounting changes so the operator gets a clean
            // error surface instead of a hard-to-trace silent
            // misbehaviour.
            revert LidoVenueNotYetSupported();
        }

        // ── Ceiling check ───────────────────────────────────────────
        uint256 treasuryBal = s.treasuryBalances[token];
        uint256 alreadyDeployed = s.treasuryDeployedExternal[token];
        // Denominator is total balance + currently-deployed: the
        // total addressable treasury for this token. Otherwise the
        // ratio would shift as we deploy.
        uint256 totalAddressable = treasuryBal + alreadyDeployed;
        uint16 maxBps = s.cfgTreasuryExternalYieldMaxBps == 0
            ? DEFAULT_EXTERNAL_YIELD_MAX_BPS
            : s.cfgTreasuryExternalYieldMaxBps;
        uint256 maxDeployable = (totalAddressable * uint256(maxBps)) / uint256(BPS_DENOM);
        uint256 wouldDeploy = alreadyDeployed + amount;
        if (wouldDeploy > maxDeployable) {
            revert ExternalYieldCapExceeded(token, wouldDeploy, maxDeployable);
        }

        // ── Debit treasury balance ──────────────────────────────────
        s.treasuryBalances[token] = treasuryBal - amount;
        s.treasuryDeployedExternal[token] = alreadyDeployed + amount;

        // ── Venue routing ───────────────────────────────────────────
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3) {
            address pool = s.cfgAaveV3Pool;
            if (pool == address(0)) revert VenueAddressNotSet(venue);
            IERC20(token).forceApprove(pool, amount);
            IAaveV3Pool(pool).supply(token, amount, address(this), 0);
        } else if (venue == LibVaipakam.TREASURY_YIELD_VENUE_LIDO_STETH) {
            // Codex Sub 3 add-on #473 round-1 P1 — the Lido path
            // requires WETH unwrap + native ETH `submit{value: ...}`
            // plumbing the diamond doesn't yet have. Reverting before
            // the accounting moves prevents the silently-broken
            // failure mode where treasuryBalances debits but no ETH
            // is staked. Phase 1 wires the unwrap path.
            revert LidoVenueNotYetSupported();
        }

        emit TreasuryYieldDeployed(token, venue, amount);
    }

    /**
     * @dev Withdraw `amount` of `token` from the configured external
     *      venue back to the diamond. The harvested interest (if any)
     *      stays on the venue side until a separate `harvestInterest`
     *      call; this method only returns principal.
     *
     *      For Aave: calls `withdraw(token, amount, address(this))`.
     *      For Lido: stETH unstake requires a separate withdrawal
     *      queue + finalisation; Phase 0 doesn't support
     *      `unstakeFromLido` automatically — the operator uses the
     *      Lido withdrawal queue manually. This function reverts
     *      for Lido until Phase 1.
     */
    function withdrawTreasuryYield(
        address token,
        uint256 amount
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint8 venue = s.cfgTreasuryYieldVenue[token];
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_NONE) {
            revert VenueNotConfigured(token);
        }
        uint256 deployed = s.treasuryDeployedExternal[token];
        if (amount > deployed) {
            revert InsufficientDeployedBalance(amount, deployed);
        }
        s.treasuryDeployedExternal[token] = deployed - amount;
        s.treasuryBalances[token] += amount;

        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3) {
            address pool = s.cfgAaveV3Pool;
            if (pool == address(0)) revert VenueAddressNotSet(venue);
            IAaveV3Pool(pool).withdraw(token, amount, address(this));
        } else if (venue == LibVaipakam.TREASURY_YIELD_VENUE_LIDO_STETH) {
            // Phase 0 — Lido withdrawal queue not auto-managed.
            revert WrongVenue(
                token, venue, LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3
            );
        }
    }
}
