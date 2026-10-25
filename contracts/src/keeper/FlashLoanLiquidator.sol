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
import {LibDiscountedLiquidation} from "../libraries/LibDiscountedLiquidation.sol";

/// @title IDiscountedLiquidationDiamond
/// @dev   The two Diamond selectors this receiver calls. The preview's return
///        type is the Diamond's own ({LibDiscountedLiquidation.Preview}), so
///        the two can never decode differently; importing the library adds no
///        bytecode here, and this contract stays deployable without the
///        Diamond's code.
interface IDiscountedLiquidationDiamond {
    function previewDiscountedLiquidation(uint256 loanId)
        external
        view
        returns (LibDiscountedLiquidation.Preview memory);

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
 *         pays it to the Vaipakam DIAMOND at oracle-priced
 *         debt-plus-discount value, receives the borrower's
 *         collateral at the per-tier discount, swaps the collateral
 *         back to principal on an off-chain-ranked DEX and repays the
 *         flash-loan + fee. The net profit, and any seized collateral
 *         beyond what the swap sold, stay in this contract as standing
 *         balance until the OWNER withdraws them.
 *
 * @dev    Phase 3 of `docs/DesignsAndPlans/FlashLoanLiquidationPath.md`.
 *         Deployed per chain (one address per chain) alongside the
 *         keeper bot in `apps/keeper`. The contract is OWNER-gated
 *         on the *entry point* — only the bot's EOA can initiate a
 *         flash-loan-funded liquidation — to prevent a griefer
 *         from triggering tx-spam costs against us. The underlying
 *         discount-path call to the DIAMOND is permissionless, so
 *         external MEV liquidators can write their own equivalent
 *         receiver (e.g. against Aave's own ParaSwap-style sweeper
 *         or any custom flash-loan provider) and compete against
 *         our bot in the open-market.
 *
 *         Layout:
 *           - `liquidateViaAaveV3` / `liquidateViaBalancerV2` —
 *             OWNER-only entry points, choose flash-loan provider.
 *           - `executeOperation` — Aave V3 callback shape.
 *           - `receiveFlashLoan` — Balancer V2 callback shape.
 *           - `_runLiquidation` — shared post-flash-loan flow:
 *             approve the DIAMOND, trigger the discounted
 *             liquidation, swap the seized collateral back to the
 *             principal asset via OWNER-supplied calldata.
 *           - `withdraw` / `rescueToken` — OWNER can pull profits
 *             OR rescue stuck tokens.
 *
 *         Reentrancy: each flash-loan provider's callback runs
 *         INSIDE that provider's flash-loan code path, so re-entry
 *         from outside is naturally blocked while the loan is open.
 *         Each entry point commits to ONE callback (the provider plus
 *         the exact packed parameters) and the first matching callback
 *         spends it, so a nested flash loan opened mid-run (Balancer V2
 *         accepts any recipient) cannot run a second liquidation with
 *         its own swap calldata (#2697). The DIAMOND's
 *         `ReentrancyGuard` separately blocks a nested trigger.
 *
 *         Security notes:
 *           - Aave V3 + Balancer V2 callbacks validate
 *             `msg.sender` against the configured provider, AND
 *             spend the run commitment — both have to align for
 *             the callback to execute. A callback with no matching
 *             commitment (a direct call, a nested or repeated
 *             loan) reverts `NotInFlight`.
 *           - Swap calldata is provided OFF-CHAIN by the keeper
 *             bot (e.g. 0x v2 / 1inch v6 quote). The contract
 *             validates the post-swap balance covers the
 *             flash-loan repayment; insufficient balance reverts
 *             the whole tx (including the discounted-liquidation
 *             call — borrower state is preserved).
 *           - `swapTarget` and `swapAllowanceTarget` are
 *             OWNER-supplied per-call (not stored) so the bot can
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
    ///         OWNER means deploying a new contract.
    address public immutable OWNER;

    /// @notice Vaipakam DIAMOND address on this chain. Constructor-
    ///         supplied to keep this contract chain-agnostic.
    address public immutable DIAMOND;

    /// @notice Aave V3 Pool address on this chain. Set to
    ///         `address(0)` when Aave V3 isn't available (then
    ///         `liquidateViaAaveV3` reverts).
    address public immutable AAVE_V3_POOL;

    /// @notice Balancer V2 Vault address on this chain. Set to
    ///         `address(0)` when Balancer V2 isn't available.
    address public immutable BALANCER_V2_VAULT;

    // ─── Transient state ─────────────────────────────────────────────

    /// @dev The ONE callback this contract will run next: the hash of the
    ///      provider it borrowed from and the exact parameters it packed.
    ///      Set by the entry point before calling the provider and CONSUMED
    ///      (zeroed) by the first callback that matches it, so each owner
    ///      call runs at most one liquidation (#2697). A bare in-flight flag
    ///      was not enough: Balancer V2 lets anyone name this contract as a
    ///      flash-loan recipient, so code running mid-run (an aggregator
    ///      route, a token hook) could open a nested Balancer loan and have
    ///      the callback run its own swap target and calldata while the flag
    ///      was still up. A callback with no matching commitment reverts
    ///      `NotInFlight`.
    bytes32 private _expectedRun;

    /// @dev One run's parameters, packed by {_prepare} and carried through
    ///      the flash-loan provider to {_runLiquidation}.
    struct Run {
        uint256 loanId;
        address collateralAsset;
        uint256 sellAmount;
        uint256 minProfit;
        address swapTarget;
        address swapAllowanceTarget;
        bytes swapCalldata;
    }

    // ─── Errors ──────────────────────────────────────────────────────

    error NotOwner();
    error NotFlashLoanProvider(address expected, address got);
    error WrongInitiator(address expected, address got);
    /// @dev A provider callback that is not the run the entry point
    ///      committed to, or a provider that returned without calling back.
    error NotInFlight();
    error ProviderNotConfigured();
    error SwapFailed();
    error InsufficientPostSwapBalance(uint256 needed, uint256 got);
    error InvalidTokenArrayLength(uint256 length);
    /// @notice The Diamond's preview says the loan cannot be liquidated on
    ///         the discount path now; `status` is its
    ///         {LibDiscountedLiquidation.Status} reason.
    error NotLiquidatable(uint256 loanId, uint8 status);
    /// @notice The liquidation delivers less collateral than the swap
    ///         calldata was quoted to sell.
    error SeizureBelowQuote(uint256 seized, uint256 sellAmount);

    // ─── Events ──────────────────────────────────────────────────────

    /// @notice Emitted at the end of every successful
    ///         flash-loan-funded liquidation. Includes the gross +
    ///         net profit for off-chain accounting. `collateralSold` is what
    ///         the swap was quoted for; any seized collateral above it stays
    ///         here as standing balance until the owner withdraws it.
    event FlashLoanLiquidationCompleted(
        uint256 indexed loanId,
        address indexed principalAsset,
        address indexed collateralAsset,
        uint256 totalDebt,
        uint256 flashLoanFee,
        uint256 collateralSeized,
        uint256 collateralSold,
        uint256 swapProceeds,
        uint256 netProfit
    );

    /// @notice Emitted on every OWNER-side withdrawal (profit
    ///         sweep or token rescue).
    event Withdrawn(address indexed token, uint256 amount);

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param _owner             Keeper-bot EOA. Cannot be zero.
    /// @param _diamond           Vaipakam DIAMOND on this chain.
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
        OWNER = _owner;
        DIAMOND = _diamond;
        AAVE_V3_POOL = _aaveV3Pool;
        BALANCER_V2_VAULT = _balancerV2Vault;
    }

