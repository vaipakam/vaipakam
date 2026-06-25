import { useEffect, useState } from "react";
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
 * Block codes (mirror `LibRiskAccess.previewActorBlock`):
 *   0 = OK · 1 = tier too low · 2 = illiquid pair needs standing consent ·
 *   3 = strict-mode mid-tier pair needs a fresh explicit ack.
 */

export type RiskPreflightStatus =
  | "idle"
  | "loading"
  | "ok"
  | "tier-too-low"
  | "needs-illiquid-consent"
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
};

// Copy is intentionally NEUTRAL about WHICH party is blocked: the on-chain
// preview checks the offer creator BEFORE the acceptor (Codex #734 P2), so a
// block can mean the creator lost tier / consent after posting — telling the
// connected acceptor to "raise your tier" would be wrong in that case. It is
// also #662-aware: a direct accept signs an acknowledgement that already
// satisfies the acceptor's illiquid-pair consent for most assets, so the
// illiquid case is framed as "usually handled by your acceptance" rather than a
// hard, separate step (Codex #734 P2).
export const RISK_PREFLIGHT_REASON: Record<RiskPreflightStatus, string> = {
  idle: "",
  loading: "Checking the progressive-risk gate for this offer…",
  ok: "",
  "tier-too-low":
    "This offer's asset pair needs a higher risk tier than is currently set. If it's your vault, raise your tier in Risk Access settings; otherwise the offer can't be filled right now.",
  "needs-illiquid-consent":
    "This pair includes an illiquid asset. Accepting usually covers it via your acceptance signature; if it doesn't, a standing per-pair consent is required that this app can't record yet (it may also be the offer creator's consent that's missing).",
  "needs-midtier-ack":
    "This pair requires a strict-mode mid-tier acknowledgement that an acceptance signature doesn't cover, and that this app can't record yet.",
  error: "Couldn't check the risk-access requirements right now.",
};

export interface RiskPreflight {
  status: RiskPreflightStatus;
  /** True only when the gate would actively block the accept (any reason). */
  blocked: boolean;
  /** A DEFINITE on-chain block regardless of the acceptance signature — a tier
   *  shortfall or a strict-mode mid-tier ack. (Illiquid consent is excluded: the
   *  acceptance signature usually satisfies the acceptor's side, so it isn't a
   *  hard block.) Used to disable the accept Confirm button. */
  hardBlock: boolean;
  /** True while the check is still in flight — Confirm should stay disabled so a
   *  user can't sign before the (possibly blocking) verdict resolves. */
  pending: boolean;
  /** Human-readable reason + fix (empty for ok/idle). */
  reason: string;
}

export function useRiskAccessPreflight(
  offerId: bigint | null | undefined,
): RiskPreflight {
  const { address, isCorrectChain, activeChain } = useWallet();
  const diamondRo = useDiamondRead();
  const readChain = useReadChain();
  const [status, setStatus] = useState<RiskPreflightStatus>("idle");
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
  }, [address, offerId, onDeployedChain, diamondRo]);

  const blocked =
    status === "tier-too-low" ||
    status === "needs-illiquid-consent" ||
    status === "needs-midtier-ack";

  // Tier shortfall + strict-mode ack are DEFINITE on-chain blocks; the illiquid
  // case usually clears via the acceptance signature, so it stays informational
  // (Codex #734 r5). The reason copy is neutral about WHO must act (the preview
  // checks the creator first), so no in-app "fix it here" action is offered.
  const hardBlock =
    status === "tier-too-low" || status === "needs-midtier-ack";

  return {
    status,
    blocked,
    hardBlock,
    pending: status === "loading",
    reason: RISK_PREFLIGHT_REASON[status],
  };
}
