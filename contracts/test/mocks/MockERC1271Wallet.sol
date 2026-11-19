// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev A minimal contract wallet (a group or team account stand-in): it
///      answers ERC-1271 with the magic value when its owner key signed the
///      digest, and with a refusal otherwise.
contract MockERC1271Wallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && signer == owner ? MAGIC : bytes4(0xffffffff);
    }
}