    // ─── Modifiers ───────────────────────────────────────────────────

    /// @dev Extracted modifier body to keep the modifier itself a thin
    ///      wrapper — every call site inlines the modifier, so the
    ///      check living in a private function dedupes the bytecode.
    function _checkOwner() private view {
        if (msg.sender != OWNER) revert NotOwner();
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
    ///         1. Read the Diamond's preview of this liquidation
    ///            ({_prepare}). It runs in this transaction, so its debt is
    ///            exactly what the liquidation pulls and its seizure exactly
    ///            what it delivers (#2697); the loan's assets come from it
    ///            too, never from the caller.
    ///         2. Set in-flight flag and call `flashLoanSimple` for exactly
    ///            that debt.
    ///         3. Aave invokes `executeOperation` synchronously; inside it,
    ///            {_runLiquidation} pays the debt, receives the collateral,
    ///            sells `sellAmount` of it and checks the run netted at least
    ///            `minProfit` above its flash-loan fee.
    ///         4. Approve Aave to sweep `debt + premium`; Aave reclaims.
    ///         5. Clear in-flight flag.
    ///
    /// @param loanId               Loan to liquidate.
    /// @param sellAmount           Collateral the swap calldata was quoted
    ///                             to sell. The liquidation must deliver at
    ///                             least this much; exactly this much is
    ///                             offered to the swap.
    /// @param minProfit            Least net profit, in principal-asset
    ///                             base units, the run must leave after
    ///                             repaying the flash loan and its fee. The
    ///                             keeper sets it to the transaction's fee,
    ///                             so a run never nets less than its gas.
    /// @param swapTarget           DEX / aggregator contract our
    ///                             swap calldata will target
    ///                             (e.g. 0x Settler, 1inch router).
    /// @param swapAllowanceTarget  ERC-20 allowance recipient for
    ///                             the swap — sometimes ≠
    ///                             `swapTarget` (0x v2 / Permit2
    ///                             pattern).
    /// @param swapCalldata         Pre-computed swap calldata selling
    ///                             `sellAmount` of collateral for principal.
    function liquidateViaAaveV3(
        uint256 loanId,
        uint256 sellAmount,
        uint256 minProfit,
        address swapTarget,
        address swapAllowanceTarget,
        bytes calldata swapCalldata
    ) external onlyOwner {
        if (AAVE_V3_POOL == address(0)) revert ProviderNotConfigured();
        (address principalAsset, uint256 debt, bytes memory params) = _prepare(
            loanId, sellAmount, minProfit, swapTarget, swapAllowanceTarget, swapCalldata
        );
        _expectedRun = _runHash(AAVE_V3_POOL, params);
        IAaveV3Pool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            principalAsset,
            debt,
            params,
            0 /* referralCode */
        );
        // The callback consumed the commitment; a provider that returned
        // without calling back would leave it set, so the run reverts.
        if (_expectedRun != bytes32(0)) revert NotInFlight();
    }

