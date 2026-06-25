import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useDiamondRead, useDiamondContract, useReadChain } from "../contracts/useDiamond";
import { beginStep } from "../lib/journeyLog";

/**
 * #735 item 3 — shared strict-mode mid-tier acknowledgement gate.
 *
 * The progressive-risk gate (#671) requires a strict-mode vault to hold a fresh,
 * deliberate per-pair acknowledgement for every MID-TIER (liquid-but-not-blue-
 * chip) pair it transacts — enforced at BOTH offer creation (`OfferCreateFacet`)
 * and accept (`LoanFacet`). An ordinary acceptance signature does NOT cover it.
 *
 * This hook is the single source for "is the connected wallet blocked on a
 * mid-tier acknowledgement for THIS pair, and how does it record one?", reused by
 * the create flow (gating the creator) and the accept flow (gating the acceptor).
 * It reads the contract's own `midTierStrictBlocked(wallet, pair)` predicate — so
 * it is correct on every deployment (false when the gate is off, when the pair
 * isn't mid-tier, or when a fresh ack already exists) and, crucially, it tells the
 * accept flow whether the connected wallet is actually the blocked party: a code-3
 * accept block can be the OFFER CREATOR's missing ack, which the acceptor cannot
 * clear, so the recorder must only be offered when `blocked` is true here.
 */

export interface RiskPairId {
  lendAsset: string;
  /** 0 = ERC20, 1 = ERC721, 2 = ERC1155. */
  lendType: number;
  lendTokenId: bigint;
  collAsset: string;
  collType: number;
  collTokenId: bigint;
  /** NFT-rental prepayment token; zero address for non-rentals. */
  prepayAsset: string;
}

export interface MidTierAckGate {
  /** True when the contract reports the connected wallet must record a fresh
   *  mid-tier acknowledgement for this exact pair before it can transact it. */
  blocked: boolean;
  /** False while the read is in flight or after it failed — `blocked` is then not
   *  authoritative (don't imply "all clear" on a failed read). */
  known: boolean;
  /** True when the connected wallet's effective tier does NOT cover this pair —
   *  i.e. recording the mid-tier ack alone won't unblock, the tier must be raised
   *  first. The create gate checks tier BEFORE the mid-tier ack, so the create
   *  flow must surface this rather than presenting the ack as the fix (Codex #740
   *  r4). The accept flow doesn't consume this (its preview already returns the
   *  tier-too-low code ahead of the mid-tier code). */
  tierTooLow: boolean;
  /** False while the tier reads are in flight or failed — `tierTooLow` unknown. */
  tierKnown: boolean;
  recording: boolean;
  recorded: boolean;
  error: string | null;
  /** Record the acknowledgement (`setMidTierPairAck`) for this pair. */
  record: () => Promise<void>;
  /** Re-read the block predicate (e.g. after recording on a zero-cooldown chain). */
  refresh: () => void;
}

const isMissingFacet = (e: unknown): boolean => {
  const msg = String(
    (e as { data?: string; message?: string })?.data ??
      (e as Error)?.message ??
      "",
  );
  return /function does not exist|functionnotfound|0xa9ad62f8/i.test(msg);
};

/**
 * #735 item 3 — resolve the EXACT pair an accept of `offerId` is gated against,
 * reading the contract's `acceptMidTierAckPair(offerId)`. A lender-sale vehicle
 * gates the buyer against the SOLD LOAN's pair (not the sale offer's own surface),
 * which the dapp can't construct itself (the `saleOfferToLoanId` mapping isn't a
 * public getter) — so the resolution happens on-chain and the dapp feeds the
 * result into {useMidTierAckGate}. Returns null while loading / when unsupported,
 * or `'unknown'` on a real read failure so callers can avoid acting on a bad pair.
 */
