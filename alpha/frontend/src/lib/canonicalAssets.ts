/**
 * Phase 8a.4 — per-chain canonical ERC-20 list for the Allowances page.
 *
 * Covers the standard bag of stablecoins + majors a user is most likely
 * to have granted a stale approval on, even if they've never touched
 * the asset through Vaipakam itself. Addresses are mainnet-canonical
 * where possible; testnets fall back to the well-known mock / bridged
 * token deployments. The list is intentionally short — if a user has
 * an approval on a long-tail token not in this set, it still surfaces
 * through the `loan`-sourced bucket when that token appears as a
 * principal / collateral asset on one of their loans.
 *
 * Casing is irrelevant downstream — `useAllowances` lowercases keys.
 */

/** Chain id → array of canonical token addresses. */
const CANONICAL: Record<number, string[]> = {
  // Ethereum mainnet (chainId 1)
  1: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
  ],
  // Base mainnet (8453)
  8453: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
    '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
  ],
  // Arbitrum One (42161)
  42161: [
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
    '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
    '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // DAI
    '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', // WBTC
  ],
  // Optimism (10)
  10: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // USDC
    '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // USDT
    '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // DAI
    '0x68f180fcCe6836688e9084f035309E29Bf0A2095', // WBTC
  ],
  // Polygon zkEVM (1101)
  1101: [
    '0x4F9A0e7FD2Bf6067db6994CF12E4495Df938E6e9', // WETH (bridge)
    '0xA8CE8aee21bC2A48a5EF670afCc9274C7bbbC035', // USDC.e
  ],
  // BNB Chain (56)
  56: [
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
    '0x55d398326f99059fF775485246999027B3197955', // USDT
    '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', // DAI
  ],
  // Sepolia (11155111) — testnet canonical only; symbols match mainnet
  11155111: [
    '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH9
    '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8', // USDC (Circle testnet)
  ],
  // Base Sepolia (84532)
  84532: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC (Circle testnet)
  ],
};

export function getCanonicalAssetsForChain(chainId: number): string[] {
  return CANONICAL[chainId] ?? [];
}
