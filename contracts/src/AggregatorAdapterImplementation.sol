// src/AggregatorAdapterImplementation.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {LibVaipakam} from "./libraries/LibVaipakam.sol";
import {LibSwap} from "./libraries/LibSwap.sol";

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

    function isSanctionedAddress(address who) external view returns (bool);

    function claimAsLender(uint256 loanId) external;

    function claimAsLenderWithRetry(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    ) external;

    function matchIntent(
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint256 counterpartyOfferId,
        uint256 fillAmount
    ) external returns (uint256 loanId);

    function rollIntentLoan(uint256 loanId) external;

    function getLenderIntent(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) external view returns (LibVaipakam.LenderIntent memory);

    function getLoanDetails(uint256 loanId)
        external
        view
        returns (LibVaipakam.Loan memory);

    function isAssetPaused(address asset) external view returns (bool);

    function paused() external view returns (bool);

    function getAggregatorAdapterVersion(address adapter)
        external
        view
        returns (uint256);

    function mandatoryAggregatorAdapterVersion() external view returns (uint256);
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
    UUPSUpgradeable,
    IERC721Receiver
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
    /// @notice The designated keeper that drives matching + auto-roll — but ONLY
    ///         through this adapter's `matchLoan` / `rollLoan` forwarders, never
    ///         the Diamond directly (the intent is keeper-gated and the adapter
    ///         grants no Diamond-level keeper authority). Routing through the
    ///         adapter is what lets every value-moving path screen the REAL
    ///         principal (#626 round-2 P1).
    address public keeper;

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
    /// @notice Raised when the authorized principal is sanctioned and tries to
    ///         deposit new capital (Tier-1 — funding screens the REAL principal,
    ///         not the always-clean adapter address).
    error PrincipalSanctioned();
    /// @notice Raised when a withdraw/redeem caller, owner, or receiver isn't
    ///         the authorized principal (no approved-spender exit).
    error WithdrawNotPrincipal();
    /// @notice Raised when a match/roll forwarder caller is neither the
    ///         designated keeper nor the authorized principal.
    error NotKeeperOrPrincipal();
    /// @notice Raised when the adapter is below a mandated upgrade floor and a
    ///         new deposit is attempted (upgrade-or-halt; exit stays open).
    error AdapterUpgradeRequired();
    /// @notice Raised when `initialize` is called by anyone other than the
    ///         Diamond (the factory deploy path) — blocks rogue adapter proxies.
    error NotDiamond();
    /// @notice Raised when `claimAndCompound` targets a loan this adapter is not
    ///         the lender-of-record on (a foreign position NFT dumped on it).
    error NotAdapterLoan();

    /// @notice The governance haircut was updated.
    event HaircutBpsSet(uint16 oldBps, uint16 newBps);
    /// @notice The principal wound the standing intent down (cancel + keeper off).
    event IntentWoundDown(address indexed principal);
    /// @notice A resolved-but-non-rollable loan's proceeds were claimed back into
    ///         the adapter and re-funded into the intent (re-entering idle/NAV).
    event LoanClaimedAndCompounded(uint256 indexed loanId, uint256 amount);

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
     * @param keeper_            The designated keeper authorized to fill +
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
        address keeper_,
        string memory name_,
        string memory symbol_,
        uint256 intentMaxExposure,
        uint256 intentMinRateBps,
        uint16 intentMaxInitLtvBps,
        uint32 intentMaxDurationDays,
        uint256 intentMinFillAmount
    ) external initializer {
        // #626 round-4 P2 — only the Diamond (the factory deploy path) may
        // initialize an adapter. The factory deploys the proxy from the Diamond's
        // context, so the constructor's delegatecall to `initialize` preserves
        // `msg.sender == diamondAddress`. A rogue proxy over the shared impl
        // (msg.sender = attacker ≠ the real Diamond) is rejected.
        if (msg.sender != diamondAddress) revert NotDiamond();
        if (
            diamondAddress == address(0) ||
            principal == address(0) ||
            lendingAsset == address(0) ||
            collateralAsset_ == address(0) ||
            keeper_ == address(0)
        ) revert ZeroAddress();
        if (haircutBps_ > MAX_HAIRCUT_BPS) revert HaircutTooHigh();

        __ERC4626_init(IERC20(lendingAsset));
        __ERC20_init(name_, symbol_);
        __Ownable_init(diamondAddress); // Diamond owns the adapter (UUPS auth)

        diamond = diamondAddress;
        authorizedPrincipal = principal;
        collateralAsset = collateralAsset_;
        haircutBps = haircutBps_;
        keeper = keeper_;

        // Register the standing intent as ourselves, KEEPER-GATED. We grant NO
        // Diamond-level keeper authority: matching + auto-roll run ONLY through
        // this adapter's `matchLoan` / `rollLoan` forwarders (which call the
        // Diamond as the intent owner — the self-branch of the keeper gate — and
        // screen the real principal first). Keeper-gating the intent means no
        // external solver can fill it on the Diamond directly, so every
        // value-moving path passes through the principal screen (#626 round-2 P1).
        IVaipakamIntentSurface(diamondAddress).setLenderIntent(
            lendingAsset,
            collateralAsset_,
            intentMaxExposure,
            intentMinRateBps,
            intentMaxInitLtvBps,
            intentMaxDurationDays,
            intentMinFillAmount,
            true, // requiresKeeperAuth — only the owner (this adapter) may fill
            true // riskAndTermsConsent
        );
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
        // #626 round-5 P2 — `_withdraw` screens the principal (funds-out Tier-1),
        // so advertise 0 when the principal is sanctioned (withdraw would revert).
        if (
            IVaipakamIntentSurface(diamond).isSanctionedAddress(
                authorizedPrincipal
            )
        ) return 0;
        uint256 byShares = super.maxWithdraw(owner);
        uint256 idle = idleAssets();
        return byShares < idle ? byShares : idle;
    }

    /// @inheritdoc ERC4626Upgradeable
    function maxRedeem(address owner) public view override returns (uint256) {
        if (
            IVaipakamIntentSurface(diamond).isSanctionedAddress(
                authorizedPrincipal
            )
        ) return 0;
        uint256 byShares = super.maxRedeem(owner);
        uint256 idleShares = convertToShares(idleAssets()); // rounds down
        return byShares < idleShares ? byShares : idleShares;
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev #626 Codex P2 — advertise 0 for any receiver other than the
    ///      principal, AND 0 whenever a deposit would revert because funding the
    ///      intent isn't currently possible (wound down, asset paused, or below
    ///      a mandated upgrade floor) — ERC-4626 routers read this before
    ///      depositing.
    function maxDeposit(address receiver)
        public
        view
        override
        returns (uint256)
    {
        if (receiver != authorizedPrincipal || !_fundingOpen()) return 0;
        return super.maxDeposit(receiver);
    }

    /// @inheritdoc ERC4626Upgradeable
    function maxMint(address receiver) public view override returns (uint256) {
        if (receiver != authorizedPrincipal || !_fundingOpen()) return 0;
        return super.maxMint(receiver);
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
        // #626 round-1 P1 — Tier-1 sanctions screen on the REAL principal. The
        // Diamond's `fundLenderIntent` gate only sees `msg.sender == this`
        // (always clean), so a sanctioned aggregator could otherwise fund new
        // capital through its clean adapter. (Withdraw stays open — Tier-2.)
        _screenPrincipal();
        // #626 round-2 P1 — enforce the mandatory upgrade floor on new deposits
        // (upgrade-or-halt). `fundLenderIntent` doesn't know the adapter version,
        // so check it here; the intent-active + asset-pause cases are enforced
        // downstream by `fundLenderIntent` itself.
        _requireUpToDate();
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
        // #626 Codex P2 — the share token is non-transferable, but ERC-4626
        // `withdraw`/`redeem` would still let an ERC-20-APPROVED spender pull
        // idle assets to an arbitrary receiver, re-creating multi-principal
        // exposure. Require all three roles to be the principal.
        if (
            caller != authorizedPrincipal ||
            owner != authorizedPrincipal ||
            receiver != authorizedPrincipal
        ) {
            revert WithdrawNotPrincipal();
        }
        // #626 round-3 P1 — funds-OUT to a sanctioned principal is a Tier-1
        // violation (same as `claimAsLender`). The Diamond-side
        // `withdrawLenderIntentCapital` gate only sees the clean adapter, so
        // screen the REAL principal here. Funds stay locked (not released to an
        // OFAC-listed wallet) until the screen clears.
        _screenPrincipal();
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

    // ─── Keeper-driven matching + auto-roll (screened forwarders) ───────────

    /// @dev Caller must be the designated keeper or the principal.
    function _onlyKeeperOrPrincipal() private view {
        if (msg.sender != keeper && msg.sender != authorizedPrincipal) {
            revert NotKeeperOrPrincipal();
        }
    }

    /// @dev Tier-1 screen on the REAL aggregator. Routing match/roll through the
    ///      adapter (which knows the principal) is the only way to screen it —
    ///      the Diamond only ever sees `msg.sender == adapter` (always clean).
    function _screenPrincipal() private view {
        if (
            IVaipakamIntentSurface(diamond).isSanctionedAddress(
                authorizedPrincipal
            )
        ) revert PrincipalSanctioned();
    }

    /// @notice Keeper/principal: fill this adapter's intent against an on-chain
    ///         borrower offer. Routed through the adapter (calling `matchIntent`
    ///         as the intent owner, the keeper-gate self-branch) so the REAL
    ///         principal is sanctions-screened before new lending — closing the
    ///         clean-adapter bypass (#626 round-2 P1).
    function matchLoan(uint256 counterpartyOfferId, uint256 fillAmount)
        external
        returns (uint256 loanId)
    {
        _onlyKeeperOrPrincipal();
        _screenPrincipal();
        _requireUpToDate();
        loanId = IVaipakamIntentSurface(diamond).matchIntent(
            address(this),
            asset(),
            collateralAsset,
            counterpartyOfferId,
            fillAmount
        );
    }

    /// @notice Keeper/principal: auto-roll a repaid adapter loan (re-lien its
    ///         proceeds into the intent). Same principal-screen as `matchLoan` —
    ///         re-committing proceeds is new lending, so a sanctioned aggregator
    ///         cannot keep compounding through the clean adapter.
    function rollLoan(uint256 loanId) external {
        _onlyKeeperOrPrincipal();
        _screenPrincipal();
        _requireUpToDate();
        IVaipakamIntentSurface(diamond).rollIntentLoan(loanId);
    }

    // ─── Principal wind-down + recovery (#626 Codex P1/P2) ──────────────────

    /// @notice Principal-only: wind the standing intent down by cancelling it.
    ///         An inactive intent blocks both `matchLoan` (matchIntent rejects
    ///         inactive) and `rollLoan` (rollIntentLoan rejects a cancelled
    ///         intent), so no keeper can re-deploy returned capital while the
    ///         aggregator exits. The intent is keyed to the adapter, so this
    ///         gated forwarder is the only way for the principal to cancel it.
    ///         Idle capital is withdrawn as live loans mature.
    function windDownIntent() external {
        if (msg.sender != authorizedPrincipal) revert NotAuthorizedPrincipal();
        IVaipakamIntentSurface(diamond).cancelLenderIntent(
            asset(),
            collateralAsset
        );
        emit IntentWoundDown(authorizedPrincipal);
    }

    /// @notice Keeper/principal: claim a RESOLVED-but-non-rollable adapter loan's
    ///         proceeds back into the adapter and best-effort re-fund them into
    ///         the intent so they re-enter idle (and thus NAV + redeemable value).
    /// @dev    #626 rounds 1-3. `rollIntentLoan` only handles clean repaid loans;
    ///         a default / fallback / paused-asset / cancelled-intent loan settles
    ///         via the normal lender claim, whose proceeds are owed to the
    ///         lender-NFT owner — this adapter.
    ///         - round-3 P1: gated to keeper/principal (NOT permissionless) and
    ///           takes `retryCalls` → uses `claimAsLenderWithRetry`. A
    ///           `FallbackPending` loan with an EMPTY retry list finalizes the
    ///           fallback distribution, forfeiting a viable swap-retry recovery;
    ///           letting the keeper supply retry calls (and barring randoms from
    ///           force-finalizing) preserves it. Pass an empty array for a clean
    ///           Repaid/Defaulted claim.
    ///         - round-3 P2 + round-1/2: the re-fund is gated by the SAME checks
    ///           as `rollLoan` (real-principal sanctions + mandatory-floor) AND
    ///           best-effort (`try`/`catch` for wound-down / paused). If any
    ///           gate is closed the proceeds stay in the adapter, recoverable by
    ///           the principal via {sweepToPrincipal}. The claim itself ALWAYS
    ///           executes (recovery is never blocked).
    function claimAndCompound(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    ) external {
        _onlyKeeperOrPrincipal();
        // #626 round-4 P2 — only this adapter's OWN intent loans may be claimed
        // here (the adapter is their lender-of-record). A foreign lender-position
        // NFT transferred onto the adapter must not let its proceeds be absorbed
        // into this aggregator's intent/NAV.
        if (
            IVaipakamIntentSurface(diamond).getLoanDetails(loanId).lender !=
            address(this)
        ) revert NotAdapterLoan();
        address lend = asset();
        uint256 before = IERC20(lend).balanceOf(address(this));
        IVaipakamIntentSurface(diamond).claimAsLenderWithRetry(loanId, retryCalls);
        uint256 recovered = IERC20(lend).balanceOf(address(this)) - before;
        if (recovered > 0) {
            // Re-commit is new lending — apply the SAME gates as `rollLoan`
            // (real-principal sanctions + mandatory-floor). If either is closed,
            // or the intent is wound down / asset paused, skip the re-fund and
            // leave the proceeds sweepable by the principal.
            bool gatesOpen = !IVaipakamIntentSurface(diamond)
                .isSanctionedAddress(authorizedPrincipal) &&
                !_belowMandatoryFloor();
            if (gatesOpen) {
                IERC20(lend).forceApprove(diamond, recovered);
                try
                    IVaipakamIntentSurface(diamond).fundLenderIntent(
                        lend,
                        collateralAsset,
                        recovered
                    )
                {} catch {
                    IERC20(lend).forceApprove(diamond, 0); // clear approval
                }
            }
        }
        emit LoanClaimedAndCompounded(loanId, recovered);
    }

    /// @notice Principal-only: sweep any raw `token` balance sitting in the
    ///         adapter (not in the intent) to the principal — including
    ///         COLLATERAL-token proceeds from an in-kind default claim (#626
    ///         round-2 P2), and lending-asset proceeds that couldn't be re-funded
    ///         during a wind-down. Safe: the adapter is single-principal (it owns
    ///         100% of the non-transferable shares) and these raw balances are
    ///         not counted in `totalAssets`, so no shareholder is diluted.
    function sweepToPrincipal(address token) external {
        if (msg.sender != authorizedPrincipal) revert NotAuthorizedPrincipal();
        // #626 round-3 P1 — funds-OUT to the principal: screen it (Tier-1). The
        // recovered value reached the adapter as the clean claimant, so the
        // Diamond's funds-out gate never saw the real principal; block release
        // to an OFAC-listed wallet here.
        _screenPrincipal();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(authorizedPrincipal, bal);
    }

    // ─── ERC721 receiver (#626 Codex P1) ────────────────────────────────────

    /// @notice The adapter is the Vaipakam lender, so `matchIntent` mints it a
    ///         lender-position NFT via `_safeMint` — which requires this hook.
    ///         Without it, every fill reverts and capital can never be lent.
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
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

    /// @dev True when a NEW deposit would fund the intent: at/above any
    ///      mandatory-upgrade floor, intent active, and neither asset paused.
    ///      Used by `maxDeposit`/`maxMint` to advertise 0 when a deposit can't
    ///      succeed.
    function _fundingOpen() private view returns (bool) {
        if (_belowMandatoryFloor()) return false;
        IVaipakamIntentSurface d = IVaipakamIntentSurface(diamond);
        // #626 round-5 P2 — a global Diamond pause makes `fundLenderIntent`
        // (`whenNotPaused`) revert, so advertise 0 during an incident pause.
        if (d.paused()) return false;
        // #626 round-4 P2 — a sanctioned principal can't deposit (`_deposit`
        // reverts), so advertise 0.
        if (d.isSanctionedAddress(authorizedPrincipal)) return false;
        if (!d.getLenderIntent(address(this), asset(), collateralAsset).active) {
            return false;
        }
        if (d.isAssetPaused(asset()) || d.isAssetPaused(collateralAsset)) {
            return false;
        }
        return true;
    }

    /// @dev True when a mandatory upgrade floor is set and this adapter is below
    ///      it. New activity (deposit / match / roll) halts until migrated;
    ///      exit + recovery (withdraw / claim / sweep / wind-down) stay open.
    function _belowMandatoryFloor() private view returns (bool) {
        IVaipakamIntentSurface d = IVaipakamIntentSurface(diamond);
        uint256 floor = d.mandatoryAggregatorAdapterVersion();
        return floor > 0 && d.getAggregatorAdapterVersion(address(this)) < floor;
    }

    /// @dev Revert if below a mandated upgrade floor (upgrade-or-halt).
    function _requireUpToDate() private view {
        if (_belowMandatoryFloor()) revert AdapterUpgradeRequired();
    }
}