    /// @notice Initiate a flash-loan-funded discount-path
    ///         liquidation via Balancer V2 — fallback when Aave V3
    ///         doesn't list the principal asset on this chain OR
    ///         when its premium would push the trade unprofitable.
    ///         Same parameters and checks as {liquidateViaAaveV3}.
    /// @dev    Balancer V2 charges its protocol flash-loan fee percentage,
    ///         which the Vault passes to the callback; the run must cover
    ///         whatever it is. Multi-asset array shape with a single entry.
    function liquidateViaBalancerV2(
        uint256 loanId,
        uint256 sellAmount,
        uint256 minProfit,
        address swapTarget,
        address swapAllowanceTarget,
        bytes calldata swapCalldata
    ) external onlyOwner {
        if (BALANCER_V2_VAULT == address(0)) revert ProviderNotConfigured();
        (address principalAsset, uint256 debt, bytes memory params) = _prepare(
            loanId, sellAmount, minProfit, swapTarget, swapAllowanceTarget, swapCalldata
        );
        address[] memory tokens = new address[](1);
        tokens[0] = principalAsset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = debt;

        _expectedRun = _runHash(BALANCER_V2_VAULT, params);
        IBalancerV2Vault(BALANCER_V2_VAULT).flashLoan(
            IFlashLoanRecipient(address(this)),
            tokens,
            amounts,
            params
        );
        if (_expectedRun != bytes32(0)) revert NotInFlight();
    }

