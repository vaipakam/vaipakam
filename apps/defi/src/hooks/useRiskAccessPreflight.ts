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
    "This pair includes an illiquid asset that needs a per-pair consent. Your acceptance signature usually covers your side, so the accept can still go through — but if the offer creator's own consent is missing or has gone stale, the accept will be rejected until they restore it (and a standing consent this app can't record yet may be required).",
  "needs-midtier-ack":
    "This pair requires a strict-mode mid-tier acknowledgement that an acceptance signature doesn't cover, and that this app can't record yet.",
  error: "Couldn't check the risk-access requirements right now.",
};

export interface RiskPreflight {
  status: RiskPreflightStatus;
  /** True only when the gate would actively block the accept (any reason). */
  blocked: boolean;
  /** A DEFINITE on-chain block the upcoming accept signature cannot clear — used
   *  to disable the accept Confirm button. Tier shortfall and strict-mode mid-tier
   *  ack are always hard (no acceptance-ack substitution); a code-2 illiquid block
   *  is hard only when it's creator-side / sale-buyer-side. An acceptor-side
   *  illiquid block self-heals via the #662 acceptance signature, so it stays a
   *  soft warning that does NOT disable Confirm. */
  hardBlock: boolean;
  /** True while the check is still in flight — Confirm should stay disabled so a
   *  user can't sign before the (possibly blocking) verdict resolves. */
  pending: boolean;
  /** Human-readable reason + fix (empty for ok/idle). */
  reason: string;
}

export function useRiskAccessPreflight(
  offerId: bigint | null | undefined,
  /** The offer creator's address. Used to tell a CREATOR-side illiquid block
   *  (unhealable — the creator has no acceptance ack) from an ACCEPTOR-side one
   *  (the acceptor's #662 acknowledgement substitutes for standing illiquid
   *  consent on a normal accept). Omitted ⇒ a code-2 illiquid block is treated
   *  conservatively as hard. */
  creator?: string | null,
): RiskPreflight {
  const { address, isCorrectChain, activeChain } = useWallet();
  const diamondRo = useDiamondRead();
  const readChain = useReadChain();
  const [status, setStatus] = useState<RiskPreflightStatus>("idle");
  // True when a code-2 illiquid block originates from the OFFER CREATOR (or no
  // creator was supplied to distinguish): then it's a definite hard block the
  // acceptor's signature can't clear. False when it's acceptor-side and the
  // upcoming #662 acceptance acknowledgement will satisfy it on a normal accept.
  const [illiquidCreatorSide, setIlliquidCreatorSide] = useState(true);
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
    void (async () => {
      try {
        const code = Number(await ro.previewOfferAcceptBlock(offerId, address));
        if (cancelled) return;
        const next = CODE_TO_STATUS[code] ?? "ok";
        // For a code-2 illiquid block, decide whether it is CREATOR-side
        // (unhealable) or ACCEPTOR-side (the #662 acceptance ack the dapp signs
        // substitutes for standing consent on a normal accept — Codex #734 r9).
        // `previewOfferAcceptBlock` checks the creator FIRST, so re-running it
        // with the creator AS the acceptor returns the creator's own verdict: a
        // code-2 there means the block is the creator's and the acceptor's
        // signature can't clear it. Without a creator to test, stay conservative
        // (creator-side ⇒ hard).
        //
        // ASSUMES the normal book-accept path (the only caller — `OfferBook`
        // renders offerType 0/1 only). On the lender-SALE-vehicle path
        // (`saleOfferToLoanId != 0`) the preview ignores the creator and checks
        // only the buyer with standing-consent-only semantics — the #662 ack does
        // NOT substitute there — so a code-2 is always hard and this self-heal
        // softening must NOT be applied. A future sale-accept caller must force
        // `hardBlock` for code-2 instead of reusing this branch.
        if (next === "needs-illiquid-consent" && creator) {
          try {
            const cCode = Number(
              await ro.previewOfferAcceptBlock(offerId, creator),
            );
            if (cancelled) return;
            setIlliquidCreatorSide(cCode === 2);
          } catch {
            if (cancelled) return;
            setIlliquidCreatorSide(true); // can't confirm self-heal ⇒ conservative
          }
        } else {
          setIlliquidCreatorSide(true);
        }
        if (!cancelled) setStatus(next);
      } catch (e) {
        if (cancelled) return;
        // A Diamond that predates RiskAccessFacet is silently "ok" (the feature
        // isn't there). But a REAL read failure (transient RPC / chain error) on
        // a deployment where the gate IS live must NOT be silently swallowed —
        // surface "error" so the modal doesn't imply the accept is clear when it
        // wasn't actually checked (Codex #734 P2). Either way it doesn't BLOCK —
        // the on-chain gate stays the boundary.
        setStatus(isMissingFacet(e) ? "ok" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, offerId, onDeployedChain, diamondRo, creator]);

  const blocked =
    status === "tier-too-low" ||
    status === "needs-illiquid-consent" ||
    status === "needs-midtier-ack";

  // Tier shortfall and strict-mode mid-tier ack are hard for BOTH parties — the
  // #662 acceptance acknowledgement substitutes for neither (LibRiskAccess). The
  // illiquid (code-2) case is hard ONLY when it's creator-side / sale-buyer-side
  // (unhealable); an acceptor-side illiquid block self-heals via the acceptance
  // signature on a normal accept, so it stays a soft warning (Codex #734 r9).
  const hardBlock =
    status === "tier-too-low" ||
    status === "needs-midtier-ack" ||
    (status === "needs-illiquid-consent" && illiquidCreatorSide);

  return {
    status,
    blocked,
    hardBlock,
    pending: status === "loading",
    reason: RISK_PREFLIGHT_REASON[status],
  };
}
