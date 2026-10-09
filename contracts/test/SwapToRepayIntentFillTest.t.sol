// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {ITakerInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/ITakerInteraction.sol";
import {MakerTraits} from "@1inch/limit-order-protocol/contracts/libraries/MakerTraitsLib.sol";
import {Address as LopAddress} from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import {CustodyInvariantBase} from "./invariants/CustodyInvariantBase.sol";
import {CustodyHandler} from "./invariants/CustodyHandler.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibFillLock} from "../src/libraries/LibFillLock.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibSwapToRepayIntentSettlement} from "../src/libraries/LibSwapToRepayIntentSettlement.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {CUSTODY_INTENT_CANCEL_GRACE} from "./invariants/CustodyHandler.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {CallbackERC20} from "./mocks/CallbackERC20.sol";
import {MockLopFill} from "./mocks/MockLopFill.sol";
import {LibLopDomain} from "../src/libraries/LibLopDomain.sol";

/**
 * @title  TakerReentry
 * @notice A taker interaction that, once armed, makes ONE call while the LOP sits between its
 *         maker-to-taker and taker-to-maker transfers, and records how that call ended instead of
 *         letting it bubble -- the same shape as {CallbackERC20}, at the LOP's other mid-fill hook.
 * @dev    A non-zero `caller` pranks the call so it arrives as that party (a borrower), not as this
 *         contract. Disarms itself before calling. Test-only: it reaches the cheatcode address.
 */
contract TakerReentry is ITakerInteraction {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public target;
    address public caller;
    bytes public data;
    bool public armed;
    uint256 public calls;
    bool public lastCallOk;
    bytes4 public lastRevertSelector;

    function arm(address target_, address caller_, bytes calldata data_) external {
        (target, caller, data, armed) = (target_, caller_, data_, true);
    }

    function takerInteraction(
        IOrderMixin.Order calldata,
        bytes calldata,
        bytes32,
        address,
        uint256,
        uint256,
        uint256,
        bytes calldata
    ) external override {
        if (!armed) return;
        armed = false;
        if (caller != address(0)) VM.prank(caller);
        (bool ok, bytes memory ret) = target.call(data);
        ++calls;
        lastCallOk = ok;
        lastRevertSelector = (!ok && ret.length >= 4) ? bytes4(ret) : bytes4(0);
    }
}

/**
 * @title  CallbackWETH
 * @notice {CallbackERC20} with WETH's deposit and withdraw, so the LOP's native-value branch (wrap the
 *         taker's ETH, refund the excess) can run against the harness's WETH. Storage-compatible with
 *         the ERC20Mock it is etched over: it adds code, not state.
 */
contract CallbackWETH is CallbackERC20 {
    constructor() CallbackERC20("MockCollateral", "MCK", 18) {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "CallbackWETH: send");
    }
}

/**
 * @title  UnwrapTaker
 * @notice A taker that asks the LOP to unwrap the WETH lot (`takerTraits.unwrapWeth`) and, once armed,
 *         makes ONE call from the native ETH the LOP pays it mid-fill -- the one native-value hook a
 *         contract-maker (Vaipakam) order can meet.
 */
contract UnwrapTaker {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public target;
    address public caller;
    bytes public data;
    bool public armed;
    uint256 public calls;
    bytes4 public lastRevertSelector;

    function arm(address target_, address caller_, bytes calldata data_) external {
        (target, caller, data, armed) = (target_, caller_, data_, true);
    }

    function fill(MockLopFill lop, IOrderMixin.Order calldata order, uint256 amount, bytes calldata extension)
        external
    {
        IERC20(address(uint160(LopAddress.unwrap(order.takerAsset)))).approve(address(lop), type(uint256).max);
        lop.fillContractOrderParsedUnwrap(order, "", amount, address(this), extension, "");
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        if (caller != address(0)) VM.prank(caller);
        (bool ok, bytes memory ret) = target.call(data);
        ++calls;
        lastRevertSelector = (!ok && ret.length >= 4) ? bytes4(ret) : bytes4(0);
    }
}

/**
 * @title  FillThenCall
 * @notice Fills an order and then, in the SAME call, makes one more call -- so a cell can see the
 *         state the fill leaves for the rest of its transaction on any forge version (newer forge
 *         clears transient storage between a test's top-level calls).
 */
contract FillThenCall {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bool public lastCallOk;

    function run(
        MockLopFill lop,
        IOrderMixin.Order calldata order,
        uint256 amount,
        bytes calldata extension,
        address target,
        address caller,
        bytes calldata data
    ) external {
        IERC20(address(uint160(LopAddress.unwrap(order.takerAsset)))).approve(address(lop), type(uint256).max);
        lop.fillContractOrderParsed(order, "", amount, address(this), extension, "");
        if (caller != address(0)) VM.prank(caller);
        (lastCallOk,) = target.call(data);
    }
}

/**
 * @title  SwapToRepayIntentFillTest
 * @notice #1566 slice 3: a swap-to-repay intent driven through a WHOLE LOP fill in one transaction
 *         ({MockLopFill}), on the #2141 custody harness's production Diamond -- so a cell can see what
 *         happens BETWEEN the hooks, which the pranked-hook harness in `SwapToRepayIntentFacetTest`
 *         cannot.
 *
 * @dev    The cells, against #1566 slice 3's design ("the intent lot is pulled at use and never
 *         rests"): the commit moves nothing (I1); the fill's pre-hook pulls exactly the lot through
 *         the Diamond to the taker (I2, I6, I10); an underfunded taker changes nothing (I3); the
 *         fill lock refuses every re-entry between the two hooks -- from the maker transfer, the
 *         pull itself, the taker interaction, the principal transfer and the native refund (I4,
 *         I4b, I5, I5b, I5c) -- lasts exactly one fill (I12) and refuses a nested Vaipakam fill
 *         (I13); the settlement is funded by exactly the taking amount (I6b); a flagged borrower
 *         blocks neither way out (I7, I8); a VPFI pull restamps the tier (I9); a commit recorded
 *         under the old custody is refused by name (I11); the teardown reads the LOP's nonce bit
 *         (I14); and a pause stops fills (I15). Each cell asserts its fixture is live first, and
 *         the guard cells straddle: the same call outside a fill succeeds.
 *         I0f, the fork cell against the DEPLOYED LOP v4, is {SwapToRepayIntentFillForkTest} below.
 *
 *         The collateral (WETH) and principal (USDC) tokens carry {CallbackERC20}'s transfer hook
 *         (WETH as {CallbackWETH}, which adds deposit and withdraw for the native-value branch): the
 *         code is etched over the harness's ERC20Mock tokens, whose storage it extends append-only,
 *         so balances, approvals and the oracle wiring all carry over.
 */
