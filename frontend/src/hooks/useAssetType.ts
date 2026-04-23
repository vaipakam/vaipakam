import { useEffect, useState } from 'react';
import { getContract, isAddress, type Address, type PublicClient } from 'viem';
import { useDiamondPublicClient } from '../contracts/useDiamond';
import { useWallet } from '../context/WalletContext';

export type DetectedAssetType = 'erc20' | 'erc721' | 'erc1155' | 'unknown';

const IERC721_INTERFACE_ID = '0x80ac58cd';
const IERC1155_INTERFACE_ID = '0xd9b67a26';

const DETECT_ABI = [
  {
    inputs: [{ internalType: 'bytes4', name: 'interfaceId', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const cache = new Map<string, DetectedAssetType>();

function cacheKey(chainId: number | null, address: string): string {
  return `${chainId ?? 0}:${address.toLowerCase()}`;
}

async function detect(
  client: PublicClient,
  address: Address,
): Promise<DetectedAssetType> {
  const c = getContract({ address, abi: DETECT_ABI, client });

  const [is721, is1155] = await Promise.all([
    c.read.supportsInterface([IERC721_INTERFACE_ID]).catch(() => false),
    c.read.supportsInterface([IERC1155_INTERFACE_ID]).catch(() => false),
  ]);

  if (is1155) return 'erc1155';
  if (is721) return 'erc721';

  try {
    await c.read.decimals();
    return 'erc20';
  } catch {
    return 'unknown';
  }
}

/**
 * Detects the asset standard (ERC-20 / ERC-721 / ERC-1155) for a contract
 * address on the connected chain. Uses ERC-165 `supportsInterface` for the
 * two NFT standards and falls back to an ERC-20 `decimals()` probe, which
 * matches what the rest of the app relies on.
 *
 * Returns `null` while the address is empty / invalid / detection is pending.
 */
export function useAssetType(address: string | null | undefined): {
  type: DetectedAssetType | null;
  loading: boolean;
} {
  const { chainId } = useWallet();
  const publicClient = useDiamondPublicClient();
  const inputsReady = !!address && isAddress(address) && !!publicClient;
  const [type, setType] = useState<DetectedAssetType | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // When inputs are invalid the hook returns `{ type: null, loading: false }`
    // by derivation below — no synchronous setState inside the effect needed.
    if (!inputsReady || !address) return;

    const key = cacheKey(chainId, address);
    const cached = cache.get(key);
    if (cached) {
      // Cached detection result — hydrate synchronously so callers don't see
      // a loading flash for known addresses.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setType(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    detect(publicClient, address as Address)
      .then((result) => {
        if (cancelled) return;
        cache.set(key, result);
        setType(result);
      })
      .catch(() => {
        if (cancelled) return;
        setType('unknown');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [address, publicClient, chainId, inputsReady]);

  return inputsReady ? { type, loading } : { type: null, loading: false };
}
