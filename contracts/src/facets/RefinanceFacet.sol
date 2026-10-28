// src/facets/RefinanceFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibRefinanceRequest} from "../libraries/LibRefinanceRequest.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAutoRefinanceCheck} from "../libraries/LibAutoRefinanceCheck.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibInitRiskGate} from "../libraries/LibInitRiskGate.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibRefinanceNetting} from "../libraries/LibRefinanceNetting.sol";

/**
 * @title RefinanceFacet
 * @author Vaipakam Developer Team
 * @notice Borrower refinancing — close an existing loan and switch to a new
 *         lender with better terms.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      ERC-20 loans only (NFT rental refinance not supported — would require
 *      NFT custody transfer between vaults).
 *
 *      One atomic flow (#3042 — every refinance completes in the
 *      transaction that accepts its offer):
 *        1. The borrower-position holder posts a refinance-TAGGED Borrower
 *           offer naming the loan it refinances.
 *        2. A lender accepts it (`OfferAcceptFacet.acceptOffer`), or the
 *           matcher fills it (`OfferMatchFacet.matchOffers`). The accept
 *           creates the replacement loan, charges the borrower's initiation
 *           fee from the new lender's funded principal, and leaves the net
 *           principal in the new lender's vault ({LibRefinanceNetting}). In
 *           the same transaction it chains into {refinanceLoanFromAccept} or
 *           {refinanceLoanFromMatch}, which pays the old lender (principal +
 *           the mode-aware interest; #411 dropped the rate-shortfall top-up
 *           that over-compensated the exiting lender) from that net
 *           principal, pulls only the rest of the old lender's due and the
 *           treasury fee from the holder's wallet, carries or returns the old
 *           collateral, checks the replacement's risk gates and closes the
 *           old loan as Repaid. Any failure reverts the accept too.
 *
 *      The net principal never exceeds the old lender's due: the replacement
 *      principal is the tagged offer's amount, which may not exceed the old
 *      loan's outstanding principal ({_refinanceLoanLogic}'s range check and
 *      `LibAutoRefinanceCheck.validate`), and the due is that principal plus
 *      interest. So a refinance has no surplus to pay out; {_settlePayoff}
 *      refuses one rather than leave it in the new lender's vault.
 *
 *      There is no after-the-fact completion. A refinance that could be
 *      finished later would need the net principal in the borrower's wallet
 *      first, and the payoff pulled back out of it — the round trip #3042
 *      removed.
 */
