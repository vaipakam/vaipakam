import { useEffect, useState } from 'react';
import { erc20Abi, type Address } from 'viem';
import { useDiamondPublicClient } from '../contracts/useDiamond';

export interface OnchainTokenInfo {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

const EMPTY: OnchainTokenInfo = { symbol: null, name: null, decimals: null };
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Reads `symbol()`, `name()`, `decimals()` from an arbitrary ERC-20
 * contract address on the chain the connected wallet is reading from.
 * Three cheap view calls; runs once per address (debounced 400ms to
 * avoid hammering the RPC while the user is still typing).
 *
 * Returns the fields it could decode and `null` for anything that
 * reverted (some tokens omit `name()` for example, or the address
 * isn't a contract at all). Consumers render only the non-null fields
 * so a partial answer is still useful — the Create-Offer
 * `<TokenInfoTag>` falls back to CoinGecko-resolved metadata when
 * available and uses these on-chain reads as the unlisted-token
 * fallback so users never end up looking at a bare address with no
 * identification.
 */
export function useOnchainTokenInfo(
  address: string | null | undefined,
): OnchainTokenInfo {
  const publicClient = useDiamondPublicClient();
  const [info, setInfo] = useState<OnchainTokenInfo>(EMPTY);

  useEffect(() => {
    if (!address || !ADDRESS_RE.test(address)) {
      setInfo(EMPTY);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      const addr = address as Address;
      Promise.allSettled([
        publicClient.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }),
        publicClient.readContract({ address: addr, abi: erc20Abi, functionName: 'name' }),
        publicClient.readContract({ address: addr, abi: erc20Abi, functionName: 'decimals' }),
      ]).then((results) => {
        if (cancelled) return;
        const symbol = results[0].status === 'fulfilled' ? String(results[0].value) : null;
        const name = results[1].status === 'fulfilled' ? String(results[1].value) : null;
        const decimals = results[2].status === 'fulfilled' ? Number(results[2].value) : null;
        setInfo({ symbol, name, decimals });
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [address, publicClient]);

  return info;
}
