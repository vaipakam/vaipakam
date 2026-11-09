// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {Handler} from "./Handler.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {RepayPeriodicFacet} from "../../src/facets/RepayPeriodicFacet.sol";
import {ForcedSaleFacet} from "../../src/facets/ForcedSaleFacet.sol";
import {RefinanceFacet} from "../../src/facets/RefinanceFacet.sol";
import {Vm} from "forge-std/Vm.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";

/**
 * @title  LoanLedgerHandler
 * @notice Per-loan settlement ledger for #3241. Wraps the shared {Handler}: every action is run
 *         through it, and around each one this contract takes a balance snapshot of every
 *         holder in the closed system and books the change against the loan the action
 *         touched.
 *
 *         A party's HOLDINGS are its wallet balance plus its vault balance, so a move between a
 *         user's own wallet and own vault (posting collateral, escrowing an offer, a claim
 *         paying out of the vault) is not a payment and books nothing. What is booked is value
 *         crossing between parties: lender, borrower, the Diamond (which is also the treasury in
 *         this rig) and the caller of a permissionless step (the inner handler, which a keeper
 *         incentive would pay).
 *
 *         Per action it records, as violation counters the invariant suite reads:
 *         - ISOLATION: no actor who is not a party to the loan has its holdings move. An action
 *           on one loan that pays out of, or into, a third user's funds is the cross-loan theft
 *           supply conservation cannot see.
 *         - PERIMETER: no token leaves or enters the tracked set (actors, their vaults, the
 *           Diamond, the caller, the market). The rig's one working swap venue is the MARKET; it
 *           is tracked like a party and may move only inside a periodic-interest sale.
 *         - PERIODIC: a periodic-interest settlement whose period is already paid moves nothing;
 *           one that sells pays the lender side at most the period's shortfall, and the market
 *           takes at most the collateral the forced-sale preview allows (`maxSell`) and gives
 *           only principal asset for it.
 *         - ACCEPT: at origination the borrower is charged the Loan Initiation Fee (0.2% of
 *           principal, spec "Treasury Fees"), the acceptor receives the 1% matcher share of it,
 *           and the Diamond keeps the rest; the side that did not accept moves exactly the
 *           principal (lender) or the principal less the fee (borrower).
 *         - INTEREST: a loan closed by one full repayment, on time and with no earlier partial,
 *           pays exactly `floor(principal x rate x elapsed / (365 days x 10_000))` of interest
 *           (spec "Interest Formula": to the second, rounded down once per settlement).
 *
 *         The cumulative per-loan ledger is exposed for the bounds the invariant suite checks
 *         after every call (see `LoanSettlementBound.invariant.t.sol`).
 *
 * @dev    The wrapper replays the inner handler's own index selection (`bound(idx, 0, len - 1)`
 *         over the same arrays) to learn which loan an action touched. `bound` is deterministic,
 *         so the two always agree.
 */
