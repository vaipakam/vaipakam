/**
 * OFF-02 / OFF-03 — the assets a pair can be picked from and what the
 * protocol says about each. The suggested list is a UI convenience, never a
 * protocol list: on a testnet it is the deployment record's wrapped native
 * token and test tokens; on a network whose record names none, the reader
 * pastes an address. Each asset's class (priced and liquid, illiquid, or a
 * price the protocol distrusts) is the protocol's own answer, read live.
 */
import { getAddress, isAddress, type Abi, type PublicClient } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import type { SupportedChain } from '../../chain/chains';
import { refusalFromError } from '../eligibility/refusal';
import { faucetAssets } from '../faucet/faucet';
import { ORACLE } from './reads';

type Hex = `0x${string}`;

export interface Candidate {
  address: Hex;
  /** A test token the deployment record publishes. */
  test: boolean;
}

/** The suggested ERC-20s on `chain`: the wrapped native token, then the
 *  test tokens a testnet publishes; empty when the record names none. */
export function suggestedAssets(chain: SupportedChain): Candidate[] {
  const out: Candidate[] = [];
  const weth = (getDeployment(chain.chainId) as { weth?: unknown } | undefined)?.weth;
  if (typeof weth === 'string' && isAddress(weth)) out.push({ address: getAddress(weth), test: false });
  for (const a of faucetAssets(chain) ?? []) {
    if (a.kind === 'erc20' && !out.some((c) => c.address.toLowerCase() === a.address.toLowerCase())) out.push({ address: getAddress(a.address), test: true });
  }
  return out;
}

/** The suggested collateral on `chain`: the ERC-20s above, then the test
 *  NFT collections a testnet publishes (NFT-13), marked as such. */
export function suggestedCollateral(chain: SupportedChain): (Candidate & { nft: boolean })[] {
  const out: (Candidate & { nft: boolean })[] = suggestedAssets(chain).map((c) => ({ ...c, nft: false }));
  for (const a of faucetAssets(chain) ?? []) {
    if (a.kind === 'nft' && !out.some((c) => c.address.toLowerCase() === a.address.toLowerCase())) out.push({ address: getAddress(a.address), test: true, nft: true });
  }
  return out;
}

/** A pasted address, checked for shape only; whether it is a token the
 *  protocol can use is the protocol's answer, read next. */
export function parsePasted(text: string): Hex | null {
  const t = text.trim();
  return isAddress(t, { strict: false }) ? getAddress(t) : null;
}

/** The liquidity probe's refusals that mean the protocol distrusts the
 *  asset's price (its sources disagree), by error name. */
const DISTRUST_ERRORS: ReadonlySet<string> = new Set(['OraclePriceDivergence', 'OracleCrossCheckDivergence']);

/** `OracleFacet.PriceStatus`, by enum position. */
const PRICE = ['priced', 'unavailable', 'distrusted'] as const;

/**
 * An asset's class as the protocol reads it now. `liquid` means priced and
 * deep enough for the protocol's liquidity probe, so loans on it are valued
 * and can be liquidated; `illiquid` is valued at zero and settles in kind;
 * `distrusted` is a price the protocol's sources disagree on, which closes
 * new positions on the asset until it clears (an asset-level switch).
 */
export type AssetClass = 'liquid' | 'illiquid' | 'distrusted';

export async function readAssetClass(client: PublicClient, diamond: Hex, asset: Hex): Promise<AssetClass> {
  const [status] = (await client.readContract({
    address: diamond,
    abi: ORACLE as Abi,
    functionName: 'getAssetPriceStatus',
    args: [asset],
  })) as readonly [number, bigint, number];
  if (PRICE[Number(status)] === 'distrusted') return 'distrusted';
  try {
    const s = Number(
      await client.readContract({
        address: diamond,
        abi: ORACLE as Abi,
        functionName: 'checkLiquidityOnActiveNetwork',
        args: [asset],
      }),
    );
    return s === 0 ? 'liquid' : 'illiquid';
  } catch (e) {
    // The protocol's price-trust refusals are its answer; anything else (a
    // sequencer outage included) is a class it cannot give now and
    // propagates, so the caller says the class is unknown, and why.
    if (DISTRUST_ERRORS.has(refusalFromError(e).code)) return 'distrusted';
    throw e;
  }
}

/** The pair a Borrow or Lend page last used, kept per network in this
 *  browser only (a convenience, never state that must persist). */
export function loadLastPair(storageKey: string, chainId: number): { lending: Hex; collateral: Hex } | null {
  try {
    const raw = window.localStorage.getItem(`${storageKey}:${chainId}`);
    if (!raw) return null;
    const v = JSON.parse(raw) as { lending?: unknown; collateral?: unknown };
    const lending = typeof v.lending === 'string' ? parsePasted(v.lending) : null;
    const collateral = typeof v.collateral === 'string' ? parsePasted(v.collateral) : null;
    return lending && collateral ? { lending, collateral } : null;
  } catch {
    return null;
  }
}

export function saveLastPair(storageKey: string, chainId: number, pair: { lending: Hex; collateral: Hex }): void {
  try {
    window.localStorage.setItem(`${storageKey}:${chainId}`, JSON.stringify(pair));
  } catch {
    /* a blocked store only loses the convenience */
  }
}
