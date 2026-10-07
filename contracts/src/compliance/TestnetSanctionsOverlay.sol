// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {TestnetChains} from "./TestnetChains.sol";

/**
 * @title  TestnetSanctionsOverlay
 * @notice A TESTNET-ONLY sanctions oracle: an address is sanctioned when the
 *         chain's real upstream oracle (Chainalysis) reports it, OR when this
 *         contract's owner has flagged it.
 *
 * @dev    #2439. Why it exists: only Chainalysis can add an address to its
 *         oracle, so on a testnet that points straight at it no wallet we
 *         control can ever be flagged, and every path that runs only for a
 *         flagged wallet (the in-app banner, the Tier-1 refusals, Tier-2
 *         close-outs staying open, `refreshSanctionsFlag`, the frozen-claimant
 *         bookkeeping, recovery's banned-source branch) cannot be driven on a
 *         live deployment. `MockSanctionsList` cannot fill that gap on a
 *         public chain: anyone may call its setter.
 *
 *         Three properties are load-bearing:
 *
 *         1. **It cannot exist on a mainnet.** The constructor refuses every
 *            chain id outside `TestnetChains`' allowlist.
 *
 *         2. **Upstream failure behaves exactly as the real oracle's would.**
 *            For an address the owner has NOT flagged, `isSanctioned` returns
 *            the upstream answer and lets an upstream revert propagate
 *            unchanged. The Diamond wraps every oracle read in `try`, so its
 *            fail-open screens and its fail-closed screens (recovery,
 *            `refreshSanctionsFlag`) see the same outcome they would see
 *            against Chainalysis directly. An owner-flagged address answers
 *            `true` without reading upstream: the owner's flag is a fact this
 *            contract holds, and no upstream outage can make it less true.
 *
 *         3. **Every answer can be attributed.** `sanctionSource` says which
 *            list flagged an address, so a surface that tells a flagged user
 *            whom to contact can tell the truth: Chainalysis for an upstream
 *            flag, this test network's operator for an overlay flag.
 *
 *         `upstream` may be `address(0)` on a testnet Chainalysis does not
 *         cover; the overlay is then the whole list. It is immutable: a
 *         different upstream is a different overlay, deployed and configured
 *         on the Diamond in the open.
 */
contract TestnetSanctionsOverlay is ISanctionsList, Ownable2Step {
    /// @notice The real oracle this overlay extends, or `address(0)` when the
    ///         chain has none.
    ISanctionsList public immutable upstream;

    /// @notice Addresses the owner has flagged on this test network.
    mapping(address => bool) public flaggedByOverlay;

    /// @notice Emitted on every flag change, so the overlay's list is
    ///         reconstructible from logs alone.
    /// @param who      The address whose overlay flag changed.
    /// @param flagged  Its new overlay flag.
    event OverlayFlagSet(address indexed who, bool flagged);

    /// @notice The constructor ran on a chain id outside the testnet allowlist.
    error NotATestnet(uint256 chainId);
    /// @notice A non-zero upstream was given with no code behind it.
    error UpstreamHasNoCode(address upstream);
    /// @notice A batch named no addresses.
    error EmptyBatch();

    /// @param owner_     The chain's admin. Two-step ownership applies to every
    ///                   later transfer.
    /// @param upstream_  The chain's Chainalysis oracle, or `address(0)` when
    ///                   the chain has none.
    constructor(address owner_, address upstream_) Ownable(owner_) {
        if (!TestnetChains.isTestnet(block.chainid)) revert NotATestnet(block.chainid);
        if (upstream_ != address(0) && upstream_.code.length == 0) {
            revert UpstreamHasNoCode(upstream_);
        }
        upstream = ISanctionsList(upstream_);
    }

    /// @notice True iff `chainId` is one this contract may be deployed on —
    ///         `TestnetChains`' allowlist, exposed for off-chain readers.
    function isTestnetChain(uint256 chainId) public pure returns (bool) {
        return TestnetChains.isTestnet(chainId);
    }

    /// @notice Flag or clear one address on this test network's list.
    function setFlagged(address who, bool flagged) external onlyOwner {
        flaggedByOverlay[who] = flagged;
        emit OverlayFlagSet(who, flagged);
    }

    /// @notice Flag or clear several addresses at once.
    function setFlaggedBatch(address[] calldata who, bool flagged) external onlyOwner {
        uint256 n = who.length;
        if (n == 0) revert EmptyBatch();
        for (uint256 i; i < n; ++i) {
            flaggedByOverlay[who[i]] = flagged;
            emit OverlayFlagSet(who[i], flagged);
        }
    }

    /// @inheritdoc ISanctionsList
    /// @dev An upstream revert propagates for any address the owner has not
    ///      flagged — see property 2 in the contract notes.
    function isSanctioned(address addr) external view returns (bool) {
        if (flaggedByOverlay[addr]) return true;
        if (address(upstream) == address(0)) return false;
        return upstream.isSanctioned(addr);
    }

    /// @notice Which list flags `addr`.
    /// @dev    Reads upstream unconditionally, so an upstream outage reverts
    ///         here even for an overlay-flagged address: an attribution that
    ///         could not ask one of its two sources is not an attribution.
    /// @return byOverlay   The owner flagged it on this test network.
    /// @return byUpstream  The upstream oracle reports it; always false when
    ///                     there is no upstream.
    function sanctionSource(address addr) external view returns (bool byOverlay, bool byUpstream) {
        byOverlay = flaggedByOverlay[addr];
        byUpstream = address(upstream) != address(0) && upstream.isSanctioned(addr);
    }
}
