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
  keccak256,
  parseEther,
  parseUnits,
  toBytes,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { nameRevert } from './selectors.mjs';

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
/** The chain's WETH as the deployment records it — the quote side of the faucet v3 pools. */
export const WETH = deployment.weth;
// The treasury is MUTABLE (`AdminFacet.setTreasury`), so the artifact's value
// is only what it was at deploy. Every accounting row reads the fee recipient
// the fork's Diamond reports NOW; the artifact value is kept for comparison.
export const ARTIFACT_TREASURY = deployment.treasury;
// The admin is MUTABLE too (`AccessControlFacet.transferAdmin` revokes every
// privileged role from the old holder), so the artifact's `admin` is only a
// candidate. `resolveLive()` settles the live one; `ADMIN` is that binding.
export const ARTIFACT_ADMIN = deployment.admin;

export const forkChain = defineChain({
  id: deployment.chainId,
  name: `${CHAIN_SLUG}-fork`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const pub = createPublicClient({ chain: forkChain, transport: http(RPC_URL) });

// Resolved by `resolveLive()`, which the runner calls AFTER its first
// `evm_mine`: a hardhat node refuses `eth_call` at a fresh fork's own block,
// so reading this while the module loads would fail before the runner could
// mine past it. Scenarios read it inside `run()`, so the live binding holds
// the resolved value by then.
export let TREASURY = null;
export let ADMIN = null;
// ERC-173 ownership and ADMIN_ROLE can be held by DIFFERENT addresses:
// setters gated on ownership (e.g. the sanctions oracle) act through OWNER,
// role-gated ones through ADMIN. Both are read from the live Diamond.
export let OWNER = null;
const view = (name, inputs, output) => ({ type: 'function', name, inputs: inputs.map((type) => ({ type })), outputs: [{ type: output }], stateMutability: 'view' });
const ADMIN_ROLE = keccak256(toBytes('ADMIN_ROLE'));
export async function resolveLive() {
  const readD = (abiItem, args = []) => pub.readContract({ address: DIAMOND, abi: [abiItem], functionName: abiItem.name, args });
  TREASURY = await readD(view('getTreasury', [], 'address'));
  // Whoever holds ADMIN_ROLE on the live Diamond NOW: the Diamond's owner
  // first, then the artifact's admin. Neither holding it is artifact drift the
  // run cannot act through, so it stops here — naming both — rather than
  // letting the gate scenarios abort later on an authorization error that
  // reads like a product defect.
  const owner = await readD(view('owner', [], 'address'));
  OWNER = owner;
  for (const candidate of [owner, ARTIFACT_ADMIN]) {
    if (candidate && (await readD(view('hasRole', ['bytes32', 'address'], 'bool'), [ADMIN_ROLE, candidate]))) { ADMIN = candidate; return; }
  }
  throw new Error(`no ADMIN_ROLE holder found: neither the Diamond owner ${owner} nor the artifact admin ${ARTIFACT_ADMIN} holds it — the deployment artifact has drifted from the live Diamond`);
}

// Fresh keys every run, NOT the published test-mnemonic accounts a fork node
// pre-funds. A fork carries the REAL chain's state for every address it
// touches, and those well-known keys are anything but clean on a public
// testnet: on Base Sepolia the second and third already carry EIP-7702
// delegations (`0xef0100…` code), so the Diamond sees a contract where the
// scenario means a wallet — accept signatures go through the ERC-1271 path
// and fail, and minting a position NFT to one calls a receiver hook that
// reverts. A node that ignores 7702 hides this; Anvil honours it. Generated
// keys have no history on any chain, and `fundActors()` gives them gas.
export const [lender, borrower, outsider] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));

export const walletFor = (account) =>
  createWalletClient({ account, chain: forkChain, transport: http(RPC_URL) });

/** Minimal ERC-20 surface: the faucet mocks expose an open `mint`. */
export const ERC20 = [
  { type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
];

/**
 * Send a transaction and fail loudly — with the custom error NAMED.
 *
 * A reverted send comes back as raw hex unless it is decoded here; the
 * simulate path has always named its refusals, and a scenario that aborts on
 * `0x5c9e11e8` instead of `InvalidCaps()` cannot tell an expected refusal
 * from a defect.
 */
export async function tx(account, params, label) {
  let hash;
  try {
    // Pad the estimate by 20%. Anvil's estimate for a loan-CLOSING call comes
    // back short: the close clears enough storage that the refund hides the
    // peak, and the send then dies inside the Diamond's delegatecall with
    // "not enough gas for reentrancy sentry" (the EIP-2200 rule that an
    // SSTORE needs >2,300 gas left). Seen on `repayLoan` after a partial —
    // estimate 573,777, reverted at 565,251. Wallets pad for the same reason.
    const estimate = await pub.estimateContractGas({ ...params, account });
    hash = await walletFor(account).writeContract({ ...params, account, chain: forkChain, gas: (estimate * 12n) / 10n });
  } catch (e) {
    const named = nameRevert(e);
    if (!named) throw e;
    const wrapped = new Error(`${label}: reverted with ${named}`);
    wrapped.cause = e;
    wrapped.decoded = named;
    throw wrapped;
  }
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label}: mined but reverted — ${await explainMinedRevert(hash, receipt)}`);
  return receipt;
}

/**
 * A send that passed estimation and still reverted on-chain carries no
 * revert data in its receipt, so name it two ways: replay the call against
 * the parent block's state (automine gives one tx per block, so that is the
 * exact pre-state), and compare gas used to the limit — an estimate that was
 * one inner call short shows up as `gasUsed ≈ gasLimit`, which a replay at
 * the block gas limit would not reproduce.
 */
async function explainMinedRevert(hash, receipt) {
  const sent = await pub.getTransaction({ hash });
  const gas = `gasUsed=${receipt.gasUsed}/${sent.gas}`;
  try {
    await pub.call({ account: sent.from, to: sent.to, data: sent.input, value: sent.value, blockNumber: receipt.blockNumber - 1n });
    return `${gas}; replay at the parent block SUCCEEDS, so the send ran short of gas or raced other state`;
  } catch (e) {
    return `${gas}; replay: ${nameRevert(e) ?? String(e.shortMessage ?? e.message).split('\n')[0]}`;
  }
}

/** Raw JSON-RPC — for the node's own cheatcodes (time warp, impersonation). */
export const rpc = (method, params = []) =>
  fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json());

/**
 * Give the generated actors gas, and refuse to run if any of them is not a
 * plain wallet. The code check is what makes the 7702 lesson above loud
 * rather than a scatter of unrelated-looking reverts.
 */
export async function fundActors() {
  for (const a of [lender, borrower, outsider]) {
    const set = await rpc('hardhat_setBalance', [a.address, '0x56BC75E2D63100000']); // 100 ETH
    if (set.error) throw new Error(`fork node refused hardhat_setBalance: ${set.error.message}`);
    const code = await pub.getCode({ address: a.address });
    if (code && code !== '0x') throw new Error(`actor ${a.address} has code on the fork (${code.slice(0, 12)}…) — not a plain wallet`);
  }
}

export const chainNow = async () => Number((await pub.getBlock()).timestamp);
export const f18 = (v) => formatUnits(v, 18);
export { formatUnits, parseEther, parseUnits };
