import { DEFAULT_CHAIN, type ChainConfig } from '../contracts/config';

/**
 * Wallet-free stub for the marketing surface.
 *
 * The marketing site never connects a wallet — every component
 * here that's a literal copy of the defi-side equivalent (Security,
 * etc.) calls `useWallet()` for `{ activeChain, address }` to
 * derive "verify on chain" links and per-user surface state. With
 * no wallet, we return:
 *
 *   - `activeChain`: `DEFAULT_CHAIN` (so chain-aware verify links
 *      land on the canonical chain rather than crash)
 *   - `address`: `null` (the same "no connected user" sentinel
 *      defi's wallet context returns when disconnected)
 *
 * All write-flow consumers of the defi wallet context (`isConnected`,
 * `chainId`, `connectWallet()`, etc.) were pruned during the labs
 * copy, so a minimal `{ activeChain, address }` shape covers every
 * remaining call site.
 */
export function useWallet(): {
  activeChain: ChainConfig;
  address: string | null;
} {
  return { activeChain: DEFAULT_CHAIN, address: null };
}
