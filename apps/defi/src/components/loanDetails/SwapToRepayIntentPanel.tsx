import { useEffect, useState } from 'react';
import { Sparkles, AlertTriangle, Loader2, X } from 'lucide-react';
import type { Address } from 'viem';
import { useWallet } from '../../context/WalletContext';
import { useChainOverride } from '../../context/ChainContext';
import { useDiamondContract } from '../../contracts/useDiamond';
import { decodeContractError } from '@vaipakam/lib/decodeContractError';
import { beginStep } from '../../lib/journeyLog';

/**
 * T-090 v1.1 (#389) Sub 3 (#418) — intent-based swap-to-repay
 * connected-app surface. Sibling to the atomic v1
 * `SwapToRepayPanel`.
 *
 * Flow:
 *   1. Borrower clicks "Commit best-price intent".
 *   2. Panel reads `canonicalExtension()` from the diamond.
 *   3. Builds `FusionOrderParams` (extension + salt + makerTraits
 *      with the bit pattern the v1.1 contract enforces).
 *   4. Submits `commitSwapToRepayIntent(loanId, params)`. The
 *      diamond pulls the collateral into custody, registers the
 *      orderHash, and approves Fusion's LimitOrderProtocol.
 *   5. Panel posts the structured order to `apps/agent`
 *      `POST /intent/fusion/post` for Fusion's resolver-pickup.
 *   6. While the auction runs, the panel shows the pending state
 *      (read back from indexer `/loans/:id` → `swapToRepayIntent`)
 *      with a cancel button gated on `now >= commit.deadline`.
 *
 * If the resolver fills the order, the on-chain `postInteraction`
 * runs the settlement waterfall atomically and the loan flips to
 * Repaid; the parent page's `onAfterSuccess` callback reloads and
 * the panel hides because the loan is no longer Active.
 *
 * If the auction expires without a fill, the borrower clicks
 * Cancel and the on-chain `cancelSwapToRepayIntent` returns the
 * custodial collateral to their vault.
 */

interface Props {
  loanId: bigint;
  chainId: number;
  collateralAsset: Address;
  collateralAmount: bigint;
  principalAsset: Address;
  /** Principal amount the borrower owes (post-interest); used as
   *  a takerAmount lower bound + sanity preview. */
  principalAmount: bigint;
  diamondAddress: Address;
  graceUntilSec: number;
  /** Effective auction-max-seconds from the on-chain config. The
   *  parent fetches this via the IntentConfigFacet getter; default
   *  600 (5 min) if the parent doesn't pass one (matches the
   *  documented Sub 1 default). */
  auctionMaxSec?: number;
  onAfterSuccess?: () => void | Promise<void>;
  actionLoading?: boolean;
  onActionLoadingChange?: (loading: boolean) => void;
}

const INDEXER_ORIGIN =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_INDEXER_ORIGIN ?? null;
const AGENT_ORIGIN =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_AGENT_ORIGIN ?? null;

// 1inch LOP v4 makerTraits bits — mirrors the Sub 1 contracts'
// internal constants. Borrower-side salt + traits construction
// follows the canonical layout `canonicalExtension()` validates
// against on-chain.
const HAS_EXTENSION_FLAG = BigInt(1) << BigInt(249);
const PRE_INTERACTION_FLAG = BigInt(1) << BigInt(252);
const POST_INTERACTION_FLAG = BigInt(1) << BigInt(251);
const NO_PARTIAL_FILLS_FLAG = BigInt(1) << BigInt(255);
// Expiration sub-field at bits 80-119 (uint40).
const EXPIRATION_SHIFT = BigInt(80);

interface LiveIntent {
  orderHash: string;
  committedBy: string;
  makerAmount: string;
  takerAmount: string;
  deadline: number;
  committedAt: number;
  committedTxHash: string;
}

