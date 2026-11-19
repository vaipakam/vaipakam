/**
 * Whether this network's Diamond routes a function, from its own loupe.
 * Used where a surface states a route only where it exists (#3763: the
 * takeover at face value is named as a way to get funds back only where it
 * is deployed). A loupe that answers "no facet" is `false`; a read that
 * fails is thrown, never read as "not deployed", so the own rail tries its
 * next source and a caller that cannot read it states the read as unknown
 * (Codex #3767 r13: an unread takeover must not hide a face-value route).
 */
import { toFunctionSelector, type Abi, type AbiFunction, type PublicClient } from 'viem';
import { DiamondLoupeFacetABI, InstantTakeoverFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The selector of `name` in `abi`; throws when the ABI has no such function. */
export function selectorOf(abi: Abi, name: string): Hex {
  const f = abi.find((x): x is AbiFunction => x.type === 'function' && x.name === name);
  if (!f) throw new Error(`no function ${name} in ABI`);
  return toFunctionSelector(f);
}

export async function routesSelector(c: PublicClient, diamond: Hex, selector: Hex): Promise<boolean> {
  const at = (await c.readContract({ address: diamond, abi: DiamondLoupeFacetABI as Abi, functionName: 'facetAddress', args: [selector] })) as Hex;
  return at.toLowerCase() !== ZERO;
}

/** Whether the Diamond routes `selector`, telling a loupe that answers "no
 *  facet" (`absent`) from a loupe that could not be read (`unknown`). Used
 *  where an absent optional capability lets a step go ahead that an unread
 *  one must not. */
export async function routeState(c: PublicClient, diamond: Hex, selector: Hex): Promise<'routed' | 'absent' | 'unknown'> {
  try {
    const at = (await c.readContract({ address: diamond, abi: DiamondLoupeFacetABI as Abi, functionName: 'facetAddress', args: [selector] })) as Hex;
    return at.toLowerCase() === ZERO ? 'absent' : 'routed';
  } catch {
    return 'unknown';
  }
}

/** Whether the instant market's takeover at face value is deployed here. */
export function takeoverRouted(c: PublicClient, diamond: Hex): Promise<boolean> {
  return routesSelector(c, diamond, selectorOf(InstantTakeoverFacetABI as Abi, 'takeoverInstant'));
}
