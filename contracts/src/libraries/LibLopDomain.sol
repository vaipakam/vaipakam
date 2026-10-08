// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibLopDomain
 * @notice The EIP-712 domain separator of a 1inch Limit Order Protocol instance, read the way the
 *         deployed protocol declares it: through ERC-5267 `eip712Domain()`.
 *
 * @dev    Why not `DOMAIN_SEPARATOR()`. The v4 LOP on mainnet is the one inside the 1inch Aggregation
 *         Router v6 (0x111111125421cA6dc452d289314280a0f8842A65); its domain is the router's
 *         ("1inch Aggregation Router", "6"), and it exposes that domain through `eip712Domain()` only.
 *         It answers no `DOMAIN_SEPARATOR()` -- that getter exists on the standalone
 *         `LimitOrderProtocol` build alone. Both builds inherit OpenZeppelin's EIP712 and so both
 *         answer `eip712Domain()`, which makes it the one read that works against either. A commit
 *         that fetched `DOMAIN_SEPARATOR()` reverted against the deployed router, before signing
 *         anything (found by the slice-3 fork cell, `SwapToRepayIntentFillTest` I0f).
 *
 *         The Diamond signs for an order whose hash it computes itself, so the separator must be the
 *         protocol's own. Only the plain four-field domain -- name, version, chain id, verifying
 *         contract; no salt, no extensions -- naming THIS chain and the LOP itself is accepted:
 *         anything else would derive a separator the protocol does not use, and a hash the protocol
 *         would never present. The derivation is OpenZeppelin EIP712's `_buildDomainSeparator`.
 */
library LibLopDomain {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev ERC-5267 field bits: name, version, chainId, verifyingContract.
    bytes1 private constant FOUR_FIELD_DOMAIN = 0x0f;

    /// @notice `lop` did not declare a plain four-field EIP-712 domain for this chain and itself.
    error LopDomainUnsupported(address lop);

    /// @dev The separator `lop` hashes orders under. Reverts {LopDomainUnsupported} when `lop` does not
    ///      answer `eip712Domain()` or declares any other shape.
    function separator(address lop) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = lop.staticcall(abi.encodeWithSignature("eip712Domain()"));
        if (!ok || ret.length < 7 * 32) revert LopDomainUnsupported(lop);
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = abi.decode(ret, (bytes1, string, string, uint256, address, bytes32, uint256[]));
        if (
            fields != FOUR_FIELD_DOMAIN || salt != bytes32(0) || extensions.length != 0
                || chainId != block.chainid || verifyingContract != lop
        ) revert LopDomainUnsupported(lop);
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
    }
}
