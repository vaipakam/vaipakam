// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {Address as LopAddress} from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import {MakerTraits} from "@1inch/limit-order-protocol/contracts/libraries/MakerTraitsLib.sol";

/**
 * @title  MockEip712Lop
 * @notice The EIP-712 domain surface of a 1inch LOP, for test stand-ins: ERC-5267 `eip712Domain()` (what
 *         the Diamond reads, `LibLopDomain`) and a `DOMAIN_SEPARATOR()` derived from the same fields
 *         (what the tests use to hash orders themselves), so the two can never disagree.
 * @dev    A stand-in names its own domain through {_lopName} / {_lopVersion}. The deployed v4 LOP
 *         (inside the Aggregation Router v6) answers only `eip712Domain()`; a stand-in may expose the
 *         derived getter as well, because nothing in `src/` reads it any more.
 */
abstract contract MockEip712Lop {
    bytes32 private constant _DOMAIN_TYPEHASH_ =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function _lopName() internal pure virtual returns (string memory);
    function _lopVersion() internal pure virtual returns (string memory);

    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        return (0x0f, _lopName(), _lopVersion(), block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function DOMAIN_SEPARATOR() public view virtual returns (bytes32) {
        return _domainSeparator();
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH_, keccak256(bytes(_lopName())), keccak256(bytes(_lopVersion())), block.chainid, address(this)
            )
        );
    }

    bytes32 private constant _ORDER_TYPEHASH_ = keccak256(
        "Order(uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits)"
    );

    /// @notice #3431 — `OrderLib.hash` under this stand-in's declared domain: the vault asks the
    ///         order protocol for the hash of the order it makes.
    function hashOrder(IOrderMixin.Order calldata order) public view virtual returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _ORDER_TYPEHASH_,
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
        return keccak256(abi.encodePacked(bytes2(0x1901), _domainSeparator(), structHash));
    }
}
