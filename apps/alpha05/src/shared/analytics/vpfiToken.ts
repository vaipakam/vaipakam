/**
 * RW-60 — the VPFI token's own facts on one network, read from the token
 * contract (not the Diamond) at the Analytics page's block.
 *
 * VPFI is issued on one network only (its home, where the 230M cap and the
 * minter live); every other network carries a bridged copy whose supply is
 * the VPFI moved there. Which network is home is the protocol's own flag
 * (`isCanonicalVpfiChain`), and the token is the one the protocol names
 * (`getVPFIToken`). A bridged network never reports a cap of its own: its
 * facts say the cap belongs to the home network, never zero.
 */
import { parseAbi, type PublicClient } from 'viem';
import { cleanTokenLabel } from '@vaipakam/lib/tokenLabel';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { SUPPORTED_CHAINS, type SupportedChain } from '../../chain/chains';
import { readVpfiHome } from '../rewards/vpfiFacts';

type Hex = `0x${string}`;

const DIAMOND = parseAbi(['function getVPFIToken() view returns (address)']);

const ZERO = '0x0000000000000000000000000000000000000000';

const TOKEN = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function cap() view returns (uint256)',
  'function INITIAL_MINT() view returns (uint256)',
  'function minter() view returns (address)',
]);

/** A token fact: its value, or why it was not read. */
export type Fact<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface HomeFacts {
  cap: Fact<bigint>;
  initialMint: Fact<bigint>;
  minter: Fact<Hex>;
}

export interface VpfiTokenFacts {
  token: Hex;
  /** True on VPFI's home network; null when the protocol's flag was not read. */
  home: boolean | null;
  name: Fact<string>;
  symbol: Fact<string>;
  decimals: Fact<number>;
  supply: Fact<bigint>;
  owner: Fact<Hex>;
  paused: Fact<boolean>;
  /** Read only on the home network. */
  homeFacts: HomeFacts | null;
}

/** The network has no VPFI token set, so there is nothing to read. */
export type VpfiRead = { kind: 'none' } | { kind: 'token'; facts: VpfiTokenFacts };

function reason(e: unknown): string {
  const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return msg.split('\n')[0]!.slice(0, 160);
}

async function fact<T>(p: Promise<T>): Promise<Fact<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, reason: reason(e) };
  }
}

export async function readVpfiToken(c: PublicClient, chain: SupportedChain, blockNumber: bigint): Promise<VpfiRead> {
  // Only a zero address the protocol actually returned is "none". A revert
  // (a Diamond without the selector) or a source that failed to answer
  // throws, and the caller states the token unread.
  const token = await c.readContract({ address: chain.diamondAddress, abi: DIAMOND, functionName: 'getVPFIToken', blockNumber });
  if (token.toLowerCase() === ZERO) return { kind: 'none' };
  const at = { address: token, abi: TOKEN, blockNumber } as const;
  const [home, name, symbol, decimals, supply, owner, paused] = await Promise.all([
    readVpfiHome(c, chain.diamondAddress, blockNumber).catch(() => null),
    // The shared label rule, as for every token the app names.
    fact(c.readContract({ ...at, functionName: 'name' }).then((n) => cleanTokenLabel(n, 'name'))),
    fact(c.readContract({ ...at, functionName: 'symbol' }).then((n) => cleanTokenLabel(n, 'symbol'))),
    fact(c.readContract({ ...at, functionName: 'decimals' }).then(Number)),
    fact(c.readContract({ ...at, functionName: 'totalSupply' })),
    fact(c.readContract({ ...at, functionName: 'owner' })),
    fact(c.readContract({ ...at, functionName: 'paused' })),
  ]);
  let homeFacts: HomeFacts | null = null;
  if (home === true) {
    const [cap, initialMint, minter] = await Promise.all([
      fact(c.readContract({ ...at, functionName: 'cap' })),
      fact(c.readContract({ ...at, functionName: 'INITIAL_MINT' })),
      fact(c.readContract({ ...at, functionName: 'minter' })),
    ]);
    homeFacts = { cap, initialMint, minter };
  }
  return { kind: 'token', facts: { token, home, name, symbol, decimals, supply, owner, paused, homeFacts } };
}

/** What may still be minted under the cap; null when either figure is unread. */
export function mintable(h: HomeFacts, supply: Fact<bigint>): bigint | null {
  if (!h.cap.ok || !supply.ok) return null;
  return h.cap.value > supply.value ? h.cap.value - supply.value : 0n;
}

/** Who an address is, when it is one this deployment records. */
export type Holder = 'diamond' | 'timelock' | 'other';

export function holderOf(address: string, chain: SupportedChain): Holder {
  const a = address.toLowerCase();
  if (a === chain.diamondAddress.toLowerCase()) return 'diamond';
  const timelock = (getDeployment(chain.chainId) as { timelock?: string } | undefined)?.timelock;
  if (timelock !== undefined && a === timelock.toLowerCase()) return 'timelock';
  return 'other';
}

/** The VPFI address this app's deployment record names on each network it
 *  serves, and whether the record marks it as the home (a network with a
 *  bridged copy records a mirror). */
export function recordedVpfiAddresses(): { chain: SupportedChain; token: Hex; home: boolean }[] {
  return SUPPORTED_CHAINS.flatMap((chain) => {
    const d = getDeployment(chain.chainId) as { vpfiToken?: string; vpfiMirror?: string } | undefined;
    if (!d?.vpfiToken) return [];
    return [{ chain, token: d.vpfiToken as Hex, home: d.vpfiMirror === undefined }];
  });
}
