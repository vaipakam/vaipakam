/**
 * Device-local pending-flow markers (per chain, per scope) — ONE
 * implementation for every "remember the thing I just broadcast" store
 * (refinance request, sale listing, offset, stuck-token recovery).
 * localStorage failures are swallowed on purpose: losing a marker only
 * costs an affordance (cancel / pending banner), never funds.
 *
 * `scope` is a loan id for the loan-scoped stores and the connected
 * ACCOUNT for the wallet-scoped ones (Codex #1547 r6) — it is only ever
 * interpolated into the key, so both shapes are safe. Keying by the
 * identity a record belongs to is what stops another account (or the
 * same account on another network) from ever seeing it.
 */
export interface PendingMarkerStore {
  read(chainId: number, scope: number | string): string | null;
  write(chainId: number, scope: number | string, id: string | null): void;
}

export function makePendingMarkerStore(prefix: string): PendingMarkerStore {
  const key = (chainId: number, scope: number | string) =>
    `${prefix}.${chainId}.${scope}`;
  return {
    read(chainId, scope) {
      try {
        return window.localStorage.getItem(key(chainId, scope));
      } catch {
        return null;
      }
    },
    write(chainId, scope, id) {
      try {
        if (id === null) window.localStorage.removeItem(key(chainId, scope));
        else window.localStorage.setItem(key(chainId, scope), id);
      } catch {
        // See module doc — marker loss is affordance loss only.
      }
    },
  };
}
