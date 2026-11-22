// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {rehearsalMode, carriesLocalNodeMarker} from "./ArtifactRoot.sol";

/// @notice Who a broadcast is sent as: the role's name, its address, and its
///         key. The key is ZERO in a deploy rehearsal, where the address is
///         impersonated on the local fork and no key is ever read.
struct Signer {
    string role;
    address addr;
    uint256 key;
}

/**
 * @title  Signers
 * @notice The ONE place an operator script decides who signs and starts a
 *         broadcast (#3891, deploy rehearsal design §12).
 *
 * @dev    A real run reads `<ROLE>_PRIVATE_KEY`, derives its address, and
 *         requires it to equal `<ROLE>_ADDRESS`. A deploy rehearsal reads ONLY
 *         `<ROLE>_ADDRESS` and broadcasts as that address, which the fork has
 *         impersonated (forge `--unlocked`). The address check in the real run
 *         is what ties the two together: the address a rehearsal impersonated
 *         is the address the real key gives, or the real run stops before its
 *         first transaction.
 *
 *         `<ROLE>_ADDRESS` is REQUIRED on a real chain. On a local node (Anvil
 *         31337, a harness node carrying the local-node marker, or `forge
 *         test`) it is checked when set and may be absent, so the scenario
 *         harnesses and the CI deploy smoke keep running on development keys.
 *
 *         A pre-deploy guard (`script/check-signer-seam.mjs`) refuses any
 *         operator script that reads a `*_PRIVATE_KEY` variable or starts a
 *         broadcast anywhere but here.
 */
library Signers {
    address private constant VM_ADDR =
        address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm private constant CHEATS = Vm(VM_ADDR);

    /// The signer for `role` (e.g. "DEPLOYER", "ADMIN"). Reverts when the run
    /// cannot produce one: no key in a real run, no address in a rehearsal.
    function role(string memory roleName) internal view returns (Signer memory s) {
        s = roleOr(roleName);
        require(
            s.addr != address(0),
            string.concat(
                "Signers: no signer for ",
                roleName,
                rehearsalMode()
                    ? " - a rehearsal needs "
                    : " - a real run needs ",
                roleName,
                rehearsalMode() ? "_ADDRESS" : "_PRIVATE_KEY"
            )
        );
    }

    /// The signer for `role`, or an empty one (address 0) when the run carries
    /// none. For the scripts where a role signs only when present (the admin
    /// key on a Timelock-governed chain, for one).
    function roleOr(string memory roleName) internal view returns (Signer memory s) {
        s.role = roleName;
        string memory addrVar = string.concat(roleName, "_ADDRESS");
        if (rehearsalMode()) {
            // No key is read in a rehearsal. The driver also pins every
            // `*_PRIVATE_KEY` to zero for each command, so a script that still
            // asked for one would get nothing.
            s.addr = CHEATS.envOr(addrVar, address(0));
            return s;
        }
        s.key = CHEATS.envOr(string.concat(roleName, "_PRIVATE_KEY"), uint256(0));
        if (s.key == 0) return s;
        s.addr = CHEATS.addr(s.key);
        _requireAddressMatches(roleName, addrVar, s.addr);
    }

    /// A signer from a key a caller already holds (the `runWith(…, key)` entry
    /// points the deploy-sanity tests drive). Refused in a rehearsal: a
    /// rehearsal never carries a key.
    function fromKey(string memory roleName, uint256 key) internal view returns (Signer memory s) {
        require(!rehearsalMode(), "Signers: a rehearsal carries no key - resolve the signer with Signers.role");
        require(key != 0, string.concat("Signers: zero key for ", roleName));
        s.role = roleName;
        s.key = key;
        s.addr = CHEATS.addr(key);
    }

    /// Start broadcasting as `s`. The only `startBroadcast` an operator script
    /// may reach.
    function start(Signer memory s) internal {
        require(s.addr != address(0), string.concat("Signers: no signer for ", s.role));
        if (s.key != 0) {
            CHEATS.startBroadcast(s.key);
        } else {
            // An address-only signer exists only in a rehearsal; the node
            // refuses a sender it has not impersonated ("No Signer available").
            require(rehearsalMode(), string.concat("Signers: no key for ", s.role, " outside a rehearsal"));
            CHEATS.startBroadcast(s.addr);
        }
    }

    /// Broadcast exactly the next call as `s`.
    function broadcastNext(Signer memory s) internal {
        require(s.addr != address(0), string.concat("Signers: no signer for ", s.role));
        if (s.key != 0) {
            CHEATS.broadcast(s.key);
        } else {
            require(rehearsalMode(), string.concat("Signers: no key for ", s.role, " outside a rehearsal"));
            CHEATS.broadcast(s.addr);
        }
    }

    /// Register `s` with forge's wallet so a later {startAs} can broadcast as
    /// its address: the key in a real run, nothing in a rehearsal (the fork has
    /// impersonated the address). Returns the address.
    function remember(Signer memory s) internal returns (address) {
        require(s.addr != address(0), string.concat("Signers: no signer for ", s.role));
        if (s.key != 0) CHEATS.rememberKey(s.key);
        return s.addr;
    }

    /// Start broadcasting as an ADDRESS, for the scripts that pass their
    /// signers around by address. The address must be one {remember} registered
    /// (a real run), the fork impersonated (a rehearsal), or a test's prank.
    /// Forge refuses an address it holds no wallet for, and the node refuses a
    /// sender it has not impersonated, so this cannot sign as anyone else.
    function startAs(address who) internal {
        require(who != address(0), "Signers: startAs the zero address");
        CHEATS.startBroadcast(who);
    }

    /// Start broadcasting as the sender forge was given on its command line
    /// (`--sender`, with `--unlocked` or a wallet flag). For the testnet tools
    /// that let an operator choose the signer per invocation when the role's
    /// own variables are unset; the node or forge refuses a sender it cannot
    /// sign for.
    function startCliSender() internal {
        CHEATS.startBroadcast();
    }

    /// TRUE when `<ROLE>_ADDRESS` may be absent: a local node or a test.
    function _addressOptional() private view returns (bool) {
        return block.chainid == 31337 ||
            CHEATS.isContext(VmSafe.ForgeContext.TestGroup) ||
            carriesLocalNodeMarker();
    }

    function _requireAddressMatches(string memory roleName, string memory addrVar, address derived)
        private
        view
    {
        address stated = CHEATS.envOr(addrVar, address(0));
        if (stated == address(0)) {
            require(
                _addressOptional(),
                string.concat(
                    "Signers: ",
                    addrVar,
                    " is required on a real chain - it is the address a rehearsal impersonates, and the real run must prove its key gives the same address"
                )
            );
            return;
        }
        require(
            stated == derived,
            string.concat(
                "Signers: ",
                addrVar,
                " is not the address of ",
                roleName,
                "_PRIVATE_KEY - the rehearsal impersonated the stated address, so this run would not be the deploy that was rehearsed"
            )
        );
    }
}