contract SwapToRepayIntentFillTest is CustodyInvariantBase {
    /// @dev The swap-to-repay bit-invalidator nonce sits at bits 120..159 of the maker traits.
    uint256 internal constant NONCE_SHIFT = 120;
    uint256 internal constant NONCE_MASK = (1 << 40) - 1;
    /// @dev The commit's flag set: no partial fills, pre- and post-interaction, has extension.
    uint256 internal constant TRAIT_FLAGS = (1 << 255) | (1 << 252) | (1 << 251) | (1 << 249);
    uint256 internal constant AUCTION_SECONDS = 300;

    CustodyHandler internal handler;
    TakerReentry internal takerHook;
    address internal taker;
    uint256 internal _seed = 100;
    uint256 internal _nextNonce = 1 << 30;

    function setUp() public {
        _deployCustodyHarness();
        handler = _deployCustodyHandler();
        // A marker balance minted BEFORE the etch, read back after it: the etched code kept storage.
        ERC20Mock(usdc).mint(address(0xBEEF), 7);
        vm.etch(weth, address(new CallbackWETH()).code);
        vm.etch(usdc, address(new CallbackERC20("MockLiquid", "MLQ", 18)).code);
        takerHook = new TakerReentry();
        taker = makeAddr("intentTaker");
        vm.prank(taker);
        IERC20(usdc).approve(address(lopFill), type(uint256).max);
        assertEq(IERC20(usdc).balanceOf(address(0xBEEF)), 7, "fixture-live: the etched USDC kept its balances");
        assertFalse(CallbackERC20(weth).isArmed(), "fixture-live: the etched WETH hook starts disarmed");
    }

    // ============================================================================================
    //  I0 -- mock fidelity
    // ============================================================================================

    /// @notice The fill runs the LOP's steps in the LOP's order -- the bit invalidation BEFORE the
    ///         pre-hook, the taker interaction BETWEEN the two transfers -- and a bit-invalidator order
    ///         sets its nonce bit and never writes the remaining-amount slot.
    /// @dev    This compares the mock with its own step log: it pins the mock against regressing, not
    ///         against the deployed LOP. Agreement with the deployed LOP is I0f's and I0g's job (the
    ///         order hash, the domain and the cancel path's bit write, on a mainnet fork).
    function test_I0_mockFidelity_callOrder_invalidateBeforePre_rawRemainingStaysZero() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        IOrderMixin.Order memory order = _order(r);
        bytes32 orderHash = lopFill.hashOrder(order);
        uint256 nonce = (r.makerTraits >> NONCE_SHIFT) & NONCE_MASK;
        assertEq(
            IntentDispatchFacet(address(diamond)).isValidSignature(orderHash, ""),
            IERC1271.isValidSignature.selector,
            "fixture-live: the Diamond and the mock agree on the order hash"
        );
        assertFalse(_bitSet(nonce), "straddle: the nonce bit is clear before the fill");

        _fund(r.takerAmount);
        vm.prank(taker);
        lopFill.fillContractOrderParsed(
            order, "", r.makerAmount, taker, r.extension, abi.encodePacked(address(takerHook))
        );

        bytes32[] memory s = lopFill.steps();
        assertEq(s.length, 6, "six steps");
        assertEq(s[0], lopFill.STEP_INVALIDATE(), "1: the invalidation comes first");
        assertEq(s[1], lopFill.STEP_PRE_INTERACTION(), "2: then the maker pre-hook");
        assertEq(s[2], lopFill.STEP_MAKER_TO_TAKER(), "3: then the maker-to-taker transfer");
        assertEq(s[3], lopFill.STEP_TAKER_INTERACTION(), "4: then the taker interaction");
        assertEq(s[4], lopFill.STEP_TAKER_TO_MAKER(), "5: then the taker-to-maker transfer");
        assertEq(s[5], lopFill.STEP_POST_INTERACTION(), "6: then the maker post-hook");
        assertTrue(_bitSet(nonce), "the fill set the nonce bit");
        assertEq(lopFill.rawRemainingInvalidatorForOrder(address(diamond), orderHash), 0, "raw remaining stays 0");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the fill closed the loan");
    }

    // ============================================================================================
    //  I3 -- an underfunded taker
    // ============================================================================================

    /// @notice A taker one wei short reverts the WHOLE fill: the commit, the nonce bit, the loan, the
    ///         Diamond's and the borrower vault's collateral balances and the lien are all untouched.
    ///         Straddle: the same fill with that one wei clears.
    function test_I3_takerUnderfunded_fullRevert_nothingChanges() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        IOrderMixin.Order memory order = _order(r);
        uint256 nonce = (r.makerTraits >> NONCE_SHIFT) & NONCE_MASK;
        address borrower = LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        address vault = VaultFactoryFacet(address(diamond)).getUserVaultAddress(borrower);
        uint256 diamondBefore = IERC20(weth).balanceOf(address(diamond));
        uint256 vaultBefore = IERC20(weth).balanceOf(vault);
        uint256 lienBefore = MetricsFacet(address(diamond)).getLoanCollateralLien(loanId).amount;
        assertGt(r.makerAmount, 0, "fixture-live: a non-empty lot");

        _fund(r.takerAmount - 1);
        vm.prank(taker);
        vm.expectRevert(MockLopFill.TransferFromTakerToMakerFailed.selector);
        lopFill.fillContractOrderParsed(order, "", r.makerAmount, taker, r.extension, "");

        assertEq(_read(loanId).makerAmount, r.makerAmount, "the commit is still live");
        assertFalse(_bitSet(nonce), "the nonce bit is still clear");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Active), "the loan is still Active");
        assertEq(IERC20(weth).balanceOf(address(diamond)), diamondBefore, "the Diamond's collateral is unchanged");
        assertEq(IERC20(weth).balanceOf(vault), vaultBefore, "the borrower vault's collateral is unchanged");
        assertEq(
            MetricsFacet(address(diamond)).getLoanCollateralLien(loanId).amount, lienBefore, "the lien is unchanged"
        );

        _fund(1);
        vm.prank(taker);
        lopFill.fillContractOrderParsed(order, "", r.makerAmount, taker, r.extension, "");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "straddle: the funded fill clears");
    }

    // ============================================================================================
    //  I1 / I2 -- the commit moves nothing; the fill pulls exactly the lot
    // ============================================================================================

    /// @notice I1. A commit leaves the lot in the borrower's vault: the Diamond's collateral, the
    ///         vault, the lien and the custody stamp are untouched, and the order's making amount --
    ///         the one the Diamond hashed and will sign for -- is the previewed lot.
    /// @dev    Kills: a pull at commit; a hash over a zero making amount (S1-12).
    function test_I1_commit_movesNothing_hashCarriesTheLot() public {
        uint256 loanId = _openWeth(++_seed);
        (uint256 lot,) = SwapToRepayIntentFacet(address(diamond)).previewSwapToRepayIntentLot(loanId);
        address vault = _vaultOf(loanId);
        uint256 diamondBefore = IERC20(weth).balanceOf(address(diamond));
        uint256 vaultBefore = IERC20(weth).balanceOf(vault);
        uint256 lienBefore = _lien(loanId);
        assertGt(lot, 0, "fixture-live: a non-empty lot");
        assertEq(lienBefore, LoanFacet(address(diamond)).getLoanDetails(loanId).collateralAmount, "fixture-live: whole lien");

        SwapToRepayIntentFacet.FusionOrderRead memory r = _commitOn(loanId);

        assertEq(r.makerAmount, lot, "the order carries the previewed lot");
        assertEq(IERC20(weth).balanceOf(address(diamond)), diamondBefore, "the Diamond holds no lot");
        assertEq(IERC20(weth).balanceOf(vault), vaultBefore, "the vault keeps all of it");
        assertEq(_lien(loanId), lienBefore, "the lien stays at the whole collateral");
        assertEq(SwapToRepayIntentFacet(address(diamond)).getIntentCustody(loanId), 0, "the custody stamp is 0");
        IOrderMixin.Order memory order = _order(r);
        assertEq(
            IntentDispatchFacet(address(diamond)).isValidSignature(lopFill.hashOrder(order), ""),
            IERC1271.isValidSignature.selector,
            "the Diamond signs for the order whose making amount is the lot"
        );
        order.makingAmount = 0;
        assertEq(
            IntentDispatchFacet(address(diamond)).isValidSignature(lopFill.hashOrder(order), ""),
            bytes4(0xffffffff),
            "straddle: not for a zero making amount"
        );
    }

    /// @notice I2. A whole fill takes exactly the lot out of the vault, through the Diamond, to the
    ///         taker: the Diamond's collateral balance is the same after the fill as before it, the
    ///         vault is down by the lot, and the lien is the collateral the fill did not take.
    /// @dev    Kills: a pull of the wrong amount; the pull's provenance event missing.
    function test_I2_fill_pullsExactlyTheLot_throughTheDiamond_toTheTaker() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        address vault = _vaultOf(loanId);
        uint256 collateral = LoanFacet(address(diamond)).getLoanDetails(loanId).collateralAmount;
        uint256 diamondBefore = IERC20(weth).balanceOf(address(diamond));
        uint256 vaultBefore = IERC20(weth).balanceOf(vault);
        assertLt(r.makerAmount, collateral, "fixture-live: the lot is part of the collateral");

        _fund(r.takerAmount);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LibSwapToRepayIntentSettlement.SwapToRepayIntentLotPulled(
            loanId, lopFill.hashOrder(_order(r)), LoanFacet(address(diamond)).getLoanDetails(loanId).borrower, weth, r.makerAmount
        );
        vm.prank(taker);
        lopFill.fillContractOrderParsed(_order(r), "", r.makerAmount, taker, r.extension, "");

        assertEq(IERC20(weth).balanceOf(address(diamond)), diamondBefore, "the Diamond keeps none of it");
        assertEq(IERC20(weth).balanceOf(vault), vaultBefore - r.makerAmount, "the vault is down by the lot");
        assertEq(IERC20(weth).balanceOf(taker), r.makerAmount, "the taker has the lot");
        assertEq(_lien(loanId), collateral - r.makerAmount, "the lien is what the fill did not take");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the fill closed the loan");
    }

    // ============================================================================================
    //  I4 / I5 -- no re-entry while the fill holds the lock
    // ============================================================================================

    /// @notice I4 (repay). While the LOP moves the lot to the taker, the collateral token's callback
    ///         tries to repay ANOTHER loan: refused with `FillInProgress`. Straddle: the same repay,
    ///         after the fill, succeeds.
    /// @dev    Kills: a function-scoped `nonReentrant` in place of the lock (it is released when the
    ///         pre-hook returns, so this call would get through).
    function test_I4_repayAnotherLoanDuringTheMakerTransfer_isRefused() public {
        (uint256 other, address otherBorrower) = _otherActiveLoan();
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        bytes memory repay = abi.encodeCall(RepayFacet.repayLoan, (other));
        CallbackERC20(weth).arm(address(diamond), taker, address(diamond), otherBorrower, repay);

        _fill(r, "");

        assertEq(CallbackERC20(weth).callbacks(), 1, "fixture-live: the hook fired inside the maker transfer");
        assertEq(CallbackERC20(weth).lastRevertSelector(), LibFillLock.FillInProgress.selector, "refused by the lock");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Active), "the other loan is untouched");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the fill itself completed");
        vm.prank(otherBorrower);
        RepayFacet(address(diamond)).repayLoan(other);
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Repaid), "straddle: outside a fill it repays");
    }

    /// @notice I4 (liquidate). The callback tries to liquidate another loan whose HF is below 1:
    ///         refused. Straddle: the same liquidation after the fill goes through.
    function test_I4_liquidateAnotherLoanDuringTheMakerTransfer_isRefused() public {
        (uint256 other,) = _otherActiveLoan();
        _setRisk(other, 0.9e18, 9_600);
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        bytes memory liquidate = abi.encodeCall(RiskFacet.triggerLiquidation, (other, _workingRoute()));
        CallbackERC20(weth).arm(address(diamond), taker, address(diamond), makeAddr("liquidator"), liquidate);

        _fill(r, "");

        assertEq(CallbackERC20(weth).callbacks(), 1, "fixture-live: the hook fired");
        assertEq(CallbackERC20(weth).lastRevertSelector(), LibFillLock.FillInProgress.selector, "refused by the lock");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Active), "the other loan is untouched");
        vm.prank(makeAddr("liquidator"));
        RiskFacet(address(diamond)).triggerLiquidation(other, _workingRoute());
        assertTrue(_status(other) != LibVaipakam.LoanStatus.Active, "straddle: outside a fill it liquidates");
    }

    /// @notice I4 (cancel, N6). At `timestamp == deadline` an order is both fillable (the LOP's
    ///         expiry is inclusive) and cancellable (the cancel needs `timestamp >= deadline`). The
    ///         callback tries to cancel the very order being filled: refused, and the fill settles.
    ///         Straddle: a second order cancels at the same instant outside a fill.
    function test_I4_cancelTheFillingOrderAtItsDeadline_isRefused() public {
        uint256 loanId = _commitWeth();
        uint256 sibling = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        assertEq(_read(sibling).deadline, r.deadline, "fixture-live: one deadline");
        vm.warp(r.deadline);
        address borrower = LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        bytes memory cancel = abi.encodeCall(SwapToRepayIntentFacet.cancelSwapToRepayIntent, (loanId));
        CallbackERC20(weth).arm(address(diamond), taker, address(diamond), borrower, cancel);

        _fill(r, "");

        assertEq(CallbackERC20(weth).lastRevertSelector(), LibFillLock.FillInProgress.selector, "refused by the lock");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the fill settled");
        vm.prank(LoanFacet(address(diamond)).getLoanDetails(sibling).borrower);
        SwapToRepayIntentFacet(address(diamond)).cancelSwapToRepayIntent(sibling);
        // Straddle: the sibling's cancel went through -- its commit is gone.
        vm.expectRevert(abi.encodeWithSelector(SwapToRepayIntentFacet.IntentNoCommit.selector, sibling));
        SwapToRepayIntentFacet(address(diamond)).getIntentCommit(sibling);
    }

    /// @notice I4b. A re-entry from inside the pre-hook's own pull (the collateral token's callback on
    ///         the vault-to-Diamond transfer) is refused: the lock is taken BEFORE the pull.
    /// @dev    Kills: the lock acquired after the pull (design: "set before the pull").
    function test_I4b_reentryFromInsideThePull_isRefused() public {
        (uint256 other, address otherBorrower) = _otherActiveLoan();
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        CallbackERC20(weth).arm(
            _vaultOf(loanId), address(diamond), address(diamond), otherBorrower,
            abi.encodeCall(RepayFacet.repayLoan, (other))
        );

        _fill(r, "");

        assertEq(CallbackERC20(weth).callbacks(), 1, "fixture-live: the hook fired inside the pull");
        assertEq(CallbackERC20(weth).lastRevertSelector(), LibFillLock.FillInProgress.selector, "refused by the lock");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Active), "the other loan is untouched");
    }

    /// @notice I5. The taker interaction (between the two transfers) is refused. Straddle: after the
    ///         fill the same repay succeeds.
    /// @dev    Kills: the lock released before the taker interaction.
    function test_I5_reentryFromTheTakerInteraction_isRefused() public {
        (uint256 other, address otherBorrower) = _otherActiveLoan();
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        takerHook.arm(address(diamond), otherBorrower, abi.encodeCall(RepayFacet.repayLoan, (other)));

        _fill(r, abi.encodePacked(address(takerHook)));

        assertEq(takerHook.calls(), 1, "fixture-live: the taker interaction ran");
        assertEq(takerHook.lastRevertSelector(), LibFillLock.FillInProgress.selector, "refused by the lock");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Active), "the other loan is untouched");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the fill itself completed");
        vm.prank(otherBorrower);
        RepayFacet(address(diamond)).repayLoan(other);
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Repaid), "straddle: outside a fill it repays");
    }

    /// @notice I5b. The principal token's callback on the taker-to-maker transfer is refused.
    function test_I5b_reentryFromThePrincipalTransfer_isRefused() public {
        (uint256 other, address otherBorrower) = _otherActiveLoan();
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        CallbackERC20(usdc).arm(taker, address(diamond), address(diamond), otherBorrower, abi.encodeCall(RepayFacet.repayLoan, (other)));

        _fill(r, "");

        assertEq(CallbackERC20(usdc).callbacks(), 1, "fixture-live: the hook fired inside the taker transfer");
        assertEq(CallbackERC20(usdc).lastRevertSelector(), LibFillLock.FillInProgress.selector, "refused by the lock");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Active), "the other loan is untouched");
    }

    /// @notice I5c. The native-value hook a Vaipakam order can actually meet: a taker that asks the LOP
    ///         to unwrap the WETH lot receives it as native ETH mid-fill, and the re-entry from its
    ///         receive hook is refused. (The taker-side ETH payment and its refund are reachable only
    ///         through `fillOrder`, which needs an EOA maker's signature; the Diamond is a contract
    ///         maker, so its orders fill through the non-payable `fillContractOrder`.)
    function test_I5c_reentryFromTheUnwrappedEthPayout_isRefused() public {
        MockLopFill lopW = new MockLopFill(weth);
        IntentConfigFacet(address(diamond)).setFusionLimitOrderProtocol(address(lopW));
        (uint256 other, address otherBorrower) = _otherActiveLoan();
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        assertEq(r.makerAsset, weth, "fixture-live: a WETH lot");
        vm.deal(weth, r.makerAmount); // the etched WETH pays its withdrawals in native ETH

        UnwrapTaker t = new UnwrapTaker();
        ERC20Mock(usdc).mint(address(t), r.takerAmount);
        t.arm(address(diamond), otherBorrower, abi.encodeCall(RepayFacet.repayLoan, (other)));
        t.fill(lopW, _order(r), r.makerAmount, r.extension);

        assertEq(t.calls(), 1, "fixture-live: the unwrapped lot reached the taker as native ETH");
        assertEq(address(t).balance, r.makerAmount, "fixture-live: the whole lot");
        assertEq(t.lastRevertSelector(), LibFillLock.FillInProgress.selector, "refused by the lock");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Active), "the other loan is untouched");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the fill settled");
    }

    // ============================================================================================
    //  I6 -- the exact deltas
    // ============================================================================================

    /// @notice I6. The pull must raise the Diamond's balance by exactly the lot: a token that skims
    ///         one wei on the way (modelled by the callback moving one wei out of the Diamond right
    ///         after the pull) fails the whole fill, and the commit stays cancellable with nothing
    ///         lost.
    /// @dev    Kills: the pre-hook's delta check dropped. The Diamond holds another balance of the same
    ///         token (a stand-in reserve), so without the check the fill would NOT fail on its own: the
    ///         LOP would make up the skimmed wei from that reserve and settle -- the harm the check
    ///         exists to prevent.
    function test_I6_feeOnThePull_revertsTheFill_commitStaysCancellable() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        uint256 reserve = 3e18;
        ERC20Mock(weth).mint(address(diamond), reserve);
        assertGe(IERC20(weth).balanceOf(address(diamond)), reserve, "fixture-live: another balance to draw on");
        address vault = _vaultOf(loanId);
        uint256 vaultBefore = IERC20(weth).balanceOf(vault);
        uint256 lienBefore = _lien(loanId);
        CallbackERC20(weth).arm(
            vault, address(diamond), weth, address(diamond), abi.encodeCall(IERC20.transfer, (makeAddr("skim"), 1))
        );

        _fund(r.takerAmount);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibSwapToRepayIntentSettlement.IntentCollateralFeeOnTransferUnsupported.selector, r.makerAmount - 1, r.makerAmount
            )
        );
        lopFill.fillContractOrderParsed(_order(r), "", r.makerAmount, taker, r.extension, "");

        assertEq(IERC20(weth).balanceOf(vault), vaultBefore, "nothing left the vault");
        assertEq(_lien(loanId), lienBefore, "the lien is whole");
        vm.warp(r.deadline + 1);
        vm.prank(LoanFacet(address(diamond)).getLoanDetails(loanId).borrower);
        SwapToRepayIntentFacet(address(diamond)).cancelSwapToRepayIntent(loanId);
        assertEq(IERC20(weth).balanceOf(vault), vaultBefore, "the cancel moves nothing either");
    }

    /// @notice I6b. Principal reaching the Diamond any way but the taker's transfer -- here the taker
    ///         interaction sends one extra wei straight to it -- fails the fill: the settlement is
    ///         funded by exactly the taking amount (S1-10).
    /// @dev    Kills: the delivered-equals-taking check dropped.
    function test_I6b_extraPrincipalMidFill_revertsWithDeliveredMismatch() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        takerHook.arm(usdc, taker, abi.encodeCall(IERC20.transfer, (address(diamond), 1)));

        _fund(r.takerAmount + 1);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibSwapToRepayIntentSettlement.IntentDeliveredMismatch.selector, r.takerAmount + 1, r.takerAmount
            )
        );
        lopFill.fillContractOrderParsed(
            _order(r), "", r.makerAmount, taker, r.extension, abi.encodePacked(address(takerHook))
        );
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Active), "nothing settled");
    }

    // ============================================================================================
    //  I7 / I8 -- a flagged borrower blocks neither way out
    // ============================================================================================

    /// @notice I7. A teardown moves nothing, so a borrower flagged after the commit no longer blocks
    ///         it (#658): the permissionless expired cancel succeeds, the vault and the lien are
    ///         untouched.
    /// @dev    Kills: the teardown still crediting the vault (it reverts for a flagged owner).
    function test_I7_teardown_movesNothing_succeedsForAFlaggedBorrower() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        address borrower = LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        address vault = _vaultOf(loanId);
        uint256 vaultBefore = IERC20(weth).balanceOf(vault);
        uint256 diamondBefore = IERC20(weth).balanceOf(address(diamond));
        uint256 lienBefore = _lien(loanId);
        sanctionsList.setFlagged(borrower, true);

        vm.warp(uint256(r.deadline) + CUSTODY_INTENT_CANCEL_GRACE + 1);
        vm.prank(makeAddr("anyone"));
        SwapToRepayIntentFacet(address(diamond)).cancelExpiredIntent(loanId);

        assertEq(IERC20(weth).balanceOf(vault), vaultBefore, "the vault is untouched");
        assertEq(IERC20(weth).balanceOf(address(diamond)), diamondBefore, "the Diamond is untouched");
        assertEq(_lien(loanId), lienBefore, "the lien is untouched");
        vm.expectRevert(abi.encodeWithSelector(SwapToRepayIntentFacet.IntentNoCommit.selector, loanId));
        SwapToRepayIntentFacet(address(diamond)).getIntentCommit(loanId);
    }

    /// @notice I7 (#658). A flagged borrower's live intent no longer blocks the lender's protection:
    ///         an HF liquidation force-cancels the commit (moving nothing) and liquidates.
    function test_I7_flaggedBorrowersLiveIntent_doesNotBlockLiquidation() public {
        uint256 loanId = _commitWeth();
        address borrower = LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        sanctionsList.setFlagged(borrower, true);
        _setRisk(loanId, 0.9e18, 9_600);

        vm.prank(makeAddr("liquidator"));
        RiskFacet(address(diamond)).triggerLiquidation(loanId, _workingRoute());

        assertTrue(_status(loanId) != LibVaipakam.LoanStatus.Active, "the loan was liquidated");
        vm.expectRevert(abi.encodeWithSelector(SwapToRepayIntentFacet.IntentNoCommit.selector, loanId));
        SwapToRepayIntentFacet(address(diamond)).getIntentCommit(loanId);
    }

    /// @notice I8. A borrower flagged after the commit does not block the fill that repays their
    ///         lender: the pull runs on the move-out exemption.
    /// @dev    Kills: a plain withdraw in the pre-hook.
    function test_I8_fill_succeedsForABorrowerFlaggedAfterTheCommit() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        sanctionsList.setFlagged(LoanFacet(address(diamond)).getLoanDetails(loanId).borrower, true);

        _fill(r, "");

        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the fill settled");
    }

    // ============================================================================================
    //  I9 / I10 -- the tier and the Diamond's other balances
    // ============================================================================================

    /// @notice I9. VPFI collateral: after the fill the holder's day stamp is the tracked balance net
    ///         of what the holder owes others -- the pull restamped it.
    /// @dev    Kills: the pre-hook's VPFI restamp dropped.
    function test_I9_vpfiFill_restampsTheTier() public {
        uint256 loanId = _openKind(++_seed, 1);
        address borrower = LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        SwapToRepayIntentFacet.FusionOrderRead memory r = _commitOn(loanId);
        assertEq(r.makerAsset, vpfi, "fixture-live: VPFI collateral");
        uint256 trackedBefore = VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(borrower, vpfi);

        _fill(r, "");

        uint256 tracked = VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(borrower, vpfi);
        assertEq(tracked, trackedBefore - r.makerAmount, "fixture-live: the lot left the tracked balance");
        (,, uint120 dayClose,) = TestMutatorFacet(address(diamond)).getStakeRollupStateRaw(borrower);
        assertEq(
            uint256(dayClose),
            tracked - EncumbranceMutateFacet(address(diamond)).getVpfiOwedToOthers(borrower),
            "the stamp is the tracked balance net of what is owed to others"
        );
    }

    /// @notice I10. Collateral the Diamond holds for other reasons (a stand-in for a same-token
    ///         buyback reserve, which needs a Diamond-as-treasury deployment this harness is not) is
    ///         untouched by a swap fill: the LOP draws exactly the lot the pre-hook pulled.
    /// @dev    Kills: a skipped or zero pull. The reserve is sized ABOVE the lot, so such a mutant does
    ///         not merely fail the fill: the LOP draws the whole lot out of the reserve, the fill
    ///         settles, and the cell fails on the property it states.
    function test_I10_aSwapFill_neverDrawsOnTheDiamondsOtherBalance() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        uint256 reserve = r.makerAmount + 3e18;
        ERC20Mock(weth).mint(address(diamond), reserve);
        uint256 before = IERC20(weth).balanceOf(address(diamond));
        assertGe(before, reserve, "fixture-live: the reserve is there");
        assertGt(reserve, r.makerAmount, "fixture-live: the reserve could cover the whole lot");

        _fill(r, "");

        assertEq(IERC20(weth).balanceOf(address(diamond)), before, "the reserve is untouched");
    }

    // ============================================================================================
    //  I11 -- O1: a commit recorded under the old custody is refused by name
    // ============================================================================================

    /// @notice I11. A commit carrying the old custody stamp (its lot in the Diamond) is refused at the
    ///         pre-hook and at the teardown, never paid from the Diamond's balance.
    /// @dev    Kills: a silent second withdrawal (the pre-hook would pull the lot again).
    function test_I11_legacyCommit_isRefusedByName_atBothWaysOut() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        ERC20Mock(weth).mint(address(diamond), r.makerAmount);
        TestMutatorFacet(address(diamond)).setIntentCustodialCollateralRaw(loanId, r.makerAmount);
        assertEq(SwapToRepayIntentFacet(address(diamond)).getIntentCustody(loanId), r.makerAmount, "fixture-live: legacy");

        _fund(r.takerAmount);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(LibSwapToRepayIntentSettlement.IntentCustodyNotVaultHeld.selector, loanId)
        );
        lopFill.fillContractOrderParsed(_order(r), "", r.makerAmount, taker, r.extension, "");

        vm.warp(r.deadline + 1);
        vm.prank(LoanFacet(address(diamond)).getLoanDetails(loanId).borrower);
        vm.expectRevert(abi.encodeWithSelector(SwapToRepayIntentFacet.IntentCustodyNotVaultHeld.selector, loanId));
        SwapToRepayIntentFacet(address(diamond)).cancelSwapToRepayIntent(loanId);
    }

    // ============================================================================================
    //  I12 / I13 -- the lock's span
    // ============================================================================================

    /// @notice I12. The lock lasts exactly one fill: a guarded Diamond call later in the SAME
    ///         transaction succeeds.
    /// @dev    Kills: a lock the post-hook does not release.
    function test_I12_aGuardedCallLaterInTheSameTransaction_succeeds() public {
        (uint256 other, address otherBorrower) = _otherActiveLoan();
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        FillThenCall runner = new FillThenCall();
        ERC20Mock(usdc).mint(address(runner), r.takerAmount);

        runner.run(lopFill, _order(r), r.makerAmount, r.extension, address(diamond), otherBorrower,
            abi.encodeCall(RepayFacet.repayLoan, (other)));

        assertTrue(runner.lastCallOk(), "the later call in the same transaction went through");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "after the fill settled");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Repaid), "and the other loan repaid");
    }

    /// @notice I13. A Vaipakam fill nested inside another is refused (the recorded trade-off): the
    ///         LOP's signature check on the inner order cannot reach the Diamond, so the inner fill
    ///         reverts `BadSignature` and its order stays live. The Diamond's own refusal is shown
    ///         directly by a second fill whose taker interaction asks for that signature.
    function test_I13_aNestedVaipakamFill_isRefused() public {
        uint256 inner = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory ri = _read(inner);
        assertEq(
            IntentDispatchFacet(address(diamond)).isValidSignature(lopFill.hashOrder(_order(ri)), ""),
            IERC1271.isValidSignature.selector,
            "fixture-live: outside a fill the Diamond signs for the inner order"
        );
        uint256 outer = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory ro = _read(outer);
        takerHook.arm(
            address(lopFill), address(0),
            abi.encodeCall(MockLopFill.fillContractOrderParsed, (_order(ri), bytes(""), ri.makerAmount, address(takerHook), ri.extension, bytes("")))
        );

        _fill(ro, abi.encodePacked(address(takerHook)));

        assertEq(takerHook.lastRevertSelector(), MockLopFill.BadSignature.selector, "the inner fill is refused");
        assertEq(uint8(_status(outer)), uint8(LibVaipakam.LoanStatus.Repaid), "the outer fill settled");
        assertEq(_read(inner).makerAmount, ri.makerAmount, "the inner order is still live");

        uint256 third = _commitWeth();
        takerHook.arm(
            address(diamond), address(0),
            abi.encodeCall(IntentDispatchFacet.isValidSignature, (lopFill.hashOrder(_order(ri)), bytes("")))
        );
        _fill(_read(third), abi.encodePacked(address(takerHook)));
        assertEq(takerHook.lastRevertSelector(), LibFillLock.FillInProgress.selector, "the Diamond refuses the signature read mid-fill");
    }

    // ============================================================================================
    //  I16 / I17 -- the hooks' caller checks
    // ============================================================================================

    /// @notice I16. Since slice 3 the pre-hook moves funds, so only the order's own LOP may call it: a
    ///         stray `preInteraction` outside any fill is refused, and the vault, the lien and the
    ///         Diamond are untouched. Straddle: the LOP's fill of the same order clears.
    /// @dev    Kills: the pre-hook's caller check dropped (anyone could pull a lot out of a vault into
    ///         the Diamond outside a fill, where it would rest unattributed).
    function test_I16_aStrayPreHook_isRefused_andMovesNothing() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        IOrderMixin.Order memory order = _order(r);
        bytes32 orderHash = lopFill.hashOrder(order);
        address vault = _vaultOf(loanId);
        uint256 vaultBefore = IERC20(weth).balanceOf(vault);
        uint256 diamondBefore = IERC20(weth).balanceOf(address(diamond));
        uint256 lienBefore = _lien(loanId);
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(LibSwapToRepayIntentSettlement.IntentPreInteractionUnauthorized.selector, stranger)
        );
        IntentDispatchFacet(address(diamond)).preInteraction(
            order, r.extension, orderHash, stranger, r.makerAmount, r.takerAmount, r.makerAmount, ""
        );

        assertEq(IERC20(weth).balanceOf(vault), vaultBefore, "the vault is untouched");
        assertEq(IERC20(weth).balanceOf(address(diamond)), diamondBefore, "the Diamond is untouched");
        assertEq(_lien(loanId), lienBefore, "the lien is untouched");
        _fill(r, "");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "straddle: the LOP's fill clears");
    }

    /// @notice I17. Mid-fill the Diamond's entry point admits the `postInteraction` selector from any
    ///         caller (the LOP's own post-hook must get through), so the post-hook's caller check is
    ///         what refuses a third party calling it with the order's hash. Refused -- which also
    ///         restores the lock -- and the LOP's own post-hook then settles.
    /// @dev    Kills: the post-hook's caller check dropped (the stray call would then fail later, on
    ///         the delivered amount, so the cell pins the exact selector).
    function test_I17_aStrayPostHookMidFill_isRefused() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        IOrderMixin.Order memory order = _order(r);
        bytes32 orderHash = lopFill.hashOrder(order);
        takerHook.arm(
            address(diamond),
            address(0),
            abi.encodeCall(
                IntentDispatchFacet.postInteraction,
                (order, r.extension, orderHash, address(takerHook), r.makerAmount, r.takerAmount, r.makerAmount, bytes(""))
            )
        );

        _fill(r, abi.encodePacked(address(takerHook)));

        assertEq(takerHook.calls(), 1, "fixture-live: the stray post-hook was attempted mid-fill");
        assertEq(
            takerHook.lastRevertSelector(),
            LibSwapToRepayIntentSettlement.IntentPostInteractionUnauthorized.selector,
            "refused by the post-hook's caller check"
        );
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the LOP's own post-hook settled");
    }

    // ============================================================================================
    //  I14 / I15 -- the teardown's bit check, and pause
    // ============================================================================================

    /// @notice I14. While a commit is recorded, a set nonce bit at the LOP (filled, or cancelled
    ///         there) makes the teardown refuse with `IntentAlreadyFilled`. Straddle: from the same
    ///         state with the bit clear, the cancel succeeds.
    /// @dev    Kills: the dead remaining-amount read kept (it is 0 for a bit-invalidator order).
    function test_I14_aSetNonceBit_makesTheTeardownRefuse() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        address borrower = LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        vm.warp(r.deadline + 1);
        uint256 snap = vm.snapshotState();
        vm.prank(borrower);
        SwapToRepayIntentFacet(address(diamond)).cancelSwapToRepayIntent(loanId);
        vm.revertToState(snap);

        bytes32 orderHash = lopFill.hashOrder(_order(r)); // before the prank: a call in the arguments would consume it
        vm.prank(address(diamond));
        lopFill.cancelOrder(MakerTraits.wrap(r.makerTraits), orderHash);
        assertTrue(_bitSet((r.makerTraits >> NONCE_SHIFT) & NONCE_MASK), "fixture-live: the bit is set");
        assertEq(lopFill.rawRemainingInvalidatorForOrder(address(diamond), orderHash), 0, "and raw remaining is 0");
        vm.prank(borrower);
        vm.expectRevert(SwapToRepayIntentFacet.IntentAlreadyFilled.selector);
        SwapToRepayIntentFacet(address(diamond)).cancelSwapToRepayIntent(loanId);
    }

    /// @notice I15 (owner decision O6). A pause stops fills: the pre-hook refuses while paused, and
    ///         the same fill clears after the unpause.
    function test_I15_aPause_stopsFills() public {
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        AdminFacet(address(diamond)).pause();
        _fund(r.takerAmount);
        vm.prank(taker);
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        lopFill.fillContractOrderParsed(_order(r), "", r.makerAmount, taker, r.extension, "");

        AdminFacet(address(diamond)).unpause();
        vm.prank(taker);
        lopFill.fillContractOrderParsed(_order(r), "", r.makerAmount, taker, r.extension, "");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "straddle: unpaused, it fills");
    }

    // ============================================================================================
    //  Helpers
    // ============================================================================================

    /// @dev A WETH-collateral forward loan opened through the harness (the real lender offer and the
    ///      borrower's signed accept), committed here at the preview's minimum ask plus 10%, so a fill
    ///      inside the auction clears the post-hook's live floor. WETH is the token whose transfer hook
    ///      the cells arm.
    function _commitWeth() internal returns (uint256 loanId) {
        loanId = _openWeth(++_seed);
        _commitOn(loanId);
    }

    /// @dev Opens a forward WETH-collateral loan and returns its id.
    function _openWeth(uint256 seed) internal returns (uint256 id) {
        id = _openKind(seed, 0);
        assertEq(handler.collateralOf(id), weth, "fixture-live: WETH collateral");
    }

    /// @dev Opens a loan of the harness kind `kind` (0 forward WETH, 1 forward VPFI, 2 reverse: WETH
    ///      principal, USDC collateral) through the real offer and accept, and returns its id.
    function _openKind(uint256 seed, uint8 kind) internal returns (uint256 id) {
        uint256 before = handler.loanIds().length;
        handler.openLoan(seed, 1_000e18 + (seed % 7) * 100e18, kind);
        uint256[] memory ids = handler.loanIds();
        assertEq(ids.length, before + 1, string.concat("fixture-live: a loan opened; ", _why()));
        id = ids[ids.length - 1];
        assertEq(uint8(_status(id)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the loan is Active");
    }

    /// @dev The whole fill as the taker: fund exactly the taking amount, then fill through the LOP.
    function _fill(SwapToRepayIntentFacet.FusionOrderRead memory r, bytes memory interaction) internal {
        _fund(r.takerAmount);
        vm.prank(taker);
        lopFill.fillContractOrderParsed(_order(r), "", r.makerAmount, taker, r.extension, interaction);
    }

    function _vaultOf(uint256 loanId) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower
        );
    }

    function _lien(uint256 loanId) internal view returns (uint256) {
        return MetricsFacet(address(diamond)).getLoanCollateralLien(loanId).amount;
    }

    /// @dev Pins a loan's HF and LTV (the harness's global mocks stay in place for every other loan).
    function _setRisk(uint256 loanId, uint256 hf, uint256 ltv) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(hf));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId), abi.encode(ltv));
    }

    /// @dev One leg through the harness's paying venue.
    function _workingRoute() internal view returns (LibSwap.AdapterCall[] memory route) {
        route = new LibSwap.AdapterCall[](1);
        route[0] = LibSwap.AdapterCall({adapterIdx: workingAdapterIdx, data: bytes("")});
    }

    /// @dev Commits `loanId` as its borrower would, with this suite's own nonce range (the
    ///      handler's starts at 1), and returns the Diamond's read-back of the order.
    function _commitOn(uint256 loanId) internal returns (SwapToRepayIntentFacet.FusionOrderRead memory) {
        SwapToRepayIntentFacet f = SwapToRepayIntentFacet(address(diamond));
        (, uint256 minTaker) = f.previewSwapToRepayIntentLot(loanId);
        bytes memory extension = f.canonicalExtension();
        uint64 deadline = uint64(block.timestamp + AUCTION_SECONDS);
        uint256 nonce = _nextNonce++;
        SwapToRepayIntentFacet.FusionOrderParams memory params = SwapToRepayIntentFacet.FusionOrderParams({
            takerAmount: minTaker + minTaker / 10 + 1,
            deadline: deadline,
            salt: (uint256(keccak256(abi.encode(loanId, nonce))) << 160) | uint256(uint160(uint256(keccak256(extension)))),
            makerTraits: TRAIT_FLAGS | (uint256(deadline) << 80) | (nonce << NONCE_SHIFT),
            extension: extension
        });
        vm.prank(LoanFacet(address(diamond)).getLoanDetails(loanId).borrower);
        f.commitSwapToRepayIntent(loanId, params);
        return _read(loanId);
    }

    /// @dev A second Active forward loan with its borrower funded to repay it.
    function _otherActiveLoan() internal returns (uint256 id, address borrower) {
        id = _openWeth(++_seed);
        borrower = LoanFacet(address(diamond)).getLoanDetails(id).borrower;
        ERC20Mock(usdc).mint(borrower, 10_000e18);
    }

    function _why() internal view returns (string memory) {
        return string.concat(
            "last handler revert at ", vm.toString(handler.lastRevertKey()), ": ", vm.toString(handler.lastRevertData())
        );
    }

    function _read(uint256 loanId) internal view returns (SwapToRepayIntentFacet.FusionOrderRead memory) {
        return SwapToRepayIntentFacet(address(diamond)).getIntentCommit(loanId);
    }

    /// @dev Rebuilds the order from the Diamond's own read-back, as a resolver does.
    function _order(SwapToRepayIntentFacet.FusionOrderRead memory r)
        internal
        pure
        returns (IOrderMixin.Order memory)
    {
        return IOrderMixin.Order({
            salt: r.salt,
            maker: LopAddress.wrap(uint256(uint160(r.maker))),
            receiver: LopAddress.wrap(uint256(uint160(r.receiver))),
            makerAsset: LopAddress.wrap(uint256(uint160(r.makerAsset))),
            takerAsset: LopAddress.wrap(uint256(uint160(r.takerAsset))),
            makingAmount: r.makerAmount,
            takingAmount: r.takerAmount,
            makerTraits: MakerTraits.wrap(r.makerTraits)
        });
    }

    function _fund(uint256 amount) internal {
        ERC20Mock(usdc).mint(taker, amount);
    }

    function _bitSet(uint256 nonce) internal view returns (bool) {
        return lopFill.bitInvalidatorForOrder(address(diamond), nonce) & (1 << (nonce & 0xff)) != 0;
    }

    function _status(uint256 loanId) internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId).status;
    }
}

