// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {MakerTraits} from "@1inch/limit-order-protocol/contracts/libraries/MakerTraitsLib.sol";
import {Address as LopAddress} from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {RiskMatchLiquidationFacet} from "../../src/facets/RiskMatchLiquidationFacet.sol";
import {SwapToRepayIntentFacet} from "../../src/facets/SwapToRepayIntentFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {LibAcceptTestSigner} from "../helpers/LibAcceptTestSigner.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockLopFill} from "../mocks/MockLopFill.sol";
import {MockSanctionsList} from "../mocks/MockSanctionsList.sol";
import {LibFallbackCustody} from "../../src/libraries/LibFallbackCustody.sol";
import {defaultQuote, liquidationQuote} from "../helpers/ForcedSaleQuote.sol";

/// @dev The intent cancel grace the harness configures and the handler waits out on the
///      permissionless expired-cancel path. One constant, read by both, so they cannot disagree.
uint32 constant CUSTODY_INTENT_CANCEL_GRACE = 86_400;

/// @notice Everything the handler needs from the harness that built the Diamond, in one value: the
///         base builds it once, so the actor set, the token roles and the venue indices cannot drift
///         between the two.
struct CustodyWiring {
    address diamond;
    address usdc;
    address weth;
    address vpfi;
    address lop;
    address sanctions;
    uint256 failingAdapterIdx;
    uint256 workingAdapterIdx;
    address[2] lenders;
    uint256[2] lenderPks;
    address[3] borrowers;
    uint256[3] borrowerPks;
}

/**
 * @title  CustodyHandler
 * @notice The CLOSED action set of the #2141 `DiamondCustodyAttribution` suite: every way a user
 *         asset can enter, rest in, or leave Diamond custody through the liquidation-fallback and
 *         swap-to-repay-intent classes -- and nothing that funds a protocol-owned balance
 *         (no buyback funding, payroll or reward funding; V0b pins those at zero, so a handler that
 *         starts exercising one must add it to V1's ledger first).
 *
 * @dev    Every action drives the REAL entry point through the full Diamond (`SetupTest`); nothing
 *         here writes protocol storage or mocks `vaultWithdrawERC20`. The only mocked inputs are the
 *         ones a price feed would move: the per-loan health factor and LTV (SetupTest mocks both
 *         globally, so a per-loan mock is how a loan becomes liquidatable) and the WETH price.
 *
 *         Each FAMILY action is self-sufficient: when the state it needs does not exist (a
 *         FallbackPending loan, a live commit) it builds it through the real producers first. That is
 *         what lets `afterInvariant` require every family to have run in EVERY run (V0) instead of
 *         hoping the fuzzer stumbles into a long precondition chain. Outcomes are counted only when
 *         observed on-chain afterwards (a status, an emitted retry result), never on a call merely
 *         returning.
 *
 *         Swap outcomes are chosen per call by venue: a permanently reverting adapter and a working
 *         one. Two fixed venues rather than one toggled adapter, because the handler is not the
 *         adapter's owner and a stateful toggle would leak from one action into the next.
 *
 *         Reverse-pair loans (WETH principal, USDC collateral) exist only as internal-match
 *         counterparties. Their LTV mock is lifted to the liquidation floor for the one explicit
 *         match call and restored straight after, so they are never an auto-dispatch candidate and a
 *         forward loan's liquidation always reaches its own swap (and, failing it, the fallback).
 */
