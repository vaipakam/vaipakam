/**
 * Fork-node impersonation and time control.
 *
 * Several behaviours only become observable from an address the harness does
 * not hold a key for — the Diamond admin (to arm the sanctions oracle or flip
 * KYC enforcement) and the testnet mocks' deployer (the faucet price feeds and
 * the mock swap venue are deliberately owner-gated, precisely so a public
 * testnet's HF and liquidation demos cannot be repriced by a passer-by).
 * Impersonation is the fork's own cheatcode, available on both Anvil and
 * `hardhat node`; nothing here weakens the deployed contracts.
 */
import { pub, forkChain, rpc, walletFor } from './chain.mjs';
import { createWalletClient, http } from 'viem';
import { RPC_URL } from './chain.mjs';

const OWNABLE = [{ type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }];

/** Send one transaction as an arbitrary address, then stop impersonating it. */
export async function sendAs(who, params) {
  await rpc('hardhat_impersonateAccount', [who]);
  await rpc('hardhat_setBalance', [who, '0x56BC75E2D63100000']); // 100 ETH for gas
  try {
    const wallet = createWalletClient({ account: who, chain: forkChain, transport: http(RPC_URL) });
    const hash = await wallet.writeContract({ ...params, account: who, chain: forkChain });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${params.functionName}: mined but reverted`);
    return receipt;
  } finally {
    await rpc('hardhat_stopImpersonatingAccount', [who]);
  }
}

/** Same, resolving the caller from the target contract's own `owner()`. */
export async function sendAsOwner(address, abi, functionName, args) {
  const owner = await pub.readContract({ address, abi: OWNABLE, functionName: 'owner' });
  await sendAs(owner, { address, abi, functionName, args });
  return owner;
}

/** Advance the fork's clock and mine, so time-based lifecycle gates fire. */
export async function warpDays(days) {
  await rpc('evm_increaseTime', [Math.round(days * 86_400)]);
  await rpc('evm_mine');
}

/** The faucet price feeds: `MockChainlinkFeed`, deployer-gated `setPrice`. */
export const MOCK_FEED_ABI = [
  { type: 'function', name: 'setPrice', inputs: [{ type: 'int256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'price', inputs: [], outputs: [{ type: 'int256' }], stateMutability: 'view' },
  { type: 'function', name: 'latestRoundData', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }], stateMutability: 'view' },
];

/** The registered liquidation venue: `MockSwapAdapter`, deployer-gated. */
export const MOCK_ADAPTER_ABI = [
  { type: 'function', name: 'setTokenPrice', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'tokenUsdPrice8', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

/** Set a faucet feed's USD price, in whole dollars, at Chainlink's 8 decimals. */
export const setFeedUsd = (feed, dollars) =>
  sendAsOwner(feed, MOCK_FEED_ABI, 'setPrice', [BigInt(Math.round(dollars * 1e8))]);

export { walletFor };
