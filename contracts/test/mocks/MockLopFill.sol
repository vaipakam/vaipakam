// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {IPreInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/IPreInteraction.sol";
import {IPostInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/IPostInteraction.sol";
import {ITakerInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/ITakerInteraction.sol";
import {ExtensionLib} from "@1inch/limit-order-protocol/contracts/libraries/ExtensionLib.sol";
import {MakerTraits, MakerTraitsLib} from "@1inch/limit-order-protocol/contracts/libraries/MakerTraitsLib.sol";
import {Address as LopAddress, AddressLib} from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";

/// @dev The three WETH entry points the LOP's native-value branches use.
interface IWethLike {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title  MockLopFill
 * @notice A faithful stand-in for the 1inch Limit Order Protocol v4 CONTRACT-MAKER fill
 *         (`fillContractOrderArgs` -> `_fillContractOrder` -> `_fill`), so a test drives a Vaipakam
 *         swap-to-repay or buyback order through the same external calls the real protocol makes, in
 *         the same order, inside ONE transaction.
 *
 * @dev    Why a mock and not the real protocol: the pinned LOP is `pragma solidity 0.8.23` and does
 *         not compile into this 0.8.29 project. Why not the existing pranked-hook harness
 *         (`SwapToRepayIntentFacetTest` pranks `preInteraction` and `postInteraction` as two separate
 *         top-level calls): it cannot observe what happens BETWEEN the hooks -- the maker-to-taker
 *         transfer, the taker interaction and the taker-to-maker transfer -- which is exactly the
 *         window #1566 slice 3's fill-state lock must cover (design: "it must reenter during the LOP
 *         transfer"), and the swap pre-hook's balance baseline lives in TRANSIENT storage, which only
 *         spans one transaction.
 *
 *         Reproduced in order from `OrderMixin._fill` (OrderMixin.sol:334-437): extension validation,
 *         allowed-sender, expiry, epoch check, the partial-fill check, the invalidation (BEFORE the
 *         pre-hook), the maker pre-interaction, the maker-to-taker `transferFrom`, the taker
 *         interaction, the taker-to-maker transfer, the maker post-interaction, then `OrderFilled`.
 *         The native-value paths follow the real contract-maker entry: `fillContractOrder` is NOT
 *         payable, so the taker-side WETH branch and its refund send (reachable only through
 *         `fillOrder`, which needs an EOA maker's signature) never run for a Vaipakam order; the one
 *         native path such an order can meet is the maker-side unwrap a taker asks for
 *         (`takerTraits.unwrapWeth`), modelled by {fillContractOrderParsedUnwrap}: the lot goes to
 *         the LOP, is unwrapped, and is paid to the taker's target in native ETH. The contract-maker signature
 *         is checked through ERC-1271 BEFORE `_fill`, as the real `_fillContractOrder` does, so it is
 *         outside the fill window.
 *
 *         Invalidators are kept exactly as the LOP keeps them: a bit-invalidator order (every
 *         Vaipakam order: no partial fills) sets its nonce bit and NEVER writes the remaining-amount
 *         slot, so `rawRemainingInvalidatorForOrder` stays 0 for it whether filled or cancelled; read
 *         `bitInvalidatorForOrder` (which shifts the nonce itself, as `checkSlot` does) to see a fill.
 *
 *         Deliberate narrowings, each refused with {MockLopUnsupported} rather than silently skipped:
 *         predicates, amount getters, asset suffixes, permit2 and the epoch manager -- the Diamond's
 *         commit gate forbids all of them for its own orders. The taker's `TakerTraits`/`args`
 *         packing is replaced by explicit `target`/`extension`/`interaction` parameters, in the LOP's
 *         making-amount mode with no threshold; the maker-side WETH unwrap (a taker-trait option) is
 *         therefore not modelled.
 *
 *         {steps} records the call order of the last fill, so a fidelity cell can assert it.
 */
contract MockLopFill {
    using AddressLib for LopAddress;
    using ExtensionLib for bytes;
    using MakerTraitsLib for MakerTraits;

    error InvalidatedOrder();
    error BadSignature();
    error PrivateOrder();
    error OrderExpired();
    error EpochManagerAndBitInvalidatorsAreIncompatible();
    error PartialFillNotAllowed();
    error SwapWithZeroAmount();
    error BitInvalidatedOrder();
    error MissingOrderExtension();
    error InvalidExtensionHash();
    error UnexpectedOrderExtension();
    error TransferFromMakerToTakerFailed();
    error TransferFromTakerToMakerFailed();
    error InvalidMsgValue();
    error ETHTransferFailed();
    error SafeTransferFailed();
    error NotWeth(address sender);
    error MockLopUnsupported(bytes32 feature);

    event OrderFilled(bytes32 orderHash, uint256 remainingAmount);
    event OrderCancelled(bytes32 orderHash);
    event BitInvalidatorUpdated(address indexed maker, uint256 slotIndex, uint256 slotValue);

    bytes32 public constant STEP_INVALIDATE = "INVALIDATE";
    bytes32 public constant STEP_PRE_INTERACTION = "PRE_INTERACTION";
    bytes32 public constant STEP_MAKER_TO_TAKER = "MAKER_TO_TAKER";
    bytes32 public constant STEP_TAKER_INTERACTION = "TAKER_INTERACTION";
    bytes32 public constant STEP_TAKER_TO_MAKER = "TAKER_TO_MAKER";
    bytes32 public constant STEP_POST_INTERACTION = "POST_INTERACTION";

    /// @dev `OrderLib._LIMIT_ORDER_TYPEHASH`, restated (OrderLib is 0.8.23-pinned).
    bytes32 private constant _LIMIT_ORDER_TYPEHASH = keccak256(
        "Order("
            "uint256 salt,"
            "address maker,"
            "address receiver,"
            "address makerAsset,"
            "address takerAsset,"
            "uint256 makingAmount,"
            "uint256 takingAmount,"
            "uint256 makerTraits"
        ")"
    );
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev `LimitOrderProtocol`'s `EIP712("1inch Limit Order Protocol", "4")`.
    bytes32 private constant _NAME_HASH = keccak256("1inch Limit Order Protocol");
    bytes32 private constant _VERSION_HASH = keccak256("4");

    /// @notice The WETH the native-value branches wrap and unwrap; `address(0)` disables them.
    address public immutable weth;

    mapping(address maker => mapping(uint256 slot => uint256 bits)) private _bitInvalidator;
    mapping(address maker => mapping(bytes32 orderHash => uint256 raw)) private _remainingInvalidator;
    bytes32[] private _steps;
    /// @dev The taker's `unwrapWeth` trait for the fill in progress (set by the entry, cleared after).
    bool private _unwrapMaker;

    constructor(address weth_) {
        weth = weth_;
    }

    /// @dev `OnlyWethReceiver`: native value arrives only from a WETH unwrap.
    receive() external payable {
        if (msg.sender != weth) revert NotWeth(msg.sender);
    }

    // --- views the Diamond and the tests read ------------------------------------------------

    /// @notice The EIP-712 domain separator the Diamond fetches at commit to hash its order.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice ERC-5267: the domain {DOMAIN_SEPARATOR} hashes, field by field -- what the Diamond reads
    ///         (`LibLopDomain`, #2449). The standalone `LimitOrderProtocol` build's domain; the deployed
    ///         v4 LOP inside the Aggregation Router v6 declares the router's instead, and the fork cells
    ///         (`SwapToRepayIntentFillForkTest`) pin that the derivation is the same.
    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        return (0x0f, "1inch Limit Order Protocol", "4", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    /// @notice `OrderLib.hash`: the EIP-712 hash over the raw eight order words.
    function hashOrder(IOrderMixin.Order calldata order) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _LIMIT_ORDER_TYPEHASH,
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
        return keccak256(abi.encodePacked(bytes2(0x1901), DOMAIN_SEPARATOR(), structHash));
    }

    /// @notice `OrderMixin.bitInvalidatorForOrder`: the 256-bit slot holding `slot`'s nonce bit.
    function bitInvalidatorForOrder(address maker, uint256 slot) external view returns (uint256) {
        return _bitInvalidator[maker][slot >> 8];
    }

    /// @notice `OrderMixin.rawRemainingInvalidatorForOrder`: written only for remaining-amount orders.
    function rawRemainingInvalidatorForOrder(address maker, bytes32 orderHash) external view returns (uint256) {
        return _remainingInvalidator[maker][orderHash];
    }

    /// @notice The call order of the last fill (see the `STEP_*` constants).
    function steps() external view returns (bytes32[] memory) {
        return _steps;
    }

    // --- maker cancel ------------------------------------------------------------------------

    /// @notice `OrderMixin.cancelOrder`: a bit order invalidates its nonce bit, a remaining-amount
    ///         order is marked fully filled.
    function cancelOrder(MakerTraits makerTraits, bytes32 orderHash) external {
        if (makerTraits.useBitInvalidator()) {
            uint256 nonce = makerTraits.nonceOrEpoch();
            uint256 result = _massInvalidate(msg.sender, nonce, 0);
            emit BitInvalidatorUpdated(msg.sender, nonce >> 8, result);
        } else {
            _remainingInvalidator[msg.sender][orderHash] = type(uint256).max;
            emit OrderCancelled(orderHash);
        }
    }

    // --- the fill ----------------------------------------------------------------------------

    /// @notice A contract-maker fill with the taker's `args` already parsed: `target` receives the
    ///         making amount (zero means `msg.sender`, as `_parseArgs` defaults), `extension` is the
    ///         order's extension, `interaction` the taker interaction (target in its first 20 bytes).
    ///         Making-amount mode, no threshold.
    function fillContractOrderParsed(
        IOrderMixin.Order calldata order,
        bytes calldata signature,
        uint256 amount,
        address target,
        bytes calldata extension,
        bytes calldata interaction
    ) external returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash) {
        return _fillContractOrder(order, signature, amount, target, extension, interaction, false);
    }

    /// @notice {fillContractOrderParsed} with the taker's `unwrapWeth` trait set: a WETH lot is sent to
    ///         this contract, unwrapped, and paid to `target` in native ETH (OrderMixin's
    ///         `needUnwrap` maker-to-taker branch, `_WETH.safeWithdrawTo`).
    function fillContractOrderParsedUnwrap(
        IOrderMixin.Order calldata order,
        bytes calldata signature,
        uint256 amount,
        address target,
        bytes calldata extension,
        bytes calldata interaction
    ) external returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash) {
        return _fillContractOrder(order, signature, amount, target, extension, interaction, true);
    }

    function _fillContractOrder(
        IOrderMixin.Order calldata order,
        bytes calldata signature,
        uint256 amount,
        address target,
        bytes calldata extension,
        bytes calldata interaction,
        bool unwrapWeth
    ) private returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash) {
        delete _steps;
        _unwrapMaker = unwrapWeth;
        orderHash = hashOrder(order);
        uint256 remainingMakingAmount = _checkRemainingMakingAmount(order, orderHash);
        if (remainingMakingAmount == order.makingAmount) {
            if (!_isValidContractSignature(order.maker.get(), orderHash, signature)) revert BadSignature();
        }
        if (target == address(0)) target = msg.sender;
        (makingAmount, takingAmount) =
            _fill(order, orderHash, remainingMakingAmount, amount, target, extension, interaction);
        _unwrapMaker = false;
    }

    function _fill(
        IOrderMixin.Order calldata order,
        bytes32 orderHash,
        uint256 remainingMakingAmount,
        uint256 amount,
        address target,
        bytes calldata extension,
        bytes calldata interaction
    ) private returns (uint256 makingAmount, uint256 takingAmount) {
        _validateOrder(order, extension);

        makingAmount = amount < remainingMakingAmount ? amount : remainingMakingAmount;
        takingAmount = _linearTakingAmount(order.makingAmount, order.takingAmount, makingAmount);
        if (!order.makerTraits.allowPartialFills() && makingAmount != order.makingAmount) {
            revert PartialFillNotAllowed();
        }
        unchecked {
            if (makingAmount * takingAmount == 0) revert SwapWithZeroAmount();
        }

        // The invalidation lands BEFORE the pre-hook, as in the LOP: a fill that reenters itself
        // finds its own nonce already spent.
        _invalidate(order, orderHash, remainingMakingAmount, makingAmount);

        if (order.makerTraits.needPreInteractionCall()) {
            _preInteraction(order, extension, orderHash, makingAmount, takingAmount, remainingMakingAmount);
        }

        _step(STEP_MAKER_TO_TAKER);
        {
            bool needUnwrap = _unwrapMaker && order.makerAsset.get() == weth;
            address receiver = needUnwrap ? address(this) : target;
            if (!_transferFrom(order.makerAsset.get(), order.maker.get(), receiver, makingAmount)) {
                revert TransferFromMakerToTakerFailed();
            }
            if (needUnwrap) {
                IWethLike(weth).withdraw(makingAmount);
                (bool sent,) = target.call{value: makingAmount}("");
                if (!sent) revert ETHTransferFailed();
            }
        }

        if (interaction.length > 19) {
            _step(STEP_TAKER_INTERACTION);
            ITakerInteraction(address(bytes20(interaction))).takerInteraction(
                order,
                extension,
                orderHash,
                msg.sender,
                makingAmount,
                takingAmount,
                remainingMakingAmount,
                interaction[20:]
            );
        }

        _takerToMaker(order, takingAmount);

        if (order.makerTraits.needPostInteractionCall()) {
            _postInteraction(order, extension, orderHash, makingAmount, takingAmount, remainingMakingAmount);
        }

        emit OrderFilled(orderHash, remainingMakingAmount - makingAmount);
    }

    function _validateOrder(IOrderMixin.Order calldata order, bytes calldata extension) private view {
        MakerTraits traits = order.makerTraits;
        if (traits.hasExtension()) {
            if (extension.length == 0) revert MissingOrderExtension();
            if ((uint256(keccak256(extension)) & type(uint160).max) != (order.salt & type(uint160).max)) {
                revert InvalidExtensionHash();
            }
        } else if (extension.length > 0) {
            revert UnexpectedOrderExtension();
        }
        if (!traits.isAllowedSender(msg.sender)) revert PrivateOrder();
        if (traits.isExpired()) revert OrderExpired();
        if (traits.needCheckEpochManager()) {
            if (traits.useBitInvalidator()) revert EpochManagerAndBitInvalidatorsAreIncompatible();
            revert MockLopUnsupported("epochManager");
        }
        if (extension.length > 0) {
            if (extension.predicate().length > 0) revert MockLopUnsupported("predicate");
            if (extension.makingAmountData().length > 0 || extension.takingAmountData().length > 0) {
                revert MockLopUnsupported("amountGetter");
            }
            if (extension.makerAssetSuffix().length > 0 || extension.takerAssetSuffix().length > 0) {
                revert MockLopUnsupported("assetSuffix");
            }
        }
        if (traits.usePermit2()) revert MockLopUnsupported("permit2");
    }

    /// @dev `_checkRemainingMakingAmount`: a bit order always has its full making amount left
    ///      (its spent state is the nonce bit, checked at invalidation).
    function _checkRemainingMakingAmount(IOrderMixin.Order calldata order, bytes32 orderHash)
        private
        view
        returns (uint256 remainingMakingAmount)
    {
        if (order.makerTraits.useBitInvalidator()) {
            remainingMakingAmount = order.makingAmount;
        } else {
            uint256 raw = _remainingInvalidator[order.maker.get()][orderHash];
            remainingMakingAmount = raw == 0 ? order.makingAmount : ~raw;
        }
        if (remainingMakingAmount == 0) revert InvalidatedOrder();
    }

    function _invalidate(
        IOrderMixin.Order calldata order,
        bytes32 orderHash,
        uint256 remainingMakingAmount,
        uint256 makingAmount
    ) private {
        address maker = order.maker.get();
        if (order.makerTraits.useBitInvalidator()) {
            uint256 nonce = order.makerTraits.nonceOrEpoch();
            uint256 slot = nonce >> 8;
            uint256 bit = 1 << (nonce & 0xff);
            uint256 bits = _bitInvalidator[maker][slot];
            if ((bits & bit) == bit) revert BitInvalidatedOrder();
            _bitInvalidator[maker][slot] = bits | bit;
        } else {
            unchecked {
                _remainingInvalidator[maker][orderHash] = ~(remainingMakingAmount - makingAmount);
            }
        }
        _step(STEP_INVALIDATE);
    }

    function _massInvalidate(address maker, uint256 nonce, uint256 additionalMask) private returns (uint256 result) {
        uint256 slot = nonce >> 8;
        result = _bitInvalidator[maker][slot] | (1 << (nonce & 0xff)) | additionalMask;
        _bitInvalidator[maker][slot] = result;
    }

    function _preInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 remainingMakingAmount
    ) private {
        _step(STEP_PRE_INTERACTION);
        bytes calldata data = extension.preInteractionTargetAndData();
        address listener = order.maker.get();
        if (data.length > 19) {
            listener = address(bytes20(data));
            data = data[20:];
        }
        IPreInteraction(listener).preInteraction(
            order, extension, orderHash, msg.sender, makingAmount, takingAmount, remainingMakingAmount, data
        );
    }

    function _postInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 remainingMakingAmount
    ) private {
        _step(STEP_POST_INTERACTION);
        bytes calldata data = extension.postInteractionTargetAndData();
        address listener = order.maker.get();
        if (data.length > 19) {
            listener = address(bytes20(data));
            data = data[20:];
        }
        IPostInteraction(listener).postInteraction(
            order, extension, orderHash, msg.sender, makingAmount, takingAmount, remainingMakingAmount, data
        );
    }

    /// @dev The taker-to-maker leg, both branches of the LOP's `msg.value` split.
    function _takerToMaker(IOrderMixin.Order calldata order, uint256 takingAmount) private {
        _step(STEP_TAKER_TO_MAKER);
        address takerAsset = order.takerAsset.get();
        address receiver = _receiverOf(order);
        if (takerAsset == weth && msg.value > 0) {
            if (msg.value < takingAmount) revert InvalidMsgValue();
            if (msg.value > takingAmount) {
                unchecked {
                    (bool refunded,) = msg.sender.call{value: msg.value - takingAmount}("");
                    if (!refunded) revert ETHTransferFailed();
                }
            }
            if (order.makerTraits.unwrapWeth()) {
                (bool sent,) = receiver.call{value: takingAmount}("");
                if (!sent) revert ETHTransferFailed();
            } else {
                IWethLike(weth).deposit{value: takingAmount}();
                if (!IWethLike(weth).transfer(receiver, takingAmount)) revert SafeTransferFailed();
            }
        } else {
            if (msg.value != 0) revert InvalidMsgValue();
            bool needUnwrap = takerAsset == weth && order.makerTraits.unwrapWeth();
            if (!_transferFrom(takerAsset, msg.sender, needUnwrap ? address(this) : receiver, takingAmount)) {
                revert TransferFromTakerToMakerFailed();
            }
            if (needUnwrap) {
                IWethLike(weth).withdraw(takingAmount);
                (bool sent,) = receiver.call{value: takingAmount}("");
                if (!sent) revert ETHTransferFailed();
            }
        }
    }

    /// @dev `_callTransferFromWithSuffix` with an empty suffix: success is a non-reverting call that
    ///      returned nothing, or returned a first word equal to 1.
    function _transferFrom(address asset, address from, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) =
            asset.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        return ok && (ret.length == 0 || (ret.length > 31 && abi.decode(ret, (uint256)) == 1));
    }

    /// @dev 1inch `ECDSA.isValidSignature(signer, hash, signature)` for a contract signer: the
    ///      return must be exactly one word equal to the ERC-1271 magic value.
    function _isValidContractSignature(address signer, bytes32 hash, bytes calldata signature)
        private
        view
        returns (bool)
    {
        (bool ok, bytes memory ret) =
            signer.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, hash, signature));
        return ok && ret.length == 32
            && abi.decode(ret, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    function _receiverOf(IOrderMixin.Order calldata order) private pure returns (address) {
        address receiver = order.receiver.get();
        return receiver != address(0) ? receiver : order.maker.get();
    }

    /// @dev `AmountCalculatorLib.getTakingAmount`: the linear proportion, rounded up.
    function _linearTakingAmount(uint256 orderMakerAmount, uint256 orderTakerAmount, uint256 swapMakerAmount)
        private
        pure
        returns (uint256)
    {
        return (swapMakerAmount * orderTakerAmount + orderMakerAmount - 1) / orderMakerAmount;
    }

    function _step(bytes32 s) private {
        _steps.push(s);
    }
}
