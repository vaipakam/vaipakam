// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/**
 * @title  ChainContracts
 * @notice The ONE walk over the contracts a chain's Diamond deploy reaches,
 *         for the scripts that must not miss one (#2743).
 *
 *         Two questions are asked of the same set. The storage-layout record
 *         keeps the EIP-1967 proxies among them (which code a refresh may
 *         change in place); the governance handover keeps the ones that
 *         answer `owner()` (which authority must move to the Timelock). Each
 *         used to carry its own list, and a list kept by hand is how the swap
 *         adapters stayed on the deploying key through the handover: nothing
 *         named them. So the candidates are found here, once, without a
 *         per-contract list, and each consumer only filters.
 *
 * @dev    The candidates, in this order (a repeat keeps its first source):
 *           1. the satellites the Diamond names (backstop vault, listing
 *              executor, reward reporter config, remittance and buyback
 *              receivers, cross-chain messenger, return sender and
 *              receiver), each read by its getter;
 *           2. the Diamond's registries of contracts it calls: every
 *              registered swap adapter and the active rate model;
 *           3. every address the chain's artifact names, outside `.facets`
 *              (the loupe is the authority on facets);
 *           4. the `messenger()` each EIP-1967 proxy among 1-3 trusts (one
 *              hop: every satellite names the one it calls through).
 *         A Diamond getter that does not exist (an older facet set) reads as
 *         no candidate, never as a revert. The Diamond itself is never a
 *         candidate unless the artifact names it (it does, as `diamond`);
 *         consumers that treat it separately drop it themselves.
 */
library ChainContracts {
    address private constant VM_ADDR = address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm private constant CHEATS = Vm(VM_ADDR);

    /// keccak256("eip1967.proxy.implementation") - 1.
    bytes32 internal constant EIP1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// Most candidates one walk holds.
    uint256 internal constant MAX_CANDIDATES = 512;

    /// One candidate and where the walk found it: the Diamond getter that
    /// returned it, or its path in the artifact (`.sanctionsList`).
    struct Found {
        address addr;
        string source;
    }

    /// Every candidate for `diamond`'s chain (see the contract notes).
    /// @param json The chain's artifact, or "" to walk the Diamond alone.
    function walk(address diamond, string memory json) internal view returns (Found[] memory found) {
        Found[] memory cand = new Found[](MAX_CANDIDATES);
        uint256 n;
        // 1. Satellites. Word indexes follow each getter's return tuple
        //    (`getRepatriationPosition` returns the sender and the receiver
        //    second and third).
        n = _push(cand, n, readWord(diamond, "getBackstopVault()", 0), "getBackstopVault()");
        n = _push(cand, n, readWord(diamond, "getCollateralListingExecutor()", 0), "getCollateralListingExecutor()");
        n = _push(cand, n, readWord(diamond, "getRewardReporterConfig()", 0), "getRewardReporterConfig()");
        n = _push(cand, n, readWord(diamond, "getRewardRemittanceReceiver()", 0), "getRewardRemittanceReceiver()");
        n = _push(cand, n, readWord(diamond, "getBuybackRemittanceReceiver()", 0), "getBuybackRemittanceReceiver()");
        n = _push(cand, n, readWord(diamond, "getCrossChainMessenger()", 0), "getCrossChainMessenger()");
        n = _push(cand, n, readWord(diamond, "getRepatriationPosition()", 1), "getRepatriationPosition().sender");
        n = _push(cand, n, readWord(diamond, "getRepatriationPosition()", 2), "getRepatriationPosition().receiver");
        // 2. Registries.
        address[] memory adapters = _readAddressArray(diamond, "getSwapAdapters()");
        for (uint256 i = 0; i < adapters.length; ++i) {
            n = _push(cand, n, adapters[i], string.concat("getSwapAdapters()[", CHEATS.toString(i), "]"));
        }
        n = _push(cand, n, readWord(diamond, "getRateModel()", 0), "getRateModel()");
        // 3. The artifact.
        if (bytes(json).length > 0) n = _collectArtifactAddresses(json, "$", cand, n);
        // 4. One messenger hop from every proxy found so far.
        uint256 direct = n;
        for (uint256 i = 0; i < direct; ++i) {
            if (implementationOf(cand[i].addr) != address(0)) {
                n = _push(
                    cand, n, readWord(cand[i].addr, "messenger()", 0), string.concat(cand[i].source, ".messenger()")
                );
            }
        }
        found = new Found[](n);
        for (uint256 i = 0; i < n; ++i) found[i] = cand[i];
    }

    /// The EIP-1967 implementation behind `a`, or zero when `a` has no code
    /// or is not such a proxy.
    function implementationOf(address a) internal view returns (address) {
        if (a.code.length == 0) return address(0);
        return address(uint160(uint256(CHEATS.load(a, EIP1967_IMPLEMENTATION_SLOT))));
    }

    /// Word `index` of `target.signature()`'s return data, as an address;
    /// zero when the call reverts, returns too little, or the word is not an
    /// address.
    function readWord(address target, string memory signature, uint256 index) internal view returns (address) {
        if (target.code.length == 0) return address(0);
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(signature));
        if (!ok || ret.length < 32 * (index + 1)) return address(0);
        uint256 word = _word(ret, index);
        if (word >> 160 != 0) return address(0);
        return address(uint160(word));
    }

    /// `target.signature()` decoded as `address[]`, or empty when the call
    /// reverts or returns something else.
    function _readAddressArray(address target, string memory signature) private view returns (address[] memory out) {
        if (target.code.length == 0) return out;
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(signature));
        if (!ok || ret.length < 64) return out;
        // A well-formed reply is (offset 0x20, length, words...); anything
        // else reads as no registry rather than reverting the walk.
        uint256 len = _word(ret, 1);
        if (_word(ret, 0) != 0x20 || len > MAX_CANDIDATES || ret.length != 64 + 32 * len) return out;
        address[] memory a = new address[](len);
        for (uint256 i = 0; i < len; ++i) {
            uint256 w = _word(ret, 2 + i);
            if (w >> 160 != 0) return out;
            a[i] = address(uint160(w));
        }
        out = a;
    }

    /// Word `index` of `data` (which holds at least `index + 1` words).
    function _word(bytes memory data, uint256 index) private pure returns (uint256) {
        bytes memory w = new bytes(32);
        for (uint256 i = 0; i < 32; ++i) w[i] = data[32 * index + i];
        return abi.decode(w, (uint256));
    }

    /// Walk `json` from `prefix`, pushing every string value that parses as
    /// an address. `.facets` is skipped: the loupe is the authority on facets.
    function _collectArtifactAddresses(string memory json, string memory prefix, Found[] memory cand, uint256 n)
        private
        view
        returns (uint256)
    {
        string[] memory keys;
        try CHEATS.parseJsonKeys(json, prefix) returns (string[] memory k) {
            keys = k;
        } catch {
            return n;
        }
        for (uint256 i = 0; i < keys.length; ++i) {
            string memory key = keccak256(bytes(prefix)) == keccak256("$")
                ? string.concat(".", keys[i])
                : string.concat(prefix, ".", keys[i]);
            if (keccak256(bytes(key)) == keccak256(".facets")) continue;
            try CHEATS.parseJsonAddress(json, key) returns (address a) {
                n = _push(cand, n, a, key);
            } catch {
                n = _collectArtifactAddresses(json, key, cand, n);
            }
        }
        return n;
    }

    function _push(Found[] memory cand, uint256 n, address a, string memory source) private pure returns (uint256) {
        if (a == address(0)) return n;
        for (uint256 i = 0; i < n; ++i) {
            if (cand[i].addr == a) return n;
        }
        require(n < MAX_CANDIDATES, "ChainContracts: more candidates than the walk holds; raise MAX_CANDIDATES");
        cand[n] = Found(a, source);
        return n + 1;
    }
}