/// @dev The read surface of the deployed 1inch LOP v4 the fork cell compares against. It exposes its
///      EIP-712 domain through ERC-5267 `eip712Domain()` only -- there is no `DOMAIN_SEPARATOR()` on the
///      Aggregation Router v6 build (the standalone `LimitOrderProtocol` build has both).
interface ILopV4Read {
    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory);
    function hashOrder(IOrderMixin.Order calldata order) external view returns (bytes32);
    function bitInvalidatorForOrder(address maker, uint256 slot) external view returns (uint256);
    function rawRemainingInvalidatorForOrder(address maker, bytes32 orderHash) external view returns (uint256);
    function cancelOrder(MakerTraits makerTraits, bytes32 orderHash) external;
}

/**
 * @title  SwapToRepayIntentFillForkTest
 * @notice I0f: {MockLopFill} agrees with the DEPLOYED 1inch LOP v4 on the two things slice 3 relies
 *         on and the mock otherwise only restates -- the order hash (the order's struct hash under the
 *         EIP-712 derivation; the Diamond commits to it and signs for it) and the bit invalidator (one
 *         cancel sets exactly that nonce's bit and never the remaining-amount slot, which is what S3b's
 *         teardown check reads).
 * @dev    It also pins how the deployed LOP declares its domain: the v4 LOP on mainnet lives inside the
 *         1inch Aggregation Router v6 at 0x1111...2A65, whose EIP-712 domain is the router's
 *         ("1inch Aggregation Router", "6") and which exposes it through ERC-5267 `eip712Domain()`
 *         only -- it answers no `DOMAIN_SEPARATOR()`. (Found by this cell; the Diamond's commits read
 *         the domain through `eip712Domain()` from the following commit on.)
 *         Gated on `FORK_URL_MAINNET`: skipped when it is unset, and kept beside the cells it vouches
 *         for rather than under `test/fork`. A full Diamond fill through the real LOP is NOT run: the
 *         pinned LOP is 0.8.23 and the harness's Diamond would have to run on a chain-1 fork.
 */
