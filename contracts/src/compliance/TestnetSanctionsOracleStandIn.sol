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
 *         3. **Its freshness is a write, never the clock.**
 *            {getLastUpdateBlockTimestamp} is the time of the last
 *            publication: deployment (an empty list published), a flag change
 *            by the owner, or {markUpdated}, which re-publishes the list
 *            unchanged the way RedStone's own refresh would. It is never the
 *            current block's time, so a stand-in nobody maintains goes stale
 *            and closes the automated route exactly as a frozen RedStone
 *            would (the timelock's `oracleMaxAge`).
 *
 *         4. **Only the owner decides what is flagged.** #3113 (owner
 *            decision 2026-11-04: the keeper refreshes it weekly instead of
 *            the admin by hand) adds a {refresher}, which the owner names and
 *            may clear. The refresher may call {markUpdated} and nothing
 *            else: it can keep the owner's list fresh, never change it. A
 *            refresh by it is the same unchanged re-publication the owner's
 *            would be, and is told apart on-chain by {StandInUpdated}'s
 *            `by`.
 */
contract TestnetSanctionsOracleStandIn is ISanctionsList, Ownable2Step {
    /// @notice The oracle this contract stands in for on test networks.
    string public constant STAND_IN_FOR = "RedStone Sanctions Oracle";

    /// @notice Addresses the owner has flagged on this test network.
    mapping(address account => bool) public flagged;

    /// @dev The time of the last publication; see {getLastUpdateBlockTimestamp}.
    uint256 private _lastUpdate;

    /// @notice The one address besides the owner that may call {markUpdated}
    ///         (the keeper, #3113); address(0) when none is named. It can
    ///         flag nothing.
    address public refresher;

    /// @notice Emitted on every flag change, so the stand-in's list is
    ///         reconstructible from logs alone.
    /// @custom:event-category informational/compliance
    event StandInFlagSet(address indexed account, bool flagged);

    /// @notice Emitted whenever the list is (re)published: at deployment,
    ///         after a flag change, and on {markUpdated}. `by` is who
    ///         published it: the owner, or the {refresher}.
    /// @custom:event-category informational/compliance
    event StandInUpdated(uint256 timestamp, address indexed by);

    /// @notice Emitted when the owner names or clears the {refresher}.
    /// @custom:event-category informational/compliance
    event StandInRefresherSet(address indexed previous, address indexed refresher);

    /// @notice The constructor ran on a chain id outside the testnet allowlist.
    error NotATestnet(uint256 chainId);
    /// @notice A batch named no addresses.
    error EmptyBatch();
    /// @notice The zero address cannot be flagged or cleared.
    error ZeroAddress();
    /// @notice {markUpdated} was called by neither the owner nor the refresher.
    error NotOwnerOrRefresher(address caller);

    /// @param owner_ The chain's admin. Two-step ownership applies to every
    ///               later transfer.
    constructor(address owner_) Ownable(owner_) {
        if (!TestnetChains.isTestnet(block.chainid)) revert NotATestnet(block.chainid);
        _stamp(owner_);
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
        _stamp(msg.sender);
    }

    /// @notice Re-publish the list unchanged, as RedStone's own refresh
    ///         would. Without one within the timelock's `oracleMaxAge` of an
    ///         execution, the stand-in is stale and the execution refuses.
    ///         The owner or the {refresher} may call it.
    function markUpdated() external {
        if (msg.sender != owner() && msg.sender != refresher) {
            revert NotOwnerOrRefresher(msg.sender);
        }
        _stamp(msg.sender);
    }

    /// @notice Name the {refresher}, or clear it with address(0). Changes no
    ///         flag and does not re-publish the list.
    function setRefresher(address refresher_) external onlyOwner {
        emit StandInRefresherSet(refresher, refresher_);
        refresher = refresher_;
    }

    function _stamp(address by) private {
        _lastUpdate = block.timestamp;
        emit StandInUpdated(block.timestamp, by);
    }
}
