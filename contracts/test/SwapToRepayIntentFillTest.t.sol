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
 * @title  SwapToRepayIntentFillTest
 * @notice #1566 slice 3: a swap-to-repay intent driven through a WHOLE LOP fill in one transaction
 *         ({MockLopFill}), on the #2141 custody harness's production Diamond -- so a cell can see what
 *         happens BETWEEN the hooks, which the pranked-hook harness in `SwapToRepayIntentFacetTest`
 *         cannot.
 *
 * @dev    S3a (this commit) lands the cells that hold on TODAY's code, before slice 3 changes where
 *         the lot rests:
 *           - I0: the mock is faithful to the real fill order (invalidate before the pre-hook, the
 *             taker interaction between the two transfers) and leaves the remaining-amount slot 0;
 *           - I3: an underfunded taker reverts the whole fill and changes nothing, at a 1-wei
 *             straddle;
 *           - I4 / I5 TODAY: a re-entry into the Diamond during the fill -- from the collateral
 *             token's transfer callback, and from the taker interaction -- is ADMITTED. That is the
 *             gap slice 3's fill-state lock closes; S3b flips both cells to require
 *             `FillInProgress`, so these are the evidence that the flipped cells can fail.
 *         I0f, the fork cell against the DEPLOYED LOP v4, is {SwapToRepayIntentFillForkTest} below.
 *
 *         The collateral (WETH) and principal (USDC) tokens are {CallbackERC20}: its code is etched
 *         over the harness's ERC20Mock tokens, whose storage it extends append-only, so balances,
 *         approvals and the oracle wiring all carry over and only the transfer hook is added.
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
        vm.etch(weth, address(new CallbackERC20("MockCollateral", "MCK", 18)).code);
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
    //  I4 / I5 TODAY -- a re-entry during the fill is admitted (the gap the fill lock closes)
    // ============================================================================================

    /// @notice TODAY: while the LOP moves the lot from the Diamond to the taker, the collateral
    ///         token's callback repays ANOTHER loan through the Diamond, and the Diamond admits it --
    ///         no guard is held between the pre-hook and the post-hook. S3b's fill lock must refuse
    ///         this call with `FillInProgress`; this cell is the evidence the flipped cell can fail.
    function test_I4_today_reentryDuringTheMakerTransfer_isAdmitted() public {
        (uint256 other, address otherBorrower) = _otherActiveLoan();
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        CallbackERC20(weth).arm(
            address(diamond), taker, address(diamond), otherBorrower, abi.encodeCall(RepayFacet.repayLoan, (other))
        );

        _fund(r.takerAmount);
        vm.prank(taker);
        lopFill.fillContractOrderParsed(_order(r), "", r.makerAmount, taker, r.extension, "");

        assertEq(CallbackERC20(weth).callbacks(), 1, "fixture-live: the hook fired inside the maker transfer");
        assertTrue(CallbackERC20(weth).lastCallOk(), "TODAY: the re-entry is admitted");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Repaid), "TODAY: the other loan repaid mid-fill");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "and the fill itself completed");
    }

    /// @notice TODAY: the taker interaction (between the two transfers) repays another loan through
    ///         the Diamond, and the Diamond admits it. S3b flips this to `FillInProgress`.
    function test_I5_today_reentryFromTheTakerInteraction_isAdmitted() public {
        (uint256 other, address otherBorrower) = _otherActiveLoan();
        uint256 loanId = _commitWeth();
        SwapToRepayIntentFacet.FusionOrderRead memory r = _read(loanId);
        takerHook.arm(address(diamond), otherBorrower, abi.encodeCall(RepayFacet.repayLoan, (other)));

        _fund(r.takerAmount);
        vm.prank(taker);
        lopFill.fillContractOrderParsed(
            _order(r), "", r.makerAmount, taker, r.extension, abi.encodePacked(address(takerHook))
        );

        assertEq(takerHook.calls(), 1, "fixture-live: the taker interaction ran");
        assertTrue(takerHook.lastCallOk(), "TODAY: the re-entry is admitted");
        assertEq(uint8(_status(other)), uint8(LibVaipakam.LoanStatus.Repaid), "TODAY: the other loan repaid mid-fill");
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "and the fill itself completed");
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

    /// @dev Opens a forward WETH-collateral loan (`kindSeed` 0) and returns its id.
    function _openWeth(uint256 seed) internal returns (uint256 id) {
        uint256 before = handler.loanIds().length;
        handler.openLoan(seed, 1_000e18 + (seed % 7) * 100e18, 0);
        uint256[] memory ids = handler.loanIds();
        assertEq(ids.length, before + 1, string.concat("fixture-live: a loan opened; ", _why()));
        id = ids[ids.length - 1];
        assertEq(handler.collateralOf(id), weth, "fixture-live: WETH collateral");
        assertEq(uint8(_status(id)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the loan is Active");
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
