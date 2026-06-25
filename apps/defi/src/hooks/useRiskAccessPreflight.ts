import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useDiamondRead, useReadChain } from "../contracts/useDiamond";

/**
 * #671 progressive risk access — accept-time preflight (#728 PR-2e).
 *
 * Sits in front of `acceptOffer`. Asks the Diamond's read-only
 * `RiskAccessFacet.previewOfferAcceptBlock(offerId, acceptor)` whether the
 * connected wallet would be BLOCKED by the progressive-risk gate if it accepted
 * `offerId` right now — and why. The on-chain gate (at loan initiation) is the
 * real boundary; this is a UX guard so the user sees the reason (and the fix)
 * before signing instead of eating an opaque revert.
 *
 * The view already folds in the master switch: it returns `0` (OK) when
 * `riskAccessGateEnabled` is off, so this hook is a silent no-op on deployments
 * where the gate isn't enforced. It is also idle when there is no connected
 * wallet or no offer selected.
 *
 * Block codes (mirror `RiskAccessFacet.previewOfferAcceptBlock`):
 *   0 = OK · 1 = tier too low · 2 = illiquid pair needs standing consent ·
 *   3 = strict-mode mid-tier pair needs a fresh explicit ack ·
 *   4 = #735 — illiquid pair, but the ACCEPTOR's standard #662 acknowledgement
 *       (always produced by the accept-signing flow) WILL clear it at sign-time.
 *       A SOFT, non-blocking warning: the user is taking on illiquid risk their
 *       acceptance signature acknowledges, NOT a block to resolve.
 */

export type RiskPreflightStatus =
  | "idle"
  | "loading"
  | "ok"
  | "tier-too-low"
  | "needs-illiquid-consent"
  | "illiquid-ack-covered"
  | "needs-midtier-ack"
  | "error";

const isMissingFacet = (e: unknown): boolean => {
  const msg = String(
    (e as { data?: string; message?: string })?.data ??
      (e as Error)?.message ??
      "",
  );
  return /function does not exist|functionnotfound|0xa9ad62f8/i.test(msg);
};

const CODE_TO_STATUS: Record<number, RiskPreflightStatus> = {
  0: "ok",
  1: "tier-too-low",
  2: "needs-illiquid-consent",
  3: "needs-midtier-ack",
  4: "illiquid-ack-covered",
};

// Copy is intentionally NEUTRAL about WHICH party is blocked: the on-chain
// preview checks the offer creator BEFORE the acceptor (Codex #734 P2), so a
// HARD block can mean the creator lost tier / consent after posting — telling the
// connected acceptor to "raise your tier" would be wrong in that case. The
// illiquid HARD copy (`needs-illiquid-consent`) does NOT promise the acceptance
// signature will clear it: that case is precisely the one the ack-aware preview
// (#735) now reports separately as the SOFT `illiquid-ack-covered` (code 4), so a
// remaining code 2 is a genuine block the signature can't heal (creator-side, a
// rental-prepay / depth-collapsed leg, or a stale anchor).
export const RISK_PREFLIGHT_REASON: Record<RiskPreflightStatus, string> = {
  idle: "",
  loading: "Checking the progressive-risk gate for this offer…",
  ok: "",
  "tier-too-low":
    "This offer's asset pair needs a higher risk tier than is currently set. If it's your vault, raise your tier in Risk Access settings; otherwise the offer can't be filled right now.",
  "needs-illiquid-consent":
    "This pair includes an illiquid asset that needs a per-pair consent the gate can't see right now — it may be the offer creator's consent that's missing or stale, or a standing consent this app can't record yet. The accept can't be completed until it's in place.",
  "illiquid-ack-covered":
    "This pair includes an illiquid asset. Your acceptance signature explicitly acknowledges it, so you can proceed — just be aware you're taking on an illiquid position that can't be priced or auto-liquidated.",
  "needs-midtier-ack":
    "This pair requires a strict-mode mid-tier acknowledgement that an acceptance signature doesn't cover. If it's your vault's requirement you can record it below; otherwise it's the offer creator's to record. Either way it isn't immediate — on a deployment with an opt-up cooldown it becomes effective only after that window (which a deployment may set up to 30 days), then re-open this offer to accept.",
  error: "Couldn't check the risk-access requirements right now.",
};