    /// @dev Read the Diamond's preview, refuse a run the preview already
    ///      rules out, and pack the callback's parameters. Refusing here,
    ///      before any flash loan, means a keeper's gas estimate names the
    ///      reason instead of a provider's revert.
    function _prepare(
        uint256 loanId,
        uint256 sellAmount,
        uint256 minProfit,
        address swapTarget,
        address swapAllowanceTarget,
        bytes calldata swapCalldata
    ) private view returns (address principalAsset, uint256 debt, bytes memory params) {
        LibDiscountedLiquidation.Preview memory p =
            IDiscountedLiquidationDiamond(DIAMOND).previewDiscountedLiquidation(loanId);
        if (p.status != LibDiscountedLiquidation.Status.Ready) {
            revert NotLiquidatable(loanId, uint8(p.status));
        }
        if (p.seized < sellAmount) revert SeizureBelowQuote(p.seized, sellAmount);
        principalAsset = p.principalAsset;
        debt = p.debt;
        params = abi.encode(
            Run({
                loanId: loanId,
                collateralAsset: p.collateralAsset,
                sellAmount: sellAmount,
                minProfit: minProfit,
                swapTarget: swapTarget,
                swapAllowanceTarget: swapAllowanceTarget,
                swapCalldata: swapCalldata
            })
        );
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
        if (msg.sender != AAVE_V3_POOL) {
            revert NotFlashLoanProvider(AAVE_V3_POOL, msg.sender);
        }
        _consumeRun(AAVE_V3_POOL, params);
        if (initiator != address(this)) {
            revert WrongInitiator(address(this), initiator);
        }

        _runLiquidation(asset, amount, premium, params);

        // Approve Aave to pull `amount + premium` back. Exact
        // amount — no leftover allowance.
        IERC20(asset).forceApprove(AAVE_V3_POOL, amount + premium);
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
        if (msg.sender != BALANCER_V2_VAULT) {
            revert NotFlashLoanProvider(BALANCER_V2_VAULT, msg.sender);
        }
        _consumeRun(BALANCER_V2_VAULT, userData);
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
        tokens[0].safeTransfer(BALANCER_V2_VAULT, amounts[0] + feeAmounts[0]);
    }

    /// @dev The commitment for one run: the provider and the exact params.
    function _runHash(address provider, bytes memory params) private pure returns (bytes32) {
        return keccak256(abi.encode(provider, params));
    }

    /// @dev Accept the callback only if it is the run the entry point
    ///      committed to, and spend the commitment so no second callback
    ///      (nested or repeated) can run inside the same owner call.
    function _consumeRun(address provider, bytes memory params) private {
        bytes32 expected = _expectedRun;
        if (expected == bytes32(0) || expected != _runHash(provider, params)) revert NotInFlight();
        _expectedRun = bytes32(0);
    }

    // ─── Shared post-flash-loan logic ────────────────────────────────

    /// @dev Decode `params`, approve the DIAMOND, trigger the
    ///      discounted liquidation, then run the off-chain-supplied
    ///      swap to convert the seized collateral back to the
    ///      principal asset.
    ///
    ///      Every figure is measured against THIS run's entry snapshot,
    ///      never against the contract's absolute balance (#961). The
    ///      contract keeps earned profit between liquidations until the
    ///      owner sweeps it, so an absolute check would let a
    ///      loss-making swap pass by spending that standing balance and
    ///      still report a positive `netProfit`. The run must return at
    ///      least its own flash-loan fee plus `minProfit` on top of what it
    ///      started with, or it reverts. Likewise only collateral that
    ///      arrived from the Diamond in this run is offered to the swap,
    ///      and only the `sellAmount` the swap was quoted for.
    function _runLiquidation(
        address principalAsset,
        uint256 totalDebt,
        uint256 fee,
        bytes memory params
    ) internal {
        Run memory r = abi.decode(params, (Run));

        // 0. Entry snapshot. It already includes the flash-loaned
        // `totalDebt`; repaying `totalDebt + fee` leaves the standing
        // balance intact only if the run ends at or above
        // `principalAtEntry + fee`.
        uint256 principalAtEntry = IERC20(principalAsset).balanceOf(address(this));

        // 1–3. Pay the debt and measure the seizure.
        uint256 collateralSeized = _seize(r, principalAsset, totalDebt);

        // 4. Swap `sellAmount` of collateral → principal using off-chain
        // calldata quoted for exactly that amount.
        uint256 swapProceeds = _swap(r, principalAsset);

        // 5. This run must cover its own flash-loan fee and `minProfit`
        // without touching the standing balance it started with.
        uint256 needed = principalAtEntry + fee;
        uint256 finalBalance = IERC20(principalAsset).balanceOf(address(this));
        if (finalBalance < needed + r.minProfit) {
            revert InsufficientPostSwapBalance(needed + r.minProfit, finalBalance);
        }

        emit FlashLoanLiquidationCompleted(
            r.loanId,
            principalAsset,
            r.collateralAsset,
            totalDebt,
            fee,
            collateralSeized,
            r.sellAmount,
            swapProceeds,
            finalBalance - needed /* this run's net profit */
        );
    }

