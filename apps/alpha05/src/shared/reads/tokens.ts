/**
 * A token's symbol and decimals, read once per chain and address from the
 * token itself (a chain read, RB-RAILS) and shared by every surface. A token
 * that does not answer is stated as such: its amounts are shown in base
 * units beside its address, never with a guessed number of decimals.
 */
import { erc20Abi, type PublicClient } from 'viem';
import { useChainRead } from './chainRead';
import { formatUnits, shortAddress } from '../ui/format';
import type { CopyAccess } from '../copy/useCopy';

export interface TokenMeta {
  symbol: string | null;
  decimals: number | null;
}

export type TokenMetaMap = Readonly<Record<string, TokenMeta>>;

export async function readTokenMeta(client: PublicClient, addresses: readonly `0x${string}`[]): Promise<TokenMetaMap> {
  // One call per field, settled separately: the clients carry no chain
  // object, so there is no multicall address to batch through, and a token
  // that answers one field and not the other keeps the field it answered.
  const results = await Promise.allSettled(
    addresses.flatMap((address) => [
      client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ]),
  );
  const out: Record<string, TokenMeta> = {};
  addresses.forEach((address, i) => {
    const sym = results[2 * i];
    const dec = results[2 * i + 1];
    out[address.toLowerCase()] = {
      symbol: sym?.status === 'fulfilled' && typeof sym.value === 'string' && sym.value.length > 0 ? sym.value : null,
      decimals: dec?.status === 'fulfilled' ? Number(dec.value) : null,
    };
  });
  return out;
}

/** The metadata of every address in `addresses` (any order, duplicates
 *  allowed), read once and kept for the session. */
export function useTokenMeta(addresses: readonly `0x${string}`[]) {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase() as `0x${string}`))].sort();
  return useChainRead(['tokenMeta', ...unique], (client) => readTokenMeta(client, unique), { immutable: true, enabled: unique.length > 0 });
}

/** The asset's name for a sentence: its symbol, else its short address. */
export function assetName(address: string, meta: TokenMetaMap | null): string {
  return meta?.[address.toLowerCase()]?.symbol ?? shortAddress(address);
}

/** An ERC-20 amount as an exact figure with its symbol; in base units with
 *  the token's address when its decimals could not be read. */
export function tokenAmount(amount: bigint, address: string, meta: TokenMetaMap | null, format: CopyAccess['format']): string {
  const m = meta?.[address.toLowerCase()];
  if (!m || m.decimals === null) return format('asset.baseUnits', { amount: amount.toString(), token: shortAddress(address) });
  return `${formatUnits(amount, m.decimals)} ${m.symbol ?? shortAddress(address)}`;
}
