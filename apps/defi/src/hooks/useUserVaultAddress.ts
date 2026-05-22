import { useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';

/**
 * Reads the connected user's per-user vault proxy from the Diamond's
 * `VaultFactoryFacet.getUserVaultAddress(address)` getter.
 *
 * Returns `null` until the call resolves — and continues to return
 * `null` if the user has never deployed an vault yet (the factory
 * returns `address(0)` in that case, which we surface as null so
 * callers can hide their "view your vault" link cleanly).
 *
 * Used by the public landing page's Security section to surface a
 * "Verify your own vault" link on the Isolated Per-User Vault
 * card. Re-runs whenever the connected address or active chain
 * changes — useDiamondRead routes through the active chain's RPC so
 * a chain switch automatically re-points the read.
 */
export function useUserVaultAddress(
  user: string | null | undefined,
): string | null {
  const diamondRead = useDiamondRead();
  const [vault, setVault] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setVault(null);
      return;
    }
    diamondRead
      .getUserVaultAddress(user)
      .then((addr: string) => {
        if (cancelled) return;
        // Factory returns the zero address when the user hasn't
        // deployed yet. Treat that as "no vault" so the caller can
        // omit the link without an extra branch.
        if (
          !addr ||
          addr === '0x0000000000000000000000000000000000000000'
        ) {
          setVault(null);
        } else {
          setVault(addr);
        }
      })
      .catch(() => {
        // Read failure (chain not deployed, RPC error, function
        // missing on this chain) — keep the link hidden rather than
        // surfacing a broken state to the user.
        if (!cancelled) setVault(null);
      });
    return () => {
      cancelled = true;
    };
    // useDiamondRead is stable per chain; including it here makes us
    // re-run on chain switch even when the connected address is
    // unchanged.
  }, [user, diamondRead]);

  return vault;
}