contract SwapToRepayIntentFillForkTest is Test {
    address internal constant LOP_V4 = 0x111111125421cA6dc452d289314280a0f8842A65;
    bytes32 internal constant LIMIT_ORDER_TYPEHASH = keccak256(
        "Order(uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,"
        "uint256 makingAmount,uint256 takingAmount,uint256 makerTraits)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev The swap-to-repay commit's flag set (no partial fills, pre- and post-interaction, has
    ///      extension), as the custody handler commits with.
    uint256 internal constant TRAIT_FLAGS = (1 << 255) | (1 << 252) | (1 << 251) | (1 << 249);

    bool internal forked;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_MAINNET", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
    }

    function test_I0f_mockAgreesWithTheDeployedLopV4_onTheHashAndTheBitInvalidator() public {
        if (!forked) vm.skip(true);
        assertGt(LOP_V4.code.length, 0, "fixture-live: LOP v4 is deployed at the pinned address");
        MockLopFill mock = new MockLopFill(address(0));
        ILopV4Read real = ILopV4Read(LOP_V4);

        address maker = makeAddr("forkMaker");
        uint256 nonce = 0x1234_5678;
        IOrderMixin.Order memory order = IOrderMixin.Order({
            salt: uint256(keccak256("i0f-salt")),
            maker: LopAddress.wrap(uint256(uint160(maker))),
            receiver: LopAddress.wrap(uint256(uint160(maker))),
            makerAsset: LopAddress.wrap(uint256(uint160(makeAddr("makerAsset")))),
            takerAsset: LopAddress.wrap(uint256(uint160(makeAddr("takerAsset")))),
            makingAmount: 7e18,
            takingAmount: 11e18,
            makerTraits: MakerTraits.wrap(TRAIT_FLAGS | (uint256(block.timestamp + 600) << 80) | (nonce << 120))
        });
        bytes32 structHash = keccak256(
            abi.encode(
                LIMIT_ORDER_TYPEHASH,
                order.salt,
                LopAddress.unwrap(order.maker),
                LopAddress.unwrap(order.receiver),
                LopAddress.unwrap(order.makerAsset),
                LopAddress.unwrap(order.takerAsset),
                order.makingAmount,
                order.takingAmount,
                MakerTraits.unwrap(order.makerTraits)
            )
        );

        // The domain. The deployed LOP v4 lives inside the 1inch Aggregation Router v6: its EIP-712
        // domain is the ROUTER's ("1inch Aggregation Router", "6"), not the standalone build's
        // ("1inch Limit Order Protocol", "4", which the mock restates), and it answers no
        // `DOMAIN_SEPARATOR()`. What the mock must share with it is the derivation and the order's
        // struct hash, which is what slice 3 hashes and signs for.
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying, bytes32 salt,
            uint256[] memory extensions) = real.eip712Domain();
        assertEq(fields, bytes1(0x0f), "a four-field domain: name, version, chain id, verifying contract");
        assertEq(salt, bytes32(0), "no salt");
        assertEq(extensions.length, 0, "no extensions");
        assertEq(keccak256(bytes(name)), keccak256("1inch Aggregation Router"), "the router's name");
        assertEq(keccak256(bytes(version)), keccak256("6"), "the router's version");
        assertEq(chainId, block.chainid, "this chain");
        assertEq(verifying, LOP_V4, "the router itself");
        (bool hasLegacyGetter,) = LOP_V4.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        assertFalse(hasLegacyGetter, "the deployed router answers no DOMAIN_SEPARATOR()");
        bytes32 realDomain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifying)
        );
        assertEq(
            real.hashOrder(order),
            keccak256(abi.encodePacked(bytes2(0x1901), realDomain, structHash)),
            "the deployed order hash: the EIP-712 derivation over that domain and the struct hash"
        );
        assertEq(
            mock.hashOrder(order),
            keccak256(abi.encodePacked(bytes2(0x1901), mock.DOMAIN_SEPARATOR(), structHash)),
            "the mock's order hash: the same struct hash"
        );

        // The bit invalidator: a cancel sets exactly that nonce's bit, never a neighbour's, and never
        // the remaining-amount slot. Straddle: clear before.
        uint256 bit = 1 << (nonce & 0xff);
        assertEq(real.bitInvalidatorForOrder(maker, nonce) & bit, 0, "straddle: clear before the cancel");
        // Each hash is computed BEFORE its prank: an external call in the argument list would consume
        // the prank, and the cancel would then run as this contract instead of the maker.
        bytes32 realHash = real.hashOrder(order);
        bytes32 mockHash = mock.hashOrder(order);
        vm.prank(maker);
        real.cancelOrder(order.makerTraits, realHash);
        vm.prank(maker);
        mock.cancelOrder(order.makerTraits, mockHash);
        uint256 realSlot = real.bitInvalidatorForOrder(maker, nonce);
        assertEq(realSlot, bit, "the deployed cancel set exactly that bit");
        assertEq(mock.bitInvalidatorForOrder(maker, nonce), realSlot, "the mock sets the same slot");
        assertEq(real.rawRemainingInvalidatorForOrder(maker, realHash), 0, "deployed raw remaining 0");
        assertEq(mock.rawRemainingInvalidatorForOrder(maker, mockHash), 0, "mock raw remaining 0");
    }

    /// @notice I0g: the Diamond reads the deployed LOP's domain the way the deployed LOP declares it
    ///         ({LibLopDomain}: ERC-5267 `eip712Domain()`), so the order the Diamond hashes and signs
    ///         for is the order the deployed LOP hashes: `hashOrder` over the same struct hash under
    ///         the separator the library derives. Before this read, a commit against the deployed
    ///         router reverted outright on its missing `DOMAIN_SEPARATOR()`.
    function test_I0g_theDiamondsDomainRead_matchesTheDeployedLop() public {
        if (!forked) vm.skip(true);
        ILopV4Read real = ILopV4Read(LOP_V4);
        IOrderMixin.Order memory order = IOrderMixin.Order({
            salt: uint256(keccak256("i0g-salt")),
            maker: LopAddress.wrap(uint256(uint160(address(this)))),
            receiver: LopAddress.wrap(uint256(uint160(address(this)))),
            makerAsset: LopAddress.wrap(uint256(uint160(makeAddr("makerAsset")))),
            takerAsset: LopAddress.wrap(uint256(uint160(makeAddr("takerAsset")))),
            makingAmount: 3e18,
            takingAmount: 5e18,
            makerTraits: MakerTraits.wrap(TRAIT_FLAGS | (uint256(block.timestamp + 600) << 80) | (uint256(77) << 120))
        });
        bytes32 structHash = keccak256(
            abi.encode(
                LIMIT_ORDER_TYPEHASH,
                order.salt,
                LopAddress.unwrap(order.maker),
                LopAddress.unwrap(order.receiver),
                LopAddress.unwrap(order.makerAsset),
                LopAddress.unwrap(order.takerAsset),
                order.makingAmount,
                order.takingAmount,
                MakerTraits.unwrap(order.makerTraits)
            )
        );
        assertEq(
            keccak256(abi.encodePacked(bytes2(0x1901), LibLopDomain.separator(LOP_V4), structHash)),
            real.hashOrder(order),
            "the Diamond's domain read reproduces the deployed LOP's order hash"
        );
    }
}
