/**
 * One hook answering the three questions every screen asks:
 *   - who is connected (address)?
 *   - is the wallet on a supported Vaipakam network?
 *   - which chain should reads target right now?
 *
 * Read-targeting rule: wallet's chain when supported, otherwise
 * DEFAULT_CHAIN — so a disconnected visitor still sees live protocol
 * data instead of a blank app.
 */
import { useAccount, useSwitchChain } from 'wagmi';
import {
  DEFAULT_CHAIN,
  getSupportedChain,
  isSupportedChain,
  type SupportedChain,
} from './chains';

export interface ActiveChainState {
  address: `0x${string}` | undefined;
  isConnected: boolean;
  /** Wallet's chain when it is a supported Vaipakam chain, else null. */
  walletChain: SupportedChain | null;
  /** Connected AND on a supported chain — the write-eligibility gate. */
  onSupportedChain: boolean;
  /** Chain reads should target (never null). */
  readChain: SupportedChain;
  /** Ask the wallet to switch to a supported chain (defaults to DEFAULT_CHAIN). */
  switchToSupported: (chainId?: number) => void;
  switchPending: boolean;
}

export function useActiveChain(): ActiveChainState {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: switchPending } = useSwitchChain();

  const walletChain = getSupportedChain(chainId);
  const onSupportedChain = isConnected && isSupportedChain(chainId);
  const readChain = walletChain ?? DEFAULT_CHAIN;

  return {
    address,
    isConnected,
    walletChain,
    onSupportedChain,
    readChain,
    switchToSupported: (target?: number) =>
      switchChain({ chainId: target ?? DEFAULT_CHAIN.chainId }),
    switchPending,
  };
}
