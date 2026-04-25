import { useState } from 'react';
import { Gavel, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { Address } from 'viem';
import { useWallet } from '../../context/WalletContext';
import { useDiamondContract } from '../../contracts/useDiamond';
import { useLiquidationQuotes } from '../../hooks/useLiquidationQuotes';
import type { OrchestratedQuotes } from '../../lib/swapQuoteService';
import { decodeContractError } from '../../lib/decodeContractError';
import { beginStep } from '../../lib/journeyLog';

interface LiquidateButtonProps {
  /** Loan being liquidated. Must already be HF-liquidatable on-chain. */
  loanId: bigint;
  chainId: number;
  collateralAsset: Address;
  collateralAmount: bigint;
  principalAsset: Address;
  /** The diamond address — `taker` for aggregator quotes, target of the
   *  triggerLiquidation call. */
  diamondAddress: Address;
}

const WORKER_ORIGIN =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_HF_WATCHER_ORIGIN ?? null;

const KIND_LABEL: Record<
  'zeroex' | 'oneinch' | 'univ3' | 'balancerv2',
  string
> = {
  zeroex: '0x',
  oneinch: '1inch',
  univ3: 'UniswapV3',
  balancerv2: 'Balancer V2',
};

/**
 * Phase 7a — one-click liquidation button with pre-flight quote
 * orchestration.
 *
 * Fetches quotes from 0x / 1inch / UniV3 / Balancer V2 in parallel,
 * ranks by expected output, renders a best-quote preview with a
 * fallback breakdown ("Plan: 1inch → UniV3 → 0x → Balancer"), and
 * submits the ranked `AdapterCall[]` to
 * `triggerLiquidation(loanId, calls)` on click. On total quote
 * failure (every venue returned null / errored) the button is
 * disabled with a "quotes unavailable" caption — the caller can still
 * trigger with an empty try-list via the raw contract UI, but that
 * would go straight to `FallbackPending`.
 */
export function LiquidateButton({
  loanId,
  chainId,
  collateralAsset,
  collateralAmount,
  principalAsset,
  diamondAddress,
}: LiquidateButtonProps) {
  const { address, isCorrectChain } = useWallet();
  const diamond = useDiamondContract();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const { status, quotes, errorMessage, refresh } = useLiquidationQuotes({
    loanId,
    chainId,
    sellToken: collateralAsset,
    buyToken: principalAsset,
    sellAmount: collateralAmount,
    taker: diamondAddress,
    workerOrigin: WORKER_ORIGIN,
  });

  const canWrite = !!address && isCorrectChain && !!diamond;

  const handleClick = async () => {
    if (!canWrite || !quotes || quotes.calls.length === 0 || !diamond) return;
    setSubmitting(true);
    setError(null);
    const step = beginStep({
      area: 'liquidation',
      flow: 'triggerLiquidation',
      step: 'submit',
      loanId: Number(loanId),
    });
    try {
      const tx = await (
        diamond as unknown as {
          triggerLiquidation: (
            id: bigint,
            calls: { adapterIdx: bigint; data: `0x${string}` }[],
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).triggerLiquidation(loanId, quotes.calls);
      setTxHash(tx.hash);
      await tx.wait();
      step.success({ note: `tx ${tx.hash} via ${quotes.ranked[0].adapterKind}` });
    } catch (err) {
      setError(decodeContractError(err, 'Liquidation failed'));
      step.failure(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--bg-secondary)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Gavel size={18} />
        <strong>Liquidate this loan</strong>
      </div>

      {status === 'loading' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.85rem' }}>
          <Loader2 size={14} className="spin" />
          Fetching quotes from 4 DEXes…
        </div>
      )}

      {status === 'error' && (
        <div className="alert alert-warning" style={{ fontSize: '0.82rem' }}>
          <AlertTriangle size={14} />
          <span>Quote orchestrator error: {errorMessage}</span>
        </div>
      )}

      {status === 'empty' && (
        <div className="alert alert-warning" style={{ fontSize: '0.82rem' }}>
          <AlertTriangle size={14} />
          <span>No DEX returned a usable quote for this pair. The loan will route to FallbackPending on submit.</span>
        </div>
      )}

      {quotes && <QuotePreview quotes={quotes} />}

      {error && (
        <div className="alert alert-error" style={{ fontSize: '0.82rem' }}>
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canWrite || status !== 'ready' || submitting}
          onClick={handleClick}
        >
          {submitting ? 'Submitting…' : 'Liquidate'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={refresh}
          disabled={submitting || status === 'loading'}
        >
          <RefreshCw size={12} /> Refresh quotes
        </button>
      </div>

      {txHash && (
        <div style={{ fontSize: '0.78rem', opacity: 0.75 }}>
          Submitted: {txHash.slice(0, 10)}…{txHash.slice(-8)}
        </div>
      )}
    </div>
  );
}

function QuotePreview({ quotes }: { quotes: OrchestratedQuotes }) {
  if (quotes.ranked.length === 0) return null;
  const best = quotes.ranked[0];
  const tail = quotes.ranked.slice(1);
  return (
    <div style={{ fontSize: '0.82rem' }}>
      <div>
        Best quote: <strong>{best.expectedOutput.toString()}</strong> (raw base units){' '}
        <em style={{ opacity: 0.7 }}>via {KIND_LABEL[best.adapterKind]}</em>
      </div>
      {tail.length > 0 && (
        <div style={{ fontSize: '0.76rem', opacity: 0.7, marginTop: 4 }}>
          Fallback plan:{' '}
          {tail.map((q) => KIND_LABEL[q.adapterKind]).join(' → ')}
        </div>
      )}
      {quotes.failedKinds.length > 0 && (
        <div style={{ fontSize: '0.72rem', opacity: 0.55, marginTop: 4 }}>
          Unavailable: {quotes.failedKinds.map((k) => KIND_LABEL[k]).join(', ')}
        </div>
      )}
    </div>
  );
}
