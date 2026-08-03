/**
 * Device-local pending-flow markers (per chain, per scope) — ONE
 * implementation for every "remember the thing I just broadcast" store
 * (refinance request, sale listing, offset, stuck-token recovery).
 *
 * For the LOAN-scoped stores a lost marker only costs an affordance
 * (cancel / pending banner), never funds — those callers ignore the
 * result and carry on.
 *
 * For the stuck-token recovery store it is a SAFETY record: losing it
 * silently means a reload presents a blank form over a recovery that
 * may still be mining. So `write` REPORTS whether the write actually
 * landed (Codex #1547 r8) instead of swallowing the failure and
 * claiming success — the caller decides whether that matters. Nothing
 * throws: the return value is the whole signal, so existing
 * fire-and-forget call sites keep their behaviour unchanged.
 *
 * `scope` is a loan id for the loan-scoped stores and the connected
 * ACCOUNT for the wallet-scoped ones (Codex #1547 r6) — it is only ever
 * interpolated into the key, so both shapes are safe. Keying by the
 * identity a record belongs to is what stops another account (or the
 * same account on another network) from ever seeing it.
 */
export interface PendingMarkerStore {
  read(chainId: number, scope: number | string): string | null;
  /** True when the value was actually persisted (or removed); false
   *  when storage refused (private mode, quota, disabled storage). */
  write(chainId: number, scope: number | string, id: string | null): boolean;
  /** The literal localStorage key a record lives under — exposed so a
   *  caller can recognise its OWN key in a cross-tab `storage` event
   *  without duplicating the naming scheme (Codex #1547 r8). */
  key(chainId: number, scope: number | string): string;
}

export function makePendingMarkerStore(prefix: string): PendingMarkerStore {
  const key = (chainId: number, scope: number | string) =>
    `${prefix}.${chainId}.${scope}`;
  return {
    key,
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
        return true;
      } catch {
        // Never throws — see module doc. Loan-scoped callers ignore
        // this; the recovery store surfaces it to the user.
        return false;
      }
    },
  };
}
