/**
 * Device-local pending-flow markers (per chain, per loan) — ONE
 * implementation for every "remember the offer id I created" store
 * (refinance request, sale listing). localStorage failures are
 * swallowed on purpose: losing a marker only costs an affordance
 * (cancel / pending banner), never funds.
 */
export interface PendingMarkerStore {
  read(chainId: number, loanId: number): string | null;
  write(chainId: number, loanId: number, id: string | null): void;
}

export function makePendingMarkerStore(prefix: string): PendingMarkerStore {
  const key = (chainId: number, loanId: number) =>
    `${prefix}.${chainId}.${loanId}`;
  return {
    read(chainId, loanId) {
      try {
        return window.localStorage.getItem(key(chainId, loanId));
      } catch {
        return null;
      }
    },
    write(chainId, loanId, id) {
      try {
        if (id === null) window.localStorage.removeItem(key(chainId, loanId));
        else window.localStorage.setItem(key(chainId, loanId), id);
      } catch {
        // See module doc — marker loss is affordance loss only.
      }
    },
  };
}
