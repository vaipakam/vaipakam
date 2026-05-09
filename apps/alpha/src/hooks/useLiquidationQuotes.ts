import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import {
  orchestrateQuotes,
  type OrchestratedQuotes,
} from '../lib/swapQuoteService';

interface UseLiquidationQuotesInput {
  /** `null` disables the hook (returns idle state). Callers pass null
   *  when the loan hasn't crossed a liquidatable threshold yet. */
  loanId: bigint | null;
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  /** Typically the diamond address — the `taker` 0x / 1inch quote for. */
  taker: Address;
  /** Base URL of the hf-watcher worker. Pulled from env in the caller. */
  workerOrigin: string | null;
}

type Status = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface UseLiquidationQuotesResult {
  status: Status;
  /** Orchestrated quotes — sorted best-first. Null until ready. */
  quotes: OrchestratedQuotes | null;
  /** Human-readable error on status === 'error'. */
  errorMessage: string | null;
  /** Trigger a re-fetch (e.g. user clicked "Refresh quotes"). */
  refresh: () => void;
}

/**
 * Phase 7a — fetches quotes from every configured DEX venue in
 * parallel, ranks by expected output, and hands the caller a ready-
 * to-submit `AdapterCall[]` try-list. Stale quotes are a known risk
 * — the hook re-fetches on mount and exposes a manual `refresh()`,
 * but does NOT poll automatically (fresh quotes cost API calls and
 * the button is only visible for a short window).
 *
 * Fails soft: an individual venue's failure downgrades the ranked
 * list but never errors out the hook. Only when ALL four venues
 * fail (or the public client isn't available) does `status` become
 * `error`. An empty list with no errors means every venue returned
 * zero liquidity — the caller routes to `FallbackPending` on-chain.
 */
export function useLiquidationQuotes({
  loanId,
  chainId,
  sellToken,
  buyToken,
  sellAmount,
  taker,
  workerOrigin,
}: UseLiquidationQuotesInput): UseLiquidationQuotesResult {
  const publicClient = usePublicClient({ chainId });
  const [status, setStatus] = useState<Status>('idle');
  const [quotes, setQuotes] = useState<OrchestratedQuotes | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (loanId == null) {
      setStatus('idle');
      setQuotes(null);
      return;
    }
    if (!publicClient) {
      setStatus('error');
      setErrorMessage('Public client unavailable — can’t quote UniV3 on-chain.');
      setQuotes(null);
      return;
    }
    setStatus('loading');
    setErrorMessage(null);
    let cancelled = false;
    (async () => {
      try {
        const result = await orchestrateQuotes({
          chainId,
          sellToken,
          buyToken,
          sellAmount,
          taker,
          workerOrigin,
          publicClient,
        });
        if (cancelled) return;
        setQuotes(result);
        if (result.ranked.length === 0) {
          setStatus('empty');
        } else {
          setStatus('ready');
        }
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Unknown error');
        setQuotes(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    loanId,
    chainId,
    sellToken,
    buyToken,
    sellAmount,
    taker,
    workerOrigin,
    publicClient,
    nonce,
  ]);

  return {
    status,
    quotes,
    errorMessage,
    refresh: () => setNonce((n) => n + 1),
  };
}
