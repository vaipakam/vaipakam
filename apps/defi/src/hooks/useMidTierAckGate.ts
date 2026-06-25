import { useCallback, useEffect, useState } from "react";
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

export function useMidTierAckGate(pair: RiskPairId | null): MidTierAckGate {
  const { address, isCorrectChain, activeChain } = useWallet();
  const diamondRo = useDiamondRead();
  const diamondRw = useDiamondContract();
  const readChain = useReadChain();
  const [blocked, setBlocked] = useState(false);
  const [known, setKnown] = useState(false);
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
      return;
    }
    const ro = diamondRo as unknown as {
      midTierStrictBlocked: (
        vault: string,
        p: RiskPairId,
      ) => Promise<boolean>;
    };
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
    return () => {
      cancelled = true;
    };
    // pairKey captures the pair's value identity; address/chain/nonce re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, pairKey, onDeployedChain, diamondRo, nonce]);

  // Reset the recorded/error state whenever the pair or wallet changes: `recorded`
  // is per-acknowledgement, not per-hook, so in a long-lived create form a user who
  // records an ack for one pair and then edits to a different (still-blocked) pair
  // must see the recorder again rather than the stale "recorded" branch (Codex
  // #740 r2). Keyed on `pairKey` (the pair's value identity) + `address`.
  useEffect(() => {
    setRecorded(false);
    setError(null);
  }, [pairKey, address]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const record = useCallback(async () => {
    if (!pair) return;
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
      setRecorded(true);
      // Re-read: on a zero-cooldown deployment the block clears immediately; on a
      // cooldown deployment it stays blocked until the cooldown elapses.
      setNonce((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
      step.failure(e);
    } finally {
      setRecording(false);
    }
  }, [pair, address, diamondRw]);

  return { blocked, known, recording, recorded, error, record, refresh };
}
