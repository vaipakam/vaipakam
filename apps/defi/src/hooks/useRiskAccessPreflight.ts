import { useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useDiamondRead } from "../contracts/useDiamond";

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
    "This pair includes an illiquid asset. Your acceptance signature acknowledges it for most assets — if the accept still fails, record a standing per-pair consent in Risk Access settings.",
  "needs-midtier-ack":
    "This pair needs a strict-mode mid-tier acknowledgement that an acceptance signature doesn't cover. If it's your vault, acknowledge the pair in Risk Access settings before accepting.",
  error: "Couldn't check the risk-access requirements right now.",
};

export interface RiskPreflight {
  status: RiskPreflightStatus;
  /** True only when the gate would actively block the accept. */
  blocked: boolean;
  /** Human-readable reason + fix (empty for ok/idle). */
  reason: string;
}

export function useRiskAccessPreflight(
  offerId: bigint | null | undefined,
): RiskPreflight {
  const { address } = useWallet();
  const diamondRo = useDiamondRead();
  const [status, setStatus] = useState<RiskPreflightStatus>("idle");

  useEffect(() => {
    let cancelled = false;
    if (!address || offerId == null) {
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
      .catch(() => {
        if (cancelled) return;
        // A Diamond that predates RiskAccessFacet (or any read failure) must
        // NOT block the accept — fall back to "ok" so the contract-layer gate
        // stays the only boundary. Surface nothing in the UI.
        setStatus("ok");
      });
    return () => {
      cancelled = true;
    };
  }, [address, offerId, diamondRo]);

  const blocked =
    status === "tier-too-low" ||
    status === "needs-illiquid-consent" ||
    status === "needs-midtier-ack";

  return { status, blocked, reason: RISK_PREFLIGHT_REASON[status] };
}
