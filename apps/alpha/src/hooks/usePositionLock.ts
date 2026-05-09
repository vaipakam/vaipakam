import { useCallback, useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';

/**
 * Mirrors LibERC721.LockReason. Kept in sync with the on-chain enum so the
 * UI can render plain-language copy per strategic flow.
 */
export const LockReason = {
  None: 0,
  PrecloseOffset: 1,
  EarlyWithdrawalSale: 2,
} as const;
export type LockReason = typeof LockReason[keyof typeof LockReason];

/**
 * Reads the native transfer-lock state for a Vaipakam position NFT via
 * {@link VaipakamNFTFacet.positionLock}. A non-`None` result means the NFT
 * cannot be transferred or approved until the responsible strategic flow
 * completes or is cancelled.
 */
export function usePositionLock(tokenId: bigint | null | undefined) {
  const diamond = useDiamondRead();
  const [lock, setLock] = useState<LockReason>(LockReason.None);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (tokenId === null || tokenId === undefined) {
      setLock(LockReason.None);
      return;
    }
    setLoading(true);
    try {
      const raw = (await diamond.positionLock(tokenId)) as bigint | number;
      setLock(Number(raw) as LockReason);
    } catch {
      setLock(LockReason.None);
    } finally {
      setLoading(false);
    }
  }, [diamond, tokenId]);

  useEffect(() => { load(); }, [load]);

  return { lock, loading, reload: load };
}
