// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {PriceGuard} from "../../src/oracle/PriceGuard.sol";
import {VaipakamFeedRegistry} from "../../src/oracle/VaipakamFeedRegistry.sol";
import {TestnetChains} from "../../src/compliance/TestnetChains.sol";
import {Deployments} from "./Deployments.sol";
import {ArtifactDeploy} from "./ArtifactDeploy.sol";

/**
 * @title  PriceGuardDeployment
 * @notice The one build of a chain's {PriceGuard} (#3272), from the same
 *         deploy config the oracle's configure step reads, so the guard and
 *         the Diamond's oracle start from one source.
 *
 * @dev    `DeployDiamond` calls {deploy} inside its broadcast, before it
 *         creates the ProtocolRegistry, which takes the guard as its
 *         `PRICE_GUARD` pointer at construction. The registry has to exist
 *         before the vault code, so the guard is built here and not in a later
 *         configure step.
 *
 *         What it sets (owner decision 2026-11-09, "Set at deploy, checked
 *         once": the starting config applies with no delay):
 *         - owner and guardian: the admin. The handover moves the owner to the
 *           Timelock and the guardian to the Pauser Safe.
 *         - identity: the retail numeraire, USD, keyed by the feed registry's
 *           own USD and ETH denominators, so a lookup never misses a feed by
 *           asking under a different sentinel. An industrial fork builds its
 *           own guard with its own numeraire.
 *         - delay: `PRICE_GUARD_DELAY_SECONDS`, 3 days by default on a
 *           production chain and 0 on a testnet.
 *         - entries: the feed registry, then from the env, resolved as the
 *           configure step resolves them (`<CHAIN>_KEY`, else `KEY`):
 *           `WETH_ADDRESS`, `ETH_USD_FEED`, `SEQUENCER_UPTIME_FEED`, and each
 *           `VPFI_STABLE_FEED_SYMBOLS` symbol's `<SYMBOL>_FEED` as a stable
 *           reference. Pyth and the secondary sources start unset, as the
 *           Diamond's oracle does today.
 *
 *         A production chain must name WETH and the ETH/USD feed, each with
 *         code: the guard there starts complete or not at all. On a testnet
 *         an entry with no address or no code is left unset and logged; its
 *         configure step completes it under the testnet's zero delay (a mock
 *         rig's feeds and WETH exist only after the Diamond).
 */
library PriceGuardDeployment {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint64 internal constant PRODUCTION_DEFAULT_DELAY = 3 days;

    /// @notice Build the chain's guard. The caller holds the broadcast.
    function deploy(address admin, address feedRegistry) internal returns (address guard) {
        (PriceGuard.Identity memory id, uint64 delay, PriceGuard.Change[] memory c) = startingConfig(feedRegistry);
        guard = ArtifactDeploy.deploy(type(PriceGuard).name, abi.encode(admin, admin, id, delay, c));
        console.log("PriceGuard:", guard);
        console.log("  delay s :", uint256(delay));
        console.log("  entries :", c.length);
    }

    /// @notice The guard's identity, delay and starting entries for this chain.
    function startingConfig(address feedRegistry)
        internal
        view
        returns (PriceGuard.Identity memory id, uint64 delay, PriceGuard.Change[] memory c)
    {
        bool testnet = TestnetChains.isTestnet(block.chainid);
        require(feedRegistry.code.length != 0, "PriceGuardDeployment: the feed registry has no code");
        id.numeraireDenominator = VaipakamFeedRegistry(feedRegistry).USD();
        id.numeraireSymbol = bytes32("usd");
        id.ethDenominator = VaipakamFeedRegistry(feedRegistry).ETH();
        delay = uint64(VM.envOr("PRICE_GUARD_DELAY_SECONDS", uint256(testnet ? 0 : PRODUCTION_DEFAULT_DELAY)));

        string[] memory symbols = _stableSymbols();
        c = new PriceGuard.Change[](4 + symbols.length);
        uint256 k;
        c[k++] = _entry(PriceGuard.Kind.FeedRegistry, bytes32(0), feedRegistry);
        k = _envEntry(c, k, PriceGuard.Kind.Weth, bytes32(0), "WETH_ADDRESS", !testnet);
        k = _envEntry(c, k, PriceGuard.Kind.EthNumeraireFeed, bytes32(0), "ETH_USD_FEED", !testnet);
        k = _envEntry(c, k, PriceGuard.Kind.SequencerFeed, bytes32(0), "SEQUENCER_UPTIME_FEED", false);
        for (uint256 i; i < symbols.length; ++i) {
            k = _envEntry(
                c, k, PriceGuard.Kind.StableRef, bytes32(bytes(symbols[i])), string.concat(symbols[i], "_FEED"), false
            );
        }
        // Trim to the entries found: allocate the exact array rather than
        // rewrite a length in place.
        PriceGuard.Change[] memory found = new PriceGuard.Change[](k);
        for (uint256 i; i < k; ++i) {
            found[i] = c[i];
        }
        c = found;
    }

    /// @dev One env-named address entry. `required`: a production chain's
    ///      load-bearing entry, which must name a contract.
    function _envEntry(
        PriceGuard.Change[] memory c,
        uint256 k,
        PriceGuard.Kind kind,
        bytes32 subject,
        string memory key,
        bool required
    ) private view returns (uint256) {
        string memory prefixed = string.concat(Deployments.envPrefix(), key);
        address a = VM.envOr(prefixed, VM.envOr(key, address(0)));
        if (a == address(0) || a.code.length == 0) {
            require(
                !required,
                string.concat(
                    "PriceGuardDeployment: ", prefixed, " must name a contract on a production chain - the guard starts complete there"
                )
            );
            console.log(string.concat("  left unset (no ", prefixed, " with code): the configure step sets it"));
            return k;
        }
        c[k] = _entry(kind, subject, a);
        return k + 1;
    }

    function _entry(PriceGuard.Kind kind, bytes32 subject, address a) private pure returns (PriceGuard.Change memory) {
        return PriceGuard.Change(kind, subject, bytes32(uint256(uint160(a))));
    }

    /// @dev `VPFI_STABLE_FEED_SYMBOLS`, comma-separated, empty entries skipped.
    function _stableSymbols() private view returns (string[] memory out) {
        bytes memory csv = bytes(VM.envOr("VPFI_STABLE_FEED_SYMBOLS", string("")));
        uint256 n;
        uint256 start;
        string[] memory tmp = new string[](csv.length + 1);
        for (uint256 i; i <= csv.length; ++i) {
            if (i == csv.length || csv[i] == ",") {
                if (i > start) {
                    bytes memory w = new bytes(i - start);
                    for (uint256 j; j < w.length; ++j) {
                        w[j] = csv[start + j];
                    }
                    tmp[n++] = string(w);
                }
                start = i + 1;
            }
        }
        out = new string[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }
}
