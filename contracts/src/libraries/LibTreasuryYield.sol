// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAaveV3Pool, IPoolAddressesProvider} from "../interfaces/IAaveV3Pool.sol";

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
    /// @notice The token's configured venue is a value this library has
    ///         no routing for (#964). Routing is exhaustive: a venue added
    ///         to the setter without a branch here refuses instead of
    ///         moving the accounting while the tokens stay put.
    error UnsupportedVenue(address token, uint8 venue);
    /// @notice The venue took a different amount from the Diamond than
    ///         was supplied (#965). Measured, not assumed.
    error VenueSupplyMismatch(address token, uint256 supplied, uint256 taken);
    /// @notice The venue reported withdrawing a different amount than was
    ///         requested (#965).
    error VenueWithdrawMismatch(address token, uint256 requested, uint256 reported);

    // ─── Events ──────────────────────────────────────────────────────

    /// @custom:event-category state-change/treasury-yield
    event TreasuryYieldDeployed(
        address indexed token,
        uint8 venue,
        uint256 amount
    );
    /// @notice Principal returned from a venue. `received` is what the
    ///         Diamond measurably gained and is what the treasury balance
    ///         is credited with; it is below `amount` only for a token that
    ///         charges on transfer, and the difference is stated here
    ///         rather than booked as if it had arrived (#965).
    /// @custom:event-category state-change/treasury-yield
    event TreasuryYieldWithdrawn(
        address indexed token,
        uint8 venue,
        uint256 amount,
        uint256 received
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
        // Codex round-2 P1 #1 — bump the Aave-deployed-tokens
        // counter when this token transitions from 0 to >0
        // deployed. `setAaveV3Pool` consults this counter to
        // refuse rotation while existing principal is live.
        if (
            venue == LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3
                && alreadyDeployed == 0
        ) {
            s.aaveDeployedTokenCount += 1;
        }

        // ── Venue routing ───────────────────────────────────────────
        // Exhaustive (#964): `_supply` reverts for any venue it has no
        // branch for, which unwinds the accounting above with it.
        _supply(s, venue, token, amount);

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
        uint256 newDeployed = deployed - amount;
        s.treasuryDeployedExternal[token] = newDeployed;
        // Codex round-2 P1 #1 — decrement counter if Aave-side
        // principal drops to 0 for this token.
        if (
            venue == LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3
                && newDeployed == 0
        ) {
            s.aaveDeployedTokenCount -= 1;
        }

        // Credit what ARRIVED (#965), never the request: a token that
        // charges on transfer would otherwise book a treasury balance
        // with nothing behind it, which a later claim pays out of other
        // buckets the Diamond holds. The deployed principal still drops
        // by the full `amount` — that is what left the venue.
        uint256 received = _withdraw(s, venue, token, amount);
        s.treasuryBalances[token] += received;
        emit TreasuryYieldWithdrawn(token, venue, amount, received);
    }

    // ─── Venue routing ───────────────────────────────────────────────

    /// @dev Moves `amount` of `token` into `venue`, measuring that the
    ///      venue took exactly `amount` from the Diamond. Every venue
    ///      without a supply path reverts — none falls through (#964).
    function _supply(LibVaipakam.Storage storage s, uint8 venue, address token, uint256 amount) private {
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3) {
            address pool = s.cfgAaveV3Pool;
            if (pool == address(0)) revert VenueAddressNotSet(venue);
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).forceApprove(pool, amount);
            IAaveV3Pool(pool).supply(token, amount, address(this), 0);
            uint256 afterBal = IERC20(token).balanceOf(address(this));
            uint256 taken = before > afterBal ? before - afterBal : 0;
            if (taken != amount) revert VenueSupplyMismatch(token, amount, taken);
            return;
        }
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_LIDO_STETH) revert LidoVenueNotYetSupported();
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_NONE) revert VenueNotConfigured(token);
        revert UnsupportedVenue(token, venue);
    }

    /// @dev Pulls `amount` of `token` back from `venue` and returns what the
    ///      Diamond measurably gained, capped at `amount` so nothing the
    ///      venue did not return is ever credited. Every venue without a
    ///      withdraw path reverts (#964).
    function _withdraw(LibVaipakam.Storage storage s, uint8 venue, address token, uint256 amount)
        private
        returns (uint256 received)
    {
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3) {
            address pool = s.cfgAaveV3Pool;
            if (pool == address(0)) revert VenueAddressNotSet(venue);
            uint256 before = IERC20(token).balanceOf(address(this));
            uint256 reported = IAaveV3Pool(pool).withdraw(token, amount, address(this));
            if (reported != amount) revert VenueWithdrawMismatch(token, amount, reported);
            uint256 afterBal = IERC20(token).balanceOf(address(this));
            received = afterBal > before ? afterBal - before : 0;
            if (received > amount) received = amount;
            return received;
        }
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_LIDO_STETH) {
            // Phase 0 — Lido withdrawal queue not auto-managed.
            revert WrongVenue(token, venue, LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        }
        if (venue == LibVaipakam.TREASURY_YIELD_VENUE_NONE) revert VenueNotConfigured(token);
        revert UnsupportedVenue(token, venue);
    }

    /// @notice Whether `pool` is the canonical Pool of its own Aave market:
    ///         its `ADDRESSES_PROVIDER()` is a contract whose `getPool()`
    ///         names `pool` back (#965).
    /// @dev    This is a fat-finger gate, not proof of authenticity: a
    ///         mistyped address, or any contract that merely has code,
    ///         fails it, but a look-alike deployed together with its own
    ///         provider passes. The defence against a deliberate swap is
    ///         that the setter is ADMIN_ROLE, which the governance
    ///         Timelock holds after handover, so the change is public for
    ///         the whole review window before it can take effect.
    function isCanonicalAavePool(address pool) internal view returns (bool) {
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeCall(IAaveV3Pool.ADDRESSES_PROVIDER, ()));
        address provider = _decodeAddress(ok, ret);
        if (provider == address(0) || provider.code.length == 0) return false;
        (ok, ret) = provider.staticcall(abi.encodeCall(IPoolAddressesProvider.getPool, ()));
        return _decodeAddress(ok, ret) == pool;
    }

    /// @dev One ABI-encoded address from a low-level call, or zero when the
    ///      call failed or returned anything else. Never reverts: a word
    ///      with high bits set is not an address and reads as "no answer".
    function _decodeAddress(bool ok, bytes memory ret) private pure returns (address) {
        if (!ok || ret.length != 32) return address(0);
        uint256 word = abi.decode(ret, (uint256));
        if (word > type(uint160).max) return address(0);
        return address(uint160(word));
    }
}
