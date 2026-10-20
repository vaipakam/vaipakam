// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {TestnetChains} from "./TestnetChains.sol";

/**
 * @title  TestnetSanctionsOracleStandIn
 * @notice A TESTNET-ONLY stand-in for RedStone's Sanctions Oracle, so the
 *         delisting timelock's cross-chain clearance route can be rehearsed
 *         end to end on test networks, where RedStone has no deployment. It
 *         is NOT RedStone and carries none of RedStone's data: an address is
 *         flagged here only when this contract's owner has flagged it.
 *
 * @dev    #2443, owner decision 2026-10-20 ("rehearse with a stand-in").
 *         RedStone's Sanctions Oracle is reported live only on Ethereum
 *         mainnet, so on a testnet a `SanctionsClearanceAttestor` has nothing
 *         real to read. This contract answers in its place, through the same
 *         two reads the attestor and the timelock use: `isSanctioned` and
 *         `getLastUpdateBlockTimestamp()`.
 *
 *         Three properties are load-bearing:
 *
 *         1. **It cannot exist on a mainnet.** The constructor refuses every
 *            chain id outside `TestnetChains`' allowlist, the same rule the
 *            admin's `TestnetSanctionsOverlay` uses.
 *
 *         2. **It says what it is.** {isTestnetStandIn} answers `true` and
 *            {STAND_IN_FOR} names the oracle it stands in for, so a bot or a
 *            surface reading a clearance can say "the testnet stand-in"
 *            instead of "RedStone". RedStone's oracle has no such function,
 *            so a reader that gets no `true` from it never calls an oracle a
 *            stand-in.
 *
 *         3. **Its freshness is its owner's.** {getLastUpdateBlockTimestamp}
 *            is the time of the owner's last write: deployment (an empty list
 *            published), a flag change, or {markUpdated}, which re-publishes
 *            the list unchanged the way RedStone's own refresh would. It is
 *            never the current block's time, so a stand-in nobody maintains
 *            goes stale and closes the automated route exactly as a frozen
 *            RedStone would (the timelock's `oracleMaxAge`); it never makes a
 *            clearance look fresher than its owner made it.
 */
contract TestnetSanctionsOracleStandIn is ISanctionsList, Ownable2Step {
    /// @notice The oracle this contract stands in for on test networks.
    string public constant STAND_IN_FOR = "RedStone Sanctions Oracle";

    /// @notice Addresses the owner has flagged on this test network.
    mapping(address account => bool) public flagged;

    /// @dev The time of the owner's last write; see {getLastUpdateBlockTimestamp}.
    uint256 private _lastUpdate;

    /// @notice Emitted on every flag change, so the stand-in's list is
    ///         reconstructible from logs alone.
    /// @custom:event-category informational/compliance
    event StandInFlagSet(address indexed account, bool flagged);

    /// @notice Emitted whenever the owner (re)publishes the list: at
    ///         deployment, after a flag change, and on {markUpdated}.
    /// @custom:event-category informational/compliance
    event StandInUpdated(uint256 timestamp);

    /// @notice The constructor ran on a chain id outside the testnet allowlist.
    error NotATestnet(uint256 chainId);
    /// @notice A batch named no addresses.
    error EmptyBatch();
    /// @notice The zero address cannot be flagged or cleared.
    error ZeroAddress();

    /// @param owner_ The chain's admin. Two-step ownership applies to every
    ///               later transfer.
    constructor(address owner_) Ownable(owner_) {
        if (!TestnetChains.isTestnet(block.chainid)) revert NotATestnet(block.chainid);
        _stamp();
    }

    /// @notice Always true: this contract is a testnet stand-in, not the
    ///         oracle named by {STAND_IN_FOR}.
    function isTestnetStandIn() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc ISanctionsList
    /// @dev True only for an address the owner has flagged here.
    function isSanctioned(address addr) external view returns (bool) {
        return flagged[addr];
    }

    /// @notice When the owner last published this list: deployment, a flag
    ///         change, or {markUpdated}. The same read RedStone's oracle
    ///         exposes, so the timelock's freshness gate applies to the
    ///         stand-in unchanged.
    function getLastUpdateBlockTimestamp() external view returns (uint256) {
        return _lastUpdate;
    }

    /// @notice Flag or clear addresses on this test network's stand-in list.
    ///         Counts as a publication of the list.
    function setFlagged(address[] calldata accounts, bool flagged_) external onlyOwner {
        uint256 n = accounts.length;
        if (n == 0) revert EmptyBatch();
        for (uint256 i; i < n; ++i) {
            address account = accounts[i];
            if (account == address(0)) revert ZeroAddress();
            flagged[account] = flagged_;
            emit StandInFlagSet(account, flagged_);
        }
        _stamp();
    }

    /// @notice Re-publish the list unchanged, as RedStone's own refresh
    ///         would. Without one within the timelock's `oracleMaxAge` of an
    ///         execution, the stand-in is stale and the execution refuses.
    function markUpdated() external onlyOwner {
        _stamp();
    }

    function _stamp() private {
        _lastUpdate = block.timestamp;
        emit StandInUpdated(block.timestamp);
    }
}
