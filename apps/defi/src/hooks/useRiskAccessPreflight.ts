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
// connected acceptor to "raise your tier" would be wrong in that case. The
// illiquid copy does NOT promise the acceptance signature will clear it: the
// #662 ack only substitutes for the acceptor's consent when it covers the gate's
// exact illiquid legs, which the client can't prove here, so the case is framed
// as a block to resolve rather than a step the signature handles (Codex #734 r10).
export const RISK_PREFLIGHT_REASON: Record<RiskPreflightStatus, string> = {
  idle: "",
  loading: "Checking the progressive-risk gate for this offer…",
  ok: "",
  "tier-too-low":
    "This offer's asset pair needs a higher risk tier than is currently set. If it's your vault, raise your tier in Risk Access settings; otherwise the offer can't be filled right now.",
  "needs-illiquid-consent":
    "This pair includes an illiquid asset that needs a per-pair consent the gate can't see right now — it may be the offer creator's consent that's missing or stale, or a standing consent this app can't record yet. The accept can't be completed until it's in place.",
  "needs-midtier-ack":
    "This pair requires a strict-mode mid-tier acknowledgement that an acceptance signature doesn't cover, and that this app can't record yet.",
  error: "Couldn't check the risk-access requirements right now.",
};

export interface RiskPreflight {
  status: RiskPreflightStatus;
  /** True only when the gate would actively block the accept (any reason). */
  blocked: boolean;
  /** A DEFINITE on-chain block the upcoming accept signature cannot be assumed to
   *  clear — used to disable the accept Confirm button. EVERY non-OK preview code
   *  qualifies (tier shortfall, illiquid-consent, strict-mode mid-tier ack):
   *  - tier / mid-tier ack: the #662 acceptance ack substitutes for neither.
   *  - illiquid (code 2): the preview is standing-consent-only and checks the
   *    offer CREATOR before the acceptor, so a block can be the creator's (no ack
   *    to substitute), a lender-SALE buyer's (the sale path is standing-consent-
   *    only too), OR an acceptor whose #662 ack does NOT cover the gate's exact
   *    illiquid legs (illiquid prepay on a rental, a depth-collapsed ERC-20 tier).
   *  None of those self-heal, and the client can't prove the one case that does
   *  (normal accept + ack covers the exact legs) from the preview alone, so we
   *  conservatively disable Confirm for all blocks (Codex #734 r10). A precise
   *  soft warning needs an ack-aware on-chain preview — a deliberate follow-up. */
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

  // Every non-OK preview code disables Confirm. The preview is standing-consent-
  // only and checks the offer CREATOR before the acceptor, and the #662 ack only
  // substitutes for the acceptor's illiquid consent when it covers the gate's
  // EXACT illiquid legs (not illiquid prepay, not a depth-collapsed ERC-20 tier,
  // not a lender-sale buyer). The client can't prove that one self-healing case
  // from the bare preview, so it conservatively treats every block as hard rather
  // than risk enabling Confirm on an accept the loan-init gate will reject
  // (Codex #734 r10). The on-chain gate remains the real boundary.
  const hardBlock = blocked;

  return {
    status,
    blocked,
    hardBlock,
    pending: status === "loading",
    reason: RISK_PREFLIGHT_REASON[status],
  };
}
