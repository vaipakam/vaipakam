import { useState } from 'react';
import { ArrowRightLeft, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { Address } from 'viem';
import { useWallet } from '../../context/WalletContext';
import { useChainOverride } from '../../context/ChainContext';
import { useDiamondContract } from '../../contracts/useDiamond';
import { useLiquidationQuotes } from '../../hooks/useLiquidationQuotes';
import type { OrchestratedQuotes } from '../../lib/swapQuoteService';
import { decodeContractError } from '@vaipakam/lib/decodeContractError';
import { beginStep } from '../../lib/journeyLog';

interface SwapToRepayPanelProps {
  /** Loan being repaid. Must be Active + ERC20-on-ERC20 + the
   *  caller must be the current borrower-NFT owner. */
  loanId: bigint;
  chainId: number;
  collateralAsset: Address;
  collateralAmount: bigint;
  principalAsset: Address;
  /** The diamond address — `taker` for aggregator quotes, target of
   *  the swapToRepayFull call. */
  diamondAddress: Address;
  /** Called after the tx confirms so the parent page can refresh
   *  loan state. Without this the parent would keep rendering the
   *  pre-swap (Active) loan with the swap panel enabled, letting a
   *  user accidentally submit a second tx that always reverts
   *  (Codex PR #409 round-1 P2 #2). */
  onAfterSuccess?: () => void | Promise<void>;
}

const WORKER_ORIGIN =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_AGENT_ORIGIN ?? null;

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
 * T-090 #403 — connected-app entry point for the borrower-initiated
 * swap-to-repay surface.
 *
 * For ERC20-on-ERC20 loans the borrower can swap their pledged
 * collateral into the loan's principal asset and apply the proceeds
 * to settlement in a single transaction, instead of the four-step
 * withdraw / external swap / redeposit / repay dance.
 *
 * Mirrors the {@link LiquidateButton} pattern:
 *   1. Orchestrate quotes from 0x / 1inch / UniV3 / Balancer V2 in
 *      parallel via {@link useLiquidationQuotes} (the same hook the
 *      liquidation path uses; sell-side = collateral, buy-side =
 *      principal, same shape).
 *   2. Display the best quote + fallback plan + unavailable venues.
 *   3. Submit `swapToRepayFull(loanId, calls, maxCollateralIn)`. The
 *      contract pulls the pre-pledged collateral from the borrower's
 *      protocol vault internally (no wallet allowance needed —
 *      Codex PR #409 P2 #3), validates the slippage cap, executes
 *      the swap via the ranked try-list, and applies proceeds to
 *      the settlement waterfall. Total swap failure (all adapters
 *      revert) reverts the whole tx — borrower can retry with
 *      fresher quotes.
 *   4. Call `onAfterSuccess` so the parent page refreshes the loan
 *      state, hiding the panel and reflecting the Repaid transition.
 *
 * Partial-reduction mode (`swapToRepayPartial`) is a v1.x follow-up;
 * this MVP ships full-close only.
 */
export function SwapToRepayPanel({
  loanId,
  chainId,
  collateralAsset,
  collateralAmount,
  principalAsset,
  diamondAddress,
  onAfterSuccess,
}: SwapToRepayPanelProps) {
  const { address, isCorrectChain } = useWallet();
  // Codex PR #409 round-2 P2 #2 — when a user has the public-dashboard
  // `viewChainId` override active (looking at a chain other than their
  // connected wallet's chain), `useDiamondContract()` intentionally
  // returns a read-only handle. Submit would throw inside the write
  // call. Refuse to enable the action button in that mode so the
  // panel is purely informational while cross-chain viewing.
  const { viewChainId } = useChainOverride();
  const diamond = useDiamondContract();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // The borrower pre-pledged `collateralAmount` at loan-init; we
  // default the bound to that amount. Future iteration can let the
  // borrower lower the bound (smaller swap → less slippage exposure,
  // at the cost of needing supplemental funds for the rest of the
  // debt) but the MVP keeps a single-click flow.
  const maxCollateralIn = collateralAmount;

  const { status, quotes, errorMessage, refresh } = useLiquidationQuotes({
    loanId,
    chainId,
    sellToken: collateralAsset,
    buyToken: principalAsset,
    sellAmount: maxCollateralIn,
    taker: diamondAddress,
    workerOrigin: WORKER_ORIGIN,
  });

  const canWrite =
    !!address && isCorrectChain && !!diamond && viewChainId === null;

  // Note: NO collateral-asset ERC20 approval is needed here (Codex
  // PR #409 round-1 P2 #3). The on-chain `swapToRepayFull` pulls the
  // pre-pledged collateral from the borrower's protocol VAULT via
  // `VaultFactoryFacet.vaultWithdrawERC20` — an `onlyDiamondInternal`
  // call — not from the borrower's wallet through a Diamond
  // allowance. A pre-flight `approve(diamond, maxCollateralIn)` would
  // be dead surface area at best, and at worst would block borrowers
  // holding USDT-style tokens (USDT requires a zero-allowance race
  // before a re-set).

  const handleSubmit = async () => {
    if (!canWrite || !quotes || quotes.calls.length === 0 || !diamond) return;
    setSubmitting(true);
    setError(null);
    setTxHash(null);
    const step = beginStep({
      area: 'repay',
      flow: 'swapToRepayFull',
      step: 'submit',
      loanId: Number(loanId),
    });
    try {
      const tx = await (
        diamond as unknown as {
          swapToRepayFull: (
            id: bigint,
            calls: { adapterIdx: bigint; data: `0x${string}` }[],
            maxCollateralIn: bigint,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).swapToRepayFull(loanId, quotes.calls, maxCollateralIn);
      setTxHash(tx.hash);
      await tx.wait();
      step.success({
        note: `tx ${tx.hash} via ${quotes.ranked[0].adapterKind}`,
      });
    } catch (err) {
      setError(decodeContractError(err, 'Swap-to-repay failed'));
      step.failure(err);
      setSubmitting(false);
      return;
    }
    // Codex PR #409 round-1 P2 #2 — refresh the parent page's loan
    // state so the panel hides and the Active loan flips to Repaid.
    // Codex PR #409 round-2 P2 #4 — handle the refresh OUTSIDE the
    // tx try/catch. A failing `onAfterSuccess` (RPC blip, etc.) AFTER
    // a successful tx must NOT mislabel the swap as failed — the
    // funds-moving operation already completed on-chain. Log the
    // refresh failure as its own concern so the user still sees the
    // success state but knows to refresh the page manually.
    if (onAfterSuccess) {
      try {
        await onAfterSuccess();
      } catch (refreshErr) {
        console.warn(
          '[SwapToRepayPanel] tx succeeded but loan-state refresh failed; refresh the page to update',
          refreshErr,
        );
      }
    }
    setSubmitting(false);
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
        marginTop: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ArrowRightLeft size={18} />
        <strong>Swap collateral to repay</strong>
      </div>
      <div style={{ fontSize: '0.82rem', opacity: 0.8 }}>
        Swap your pledged collateral into the loan's principal asset
        and apply the proceeds to the settlement waterfall in one
        atomic call — no separate withdraw, DEX hop, redeposit, or
        repay step needed. Capped at 3% slippage by the protocol; if
        every quote is worse than that, the transaction reverts and
        you can retry with fresher routing.
      </div>

      {status === 'loading' && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            fontSize: '0.85rem',
          }}
        >
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
          <span>
            No DEX returned a usable quote for this pair right now. You
            can refresh after a few seconds or fall back to the regular
            Repay surface above.
          </span>
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
          onClick={handleSubmit}
        >
          {submitting ? 'Submitting…' : 'Swap & repay'}
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
        Best quote: <strong>{best.expectedOutput.toString()}</strong> (raw
        base units){' '}
        <em style={{ opacity: 0.7 }}>via {KIND_LABEL[best.adapterKind]}</em>
      </div>
      {tail.length > 0 && (
        <div
          style={{ fontSize: '0.76rem', opacity: 0.7, marginTop: 4 }}
        >
          Fallback plan:{' '}
          {tail.map((q) => KIND_LABEL[q.adapterKind]).join(' → ')}
        </div>
      )}
      {quotes.failedKinds.length > 0 && (
        <div
          style={{ fontSize: '0.72rem', opacity: 0.55, marginTop: 4 }}
        >
          Unavailable: {quotes.failedKinds.map((k) => KIND_LABEL[k]).join(', ')}
        </div>
      )}
    </div>
  );
}
