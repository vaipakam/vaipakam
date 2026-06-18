// src/BackstopVaultImplementation.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibVaipakam} from "./libraries/LibVaipakam.sol";
import {LibSwap} from "./libraries/LibSwap.sol";

/**
 * @title  IBackstopDiamond
 * @notice The minimal slice of the Vaipakam Diamond the backstop vault calls as
 *         its own Vaipakam lender (msg.sender == this vault). The single behaviour
 *         the vault adds over the Diamond is being a distinct, protocol-owned
 *         lender-of-record address; ALL policy (kill-switches, the on-chain
 *         `backstopEligibleAfter` trigger, treasury seeding, caps) lives in
 *         `BackstopFacet`, which has direct storage access — the vault is a thin,
 *         owner-gated executor of as-self Diamond calls.
 */
interface IBackstopDiamond {
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

    function withdrawLenderIntentCapital(
        address lendingAsset,
        address collateralAsset,
        uint256 amount
    ) external;

    function matchIntent(
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint256 counterpartyOfferId,
        uint256 fillAmount
    ) external returns (uint256 loanId);

    function claimAsLenderWithRetry(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    ) external;

    function getLoanDetails(uint256 loanId)
        external
        view
        returns (LibVaipakam.Loan memory);
}

/**
 * @title  BackstopVaultImplementation
 * @notice #399 backstop v0 — the single, treasury-seeded, protocol-owned Vaipakam
 *         lender-of-last-resort. Reuses the `LenderIntent` substrate (like the
 *         #398 aggregator adapter) but is NOT an ERC-4626 vault: there is one
 *         protocol principal (the treasury), so there are no shares to tokenise
 *         and nothing to segregate per-asset (that arrives with the v1 LP
 *         tranche). It holds per-asset-pair `LenderIntent`s in its own per-user
 *         vault and acts as the lender for backstop-originated loans.
 *
 * @dev    UUPS, owner = the Vaipakam Diamond, which upgrades it directly via
 *         governance/timelock (no aggregator-pull model — it is protocol-owned).
 *         Every state-mutating method is `onlyOwner`, i.e. only `BackstopFacet`
 *         (running in the Diamond's context) can drive it; the facet enforces the
 *         policy gates before each call. See
 *         `docs/DesignsAndPlans/BackstopVaultV0Design.md`.
 */
