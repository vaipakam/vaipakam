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
  /** Effective auction-max-seconds. The panel reads this live from
   *  the diamond via `IntentConfigFacet.getIntentAuctionSecondsBounds`
   *  on mount; parent can pass an initial value to avoid a frame
   *  flash when the chain query is in flight. Defaults to 600
   *  (matches the documented Sub 1 default) as a safe initial
   *  before the chain read returns (Codex round-1 PR #423 P2 —
   *  hardcoded 600 would reject every commit if governance
   *  lowered the cap). */
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

// Codex round-5 PR #430 P2 — pre-commit chain gate. Fusion only
// supports a fixed set of mainnet chains (mirror of the agent
// worker's `FUSION_SUPPORTED_CHAIN_IDS`). On any other chain the
// agent endpoint short-circuits to a queued-ack, so allowing the
// borrower to commit there just locks their collateral into
// custody with no chance of a Fusion fill. Disable the Commit
// button up-front + tell them why.
const FUSION_SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 8453, 42161, 10, 56, 137,
]);

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
  // Codex round-1 PR #423 P2 — refresh trigger so a successful
  // commit / cancel re-runs the live-intent fetch effect.
  const [refreshTick, setRefreshTick] = useState(0);
  // Codex round-3 PR #423 P2 — when the panel optimistically sets
  // `liveIntent` after a successful commit (because the indexer
  // hasn't ingested the event yet), the refresh effect's
  // immediate re-fetch would otherwise clear the optimistic
  // pending row back to null. Track the optimistic-set state +
  // suppress the null-clear until the indexer catches up.
  const [optimisticPending, setOptimisticPending] = useState(false);
  // Codex round-1 PR #423 P2 — render-time tick so the cancel
  // button enables itself the moment `liveIntent.deadline` is
  // crossed (without depending on an unrelated re-render).
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  // Codex round-1 PR #423 P2 — read the live auction-max bound
  // from the diamond so the panel adapts when governance rotates
  // the knob.
  const [liveAuctionMaxSec, setLiveAuctionMaxSec] = useState(auctionMaxSec);
  // Codex round-5 PR #423 P2 — same for the min-output buffer.
  // Default 200 bps mirrors the documented Sub 1 default.
  const [liveBufferBps, setLiveBufferBps] = useState(200);

  // Fetch live intent state from indexer (primary) with on-chain
  // fallback (Codex round-5 P2 — when `VITE_INDEXER_ORIGIN` is
  // unset or 5xx, read directly from the diamond's
  // `getIntentCommit` view so the borrower still has a cancel
  // surface after a page reload). Re-runs on commit / cancel via
  // the `refreshTick` bump + polls every 15s while the panel is
  // mounted so a resolver-fill or force-cancel that happens
  // minutes later is observed without a manual reload.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingIntent(true);
      let indexerIntent: LiveIntent | null = null;
      let indexerOk = false;
      if (INDEXER_ORIGIN) {
        try {
          const res = await fetch(
            `${INDEXER_ORIGIN}/loans/${loanId}?chainId=${chainId}`,
          );
          if (res.ok) {
            const payload = await res.json();
            indexerIntent = payload.swapToRepayIntent ?? null;
            indexerOk = true;
          }
        } catch {
          // Fall through to on-chain fallback below.
        }
      }
      if (cancelled) return;
      // On-chain fallback (Codex round-5 P2 #4) — if the indexer
      // is unset / down / 5xx, read directly from the diamond.
      // The view returns an empty/zero struct when no commit is
      // live; treat that as null.
      if (!indexerOk && diamond) {
        try {
          // Codex round-6 PR #423 P2 — getIntentCommit returns
          // the `FusionOrderRead` struct shape:
          // (maker, receiver, makerAsset, takerAsset, makerAmount,
          //  takerAmount, deadline, salt, makerTraits, extension).
          // No orderHash / committedBy / committedAt on the view —
          // the view reverts when no commit is live. We compute a
          // placeholder orderHash locally (extension hash) just
          // for display + populate committedBy with the connected
          // address as a best-guess for the panel's pending-state
          // rendering. The indexer's row replaces all this once
          // it catches up; for the "indexer down" fallback the
          // borrower's primary need is the cancel button which
          // doesn't depend on these fields.
          const fr = (await (
            diamond as unknown as {
              getIntentCommit: (id: bigint) => Promise<{
                makerAmount: bigint;
                takerAmount: bigint;
                deadline: bigint;
                extension: `0x${string}`;
              }>;
            }
          ).getIntentCommit(loanId)) as {
            makerAmount: bigint;
            takerAmount: bigint;
            deadline: bigint;
            extension: `0x${string}`;
          };
          // Reverts on no-commit → we won't reach here if no
          // commit is live. When we do, populate the projection
          // from what's available.
          const { keccak256: kc } = await import('viem');
          indexerIntent = {
            orderHash: kc(fr.extension),
            committedBy: (address ?? '').toLowerCase(),
            makerAmount: fr.makerAmount.toString(),
            takerAmount: fr.takerAmount.toString(),
            deadline: Number(fr.deadline),
            committedAt: 0,
            committedTxHash: '',
          };
          indexerOk = true;
        } catch {
          // View reverts (no commit live) → leave indexerIntent null.
          // Mark indexerOk=true so the round-3 "trust the indexer"
          // gate below null-clears the panel correctly.
          indexerOk = true;
        }
      }
      if (cancelled) return;
      if (indexerIntent) {
        setLiveIntent(indexerIntent);
        setOptimisticPending(false);
      } else if (indexerOk && !optimisticPending) {
        // Indexer (or chain) was queried successfully + returned
        // no commit → trust it. Don't null-clear when we couldn't
        // reach either source — preserve any optimistic state.
        setLiveIntent(null);
      }
      setLoadingIntent(false);
    }
    void load();
    // Codex round-5 PR #423 P2 #5 — poll every 15s while mounted
    // so a resolver fill or force-cancel updates the panel
    // without a manual reload. 15s is a reasonable trade-off
    // between freshness + indexer load.
    const id = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loanId, chainId, refreshTick, optimisticPending, diamond]);

  // Codex round-1 PR #423 P2 — read live auction-max bound from
  // the diamond's `IntentConfigFacet`. Best-effort; falls back to
  // the prop default if the read fails.
  // Codex round-5 PR #423 P2 — additionally read live
  // `cfgIntentMinOutputBufferBps` so the panel adapts when
  // governance rotates the buffer above the documented 200 bps
  // default (setter caps at 2500 bps).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!diamond) return;
      try {
        const bounds = (await (
          diamond as unknown as {
            getIntentAuctionSecondsBounds: () => Promise<[bigint, bigint]>;
          }
        ).getIntentAuctionSecondsBounds()) as [bigint, bigint] | undefined;
        if (!cancelled && bounds) setLiveAuctionMaxSec(Number(bounds[1]));
      } catch {
        // Use the prop default.
      }
      try {
        const buf = (await (
          diamond as unknown as {
            getIntentMinOutputBufferBps: () => Promise<bigint>;
          }
        ).getIntentMinOutputBufferBps()) as bigint | undefined;
        if (!cancelled && typeof buf === 'bigint') {
          setLiveBufferBps(Number(buf));
        }
      } catch {
        // Use the documented default (200 bps).
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [diamond]);

  // Codex round-1 PR #423 P2 — keep `nowSec` fresh so the cancel
  // button enables itself the moment `liveIntent.deadline` is
  // crossed. 1-second tick is plenty for the human-perceived
  // window; cleaned up on unmount.
  useEffect(() => {
    const id = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

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
      // Codex round-1 PR #423 P2 — use the full uint40 nonce
      // space the contract's `intentNonceUsed` slot covers. Math.random's
      // 32-bit space hits ~50% birthday collision at ~77k commits;
      // mixing two random words pushes that to ~1.4M commits.
      const noncePart1 = BigInt(Math.floor(Math.random() * 0xffffffff));
      const noncePart2 = BigInt(Math.floor(Math.random() * 0xffff));
      const nonce =
        ((noncePart2 << BigInt(32)) | noncePart1) &
        ((BigInt(1) << BigInt(40)) - BigInt(1));
      const saltHigh = nonce << BigInt(160);
      const salt = saltHigh | (extHashBig & low160Mask);

      // 3. Compute deadline + makerTraits.
      // Cap the auction at the chain's `cfgIntentMaxAuctionSeconds`
      // (default 600); never let it exceed `endTime + gracePeriod`
      // (the contract enforces both).
      const now = Math.floor(Date.now() / 1000);
      // Use the live `liveAuctionMaxSec` read from the chain
      // (round-1 P2 fix); prop value is the initial fallback.
      const desiredDeadline = now + liveAuctionMaxSec;
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

      // 4. Pick takerAmount.
      // Codex round-2 PR #423 P2 — the contract's commit check
      // compares the borrower-supplied `takerAmount` against the
      // live settlement floor: principal + accrued interest +
      // treasury / preclose fees + late fee + the configured
      // buffer BPS. For high-APR / long-running / late loans
      // that floor can exceed `principal × 125%`, making every
      // commit revert with `IntentMinOutputBelowFloor` until the
      // user manually retries.
      //
      // Read the live floor via `getPrepayContext(loanId)` —
      // returns the canonical settlement legs the postInteraction
      // check uses — and add the configured buffer + a small
      // safety margin (~2% on top) to absorb 1-2 blocks of
      // additional interest accrual between read + commit-tx
      // inclusion.
      // Codex round-3 PR #423 P2 — call `getPrepayContext` with
      // its real shape: `(loanId, asOfTimestamp)` returns a
      // `PrepayContext` struct with `lenderLeg` + `treasuryLeg`
      // (no `lateFee` field — the on-chain intent code computes
      // it separately from loan state). Round-2's call shape
      // (1-arg + reading `lateFee`) would throw at the viem read
      // layer and silently drop through to the principal × 125%
      // fallback, which is exactly what round-2 set out to fix.
      let liveFloor: bigint;
      try {
        const ctx = (await (
          diamond as unknown as {
            getPrepayContext: (
              id: bigint,
              asOf: bigint,
            ) => Promise<{ lenderLeg: bigint; treasuryLeg: bigint }>;
          }
        ).getPrepayContext(loanId, BigInt(now))) as {
          lenderLeg: bigint;
          treasuryLeg: bigint;
        };
        // Codex round-6 PR #423 P2 — the contract floor is
        //   (lenderLeg + treasuryLeg + lateFee) × (1 + cfgBuffer)
        // not
        //   (lenderLeg + treasuryLeg) × (1 + cfgBuffer + lateFeeMarginBps)
        // Round-5's additive form under-shoots once cfgBuffer is
        // near the 2500 bps cap + lateFee is at the 5% cap: floor
        // ≈ 2.62 × base, our formula ≈ 1.31 × base → reverts.
        //
        // Correct formula: add the WORST-CASE lateFee (5% of
        // principal) to the base inside the multiplier, then
        // apply the live cfgBuffer (live read) + a small accrual
        // margin (~1%) for blocks-between-read-and-tx. Always
        // over-estimates; never under-estimates.
        const estimatedLateFee = (principalAmount * BigInt(500)) / BigInt(10_000);
        const protocolBufferBps = BigInt(liveBufferBps);
        const accrualMarginBps = BigInt(100);
        const totalBufferBps = protocolBufferBps + accrualMarginBps;
        const baseFloor = ctx.lenderLeg + ctx.treasuryLeg + estimatedLateFee;
        liveFloor =
          (baseFloor * (BigInt(10_000) + totalBufferBps)) / BigInt(10_000);
      } catch {
        // Fallback: principal × 125%. Mirrors the round-0
        // behaviour for low-APR / fresh loans where the floor
        // approximates principal.
        liveFloor = (principalAmount * BigInt(125)) / BigInt(100);
      }
      const takerAmount = liveFloor;

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
      const receipt = (await tx.wait()) as
        | { logs: { topics: string[] }[] }
        | undefined;

      // Codex round-4 PR #423 P2 — extract the CANONICAL orderHash
      // from the `SwapToRepayIntentCommitted` event log. The
      // contract registers + emits a hash derived from the salt,
      // maker/receiver/assets, amounts, makerTraits, and LOP
      // domain separator — NOT the extension keccak we used to
      // bind the salt. Sending the wrong hash to the agent +
      // Fusion would mean ERC-1271 staticcall returns
      // `0xffffffff` for every resolver pickup attempt → no
      // resolver fills, order expires.
      const { keccak256, toBytes } = await import('viem');
      const committedTopic0 = keccak256(
        toBytes(
          'SwapToRepayIntentCommitted(uint256,bytes32,address,uint256,uint256,uint64)',
        ),
      );
      let canonicalOrderHash: `0x${string}` = extHash; // fallback
      if (receipt?.logs) {
        for (const lg of receipt.logs) {
          if (lg.topics?.[0]?.toLowerCase() === committedTopic0.toLowerCase()) {
            // topics[2] is the indexed orderHash field.
            if (lg.topics[2]) {
              canonicalOrderHash = lg.topics[2] as `0x${string}`;
              break;
            }
          }
        }
      }

      // 6. Post the structured order to apps/agent so Fusion's
      // resolver-set picks it up. Best-effort — the on-chain commit
      // already landed; failure here just means the resolver auction
      // doesn't run and the order expires (the borrower can cancel
      // after deadline).
      if (AGENT_ORIGIN) {
        try {
          // Codex round-2 PR #430 P2 — surface upstream Fusion
          // pickup failures to the borrower. The on-chain commit
          // already locked their collateral in custody; if the
          // Fusion-side post fails (queued-ack from a
          // pre-rotation worker, 4xx from a rejected payload,
          // 5xx from Fusion), the borrower needs to know so they
          // can cancel after deadline instead of waiting for a
          // fill that won't arrive.
          const res = await fetch(`${AGENT_ORIGIN}/intent/fusion/post`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chainId,
              orderHash: canonicalOrderHash,
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
          if (!res.ok) {
            setError(
              `On-chain commit succeeded, but the Fusion resolver-pickup post failed (HTTP ${res.status}). Your collateral is in protocol custody; cancel after the auction deadline to recover.`,
            );
          } else {
            const body = (await res.json().catch(() => null)) as
              | { status?: string; note?: string }
              | null;
            if (body?.status === 'queued' && body?.note) {
              setError(
                `On-chain commit succeeded, but Fusion-side pickup is in a degraded state: ${body.note}`,
              );
            }
          }
        } catch (err) {
          setError(
            `On-chain commit succeeded, but the Fusion resolver-pickup post failed: ${
              err instanceof Error ? err.message : String(err)
            }. Your collateral is in protocol custody; cancel after the auction deadline to recover.`,
          );
        }
      }

      // Codex round-2 PR #423 P2 — optimistically populate
      // `liveIntent` from the committed params. Without this, an
      // indexer that hasn't yet ingested `SwapToRepayIntentCommitted`
      // by the one immediate `refreshTick` re-fetch leaves the
      // panel showing the commit button as if nothing happened —
      // even though the collateral is already in diamond custody.
      // The refresh effect below replaces this row with the
      // canonical indexer-sourced one once the indexer catches up.
      setLiveIntent({
        // Real canonical orderHash extracted from the receipt
        // log above (Codex round-4 P2). Falls back to extHash
        // only if topic extraction fails — the indexer's row
        // will replace it on next tick either way.
        orderHash: canonicalOrderHash,
        committedBy: (address ?? '').toLowerCase(),
        makerAmount: collateralAmount.toString(),
        takerAmount: takerAmount.toString(),
        deadline,
        committedAt: Math.floor(Date.now() / 1000),
        committedTxHash: commitTxHash,
      });
      // Codex round-3 PR #423 P2 — flag the optimistic set so
      // the refresh effect doesn't immediately null-clear when
      // the indexer hasn't ingested yet.
      setOptimisticPending(true);
      step.success({ note: `tx ${commitTxHash}` });
    } catch (err) {
      setError(decodeContractError(err, 'Intent commit failed'));
      step.failure(err);
    } finally {
      setSubmitting(false);
      onActionLoadingChange?.(false);
      // Codex round-1 PR #423 P2 — bump the refresh tick so the
      // panel re-fetches its own live-intent state. The parent's
      // `onAfterSuccess` reloads the loan but doesn't re-mount
      // this panel; without the bump the effect's deps don't
      // change and the UI keeps showing "Commit best-price intent".
      setRefreshTick((t) => t + 1);
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
      // Codex round-4 PR #423 P2 — clear ONLY on success path.
      // A revert at `tx.wait()` (too early / wrong NFT holder /
      // RPC timeout) still has the on-chain commit alive; the
      // borrower needs the cancel surface to stay so they can
      // retry. Round-3 had this in `finally` which would clear
      // the panel on any failure including transient RPC ones.
      setLiveIntent(null);
      setOptimisticPending(false);
    } catch (err) {
      setError(decodeContractError(err, 'Cancel intent failed'));
    } finally {
      setSubmitting(false);
      onActionLoadingChange?.(false);
      setRefreshTick((t) => t + 1);
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
        waterfall atomically with the fill. If no resolver fills, you
        can cancel after the deadline and the custodial collateral
        returns to your vault.
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

      {/* Codex round-6 PR #430 P1 + P2 — commit is disabled until
          the v1.2 quoteId work + the agent-origin requirement are
          both addressed. Three independent disable reasons; the
          alert text explains which one applies.

          Codex round-7 PR #430 P2 — keep this warning visible for
          live-intent borrowers too. Their existing commit is also
          expected not to fill until #431, so they need the same
          "use cancel-after-deadline" framing even though the
          Commit button is hidden in their state. */}
      <div className="alert alert-warning" style={{ fontSize: '0.82rem' }}>
        <AlertTriangle size={14} />
        <span>
          {!FUSION_SUPPORTED_CHAIN_IDS.has(chainId) ? (
            <>
              1inch Fusion does not support chain {chainId}.
              {hasLiveIntent ? (
                <>
                  {' '}
                  Your existing commit can only be resolved via the
                  cancel-after-deadline path; no resolver fill will
                  arrive on this chain.
                </>
              ) : (
                <>
                  {' '}
                  A commit here would lock your collateral with no
                  chance of a resolver fill. Use the atomic
                  swap-to-repay above instead.
                </>
              )}
            </>
          ) : !AGENT_ORIGIN ? (
            <>
              The Vaipakam agent worker URL is not configured in this
              build.
              {hasLiveIntent ? (
                <>
                  {' '}
                  Your existing commit is best resolved via the
                  cancel-after-deadline path.
                </>
              ) : (
                <>
                  {' '}
                  Use the atomic swap-to-repay above instead.
                </>
              )}
            </>
          ) : (
            <>
              The 1inch Fusion resolver-pickup wire submits orders
              without the `quoteId` field that Fusion requires, so
              upstream is expected to reject every commit until the
              v1.2 follow-up (issue #431) patches the bridge.
              {hasLiveIntent ? (
                <>
                  {' '}
                  Your existing commit is expected NOT to fill;
                  cancel after the deadline to return custodial
                  collateral to your vault.
                </>
              ) : (
                <>
                  {' '}
                  Commit is disabled to avoid locking collateral
                  that would only ever recover via the
                  cancel-after-deadline path. Use the atomic
                  swap-to-repay above instead; this surface
                  re-enables when #431 lands.
                </>
              )}
            </>
          )}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {!hasLiveIntent && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={
              !canWrite ||
              submitting ||
              actionLoading ||
              !FUSION_SUPPORTED_CHAIN_IDS.has(chainId) ||
              !AGENT_ORIGIN
              // T-090 v1.2 #431 — the round-0 hard-disable is
              // gone now that the agent worker submits to the
              // LOP orderbook endpoint (no quoteId required)
              // instead of Fusion v2's resolver-pickup.
            }
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