contract LoanLedgerHandler is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;
    /// @dev Spec "Treasury Fees": the Loan Initiation Fee is 0.2% of the lending-asset amount.
    uint256 internal constant LIF_BPS = 20;
    /// @dev Spec "Keeper-matcher": whoever completes a match earns 1% of the Loan Initiation Fee.
    uint256 internal constant MATCHER_SHARE_BPS = 100;
    /// @dev Spec "Late Fees": the total late fee is capped at 5% of the outstanding principal.
    uint256 internal constant LATE_FEE_CAP_BPS = 500;

    /// @dev Index of each tracked asset in the per-asset arrays.
    uint256 internal constant USDC = 0;
    uint256 internal constant WETH = 1;

    InvariantBase public base;
    Handler public inner;
    address public diamond;
    address[2] public assets;

    /// @dev The six actors, then their vaults, in a fixed order.
    address[6] internal actors;
    address[6] internal vaults;

    /// @notice One snapshot of every tracked balance, per asset.
    struct Snap {
        uint256[2][6] actor; // wallet + vault
        uint256[2] diamond;
        uint256[2] caller; // the inner handler: msg.sender of permissionless steps
        uint256[2] market; // the working swap venue
        uint256[2] outside; // totalSupply minus everything above
    }

    /// @notice A loan's cumulative booked deltas, per asset, and the terms the bounds need.
    struct LoanBook {
        bool known;
        address lender;
        address borrower;
        uint256 principal0;
        uint256 rateBps;
        uint64 startTime;
        uint256 dueTime;
        uint256 collateralIn; // initial collateral plus every top-up
        uint256 lastActionTs;
        bool hadPartial;
        /// @dev #3241 — every holder the lender position has had. A sale moves value between
        ///      them (the buyer pays the seller), so the lender side is booked as one party.
        mapping(address => bool) lenderSide;
        /// @dev #3241 — a periodic settlement sold this loan's collateral: the borrower's
        ///      collateral became principal asset, so its principal-asset bound is read in value.
        bool hadPeriodicSale;
        /// @dev #3241 — closed by a preclose offset. Its lender may be paid the interest the
        ///      original term would still have earned, past what has accrued so far.
        bool offsetClosed;
        /// @dev #3241 — an NFT rental: the principal is the daily fee, paid from a USDC
        ///      prepayment (rent for the whole term plus the buffer) the renter holds in its own
        ///      vault. `rentOwed` is set when the rental closes on time: the fee times every day
        ///      used, any part of a day counting as a whole day, never past the term.
        bool isRental;
        uint256 tokenId;
        uint256 termDays;
        uint256 prepay;
        uint256 rentOwed;
        bool rentOwedSet;
        bool renterSettledChecked;
        bool lenderSettledChecked;
        int256[2] dLender;
        int256[2] dBorrower;
        int256[2] dDiamond;
        int256[2] dCaller;
        int256[2] dMarket;
    }

    mapping(uint256 => LoanBook) internal books;
    uint256[] public bookedLoanIds;

    // ── Violation counters (must stay zero) and the first failure's reason ──
    uint256 public isolationViolations;
    uint256 public perimeterViolations;
    uint256 public acceptViolations;
    uint256 public interestViolations;
    uint256 public periodicViolations;
    uint256 public offsetViolations;
    uint256 public refinanceViolations;
    uint256 public rentalViolations;
    string public firstViolation;

    // ── Coverage counters: how often each per-action check actually ran ──
    uint256 public acceptChecks;
    uint256 public interestChecks;
    uint256 public bookedActions;
    uint256 public precloseLanded;
    uint256 public liquidationLanded;
    uint256 public saleLanded;
    uint256 public periodicStamped;
    uint256 public periodicSold;
    uint256 public offsetLanded;
    uint256 public refinanceLanded;
    uint256 public rentalsOpened;
    uint256 public rentDeductions;
    uint256 public rentalsFullyDeducted;
    uint256 public rentalChecks;

    /// @dev Set only while a periodic-interest sale is booked: the one action the market may trade in.
    bool internal marketOpen;
    address public market;

    constructor(InvariantBase _base) {
        base = _base;
        inner = new Handler(_base);
        diamond = address(_base.diamond());
        assets[USDC] = _base.mockUsdc();
        assets[WETH] = _base.mockWeth();
        market = address(_base.workingVenue());
        for (uint256 i = 0; i < 3; i++) {
            actors[i] = _base.lenderAt(i);
            actors[i + 3] = _base.borrowerAt(i);
        }
        for (uint256 i = 0; i < 6; i++) {
            vaults[i] = VaultFactoryFacet(diamond).getUserVaultAddress(actors[i]);
        }
        inner.enableRentals();
    }

    // ── Wrapped actions ────────────────────────────────────────────────

    /// @notice Lender posts an offer. Escrow is wallet -> own vault, so nothing may move.
    function createLenderOffer(uint256 s, uint256 a, uint256 d, uint256 r, uint256 c) external {
        Snap memory before = _snap();
        inner.createLenderOffer(s, a, d, r, c);
        _requireNoMovement(before, "createLenderOffer");
    }

    /// @notice Borrower posts a request. Collateral is wallet -> own vault, so nothing may move.
    function createBorrowerOffer(uint256 s, uint256 a, uint256 d, uint256 r, uint256 c) external {
        Snap memory before = _snap();
        inner.createBorrowerOffer(s, a, d, r, c);
        _requireNoMovement(before, "createBorrowerOffer");
    }

    function acceptLenderOffer(uint256 borrowerSeed, uint256 offerIdx) external {
        uint256 n = inner.loanIdsLength();
        uint256 offsetOf = _pickedOffsetLoan(offerIdx);
        // An offset accept whose acceptor already holds the closing loan's lender side (an
        // earlier offset made a borrower a lender) puts one party on both loans in two roles,
        // and its delta cannot be split between them. The ledger does not drive that case.
        if (offsetOf != 0) {
            address acceptor = base.borrowerAt(borrowerSeed);
            LoanBook storage b1 = books[offsetOf];
            if (acceptor == b1.lender || b1.lenderSide[acceptor]) return;
        }
        Snap memory before = _snap();
        inner.acceptLenderOffer(borrowerSeed, offerIdx);
        if (offsetOf != 0 && inner.loanIdsLength() != n) {
            _afterOffsetAccept(n, offsetOf, before);
        } else {
            _afterAccept(n, before, true);
        }
    }

    /// @notice #3241: the borrower starts the preclose offset by posting a lender offer from its
    ///         own principal. The escrow is wallet -> own vault, so nothing may move.
    function offsetLoan(uint256 loanIdx, uint256 rateBps, uint256 durationDays) external {
        Snap memory before = _snap();
        inner.offsetLoan(loanIdx, rateBps, durationDays);
        _requireNoMovement(before, "offsetLoan");
    }

    function acceptBorrowerOffer(uint256 lenderSeed, uint256 offerIdx) external {
        uint256 n = inner.loanIdsLength();
        uint256 refinanceOf = _pickedRefinanceLoan(offerIdx);
        if (refinanceOf == 0) {
            Snap memory before0 = _snap();
            inner.acceptBorrowerOffer(lenderSeed, offerIdx);
            _afterAccept(n, before0, false);
            return;
        }
        // A refinance accept by a lender who already holds the closing loan's lender side puts
        // one party on both loans, and its delta cannot be split between them. Not driven.
        address acceptor = base.lenderAt(lenderSeed);
        LoanBook storage b1 = books[refinanceOf];
        if (acceptor == b1.lender || b1.lenderSide[acceptor]) return;
        LibVaipakam.Loan memory pre = _loan(refinanceOf);
        Snap memory before = _snap();
        vm.recordLogs();
        inner.acceptBorrowerOffer(lenderSeed, offerIdx);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (inner.loanIdsLength() == n) {
            _requireNoMovement(before, "refinance accept (no loan)");
            return;
        }
        _afterRefinanceAccept(n, refinanceOf, pre, before, logs);
    }

    /// @notice #3241: a lender lists an NFT for rent. The NFT moves into its own vault, and no
    ///         token balance may move.
    function createRentalOffer(uint256 s, uint256 t, uint256 fee, uint256 d) external {
        Snap memory before = _snap();
        inner.createRentalOffer(s, t, fee, d);
        _requireNoMovement(before, "createRentalOffer");
    }

    /// @notice #3241: a borrower rents a listed NFT. Its prepayment moves wallet -> own vault and
    ///         nothing crosses parties: a rental charges no Loan Initiation Fee, and the lender
    ///         is paid only as the rent is earned.
    function acceptRentalOffer(uint256 borrowerSeed, uint256 offerIdx) external {
        uint256 n = inner.loanIdsLength();
        Snap memory before = _snap();
        inner.acceptRentalOffer(borrowerSeed, offerIdx);
        if (inner.loanIdsLength() == n) {
            _requireNoMovement(before, "acceptRentalOffer (no loan)");
            return;
        }
        uint256 loanId = inner.loanIdAt(n);
        _register(loanId);
        _book(loanId, before, "acceptRentalOffer");
        LoanBook storage b = books[loanId];
        rentalsOpened++;
        for (uint256 a = 0; a < 2; a++) {
            if (b.dLender[a] != 0 || b.dBorrower[a] != 0 || b.dDiamond[a] != 0 || b.dCaller[a] != 0) {
                rentalViolations++;
                _flag("acceptRentalOffer: value crossed between parties when the rental opened");
            }
        }
    }

    /// @notice #3241: the daily rent deduction pays the lender side at most one day's fee and
    ///         takes at most that from the renter. The deduction that pays the term's last day
    ///         closes the rental with no late fee and the whole buffer refunded, so the rent it
    ///         owes is the whole term, whenever that deduction lands.
    function autoDeductDaily(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        LibVaipakam.Loan memory pre = _loan(loanId);
        uint256 lastBefore = pre.lastDeductTime;
        Snap memory before = _snap();
        inner.autoDeductDaily(loanIdx);
        int256[2] memory dB = _book(loanId, before, "autoDeductDaily");
        if (_loan(loanId).lastDeductTime == lastBefore) return; // nothing deducted
        rentDeductions++;
        LoanBook storage b = books[loanId];
        int256 fee = int256(b.principal0);
        if (dB[USDC] < -fee || dB[WETH] != 0) {
            rentalViolations++;
            _flag(string.concat("autoDeductDaily: renter charged ", vm.toString(-dB[USDC]), " for one day of ", vm.toString(fee)));
        }
        if (
            b.isRental && pre.status == LibVaipakam.LoanStatus.Active
                && _loan(loanId).status == LibVaipakam.LoanStatus.Repaid
        ) {
            rentalsFullyDeducted++;
            _setRentOwed(loanId, b.termDays);
        }
    }

    /// @notice #3241: the borrower asks to refinance a loan. Consenting to the rate cap, posting
    ///         the request on the loan's own collateral and attaching the payoff permit move
    ///         nothing.
    function refinanceRequest(uint256 loanIdx, uint256 rateBps, uint256 durationDays) external {
        Snap memory before = _snap();
        inner.refinanceRequest(loanIdx, rateBps, durationDays);
        _requireNoMovement(before, "refinanceRequest");
    }

    function repay(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        LibVaipakam.Loan memory pre = _loan(loanId);
        Snap memory before = _snap();
        inner.repay(loanIdx);
        int256[2] memory dB = _book(loanId, before, "repay");
        _checkExactInterest(loanId, pre, dB, false);
    }

    /// @notice #3241: a direct preclose closes the loan early. Booked like a repayment; when it
    ///         closes a loan with no earlier partial before its due time, the interest it pays is
    ///         checked exactly, the same as an on-time repayment.
    function precloseDirect(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        LibVaipakam.Loan memory pre = _loan(loanId);
        bool wasActive = pre.status == LibVaipakam.LoanStatus.Active;
        Snap memory before = _snap();
        inner.precloseDirect(loanIdx);
        int256[2] memory dB = _book(loanId, before, "precloseDirect");
        _checkExactInterest(loanId, pre, dB, true);
        if (wasActive && _loan(loanId).status != LibVaipakam.LoanStatus.Active) precloseLanded++;
    }

    function repayPartial(uint256 loanIdx, uint256 amount) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        uint256 principalBefore = _loan(loanId).principal;
        Snap memory before = _snap();
        inner.repayPartial(loanIdx, amount);
        _book(loanId, before, "repayPartial");
        if (_loan(loanId).principal != principalBefore) books[loanId].hadPartial = true;
    }

    function addCollateral(uint256 loanIdx, uint256 amount) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        uint256 collateralBefore = _loan(loanId).collateralAmount;
        Snap memory before = _snap();
        inner.addCollateral(loanIdx, amount);
        _book(loanId, before, "addCollateral");
        uint256 collateralAfter = _loan(loanId).collateralAmount;
        if (collateralAfter > collateralBefore) {
            books[loanId].collateralIn += collateralAfter - collateralBefore;
        }
    }

    function triggerDefault(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        Snap memory before = _snap();
        inner.triggerDefault(loanIdx);
        _book(loanId, before, "triggerDefault");
    }

    /// @notice #3241: a Health-Factor liquidation (in-kind fallback in this rig). Booked like a
    ///         default; the after-every-call bounds then hold it to what entered the loan.
    function triggerLiquidation(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        bool wasActive = _loan(loanId).status == LibVaipakam.LoanStatus.Active;
        Snap memory before = _snap();
        inner.triggerLiquidation(loanIdx);
        _book(loanId, before, "triggerLiquidation");
        if (wasActive && _loan(loanId).status != LibVaipakam.LoanStatus.Active) liquidationLanded++;
    }

    /// @notice #3241: the lender sells the position into a standing lender offer. The buyer
    ///         joins the loan's lender side, so the price it pays the seller nets out inside it;
    ///         what the side as a whole receives stays bounded by what entered the loan.
    function sellLoan(uint256 loanIdx, uint256 offerIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        address lenderBefore = _loan(loanId).lender;
        Snap memory before = _snap();
        inner.sellLoan(loanIdx, offerIdx);
        address lenderAfter = _loan(loanId).lender;
        if (lenderAfter == lenderBefore) {
            _requireNoMovement(before, "sellLoan (no sale)");
            return;
        }
        books[loanId].lenderSide[lenderAfter] = true;
        _book(loanId, before, "sellLoan");
        saleLanded++;
    }

    /// @notice #3241: settle a periodic-interest period (a just-stamp, or a collateral sale through
    ///         the market). The wrapper warps to the period's grace end itself, so the shortfall
    ///         and the sale bound it reads are the ones the settlement acts on.
    function settlePeriodic(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        LibVaipakam.Loan memory pre = _loan(loanId);
        if (pre.status != LibVaipakam.LoanStatus.Active) return;
        if (pre.periodicInterestCadence == LibVaipakam.PeriodicInterestCadence.None) return;
        (uint256 shortfall, uint256 maxSell) = _periodicBounds(loanId);

        Snap memory before = _snap();
        inner.settlePeriodic(loanIdx);
        LibVaipakam.Loan memory post = _loan(loanId);
        if (post.lastPeriodicInterestSettledAt == pre.lastPeriodicInterestSettledAt) {
            // Nothing settled (the sale reverted, or the loan was not eligible).
            _requireNoMovement(before, "settlePeriodic (not settled)");
            return;
        }
        if (shortfall == 0) {
            _requireNoMovement(before, "settlePeriodic (just-stamp)");
            periodicStamped++;
            return;
        }
        int256[2] memory dLenderBefore = [books[loanId].dLender[USDC], books[loanId].dLender[WETH]];
        int256[2] memory dMarketBefore = [books[loanId].dMarket[USDC], books[loanId].dMarket[WETH]];
        marketOpen = true; // the market may trade in this booking, and only in this one
        _book(loanId, before, "settlePeriodic");
        marketOpen = false;
        LoanBook storage b = books[loanId];
        b.hadPartial = true; // interest was paid mid-loan; the exact on-time check no longer applies
        b.hadPeriodicSale = true;
        periodicSold++;
        _checkPeriodicSale(b, shortfall, maxSell, dLenderBefore, dMarketBefore);
    }

    /// @dev Warps to the period's grace end when it is still ahead, then reads the shortfall and
    ///      the forced-sale preview's `maxSell` at that block.
    function _periodicBounds(uint256 loanId) internal returns (uint256 shortfall, uint256 maxSell) {
        (,, uint256 graceEndsAt,,,,) = RepayPeriodicFacet(diamond).previewPeriodicSettle(loanId);
        if (graceEndsAt > block.timestamp) vm.warp(graceEndsAt);
        (,,,,, shortfall,) = RepayPeriodicFacet(diamond).previewPeriodicSettle(loanId);
        maxSell = ForcedSaleFacet(diamond)
            .previewForcedSale(loanId, ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement).maxSell;
    }

    /// @dev Spec "Periodic Interest Payments": a missed period is covered by selling just enough
    ///      collateral; the lender is paid at most the shortfall, the market only buys collateral,
    ///      and never more than the preview allowed.
    function _checkPeriodicSale(
        LoanBook storage b,
        uint256 shortfall,
        uint256 maxSell,
        int256[2] memory dLenderBefore,
        int256[2] memory dMarketBefore
    ) internal {
        int256 lenderGot = b.dLender[USDC] - dLenderBefore[USDC];
        int256 marketWeth = b.dMarket[WETH] - dMarketBefore[WETH];
        int256 marketUsdc = b.dMarket[USDC] - dMarketBefore[USDC];
        if (lenderGot > int256(shortfall)) {
            periodicViolations++;
            _flag(string.concat("settlePeriodic: lender paid ", vm.toString(lenderGot), " > shortfall ", vm.toString(shortfall)));
        }
        if (b.dLender[WETH] != dLenderBefore[WETH]) {
            periodicViolations++;
            _flag("settlePeriodic: the lender side received collateral");
        }
        if (marketWeth < 0 || marketWeth > int256(maxSell) || marketUsdc > 0) {
            periodicViolations++;
            _flag(string.concat("settlePeriodic: market took ", vm.toString(marketWeth), " collateral, maxSell ", vm.toString(maxSell)));
        }
    }

    function claimAsLender(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        Snap memory before = _snap();
        inner.claimAsLender(loanIdx);
        _book(loanId, before, "claimAsLender");
        _checkRentalSettled(loanId);
    }

    function claimAsBorrower(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        Snap memory before = _snap();
        inner.claimAsBorrower(loanIdx);
        _book(loanId, before, "claimAsBorrower");
        _checkRentalSettled(loanId);
    }

    /// @notice Time passes; no balance may move.
    function warp(uint256 delta) external {
        Snap memory before = _snap();
        inner.warp(delta);
        _requireNoMovement(before, "warp");
    }

    // ── Accessors for the invariant suite ──────────────────────────────

    function bookedLoanCount() external view returns (uint256) {
        return bookedLoanIds.length;
    }

    /// @notice The terms and bounds inputs of a booked loan.
    function loanTerms(uint256 loanId)
        external
        view
        returns (uint256 principal0, uint256 rateBps, uint64 startTime, uint256 collateralIn, uint256 lastActionTs)
    {
        LoanBook storage b = books[loanId];
        return (b.principal0, b.rateBps, b.startTime, b.collateralIn, b.lastActionTs);
    }

    /// @notice A booked loan's cumulative deltas in asset `a` (0 = USDC principal, 1 = WETH collateral).
    function loanDeltas(uint256 loanId, uint256 a)
        external
        view
        returns (int256 dLender, int256 dBorrower, int256 dDiamond, int256 dCaller)
    {
        LoanBook storage b = books[loanId];
        return (b.dLender[a], b.dBorrower[a], b.dDiamond[a], b.dCaller[a]);
    }

    /// @notice Whether a preclose offset closed a booked loan, and the loan's original due time.
    function loanOffset(uint256 loanId) external view returns (bool closed, uint256 dueTime) {
        return (books[loanId].offsetClosed, books[loanId].dueTime);
    }

    /// @notice A booked loan's cumulative market delta in asset `a`, and whether a periodic
    ///         settlement ever sold its collateral.
    function loanMarket(uint256 loanId, uint256 a) external view returns (int256 dMarket, bool hadPeriodicSale) {
        LoanBook storage b = books[loanId];
        return (b.dMarket[a], b.hadPeriodicSale);
    }

    // ── Internals ──────────────────────────────────────────────────────

    /// @dev Replays the inner handler's pick: `bound(idx, 0, len - 1)` over its loan list.
    function _pickLoan(uint256 loanIdx) internal view returns (bool ok, uint256 loanId) {
        uint256 n = inner.loanIdsLength();
        if (n == 0) return (false, 0);
        loanId = inner.loanIdAt(_boundView(loanIdx, 0, n - 1));
        ok = books[loanId].known;
    }

    /// @dev `bound` without its console log, so a view can call it.
    function _boundView(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        return _bound(x, min, max);
    }

    function _loan(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(diamond).getLoanDetails(loanId);
    }

    function _snap() internal view returns (Snap memory s) {
        uint256 trackedSum;
        for (uint256 a = 0; a < 2; a++) {
            ERC20Mock t = ERC20Mock(assets[a]);
            trackedSum = 0;
            for (uint256 i = 0; i < 6; i++) {
                s.actor[i][a] = t.balanceOf(actors[i]) + t.balanceOf(vaults[i]);
                trackedSum += s.actor[i][a];
            }
            s.diamond[a] = t.balanceOf(diamond);
            s.caller[a] = t.balanceOf(address(inner));
            s.market[a] = t.balanceOf(market);
            trackedSum += s.diamond[a] + s.caller[a] + s.market[a];
            s.outside[a] = t.totalSupply() - trackedSum;
        }
    }

    function _delta(uint256 afterV, uint256 beforeV) internal pure returns (int256) {
        return int256(afterV) - int256(beforeV);
    }

    function _flag(string memory reason) internal {
        if (bytes(firstViolation).length == 0) firstViolation = reason;
    }

    /// @dev For an action that touches no loan, or one that turned out to do nothing: every
    ///      tracked balance must be where it was.
    function _requireNoMovement(Snap memory before, string memory action) internal {
        Snap memory s = _snap();
        for (uint256 a = 0; a < 2; a++) {
            for (uint256 i = 0; i < 6; i++) {
                if (s.actor[i][a] != before.actor[i][a]) {
                    isolationViolations++;
                    _flag(string.concat(action, ": an actor's holdings moved with no loan booked"));
                }
            }
            if (
                s.diamond[a] != before.diamond[a] || s.caller[a] != before.caller[a]
                    || s.market[a] != before.market[a]
            ) {
                isolationViolations++;
                _flag(string.concat(action, ": the Diamond, caller or market balance moved with no loan booked"));
            }
            if (s.outside[a] != before.outside[a]) {
                perimeterViolations++;
                _flag(string.concat(action, ": tokens crossed the tracked perimeter"));
            }
        }
    }

    /// @dev `[floor, ceil]` of `amount x bps / 10_000`: the fee may round either way, never further.
    function _bpsRange(uint256 amount, uint256 bps) internal pure returns (int256 lo, int256 hi) {
        uint256 f = (amount * bps) / BPS;
        lo = int256(f);
        hi = int256(f + ((amount * bps) % BPS == 0 ? 0 : 1));
    }

    function _afterAccept(uint256 lenBefore, Snap memory before, bool borrowerAccepted) internal {
        if (inner.loanIdsLength() == lenBefore) {
            _requireNoMovement(before, "accept (no loan)");
            return;
        }
        uint256 loanId = inner.loanIdAt(lenBefore);
        _register(loanId);
        int256[2] memory dB = _book(loanId, before, "accept");
        _checkAccept(loanId, dB, borrowerAccepted);
    }

    /// @dev Opens the book of a newly originated loan.
    function _register(uint256 loanId) internal {
        LibVaipakam.Loan memory L = _loan(loanId);
        LoanBook storage b = books[loanId];
        b.known = true;
        b.lender = L.lender;
        b.borrower = L.borrower;
        b.principal0 = L.principal;
        b.rateBps = L.interestRateBps;
        b.startTime = L.startTime;
        b.dueTime = uint256(L.startTime) + L.durationDays * 1 days;
        b.collateralIn = L.collateralAmount;
        if (L.assetType != LibVaipakam.AssetType.ERC20) {
            b.isRental = true;
            b.tokenId = L.tokenId;
            b.termDays = L.durationDays;
            b.prepay = L.prepayAmount + L.bufferAmount;
        }
        bookedLoanIds.push(loanId);
    }

    /// @dev The origination checks on a loan's accept booking; `dB` is the borrower's delta.
    function _checkAccept(uint256 loanId, int256[2] memory dB, bool borrowerAccepted) internal {
        LibVaipakam.Loan memory L = _loan(loanId);
        LoanBook storage b = books[loanId];
        // Origination (spec "Treasury Fees" and the matcher kickback): the borrower is charged
        // a Loan Initiation Fee F of 0.2% of the principal, 1% of F (S) goes to whoever
        // completed the match -- on a direct accept, the acceptor -- and the Diamond keeps F - S.
        // The counterparty who did not accept moves exactly P (lender) or P - F (borrower).
        acceptChecks++;
        int256 p = int256(L.principal);
        (int256 fLo, int256 fHi) = _bpsRange(L.principal, LIF_BPS);
        if (borrowerAccepted) {
            // dL = -P, dB = P - F + S, dD = F - S: only F - S is observable.
            if (b.dLender[USDC] != -p) {
                acceptViolations++;
                _flag(string.concat("accept: lender delta ", vm.toString(b.dLender[USDC]), " != -principal ", vm.toString(p)));
            }
            (int256 sLoAtHi,) = _bpsRange(uint256(fHi), MATCHER_SHARE_BPS);
            (, int256 sHiAtLo) = _bpsRange(uint256(fLo), MATCHER_SHARE_BPS);
            int256 kept = b.dDiamond[USDC];
            if (kept < fLo - sHiAtLo || kept > fHi - sLoAtHi) {
                acceptViolations++;
                _flag(string.concat("accept: Diamond kept ", vm.toString(kept), ", expected 99% of the 0.2% LIF"));
            }
        } else {
            // dL = -P + S, dB = P - F, dD = F - S: F and S are both observable.
            int256 f = p - dB[USDC];
            int256 sh = b.dLender[USDC] + p;
            if (f < fLo || f > fHi) {
                acceptViolations++;
                _flag(string.concat("accept: borrower was charged ", vm.toString(f), ", 0.2% LIF is ", vm.toString(fLo)));
            }
            (int256 sLo, int256 sHi) = _bpsRange(f > 0 ? uint256(f) : 0, MATCHER_SHARE_BPS);
            if (sh < sLo || sh > sHi) {
                acceptViolations++;
                _flag(string.concat("accept: lender acceptor's share ", vm.toString(sh), ", 1% of the LIF is ", vm.toString(sLo)));
            }
        }
        if (b.dLender[WETH] != 0 || dB[WETH] != 0 || b.dDiamond[WETH] != 0 || b.dCaller[WETH] != 0) {
            acceptViolations++;
            _flag("accept: collateral crossed between parties at origination");
        }
    }

    /// @dev The original loan an offset offer was posted to close, replaying the inner handler's
    ///      pick over the open lender offers; 0 when the picked offer is an ordinary one.
    function _pickedOffsetLoan(uint256 offerIdx) internal view returns (uint256 loanId) {
        uint256 len = inner.lenderOfferIdsLength();
        if (len == 0) return 0;
        loanId = inner.ghostOffsetOf(inner.lenderOfferIds(_boundView(offerIdx, 0, len - 1)));
        if (!books[loanId].known) return 0;
    }

    /// @dev #3241: accepting an offset offer is ONE action over TWO loans. It opens the new loan
    ///      (the offsetting borrower A lends to the acceptor C) and closes the original one (A
    ///      pays its lender side L the payoff, and the Diamond the treasury cut). A is a party
    ///      to both, so its delta is split. The new loan takes the origination A's offer defines:
    ///      the lender side moves exactly the principal, C's delta is C's own, and the Diamond
    ///      keeps the rest of C's charge (so its LIF is checked as on any accept). Everything
    ///      else A moved, and the rest of the Diamond's delta, belongs to the original loan.
    function _afterOffsetAccept(uint256 lenBefore, uint256 oldLoanId, Snap memory before) internal {
        uint256 newLoanId = inner.loanIdAt(lenBefore);
        _register(newLoanId);
        LoanBook storage b1 = books[oldLoanId];
        LoanBook storage b2 = books[newLoanId];
        bookedActions++;
        b1.lastActionTs = block.timestamp;
        b2.lastActionTs = block.timestamp;
        if (b2.lender != b1.borrower) {
            offsetViolations++;
            _flag("offset: the new loan's lender is not the original loan's borrower");
        }
        Snap memory s = _snap();
        int256[2] memory dC;
        for (uint256 a = 0; a < 2; a++) {
            int256 dA;
            for (uint256 i = 0; i < 6; i++) {
                int256 d = _delta(s.actor[i][a], before.actor[i][a]);
                if (actors[i] == b2.borrower) {
                    dC[a] = d;
                } else if (actors[i] == b2.lender) {
                    dA = d;
                } else if (actors[i] == b1.lender || b1.lenderSide[actors[i]]) {
                    b1.dLender[a] += d;
                } else if (d != 0) {
                    isolationViolations++;
                    _flag("offset accept: a non-party's holdings moved");
                }
            }
            int256 aNew = a == USDC ? -int256(b2.principal0) : int256(0);
            int256 diamondNew = -(aNew + dC[a]);
            b2.dLender[a] += aNew;
            b2.dBorrower[a] += dC[a];
            b2.dDiamond[a] += diamondNew;
            b1.dBorrower[a] += dA - aNew;
            b1.dDiamond[a] += _delta(s.diamond[a], before.diamond[a]) - diamondNew;
            b1.dCaller[a] += _delta(s.caller[a], before.caller[a]);
            if (s.market[a] != before.market[a]) {
                isolationViolations++;
                _flag("offset accept: the market traded outside a periodic sale");
            }
            if (s.outside[a] != before.outside[a]) {
                perimeterViolations++;
                _flag("offset accept: tokens crossed the tracked perimeter");
            }
        }
        _checkAccept(newLoanId, dC, true);

        if (_loan(oldLoanId).status != LibVaipakam.LoanStatus.Repaid) {
            offsetViolations++;
            _flag("offset accept: the offset offer was taken but the original loan did not close");
            return;
        }
        b1.offsetClosed = true;
        b1.hadPartial = true; // closed by the offset, not by an on-time repayment
        offsetLanded++;
    }

    /// @dev The loan a refinance request was posted to replace, replaying the inner handler's
    ///      pick over the open borrower offers; 0 when the picked offer is an ordinary one.
    function _pickedRefinanceLoan(uint256 offerIdx) internal view returns (uint256 loanId) {
        uint256 len = inner.borrowerOfferIdsLength();
        if (len == 0) return 0;
        loanId = inner.ghostRefinanceOf(inner.borrowerOfferIds(_boundView(offerIdx, 0, len - 1)));
        if (!books[loanId].known) return 0;
    }

    /// @dev #3241: accepting a refinance request is ONE action over TWO loans. It opens the
    ///      replacement loan (the acceptor C lends to the borrower B) and closes the original
    ///      (its lender side L is paid off). B is a party to both, so its delta is split. C's
    ///      net principal never reaches B: it pays L, vault to vault, and B's wallet pays the
    ///      rest of L's payoff and the treasury cut. The contract's `RefinancePayoffSettled`
    ///      states that net principal, and it is used for one thing only, to apportion B's
    ///      single delta: the replacement loan's borrower is credited the net principal (so its
    ///      Loan Initiation Fee and C's matcher share are checked as on any lender accept), and
    ///      everything else B moved is the original loan's payoff, which must then be exactly
    ///      principal plus interest to the second when it closes on time with no partial. The
    ///      totals across the two books stay exactly what was observed.
    function _afterRefinanceAccept(
        uint256 lenBefore,
        uint256 oldLoanId,
        LibVaipakam.Loan memory pre,
        Snap memory before,
        Vm.Log[] memory logs
    ) internal {
        uint256 newLoanId = inner.loanIdAt(lenBefore);
        _register(newLoanId);
        LoanBook storage b1 = books[oldLoanId];
        LoanBook storage b2 = books[newLoanId];
        bookedActions++;
        b1.lastActionTs = block.timestamp;
        b2.lastActionTs = block.timestamp;
        if (b2.borrower != b1.borrower) {
            refinanceViolations++;
            _flag("refinance: the replacement loan's borrower is not the original loan's borrower");
        }
        (bool found, uint256 net) = _refinanceNet(logs, oldLoanId, newLoanId);
        if (!found) {
            refinanceViolations++;
            _flag("refinance: the accept opened a loan but stated no payoff for the original");
        }
        Snap memory s = _snap();
        int256[2] memory dB2;
        dB2[USDC] = int256(net);
        for (uint256 a = 0; a < 2; a++) {
            int256 dCNew;
            for (uint256 i = 0; i < 6; i++) {
                int256 d = _delta(s.actor[i][a], before.actor[i][a]);
                if (actors[i] == b2.lender) {
                    dCNew = d;
                } else if (actors[i] == b1.borrower) {
                    b1.dBorrower[a] += d - dB2[a];
                } else if (actors[i] == b1.lender || b1.lenderSide[actors[i]]) {
                    b1.dLender[a] += d;
                } else if (d != 0) {
                    isolationViolations++;
                    _flag("refinance accept: a non-party's holdings moved");
                }
            }
            int256 diamondNew = -(dCNew + dB2[a]);
            b2.dLender[a] += dCNew;
            b2.dBorrower[a] += dB2[a];
            b2.dDiamond[a] += diamondNew;
            b1.dDiamond[a] += _delta(s.diamond[a], before.diamond[a]) - diamondNew;
            b1.dCaller[a] += _delta(s.caller[a], before.caller[a]);
            if (s.market[a] != before.market[a]) {
                isolationViolations++;
                _flag("refinance accept: the market traded outside a periodic sale");
            }
            if (s.outside[a] != before.outside[a]) {
                perimeterViolations++;
                _flag("refinance accept: tokens crossed the tracked perimeter");
            }
        }
        _checkAccept(newLoanId, dB2, false);

        if (_loan(oldLoanId).status != LibVaipakam.LoanStatus.Repaid) {
            refinanceViolations++;
            _flag("refinance accept: the request was taken but the original loan did not close");
            return;
        }
        // The original loan's own share of this action, for the exact on-time interest check.
        int256[2] memory dBOld;
        for (uint256 i = 0; i < 6; i++) {
            if (actors[i] != b1.borrower) continue;
            for (uint256 a = 0; a < 2; a++) {
                dBOld[a] = _delta(s.actor[i][a], before.actor[i][a]) - dB2[a];
            }
        }
        _checkExactInterest(oldLoanId, pre, dBOld, false);
        refinanceLanded++;
    }

    /// @dev The net principal `RefinancePayoffSettled` states moved from the new lender to the
    ///      original loan's lender, for this pair of loans.
    function _refinanceNet(Vm.Log[] memory logs, uint256 oldLoanId, uint256 newLoanId)
        internal
        view
        returns (bool found, uint256 net)
    {
        bytes32 topic = RefinanceFacet.RefinancePayoffSettled.selector;
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != diamond || l.topics.length != 4 || l.topics[0] != topic) continue;
            if (uint256(l.topics[1]) != oldLoanId || uint256(l.topics[2]) != newLoanId) continue;
            (net,,) = abi.decode(l.data, (uint256, uint256, uint256));
            return (true, net);
        }
    }

    /// @dev Books the change since `before` against `loanId`, flags isolation and perimeter
    ///      breaches, and returns this action's borrower delta per asset.
    function _book(uint256 loanId, Snap memory before, string memory action)
        internal
        returns (int256[2] memory dBorrowerAction)
    {
        LoanBook storage b = books[loanId];
        Snap memory s = _snap();
        bookedActions++;
        b.lastActionTs = block.timestamp;
        for (uint256 a = 0; a < 2; a++) {
            for (uint256 i = 0; i < 6; i++) {
                int256 d = _delta(s.actor[i][a], before.actor[i][a]);
                if (actors[i] == b.lender || b.lenderSide[actors[i]]) {
                    b.dLender[a] += d;
                } else if (actors[i] == b.borrower) {
                    b.dBorrower[a] += d;
                    dBorrowerAction[a] = d;
                } else if (d != 0) {
                    isolationViolations++;
                    _flag(string.concat(action, ": a non-party's holdings moved"));
                }
            }
            b.dDiamond[a] += _delta(s.diamond[a], before.diamond[a]);
            b.dCaller[a] += _delta(s.caller[a], before.caller[a]);
            int256 dM = _delta(s.market[a], before.market[a]);
            b.dMarket[a] += dM;
            if (dM != 0 && !marketOpen) {
                isolationViolations++;
                _flag(string.concat(action, ": the market traded outside a periodic sale"));
            }
            if (s.outside[a] != before.outside[a]) {
                perimeterViolations++;
                _flag(string.concat(action, ": tokens crossed the tracked perimeter"));
            }
        }
    }

    /// @dev Spec "Interest Formula": a loan closed by one on-time full repayment with no earlier
    ///      partial pays `floor(P x rate x elapsed / (365 days x 10_000))`, to the second.
    ///      `directClose` marks a direct preclose, which a rental settles on its own rule.
    function _checkExactInterest(uint256 loanId, LibVaipakam.Loan memory pre, int256[2] memory dB, bool directClose)
        internal
    {
        LoanBook storage b = books[loanId];
        if (b.isRental) {
            _recordRentOwed(loanId, pre, directClose);
            return;
        }
        if (b.hadPartial) return;
        if (pre.status != LibVaipakam.LoanStatus.Active) return;
        if (_loan(loanId).status != LibVaipakam.LoanStatus.Repaid) return;
        if (block.timestamp > b.dueTime) return; // a late fee may apply; bounded elsewhere
        // A full-term-interest loan pays the whole term on an early preclose, not the accrual
        // to the second. The shared handler never posts one; skip rather than misprice it.
        if (pre.useFullTermInterest) return;
        interestChecks++;
        int256 paid = -dB[USDC];
        uint256 elapsed = block.timestamp - b.startTime;
        uint256 expected = (b.principal0 * b.rateBps * elapsed) / (YEAR * BPS);
        if (paid != int256(b.principal0 + expected)) {
            interestViolations++;
            _flag(
                string.concat(
                    "repay: interest paid ",
                    vm.toString(paid - int256(b.principal0)),
                    " != floor(P*r*t/yr) ",
                    vm.toString(expected)
                )
            );
        }
    }

    /// @dev Spec "NFT Rental Outcome": a rental returned on time owes the fee for every day used,
    ///      any part of a day counting as a whole day (at least one), never past the term. A
    ///      direct preclose is the spec's Option 1, "the full interest that would have been due
    ///      for the original agreed loan term": it owes the fee for every day of the term.
    function _recordRentOwed(uint256 loanId, LibVaipakam.Loan memory pre, bool directClose) internal {
        LoanBook storage b = books[loanId];
        if (pre.status != LibVaipakam.LoanStatus.Active) return;
        if (_loan(loanId).status != LibVaipakam.LoanStatus.Repaid) return;
        if (block.timestamp > b.dueTime) return; // a late fee may apply; bounded elsewhere
        if (pre.useFullTermInterest) return;
        uint256 elapsed = block.timestamp - b.startTime;
        uint256 daysUsed = (elapsed + 1 days - 1) / 1 days;
        if (daysUsed == 0) daysUsed = 1;
        if (daysUsed > b.termDays || directClose) daysUsed = b.termDays;
        _setRentOwed(loanId, daysUsed);
    }

    /// @dev Records the rent a closed rental owes (`days` of the daily fee) and checks any side
    ///      whose claim is already paid.
    function _setRentOwed(uint256 loanId, uint256 days_) internal {
        LoanBook storage b = books[loanId];
        b.rentOwed = b.principal0 * days_;
        b.rentOwedSet = true;
        _checkRentalSettled(loanId);
    }

    /// @dev Once a rental that closed on time has paid out a side's claim, that side's net is
    ///      exact: the renter has paid exactly the rent owed (the rest of its prepayment, the
    ///      buffer included, is back with it), and the lender side has received that rent less
    ///      the treasury's share (rounded once per deduction, so within one wei a day). Each side
    ///      is checked once, when its claim is first seen paid.
    function _checkRentalSettled(uint256 loanId) internal {
        LoanBook storage b = books[loanId];
        if (!b.rentOwedSet) return;
        (,, bool borrowerClaimed) = ClaimFacet(diamond).getClaimableAmount(loanId, false);
        (,, bool lenderClaimed) = ClaimFacet(diamond).getClaimableAmount(loanId, true);
        int256 owed = int256(b.rentOwed);
        if (borrowerClaimed && !b.renterSettledChecked) {
            b.renterSettledChecked = true;
            rentalChecks++;
            if (b.dBorrower[USDC] != -owed) {
                rentalViolations++;
                _flag(string.concat("rental: renter paid ", vm.toString(-b.dBorrower[USDC]), ", rent owed ", vm.toString(owed)));
            }
        }
        if (lenderClaimed && !b.lenderSettledChecked) {
            b.lenderSettledChecked = true;
            rentalChecks++;
            uint256 bps = _loan(loanId).treasuryFeeBpsAtInit;
            int256 hi = owed - int256((b.rentOwed * bps) / BPS);
            int256 lo = owed - int256((b.rentOwed * bps + BPS - 1) / BPS) - int256(b.termDays);
            if (b.dLender[USDC] > hi || b.dLender[USDC] < lo) {
                rentalViolations++;
                _flag(string.concat("rental: lender received ", vm.toString(b.dLender[USDC]), ", rent less the treasury share is ", vm.toString(hi)));
            }
        }
    }

    /// @notice A booked loan's rental terms: whether it is a rental, the rented token, the
    ///         prepayment (whole-term rent plus buffer), and its two parties.
    function loanRental(uint256 loanId)
        external
        view
        returns (bool isRental, uint256 tokenId, uint256 prepay, address lender, address borrower)
    {
        LoanBook storage b = books[loanId];
        return (b.isRental, b.tokenId, b.prepay, b.lender, b.borrower);
    }
}
