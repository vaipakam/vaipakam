// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRateSourceReader} from "../../interfaces/IRateSourceReader.sol";
import {TestnetChains} from "../../compliance/TestnetChains.sol";

/**
 * @title  MockRateSource
 * @author Vaipakam Developer Team
 * @notice A TEST source for the rate reference (#3337 part 1,
 *         `RateReferenceDesign.md` section 3): the testnets' outside markets
 *         are thin and their rates mean nothing, so each testnet asset reads
 *         three or more of these, whose rate the test admin sets. It is its
 *         own reader and its own market. Refused on every chain that is not a
 *         listed testnet, so a mainnet series can never name one.
 */
contract MockRateSource is IRateSourceReader, Ownable {
    error NotATestnet(uint256 chainId);

    /// @notice The rate set for each asset, 1e18-scaled annual.
    mapping(address => uint256) public rateOf;
    /// @notice When true the source answers nothing, as a failed market.
    bool public failing;

    event RateSet(address indexed asset, uint256 rate1e18);
    event FailingSet(bool failing);

    constructor(address owner_) Ownable(owner_) {
        if (!TestnetChains.isTestnet(block.chainid)) revert NotATestnet(block.chainid);
    }

    /// @notice Set `asset`'s rate. The test admin only.
    function setRate(address asset, uint256 rate1e18) external onlyOwner {
        rateOf[asset] = rate1e18;
        emit RateSet(asset, rate1e18);
    }

    /// @notice Make the source fail or answer again. The test admin only.
    function setFailing(bool f) external onlyOwner {
        failing = f;
        emit FailingSet(f);
    }

    /// @inheritdoc IRateSourceReader
    function readRate(address asset, address market, bytes32 marketAssetId)
        external
        view
        returns (bool ok, uint256 rate1e18)
    {
        if (failing || market != address(this) || marketAssetId != bytes32(0)) return (false, 0);
        uint256 r = rateOf[asset];
        return (r != 0, r);
    }
}
