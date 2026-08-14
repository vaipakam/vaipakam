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
 *
 * **The result is tagged with the wallet it was resolved for**, and a result
 * belonging to a different wallet reads as `null` rather than being handed
 * back. Without that, a wallet switch left the previous wallet's vault
 * address in hand for the whole lookup — long enough for a caller to pair it
 * with the NEW wallet's address and read a mix of the two. That is a real
 * hazard for a per-user vault: the balance of one wallet's vault, minus the
 * protocol-tracked figure for another's, is not a number that means anything.
 * Returning `null` while resolving makes the transition state "unknown",
 * which every caller already handles, instead of "confidently wrong".
 */
export function useUserVaultAddress(
  user: string | null | undefined,
): string | null {
  const diamondRead = useDiamondRead();
  const [resolved, setResolved] = useState<{
    vault: string | null;
    forUser: string | null;
  }>({ vault: null, forUser: null });

  useEffect(() => {
    let cancelled = false;
    // Every write records the wallet the value belongs to. `forUser` is read
    // from the effect's own closure, so it is always the wallet this run was
    // started for — never whichever one happens to be connected when the
    // promise settles.
    const forUser = (user ?? null) as string | null;
    if (!user) {
      setResolved({ vault: null, forUser });
      return;
    }
    diamondRead
      .getUserVaultAddress(user)
      .then((addr: string) => {
        if (cancelled) return;
        // Factory returns the zero address when the user hasn't
        // deployed yet. Treat that as "no vault" so the caller can
        // omit the link without an extra branch.
        const isUndeployed =
          !addr || addr === '0x0000000000000000000000000000000000000000';
        setResolved({ vault: isUndeployed ? null : addr, forUser });
      })
      .catch(() => {
        // Read failure (chain not deployed, RPC error, function
        // missing on this chain) — keep the link hidden rather than
        // surfacing a broken state to the user.
        if (!cancelled) setResolved({ vault: null, forUser });
      });
    return () => {
      cancelled = true;
    };
    // useDiamondRead is stable per chain; including it here makes us
    // re-run on chain switch even when the connected address is
    // unchanged.
  }, [user, diamondRead]);

  // Synchronous staleness guard. On the render right after a wallet change,
  // `resolved` still holds the previous wallet's answer and the effect has not
  // re-run yet; withhold it rather than let a caller pair it with the new
  // wallet's address. Compared case-insensitively so a checksum-case
  // difference between two sources of the same address can't read as a
  // mismatch and pin this at `null`.
  const currentUser = (user ?? null) as string | null;
  const isForCurrentUser =
    resolved.forUser === currentUser ||
    (resolved.forUser != null &&
      currentUser != null &&
      resolved.forUser.toLowerCase() === currentUser.toLowerCase());
  return isForCurrentUser ? resolved.vault : null;
}
