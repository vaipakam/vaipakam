/**
 * Mounts the cross-tab receipt-invalidation receiver (RPC read-diet
 * PR A, design §4.1.4 rule 2) and registers the shared QueryClient so
 * non-hook write helpers (ERC-20 approve/revoke) can publish through
 * the same rail. Renders nothing; mount once inside the app shell
 * beside LiveChainSync / IndexerPushSync.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listenForReceiptInvalidations } from './receiptSync';

export function ReceiptSyncListener() {
  const queryClient = useQueryClient();
  useEffect(
    () => listenForReceiptInvalidations(queryClient),
    [queryClient],
  );
  return null;
}