export function useAcceptMidTierPair(
  offerId: bigint | null | undefined,
): RiskPairId | null | "unknown" {
  const { address, isCorrectChain, activeChain } = useWallet();
  const diamondRo = useDiamondRead();
  const readChain = useReadChain();
  const [pair, setPair] = useState<RiskPairId | null | "unknown">(null);

  const onDeployedChain =
    isCorrectChain &&
    !!activeChain?.diamondAddress &&
    readChain.chainId === activeChain.chainId;

  useEffect(() => {
    let cancelled = false;
    if (offerId == null || !address || !onDeployedChain) {
      setPair(null);
      return;
    }
    const ro = diamondRo as unknown as {
      acceptMidTierAckPair: (offerId: bigint) => Promise<{
        lendAsset: string;
        lendType: number | bigint;
        lendTokenId: bigint;
        collAsset: string;
        collType: number | bigint;
        collTokenId: bigint;
        prepayAsset: string;
      }>;
    };
    ro.acceptMidTierAckPair(offerId)
      .then((p) => {
        if (cancelled) return;
        setPair({
          lendAsset: p.lendAsset,
          lendType: Number(p.lendType),
          lendTokenId: BigInt(p.lendTokenId),
          collAsset: p.collAsset,
          collType: Number(p.collType),
          collTokenId: BigInt(p.collTokenId),
          prepayAsset: p.prepayAsset,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        // A Diamond predating the view ⇒ no gate to satisfy ⇒ null (no recorder).
        // A real read failure ⇒ 'unknown' so the caller doesn't act on a bad pair.
        setPair(isMissingFacet(e) ? null : "unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [offerId, address, onDeployedChain, diamondRo]);

  return pair;
}

export function useMidTierAckGate(pair: RiskPairId | null): MidTierAckGate {
  const { address, isCorrectChain, activeChain } = useWallet();
  const diamondRo = useDiamondRead();
  const diamondRw = useDiamondContract();
  const readChain = useReadChain();
  const [blocked, setBlocked] = useState(false);
  const [known, setKnown] = useState(false);
  const [tierTooLow, setTierTooLow] = useState(false);
  const [tierKnown, setTierKnown] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Only read on a chain that actually has a deployed Diamond AND is the wallet's
  // own chain (not a public-dashboard view override) — mirrors useRiskAccess.
  const onDeployedChain =
    isCorrectChain &&
    !!activeChain?.diamondAddress &&
    readChain.chainId === activeChain.chainId;

  // Stable key so the effect doesn't re-fire on every render from the object
  // identity of `pair`.
  const pairKey = pair
    ? `${pair.lendAsset}:${pair.lendType}:${pair.lendTokenId}:${pair.collAsset}:${pair.collType}:${pair.collTokenId}:${pair.prepayAsset}`
    : null;

  useEffect(() => {
    let cancelled = false;
    if (!address || !pair || !onDeployedChain) {
      setBlocked(false);
      setKnown(false);
      setTierTooLow(false);
      setTierKnown(false);
      return;
    }
    // Reset every verdict to UNKNOWN before the new reads resolve. Otherwise a
    // transition from a previously-CLEAR pair (known=true, blocked=false) would
    // briefly carry that verdict onto the NEW pair until the async reads land —
    // and since the create submit enables on a clear verdict, a create could slip
    // through for an as-yet-unverified pair (Codex #740 r3/r4).
    setKnown(false);
    setBlocked(false);
    setTierKnown(false);
    setTierTooLow(false);
    const ro = diamondRo as unknown as {
      midTierStrictBlocked: (vault: string, p: RiskPairId) => Promise<boolean>;
      pairRequiredRiskLevel: (p: RiskPairId) => Promise<number | bigint>;
      getEffectiveRiskTier: (vault: string) => Promise<number | bigint>;
      getRiskAccessGateEnabled: () => Promise<boolean>;
    };
    // Mid-tier ack verdict.
    ro.midTierStrictBlocked(address, pair)
      .then((v) => {
        if (cancelled) return;
        setBlocked(Boolean(v));
        setKnown(true);
      })
      .catch((e) => {
        if (cancelled) return;
        // A Diamond predating RiskAccessFacet means the gate isn't there ⇒ not
        // blocked. A real read failure leaves it UNKNOWN (don't imply "clear").
        if (isMissingFacet(e)) {
          setBlocked(false);
          setKnown(true);
        } else {
          setBlocked(false);
          setKnown(false);
        }
      });
    // Tier-vs-pair-requirement verdict (Codex #740 r4): the create gate checks the
    // creator's tier BEFORE the mid-tier ack, so recording the ack alone can't
    // unblock a still-under-tiered wallet. Compare the pair's required level with
    // the wallet's EFFECTIVE tier (read-time re-locked) — BUT only when the master
    // switch is ON. With the gate off, `OfferCreateFacet` skips the risk assert
    // entirely, so a non-blue-chip pair on a default-tier vault creates fine and
    // must NOT be reported tier-too-low (Codex #740 r5 P1 — otherwise the gate-off
    // retail deploy can't create any non-blue-chip offer).
    Promise.all([
      ro.pairRequiredRiskLevel(pair),
      ro.getEffectiveRiskTier(address),
      ro.getRiskAccessGateEnabled(),
    ])
      .then(([req, eff, gateOn]) => {
        if (cancelled) return;
        setTierTooLow(Boolean(gateOn) && Number(eff) < Number(req));
        setTierKnown(true);
      })
      .catch((e) => {
        if (cancelled) return;
        // Missing facet ⇒ no gate ⇒ tier can't be too low. Real failure ⇒ unknown.
        if (isMissingFacet(e)) {
          setTierTooLow(false);
          setTierKnown(true);
        } else {
          setTierTooLow(false);
          setTierKnown(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // pairKey captures the pair's value identity; address/chain/nonce re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, pairKey, onDeployedChain, diamondRo, nonce]);

  // Full identity the recorded/in-flight state is bound to: the pair AND the
  // connected wallet AND the chain. A change to ANY of them must reset the
  // per-acknowledgement state (a recorded ack belongs to one vault on one chain
  // for one pair) and invalidate an in-flight record's completion (Codex #740
  // r2/r4 — e.g. switching accounts mid-mine must not stamp the new vault).
  const identity = `${address ?? ""}:${readChain.chainId ?? ""}:${pairKey ?? ""}`;

  useEffect(() => {
    setRecorded(false);
    setError(null);
    // Also clear the in-flight flag for the NEW context: an old, still-pending
    // record tx belongs to the previous identity and can no longer apply here, so
    // the new context's recorder must not stay disabled behind it (Codex #740 r5).
    setRecording(false);
  }, [identity]);

  const identityRef = useRef<string>(identity);
  identityRef.current = identity;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const record = useCallback(async () => {
    if (!pair) return;
    const startedIdentity = identity;
    const stillSameContext = () => identityRef.current === startedIdentity;
    const step = beginStep({
      area: "profile",
      flow: "setMidTierPairAck",
      step: "record",
      wallet: address ?? undefined,
    });
    setRecording(true);
    setError(null);
    try {
      const rw = diamondRw as unknown as {
        setMidTierPairAck: (
          p: RiskPairId,
        ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
      };
      const tx = await rw.setMidTierPairAck(pair);
      await tx.wait();
      step.success();
      // The form may have moved to a different pair — or the user may have
      // switched wallet/chain — while the tx was mining; don't stamp that new
      // context as recorded / trigger its re-read off this result.
      if (!stillSameContext()) return;
      setRecorded(true);
      // Re-read: on a zero-cooldown deployment the block clears immediately; on a
      // cooldown deployment it stays blocked until the cooldown elapses.
      setNonce((n) => n + 1);
    } catch (e) {
      step.failure(e);
      if (!stillSameContext()) return;
      setError((e as Error).message);
    } finally {
      // Only clear the busy flag if the context is unchanged. If it changed, the
      // identity-reset effect already cleared it for the new context (and a fresh
      // record there may have set it true again — don't stomp that).
      if (stillSameContext()) setRecording(false);
    }
  }, [pair, identity, address, diamondRw]);

  return {
    blocked,
    known,
    tierTooLow,
    tierKnown,
    recording,
    recorded,
    error,
    record,
    refresh,
  };
}
