/**
 * Fork-facing viem plumbing shared by the fixtures, the seeding
 * helpers, and the indexer stub. One place resolves the Diamond and
 * the testnet mock assets from the SAME consolidated deployments
 * bundle the app reads, so the suite can never drift from the app's
 * own address source.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem';
import { ANVIL_URL } from './anvil';
import { loadDeployment, loadDiamondAbi } from './artifacts';

export const CHAIN_ID = 84532;

const deployment = loadDeployment(CHAIN_ID);

export const DIAMOND = deployment.diamond;
export const WETH = deployment.weth as `0x${string}`;
export const MOCKS = deployment.testnetMocks;
if (!MOCKS) {
  throw new Error(
    'Base Sepolia bundle has no testnetMocks — the fork tier seeds via the faucet assets',
  );
}

export const DIAMOND_ABI_VIEM = loadDiamondAbi();

/** The fork chain as viem sees it — Base Sepolia's id, anvil's URL. */
export const forkChain: Chain = {
  id: CHAIN_ID,
  name: 'Base Sepolia (anvil fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
};

export const pub: PublicClient = createPublicClient({
  chain: forkChain,
  transport: http(ANVIL_URL),
});

export function walletFor(account: Account): WalletClient {
  return createWalletClient({
    chain: forkChain,
    transport: http(ANVIL_URL),
    account,
  });
}

export const ERC20_MIN_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const;