    /// @dev Approve the DIAMOND for the debt it previewed in this
    ///      transaction (#2697), which is what it pulls; trigger the
    ///      liquidation with this contract as recipient; clear the
    ///      allowance whatever it consumed; and return the collateral that
    ///      arrived in this run. The preview already promised at least
    ///      `sellAmount`; measured again because a balance is the only
    ///      figure this contract trusts.
    function _seize(Run memory r, address principalAsset, uint256 totalDebt)
        private
        returns (uint256 collateralSeized)
    {
        uint256 collateralAtEntry = IERC20(r.collateralAsset).balanceOf(address(this));
        IERC20(principalAsset).forceApprove(DIAMOND, totalDebt);
        IDiscountedLiquidationDiamond(DIAMOND).triggerLiquidationDiscounted(
            r.loanId,
            address(this),
            "" /* extraData reserved for v2 */
        );
        IERC20(principalAsset).forceApprove(DIAMOND, 0);
        uint256 collateralNow = IERC20(r.collateralAsset).balanceOf(address(this));
        collateralSeized = collateralNow > collateralAtEntry ? collateralNow - collateralAtEntry : 0;
        if (collateralSeized < r.sellAmount) revert SeizureBelowQuote(collateralSeized, r.sellAmount);
    }

    /// @dev Offer exactly `sellAmount` of collateral to the swap and return
    ///      the principal it delivered. The keeper bot computed the route +
    ///      min-output; if the realised proceeds do not cover the flash loan,
    ///      its fee and `minProfit`, the caller's balance check reverts the
    ///      whole tx.
    function _swap(Run memory r, address principalAsset) private returns (uint256 swapProceeds) {
        if (r.sellAmount == 0) return 0;
        IERC20(r.collateralAsset).forceApprove(r.swapAllowanceTarget, r.sellAmount);
        uint256 principalBefore = IERC20(principalAsset).balanceOf(address(this));
        (bool ok, ) = r.swapTarget.call(r.swapCalldata);
        if (!ok) revert SwapFailed();
        uint256 principalAfter = IERC20(principalAsset).balanceOf(address(this));
        swapProceeds = principalAfter > principalBefore ? principalAfter - principalBefore : 0;
        // Clean up the allowance — defence-in-depth against an
        // aggregator that pulled less than approved.
        IERC20(r.collateralAsset).forceApprove(r.swapAllowanceTarget, 0);
    }

    // ─── Owner withdraw / rescue ─────────────────────────────────────

    /// @notice Sweep `amount` of `token` to the OWNER. Used to
    ///         pull accumulated profit after each successful
    ///         liquidation. Passing `address(0)` sweeps native
    ///         ETH (in case any drifts in from an aggregator).
    function withdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok, ) = payable(OWNER).call{value: amount}("");
            require(ok, "eth send");
        } else {
            IERC20(token).safeTransfer(OWNER, amount);
        }
        emit Withdrawn(token, amount);
    }

    /// @notice Allow native ETH receipts so aggregators that route
    ///         through WETH unwrap can settle here.
    receive() external payable {}
}
