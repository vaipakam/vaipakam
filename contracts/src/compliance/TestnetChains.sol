// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  TestnetChains
 * @notice The chain ids a testnet-only contract or script step may run on.
 * @dev    #2439. One allowlist, read by `TestnetSanctionsOverlay`'s
 *         constructor and by `ConfigureSanctionsOracle`, so the contract and
 *         the script that deploys it cannot disagree about what a testnet is.
 *         An allowlist, not a denylist: a chain id added later is treated as
 *         a mainnet until someone decides otherwise here.
 */
library TestnetChains {
    /// @notice True iff `chainId` is Base Sepolia, Ethereum Sepolia, Arbitrum
    ///         Sepolia, OP Sepolia, Polygon Amoy, BNB testnet or Anvil.
    function isTestnet(uint256 chainId) internal pure returns (bool) {
        return chainId == 84532 || chainId == 11155111 || chainId == 421614
            || chainId == 11155420 || chainId == 80002 || chainId == 97
            || chainId == 31337;
    }
}
