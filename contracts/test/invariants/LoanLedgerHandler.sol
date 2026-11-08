// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {Handler} from "./Handler.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";

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
 *           Diamond, the caller). The rig has no working swap venue, so nothing may go anywhere
 *           else.
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
        int256[2] dLender;
        int256[2] dBorrower;
        int256[2] dDiamond;
        int256[2] dCaller;
    }

    mapping(uint256 => LoanBook) internal books;
    uint256[] public bookedLoanIds;

    // ── Violation counters (must stay zero) and the first failure's reason ──
    uint256 public isolationViolations;
    uint256 public perimeterViolations;
    uint256 public acceptViolations;
    uint256 public interestViolations;
    string public firstViolation;

    // ── Coverage counters: how often each per-action check actually ran ──
    uint256 public acceptChecks;
    uint256 public interestChecks;
    uint256 public bookedActions;
    uint256 public precloseLanded;
    uint256 public liquidationLanded;
    uint256 public saleLanded;

    constructor(InvariantBase _base) {
        base = _base;
        inner = new Handler(_base);
        diamond = address(_base.diamond());
        assets[USDC] = _base.mockUsdc();
        assets[WETH] = _base.mockWeth();
        for (uint256 i = 0; i < 3; i++) {
            actors[i] = _base.lenderAt(i);
            actors[i + 3] = _base.borrowerAt(i);
        }
        for (uint256 i = 0; i < 6; i++) {
            vaults[i] = VaultFactoryFacet(diamond).getUserVaultAddress(actors[i]);
        }
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
        Snap memory before = _snap();
        inner.acceptLenderOffer(borrowerSeed, offerIdx);
        _afterAccept(n, before, true);
    }

    function acceptBorrowerOffer(uint256 lenderSeed, uint256 offerIdx) external {
        uint256 n = inner.loanIdsLength();
        Snap memory before = _snap();
        inner.acceptBorrowerOffer(lenderSeed, offerIdx);
        _afterAccept(n, before, false);
    }

    function repay(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        LibVaipakam.Loan memory pre = _loan(loanId);
        Snap memory before = _snap();
        inner.repay(loanIdx);
        int256[2] memory dB = _book(loanId, before, "repay");
        _checkExactInterest(loanId, pre, dB);
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
        _checkExactInterest(loanId, pre, dB);
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

    function claimAsLender(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        Snap memory before = _snap();
        inner.claimAsLender(loanIdx);
        _book(loanId, before, "claimAsLender");
    }

    function claimAsBorrower(uint256 loanIdx) external {
        (bool ok, uint256 loanId) = _pickLoan(loanIdx);
        if (!ok) return;
        Snap memory before = _snap();
        inner.claimAsBorrower(loanIdx);
        _book(loanId, before, "claimAsBorrower");
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
            trackedSum += s.diamond[a] + s.caller[a];
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
            if (s.diamond[a] != before.diamond[a] || s.caller[a] != before.caller[a]) {
                isolationViolations++;
                _flag(string.concat(action, ": the Diamond or caller balance moved with no loan booked"));
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
        bookedLoanIds.push(loanId);

        int256[2] memory dB = _book(loanId, before, "accept");

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
            if (s.outside[a] != before.outside[a]) {
                perimeterViolations++;
                _flag(string.concat(action, ": tokens crossed the tracked perimeter"));
            }
        }
    }

    /// @dev Spec "Interest Formula": a loan closed by one on-time full repayment with no earlier
    ///      partial pays `floor(P x rate x elapsed / (365 days x 10_000))`, to the second.
    function _checkExactInterest(uint256 loanId, LibVaipakam.Loan memory pre, int256[2] memory dB) internal {
        LoanBook storage b = books[loanId];
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
}
