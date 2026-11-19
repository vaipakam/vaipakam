/**
 * #3770 — a transaction id the tracker kept lives on one device only. When
 * the app is opened inside a Safe wallet, the shell also reads that
 * wallet's own queue and says how many of its pending transactions call
 * the platform on this network, so a step sent from another device or
 * another owner is not out of sight. It states what the queue says; it
 * never marks anything done (only a receipt on chain does), and a queue it
 * cannot read is said to be unread, not empty.
 */
import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { Notice } from '../ui/Notice';
import { readQueuedTo } from './accountWallet';

export function AccountQueue() {
  const { text, format } = useCopy();
  const { address, chainId, connector } = useAccount();
  const chain = chainId !== undefined ? getSupportedChain(chainId) : null;
  const enabled = connector?.id === 'safe' && address !== undefined && chain !== null;
  const q = useQuery({
    queryKey: ['account-queue', chainId, address],
    queryFn: () => readQueuedTo(chain!.chainId, address!, chain!.diamondAddress),
    enabled,
    refetchInterval: 60_000,
    retry: 0,
  });
  if (!enabled) return null;
  if (q.isError)
    return (
      <div data-testid="account-queue" data-state="unread">
        <Notice tone="info" tier="A">
          {text('flow.queueUnread')}
        </Notice>
      </div>
    );
  if (!q.data || q.data.length === 0) return null;
  return (
    <div data-testid="account-queue" data-state="pending">
      <Notice tone="info" tier="A">
        {format('flow.queuePending', { count: String(q.data.length), chain: chain!.name })}
      </Notice>
    </div>
  );
}
