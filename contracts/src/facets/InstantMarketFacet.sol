// src/facets/InstantMarketFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibOfferMatchExecute} from "../libraries/LibOfferMatchExecute.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {InstantFillFacet} from "./InstantFillFacet.sol";

/**
 * @title  InstantMarketFacet
 * @author Vaipakam Developer Team
 * @notice Instant market (#3656) — the borrower's instant borrow, the slot
 *         owner's instant-market consents, and the feature's settings.
 *
 *         A borrower names the pair, the amount wanted, the collateral
 *         offered, the term, the highest rate accepted, the repayment shape,
 *         the sources (cheapest first, chosen off-chain) and the least total
 *         that must be received. {borrowInstant} fills from the sources in
 *         order: each fill is its own loan with one lender, opened through the
 *         shared match core at that source's own price
 *         (`InstantFillFacet.fillInstant`). A source that refuses is skipped
 *         and reported with its refusal; the call reverts only when what was
 *         received is below the stated least. The loans share a group id, a
 *         label stated in one summary event: each loan keeps its own
 *         collateral, health factor and liquidation, and nothing cross-defaults.
 *
 *         Fixed-rate loans only for now: floating loans arrive with the
 *         reference rate (#3337), and the request's kind is refused until then.
 * @dev    Behind a master switch, off by default, and limited to pairs whose
 *         two assets are both blue-chip (`LibRiskAccess._isBlueChip`: the
 *         numeraire basket or liquidity tier 3). Refreshed together with
 *         InstantFillFacet.
 */