contract RefinanceFacet is DiamondPausable, IVaipakamErrors {
    /// @notice Emitted when a loan is refinanced to a new lender.
    /// @param oldLoanId The ID of the original loan.
    /// @param newLoanId The ID of the new refinanced loan.
    /// @param borrower The borrower's address.
    /// @param oldLender The original lender's address.
    /// @param newLender The new lender's address.
    /// @param oldLoanNewStatus The original loan's `LoanStatus` after the
    ///        refinance — always `Repaid` (1). Carried explicitly so an
    ///        indexer flips status from the payload rather than inferring
    ///        it from the event name (uniform with `LoanRepaid.newStatus`).
    /// @custom:event-category state-change/loan-mutation
    event LoanRefinanced(
        uint256 indexed oldLoanId,
        uint256 indexed newLoanId,
        address indexed borrower,
        address oldLender,
        address newLender,
        uint8 oldLoanNewStatus
    );

    /// @notice #3042 — how a refinance's payoff was paid, leg by leg, in the
    ///         replacement loan's principal asset. All of the new lender's
    ///         net principal (principal minus the borrower's initiation fee)
    ///         goes to the old lender; the borrower pays only the rest of the
    ///         old lender's due and the treasury fee. The three legs sum to
    ///         the old lender's due plus the treasury fee.
    /// @param oldLoanId            The loan refinanced (now Repaid).
    /// @param newLoanId            The replacement loan.
    /// @param asset                The principal asset every leg moved.
    /// @param newLenderToOldLender From the new lender's vault to the old
    ///        lender's vault: the whole net principal.
    /// @param borrowerToOldLender  From the borrower's wallet to the old
    ///        lender's vault: the part of the old lender's due the net
    ///        principal did not cover.
    /// @param borrowerToTreasury   From the borrower's wallet to the
    ///        treasury: the treasury fee on the old loan's interest.
    ///        A settlement breakdown like `RepayFacet`'s: the state change
    ///        itself is `LoanRefinanced` in the same transaction.
    /// @custom:event-category informational/settlement
    event RefinancePayoffSettled(
        uint256 indexed oldLoanId,
        uint256 indexed newLoanId,
        address indexed asset,
        uint256 newLenderToOldLender,
        uint256 borrowerToOldLender,
        uint256 borrowerToTreasury
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidRefinanceOffer();
    error OfferNotAccepted();
    /// @notice #3042 — the new lender's net principal exceeds what the old
    ///         lender is owed. The admission rules make this impossible (the
    ///         replacement principal never exceeds the old principal); it is
    ///         refused rather than leave the excess in the new lender's vault
    ///         on a loan that records it as delivered.
    error RefinanceNetPrincipalExceedsPayoff(uint256 netPrincipal, uint256 lenderDue);
    /// @notice T-092 #508 / #2349 — the auto-refinance kill switch
    ///         (`cfgAutoRefinanceEnabled`) is off, and this refinance is
    ///         being completed by the route the switch governs: the
    ///         range-order matcher filling a refinance-tagged offer. A lender
    ///         directly accepting the borrower's refinance-tagged offer is
    ///         never blocked by it.
    error AutoRefinanceDisabled();

    /// @notice #2349 — which door a refinance completion came through.
    ///         STATED by the entry point, never inferred from `msg.sender`:
    ///         on both atomic routes `msg.sender` is the Diamond itself, so a
    ///         `msg.sender`-based test cannot tell a lender's accept from a
    ///         matcher fill (the defect #2349 recorded — every atomic
    ///         completion was treated as keeper-driven and blocked while the
    ///         switch was off).
    enum RefinanceRoute {
        /// {refinanceLoanFromAccept}: a lender accepted the holder's
        /// refinance-tagged offer directly (`OfferAcceptFacet.acceptOffer`).
        LenderAccept,
        /// {refinanceLoanFromMatch}: the range-order matcher filled the
        /// holder's refinance-tagged offer (`OfferMatchFacet.matchOffers`).
        MatchedFill
    }


    /// @notice T-092-H (#549) — `msg.sender == address(this)` gate.
    ///         Used by both refinance entries so the atomic chain from
    ///         `OfferAcceptFacet` + `OfferMatchFacet` is the ONLY way to
    ///         reach them; an external EOA cannot call either directly.
    error OnlyDiamondInternal();
    /// @dev Extracted modifier body — same shape as VaultFactoryFacet's
    ///      `_checkDiamondInternal`. Keeps the modifier a thin wrapper
    ///      so each call site inlines one function call.
    function _checkDiamondInternal() private view {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
    }
    modifier onlyDiamondInternal() {
        _checkDiamondInternal();
        _;
    }

    /// @notice T-092-H (#549) — atomic accept-and-refinance entry for a
    ///         LENDER'S DIRECT ACCEPT of a refinance-tagged borrower offer.
    ///         Callable only via `LibFacet.crossFacetCall` from
    ///         `OfferAcceptFacet._acceptOffer`, AFTER `offer.accepted =
    ///         true` is set, and only when that accept is NOT running inside
    ///         a range-order match (a match routes to
    ///         {refinanceLoanFromMatch} instead). No `nonReentrant` here —
    ///         the outer `acceptOffer` lock covers the whole tx (see design
    ///         doc §3.2 "Reentrancy analysis"). `whenNotPaused` retained —
    ///         pause freezes the chain as well as the direct external path.
    /// @dev    #2349 — NOT gated by the auto-refinance kill switch. The
    ///         borrower-NFT holder authorised this refinance by creating the
    ///         tagged offer under their own caps, and the lender chose to
    ///         accept it; no keeper or matcher is acting. The spec's standard
    ///         refinance process (ProjectDetailsREADME "Allow Borrower to
    ///         Choose New Lender…", steps 2–3) is exactly this route, and the
    ///         switch defaults OFF on a fresh deployment, so gating it would
    ///         disable ordinary refinancing wherever the switch is off.
    function refinanceLoanFromAccept(
        uint256 oldLoanId,
        uint256 borrowerOfferId
    ) external onlyDiamondInternal whenNotPaused {
        // #2407 — on the atomic routes only the loan's RECORDED request may
        // complete, and only while no offset is open on the loan: the
        // recorded request is the one the borrower-action guard watches, so a
        // displaced or never-recorded request (which could otherwise revive
        // when the position returns to its creator) can never be taken; and a
        // refinance and an offset each close the loan, so they never both
        // proceed. A revert here unwinds the whole acceptance, so nothing is
        // stranded.
        LibRefinanceRequest.assertTakeable(oldLoanId, borrowerOfferId);
        _authorizeRefinance(oldLoanId, RefinanceRoute.LenderAccept);
        _refinanceLoanLogic(oldLoanId, borrowerOfferId);
    }

    /// @notice #2349 — atomic accept-and-refinance entry for a range-order
    ///         MATCHER fill of a refinance-tagged borrower offer. Callable
    ///         only via `LibFacet.crossFacetCall` — from `OfferMatchFacet`'s
    ///         dust-close branch (partial-fill on), or from
    ///         `OfferAcceptFacet._acceptOffer` when that accept is running
    ///         inside `matchOffers` (partial-fill off). Same reentrancy /
    ///         pause posture as {refinanceLoanFromAccept}.
    /// @dev    Gated by the auto-refinance kill switch: the matcher is the
    ///         automated completion path the switch exists to stop
    ///         (ProjectDetailsREADME, carry-over-aware matched refinance —
    ///         "the auto-refinance caps and kill-switch satisfied"). The
    ///         matcher's admission predicate
    ///         (`LibAutoRefinanceCheck.matchAdmissible`) already refuses a
    ///         tagged offer while the switch is off; this gate is the
    ///         execution-time backstop for the same rule.
    function refinanceLoanFromMatch(
        uint256 oldLoanId,
        uint256 borrowerOfferId
    ) external onlyDiamondInternal whenNotPaused {
        // #2407 — see {refinanceLoanFromAccept}.
        LibRefinanceRequest.assertTakeable(oldLoanId, borrowerOfferId);
        _authorizeRefinance(oldLoanId, RefinanceRoute.MatchedFill);
        _refinanceLoanLogic(oldLoanId, borrowerOfferId);
    }

    /// @dev #2349 — every check that runs BEFORE any refinance state changes,
    ///      including the one rule that depends on WHICH route is completing
    ///      the refinance. Split out of {_refinanceLoanLogic} on purpose: the
    ///      entries pass `route` as a compile-time constant, and passing it
    ///      into the long payoff body let the optimizer specialize a copy of
    ///      that body per route (measured: +~1.7 KB per entry). Only this
    ///      small prelude sees `route` now. The fail-closed frozen-holder
    ///      block (`mustFreezeParty`) runs at the top of {_refinanceLoanLogic},
    ///      beside the payout it guards (S10 Invariant B), so a frozen holder on
    ///      the gated route reverts on the route rule first. Either way the
    ///      call reverts before any state changes.
    ///
    ///      Both routes arrive from the Diamond itself, inside an accept that
    ///      already screened its own caller (the lender, or the matcher). What
    ///      is screened here is the borrower-position holder, who receives the
    ///      old collateral and pays what the net principal does not cover. The
    ///      auto-refinance kill switch applies to the matcher route only: a
    ///      lender's direct accept is not automation and is never blocked by
    ///      it. (#3042 retired the after-the-fact completion, and with it the
    ///      holder-or-keeper authority check that route needed: on both atomic
    ///      routes the caller is the Diamond.)
    function _authorizeRefinance(
        uint256 oldLoanId,
        RefinanceRoute route
    ) private view {
        // T-090 v1.1 (#389) §5.8 — refinance withdraws old
        // collateral from `loan.borrower`'s vault before flipping
        // the old loan to Repaid; block while a v1.1 commit is live.
        LibVaipakam.assertNoLiveIntentCommit(oldLoanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage oldLoan = s.loans[oldLoanId];
        if (oldLoan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // T-092 Phase 2a (#505) — the current borrower-NFT holder is the
        // party the refinance pays and draws from, so screen them (Tier-1).
        LibVaipakam._assertNotSanctioned(
            LibERC721.ownerOf(oldLoan.borrowerTokenId)
        );
        if (
            route == RefinanceRoute.MatchedFill &&
            !s.protocolCfg.cfgAutoRefinanceEnabled
        ) revert AutoRefinanceDisabled();
    }

    /// @dev Shared payoff body for both atomic entries, run only after
    ///      {_authorizeRefinance} passed. Takes no route — see
    ///      {_authorizeRefinance} for why.
    function _refinanceLoanLogic(
        uint256 oldLoanId,
        uint256 borrowerOfferId
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage oldLoan = s.loans[oldLoanId];
        // Pass-2 A1/D5 (#1189) — the OLD loan's fixed maturity, for the
        // exiting lender's late fee below (charged when the close lands in the
        // grace window). The strictly-post-grace BLOCK is enforced further down
        // against the REPLACEMENT's acceptance time, not `block.timestamp` — see
        // the gate after `newLoan` is resolved (Codex #1233 r2 P1).
        // The current borrower-NFT holder — the fund source and collateral
        // recipient on every route (fail-open screened in {_authorizeRefinance}).
        address currentBorrowerNftOwner =
            LibERC721.ownerOf(oldLoan.borrowerTokenId);
        // #998 S10 (#1006, Codex #1122-rework 186c60ff-round P1) — the fail-open
        // `_assertNotSanctioned` screens in {_authorizeRefinance} would let a
        // PREVIOUSLY-CONFIRMED-flagged borrower holder through during an oracle
        // outage, who then receives the OLD collateral directly in the
        // non-carry-over branch with no registry-aware block. Refinance is a
        // discretionary, borrower-initiated action (Tier-1), so hard-BLOCK a
        // registry-frozen holder FAIL-CLOSED here (a previously-confirmed party
        // during an outage, or a fresh oracle-up flag), mirroring the lender-side
        // fail-closed protection. `mustFreezeParty` self-heals the registry on a
        // clean read; a clean / never-confirmed holder passes unchanged, so an
        // oracle blip can't freeze an honest borrower.
        //
        // It sits HERE, in the function that pays the holder, and runs on every
        // route before any state changes. That co-location is the S10 Invariant B
        // rule (`check-sanctions-register-coverage.mjs`), not a style choice —
        // #2355 briefly moved it into the prelude and the guardrail caught it.
        if (LibSanctionedLock.mustFreezeParty(s, currentBorrowerNftOwner)) {
            revert LibVaipakam.SanctionedAddress(currentBorrowerNftOwner);
        }
        // NFT rental refinance not supported in Phase 1 (requires NFT custody transfer)
        if (oldLoan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidRefinanceOffer();

        // #658 PR-B (#594 arc) — eagerly consolidate the LENDER side of the
        // exiting old loan to its current lender-NFT holder while the old loan
        // is still Active (the primitive no-ops once terminal). The old lender
        // EXITS at refinance regardless of branch (`s.lenderClaims[oldLoanId]`
        // is set and the old loan closes below), so its accrued reward entry +
        // VPFI checkpoint must follow the current holder before the close.
        // Funds are already current-holder-safe (the exit payout routes via
        // `lenderClaims` → `ClaimFacet`, `ownerOf`-gated). The BORROWER side is
        // consolidated separately, gated to the NON-carry-over branch below
        // (Codex #690 round-2 P2): on carry-over the borrower stays and its
        // collateral is re-tagged into the new loan (no close-out), but on the
        // fresh-pledge path the old collateral is returned and the old loan closes
        // for the borrower too — so the borrower's position effects must follow
        // the current holder there. Size-tight facet → few-byte cross-facet
        // entry (Tier2 skip-not-block).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateToHolder.selector,
                oldLoanId,
                /* isLenderSide */ true
            ),
            bytes4(0)
        );

        // T-034 §4.6 — settle-first guard. If the old loan has a
        // Periodic Interest Payment cadence AND the current period is
        // overdue past its grace window, the original lender is owed
        // interest right now. Refinance must NOT overwrite the loan's
        // state until that obligation is settled — otherwise the new
        // lender's terms (different rate / cadence / start time)
        // would silently extinguish the original lender's claim.
        // Caller resolves by running `settlePeriodicInterest` on the
        // old loan first; that path either just-stamps (no shortfall)
        // or auto-liquidates (covers the shortfall to the lender),
        // and refinance can then proceed cleanly.
        if (
            oldLoan.periodicInterestCadence !=
            LibVaipakam.PeriodicInterestCadence.None
        ) {
            uint256 graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(oldLoan);
            if (block.timestamp >= graceEndsAt) {
                revert IVaipakamErrors.RefinanceRequiresPeriodSettle(
                    oldLoanId,
                    graceEndsAt
                );
            }
        }

        // Validate: must be a Borrower offer created by the current
        // borrower-NFT owner, already accepted. T-092 Phase 2a — the
        // creator check binds to the current NFT holder, not
        // msg.sender (which is the Diamond on both atomic routes).
        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        if (
            offer.offerType != LibVaipakam.OfferType.Borrower ||
            offer.creator != currentBorrowerNftOwner
        ) revert InvalidRefinanceOffer();
        // T-092 Phase 2b (Codex round-1 P1) — the offer must be TAGGED for
        // exactly the loan being refinanced: the accept's cap checks
        // (`LibAutoRefinanceCheck`) were run against that target. The atomic
        // callers only chain on a tagged offer and pass its own target, so
        // this is the backstop that keeps it so.
        if (offer.refinanceTargetLoanId != oldLoanId)
            revert InvalidRefinanceOffer();
        if (!offer.accepted) revert OfferNotAccepted();
        // Range-aware amount check: legacy single-value offers satisfy
        // `amount == amountMax`; range offers satisfy
        // `amount <= oldLoan.principal <= amountMax` (the borrower's
        // range must accommodate the existing loan's principal). With
        // auto-collapse (`amountMax == 0` → treated as `amount`),
        // legacy single-value offers fall through to the original
        // `offer.amount >= oldLoan.principal` check unchanged.
        uint256 effAmountMax = offer.amountMax == 0
            ? offer.amount
            : offer.amountMax;
        if (offer.amount > oldLoan.principal || oldLoan.principal > effAmountMax)
            revert InvalidRefinanceOffer();
        // Range Orders Phase 1 — single source of truth for the per-
        // asset invariants (lendingAsset / collateralAsset /
        // collateralAssetType / prepayAsset). README: same lending,
        // collateral, and prepay asset types as original loan.
        if (!LibOfferMatch.assertAssetContinuity(oldLoan, offer))
            revert InvalidRefinanceOffer();

        // The replacement loan this accept just created
        uint256 newLoanId = s.offerIdToLoanId[borrowerOfferId];
        if (newLoanId == 0) revert InvalidRefinanceOffer();
        LibVaipakam.Loan storage newLoan = s.loans[newLoanId];
        address newLender = newLoan.lender;

        // Pass-2 A1/D5 (#1189, Codex #1233 r2+r3) — no execution-level
        // post-grace block here: a post-grace refinance is refused at ADMISSION
        // (the refinance-tagged offer can't be created, accepted or matched
        // against a past-grace target — `LibAutoRefinanceCheck.validate` /
        // `matchAdmissible` revert `RefinanceTargetPastGrace`), and this body
        // runs only inside that same accept. A refinance landing in the grace
        // window settles the old lender in full plus the grace late fee
        // computed below.

        // ── Pay off the old loan ──────────────────────────────────────────
        // #1003 (S7) — settle the exiting lender's interest MODE-AWARE, through
        // the SAME `settlementInterestNet` the preclose path uses, instead of an
        // unconditional full-term charge. The two "early close" doors
        // (preclose / refinance) must agree:
        //   • useFullTermInterest == true  → full-term (the floor is the
        //     remaining committed term, so the exiting lender receives their
        //     maximum and is strictly whole — the historical behaviour), on the
        //     #641 interest-clock remaining term, not the immutable durationDays.
        //   • useFullTermInterest == false → accrued-only (pro-rata): a borrower
        //     who OPTED INTO pro-rata must not be punished with full-term just
        //     because they refinance rather than repay directly.
        // `...Net` also credits any periodic `interestSettled` (paid once).
        // #411 fix — the rate-shortfall top-up is gone (see {_exitingLenderDue}).
        (uint256 treasuryFee, uint256 lenderDue) = _exitingLenderDue(oldLoan, oldLoanId);
        // #3042 — the new lender's net principal pays the old lender inside
        // the Diamond; the holder's wallet pays only the rest of the due and
        // the treasury fee.
        _settlePayoff(
            oldLoanId,
            newLoanId,
            borrowerOfferId,
            currentBorrowerNftOwner,
            treasuryFee,
            lenderDue
        );

        // Record lender's claimable. heldForLender handled by ClaimFacet.
        s.lenderClaims[oldLoanId] = LibVaipakam.ClaimInfo({
            asset: oldLoan.principalAsset,
            amount: lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        // #592 — refinance is a terminal close of the OLD loan: the old
        // lender's proceeds land in their (possibly transferred-away) vault and
        // are owed to the current old-position holder via the claim above.
        // Reserve VPFI proceeds against the unstake path until that holder
        // claims (released path-agnostically in ClaimFacet). `oldLoan.lender`
        // is fixed for the now-terminal old loan. No-op for non-VPFI principal.
        if (oldLoan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                oldLoanId, oldLoan.lender, oldLoan.principalAsset, lenderDue
            );
        }
        // #998 S10 (#1006 / #1132) F2 — refinance terminally closes the OLD loan
        // and parks the old lender's proceeds into `oldLoan.lender`'s vault, owed to
        // the CURRENT lender-position holder via the claim recorded above. The old
        // lender is NOT the caller and its position may have been transferred to a
        // flagged wallet, so it needs a fail-closed frozen-claimant marker; both
        // holders' markers are recorded centrally at the `Repaid` transition below
        // (via `EncumbranceMutateFacet.terminalize`). The old lender NFT is only
        // status-updated (not burned) further below, so `ownerOf` still resolves at
        // the transition.

        // T-086 follow-up to step 14 — clear any active prepay listing on
        // the OLD loan BEFORE the collateral withdrawal below. Placement
        // matters here: `LibPrepayCleanup.clearActiveListing` calls
        // `vault.setCollateralOperatorApproval(..., approved=false)` on
        // ERC721 collateral, which performs `IERC721.approve(address(0),
        // tokenId)` from the vault. After the collateral has been
        // withdrawn out of the vault (lines below), the vault is no
        // longer the token owner and standard ERC721s revert that approve
        // call — leaving refinance permanently broken for ERC721
        // collateral loans that carry a live listing.
        //
        // Refinance is gated on `oldLoan.assetType == ERC20` upstream
        // (line ~109) so rental loans never reach here; for the
        // ERC20-principal + NFT-collateral case this is the right
        // moment: principal-asset payments to the old lender have
        // already committed (so we know the borrower paid), no
        // collateral has been touched yet, and the listing's
        // bookkeeping can be cleared while the vault still owns the
        // NFT. Idempotent no-op when no listing is live.
        // Codex round-1 P1 fix on PR #317.
        LibPrepayCleanup.clearActiveListing(oldLoan, oldLoanId);

        // ── Collateral handling — carry-over vs fresh pledge ──
        // #576 — a CARRY-OVER refinance (tagged + NON-transferred +
        // single-value, per `LibAutoRefinanceCheck.isCarryOver`) reuses the OLD
        // loan's collateral IN PLACE: OfferCreateFacet skipped the fresh deposit
        // + escrow and LoanFacet skipped the fresh lien (all keyed off the same
        // predicate), so the collateral is already in the borrower's vault and
        // we just RETAG the lien old→new (`sameKey` — no aggregate change, no
        // 2x lock). Because carry-over is NON-transferred, `newLoan.borrower`
        // (= offer.creator) already equals `oldLoan.borrower`, so the loan was
        // born correct — no post-init pin, no event/index/reward divergence.
        //
        // Everything else — a TRANSFERRED or RANGED tagged offer — pledged a
        // fresh collateral batch at create and carries its own fresh lien, so
        // it takes the fresh-pledge path: release the old lien and return the
        // old collateral to the current borrower-position holder.
        // Reads the PERSISTED create-time decision on the offer — the same
        // flag the deposit/lien skips keyed off, so retag-vs-return can't
        // disagree with whether a fresh batch was actually deposited.
        LibVaipakam.Offer storage bOffer = s.offers[borrowerOfferId];
        if (bOffer.refinanceCarryOver) {
            // Validate the FULL collateral identity matches the old loan (Codex
            // round-1 P2). The tag check only proved asset + type, so without
            // this a borrower could advertise a different amount / tokenId /
            // quantity that a lender accepts, then end up backed by the OLD
            // collateral instead (no LTV gate catches NFT/illiquid mismatch).
            // Reverting unwinds the whole atomic accept-and-refinance.
            if (
                newLoan.collateralAsset != oldLoan.collateralAsset ||
                newLoan.collateralAssetType != oldLoan.collateralAssetType ||
                newLoan.collateralAmount != oldLoan.collateralAmount ||
                newLoan.collateralTokenId != oldLoan.collateralTokenId ||
                newLoan.collateralQuantity != oldLoan.collateralQuantity
            ) revert InvalidRefinanceOffer();
            // Require the OLD loan's lien to be LIVE (Codex round-1 P2):
            // `rekeyCollateralLienOnRefinance` silently no-ops on a missing /
            // released lien, which would leave the carried collateral
            // UNENCUMBERED under the new loan (withdrawable before close). Every
            // ERC-20 loan post-#565 carries a lien, so this only fires on a
            // genuinely un-encumbered position — fail closed.
            LibVaipakam.Encumbrance storage oldLien = s.loanCollateralLien[oldLoanId];
            if (oldLien.released || oldLien.user == address(0)) {
                revert InvalidRefinanceOffer();
            }
            // #576 Codex round-7 P1 — the retag is STRICT: it only succeeds when
            // the old lien's key matches the new loan EXACTLY (same user, asset,
            // tokenId, amount, kind). If the target obligation migrated to a
            // different borrower since this carry-over offer was created (the
            // old lien is now keyed to the migrated-in borrower, the new loan's
            // borrower is the original creator after the borrower NFT returns to
            // them), the keys diverge; falling back to release+create would
            // back the replacement loan with an accounting-only lien against an
            // empty vault (the carry-over offer pledged no fresh collateral).
            // Reject the stale carry-over instead — fail closed.
            if (
                !LibEncumbrance.rekeyCollateralLienOnRefinance(
                    oldLoanId, newLoanId, newLoan
                )
            ) {
                revert InvalidRefinanceOffer();
            }
        } else {
            // #658 PR-B (#594 arc, Codex #690 round-2 P2) — NON-carry-over is a
            // real borrower close-out: the old collateral is returned and the
            // old loan goes Repaid. Consolidate the BORROWER side to its current
            // holder FIRST (while still Active), so the collateral lien, reward
            // entry, and VPFI checkpoint follow the holder, not the departed
            // stored borrower. After the
            // re-anchor `oldLoan.borrower` IS the current holder, so the
            // release+withdraw below sources from the right vault. (Done only on
            // this branch — carry-over keeps the borrower + re-tags the
            // collateral, so a borrower consolidation there would be a no-op at
            // best and fight the re-tag at worst.)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    ConsolidationFacet.eagerConsolidateToHolder.selector,
                    oldLoanId,
                    /* isLenderSide */ false
                ),
                bytes4(0)
            );
            // Legacy: release the old lien BEFORE the withdraw (the chokepoint
            // guard would otherwise block the legitimate refinance return).
            // The old collateral lives in `oldLoan.borrower`'s vault (the
            // custody key — now the consolidated current holder); deliver it to
            // `currentBorrowerNftOwner` (the rightful current holder).
            _releaseOldLienAtRefinance(oldLoanId);
            if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                uint256 oldCol = oldLoan.collateralAmount;
                if (oldCol > 0) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC20.selector,
                            oldLoan.borrower,
                            oldLoan.collateralAsset,
                            currentBorrowerNftOwner,
                            oldCol
                        ),
                        VaultWithdrawFailed.selector
                    );
                    // #1820 — the withdraw refreshes the holder's tier record
                    // at the post-return balance.
                }
            } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC721.selector,
                        oldLoan.borrower,
                        oldLoan.collateralAsset,
                        oldLoan.collateralTokenId,
                        currentBorrowerNftOwner
                    ),
                    VaultWithdrawFailed.selector
                );
            } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC1155.selector,
                        oldLoan.borrower,
                        oldLoan.collateralAsset,
                        oldLoan.collateralTokenId,
                        oldLoan.collateralQuantity,
                        currentBorrowerNftOwner
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        }

        // Post-refinance LTV + HF gates — the same branches the replacement
        // loan was admitted under at acceptance (#2380).
        _requirePostRolloverRisk(newLoanId, newLoan, oldLoan.collateralAsset);

        // Update old loan NFTs: mark lender NFT as Loan Repaid
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                oldLoan.lenderTokenId,
                oldLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );
        // Preserve old borrower NFT as a LoanRepaid-status receipt so the
        // borrower retains a redeemable claim on the original position even
        // after refinancing into a new loan.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                oldLoan.borrowerTokenId,
                oldLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );

        // Mark old loan closed — refinance only operates on Active loans.
        // #1132 (S10 central enforcement) — route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active→Repaid
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place (the standalone lender register above was folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                oldLoanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            ),
            bytes4(0)
        );
        // #969 / S5 (#998 Tranche 2) — close the OLD loan's reward entries. The
        // new refinanced loan (`newLoanId`) already registered its own fresh
        // entries at initiation, so leaving the old entries open double-counted
        // the same principal in both the numerator AND the denominator. The
        // exiting old lender is paid in full and never forfeits. The borrower
        // rolls into the new loan — CLEAN only when the refinance happens IN
        // GRACE; a late refinance (past grace, before default was triggered) is a
        // non-clean close and forfeits the old borrower reward, matching the
        // preclose/repay convention (Codex #1061 P2).
        uint256 oldGraceEnd = LibLoanClock.graceEnd(oldLoan);
        LibInteractionRewards.closeLoan(
            oldLoanId,
            /* borrowerClean */ block.timestamp <= oldGraceEnd,
            /* lenderForfeit */ false
        );
        // #407 PR 4 (T-407-B, 2026-06-12) — collateral lien release
        // moved to BEFORE the old-collateral withdraw above so the
        // {VaultFactoryFacet.vaultWithdrawERC20} guard clears. See the
        // explanatory comment at the new call site.

        // T-092 Phase 2a (Codex round-1 P2) — emit the current
        // borrower-NFT owner as the borrower (msg.sender is the Diamond
        // on both atomic routes) so indexers / activity feeds attribute
        // the row to the actual borrower, matching the fund flow above.
        emit LoanRefinanced(
            oldLoanId,
            newLoanId,
            currentBorrowerNftOwner,
            oldLoan.lender,
            newLender,
            uint8(oldLoan.status)
        );
    }

    /// @dev #3042 — the payoff legs, in the old loan's principal asset (the
    ///      replacement's too: asset continuity was checked). `net` is the new
    ///      lender's net principal the accept left in their vault
    ///      ({LibRefinanceNetting}); all of it goes to the old lender, who is
    ///      made whole before anyone else. The holder's wallet pays only the
    ///      rest of the old lender's due and the treasury fee, so their
    ///      approval need cover only that. `net` never exceeds the due (see
    ///      the contract header); a surplus is refused, never kept. Every leg
    ///      is voluntary and refused unless delivered in full.
    ///
    ///      #998 S10 (#1006) F2 — both legs into the old lender's vault land
    ///      behind the receive-side pin on `oldLoan.lender`: the old lender is
    ///      being CLOSED OUT, so a sanctions-flagged lender-of-record's proceeds
    ///      are parked in their EXISTING vault (#831 freeze-not-seize) instead
    ///      of bricking the borrower's refinance; `end` emits the audit event
    ///      for a flagged owner. Its own frame because {_refinanceLoanLogic} is
    ///      at the viaIR stack budget.
    function _settlePayoff(
        uint256 oldLoanId,
        uint256 newLoanId,
        uint256 borrowerOfferId,
        address holder,
        uint256 treasuryFee,
        uint256 lenderDue
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage oldLoan = s.loans[oldLoanId];
        address newLender = s.loans[newLoanId].lender;
        address asset = oldLoan.principalAsset;
        uint256 net = LibRefinanceNetting.take(borrowerOfferId, newLender, asset);
        if (net > lenderDue) revert RefinanceNetPrincipalExceedsPayoff(net, lenderDue);
        uint256 borrowerToOldLender = lenderDue - net;

        LibSanctionedLock.begin(s, oldLoan.lender);
        // The net principal moves vault to vault: it never leaves the Diamond's
        // custody model, and the old lender's tracked balance ticks with it.
        LibFacet.vaultWithdrawExact(
            newLender,
            asset,
            LibFacet.getOrCreateVault(oldLoan.lender),
            net,
            VaultWithdrawFailed.selector
        );
        LibVaipakam.recordVaultDeposit(oldLoan.lender, asset, net);
        if (borrowerToOldLender > 0) {
            // The cross-payer chokepoint ticks the old lender's tracked
            // balance while the holder pays.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultDepositERC20From.selector,
                    holder,
                    oldLoan.lender,
                    asset,
                    borrowerToOldLender
                ),
                VaultDepositFailed.selector
            );
        }
        LibSanctionedLock.end(s, oldLoan.lender, oldLoanId, asset, lenderDue);

        // #1281-011 — the one payer -> treasury pull (refuses a short arrival).
        LibFacet.transferFromPayerToTreasury(holder, asset, treasuryFee);
        emit RefinancePayoffSettled(
            oldLoanId,
            newLoanId,
            asset,
            net,
            borrowerToOldLender,
            treasuryFee
        );
    }

    /// @dev The exiting lender's settlement on a refinance: the treasury fee
    ///      on the interest (after any lender yield-fee discount) and what the
    ///      old lender is owed. A VPFI-paid discount debits the lender's vault
    ///      here and emits its analytics passthrough here, before the payouts.
    ///      Its own frame because {_refinanceLoanLogic} is at the viaIR stack
    ///      budget.
    function _exitingLenderDue(LibVaipakam.Loan storage oldLoan, uint256 oldLoanId)
        private
        returns (uint256 treasuryFee, uint256 lenderDue)
    {
        uint256 oldInterest = LibEntitlement.settlementInterestNet(
            oldLoan,
            block.timestamp
        );

        // #411 fix (2026-06-12) — DROPPED the rate-shortfall addend
        // that previously over-compensated the exiting old lender at
        // borrower expense. Spec §2127 / §2138 (the "Original Lender
        // Protection Rule") historically required a shortfall =
        // `oldFullTerm - newFullTerm` top-up on top of full-term
        // interest. But full-term IS the lender's maximum possible
        // earnings on this loan; paying ANY additional shortfall
        // pushes them BEYOND their ceiling, funded by the borrower
        // (`oldInterest + shortfall = P + 2·oldFullTerm − newFullTerm`).
        //
        // The Protection Rule is structurally satisfied by paying
        // `principal + full-term interest` to an exiting lender —
        // they are strictly whole at their maximum entitlement.
        //
        // The shortfall is still NECESSARY on the obligation-transfer
        // / offset paths (`PrecloseFacet.transferObligationViaOffer`)
        // where the lender STAYS on the loan and earns the NEW rate
        // going forward — there the shortfall genuinely bridges back
        // up to the original full-term. Refinance differs because the
        // old lender exits (`s.lenderClaims[oldLoanId]` is set and the
        // old loan closes). Refinance-path only fix; transfer/offset
        // shortfall unchanged.
        //
        // Design doc:
        // `docs/DesignsAndPlans/RefinanceOldLenderOverpayFix.md`
        // (Option 1 selected 2026-06-07).

        // Treasury fee on the interest portion, at the old loan's
        // snapshotted rate.
        // Lender Yield Fee discount (Tokenomics §6): when the old lender has
        // platform-level VPFI-discount consent AND holds >= the required VPFI
        // in vault, the treasury cut is paid in VPFI from the old lender's
        // vault and the old lender keeps 100% of interestPortion in the
        // lending asset. tryApplyYieldFee silently falls back on any
        // precondition failure.
        // Pass-2 A1/D5 (#1189) — a refinance that lands in the grace window
        // charges the same late fee `repayLoan` does (0 within term), split
        // treasury/lender like the interest. The yield-fee branch below keeps the
        // whole `interest + lateFee` for the lender (mirrors RepayFacet), so the
        // penalty is never silently dropped on the discounted path.
        uint256 lateFee = LibVaipakam.calculateLateFee(oldLoanId);
        uint256 interestPortion = oldInterest + lateFee;
        uint256 lenderInterest;
        (treasuryFee, lenderInterest) = LibEntitlement.splitTreasury(
            oldLoan,
            interestPortion
        );
        // #1354 §F2 / #1383 — eligibility is `consent OR lenderMode == Full` (a
        // Full lender earns the +10% even without hold-discount consent). The
        // shared resolve helper runs the whole VPFI-payment-then-direct-reduction
        // delivery, returning the deltas to fold in.
        //
        // #1947 — keyed EXPLICITLY on the current position-NFT holder. This used
        // the `resolveLenderYieldFee(oldLoan, ...)` form, which resolves
        // `oldLoan.lender` internally, on the stated grounds that the refinance
        // had consolidated the slot to the current holder earlier. It attempts
        // that consolidation, but the consolidation is Tier-2 *skip-not-block*:
        // it declines rather than reverting for a sanctioned holder or an
        // excluded lender state, so a call to it is NOT proof the field is
        // fresh. On a transferred position that fell through the skip, the
        // stale address priced the discount off the PREVIOUS lender's hold tier
        // and — once the peg is set — debited that party's VPFI vault for a
        // reduction the buyer receives.
        // Held in a local because the analytics passthrough below must name the
        // SAME party: this facet calls the library directly rather than through
        // `VPFIDiscountFacet`, so unlike every other settlement path it emits
        // its own `emitYieldFeeDiscountApplied` and has to carry the settling
        // lender to it. Reporting `oldLoan.lender` there while charging the
        // holder here would have indexers attribute the VPFI debit to the
        // previous lender — precisely the transferred-position case this fix is
        // about (Codex #1953 r1 P2).
        address settlingLender = LibERC721.ownerOf(oldLoan.lenderTokenId);
        (uint256 lenderExtra, uint256 newTreasuryFee, uint256 yieldVpfiDeducted) =
            LibVPFIDiscount.resolveLenderYieldFeeFor(
                oldLoan,
                settlingLender,
                interestPortion,
                treasuryFee
            );
        if (lenderExtra > 0) {
            lenderInterest += lenderExtra;
            treasuryFee = newTreasuryFee;
        }
        lenderDue = oldLoan.principal + lenderInterest;

        // Passthrough event for lender yield-fee VPFI discount so indexers
        // subscribe to a single facet for all VPFI-discount analytics.
        if (yieldVpfiDeducted > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector,
                    oldLoanId,
                    settlingLender,
                    oldLoan.principalAsset,
                    yieldVpfiDeducted
                ),
                TreasuryTransferFailed.selector
            );
        }
    }

    /// @dev #407 PR 4 (T-407-B) — release the OLD loan's collateral lien
    ///      before the fresh-pledge refinance return-withdraw of the same
    ///      collateral (the chokepoint guard would otherwise block it).
    ///      Used only on the fresh-pledge path; the carry-over path retags
    ///      the lien instead (#576). Extracted to
    ///      keep the cross-facet call's transient locals in their own stack
    ///      frame.
    function _releaseOldLienAtRefinance(uint256 oldLoanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseCollateralLien.selector,
                oldLoanId
            ),
            bytes4(0)
        );
    }

    /**
     * @dev The post-rollover risk gate, branch for branch the one the
     *      replacement loan was admitted under at acceptance
     *      (`LoanFacet`'s initiation gate), so refinance can neither admit a
     *      position initiation would reject nor reject one it admitted.
     *
     *      #2380 / #2956 — the ILLIQUID branch. Initiation runs the LTV and
     *      health-factor checks only on a pair liquid on both legs
     *      ({LibInitRiskGate.applies}); a pair with an illiquid leg has no LTV
     *      or health factor to compute and is admitted on the illiquid
     *      risk-and-terms consent every loan carries. Refinance used to run the
     *      checks unconditionally and so reverted `IlliquidLoanNoRiskMath` on
     *      every such replacement, after the payoff had run. The branch reads
     *      the replacement loan's OWN liquidity stamps, which acceptance wrote
     *      from exactly the values initiation tested, so it re-derives nothing
     *      live: a liquidity change between acceptance and here cannot strand a
     *      replacement the borrower was admitted into, the same race the
     *      snapshotted caps below close for the liquid branch.
     *
     *      The exiting lender gives no consent: they are paid out in full.
     */
    function _requirePostRolloverRisk(
        uint256 newLoanId,
        LibVaipakam.Loan storage newLoan,
        address oldCollateralAsset
    ) private view {
        if (!LibInitRiskGate.applies(newLoan.principalLiquidity, newLoan.collateralLiquidity)) return;

        // Mirrors
        // `LoanFacet._checkInitialLtvAndHf` exactly so refinance can't
        // admit a position that would have been rejected at init —
        // both regimes (depth-tiered ON / OFF) must agree.
        //
        // Regime OFF (default / pre-flip): today's gate — `LTV ≤
        // assetRiskParams.loanInitMaxLtvBps` and `HF ≥ 1.5e18`.
        //
        // Regime ON (post-flip per chain): cap LTV at
        // `min(loanInitMaxLtvBps, effectiveTierMaxInitLtvBps[effectiveTier(
        // collateral)])` and relax HF floor to `≥ 1e18` (tier cap is
        // the binding buffer; see LoanFacet for full rationale).
        bytes memory ltvResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, newLoanId),
            LTVCalculationFailed.selector
        );
        uint256 newLtv = abi.decode(ltvResult, (uint256));
        // #394 Lever A (Codex #647 round-4) — compare against the replacement
        // loan's SNAPSHOTTED admission init-LTV cap (acceptOffer stored it when
        // it admitted `newLoan`; the snapshot already encodes the tiered
        // `min(assetCap, tierCap)` vs non-tiered `assetCap` branch), NOT a
        // freshly-recomputed live asset/tier cap, so refinance tests exactly the
        // gate the replacement was admitted under (the HF gate below reads its
        // snapshot for the same reason).
        uint256 cap = LibVaipakam.effectiveLoanInitLtvCapBps(
            newLoan.initLtvCapBpsAtInit,
            LibVaipakam.assetInitLtvCeilingBps(oldCollateralAsset)
        );
        if (newLtv > cap) {
            // Preserve the regime-specific error (cosmetic; the cap value is the
            // load-bearing part and comes from the snapshot either way).
            if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
                revert IVaipakamErrors.InitLtvAboveTier(newLtv, cap);
            }
            revert LTVExceeded();
        }

        bytes memory hfResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                newLoanId
            ),
            HealthFactorCalculationFailed.selector
        );
        uint256 newHf = abi.decode(hfResult, (uint256));
        // #394 Lever A (Codex #647 round-2 P2) — `acceptOffer` already created
        // and ADMITTED `newLoan`, snapshotting the (branch-aware) floor it was
        // gated at onto `newLoan.minHealthFactorAtInit`. Compare against THAT
        // snapshot, not the live `minHealthFactor()` knob, so refinance tests
        // exactly the floor the replacement was admitted at. The snapshot
        // already encodes the tiered (1e18) vs non-tiered branch.
        uint256 hfFloor =
            LibVaipakam.effectiveLoanMinHealthFactor(newLoan.minHealthFactorAtInit);
        if (newHf < hfFloor) revert HealthFactorTooLow();
    }

    // ─── #2407 — the loan → refinance-request index ─────────────────────

    /// @notice The refinance request (a refinance-tagged borrower offer)
    ///         recorded for `loanId`, and whether it is LIVE — whether it still
    ///         STANDS: it exists, is not taken, still targets the loan, has not
    ///         expired, the loan is Active and its creator still holds the
    ///         borrower position. While `live` is true the borrower actions
    ///         that would change the loan underneath it revert
    ///         {IVaipakamErrors.RefinanceRequestOpen}; the moment it stops
    ///         standing — taken, cancelled, expired, the position handed on, the
    ///         loan closed — it stops holding the loan back, with no write
    ///         anywhere. `live` does NOT say a lender could fill it now: the
    ///         holder's caps, the payoff approval, an overdue period or the
    ///         market can each refuse acceptance, and the remedy for a request
    ///         that can no longer fill is to cancel it.
    ///         {checkRefinanceRequest} reports the acceptance-side reasons it
    ///         can know.
    /// @dev    A recorded request that is no longer live is still reported, so
    ///         a client can tell an expired-but-uncancelled request (whose token
    ///         approval or pledge the borrower may want back) from no request at
    ///         all; `offerId` is 0 only when nothing was ever recorded. Only
    ///         the recorded request can be taken, so a request posted BEFORE
    ///         the record existed is neither seen here nor takeable: it does not
    ///         hold the loan back either, and its borrower cancels and re-posts
    ///         it. (A migration that recorded such requests was tried and
    ///         withdrawn — every rule it needed to decide which pre-upgrade
    ///         request to trust opened another way to resurrect or race one.)
    function getRefinanceRequest(
        uint256 loanId
    ) external view returns (uint256 offerId, bool live) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        offerId = s.refinanceRequestOfLoan[loanId];
        if (offerId == 0) return (0, false);
        live = LibRefinanceRequest.stands(s, loanId, offerId);
    }

    /// @notice Revert with the reason `offerId` could not be accepted as
    ///         `loanId`'s refinance request right now; return if it could.
    ///         {IVaipakamErrors.RefinanceRequestNotLive} covers the request's
    ///         own state (gone, taken, retargeted, expired); every other reason
    ///         is the one acceptance itself would give
    ///         (`LibAutoRefinanceCheck`'s target, ownership, asset, principal
    ///         and cap errors, and the offset, intent, overdue-period and
    ///         carry-over checks). Informational: the guard reads
    ///         {getRefinanceRequest}'s `live`, not this. Does not check that it
    ///         is the RECORDED request, nor the payoff funding or the market.
    function checkRefinanceRequest(uint256 loanId, uint256 offerId) external view {
        LibRefinanceRequest.assertAcceptable(LibVaipakam.storageSlot(), loanId, offerId);
    }
}
