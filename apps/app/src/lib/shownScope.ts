/**
 * #3836 — which wallet and network a card is showing now.
 *
 * A signed alert request can wait days for a multi-signature wallet's
 * owners, and the person may switch wallet or network meanwhile. When the
 * old request finally answers, what it learned (the saved settings, a link
 * code, a notice, the kept request) belongs to the wallet and network that
 * signed it, never to the one on screen. Each action takes the key it
 * started under and writes its answer to the card only through `ifShowing`.
 */
export interface ShownScope {
  /** Records the key the card shows now. */
  show(key: string): void;
  /** Runs `apply` only while the card still shows `key`; says whether it ran. */
  ifShowing(key: string, apply: () => void): boolean;
}

/** The key for a wallet on one network; no wallet is its own scope. */
export function scopeKey(chainId: number, wallet: string | undefined): string {
  return `${chainId}:${(wallet ?? '').toLowerCase()}`;
}

export function createShownScope(initial: string): ShownScope {
  let current = initial;
  return {
    show(key) {
      current = key;
    },
    ifShowing(key, apply) {
      if (current !== key) return false;
      apply();
      return true;
    },
  };
}
