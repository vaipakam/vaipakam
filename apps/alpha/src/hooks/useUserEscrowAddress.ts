import { useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';

/**
 * Reads the connected user's per-user escrow proxy from the Diamond's
 * `EscrowFactoryFacet.getUserEscrowAddress(address)` getter.
 *
 * Returns `null` until the call resolves — and continues to return
 * `null` if the user has never deployed an escrow yet (the factory
 * returns `address(0)` in that case, which we surface as null so
 * callers can hide their "view your escrow" link cleanly).
 *
 * Used by the public landing page's Security section to surface a
 * "Verify your own escrow" link on the Isolated Per-User Escrow
 * card. Re-runs whenever the connected address or active chain
 * changes — useDiamondRead routes through the active chain's RPC so
 * a chain switch automatically re-points the read.
 */
export function useUserEscrowAddress(
  user: string | null | undefined,
): string | null {
  const diamondRead = useDiamondRead();
  const [escrow, setEscrow] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setEscrow(null);
      return;
    }
    diamondRead
      .getUserEscrowAddress(user)
      .then((addr: string) => {
        if (cancelled) return;
        // Factory returns the zero address when the user hasn't
        // deployed yet. Treat that as "no escrow" so the caller can
        // omit the link without an extra branch.
        if (
          !addr ||
          addr === '0x0000000000000000000000000000000000000000'
        ) {
          setEscrow(null);
        } else {
          setEscrow(addr);
        }
      })
      .catch(() => {
        // Read failure (chain not deployed, RPC error, function
        // missing on this chain) — keep the link hidden rather than
        // surfacing a broken state to the user.
        if (!cancelled) setEscrow(null);
      });
    return () => {
      cancelled = true;
    };
    // useDiamondRead is stable per chain; including it here makes us
    // re-run on chain switch even when the connected address is
    // unchanged.
  }, [user, diamondRead]);

  return escrow;
}
