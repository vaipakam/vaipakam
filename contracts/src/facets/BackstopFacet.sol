// src/facets/BackstopFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibBackstopOracleGate} from "../libraries/LibBackstopOracleGate.sol";
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
    /// @notice Raw ERC20 residue on the backstop vault was swept to treasury.
    event BackstopTokenSwept(address indexed token, uint256 amount);
    /// @notice A foreign ERC721 on the backstop vault was swept out.
    event BackstopNFTSwept(
        address indexed nft,
        uint256 tokenId,
        address indexed to
    );
    /// @notice VPFI interaction rewards earned by the backstop were claimed to
    ///         treasury.
    event BackstopRewardsClaimed(address indexed vpfi, uint256 amount);
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
    /// @notice A borrower opted their offer into backstop eligibility.
    event OfferBackstopEligibilitySet(
        uint256 indexed offerId,
        uint64 eligibleAfter
    );
    /// @notice #638 — the backstop min-secondary-oracle-coverage knob changed.
    event BackstopMinSecondaryOracleCoverageSet(uint8 minCoverage);

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
    error OfferNotBackstopEligible();
    error OfferNotBackstopFillable();
    error BackstopDisabled();
    error UpgradeFailed();
    error VPFINotConfigured();
    error VpfiLendingUnsupported();
    error BackstopAbsorbCollateralInsufficient();
    /// @dev #638 — `setBackstopMinSecondaryOracleCoverage` given a value above
    ///      the three available secondaries.
    error BackstopOracleCoverageOutOfRange(uint8 minCoverage);

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
        // Provision the vault as an inherently compliant protocol entity: a
        // backstop fill routes `acceptOfferInternal`, which checks the acceptor's
        // (the vault's) KYC tier on a KYC-enforced deployment. Stamp the top tier
        // here so above-threshold fills don't revert pending an out-of-band admin
        // step. No-op on the retail deploy (enforcement off ⇒ the check short-
        // circuits true); load-bearing only on the KYC-enforced industrial fork.
        // (Country-pair gating on that fork remains operator-provisioned config.)
        s.kycTier[vault] = LibVaipakam.KYCTier.Tier2;
        s.kycVerified[vault] = true;
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
        // VPFI can't back generic intent capital — its discount/staking accounting
        // is bypassed by the generic-custody path, so `fundLenderIntent` /
        // `matchIntent` reject VPFI-denominated lending. `setLenderIntent` blocks it
        // at the root, but `vpfiToken` can be ROTATED onto `lend` AFTER the intent
        // row was created; re-check here so this direct treasury seed can't stage
        // VPFI capital that `matchIntent` would then refuse to fill.
        if (lend == s.vpfiToken) revert VpfiLendingUnsupported();
        // Honor asset pauses, like `fundLenderIntent` does on the normal on-ramp —
        // an asset-pause incident must not let this seed stage new fillable
        // exposure for the paused pair (it would fill the instant the asset
        // unpauses, never passing a live healthy-market check).
        LibFacet.requireAssetNotPaused(lend);
        LibFacet.requireAssetNotPaused(coll);
        uint256 bal = s.treasuryBalances[lend];
        if (bal < amount) revert TreasuryInsufficient();
        s.treasuryBalances[lend] = bal - amount;
        address proxy = VaultFactoryFacet(address(this)).getOrCreateUserVault(
            vault
        );
        IERC20(lend).safeTransfer(proxy, amount);
        LibVaipakam.recordVaultDeposit(vault, lend, amount);
        LibEncumbrance.lienIntentCapital(vault, lend, coll, amount);
        // #625 WI-2a — the backstop seeds intent capital DIRECTLY (not via
        // `fundLenderIntent`), so sync the discovery registry here too — else the
        // backstop's funded intent would never appear in the keeper feed.
        LibVaipakam.syncIntentRegistry(vault, lend, coll);
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

    /// @notice Revert unless `o` is a shape the backstop can actually fill.
    /// @dev Checked at BOTH opt-in ({setOfferBackstopEligible}) AND fill
    ///      ({backstopFill}) — the offer can be mutated via `OfferMutateFacet`
    ///      AFTER opt-in (e.g. fixed-size → ranged), and `backstopEligibleAfter`
    ///      is not cleared on mutation, so the opt-in check alone is not load-
    ///      bearing. Rejects the shapes the later `matchIntent` path rejects:
    ///        • refinance-tagged (direct-accept-only, #576 — `_executeMatch` rejects);
    ///        • non-ERC20-on-ERC20 (the backstop intent + vault are ERC20-on-ERC20;
    ///          `previewMatch` rejects an asset-type mismatch);
    ///        • a genuine principal range (`amountMax != amount`) — the backstop
    ///          fills the WHOLE offer in one shot; ranged offers are v0-out-of-scope.
    function _assertBackstopShape(LibVaipakam.Offer storage o) private view {
        if (
            o.refinanceTargetLoanId != 0 ||
            o.assetType != LibVaipakam.AssetType.ERC20 ||
            o.collateralAssetType != LibVaipakam.AssetType.ERC20 ||
            o.amountMax != o.amount
        ) revert OfferNotBackstopEligible();
    }

    /// @notice Borrower opt-in: mark `offerId` backstop-eligible after
    ///         `eligibleAfter`. Creator-only. Validated against a future mandatory
    ///         delay + the offer's own expiry + intent-fillability terms — so an
    ///         offer that could never be backstop-filled fails here, not after the
    ///         deadline. Set as an Offer struct field (not via CreateOfferParams).
    function setOfferBackstopEligible(uint256 offerId, uint64 eligibleAfter)
        external
        whenNotPaused
    {
        // #921 item 2 (sanctions sweep) — Tier-1 gate. Opting an offer into the
        // treasury-backed backstop stages it for a fill funded by protocol
        // (treasury) capital, i.e. a value-flow entry point. `createOffer`
        // screened the creator at creation, but a wallet flagged AFTERWARDS could
        // otherwise re-stage here; the downstream `backstopFill → matchIntent`
        // screens only the vault (solver + lender), never the offer creator. Screen
        // the caller (== the creator, enforced just below) at this opt-in.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (o.creator != msg.sender) revert NotOfferCreator();
        if (o.offerType != LibVaipakam.OfferType.Borrower) {
            revert OfferNotBorrowerType();
        }
        // Don't stage eligibility while the backstop is switched off: in a
        // break-glass / off-by-default period a borrower could otherwise let the
        // mandatory delay elapse and have the offer become immediately fillable on
        // re-enable — the same no-staging posture the pause gate enforces.
        if (
            !s.protocolCfg.backstopEnabled || !s.protocolCfg.backstopFillEnabled
        ) revert BackstopDisabled();
        // Honor per-asset pauses too (create/mutate/accept/fund all do): an
        // asset-pause incident must not let eligibility be staged during the freeze
        // and fire the instant the asset unpauses, skipping the healthy-market wait.
        LibFacet.requireAssetNotPaused(o.lendingAsset);
        LibFacet.requireAssetNotPaused(o.collateralAsset);
        // Shape gate — reject any offer the later `matchIntent` path could never
        // fill, so the borrower fails fast at opt-in (re-asserted at fill time, see
        // {backstopFill}, because the offer can be mutated after opt-in).
        _assertBackstopShape(o);
        // The backstop must already be able to fill this pair, or opting in is an
        // empty promise: the borrower would wait out a last-resort deadline only
        // for `backstopFill` → `matchIntent` to revert `BackstopNotProvisioned` /
        // `LenderIntentInactive`. Require the vault provisioned + a live intent row
        // for the offer's exact (lend, coll) pair. (Finer term checks — rate
        // overlap, LTV, exposure — stay at fill time; they depend on live oracle /
        // exposure state, not on stable opt-in-time facts.)
        address bv = s.backstopVault;
        if (bv == address(0)) revert BackstopNotProvisioned();
        if (!s.lenderIntent[bv][o.lendingAsset][o.collateralAsset].active) {
            revert BackstopIntentInactive();
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
        // Re-assert the fillable SHAPE here, not just at opt-in: the offer may have
        // been mutated (e.g. fixed-size → ranged, or retagged) after opt-in, and
        // `backstopEligibleAfter` is not cleared on mutation.
        _assertBackstopShape(o);
        // Effective unfilled capacity = ceiling − filled (the `LibOfferMatch`
        // formula). The shape gate above guarantees `amountMax == amount`, so this
        // equals the whole offer; using the ceiling stays correct if borrower
        // partial-fill (#102) ever starts writing `amountFilled`, and never underflows.
        uint256 remainder = o.amountMax - o.amountFilled;
        if (remainder == 0) revert OfferNotBackstopFillable();
        if (
            OracleFacet(address(this)).checkLiquidity(o.collateralAsset) !=
            LibVaipakam.LiquidityStatus.Liquid
        ) revert OfferNotBackstopFillable();
        // #638 — Role A puts treasury funds at risk as counterparty on this
        // collateral. Enforce the governance-set minimum live-secondary-oracle
        // coverage so the treasury isn't left holding single-feed-priced
        // collateral. No-op when the knob is 0 (default). Backstop-scoped — the
        // general permissionless liquidation path is unaffected.
        LibBackstopOracleGate.assertCoverage(o.collateralAsset);
        // #954 (§1.5) — RE-SCREEN the offer creator at fill, not just at opt-in
        // (`setOfferBackstopEligible:352`). `backstopFill` originates a
        // treasury-funded loan to `o.creator` and routes principal to them, so
        // it is Tier-1 (creates state + pays value to the caller's economic
        // party) → hard-revert for a creator flagged in the
        // opt-in→`eligibleAfter` window. Without this, a borrower flagged after
        // opting in could still have a loan originated to them here; downstream
        // `matchIntent` screens only the solver / backstop vault, never
        // `o.creator`. Mirrors the shape re-assert already done above.
        LibVaipakam._assertNotSanctioned(o.creator);
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
    ///
    ///      Requires Diamond-as-treasury (like seed/withdraw). If governance moved
    ///      `treasury` away from the Diamond, we MUST revert rather than forward
    ///      the recovered tokens to the Diamond and skip the credit — that would
    ///      strand them as untracked raw Diamond balance `TreasuryFacet` can't
    ///      reach. Reverting keeps the loan claimable once treasury is the Diamond
    ///      again; nothing is lost.
    ///
    ///      Credits BOTH legs the vault forwards: principal on a normal resolution,
    ///      and the raw collateral on a no-swap default (collateral that went
    ///      illiquid AFTER a liquid-at-fill origination). See
    ///      {BackstopVaultImplementation.executeClaim}.
    function backstopClaim(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata retryCalls
    ) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        if (s.loans[loanId].lender != vault) revert NotBackstopLoan();
        (
            address principalAsset,
            uint256 principalRecovered,
            address collateralAsset,
            uint256 collateralRecovered
        ) = BackstopVaultImplementation(vault).executeClaim(loanId, retryCalls);
        if (principalRecovered > 0) {
            s.treasuryBalances[principalAsset] += principalRecovered;
        }
        if (collateralRecovered > 0) {
            s.treasuryBalances[collateralAsset] += collateralRecovered;
        }
        emit BackstopLoanClaimed(loanId, principalAsset, principalRecovered);
        if (collateralRecovered > 0) {
            emit BackstopLoanClaimed(loanId, collateralAsset, collateralRecovered);
        }
    }

    /// @notice Sweep a raw ERC20 balance off the backstop vault into treasury.
    /// @dev VAULT_ADMIN / timelock. Recovers residue that lands raw on the vault
    ///      and is NOT captured by {backstopClaim} — e.g. a VPFI matcher kickback,
    ///      an airdrop, or dust. The vault is owned by the Diamond, so without this
    ///      wrapper there is no selector to drive its `sweepToken`. Requires
    ///      Diamond-as-treasury so the recovered value is tracked, mirroring
    ///      seed/withdraw/claim.
    function sweepBackstopToken(address token)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
        returns (uint256 amount)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        amount = BackstopVaultImplementation(vault).sweepToken(
            token,
            address(this)
        );
        if (amount > 0) s.treasuryBalances[token] += amount;
        emit BackstopTokenSwept(token, amount);
    }

    /// @notice Sweep a FOREIGN ERC721 off the backstop vault to `to`.
    /// @dev VAULT_ADMIN / timelock. For an NFT sent to the vault via a non-safe
    ///      `transferFrom` (the `onERC721Received` hook rejects safe transfers of
    ///      foreign NFTs). The vault's `sweepNFT` refuses to move Vaipakam protocol
    ///      NFTs (`nft == diamond`), so a live lender-position NFT can't be pulled.
    function sweepBackstopNFT(address nft, uint256 tokenId, address to)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        BackstopVaultImplementation(vault).sweepNFT(nft, tokenId, to);
        emit BackstopNFTSwept(nft, tokenId, to);
    }

    /// @notice Claim the VPFI interaction rewards the backstop accrued as a lender
    ///         and credit them to treasury.
    /// @dev VAULT_ADMIN / timelock. Backstop-originated loans book interaction
    ///      rewards under the vault (the lender-of-record); `claimInteractionRewards`
    ///      only pays its caller, so the vault must claim them itself via this
    ///      forwarder, otherwise they're stuck while still diluting the emission
    ///      denominators. Requires Diamond-as-treasury so the recovered VPFI is
    ///      tracked, mirroring seed/withdraw/claim/sweep.
    function claimBackstopRewards()
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
        returns (uint256 amount)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFINotConfigured();
        amount = BackstopVaultImplementation(vault)
            .claimInteractionRewardsToDiamond(vpfi);
        if (amount > 0) s.treasuryBalances[vpfi] += amount;
        emit BackstopRewardsClaimed(vpfi, amount);
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

    /// @notice Role B (liquidator-of-last-resort) kill-switch — independent of
    ///         Role A's `backstopFillEnabled` so the riskier absorb path can be
    ///         staged/paused on its own. Subordinate to the master pause.
    function setBackstopAbsorbEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.backstopAbsorbEnabled = enabled;
    }

    function setMinBackstopDelay(uint64 delaySeconds)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.minBackstopDelay = delaySeconds;
    }

    /// @notice #638 — set the minimum number of LIVE secondary oracle feeds
    ///         (Tellor / API3 / DIA) a collateral asset must have for the
    ///         treasury backstop to take it on (both Role A fills and Role B
    ///         absorbs). 0 = no requirement (default — the general
    ///         permissionless behaviour). Range-bounded to [0, 3] (there are
    ///         exactly three secondaries). BACKSTOP-SCOPED — does not affect the
    ///         general liquid-classification or any general liquidation path.
    function setBackstopMinSecondaryOracleCoverage(uint8 minCoverage)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        if (minCoverage > 3) {
            revert BackstopOracleCoverageOutOfRange(minCoverage);
        }
        LibVaipakam
            .storageSlot()
            .backstopMinSecondaryOracleCoverage = minCoverage;
        emit BackstopMinSecondaryOracleCoverageSet(minCoverage);
    }

    /// @notice #638 — the current backstop min-secondary-oracle-coverage knob.
    function getBackstopMinSecondaryOracleCoverage()
        external
        view
        returns (uint8)
    {
        return
            LibVaipakam.storageSlot().backstopMinSecondaryOracleCoverage;
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
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        if (principal == s.vpfiToken) revert VpfiLendingUnsupported();
        LibFacet.requireAssetNotPaused(principal);
        LibFacet.requireAssetNotPaused(collateral);
        uint256 bal = s.treasuryBalances[principal];
        if (bal < amount) revert TreasuryInsufficient();
        s.treasuryBalances[principal] = bal - amount;
        address proxy = VaultFactoryFacet(address(this)).getOrCreateUserVault(
            vault
        );
        IERC20(principal).safeTransfer(proxy, amount);
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
    function withdrawBackstopAbsorbToTreasury(
        address principal,
        address collateral,
        uint256 amount
    ) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vault = s.backstopVault;
        if (vault == address(0)) revert BackstopNotProvisioned();
        if (s.treasury != address(this)) revert TreasuryNotDiamond();
        uint256 bucket = s.backstopAbsorbCash[principal][collateral];
        if (amount > bucket) revert TreasuryInsufficient();
        s.backstopAbsorbCash[principal][collateral] = bucket - amount;
        // Pull the free cash from the vault back to the Diamond (treasury custody).
        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            vault,
            principal,
            address(this),
            amount
        );
        s.treasuryBalances[principal] += amount;
        emit BackstopAbsorbWithdrawn(principal, collateral, amount);
    }

    /// @notice Sweep WAREHOUSED absorb collateral out of the backstop vault (e.g.
    ///         to a governance address for an off-protocol sale, or to treasury on
    ///         a write-off). Does NOT touch the `backstopAbsorbExposure` counter —
    ///         per §5.1 moving unsold collateral is not a realized-cash return.
    /// @dev VAULT_ADMIN. Withdraws from the backstop vault's tracked balance.
    function sweepBackstopAbsorbCollateral(
        address collateral,
        address to,
        uint256 amount
    ) external onlyRole(LibAccessControl.VAULT_ADMIN_ROLE) {
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
        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            vault,
            collateral,
            to,
            amount
        );
        // Write-off-to-treasury path: if the recipient is the Diamond itself (in
        // Diamond-as-treasury mode), record the treasury credit — otherwise the
        // swept tokens would sit as raw Diamond balance that `TreasuryFacet`
        // can't claim (it only sweeps tracked `treasuryBalances`). Mirrors the
        // other backstop recovery paths.
        if (to == address(this) && s.treasury == address(this)) {
            s.treasuryBalances[collateral] += amount;
        }
        emit BackstopAbsorbCollateralSwept(collateral, to, amount);
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

    function getBackstopVault() external view returns (address) {
        return LibVaipakam.getBackstopVault();
    }

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
