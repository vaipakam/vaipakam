/**
 * Shared chain wiring for the fork-scenario harness.
 *
 * Talks to a local fork node (Anvil or `hardhat node --fork`) that is
 * serving a COPY of a real deployment, so every scenario runs against the
 * bytecode that is actually live rather than a fresh local deploy. The
 * Diamond address, the treasury and the testnet faucet mocks all come from
 * the committed deployment artifact for the forked chain — never hard-coded
 * here — so the harness follows a redeploy without an edit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseEther,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

export const RPC_URL = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';
export const CHAIN_SLUG = process.env.FORK_CHAIN_SLUG ?? 'base-sepolia';

const ABI_DIR = path.join(REPO, 'packages/contracts/src/abis');
const ARTIFACT = path.join(REPO, 'contracts/deployments', CHAIN_SLUG, 'addresses.json');

/** Load a facet ABI from the committed per-facet export. */
export const abi = (name) => JSON.parse(fs.readFileSync(path.join(ABI_DIR, `${name}.json`), 'utf8'));

export const deployment = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
export const DIAMOND = deployment.diamond;
export const MOCKS = deployment.testnetMocks ?? {};
export const TREASURY = deployment.treasury;
export const ADMIN = deployment.admin;

export const forkChain = defineChain({
  id: deployment.chainId,
  name: `${CHAIN_SLUG}-fork`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const pub = createPublicClient({ chain: forkChain, transport: http(RPC_URL) });

// The three canonical dev keys every fork node pre-funds. They are the
// standard published test mnemonic's first accounts — never usable anywhere
// that holds value.
const DEV_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
export const [lender, borrower, outsider] = DEV_KEYS.map(privateKeyToAccount);

export const walletFor = (account) =>
  createWalletClient({ account, chain: forkChain, transport: http(RPC_URL) });

/** Minimal ERC-20 surface: the faucet mocks expose an open `mint`. */
export const ERC20 = [
  { type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
];

/** Send a transaction and fail loudly on a mined-but-reverted receipt. */
export async function tx(account, params, label) {
  const hash = await walletFor(account).writeContract({ ...params, account, chain: forkChain });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label}: mined but reverted`);
  return receipt;
}

/** Raw JSON-RPC — for the node's own cheatcodes (time warp, impersonation). */
export const rpc = (method, params = []) =>
  fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json());

export const chainNow = async () => Number((await pub.getBlock()).timestamp);
export const f18 = (v) => formatUnits(v, 18);
export { formatUnits, parseEther, parseUnits };
