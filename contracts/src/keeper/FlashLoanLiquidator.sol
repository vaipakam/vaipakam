// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {
    IAaveV3Pool,
    IFlashLoanSimpleReceiver
} from "../interfaces/IAaveV3Pool.sol";
import {
    IBalancerV2Vault,
    IFlashLoanRecipient
} from "../interfaces/IBalancerV2Vault.sol";

/// @title IRiskFacetDiscount
/// @dev   Local alias for the `RiskFacet.triggerLiquidationDiscounted`
///        selector. Lives here rather than as a full RiskFacet import
///        to keep this contract independently deployable (no Diamond
///        dependency at compile time beyond the function selector).
interface IRiskFacetDiscount {
    function triggerLiquidationDiscounted(
        uint256 loanId,
        address recipient,
        bytes calldata extraData
    ) external;
}

/**
 * @title  FlashLoanLiquidator
 * @author Vaipakam Developer Team
 * @notice Reference flash-loan-funded receiver for Vaipakam's
 *         discount-path liquidation
 *         (`RiskFacet.triggerLiquidationDiscounted`). Borrows the
 *         outstanding principal asset from Aave V3 or Balancer V2,
 *         pays it to the Vaipakam diamond at oracle-priced
 *         debt-plus-discount value, receives the borrower's
 *         collateral at the per-tier discount, swaps the collateral
 *         back to principal on an off-chain-ranked DEX, repays the
 *         flash-loan + fee, and forwards the net profit to the
 *         keeper-bot EOA.
 *
 * @dev    Phase 3 of `docs/DesignsAndPlans/FlashLoanLiquidationPath.md`.
 *         Deployed per chain (one address per chain) alongside the
 *         keeper bot in `apps/keeper`. The contract is owner-gated
 *         on the *entry point* — only the bot's EOA can initiate a
 *         flash-loan-funded liquidation — to prevent a griefer
 *         from triggering tx-spam costs against us. The underlying
 *         discount-path call to the diamond is permissionless, so
 *         external MEV liquidators can write their own equivalent
 *         receiver (e.g. against Aave's own ParaSwap-style sweeper
 *         or any custom flash-loan provider) and compete against
 *         our bot in the open-market.
 *
 *         Layout:
 *           - `liquidateViaAaveV3` / `liquidateViaBalancerV2` —
 *             owner-only entry points, choose flash-loan provider.
 *           - `executeOperation` — Aave V3 callback shape.
 *           - `receiveFlashLoan` — Balancer V2 callback shape.
 *           - `_runLiquidation` — shared post-flash-loan flow:
 *             approve the diamond, trigger the discounted
 *             liquidation, swap the seized collateral back to the
 *             principal asset via owner-supplied calldata.
 *           - `withdraw` / `rescueToken` — owner can pull profits
 *             OR rescue stuck tokens.
 *
 *         Reentrancy: each flash-loan provider's callback runs
 *         INSIDE that provider's flash-loan code path, so re-entry
 *         from outside is naturally blocked while the loan is open.
 *         The `_inFlight` flag also blocks a malicious nested
 *         `triggerLiquidationDiscounted` from re-entering one of
 *         our entry points (defence-in-depth — the diamond's
 *         `ReentrancyGuard` already covers this).
 *
 *         Security notes:
 *           - Aave V3 + Balancer V2 callbacks validate
 *             `msg.sender` against the configured provider, AND
 *             validate the in-flight flag — both have to align
 *             for the callback to execute. An attacker calling
 *             our `executeOperation` directly will hit the
 *             `_inFlight` guard.
 *           - Swap calldata is provided OFF-CHAIN by the keeper
 *             bot (e.g. 0x v2 / 1inch v6 quote). The contract
 *             validates the post-swap balance covers the
 *             flash-loan repayment; insufficient balance reverts
 *             the whole tx (including the discounted-liquidation
 *             call — borrower state is preserved).
 *           - `swapTarget` and `swapAllowanceTarget` are
 *             owner-supplied per-call (not stored) so the bot can
 *             route via different aggregators per loan.
 */
