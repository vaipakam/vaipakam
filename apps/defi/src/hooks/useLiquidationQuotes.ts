import { useEffect, useState } from 'react';
// Caller-parameterised chainId, not bound to the app-selected ChainContext.
// The lint rule guards against bare app-chain reads sneaking off to the wallet
// chain; this hook's contract is "quote against THIS chainId" and it calls
// `usePublicClient({ chainId })` with the caller's value, so the scoped wagmi
// form is exactly right.
//
// Keep the directive on the line directly above the import. It used to sit
// above this explanation, and `eslint-disable-next-line` suppresses only the
// line that follows it — so as soon as the note grew past one line the
// suppression landed on a comment and stopped covering the import. The rule
// then fired unsuppressed and defi's lint carried it as a real error, hidden
// among the unused-directive warnings it also produced.
// eslint-disable-next-line no-restricted-imports
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
  /** Base URL of the apps/agent Worker. Pulled from env in the caller. */
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
  const [nonce, setNonce] = useState(0);
  // Tagged with the whole quote request. A quote is a price for a specific
  // loan on a specific chain for a specific size — the previous loan's ranked
  // venues shown against a new one is not stale decoration, it is a number a
  // liquidator would act on. `idle`, `loading` and the no-client error are all
  // DERIVED, so none of them is written a paint after the frame that showed
  // the wrong quote. `nonce` is in the key because `refresh()` exists to get a
  // NEW quote; satisfying it from the old one would defeat the call.
  const reqKey =
    loanId == null
      ? null
      : [chainId, loanId, sellToken, buyToken, String(sellAmount), taker, nonce].join('|');
  const [result, setResult] = useState<{
    key: string;
    status: Status;
    quotes: OrchestratedQuotes | null;
    errorMessage: string | null;
  } | null>(null);

  useEffect(() => {
    if (!reqKey || loanId == null || !publicClient) return;
    let cancelled = false;
    (async () => {
      let next: { status: Status; quotes: OrchestratedQuotes | null; errorMessage: string | null };
      try {
        const quotes = await orchestrateQuotes({
          chainId,
          sellToken,
          buyToken,
          sellAmount,
          taker,
          workerOrigin,
          publicClient,
        });
        next = {
          status: quotes.ranked.length === 0 ? 'empty' : 'ready',
          quotes,
          errorMessage: null,
        };
      } catch (err) {
        next = {
          status: 'error',
          quotes: null,
          errorMessage: err instanceof Error ? err.message : 'Unknown error',
        };
      }
      if (cancelled) return;
      setResult({ key: reqKey, ...next });
    })();
    return () => {
      cancelled = true;
      // Dropped on the way out, so a re-opened panel re-quotes rather than
      // showing a price fetched before it was closed.
      setResult(null);
    };
  }, [
    reqKey,
    loanId,
    chainId,
    sellToken,
    buyToken,
    sellAmount,
    taker,
    workerOrigin,
    publicClient,
  ]);

  const matched = result?.key === reqKey;
  // A missing public client is a SETTLED answer, not a pending one — there is
  // nothing in flight and nothing will arrive.
  const status: Status =
    reqKey === null
      ? 'idle'
      : !publicClient
        ? 'error'
        : matched
          ? result.status
          : 'loading';

  return {
    status,
    quotes: matched ? result.quotes : null,
    errorMessage:
      reqKey !== null && !publicClient
        ? 'Public client unavailable — can\u2019t quote UniV3 on-chain.'
        : matched
          ? result.errorMessage
          : null,
    refresh: () => setNonce((n) => n + 1),
  };
}