export interface RiskPreflight {
  status: RiskPreflightStatus;
  /** True only when the gate would actively block the accept (any reason). */
  blocked: boolean;
  /** A DEFINITE on-chain block the upcoming accept signature cannot be assumed to
   *  clear — used to disable the accept Confirm button. The HARD codes qualify
   *  (tier shortfall, illiquid standing-consent gap, strict-mode mid-tier ack):
   *  - tier / mid-tier ack: the #662 acceptance ack substitutes for neither.
   *  - illiquid (code 2): now a TRUE block — the ack-aware preview (#735) split out
   *    the self-healing case as the soft code 4, so a remaining code 2 is a gap the
   *    signature can't heal (creator-side, a rental-prepay / depth-collapsed leg,
   *    or a stale tier anchor). The on-chain gate remains the real boundary. */
  hardBlock: boolean;
  /** #735 — a SOFT, non-blocking warning (code 4): the pair is illiquid but the
   *  acceptor's standard #662 acknowledgement (produced by the accept-signing
   *  flow) clears the gate at sign-time. Confirm stays ENABLED; the UI shows the
   *  reason so the user knows they're taking on acknowledged illiquid risk. */
  softWarn: boolean;
  /** True while the check is still in flight — Confirm should stay disabled so a
   *  user can't sign before the (possibly blocking) verdict resolves. */
  pending: boolean;
  /** Human-readable reason + fix (empty for ok/idle). */
  reason: string;
  /** #735 r13 — re-run the preview. Call after recording a mid-tier ack/consent so
   *  a zero-cooldown clear lifts the hard block without closing/reopening the
   *  modal. */
  refresh: () => void;
}

export function useRiskAccessPreflight(
  offerId: bigint | null | undefined,
): RiskPreflight {
  const { address, isCorrectChain, activeChain } = useWallet();
  const diamondRo = useDiamondRead();
  const readChain = useReadChain();
  const [status, setStatus] = useState<RiskPreflightStatus>("idle");
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // Require an actual DEPLOYED Diamond on the wallet's chain, not just a
  // registered chain (`isCorrectChain` is true even for a supported-but-
  // undeployed chain, where the read would hit the zero-address sentinel —
  // Claude review #734 r2), AND that the read target is the wallet's chain (not
  // a public-dashboard view override — Codex #734 r6).
  const onDeployedChain =
    isCorrectChain &&
    !!activeChain?.diamondAddress &&
    readChain.chainId === activeChain.chainId;

  useEffect(() => {
    let cancelled = false;
    // Idle unless there's a connected wallet on a chain with a deployed Diamond:
    // otherwise `useDiamondRead` resolves to the default / a zero-address
    // deployment and the modal could show a different chain's verdict for an
    // accept that can't settle here.
    if (!address || offerId == null || !onDeployedChain) {
      setStatus("idle");
      return;
    }
    setStatus("loading");
    const ro = diamondRo as unknown as {
      previewOfferAcceptBlock: (
        offerId: bigint,
        acceptor: string,
      ) => Promise<number | bigint>;
    };
    ro.previewOfferAcceptBlock(offerId, address)
      .then((code) => {
        if (cancelled) return;
        setStatus(CODE_TO_STATUS[Number(code)] ?? "ok");
      })
      .catch((e) => {
        if (cancelled) return;
        // A Diamond that predates RiskAccessFacet is silently "ok" (the feature
        // isn't there). But a REAL read failure (transient RPC / chain error) on
        // a deployment where the gate IS live must NOT be silently swallowed —
        // surface "error" so the modal doesn't imply the accept is clear when it
        // wasn't actually checked (Codex #734 P2). Either way it doesn't BLOCK —
        // the on-chain gate stays the boundary.
        setStatus(isMissingFacet(e) ? "ok" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [address, offerId, onDeployedChain, diamondRo, nonce]);

  // The HARD codes block the accept; the soft `illiquid-ack-covered` (code 4) does
  // NOT — the accept-signing flow's #662 ack clears it at sign-time (#735).
  const hardBlock =
    status === "tier-too-low" ||
    status === "needs-illiquid-consent" ||
    status === "needs-midtier-ack";
  const softWarn = status === "illiquid-ack-covered";

  return {
    status,
    // `blocked` tracks the gate actively blocking the accept — the hard codes
    // only (code 4 self-heals, so it isn't a block).
    blocked: hardBlock,
    hardBlock,
    softWarn,
    pending: status === "loading",
    reason: RISK_PREFLIGHT_REASON[status],
    refresh,
  };
}
