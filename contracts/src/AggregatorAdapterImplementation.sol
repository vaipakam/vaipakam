// src/AggregatorAdapterImplementation.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title  IVaipakamIntentSurface
 * @notice The minimal slice of the Vaipakam Diamond the aggregator adapter
 *         calls / reads. The adapter is an external contract acting as its own
 *         Vaipakam lender, so it talks to the Diamond through this typed
 *         interface rather than cross-facet `address(this).call`.
 */
interface IVaipakamIntentSurface {
    function setLenderIntent(
        address lendingAsset,
        address collateralAsset,
        uint256 maxExposure,
        uint256 minRateBps,
        uint16 maxInitLtvBps,
        uint32 maxDurationDays,
        uint256 minFillAmount,
        bool requiresKeeperAuth,
        bool riskAndTermsConsent
    ) external;

    function cancelLenderIntent(address lendingAsset, address collateralAsset)
        external;

    function fundLenderIntent(
        address lendingAsset,
        address collateralAsset,
        uint256 amount
    ) external;

    function withdrawLenderIntentCapital(
        address lendingAsset,
        address collateralAsset,
        uint256 amount
    ) external;

    function getLenderIntentCapital(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) external view returns (uint256);

    function getLenderIntentLivePrincipal(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) external view returns (uint256);

    function setKeeperAccess(bool enabled) external;

    function approveKeeper(address keeper, uint8 actions) external;
}

/**
 * @title  AggregatorAdapterImplementation
 * @author Vaipakam Developer Team
 * @notice #398 / #401 v1.5 — the outward **ERC-4626 lender adapter**. One
 *         instance per aggregator (deployed by `AggregatorAdapterFactoryFacet`
 *         as an `ERC1967Proxy` over this shared UUPS implementation). The
 *         adapter *is itself a Vaipakam lender*: a yield aggregator deposits the
 *         lending asset through the standard ERC-4626 face, and the adapter
 *         routes that capital into its own standing `LenderIntent`
 *         (`fundLenderIntent`) where keepers match (`matchIntent`) and auto-roll
 *         (`rollIntentLoan`) it. Withdrawals pull un-lent capital back
 *         (`withdrawLenderIntentCapital`).
 *
 * @dev    E1 single-principal, enforced at BOTH layers:
 *           - `deposit`/`mint` are restricted to the one `authorizedPrincipal`
 *             (both caller and receiver);
 *           - shares are **non-transferable** (only mint/burn) — otherwise the
 *             principal could transfer ERC-20 shares and re-create
 *             multi-principal exposure on one Vaipakam vault.
 *         The aggregator's retail depositors commingle *inside the aggregator*,
 *         off-Vaipakam. We adopt the ERC-4626 interface, never pooled custody.
 *
 *         NAV (`totalAssets`) is conservative: idle intent capital (which
 *         already reflects collected + auto-rolled interest) + live principal
 *         marked at FACE minus a per-asset `haircutBps`; accrued-but-unpaid
 *         interest is excluded until a roll realizes it into idle.
 *         `maxWithdraw`/`maxRedeem` are capped to **idle** (capital out on live
 *         loans is illiquid until it repays).
 *
 *         UUPS-upgradeable; owner = the Diamond. Routine upgrades are
 *         aggregator-pull (the factory's `upgradeAggregatorAdapter`); a
 *         governance mandate floor can force a critical fix. See
 *         docs/DesignsAndPlans/AggregatorAdapterV15Design.md.
 */
