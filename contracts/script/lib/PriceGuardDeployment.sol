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
 *         The inputs are read from the env once, by {fromEnv}, in
 *         `DeployDiamond.run`; `runWith` takes them as script state and reads
 *         no env of its own, so an in-process deploy names its inputs without
 *         touching the process env every parallel test shares.
 *
 *         What it sets (owner decision 2026-11-09, "Set at deploy, checked
 *         once": the starting config applies with no delay):
 *         - owner and guardian: the admin. The handover moves the owner to the
 *           Timelock and the guardian to the Pauser Safe.
 *         - identity: the retail numeraire, USD, keyed by the feed registry's
 *           own USD and ETH denominators, so a lookup never misses a feed by
 *           asking under a different sentinel. An industrial fork builds its
 *           own guard with its own numeraire.
 *         - delay: `PRICE_GUARD_DELAY_SECONDS`, 7 days by default on a
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

    uint64 internal constant PRODUCTION_DEFAULT_DELAY = 7 days;

    /// @notice What the deploy reads from its config. A zero address is a
    ///         missing entry; unset inputs mean a testnet guard with no delay
    ///         and only the feed registry.
    struct Inputs {
        uint64 delay;
        address weth;
        address ethUsdFeed;
        address sequencerFeed;
        bytes32[] stableSymbols;
        address[] stableFeeds;
    }

    /// @notice The inputs from the env (see the library notes).
    function fromEnv() internal view returns (Inputs memory i) {
        bool testnet = TestnetChains.isTestnet(block.chainid);
        i.delay = uint64(VM.envOr("PRICE_GUARD_DELAY_SECONDS", uint256(testnet ? 0 : PRODUCTION_DEFAULT_DELAY)));
        i.weth = _envAddress("WETH_ADDRESS");
        i.ethUsdFeed = _envAddress("ETH_USD_FEED");
        i.sequencerFeed = _envAddress("SEQUENCER_UPTIME_FEED");
        string[] memory symbols = _stableSymbols();
        i.stableSymbols = new bytes32[](symbols.length);
        i.stableFeeds = new address[](symbols.length);
        for (uint256 k; k < symbols.length; ++k) {
            i.stableSymbols[k] = bytes32(bytes(symbols[k]));
            i.stableFeeds[k] = _envAddress(string.concat(symbols[k], "_FEED"));
        }
    }

    /// @notice Build the chain's guard. The caller holds the broadcast.
    function deploy(address admin, address feedRegistry, Inputs memory inputs) internal returns (address guard) {
        (PriceGuard.Identity memory id, uint64 delay, PriceGuard.Change[] memory c) =
            startingConfig(feedRegistry, inputs);
        guard = ArtifactDeploy.deploy(type(PriceGuard).name, abi.encode(admin, admin, id, delay, c));
        console.log("PriceGuard:", guard);
        console.log("  delay s :", uint256(delay));
        console.log("  entries :", c.length);
    }

    /// @notice The guard's identity, delay and starting entries for this chain.
    function startingConfig(address feedRegistry, Inputs memory inputs)
        internal
        view
        returns (PriceGuard.Identity memory id, uint64 delay, PriceGuard.Change[] memory c)
    {
        bool testnet = TestnetChains.isTestnet(block.chainid);
        require(feedRegistry.code.length != 0, "PriceGuardDeployment: the feed registry has no code");
        require(
            inputs.stableSymbols.length == inputs.stableFeeds.length,
            "PriceGuardDeployment: one feed per stable symbol"
        );
        id.numeraireDenominator = VaipakamFeedRegistry(feedRegistry).USD();
        id.numeraireSymbol = bytes32("usd");
        id.ethDenominator = VaipakamFeedRegistry(feedRegistry).ETH();
        delay = inputs.delay;

        c = new PriceGuard.Change[](4 + inputs.stableSymbols.length);
        uint256 k;
        c[k++] = _entry(PriceGuard.Kind.FeedRegistry, bytes32(0), feedRegistry);
        k = _addEntry(c, k, PriceGuard.Kind.Weth, bytes32(0), inputs.weth, "WETH_ADDRESS", !testnet);
        k = _addEntry(c, k, PriceGuard.Kind.EthNumeraireFeed, bytes32(0), inputs.ethUsdFeed, "ETH_USD_FEED", !testnet);
        k = _addEntry(c, k, PriceGuard.Kind.SequencerFeed, bytes32(0), inputs.sequencerFeed, "SEQUENCER_UPTIME_FEED", false);
        for (uint256 i; i < inputs.stableSymbols.length; ++i) {
            bytes32 sym = inputs.stableSymbols[i];
            k = _addEntry(
                c, k, PriceGuard.Kind.StableRef, sym, inputs.stableFeeds[i], string.concat(_str(sym), "_FEED"), false
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

    /// @dev One address entry. `required`: a production chain's load-bearing
    ///      entry, which must name a contract. `key` names its config.
    function _addEntry(
        PriceGuard.Change[] memory c,
        uint256 k,
        PriceGuard.Kind kind,
        bytes32 subject,
        address a,
        string memory key,
        bool required
    ) private view returns (uint256) {
        if (a == address(0) || a.code.length == 0) {
            string memory named = string.concat(Deployments.envPrefix(), key);
            require(
                !required,
                string.concat(
                    "PriceGuardDeployment: ", named, " must name a contract on a production chain - the guard starts complete there"
                )
            );
            console.log(string.concat("  left unset (no ", named, " with code): the configure step sets it"));
            return k;
        }
        c[k] = _entry(kind, subject, a);
        return k + 1;
    }

    function _entry(PriceGuard.Kind kind, bytes32 subject, address a) private pure returns (PriceGuard.Change memory) {
        return PriceGuard.Change(kind, subject, bytes32(uint256(uint160(a))));
    }

    /// @dev `<CHAIN>_KEY`, else `KEY`, else zero.
    function _envAddress(string memory key) private view returns (address) {
        return VM.envOr(string.concat(Deployments.envPrefix(), key), VM.envOr(key, address(0)));
    }

    function _str(bytes32 word) private pure returns (string memory) {
        uint256 n;
        while (n < 32 && word[n] != 0) ++n;
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = word[i];
        }
        return string(b);
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