contract InstantMarketFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl {
    /// @notice The kind of loan a request asks for.
    uint8 internal constant KIND_FIXED = 0;
    /// @notice The fill bound's default and its governance range.
    uint8 internal constant DEFAULT_MAX_FILLS = 8;
    uint8 internal constant MIN_MAX_FILLS = 2;
    uint8 internal constant MAX_MAX_FILLS = 16;

    /// @notice A borrower's instant-borrow request.
    /// @param lendingAsset      The asset borrowed.
    /// @param collateralAsset   The collateral asset.
    /// @param amountWanted      The principal wanted in all.
    /// @param collateralOffered The collateral offered in all. Each loan takes
    ///        its share in proportion to principal; the share of what is not
    ///        filled is not taken.
    /// @param kind              The kind of loan: 0 = fixed rate. Floating is
    ///        refused until the reference rate exists.
    /// @param termDays          The base term of every loan.
    /// @param maxRateBps        The highest rate accepted; a dearer source is
    ///        skipped.
    /// @param allowsPartialRepay The repayment shape asked for; a source that
    ///        refuses it is skipped.
    /// @param minTotal          The least total principal that must be
    ///        received, or the whole call reverts.
    /// @param validUntil        The transaction deadline.
    /// @param riskAndTermsConsent The borrower's consent to the loan terms.
    /// @param rateFarFromAverageAcknowledged The borrower's own statement that
    ///        it accepts a fixed rate far from the term average
    ///        (TermAverageAndLinkGuardsDesign §6.4, #3713). It will be required
    ///        for a fixed-rate instant borrow whose rate is outside the band
    ///        around the term average, and is never needed inside it. Until the
    ///        shared term-average check (#3635 part A) lands it is carried but
    ///        NOT enforced: no borrow is refused or allowed because of it.
    struct InstantBorrowRequest {
        address lendingAsset;
        address collateralAsset;
        uint256 amountWanted;
        uint256 collateralOffered;
        uint8 kind;
        uint32 termDays;
        uint256 maxRateBps;
        bool allowsPartialRepay;
        uint256 minTotal;
        uint64 validUntil;
        bool riskAndTermsConsent;
        bool rateFarFromAverageAcknowledged;
    }

    /// @notice One loan an instant borrow opened.
    struct InstantFill {
        uint256 sourceIndex;
        uint256 loanId;
        uint256 amount;
        uint256 rateBps;
        uint256 collateral;
    }

    /// @notice One source an instant borrow skipped, with the refusal it
    ///         raised (the ABI-encoded custom error).
    struct InstantSkip {
        uint256 sourceIndex;
        bytes reason;
    }

    /// @notice One loan an instant borrow opened, one event per loan so
    ///         each carries its own loan id (the activity feed files it by
    ///         that id). Emitted before the {InstantBorrowed} that sums them.
    event InstantLoanOpened(
        uint256 indexed groupId,
        uint256 indexed loanId,
        uint256 sourceIndex,
        uint256 amount,
        uint256 rateBps,
        uint256 collateral
    );

    /// @notice One instant borrow, stated whole: what it borrowed (its loans
    ///         are the group's {InstantLoanOpened} events), the sources it
    ///         skipped and why, and where the collateral came from
    ///         (`fromWallet` was deposited from the wallet; the rest of
    ///         `collateralLocked` was already free in the borrower's vault).
    event InstantBorrowed(
        uint256 indexed groupId,
        address indexed borrower,
        address lendingAsset,
        address collateralAsset,
        uint256 totalBorrowed,
        uint256 collateralLocked,
        uint256 fromWallet,
        uint256 loansOpened,
        InstantSkip[] skipped
    );

    /// @notice A slot owner set (or changed) their slot's instant-market
    ///         consents.
    event InstantSlotSet(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset,
        uint8 slot,
        bool fills,
        bool renewal,
        bool takeover
    );

    /// @notice Governance turned the instant market on or off.
    event InstantMarketEnabledSet(bool enabled);
    /// @notice Governance set the most fills one instant borrow opens.
    event InstantMaxFillsSet(uint8 maxFills);

    /// @notice The instant market is switched off.
    error InstantMarketDisabled();
    /// @notice A pair asset is not blue-chip; the instant market serves only
    ///         pairs whose two assets are.
    error InstantPairNotEligible(address lendingAsset, address collateralAsset);
    /// @notice The kind of loan asked for is not available yet.
    error InstantKindUnavailable(uint8 kind);
    /// @notice The request is empty or malformed: no amount, no collateral,
    ///         no term, or no sources.
    error InstantRequestInvalid();
    /// @notice More sources than one instant borrow may walk.
    error InstantTooManySources(uint256 count, uint256 max);
    /// @notice The loans opened came to less than the stated least.
    error InstantBelowLeast(uint256 received, uint256 least);
    /// @notice The slot is not active.
    error InstantSlotInactive();
    /// @notice The slot does not take interest by time, which every
    ///         instant-market loan carries.
    error InstantSlotNeedsProRata();
    /// @notice The slot lets only authorized solvers fill it, which conflicts
    ///         with fills from any borrower's direct request.
    error InstantSlotSolverOnly();

    // ─── Settings ─────────────────────────────────────────────────────────

    /// @notice Turn the instant market on or off. Existing loans keep their
    ///         rules either way.
    function setInstantMarketEnabled(bool enabled) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.storageSlot().instantCfg.enabled = enabled;
        emit InstantMarketEnabledSet(enabled);
    }

    /// @notice Set the most fills one instant borrow opens (2 to 16).
    function setInstantMaxFills(uint8 maxFills) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (maxFills < MIN_MAX_FILLS || maxFills > MAX_MAX_FILLS) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "instantMaxFills", maxFills, MIN_MAX_FILLS, MAX_MAX_FILLS
            );
        }
        LibVaipakam.storageSlot().instantCfg.maxFills = maxFills;
        emit InstantMaxFillsSet(maxFills);
    }

    /// @notice The instant market's settings: whether it is on and the most
    ///         fills one instant borrow opens.
    function getInstantMarketConfig() external view returns (bool enabled, uint8 maxFills) {
        LibVaipakam.InstantMarketConfig storage c = LibVaipakam.storageSlot().instantCfg;
        return (c.enabled, _maxFills(c));
    }

    // ─── The slot owner's consents ────────────────────────────────────────

    /// @notice Give or change the instant-market consents of the caller's
    ///         Auto-lend slot (design §3). `fills`: a borrower's instant borrow
    ///         may fill the slot at its minimum rate. `renewal`: its
    ///         instant-market loans may renew in place, one base term at a
    ///         time, never past its lend-until time; turning it off is the
    ///         notice to leave. `takeover`: the slot may take over another
    ///         lender's instant-market loan at face value when the loan fits
    ///         its limits as if opened now. Setting the slot's terms again
    ///         clears all three.
    /// @dev   The slot must be active and take interest by time
    ///        (`acceptsProRata`), and must not be limited to authorized
    ///        solvers. Turning a consent ON needs the market on, a blue-chip
    ///        pair and an unflagged owner; turning one off is always open. A
    ///        borrower fill waits the same minimum age from this call as from
    ///        the slot's terms (#3443).
    function setInstantSlot(
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        bool fills,
        bool renewal,
        bool takeover,
        bool riskAndTermsConsent,
        uint64 validUntil
    ) external nonReentrant whenNotPaused {
        LibTiming.requireDeadline(validUntil);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (fills || renewal || takeover) {
            if (!riskAndTermsConsent) revert IVaipakamErrors.RiskAndTermsConsentRequired();
            if (!s.instantCfg.enabled) revert InstantMarketDisabled();
            LibVaipakam._assertNotSanctioned(msg.sender);
            LibProtectedAccount.requireCanOpen(msg.sender);
            _requireEligiblePair(lendingAsset, collateralAsset);
            LibVaipakam.LenderIntent storage intent =
                s.lenderIntent[msg.sender][lendingAsset][collateralAsset][slot];
            if (!intent.active) revert InstantSlotInactive();
            if (!intent.acceptsProRata) revert InstantSlotNeedsProRata();
            if (intent.requiresKeeperAuth) revert InstantSlotSolverOnly();
        }
        s.instantSlot[msg.sender][lendingAsset][collateralAsset][slot] = LibVaipakam.InstantSlot({
            fills: fills,
            renewal: renewal,
            takeover: takeover,
            setAt: uint64(block.timestamp)
        });
        emit InstantSlotSet(msg.sender, lendingAsset, collateralAsset, slot, fills, renewal, takeover);
    }

    /// @notice A slot's instant-market consents and when they were set.
    function getInstantSlot(address owner, address lendingAsset, address collateralAsset, uint8 slot)
        external
        view
        returns (LibVaipakam.InstantSlot memory)
    {
        return LibVaipakam.storageSlot().instantSlot[owner][lendingAsset][collateralAsset][slot];
    }

    // ─── Instant borrow ───────────────────────────────────────────────────

    /// @notice Borrow now from several lenders in one transaction (design §4).
    /// @dev    Fills from `sources` in order until the amount wanted is
    ///         received or the fill bound is reached. Each fill runs through
    ///         the Diamond as its own call, so a source that refuses (stale,
    ///         too dear, out of room, a loan that would fail any origination
    ///         check) changes nothing and is reported with its refusal. The
    ///         principal of every loan arrives in the borrower's vault as free
    ///         balance, less the fee; moving it to a wallet is a separate
    ///         withdrawal. The collateral the wallet supplies needs an approval
    ///         to the Diamond of at least `collateralOffered` less what is free
    ///         in the vault; what is not used is not taken.
    /// @param req     The request.
    /// @param sources The sources, cheapest first. At most 16.
    /// @return groupId The group the loans share.
    /// @return fills   The loans opened.
    function borrowInstant(InstantBorrowRequest calldata req, InstantFillFacet.InstantSource[] calldata sources)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 groupId, InstantFill[] memory fills)
    {
        LibTiming.requireDeadline(req.validUntil);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.instantCfg.enabled) revert InstantMarketDisabled();
        if (!req.riskAndTermsConsent) revert IVaipakamErrors.RiskAndTermsConsentRequired();
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibProtectedAccount.requireCanOpen(msg.sender);
        // The fill path's own pre-requisites, named here rather than as a
        // skip of every source.
        if (!s.protocolCfg.partialFillEnabled) revert LibOfferMatchExecute.FunctionDisabled(3);
        if (req.kind != KIND_FIXED) revert InstantKindUnavailable(req.kind);
        if (
            req.amountWanted == 0 || req.collateralOffered == 0 || req.termDays == 0
                || sources.length == 0
        ) revert InstantRequestInvalid();
        if (sources.length > MAX_MAX_FILLS) revert InstantTooManySources(sources.length, MAX_MAX_FILLS);
        _requireEligiblePair(req.lendingAsset, req.collateralAsset);

        groupId = ++s.lastInstantGroupId;
        uint256 maxFills = _maxFills(s.instantCfg);
        fills = new InstantFill[](sources.length);
        InstantSkip[] memory skipped = new InstantSkip[](sources.length);
        uint256 nFills;
        uint256 nSkips;
        InstantFillFacet.FillRequest memory fr = _fillRequest(req);
        uint256 fromWallet;
        for (uint256 i; i < sources.length && fr.remaining > 0 && nFills < maxFills; ++i) {
            fr.source = sources[i];
            (bool ok, bytes memory ret) = address(this).call(
                abi.encodeWithSelector(InstantFillFacet.fillInstant.selector, fr)
            );
            if (!ok) {
                skipped[nSkips++] = InstantSkip({sourceIndex: i, reason: ret});
                continue;
            }
            InstantFillFacet.FillResult memory res = abi.decode(ret, (InstantFillFacet.FillResult));
            s.instantGroupOf[res.loanId] = groupId;
            fills[nFills++] = InstantFill({
                sourceIndex: i,
                loanId: res.loanId,
                amount: res.amount,
                rateBps: res.rateBps,
                collateral: res.collateral
            });
            emit InstantLoanOpened(groupId, res.loanId, i, res.amount, res.rateBps, res.collateral);
            fr.remaining -= res.amount;
            fr.collRemaining -= res.collateral;
            fromWallet += res.fromWallet;
        }
        uint256 received = req.amountWanted - fr.remaining;
        if (received == 0 || received < req.minTotal) revert InstantBelowLeast(received, req.minTotal);
        assembly ("memory-safe") {
            mstore(fills, nFills)
            mstore(skipped, nSkips)
        }
        emit InstantBorrowed(
            groupId,
            msg.sender,
            req.lendingAsset,
            req.collateralAsset,
            received,
            req.collateralOffered - fr.collRemaining,
            fromWallet,
            nFills,
            skipped
        );
    }

    /// @notice The instant-borrow group that opened `loanId` (0 = none).
    function getInstantGroup(uint256 loanId) external view returns (uint256) {
        return LibVaipakam.storageSlot().instantGroupOf[loanId];
    }

    // ─── Internals ────────────────────────────────────────────────────────

    function _fillRequest(InstantBorrowRequest calldata req)
        private
        view
        returns (InstantFillFacet.FillRequest memory fr)
    {
        fr.borrower = msg.sender;
        fr.lendingAsset = req.lendingAsset;
        fr.collateralAsset = req.collateralAsset;
        fr.termDays = req.termDays;
        fr.maxRateBps = req.maxRateBps;
        fr.allowsPartialRepay = req.allowsPartialRepay;
        fr.remaining = req.amountWanted;
        fr.collRemaining = req.collateralOffered;
        fr.amountWanted = req.amountWanted;
        fr.collateralOffered = req.collateralOffered;
    }

    /// @notice #3761 — whether the instant market is on, and whether
    ///         `lendingAsset` lent against `collateralAsset` is a pair it
    ///         serves: two different assets, both blue-chip. The same rule
    ///         {setInstantSlot} and {borrowInstant} enforce, so an app can say
    ///         ahead of time whether a lend form may offer instant borrowing,
    ///         instead of reading a refused write.
    /// @return enabled  The market switch ({setInstantMarketEnabled}).
    /// @return eligible Whether the pair qualifies, read independently of
    ///                  the switch: a qualifying pair reads true while the
    ///                  market is off.
    function instantPairEligible(address lendingAsset, address collateralAsset)
        external
        view
        returns (bool enabled, bool eligible)
    {
        return (LibVaipakam.storageSlot().instantCfg.enabled, _pairEligible(lendingAsset, collateralAsset));
    }

    function _maxFills(LibVaipakam.InstantMarketConfig storage c) private view returns (uint8) {
        return c.maxFills == 0 ? DEFAULT_MAX_FILLS : c.maxFills;
    }

    function _requireEligiblePair(address lendingAsset, address collateralAsset) private view {
        if (!_pairEligible(lendingAsset, collateralAsset)) {
            revert InstantPairNotEligible(lendingAsset, collateralAsset);
        }
    }

    /// @dev The one statement of the instant market's pair rule: two
    ///      different assets, both blue-chip.
    function _pairEligible(address lendingAsset, address collateralAsset) private view returns (bool) {
        return lendingAsset != collateralAsset
            && LibRiskAccess._isBlueChip(lendingAsset)
            && LibRiskAccess._isBlueChip(collateralAsset);
    }
}
