/**
 * ACC-63 — the testnet faucet's assets. Minting lives in the mock token
 * contracts the deployment record publishes (`testnetMocks`), never in the
 * protocol contract, so the faucet exists only on a testnet whose record
 * carries them. Two kinds of test token are offered so priced and unpriced
 * deals are both possible: ones the rig wired to a test price feed and pool,
 * and ones it deliberately left without (that absence is what makes them
 * unpriced), plus rentable test NFTs and a multi-token (ERC-1155)
 * collection, which can be pledged by quantity.
 */
import { parseAbi, parseEventLogs, zeroAddress, type Log } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import type { SupportedChain } from '../../chain/chains';

type Hex = `0x${string}`;

export type FaucetAsset = { key: string; address: Hex; kind: 'erc20'; priced: boolean } | { key: string; address: Hex; kind: 'nft' } | { key: string; address: Hex; kind: 'multi' };

/** The record's keys, in display order. */
const ERC20_KEYS: readonly (readonly [key: string, priced: boolean])[] = [
  ['liquidToken', true],
  ['liquidToken2', true],
  ['mWeth', true],
  ['illiquidToken', false],
  ['illiquidToken2', false],
];
const NFT_KEYS: readonly string[] = ['rentalNft', 'rentalNft2'];
/** The multi-token (ERC-1155) collection, minted by quantity. */
const MULTI_KEYS: readonly string[] = ['multiToken'];

/** How many of a fresh multi-token one mint gives, so a quantity can be
 *  pledged and some kept. */
export const MULTI_MINT_UNITS = 10n;

/** Whole units of a test token one mint gives. */
export const ERC20_MINT_UNITS = 1000n;

export const FAUCET_ERC20_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address owner) view returns (uint256)']);
const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

/** Whether the mined transaction's own logs record `token` minting at
 *  least `amount` to `to` (a Transfer from the zero address). */
export function mintLogged(logs: readonly Log[], token: Hex, to: Hex, amount: bigint): boolean {
  return parseEventLogs({ abi: TRANSFER_ABI, logs: [...logs], eventName: 'Transfer', strict: false }).some(
    (l) =>
      l.address.toLowerCase() === token.toLowerCase() &&
      l.args.from?.toLowerCase() === zeroAddress &&
      l.args.to?.toLowerCase() === to.toLowerCase() &&
      (l.args.value ?? 0n) >= amount,
  );
}

/**
 * A token mint's measured outcome. `rose` is the balance change across the
 * mint's own block (read at the block before and at it), so a transfer made
 * while the mint waited is not counted against it. A shortfall the
 * transaction's own mint log contradicts (another transfer in the same
 * block) is unknown, never "not done"; only a shortfall with no mint
 * recorded is.
 */
export function mintVerdict(rose: bigint, amount: bigint, logged: boolean): 'done' | 'unknown' | 'not-done' {
  if (rose >= amount) return 'done';
  return logged ? 'unknown' : 'not-done';
}

export const FAUCET_NFT_ABI = parseAbi(['function mint(address to, uint256 tokenId)', 'function ownerOf(uint256 tokenId) view returns (address)']);
export const FAUCET_MULTI_ABI = parseAbi(['function mint(address to, uint256 id, uint256 amount)', 'function balanceOf(address owner, uint256 id) view returns (uint256)']);

/** The faucet's assets on `chain`, or null when it offers none: a mainnet,
 *  or a testnet whose deployment record publishes no test assets. */
export function faucetAssets(chain: SupportedChain): FaucetAsset[] | null {
  if (!chain.testnet) return null;
  const mocks = getDeployment(chain.chainId)?.testnetMocks as Readonly<Record<string, unknown>> | undefined;
  if (!mocks) return null;
  const at = (key: string): Hex | null => {
    const v = mocks[key];
    return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Hex) : null;
  };
  const out: FaucetAsset[] = [];
  for (const [key, priced] of ERC20_KEYS) {
    const address = at(key);
    if (address) out.push({ key, address, kind: 'erc20', priced });
  }
  for (const key of NFT_KEYS) {
    const address = at(key);
    if (address) out.push({ key, address, kind: 'nft' });
  }
  for (const key of MULTI_KEYS) {
    const address = at(key);
    if (address) out.push({ key, address, kind: 'multi' });
  }
  return out.length > 0 ? out : null;
}

/** A token number for a fresh test NFT: random, so two wallets minting at
 *  once do not collide; checked unminted before the wallet opens. */
export function freshTokenId(random: () => number = Math.random): bigint {
  return BigInt(Math.floor(random() * 2 ** 40)) + 1_000_000n;
}