export function SwapToRepayIntentPanel({
  loanId,
  chainId,
  collateralAsset,
  collateralAmount,
  principalAsset,
  principalAmount,
  diamondAddress,
  graceUntilSec,
  auctionMaxSec = 600,
  onAfterSuccess,
  actionLoading = false,
  onActionLoadingChange,
}: Props) {
  const { address, isCorrectChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const diamond = useDiamondContract();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveIntent, setLiveIntent] = useState<LiveIntent | null>(null);
  const [loadingIntent, setLoadingIntent] = useState(false);

  // Fetch live intent state from indexer.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!INDEXER_ORIGIN) return;
      setLoadingIntent(true);
      try {
        const res = await fetch(
          `${INDEXER_ORIGIN}/loans/${loanId}?chainId=${chainId}`,
        );
        if (!res.ok) return;
        const payload = await res.json();
        if (cancelled) return;
        setLiveIntent(payload.swapToRepayIntent ?? null);
      } catch {
        // Indexer unreachable → silently treat as "no live intent".
        // The borrower can still attempt a fresh commit; the on-chain
        // no-double-commit guard rejects it cleanly if one's live.
      } finally {
        if (!cancelled) setLoadingIntent(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [loanId, chainId]);

  const canWrite =
    !!address && isCorrectChain && !!diamond && viewChainId === null;

  // ───────────────────────────────────────────────────────────
  // Commit handler
  // ───────────────────────────────────────────────────────────
  async function handleCommit() {
    if (!canWrite || !diamond) return;
    setSubmitting(true);
    setError(null);
    onActionLoadingChange?.(true);
    const step = beginStep({
      area: 'repay',
      flow: 'commitSwapToRepayIntent',
      step: 'submit',
      loanId: Number(loanId),
    });
    try {
      // 1. Read canonical extension bytes from the diamond.
      const extension = (await (
        diamond as unknown as {
          canonicalExtension: () => Promise<`0x${string}`>;
        }
      ).canonicalExtension()) as `0x${string}`;

      // 2. Compute extensionHash + salt.
      // Salt's low 160 bits MUST equal uint160(uint256(keccak256(extension))).
      // The high 96 bits are free for nonce variation (different
      // borrowers / sessions vary them to keep makerTraits.nonceOrEpoch
      // unique per live commit).
      const extHash = await keccak256Hex(extension);
      const extHashBig = BigInt(extHash);
      const low160Mask = (BigInt(1) << BigInt(160)) - BigInt(1);
      const nonce = BigInt(Math.floor(Math.random() * 0xffffffff)); // 40-bit
      const saltHigh = nonce << BigInt(160);
      const salt = saltHigh | (extHashBig & low160Mask);

      // 3. Compute deadline + makerTraits.
      // Cap the auction at the chain's `cfgIntentMaxAuctionSeconds`
      // (default 600); never let it exceed `endTime + gracePeriod`
      // (the contract enforces both).
      const now = Math.floor(Date.now() / 1000);
      const desiredDeadline = now + auctionMaxSec;
      const deadline = Math.min(desiredDeadline, graceUntilSec);
      let makerTraits =
        HAS_EXTENSION_FLAG |
        PRE_INTERACTION_FLAG |
        POST_INTERACTION_FLAG |
        NO_PARTIAL_FILLS_FLAG;
      makerTraits |= BigInt(deadline) << EXPIRATION_SHIFT;
      // Embed the nonce in the nonceOrEpoch sub-field (bits 120-159)
      // so the contract's intentNonceUsed[nonce] uniqueness check
      // matches the salt's high bits.
      makerTraits |= (nonce & ((BigInt(1) << BigInt(40)) - BigInt(1))) << BigInt(120);

      // 4. Pick takerAmount — for the MVP we use the loan's
      // principal + 25% margin to clear the floor with comfortable
      // headroom. A future iteration reads
      // `IVaipakamPrepayContext.getPrepayContext` for the live
      // floor and lets the borrower pick a tighter min.
      const takerAmount = (principalAmount * BigInt(125)) / BigInt(100);

      interface FusionOrderParams {
        takerAmount: bigint;
        deadline: bigint;
        salt: bigint;
        makerTraits: bigint;
        extension: `0x${string}`;
      }
      const params: FusionOrderParams = {
        takerAmount,
        deadline: BigInt(deadline),
        salt,
        makerTraits,
        extension,
      };

      // 5. Submit the on-chain commit.
      const tx = await (
        diamond as unknown as {
          commitSwapToRepayIntent: (
            id: bigint,
            p: FusionOrderParams,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).commitSwapToRepayIntent(loanId, params);
      const commitTxHash = tx.hash;
      await tx.wait();

      // 6. Post the structured order to apps/agent so Fusion's
      // resolver-set picks it up. Best-effort — the on-chain commit
      // already landed; failure here just means the resolver auction
      // doesn't run and the order expires (the borrower can cancel
      // after deadline).
      if (AGENT_ORIGIN) {
        try {
          await fetch(`${AGENT_ORIGIN}/intent/fusion/post`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chainId,
              orderHash: extHash, // placeholder; real shape returned from chain logs
              commitTxHash,
              order: {
                maker: diamondAddress,
                receiver: diamondAddress,
                makerAsset: collateralAsset,
                takerAsset: principalAsset,
                makerAmount: collateralAmount.toString(),
                takerAmount: takerAmount.toString(),
                deadline,
                salt: salt.toString(),
                makerTraits: makerTraits.toString(),
                extension,
              },
            }),
          });
        } catch {
          // Best-effort. Continue.
        }
      }

      step.success({ note: `tx ${commitTxHash}` });
    } catch (err) {
      setError(decodeContractError(err, 'Intent commit failed'));
      step.failure(err);
    } finally {
      setSubmitting(false);
      onActionLoadingChange?.(false);
      if (onAfterSuccess) {
        try {
          await onAfterSuccess();
        } catch {
          /* parent's responsibility */
        }
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  // Cancel handler
  // ───────────────────────────────────────────────────────────
  async function handleCancel() {
    if (!canWrite || !diamond) return;
    setSubmitting(true);
    setError(null);
    onActionLoadingChange?.(true);
    try {
      const tx = await (
        diamond as unknown as {
          cancelSwapToRepayIntent: (id: bigint) => Promise<{
            hash: string;
            wait: () => Promise<unknown>;
          }>;
        }
      ).cancelSwapToRepayIntent(loanId);
      await tx.wait();
    } catch (err) {
      setError(decodeContractError(err, 'Cancel intent failed'));
    } finally {
      setSubmitting(false);
      onActionLoadingChange?.(false);
      if (onAfterSuccess) {
        try {
          await onAfterSuccess();
        } catch {
          /* parent's responsibility */
        }
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────
  const hasLiveIntent = !!liveIntent;
  const nowSec = Math.floor(Date.now() / 1000);
  const cancelEnabled = hasLiveIntent && nowSec >= (liveIntent?.deadline ?? 0);

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
        <Sparkles size={18} />
        <strong>Best-price intent (1inch Fusion)</strong>
      </div>
      <div style={{ fontSize: '0.82rem', opacity: 0.8 }}>
        Commit your collateral to a Fusion solver auction. A resolver
        competes to fill the order at the best available price; the
        diamond's postInteraction hook runs the canonical settlement
        waterfall atomically with the fill. Typically completes in
        1-2 minutes; if no resolver fills, you can cancel after the
        deadline and the custodial collateral returns to your vault.
      </div>

      {loadingIntent && (
        <div style={{ fontSize: '0.82rem', opacity: 0.7 }}>
          <Loader2 size={14} className="spin" /> Checking live intent…
        </div>
      )}

      {hasLiveIntent && liveIntent && (
        <div className="alert alert-info" style={{ fontSize: '0.82rem' }}>
          <div>
            <strong>Pending intent</strong> — deadline at{' '}
            {new Date(liveIntent.deadline * 1000).toLocaleString()}.
          </div>
          <div style={{ opacity: 0.7 }}>
            Order: {liveIntent.orderHash.slice(0, 10)}…
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error" style={{ fontSize: '0.82rem' }}>
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {!hasLiveIntent && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canWrite || submitting || actionLoading}
            onClick={handleCommit}
          >
            {submitting ? 'Submitting…' : 'Commit best-price intent'}
          </button>
        )}
        {hasLiveIntent && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!canWrite || submitting || actionLoading || !cancelEnabled}
            onClick={handleCancel}
            title={
              cancelEnabled
                ? 'Cancel the pending intent and return collateral to your vault'
                : 'Cancel opens after the Fusion auction deadline'
            }
          >
            <X size={12} /> Cancel & return collateral
          </button>
        )}
      </div>
    </div>
  );
}

// Lightweight keccak256 of a hex string using viem (already a
// transitive dep). Returns a 0x-prefixed bytes32.
async function keccak256Hex(hex: `0x${string}`): Promise<`0x${string}`> {
  const { keccak256 } = await import('viem');
  return keccak256(hex);
}