contract FlashLoanLiquidator is
    IFlashLoanSimpleReceiver,
    IFlashLoanRecipient
{
    using SafeERC20 for IERC20;

    // ─── Immutables ──────────────────────────────────────────────────

    /// @notice Owner-EOA of the keeper bot — the only address allowed
    ///         to initiate a flash-loan-funded liquidation via this
    ///         contract. Set once at construction; rotating the
    ///         owner means deploying a new contract.
    address public immutable owner;

    /// @notice Vaipakam diamond address on this chain. Constructor-
    ///         supplied to keep this contract chain-agnostic.
    address public immutable diamond;

    /// @notice Aave V3 Pool address on this chain. Set to
    ///         `address(0)` when Aave V3 isn't available (then
    ///         `liquidateViaAaveV3` reverts).
    address public immutable aaveV3Pool;

    /// @notice Balancer V2 Vault address on this chain. Set to
    ///         `address(0)` when Balancer V2 isn't available.
    address public immutable balancerV2Vault;

    // ─── Transient state ─────────────────────────────────────────────

    /// @dev In-flight flag — set by the entry-point BEFORE calling
    ///      the flash-loan provider, validated by the callback,
    ///      cleared after. Prevents an attacker from invoking
    ///      `executeOperation` / `receiveFlashLoan` directly with a
    ///      forged `msg.sender` (the `msg.sender == provider` check
    ///      already blocks that, but defence-in-depth).
    bool private _inFlight;

    // ─── Errors ──────────────────────────────────────────────────────

    error NotOwner();
    error NotFlashLoanProvider(address expected, address got);
    error WrongInitiator(address expected, address got);
    error NotInFlight();
    error ProviderNotConfigured();
    error SwapFailed();
    error InsufficientPostSwapBalance(uint256 needed, uint256 got);
    error InvalidTokenArrayLength(uint256 length);

    // ─── Events ──────────────────────────────────────────────────────

    /// @notice Emitted at the end of every successful
    ///         flash-loan-funded liquidation. Includes the gross +
    ///         net profit for off-chain accounting.
    event FlashLoanLiquidationCompleted(
        uint256 indexed loanId,
        address indexed principalAsset,
        address indexed collateralAsset,
        uint256 totalDebt,
        uint256 flashLoanFee,
        uint256 collateralSeized,
        uint256 swapProceeds,
        uint256 netProfit
    );

    /// @notice Emitted on every owner-side withdrawal (profit
    ///         sweep or token rescue).
    event Withdrawn(address indexed token, uint256 amount);

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param _owner             Keeper-bot EOA. Cannot be zero.
    /// @param _diamond           Vaipakam diamond on this chain.
    ///                           Cannot be zero.
    /// @param _aaveV3Pool        Aave V3 Pool. `address(0)` if Aave
    ///                           V3 isn't deployed on this chain
    ///                           (no `liquidateViaAaveV3` then).
    /// @param _balancerV2Vault   Balancer V2 Vault. `address(0)` if
    ///                           Balancer V2 isn't deployed.
    constructor(
        address _owner,
        address _diamond,
        address _aaveV3Pool,
        address _balancerV2Vault
    ) {
        require(_owner != address(0), "owner");
        require(_diamond != address(0), "diamond");
        // At least one flash-loan provider must be configured —
        // a contract with neither is operationally pointless.
        require(
            _aaveV3Pool != address(0) || _balancerV2Vault != address(0),
            "no provider"
        );
        owner = _owner;
        diamond = _diamond;
        aaveV3Pool = _aaveV3Pool;
        balancerV2Vault = _balancerV2Vault;
    }

    // ─── Modifiers ───────────────────────────────────────────────────

    /// @dev Extracted modifier body to keep the modifier itself a thin
    ///      wrapper — every call site inlines the modifier, so the
    ///      check living in a private function dedupes the bytecode.
    function _checkOwner() private view {
        if (msg.sender != owner) revert NotOwner();
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    // ─── Entry points ────────────────────────────────────────────────

    /// @notice Initiate a flash-loan-funded discount-path
    ///         liquidation via Aave V3.
    ///
    /// @dev    Workflow:
    ///         1. Set in-flight flag.
    ///         2. Call `flashLoanSimple` — Aave sends `totalDebt`
    ///            of `principalAsset` to this contract.
    ///         3. Aave invokes `executeOperation` synchronously.
    ///         4. Inside the callback: approve diamond, trigger
    ///            discounted liquidation, swap seized collateral
    ///            for more principal-asset via owner-supplied
    ///            calldata.
    ///         5. Approve Aave to sweep `totalDebt + premium`.
    ///         6. Return true — Aave reclaims funds.
    ///         7. Clear in-flight flag, emit event.
    ///
    /// @param loanId               Loan to liquidate.
    /// @param principalAsset       Loan's principal asset — what
    ///                             we flash-loan.
    /// @param collateralAsset      Loan's collateral asset — what
    ///                             the diamond will hand us, then
    ///                             we swap back to principal.
    /// @param totalDebt            Exact debt to pay the diamond.
    ///                             Caller computes off-chain from
    ///                             `LoanFacet.getLoanDetails` +
    ///                             current borrow-balance interest.
    /// @param swapTarget           DEX / aggregator contract our
    ///                             swap calldata will target
    ///                             (e.g. 0x Settler, 1inch router).
    /// @param swapAllowanceTarget  ERC-20 allowance recipient for
    ///                             the swap — sometimes ≠
    ///                             `swapTarget` (0x v2 / Permit2
    ///                             pattern).
    /// @param swapCalldata         Pre-computed swap calldata.
    function liquidateViaAaveV3(
        uint256 loanId,
        address principalAsset,
        address collateralAsset,
        uint256 totalDebt,
        address swapTarget,
        address swapAllowanceTarget,
        bytes calldata swapCalldata
    ) external onlyOwner {
        if (aaveV3Pool == address(0)) revert ProviderNotConfigured();

        bytes memory params = abi.encode(
            loanId,
            collateralAsset,
            swapTarget,
            swapAllowanceTarget,
            swapCalldata
        );
        _inFlight = true;
        IAaveV3Pool(aaveV3Pool).flashLoanSimple(
            address(this),
            principalAsset,
            totalDebt,
            params,
            0 /* referralCode */
        );
        _inFlight = false;
    }

    /// @notice Initiate a flash-loan-funded discount-path
    ///         liquidation via Balancer V2 — fallback when Aave V3
    ///         doesn't list `principalAsset` on this chain OR
    ///         when its premium would push the trade unprofitable.
    /// @dev    Balancer V2's flash-loan is fee-less on assets the
    ///         Vault already holds (typical for major assets).
    ///         Multi-asset array shape with a single entry.
    function liquidateViaBalancerV2(
        uint256 loanId,
        address principalAsset,
        address collateralAsset,
        uint256 totalDebt,
        address swapTarget,
        address swapAllowanceTarget,
        bytes calldata swapCalldata
    ) external onlyOwner {
        if (balancerV2Vault == address(0)) revert ProviderNotConfigured();

        bytes memory params = abi.encode(
            loanId,
            collateralAsset,
            swapTarget,
            swapAllowanceTarget,
            swapCalldata
        );
        address[] memory tokens = new address[](1);
        tokens[0] = principalAsset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = totalDebt;

        _inFlight = true;
        IBalancerV2Vault(balancerV2Vault).flashLoan(
            IFlashLoanRecipient(address(this)),
            tokens,
            amounts,
            params
        );
        _inFlight = false;
    }

    // ─── Provider callbacks ──────────────────────────────────────────

    /// @notice Aave V3 callback. Validates the caller, runs the
    ///         shared liquidation flow, then approves the Pool to
    ///         sweep `amount + premium` back.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (!_inFlight) revert NotInFlight();
        if (msg.sender != aaveV3Pool) {
            revert NotFlashLoanProvider(aaveV3Pool, msg.sender);
        }
        if (initiator != address(this)) {
            revert WrongInitiator(address(this), initiator);
        }

        _runLiquidation(asset, amount, premium, params);

        // Approve Aave to pull `amount + premium` back. Exact
        // amount — no leftover allowance.
        IERC20(asset).forceApprove(aaveV3Pool, amount + premium);
        return true;
    }

    /// @notice Balancer V2 callback. Validates the caller, runs
    ///         the shared liquidation flow, then transfers
    ///         `amount + fee` back to the Vault directly (Balancer
    ///         doesn't sweep via approve+pull — receiver pushes).
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        if (!_inFlight) revert NotInFlight();
        if (msg.sender != balancerV2Vault) {
            revert NotFlashLoanProvider(balancerV2Vault, msg.sender);
        }
        // We always flash-loan a single asset — defensive against
        // a Vault that erroneously hands us a different shape.
        if (tokens.length != 1 || amounts.length != 1 || feeAmounts.length != 1) {
            revert InvalidTokenArrayLength(tokens.length);
        }

        _runLiquidation(
            address(tokens[0]),
            amounts[0],
            feeAmounts[0],
            userData
        );

        // Balancer V2: push repayment directly to the Vault.
        tokens[0].safeTransfer(balancerV2Vault, amounts[0] + feeAmounts[0]);
    }

    // ─── Shared post-flash-loan logic ────────────────────────────────

    /// @dev Decode `params`, approve the diamond, trigger the
    ///      discounted liquidation, then run the off-chain-supplied
    ///      swap to convert the seized collateral back to the
    ///      principal asset. Reverts if the post-swap balance is
    ///      insufficient to repay the flash-loan + fee.
    function _runLiquidation(
        address principalAsset,
        uint256 totalDebt,
        uint256 fee,
        bytes memory params
    ) internal {
        (
            uint256 loanId,
            address collateralAsset,
            address swapTarget,
            address swapAllowanceTarget,
            bytes memory swapCalldata
        ) = abi.decode(params, (uint256, address, address, address, bytes));

        // 1. Approve diamond for the exact debt amount. The
        // diamond's `safeTransferFrom` consumes the entire
        // allowance — no leftover risk.
        IERC20(principalAsset).forceApprove(diamond, totalDebt);

        // 2. Trigger discounted liquidation. Collateral lands on
        // this contract (we passed `address(this)` as recipient).
        IRiskFacetDiscount(diamond).triggerLiquidationDiscounted(
            loanId,
            address(this),
            "" /* extraData reserved for v2 */
        );

        // 3. Snapshot the seized collateral balance. The exact
        // size depends on the diamond's per-tier discount math
        // applied to the loan's oracle-priced collateral value;
        // we don't try to second-guess it on-chain.
        uint256 collateralSeized = IERC20(collateralAsset).balanceOf(address(this));

        // 4. Swap collateral → principal using off-chain calldata.
        // The keeper bot computed the route + min-output; if the
        // realised proceeds are insufficient to repay the loan +
        // fee, the swap-balance check below reverts the whole tx.
        uint256 swapProceeds = 0;
        if (collateralSeized > 0) {
            IERC20(collateralAsset).forceApprove(swapAllowanceTarget, collateralSeized);
            uint256 principalBefore = IERC20(principalAsset).balanceOf(address(this));
            (bool ok, ) = swapTarget.call(swapCalldata);
            if (!ok) revert SwapFailed();
            uint256 principalAfter = IERC20(principalAsset).balanceOf(address(this));
            swapProceeds = principalAfter - principalBefore;
            // Clean up the allowance — defence-in-depth against an
            // aggregator that pulled less than approved.
            IERC20(collateralAsset).forceApprove(swapAllowanceTarget, 0);
        }

        // 5. Validate post-swap balance covers debt + fee.
        uint256 needed = totalDebt + fee;
        uint256 finalBalance = IERC20(principalAsset).balanceOf(address(this));
        if (finalBalance < needed) {
            revert InsufficientPostSwapBalance(needed, finalBalance);
        }

        emit FlashLoanLiquidationCompleted(
            loanId,
            principalAsset,
            collateralAsset,
            totalDebt,
            fee,
            collateralSeized,
            swapProceeds,
            finalBalance - needed /* net profit */
        );
    }

    // ─── Owner withdraw / rescue ─────────────────────────────────────

    /// @notice Sweep `amount` of `token` to the owner. Used to
    ///         pull accumulated profit after each successful
    ///         liquidation. Passing `address(0)` sweeps native
    ///         ETH (in case any drifts in from an aggregator).
    function withdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok, ) = payable(owner).call{value: amount}("");
            require(ok, "eth send");
        } else {
            IERC20(token).safeTransfer(owner, amount);
        }
        emit Withdrawn(token, amount);
    }

    /// @notice Allow native ETH receipts so aggregators that route
    ///         through WETH unwrap can settle here.
    receive() external payable {}
}
