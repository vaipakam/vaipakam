/**
 * Wallet-free stub for the marketing surface.
 *
 * Marketing pages have no connected user, so the per-user escrow
 * lookup always returns `null`. Consumers (Security card "verify
 * on chain" links) treat null as "no per-user-escrow link" and
 * fall back to a generic Diamond-contract link.
 */
export function useUserEscrowAddress(
  _user: string | null | undefined,
): string | null {
  return null;
}