contract BackstopVaultImplementation is
    OwnableUpgradeable,
    UUPSUpgradeable,
    IERC721Receiver
{
    using SafeERC20 for IERC20;

    /// @notice The Vaipakam Diamond (== owner). Set once at init.
    address public diamond;

    /// @notice Initialize must be invoked by the Diamond deploy path.
    error NotDiamond();
    /// @notice Zero address supplied where a contract is required.
    error ZeroAddress();
    /// @notice A safe-transferred ERC721 isn't a Diamond mint to this vault.
    error UnexpectedNFT();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize a freshly-deployed backstop-vault proxy.
     * @dev Called once by `BackstopFacet.provisionBackstopVault` immediately after
     *      proxy deployment, from the Diamond's context — so `msg.sender ==
     *      diamondAddress`. Sets the Diamond as owner (UUPS auth). No intent is
     *      registered here; governance registers per-asset intents afterward via
     *      {setIntent}.
     * @param diamondAddress The Vaipakam Diamond.
     */
    function initialize(address diamondAddress) external initializer {
        if (msg.sender != diamondAddress) revert NotDiamond();
        if (diamondAddress == address(0)) revert ZeroAddress();
        __Ownable_init(diamondAddress);
        diamond = diamondAddress;
    }

    // ─── Owner-only intent forwarders (run AS the vault) ────────────────────

    /**
     * @notice Register / update a per-asset-pair standing intent as the vault.
     * @dev `requiresKeeperAuth = true` with NO keeper grant — SELF-ONLY: only
     *      {executeFill} (invoked by `BackstopFacet.backstopFill` after the §4
     *      gates) can drive `matchIntent` for the backstop, closing the open-
     *      `matchIntent` bypass. `riskAndTermsConsent = true` (treasury capital
     *      consents to the fallback terms). Governance-set bounds (the per-asset
     *      capacity cap / posted rate / LTV ceiling) come in via the facet.
     */
    function setIntent(
        address lend,
        address coll,
        uint256 maxExposure,
        uint256 minRateBps,
        uint16 maxInitLtvBps,
        uint32 maxDurationDays,
        uint256 minFillAmount
    ) external onlyOwner {
        IBackstopDiamond(diamond).setLenderIntent(
            lend,
            coll,
            maxExposure,
            minRateBps,
            maxInitLtvBps,
            maxDurationDays,
            minFillAmount,
            true, // requiresKeeperAuth — self-only
            true // riskAndTermsConsent
        );
    }

    /**
     * @notice Originate a backstop loan against `offerId` as the lender.
     * @dev onlyOwner: `BackstopFacet.backstopFill` validates the on-chain trigger
     *      (kill-switches, `backstopEligibleAfter`, unfilled remainder, !accepted,
     *      !expired) and the §5b collateral gates, THEN calls this. The vault is
     *      the intent owner, so `matchIntent`'s self-branch authorizes it.
     */
    function executeFill(
        address lend,
        address coll,
        uint256 offerId,
        uint256 fillAmount
    ) external onlyOwner returns (uint256 loanId) {
        loanId = IBackstopDiamond(diamond).matchIntent(
            address(this),
            lend,
            coll,
            offerId,
            fillAmount
        );
    }

    /**
     * @notice Claim a resolved backstop loan's proceeds and forward them to the
     *         Diamond (treasury) for recording by the facet.
     * @dev onlyOwner. `claimAsLenderWithRetry` pays the lender (this vault) the
     *      proceeds as a RAW token balance (not into the per-user vault). The
     *      paid asset is NOT always `principalAsset`: on a proper repayment (or a
     *      retry that swaps collateral→principal) the vault receives principal, but
     *      on a default/fallback that resolves WITHOUT a swap — e.g. the collateral
     *      went illiquid or value-collapsed AFTER origination (it was liquid at
     *      `backstopFill` time, so the loan was allowed) — `claimAsLenderWithRetry`
     *      pays out the raw COLLATERAL token instead. So we measure and forward the
     *      deltas of BOTH the principal and the collateral asset, returning both so
     *      the facet credits each to `treasuryBalances`. Snapshot both balances
     *      BEFORE the claim (the principal forward below would otherwise corrupt a
     *      same-asset collateral delta). The facet has already verified the loan is
     *      a backstop-originated loan (`lender == this`).
     */
    function executeClaim(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    )
        external
        onlyOwner
        returns (
            address principalAsset,
            uint256 principalRecovered,
            address collateralAsset,
            uint256 collateralRecovered
        )
    {
        LibVaipakam.Loan memory loan = IBackstopDiamond(diamond).getLoanDetails(
            loanId
        );
        principalAsset = loan.principalAsset;
        collateralAsset = loan.collateralAsset;
        uint256 principalBefore = IERC20(principalAsset).balanceOf(address(this));
        bool distinctCollateral = collateralAsset != principalAsset;
        uint256 collateralBefore = distinctCollateral
            ? IERC20(collateralAsset).balanceOf(address(this))
            : 0;
        IBackstopDiamond(diamond).claimAsLenderWithRetry(loanId, retryCalls);
        principalRecovered =
            IERC20(principalAsset).balanceOf(address(this)) - principalBefore;
        if (principalRecovered > 0) {
            IERC20(principalAsset).safeTransfer(diamond, principalRecovered);
        }
        // Only forward the collateral leg when it is a DISTINCT token; a
        // same-asset loan already counted the whole delta as `principalRecovered`.
        if (distinctCollateral) {
            collateralRecovered =
                IERC20(collateralAsset).balanceOf(address(this)) - collateralBefore;
            if (collateralRecovered > 0) {
                IERC20(collateralAsset).safeTransfer(diamond, collateralRecovered);
            }
        }
    }

    /**
     * @notice Release `amount` of idle intent capital and forward it to the
     *         Diamond (treasury) for recording by the facet.
     * @dev onlyOwner. `withdrawLenderIntentCapital` returns the un-lent capital to
     *      the vault as a raw balance; the delta is forwarded to the Diamond.
     */
    function withdrawIdleToDiamond(
        address lend,
        address coll,
        uint256 amount
    ) external onlyOwner returns (uint256 returned) {
        uint256 before = IERC20(lend).balanceOf(address(this));
        IBackstopDiamond(diamond).withdrawLenderIntentCapital(lend, coll, amount);
        returned = IERC20(lend).balanceOf(address(this)) - before;
        if (returned > 0) IERC20(lend).safeTransfer(diamond, returned);
    }

    /**
     * @notice Recover a raw ERC20 balance to `to` (the Diamond/treasury).
     * @dev onlyOwner. For any residue that lands raw on the vault (e.g. a VPFI
     *      matcher kickback). The facet records the treasury credit.
     */
    function sweepToken(address token, address to)
        external
        onlyOwner
        returns (uint256 bal)
    {
        bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(to, bal);
    }

    /**
     * @notice Recover a FOREIGN ERC721 (sent via a non-safe `transferFrom`) to
     *         `to`. Vaipakam protocol NFTs (`nft == diamond`) are NOT sweepable —
     *         the vault's own lender-position NFTs must stay put.
     * @dev onlyOwner; plain `transferFrom` so a contract recipient without a
     *      receiver hook can still receive it.
     */
    function sweepNFT(address nft, uint256 tokenId, address to)
        external
        onlyOwner
    {
        if (nft == diamond) revert UnexpectedNFT();
        IERC721(nft).transferFrom(address(this), to, tokenId);
    }

    // ─── ERC721 receiver ────────────────────────────────────────────────────

    /// @notice Accept ONLY the Diamond's mints to this vault — the transient
    ///         intent-slice `OfferCreated` NFT AND the final lender-position NFT
    ///         (both `_safeMint`ed by the Diamond with `from == address(0)`).
    ///         Reject any other safe-transferred ERC721 (the vault is
    ///         ERC20-on-ERC20 with no NFT use; a foreign NFT would be stuck).
    ///         Non-safe `transferFrom`s bypass this hook — recover those via
    ///         {sweepNFT}.
    function onERC721Received(
        address,
        address from,
        uint256,
        bytes calldata
    ) external view override returns (bytes4) {
        if (msg.sender != diamond || from != address(0)) revert UnexpectedNFT();
        return IERC721Receiver.onERC721Received.selector;
    }

    // ─── UUPS ───────────────────────────────────────────────────────────────

    /// @dev owner = Diamond; governance upgrades directly (protocol-owned).
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