contract AggregatorAdapterImplementation is
    ERC4626Upgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    /// @dev BPS denominator (matches `LibVaipakam.BASIS_POINTS`).
    uint16 internal constant BASIS_POINTS = 10_000;
    /// @dev Upper bound on the NAV haircut — a live-principal mark can be
    ///      discounted by at most 50%; a higher haircut would understate NAV
    ///      so severely it signals a misconfig.
    uint16 internal constant MAX_HAIRCUT_BPS = 5_000;

    /// @notice The Vaipakam Diamond (this adapter's `owner` + intent surface).
    address public diamond;
    /// @notice The single authorized aggregator — the only address that may
    ///         deposit/mint and the only permitted share holder.
    address public authorizedPrincipal;
    /// @notice The intent's collateral asset (the ERC-4626 `asset()` is the
    ///         lending asset). One adapter = one (lendingAsset, collateralAsset)
    ///         pair.
    address public collateralAsset;
    /// @notice Per-asset NAV haircut applied to live (outstanding) principal in
    ///         `totalAssets`. Governance-settable (owner = Diamond).
    uint16 public haircutBps;

    /// @notice Raised on a share transfer between non-zero holders (shares are
    ///         non-transferable to preserve the E1 single-principal property).
    error SharesNonTransferable();
    /// @notice Raised when a caller other than the authorized aggregator tries
    ///         to deposit/mint, or when the receiver isn't the principal.
    error NotAuthorizedPrincipal();
    /// @notice Raised when `haircutBps` is set above `MAX_HAIRCUT_BPS`.
    error HaircutTooHigh();
    /// @notice Raised on a zero-address constructor/init argument.
    error ZeroAddress();

    /// @notice The governance haircut was updated.
    event HaircutBpsSet(uint16 oldBps, uint16 newBps);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize a freshly-deployed adapter proxy.
     * @dev Called once by the factory immediately after proxy deployment. Sets
     *      the Diamond as owner, records the principal + pair + haircut, and —
     *      acting as itself against the Diamond — registers the standing intent
     *      (keeper-gated) and authorizes the designated keeper for fills +
     *      auto-roll. The aggregator funds via {deposit} afterward.
     * @param diamondAddress     The Vaipakam Diamond.
     * @param principal          The single authorized aggregator.
     * @param lendingAsset       ERC-4626 underlying = the asset lent.
     * @param collateralAsset_   The collateral the intent accepts.
     * @param haircutBps_        Initial NAV haircut on live principal.
     * @param keeper             The designated keeper authorized to fill +
     *                           auto-roll this adapter's intent.
     * @param name_              ERC-20 share name.
     * @param symbol_            ERC-20 share symbol.
     * @param intentMaxExposure  Intent bound: max live principal at once.
     * @param intentMinRateBps   Intent bound: APR floor.
     * @param intentMaxInitLtvBps Intent bound: init-LTV ceiling.
     * @param intentMaxDurationDays Intent bound: longest term.
     * @param intentMinFillAmount Intent bound: smallest slice.
     */
    function initialize(
        address diamondAddress,
        address principal,
        address lendingAsset,
        address collateralAsset_,
        uint16 haircutBps_,
        address keeper,
        string memory name_,
        string memory symbol_,
        uint256 intentMaxExposure,
        uint256 intentMinRateBps,
        uint16 intentMaxInitLtvBps,
        uint32 intentMaxDurationDays,
        uint256 intentMinFillAmount
    ) external initializer {
        if (
            diamondAddress == address(0) ||
            principal == address(0) ||
            lendingAsset == address(0) ||
            collateralAsset_ == address(0) ||
            keeper == address(0)
        ) revert ZeroAddress();
        if (haircutBps_ > MAX_HAIRCUT_BPS) revert HaircutTooHigh();

        __ERC4626_init(IERC20(lendingAsset));
        __ERC20_init(name_, symbol_);
        __Ownable_init(diamondAddress); // Diamond owns the adapter (UUPS auth)

        diamond = diamondAddress;
        authorizedPrincipal = principal;
        collateralAsset = collateralAsset_;
        haircutBps = haircutBps_;

        // Register the standing intent as ourselves, keeper-gated, and authorize
        // the designated keeper for fills + auto-roll. `requiresKeeperAuth=true`
        // so only the curated keeper fills/rolls this adapter's capital.
        IVaipakamIntentSurface d = IVaipakamIntentSurface(diamondAddress);
        d.setLenderIntent(
            lendingAsset,
            collateralAsset_,
            intentMaxExposure,
            intentMinRateBps,
            intentMaxInitLtvBps,
            intentMaxDurationDays,
            intentMinFillAmount,
            true, // requiresKeeperAuth
            true // riskAndTermsConsent
        );
        d.setKeeperAccess(true);
        d.approveKeeper(keeper, _signedFillAndAutoRollMask());
    }

    // ─── NAV (conservative-haircut mark) ────────────────────────────────────

    /// @inheritdoc ERC4626Upgradeable
    /// @dev idle (un-lent intent capital, incl. realized/auto-rolled interest)
    ///      + live principal marked at FACE − `haircutBps`. Unrealized interest
    ///      is excluded (live counts original principal only; a roll realizes
    ///      interest into idle). See design §5.
    function totalAssets() public view override returns (uint256) {
        IVaipakamIntentSurface d = IVaipakamIntentSurface(diamond);
        address lend = asset();
        uint256 idle = d.getLenderIntentCapital(address(this), lend, collateralAsset);
        uint256 live = d.getLenderIntentLivePrincipal(
            address(this),
            lend,
            collateralAsset
        );
        uint256 riskAdjustedLive =
            (live * (BASIS_POINTS - haircutBps)) / BASIS_POINTS;
        return idle + riskAdjustedLive;
    }

    /// @notice Idle (immediately withdrawable) intent capital.
    function idleAssets() public view returns (uint256) {
        return
            IVaipakamIntentSurface(diamond).getLenderIntentCapital(
                address(this),
                asset(),
                collateralAsset
            );
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Capped to idle — capital out on live loans is illiquid until it
    ///      repays + rolls back to idle.
    function maxWithdraw(address owner)
        public
        view
        override
        returns (uint256)
    {
        uint256 byShares = super.maxWithdraw(owner);
        uint256 idle = idleAssets();
        return byShares < idle ? byShares : idle;
    }

    /// @inheritdoc ERC4626Upgradeable
    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 byShares = super.maxRedeem(owner);
        uint256 idleShares = convertToShares(idleAssets()); // rounds down
        return byShares < idleShares ? byShares : idleShares;
    }

    // ─── Deposit / withdraw — route through the intent layer ────────────────

    /// @dev Gate to the single authorized principal, then pull + mint via OZ,
    ///      then deploy the pulled assets into the standing intent.
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        if (caller != authorizedPrincipal || receiver != authorizedPrincipal) {
            revert NotAuthorizedPrincipal();
        }
        // OZ: safeTransferFrom(caller -> this, assets) + _mint(receiver, shares).
        super._deposit(caller, receiver, assets, shares);
        // Deploy the just-pulled assets into the intent: approve the Diamond's
        // chokepoint allowance, then fund (Diamond pulls this -> our vault, liens
        // as idle intent capital).
        address lend = asset();
        IERC20(lend).forceApprove(diamond, assets);
        IVaipakamIntentSurface(diamond).fundLenderIntent(
            lend,
            collateralAsset,
            assets
        );
    }

    /// @dev Pull the un-lent capital back from the intent (Diamond -> this),
    ///      then burn + transfer to the receiver via OZ. `maxWithdraw` already
    ///      bounds `assets` to idle, so the pull always covers the transfer.
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        IVaipakamIntentSurface(diamond).withdrawLenderIntentCapital(
            asset(),
            collateralAsset,
            assets
        );
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    // ─── E1 — non-transferable shares ───────────────────────────────────────

    /// @dev Permit only mint (`from == 0`) and burn (`to == 0`). Any
    ///      holder→holder transfer reverts — the share layer must stay
    ///      single-principal (gating deposits alone is insufficient).
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from != address(0) && to != address(0)) {
            revert SharesNonTransferable();
        }
        super._update(from, to, value);
    }

    // ─── Governance ─────────────────────────────────────────────────────────

    /// @notice Update the NAV haircut on live principal. owner = Diamond, so
    ///         this is governance-gated (called via a Diamond facet).
    function setHaircutBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_HAIRCUT_BPS) revert HaircutTooHigh();
        uint16 old = haircutBps;
        haircutBps = newBps;
        emit HaircutBpsSet(old, newBps);
    }

    // ─── UUPS ───────────────────────────────────────────────────────────────

    /// @dev owner = Diamond; the factory's `upgradeAggregatorAdapter` triggers
    ///      the UUPS `upgradeToAndCall` through the Diamond (the owner).
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── helpers ────────────────────────────────────────────────────────────

    /// @dev `KEEPER_ACTION_SIGNED_FILL (0x40) | KEEPER_ACTION_AUTO_ROLL (0x80)`.
    ///      Inlined to avoid importing LibVaipakam into the adapter.
    function _signedFillAndAutoRollMask() private pure returns (uint8) {
        return 0x40 | 0x80; // 0xC0
    }
}
