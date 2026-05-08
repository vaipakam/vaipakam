/**
 * Minimal EIP-1193 provider surface we rely on. We avoid importing the full
 * MetaMask / WalletConnect types because tests inject a hand-rolled mock and
 * the app only ever touches `request` / `on` / `removeListener`.
 */

export interface Eip1193RequestArgs {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

export type Eip1193EventName = 'accountsChanged' | 'chainChanged' | 'disconnect';

export interface Eip1193Provider {
  request: (args: Eip1193RequestArgs) => Promise<unknown>;
  on: (event: Eip1193EventName, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: Eip1193EventName, listener: (...args: unknown[]) => void) => void;
}

/**
 * Error thrown by injected wallets — codes follow EIP-1193 standard error
 * ranges (4001 = user rejected, 4902 = unknown chain for add-chain flows).
 */
export interface WalletProviderError extends Error {
  code?: number;
  reason?: string;
  data?: unknown;
}