contract CustodyHandler is Test {
    /// @notice Which leg of the internal-match pair a loan sits on, and which collateral it posts.
    enum Kind {
        ForwardWeth,
        ForwardVpfi,
        Reverse
    }

    /// @dev The loans a by-seed pick may land on.
    enum Want {
        ActiveAny,
        ActiveForward,
        ActiveOrFallback,
        LenderClaimable,
        BorrowerClaimable
    }

    error VpfiStashExhausted(uint256 wanted, uint256 held);
    /// @dev The floor restatement covers the non-tiered admission regime only; the harness never
    ///      enables depth-tiered LTV, so meeting it means the fixture moved under the handler.
    error DepthTieredFloorNotModelled();
    error FloorUnpriced(address lending, address collateral);

    uint256 internal constant HF_HEALTHY = 2e18;
    uint256 internal constant HF_LIQUIDATABLE = 0.9e18;
    /// @dev Inside every admission cap the suite's loans are born under (accept passed at 6666).
    uint256 internal constant LTV_HEALTHY = 5_000;
    /// @dev Above the 8500 tier floor plus the largest external-liquidation priority window (500),
    ///      and below the 11000 value-collapse threshold, so a time default still attempts its swap.
    uint256 internal constant LTV_LIQUIDATABLE = 9_600;
    uint256 internal constant LOAN_DAYS = 30;
    uint256 internal constant SHORT_LOAN_DAYS = 7;
    /// @dev Past every default-schedule grace bucket for the sub-90-day terms this handler opens.
    uint256 internal constant PAST_EVERY_GRACE = 8 days;
    uint256 internal constant RATE_BPS = 1_000;
    uint256 internal constant SCAN = 6;
    uint256 internal constant INTENT_AUCTION_SECONDS = 300;
    /// @dev NO_PARTIAL_FILLS | PRE_INTERACTION_CALL | POST_INTERACTION_CALL | HAS_EXTENSION -- the
    ///      bits the commit gate requires; the expiry and nonce sub-fields are added per commit.
    uint256 internal constant INTENT_TRAIT_FLAGS = (1 << 255) | (1 << 252) | (1 << 251) | (1 << 249);
    uint256 public constant ACTION_COUNT = 18;
    /// @dev Every open posts collateral at the protocol's create-time floor times a seed-driven
    ///      margin in [FLOOR_MARGIN_MIN_BPS, FLOOR_MARGIN_MIN_BPS + FLOOR_MARGIN_SPREAD_BPS]: the 5%
    ///      minimum absorbs the floor's own whole-unit truncation and any rounding, the spread keeps
    ///      the over-collateralisation fuzzed.
    uint256 internal constant FLOOR_MARGIN_MIN_BPS = 10_500;
    uint256 internal constant FLOOR_MARGIN_SPREAD_BPS = 5_000;
    /// @dev The reference principal {_maxPrincipalFor} prices the floor at: large enough that the
    ///      floor's whole-USD truncation is a sub-ppm error.
    uint256 internal constant FLOOR_REFERENCE_PRINCIPAL = 1e24;

    address public immutable diamond;
    address public immutable usdc;
    address public immutable weth;
    address public immutable vpfi;
    MockLopFill public immutable lop;
    MockSanctionsList public immutable sanctions;
    uint256 public immutable failingAdapterIdx;
    uint256 public immutable workingAdapterIdx;

    address[2] internal _lenders;
    uint256[2] internal _lenderPks;
    address[3] internal _borrowers;
    uint256[3] internal _borrowerPks;

    // --- the loan book the invariant enumerates --------------------------------------------------
    uint256[] internal _loanIds;
    mapping(uint256 => Kind) public kindOf;
    mapping(uint256 => address) public collateralOf;
    /// @dev Every loan observed entering FallbackPending (never pruned): the legacy-fallback term
    ///      sums over it. A loan that reached FallbackPending unobserved is MISSING here, which can
    ///      only make V1 stricter, never hide custody.
    uint256[] internal _fallbackLoanIds;
    mapping(uint256 => bool) internal _fallbackTracked;
    /// @dev Every loan that ever committed an intent (never pruned); same argument as above.
    uint256[] internal _intentLoanIds;
    mapping(uint256 => bool) internal _intentTracked;
    uint40 internal _nextIntentNonce = 1;

    // --- V0 coverage ----------------------------------------------------------------------------
    mapping(bytes32 => uint256) public calls;
    uint256 public loansOpened;
    uint256 public repaid;
    uint256 public partialRepaid;
    uint256 public toppedUp;
    uint256 public swapLiquidations;
    uint256 public fallbackViaLiquidation;
    uint256 public fallbackViaDefault;
    uint256 public retryFailed;
    /// @notice Failed claim-time retries observed to RESTORE the custody row they pulled (S2b):
    ///         a `RetryRestored` row move for the claimed loan in the same call.
    uint256 public retryRestored;
    uint256 public retrySucceeded;
    /// @dev Lender claims that RAN a claim-time retry on a FallbackPending loan, by venue: the V0
    ///      coverage check asserts each retry family's OUTCOME given an attempt (see the suite's
    ///      `_assertV0`), because a 500-call run has only a handful of retry-eligible claims.
    uint256 public retryAttemptsWorkingVenue;
    uint256 public retryAttemptsFailingVenue;
    uint256 public disposed;
    uint256 public absorbed;
    uint256 public cured;
    uint256 public repayCured;
    uint256 public fallbackPartialLegs;
    uint256 public fullRescues;
    uint256 public intentCommits;
    uint256 public intentFills;
    uint256 public intentCancels;
    uint256 public lenderClaims;
    uint256 public borrowerClaims;
    uint256 public sanctionToggles;
    /// @notice Partial internal-match legs that left a FallbackPending loan's snapshot scaled, per
    ///         collateral asset -- the input to V1's K5 rounding allowance.
    mapping(address => uint256) public partialLegsByAsset;
    uint256 public wethPrice8 = 1e8;

    // --- diagnosis: every swallowed revert, by site ---------------------------------------------
    mapping(bytes32 => bytes) public lastRevert;
    mapping(bytes32 => uint256) public reverts;
    bytes32 public lastRevertKey;
    bytes public lastRevertData;

    constructor(CustodyWiring memory w) {
        diamond = w.diamond;
        usdc = w.usdc;
        weth = w.weth;
        vpfi = w.vpfi;
        lop = MockLopFill(payable(w.lop));
        sanctions = MockSanctionsList(w.sanctions);
        failingAdapterIdx = w.failingAdapterIdx;
        workingAdapterIdx = w.workingAdapterIdx;
        _lenders = w.lenders;
        _lenderPks = w.lenderPks;
        _borrowers = w.borrowers;
        _borrowerPks = w.borrowerPks;
        // The handler is the resolver of every intent fill: the LOP pulls the taker amount from it.
        IERC20(w.usdc).approve(w.lop, type(uint256).max);
        IERC20(w.weth).approve(w.lop, type(uint256).max);
    }

    // ============================================================================================
    //  Actions (the fuzz targets)
    // ============================================================================================

    /// @notice Open a loan through the real lender offer and the borrower's signed accept.
    function openLoan(uint256 seed, uint256 principal, uint8 kindSeed) external {
        ++calls["openLoan"];
        _openLoanOf(Kind(kindSeed % 3), seed, bound(principal, 100e18, 10_000e18), LOAN_DAYS);
    }

    /// @notice Full repayment of an Active loan by its (clean) borrower.
    function repay(uint256 seed) external {
        ++calls["repay"];
        uint256 loanId = _pick(seed, Want.ActiveAny);
        if (loanId == 0) return;
        LibVaipakam.Loan memory l = _loan(loanId);
        if (_flagged(l.borrower)) return;
        _fund(l.borrower, l.principalAsset, l.principal * 4 + 1_000e18);
        vm.prank(l.borrower);
        try RepayFacet(diamond).repayLoan(loanId) {
            ++repaid;
        } catch (bytes memory err) {
            _noteRevert("repay", err);
        }
    }

    /// @notice A partial repayment of an Active loan.
    function repayPartial(uint256 seed, uint256 amount) external {
        ++calls["repayPartial"];
        uint256 loanId = _pick(seed, Want.ActiveAny);
        if (loanId == 0) return;
        LibVaipakam.Loan memory l = _loan(loanId);
        if (_flagged(l.borrower) || l.principal < 2e18) return;
        amount = bound(amount, 1e18, l.principal / 2);
        _fund(l.borrower, l.principalAsset, amount * 2 + 1_000e18);
        vm.prank(l.borrower);
        try RepayFacet(diamond).repayPartial(loanId, amount) {
            ++partialRepaid;
        } catch (bytes memory err) {
            _noteRevert("repayPartial", err);
        }
    }

    /// @notice A collateral top-up WITHOUT touching the loan's risk mocks: on an Active loan a plain
    ///         top-up, on a FallbackPending loan a non-curing top-up (the vault-held, liened top-up
    ///         that sits beside the loan's vault-held fallback custody row, S2b).
    function addCollateral(uint256 seed, uint256 amount) external {
        ++calls["addCollateral"];
        uint256 loanId = _pick(seed, Want.ActiveOrFallback);
        if (loanId == 0) return;
        LibVaipakam.Loan memory l = _loan(loanId);
        if (_flagged(l.borrower)) return;
        amount = bound(amount, 1e18, 500e18);
        _fund(l.borrower, l.collateralAsset, amount);
        vm.prank(l.borrower);
        try AddCollateralFacet(diamond).addCollateral(loanId, amount) {
            ++toppedUp;
        } catch (bytes memory err) {
            _noteRevert("addCollateral", err);
        }
    }

    /// @notice The oracle knob: move the WETH price inside [0.95, 1.00] USD. Never above the
    ///         principal's 1 USD, so a fresh fallback's lender slice always re-values to its due
    ///         within the backstop par guard's one-wei tolerance.
    function priceShock(uint256 bps) external {
        ++calls["priceShock"];
        bps = bound(bps, 9_500, 10_000);
        wethPrice8 = (uint256(1e8) * bps) / 10_000;
        vm.mockCall(
            diamond,
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, weth),
            abi.encode(wethPrice8, uint8(8))
        );
    }

    /// @notice HF liquidation of a forward loan; `swapFails` picks the reverting venue, which routes
    ///         the loan into FallbackPending (the RiskFacet producer).
    function liquidate(uint256 seed, bool swapFails) external {
        ++calls["liquidate"];
        uint256 loanId = _pick(seed, Want.ActiveForward);
        if (loanId == 0) loanId = _openLoanOf(_forwardKind(seed), seed, _principal(seed), LOAN_DAYS);
        if (loanId == 0) return;
        _liquidate(loanId, swapFails);
    }

    /// @notice Time default of a forward loan past its grace; `swapFails` routes it into
    ///         FallbackPending through the DefaultedFacet producer.
    function defaultLoan(uint256 seed, bool swapFails) external {
        ++calls["defaultLoan"];
        uint256 loanId = _pick(seed, Want.ActiveForward);
        if (loanId == 0) loanId = _openLoanOf(_forwardKind(seed), seed, _principal(seed), SHORT_LOAN_DAYS);
        if (loanId == 0) return;
        LibVaipakam.Loan memory l = _loan(loanId);
        uint256 pastGrace = uint256(l.startTime) + l.durationDays * 1 days + PAST_EVERY_GRACE;
        if (pastGrace > block.timestamp) vm.warp(pastGrace);
        LibSwap.AdapterCall[] memory route = _adapterCalls(swapFails);
        uint256 sellQuote = defaultQuote(diamond, loanId);
        try DefaultedFacet(diamond).triggerDefault(loanId, sellQuote, route) {
            if (_statusOf(loanId) == LibVaipakam.LoanStatus.FallbackPending) {
                _trackFallback(loanId);
                // Keep it uncurable by a plain top-up: only the `cure` action restores health.
                _setRisk(loanId, HF_LIQUIDATABLE, LTV_LIQUIDATABLE);
                ++fallbackViaDefault;
            }
        } catch (bytes memory err) {
            _noteRevert("defaultLoan", err);
        }
    }

    /// @notice The lender claim. Mode 0: `claimAsLender` on any claimable loan (a FallbackPending one
    ///         disposes in kind). Mode 1: `claimAsLenderWithRetry` on an unretried FallbackPending
    ///         loan through the reverting venue (retry fails, then dispose). Mode 2: the same through
    ///         the working venue (retry succeeds).
    function claimLender(uint256 seed, uint8 mode) external {
        ++calls["claimLender"];
        mode = mode % 3;
        uint256 loanId = mode == 0 ? _pick(seed, Want.LenderClaimable) : _fallbackSubject(seed, true, false, false);
        if (loanId == 0) return;
        _claimLender(loanId, mode);
    }

    /// @notice The borrower claim on a terminal loan.
    function claimBorrower(uint256 seed) external {
        ++calls["claimBorrower"];
        uint256 loanId = _pick(seed, Want.BorrowerClaimable);
        if (loanId == 0) return;
        LibVaipakam.Loan memory l = _loan(loanId);
        if (_flagged(l.borrower)) return;
        vm.prank(l.borrower);
        try ClaimFacet(diamond).claimAsBorrower(loanId) {
            ++borrowerClaims;
        } catch (bytes memory err) {
            _noteRevert("claimBorrower", err);
        }
    }

    /// @notice The backstop's Role-B buyout: a fresh FallbackPending loan (no top-up, priced now), the
    ///         lender's opt-in, then the keeper absorb with a failing retry.
    function absorb(uint256 seed) external {
        ++calls["absorb"];
        uint256 loanId = _freshFallback(seed, false);
        if (loanId == 0) return;
        address lender_ = _loan(loanId).lender;
        vm.prank(lender_);
        try ClaimFacet(diamond).setLenderBackstopOptIn(loanId, true) {}
        catch (bytes memory err) {
            _noteRevert("absorb.optIn", err);
            return;
        }
        LibSwap.AdapterCall[] memory retry = _adapterCalls(true);
        try ClaimFacet(diamond).claimAsLenderViaBackstop(loanId, retry) {
            LibVaipakam.LoanStatus st = _statusOf(loanId);
            if (st == LibVaipakam.LoanStatus.Defaulted || st == LibVaipakam.LoanStatus.Settled) ++absorbed;
        } catch (bytes memory err) {
            _noteRevert("absorb", err);
        }
    }

    /// @notice Cure by top-up: restore the loan's health, then `addCollateral` re-activates it.
    function cure(uint256 seed, uint256 amount) external {
        ++calls["cure"];
        uint256 loanId = _fallbackSubject(seed, false, true, false);
        if (loanId == 0) return;
        LibVaipakam.Loan memory l = _loan(loanId);
        amount = bound(amount, 1e18, 500e18);
        _fund(l.borrower, l.collateralAsset, amount);
        _setRisk(loanId, HF_HEALTHY, LTV_HEALTHY);
        vm.prank(l.borrower);
        try AddCollateralFacet(diamond).addCollateral(loanId, amount) {
            if (_statusOf(loanId) == LibVaipakam.LoanStatus.Active) {
                ++cured;
                return;
            }
        } catch (bytes memory err) {
            _noteRevert("cure", err);
        }
        _setRisk(loanId, HF_LIQUIDATABLE, LTV_LIQUIDATABLE);
    }

    /// @notice Cure by full repayment of a FallbackPending loan.
    function repayCure(uint256 seed) external {
        ++calls["repayCure"];
        uint256 loanId = _fallbackSubject(seed, false, true, false);
        if (loanId == 0) return;
        LibVaipakam.Loan memory l = _loan(loanId);
        _fund(l.borrower, l.principalAsset, l.principal * 4 + 1_000e18);
        vm.prank(l.borrower);
        try RepayFacet(diamond).repayLoan(loanId) {
            if (_statusOf(loanId) == LibVaipakam.LoanStatus.Repaid) ++repayCured;
        } catch (bytes memory err) {
            _noteRevert("repayCure", err);
        }
    }

    /// @notice The explicit two-way internal match of a FallbackPending forward-WETH loan A against a
    ///         fresh reverse loan B. Each leg moves `min(debt, opposing collateral)`, so B's USDC
    ///         collateral decides A's outcome: `rescueFully` sizes it past A's whole principal
    ///         (A -> InternalMatched, the full rescue); otherwise to 30-80% of it (A stays
    ///         FallbackPending with its snapshot scaled -- the partial leg). B's WETH principal is the
    ///         most the protocol's own create-time floor admits against that collateral, scaled down by
    ///         the open margin, and kept below A's custody row so A keeps a residual either way.
    /// @dev    Counted only on the observed effect: InternalMatched for the rescue; still
    ///         FallbackPending with an active snapshot strictly smaller than before for the partial leg.
    function internalMatch(uint256 seed, bool rescueFully) external {
        ++calls["internalMatch"];
        uint256 a = _fallbackSubject(seed, false, false, true);
        if (a == 0) return;
        uint256 aPrincipal = _loan(a).principal;
        uint256 aCustodyRow = _snapshotTotal(a);
        if (aCustodyRow < 4 || aPrincipal < 4) return;
        uint256 bCollateral = rescueFully
            ? aPrincipal + 1e18
            : (aPrincipal * (3_000 + (_mix(seed, "bCollateral") % 5_001))) / 10_000;
        uint256 bPrincipal = _maxPrincipalFor(bCollateral, weth, usdc, seed);
        if (bPrincipal >= aCustodyRow) bPrincipal = aCustodyRow / 2;
        if (bPrincipal == 0 || bCollateral == 0) return;
        uint256 b = _openLoanExplicit(Kind.Reverse, seed, bPrincipal, bCollateral, LOAN_DAYS);
        if (b == 0) return;
        _setRisk(b, HF_LIQUIDATABLE, LTV_LIQUIDATABLE);
        try RiskMatchLiquidationFacet(diamond).triggerInternalMatchLiquidation(a, b, 0) {
            LibVaipakam.LoanStatus st = _statusOf(a);
            if (st == LibVaipakam.LoanStatus.InternalMatched) {
                ++fullRescues;
            } else if (st == LibVaipakam.LoanStatus.FallbackPending) {
                (,,,,, bool activeAfter,) = ClaimFacet(diamond).getFallbackSnapshot(a);
                if (activeAfter && _snapshotTotal(a) < aCustodyRow) {
                    ++fallbackPartialLegs;
                    ++partialLegsByAsset[collateralOf[a]];
                }
            }
        } catch (bytes memory err) {
            _noteRevert("internalMatch", err);
        }
        _setRisk(b, HF_HEALTHY, LTV_HEALTHY);
    }

    /// @notice Commit a swap-to-repay intent on a fresh forward loan.
    function commitIntent(uint256 seed) external {
        ++calls["commitIntent"];
        _commitFresh(seed);
    }

    /// @notice Fill a live, unexpired commit through {MockLopFill} (committing one first if none).
    function fillIntent(uint256 seed) external {
        ++calls["fillIntent"];
        uint256 loanId = _pickLiveCommit(seed, true);
        if (loanId == 0) loanId = _commitFresh(seed);
        if (loanId == 0) return;
        _fillCommitted(loanId);
    }

    /// @notice Cancel a live commit: the borrower's cancel at the deadline, or the permissionless
    ///         expired cancel after the grace (committing one first if none).
    function cancelIntent(uint256 seed, bool expiredPath) external {
        ++calls["cancelIntent"];
        uint256 loanId = _pickLiveCommit(seed, false);
        if (loanId == 0) loanId = _commitFresh(seed);
        if (loanId == 0) return;
        (bool live, SwapToRepayIntentFacet.FusionOrderRead memory r) = _readCommit(loanId);
        if (!live) return;
        if (expiredPath) {
            uint256 at = uint256(r.deadline) + uint256(CUSTODY_INTENT_CANCEL_GRACE) + 1;
            if (at > block.timestamp) vm.warp(at);
            try SwapToRepayIntentFacet(diamond).cancelExpiredIntent(loanId) {
                (bool stillLive,) = _readCommit(loanId);
                if (!stillLive) ++intentCancels;
            } catch (bytes memory err) {
                _noteRevert("cancelIntent.expired", err);
            }
        } else {
            if (uint256(r.deadline) > block.timestamp) vm.warp(uint256(r.deadline));
            address holder = _loan(loanId).borrower;
            vm.prank(holder);
            try SwapToRepayIntentFacet(diamond).cancelSwapToRepayIntent(loanId) {
                (bool stillLive,) = _readCommit(loanId);
                if (!stillLive) ++intentCancels;
            } catch (bytes memory err) {
                _noteRevert("cancelIntent", err);
            }
        }
    }

    /// @notice Flag one borrower on the sanctions oracle, or clear the one that is flagged. At most
    ///         one borrower is ever flagged, so the families always have a clean borrower to use.
    function toggleSanction(uint256 seed) external {
        ++calls["toggleSanction"];
        ++sanctionToggles;
        for (uint256 i; i < 3; ++i) {
            if (_flagged(_borrowers[i])) {
                sanctions.setFlagged(_borrowers[i], false);
                return;
            }
        }
        sanctions.setFlagged(_borrowers[seed % 3], true);
    }

    /// @notice Time passes.
    function warp(uint256 delta) external {
        ++calls["warp"];
        vm.warp(block.timestamp + bound(delta, 1 hours, 10 days));
    }

    // ============================================================================================
    //  Read surface for the invariant suite
    // ============================================================================================

    function loanIds() external view returns (uint256[] memory) {
        return _loanIds;
    }

    function fallbackLoanIds() external view returns (uint256[] memory) {
        return _fallbackLoanIds;
    }

    function intentLoanIds() external view returns (uint256[] memory) {
        return _intentLoanIds;
    }

    function lenders() external view returns (address[2] memory) {
        return _lenders;
    }

    function borrowers() external view returns (address[3] memory) {
        return _borrowers;
    }

    /// @notice The `calls` key of every action -- the list V0 requires to have run.
    function actionNames() external pure returns (bytes32[18] memory names) {
        names[0] = "openLoan";
        names[1] = "repay";
        names[2] = "repayPartial";
        names[3] = "addCollateral";
        names[4] = "priceShock";
        names[5] = "liquidate";
        names[6] = "defaultLoan";
        names[7] = "claimLender";
        names[8] = "claimBorrower";
        names[9] = "absorb";
        names[10] = "cure";
        names[11] = "repayCure";
        names[12] = "internalMatch";
        names[13] = "commitIntent";
        names[14] = "fillIntent";
        names[15] = "cancelIntent";
        names[16] = "toggleSanction";
        names[17] = "warp";
    }

    /// @notice The fuzz target selectors, in {actionNames} order.
    function actionSelectors() external pure returns (bytes4[] memory sel) {
        sel = new bytes4[](18);
        sel[0] = this.openLoan.selector;
        sel[1] = this.repay.selector;
        sel[2] = this.repayPartial.selector;
        sel[3] = this.addCollateral.selector;
        sel[4] = this.priceShock.selector;
        sel[5] = this.liquidate.selector;
        sel[6] = this.defaultLoan.selector;
        sel[7] = this.claimLender.selector;
        sel[8] = this.claimBorrower.selector;
        sel[9] = this.absorb.selector;
        sel[10] = this.cure.selector;
        sel[11] = this.repayCure.selector;
        sel[12] = this.internalMatch.selector;
        sel[13] = this.commitIntent.selector;
        sel[14] = this.fillIntent.selector;
        sel[15] = this.cancelIntent.selector;
        sel[16] = this.toggleSanction.selector;
        sel[17] = this.warp.selector;
    }

    // ============================================================================================
    //  Producers and consumers, shared by the actions
    // ============================================================================================

    function _liquidate(uint256 loanId, bool swapFails) internal returns (bool enteredFallback) {
        _setRisk(loanId, HF_LIQUIDATABLE, LTV_LIQUIDATABLE);
        LibSwap.AdapterCall[] memory route = _adapterCalls(swapFails);
        uint256 sellQuote = liquidationQuote(diamond, loanId);
        try RiskFacet(diamond).triggerLiquidation(loanId, sellQuote, route) {
            LibVaipakam.LoanStatus st = _statusOf(loanId);
            if (st == LibVaipakam.LoanStatus.FallbackPending) {
                _trackFallback(loanId);
                ++fallbackViaLiquidation;
                return true;
            }
            if (st == LibVaipakam.LoanStatus.Defaulted) ++swapLiquidations;
        } catch (bytes memory err) {
            _noteRevert("liquidate", err);
            _setRisk(loanId, HF_HEALTHY, LTV_HEALTHY);
        }
    }

    function _claimLender(uint256 loanId, uint8 mode) internal {
        LibVaipakam.Loan memory l = _loan(loanId);
        (,,,,, bool activeBefore,) = ClaimFacet(diamond).getFallbackSnapshot(loanId);
        bool fallbackBefore = l.status == LibVaipakam.LoanStatus.FallbackPending && activeBefore;
        LibSwap.AdapterCall[] memory retry = _adapterCalls(mode == 1);
        bool ok;
        vm.recordLogs();
        if (mode == 0) {
            vm.prank(l.lender);
            try ClaimFacet(diamond).claimAsLender(loanId) {
                ok = true;
            } catch (bytes memory err) {
                _noteRevert("claimLender", err);
            }
        } else {
            vm.prank(l.lender);
            try ClaimFacet(diamond).claimAsLenderWithRetry(loanId, retry) {
                ok = true;
            } catch (bytes memory err) {
                _noteRevert("claimLender.retry", err);
            }
        }
        (bool retryRan, bool retryOk, bool restored) = _retryOutcome(loanId);
        if (!ok) return;
        ++lenderClaims;
        if (!fallbackBefore) return;
        // An ATTEMPT: a non-reverting retry claim on a FallbackPending subject, by venue.
        if (mode == 2) ++retryAttemptsWorkingVenue;
        else if (mode == 1) ++retryAttemptsFailingVenue;
        LibVaipakam.LoanStatus stAfter = _statusOf(loanId);
        if (stAfter == LibVaipakam.LoanStatus.InternalMatched) return;
        // Observed resolution only: the claim left FallbackPending and cleared the snapshot.
        (,,,,, bool activeAfter,) = ClaimFacet(diamond).getFallbackSnapshot(loanId);
        if (activeAfter || stAfter == LibVaipakam.LoanStatus.FallbackPending) return;
        if (retryRan && retryOk) {
            ++retrySucceeded;
            return;
        }
        if (retryRan) {
            ++retryFailed;
            if (restored) ++retryRestored;
        }
        ++disposed;
    }

    /// @dev Reads the claim's `ClaimRetryExecuted` from the recorded logs: whether the one-shot retry
    ///      ran in this call, and whether it succeeded; and whether a `RetryRestored` custody row move
    ///      for the loan was emitted (S2b: a failed retry puts the row it pulled back into the vault).
    function _retryOutcome(uint256 loanId) internal view returns (bool ran, bool ok, bool restored) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = ClaimFacet.ClaimRetryExecuted.selector;
        bytes32 moveSig = LibFallbackCustody.FallbackCustodyMoved.selector;
        bytes32 restoredTopic = bytes32(uint256(uint8(LibFallbackCustody.Move.RetryRestored)));
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != diamond || logs[i].topics.length < 2 || logs[i].topics[1] != bytes32(loanId)) {
                continue;
            }
            if (logs[i].topics[0] == sig) {
                ran = true;
                (ok,) = abi.decode(logs[i].data, (bool, uint256));
            } else if (logs[i].topics[0] == moveSig && logs[i].topics.length > 2 && logs[i].topics[2] == restoredTopic) {
                restored = true;
            }
        }
    }

    /// @dev A tracked loan still in FallbackPending with an active snapshot that meets the filters,
    ///      or a fresh one built through the RiskFacet producer when none of the scanned ones does.
    function _fallbackSubject(uint256 seed, bool unretried, bool cleanBorrower, bool wethOnly)
        internal
        returns (uint256)
    {
        uint256 n = _fallbackLoanIds.length;
        uint256 tries = n < SCAN ? n : SCAN;
        for (uint256 k; k < tries; ++k) {
            uint256 id = _fallbackLoanIds[(seed % n + k) % n];
            if (wethOnly && collateralOf[id] != weth) continue;
            if (_statusOf(id) != LibVaipakam.LoanStatus.FallbackPending) continue;
            (,,,,, bool active, bool retried) = ClaimFacet(diamond).getFallbackSnapshot(id);
            if (!active || (unretried && retried)) continue;
            if (cleanBorrower && _flagged(_loan(id).borrower)) continue;
            return id;
        }
        return _freshFallback(seed, wethOnly);
    }

    function _freshFallback(uint256 seed, bool wethOnly) internal returns (uint256 loanId) {
        Kind kind = wethOnly ? Kind.ForwardWeth : _forwardKind(seed);
        loanId = _openLoanOf(kind, seed, _principal(seed), LOAN_DAYS);
        if (loanId == 0) return 0;
        if (!_liquidate(loanId, true)) return 0;
    }

    function _commitFresh(uint256 seed) internal returns (uint256 loanId) {
        loanId = _openLoanOf(_forwardKind(seed), seed, _principal(seed), LOAN_DAYS);
        if (loanId == 0) return 0;
        if (!_commit(loanId, seed)) return 0;
    }

    /// @dev Commits at the preview's minimum ask plus 10%, so a fill inside the auction always clears
    ///      the post-hook's live floor. Each commit takes the next bit-invalidator nonce.
    function _commit(uint256 loanId, uint256 seed) internal returns (bool) {
        address holder = _loan(loanId).borrower;
        uint256 minTaker;
        try SwapToRepayIntentFacet(diamond).previewSwapToRepayIntentLot(loanId) returns (uint256, uint256 minTaker_) {
            minTaker = minTaker_;
        } catch (bytes memory err) {
            _noteRevert("commitIntent.preview", err);
            return false;
        }
        bytes memory extension = SwapToRepayIntentFacet(diamond).canonicalExtension();
        uint64 deadline = uint64(block.timestamp + INTENT_AUCTION_SECONDS);
        uint256 nonce = _nextIntentNonce++;
        SwapToRepayIntentFacet.FusionOrderParams memory params = SwapToRepayIntentFacet.FusionOrderParams({
            takerAmount: minTaker + minTaker / 10 + 1,
            deadline: deadline,
            salt: (_mix(seed, "salt") << 160) | uint256(uint160(uint256(keccak256(extension)))),
            makerTraits: INTENT_TRAIT_FLAGS | (uint256(deadline) << 80) | (nonce << 120),
            extension: extension
        });
        vm.prank(holder);
        try SwapToRepayIntentFacet(diamond).commitSwapToRepayIntent(loanId, params) {
            _trackIntent(loanId);
            (bool live,) = _readCommit(loanId);
            if (!live) return false;
            ++intentCommits;
            return true;
        } catch (bytes memory err) {
            _noteRevert("commitIntent", err);
            return false;
        }
    }

    /// @dev Rebuilds the order from the Diamond's own read-back (as a resolver does) and fills it as
    ///      the taker, paying the order's taking amount.
    function _fillCommitted(uint256 loanId) internal returns (bool) {
        (bool live, SwapToRepayIntentFacet.FusionOrderRead memory r) = _readCommit(loanId);
        if (!live) return false;
        IOrderMixin.Order memory order = IOrderMixin.Order({
            salt: r.salt,
            maker: LopAddress.wrap(uint256(uint160(r.maker))),
            receiver: LopAddress.wrap(uint256(uint160(r.receiver))),
            makerAsset: LopAddress.wrap(uint256(uint160(r.makerAsset))),
            takerAsset: LopAddress.wrap(uint256(uint160(r.takerAsset))),
            makingAmount: r.makerAmount,
            takingAmount: r.takerAmount,
            makerTraits: MakerTraits.wrap(r.makerTraits)
        });
        ERC20Mock(r.takerAsset).mint(address(this), r.takerAmount);
        try lop.fillContractOrderParsed(order, "", r.makerAmount, address(this), r.extension, "") {
            (bool stillLive,) = _readCommit(loanId);
            if (stillLive) return false;
            ++intentFills;
            return true;
        } catch (bytes memory err) {
            _noteRevert("fillIntent", err);
            return false;
        }
    }

    function _readCommit(uint256 loanId)
        internal
        view
        returns (bool live, SwapToRepayIntentFacet.FusionOrderRead memory r)
    {
        try SwapToRepayIntentFacet(diamond).getIntentCommit(loanId) returns (
            SwapToRepayIntentFacet.FusionOrderRead memory read
        ) {
            return (true, read);
        } catch {
            return (false, r);
        }
    }

    function _pickLiveCommit(uint256 seed, bool fillable) internal view returns (uint256) {
        uint256 n = _intentLoanIds.length;
        uint256 tries = n < SCAN ? n : SCAN;
        for (uint256 k; k < tries; ++k) {
            uint256 id = _intentLoanIds[(seed % n + k) % n];
            (bool live, SwapToRepayIntentFacet.FusionOrderRead memory r) = _readCommit(id);
            if (live && (!fillable || uint256(r.deadline) >= block.timestamp)) return id;
        }
        return 0;
    }

    // ============================================================================================
    //  Loan opening
    // ============================================================================================

    /// @dev Collateral is the protocol's create-time floor for this pair at today's prices
    ///      ({_collateralFloor}) times the seed-driven open margin, so every open clears
    ///      `LibOfferBounds.assertOfferBounds` for every asset kind and after any `priceShock`.
    function _openLoanOf(Kind kind, uint256 seed, uint256 principal, uint256 durationDays)
        internal
        returns (uint256)
    {
        (address lending, address collateral) = _assetsOf(kind);
        uint256 collateralAmount = (_collateralFloor(principal, lending, collateral) * _marginBps(seed)) / 10_000;
        return _openLoanExplicit(kind, seed, principal, collateralAmount, durationDays);
    }

    /// @dev The handler's restatement of `LibRiskMath.minCollateralForLending` in the non-tiered
    ///      regime, over the SAME reads the Diamond makes: the oracle prices (SetupTest's and the
    ///      base's mocks, moved by `priceShock`), the collateral's effective tier and that tier's
    ///      liquidation LTV, the live admission HF floor, and the per-asset init-LTV cap clamp.
    ///      Same integer order (whole-unit USD, then round up), so it is the protocol's figure, not a
    ///      guess at it.
    function _collateralFloor(uint256 principal, address lending, address collateral)
        internal
        view
        returns (uint256 floor)
    {
        if (ConfigFacet(diamond).getDepthTieredLtvEnabled()) revert DepthTieredFloorNotModelled();
        uint8 tier = OracleFacet(diamond).getEffectiveLiquidityTier(collateral);
        (uint256 t1, uint256 t2, uint256 t3) = ConfigFacet(diamond).getTierLiquidationLtvBps();
        uint256 liqBps = tier == 3 ? t3 : (tier == 2 ? t2 : t1);
        uint256 hfFloor = RiskFacet(diamond).getMinHealthFactor();
        (uint256 pPrice, uint8 pFeedDec) = OracleFacet(diamond).getAssetPrice(lending);
        (uint256 cPrice, uint8 cFeedDec) = OracleFacet(diamond).getAssetPrice(collateral);
        if (pPrice == 0 || cPrice == 0) revert FloorUnpriced(lending, collateral);
        uint256 principalUsd =
            (principal * pPrice) / (10 ** pFeedDec) / (10 ** IERC20Metadata(lending).decimals());
        uint256 cScale = (10 ** cFeedDec) * (10 ** IERC20Metadata(collateral).decimals());
        uint256 collateralUsd = (principalUsd * hfFloor * 10_000) / (1e18 * liqBps);
        floor = _divUp(collateralUsd * cScale, cPrice);
        uint256 capBps = ConfigFacet(diamond).getAssetRiskParams(collateral).loanInitMaxLtvBps;
        if (capBps != 0) {
            uint256 ltvFloor = _divUp(_divUp(principalUsd * 10_000, capBps) * cScale, cPrice);
            if (ltvFloor > floor) floor = ltvFloor;
        }
    }

    /// @dev The inverse of {_collateralFloor} with the open margin applied: the largest principal
    ///      whose floor, times this seed's margin, is at most `collateralAmount`. Priced at
    ///      {FLOOR_REFERENCE_PRINCIPAL} so the floor's whole-unit truncation is negligible; the 5%
    ///      minimum margin covers what remains.
    function _maxPrincipalFor(uint256 collateralAmount, address lending, address collateral, uint256 seed)
        internal
        view
        returns (uint256)
    {
        uint256 refFloor = _collateralFloor(FLOOR_REFERENCE_PRINCIPAL, lending, collateral);
        return (collateralAmount * FLOOR_REFERENCE_PRINCIPAL / refFloor) * 10_000 / _marginBps(seed);
    }

    function _marginBps(uint256 seed) internal pure returns (uint256) {
        return FLOOR_MARGIN_MIN_BPS + (_mix(seed, "collateral") % (FLOOR_MARGIN_SPREAD_BPS + 1));
    }

    function _assetsOf(Kind kind) internal view returns (address lending, address collateral) {
        lending = kind == Kind.Reverse ? weth : usdc;
        collateral = kind == Kind.ForwardWeth ? weth : (kind == Kind.ForwardVpfi ? vpfi : usdc);
    }

    function _divUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    function _openLoanExplicit(
        Kind kind,
        uint256 seed,
        uint256 principal,
        uint256 collateralAmount,
        uint256 durationDays
    ) internal returns (uint256 loanId) {
        (address borrower_, uint256 borrowerPk) = _cleanBorrower(_mix(seed, "borrower"));
        if (borrower_ == address(0)) return 0;
        address lender_ = _lenders[_mix(seed, "lender") % 2];
        (address lending, address collateral) = _assetsOf(kind);
        _fund(lender_, lending, principal);
        _fund(borrower_, collateral, collateralAmount);
        (bool created, uint256 offerId) =
            _createLenderOffer(lender_, lending, principal, collateral, collateralAmount, durationDays);
        if (!created) return 0;
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(diamond, borrower_, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(diamond, t, borrowerPk);
        vm.prank(borrower_);
        try OfferAcceptFacet(diamond).acceptOffer(offerId, t, sig) returns (uint256 id) {
            loanId = id;
        } catch (bytes memory err) {
            _noteRevert("openLoan.accept", err);
            return 0;
        }
        _loanIds.push(loanId);
        kindOf[loanId] = kind;
        collateralOf[loanId] = collateral;
        _setRisk(loanId, HF_HEALTHY, LTV_HEALTHY);
        ++loansOpened;
    }

    function _createLenderOffer(
        address lender_,
        address lending,
        uint256 principal,
        address collateral,
        uint256 collateralAmount,
        uint256 durationDays
    ) internal returns (bool created, uint256 offerId) {
        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: lending,
            amount: principal,
            interestRateBps: RATE_BPS,
            collateralAsset: collateral,
            collateralAmount: collateralAmount,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: principal,
            interestRateBpsMax: RATE_BPS,
            collateralAmountMax: collateralAmount,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
        vm.prank(lender_);
        try OfferCreateFacet(diamond).createOffer(p) returns (uint256 id) {
            return (true, id);
        } catch (bytes memory err) {
            _noteRevert("openLoan.create", err);
            return (false, 0);
        }
    }

    // ============================================================================================
    //  Small helpers
    // ============================================================================================

    function _pick(uint256 seed, Want want) internal view returns (uint256) {
        uint256 n = _loanIds.length;
        uint256 tries = n < SCAN ? n : SCAN;
        for (uint256 k; k < tries; ++k) {
            uint256 id = _loanIds[(seed % n + k) % n];
            if (_wants(want, id, _statusOf(id))) return id;
        }
        return 0;
    }

    function _wants(Want want, uint256 id, LibVaipakam.LoanStatus st) internal view returns (bool) {
        if (want == Want.ActiveAny) return st == LibVaipakam.LoanStatus.Active;
        if (want == Want.ActiveForward) return st == LibVaipakam.LoanStatus.Active && kindOf[id] != Kind.Reverse;
        if (want == Want.ActiveOrFallback) {
            return st == LibVaipakam.LoanStatus.Active || st == LibVaipakam.LoanStatus.FallbackPending;
        }
        bool terminal = st == LibVaipakam.LoanStatus.Repaid || st == LibVaipakam.LoanStatus.Defaulted
            || st == LibVaipakam.LoanStatus.InternalMatched;
        if (want == Want.LenderClaimable) return terminal || st == LibVaipakam.LoanStatus.FallbackPending;
        return terminal;
    }

    function _cleanBorrower(uint256 seed) internal view returns (address, uint256) {
        for (uint256 i; i < 3; ++i) {
            uint256 idx = (seed % 3 + i) % 3;
            if (!_flagged(_borrowers[idx])) return (_borrowers[idx], _borrowerPks[idx]);
        }
        return (address(0), 0);
    }

    function _flagged(address who) internal view returns (bool) {
        return sanctions.flagged(who);
    }

    function _loan(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(diamond).getLoanDetails(loanId);
    }

    function _statusOf(uint256 loanId) internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(diamond).getLoanDetails(loanId).status;
    }

    function _snapshotTotal(uint256 loanId) internal view returns (uint256) {
        (uint256 l, uint256 t, uint256 b,,,,) = ClaimFacet(diamond).getFallbackSnapshot(loanId);
        return l + t + b;
    }

    /// @dev The two price-feed-driven inputs SetupTest mocks globally, overridden for one loan.
    function _setRisk(uint256 loanId, uint256 hf, uint256 ltv) internal {
        vm.mockCall(diamond, abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(hf));
        vm.mockCall(diamond, abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId), abi.encode(ltv));
    }

    function _adapterCalls(bool fails) internal view returns (LibSwap.AdapterCall[] memory route) {
        route = new LibSwap.AdapterCall[](1);
        route[0] = LibSwap.AdapterCall({adapterIdx: fails ? failingAdapterIdx : workingAdapterIdx, data: bytes("")});
    }

    /// @dev ERC20Mock tokens are minted; VPFI comes from the handler's stash (the harness is its minter).
    function _fund(address who, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == vpfi) {
            uint256 held = IERC20(vpfi).balanceOf(address(this));
            if (held < amount) revert VpfiStashExhausted(amount, held);
            if (!IERC20(vpfi).transfer(who, amount)) revert VpfiStashExhausted(amount, held);
        } else {
            ERC20Mock(token).mint(who, amount);
        }
    }

    function _trackFallback(uint256 loanId) internal {
        if (_fallbackTracked[loanId]) return;
        _fallbackTracked[loanId] = true;
        _fallbackLoanIds.push(loanId);
    }

    function _trackIntent(uint256 loanId) internal {
        if (_intentTracked[loanId]) return;
        _intentTracked[loanId] = true;
        _intentLoanIds.push(loanId);
    }

    function _forwardKind(uint256 seed) internal pure returns (Kind) {
        return _mix(seed, "kind") % 2 == 0 ? Kind.ForwardWeth : Kind.ForwardVpfi;
    }

    function _principal(uint256 seed) internal pure returns (uint256) {
        return 100e18 + (_mix(seed, "principal") % 9_901e18);
    }

    function _mix(uint256 seed, bytes32 tag) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, tag)));
    }

    function _noteRevert(bytes32 key, bytes memory err) internal {
        lastRevert[key] = err;
        ++reverts[key];
        lastRevertKey = key;
        lastRevertData = err;
    }
}
