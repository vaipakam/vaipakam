import {
  useCreatorBlock,
  useMidTierAckGate,
  type RiskPairId,
} from "../../hooks/useMidTierAckGate";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * #735 item 3 — creator-side risk recovery for an OWN posted offer (Codex #740
 * r6/r7/r9). When strict mode is enabled (or a terms bump stales the prior ack /
 * drops the tier / stales the consent) AFTER an offer was posted, the accept gate
 * re-checks the creator FIRST, so acceptors stay blocked until the creator acts —
 * but the creator's own offers show a "Your Offer" badge / a Cancel-only row, not
 * an Accept modal.
 *
 * The contract's `previewCreatorBlock` is the authoritative verdict: it folds in
 * the lender-sale SELLER exemption (→ 0, never prompt a seller) and the
 * tier→illiquid→mid-tier ordering. This renders the right affordance per code: a
 * record action for a mid-tier ack (3) or a stale per-pair illiquid consent (2),
 * a "fix your tier" note (1), and nothing for 0 (OK / gate-off / seller-exempt).
 * On a deployment that predates the `previewCreatorBlock` selector it gets
 * `'unknown'` and shows a neutral note rather than silently hiding the control.
 *
 * All record/consent state lives in {useMidTierAckGate}, keyed to the
 * pair+wallet+chain identity, so navigating between own offers can't carry one
 * offer's "recorded" state onto another (Codex #740 r9). Shared by the market
 * table (OfferBook) and the single-offer view (OfferDetails, reachable from the
 * Dashboard MyOffersTable row links).
 */
export interface OwnOfferMidTierAckProps {
  offerId: bigint;
  lendingAsset: string;
  /** 0 = ERC20, 1 = ERC721, 2 = ERC1155. */
  assetType: number;
  tokenId: bigint;
  collateralAsset: string;
  collateralAssetType?: number;
  collateralTokenId?: bigint;
  prepayAsset?: string;
}

const noteStyle = { marginTop: "0.35rem", fontSize: "0.75rem", opacity: 0.85 } as const;

export function OwnOfferMidTierAck({
  offerId,
  lendingAsset,
  assetType,
  tokenId,
  collateralAsset,
  collateralAssetType,
  collateralTokenId,
  prepayAsset,
}: OwnOfferMidTierAckProps) {
  const code = useCreatorBlock(offerId);
  // A creator-side block is always a NORMAL offer (sale-vehicle sellers are
  // exempt), so the gated pair is the offer's own surface.
  const pair: RiskPairId = {
    lendAsset: lendingAsset,
    lendType: assetType,
    lendTokenId: tokenId,
    collAsset: collateralAsset,
    collType: collateralAssetType ?? 0,
    collTokenId: collateralTokenId ?? 0n,
    prepayAsset: prepayAsset ?? ZERO_ADDR,
  };
  const gate = useMidTierAckGate(pair);

  if (gate.recorded) {
    return (
      <div role="status" style={noteStyle}>
        Acknowledgement recorded — effective after any configured cooldown; until
        then acceptors stay blocked on this offer.
      </div>
    );
  }
  if (gate.consentRecorded) {
    return (
      <div role="status" style={noteStyle}>
        Per-pair consent recorded — effective after any configured cooldown; until
        then acceptors stay blocked on this offer.
      </div>
    );
  }
  // Diamond predates the creator-verdict view ⇒ neutral note (don't silently hide).
  if (code === "unknown") {
    return (
      <div role="status" style={noteStyle}>
        Couldn't determine this offer's risk status on this deployment.
      </div>
    );
  }
  // 0 / null ⇒ OK, gate-off, seller-exempt, or read pending ⇒ nothing.
  if (code === null || code === 0) return null;
  if (code === 1) {
    return (
      <div role="status" style={noteStyle}>
        This offer's pair now needs a higher risk tier than your vault holds — raise
        (or re-affirm) it in Risk Access settings to make it acceptable again.
      </div>
    );
  }
  if (code === 2) {
    return (
      <div style={{ marginTop: "0.35rem" }}>
        <div style={{ fontSize: "0.75rem", opacity: 0.85, marginBottom: "0.25rem" }}>
          This offer's pair needs a per-pair consent that is no longer current.
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={gate.consentRecording}
          onClick={() => void gate.recordConsent()}
        >
          {gate.consentRecording ? "Recording consent…" : "Record per-pair consent"}
        </button>
        {gate.consentError && (
          <div role="alert" style={{ marginTop: "0.3rem", fontSize: "0.75rem", color: "var(--danger, #d66)" }}>
            {gate.consentError}
          </div>
        )}
      </div>
    );
  }
  // code === 3 — strict-mode mid-tier acknowledgement.
  return (
    <div style={{ marginTop: "0.35rem" }}>
      <div style={{ fontSize: "0.75rem", opacity: 0.85, marginBottom: "0.25rem" }}>
        Strict mode now requires a mid-tier acknowledgement for this pair before it
        can be accepted.
      </div>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={gate.recording}
        onClick={() => void gate.record()}
      >
        {gate.recording ? "Recording…" : "Record mid-tier acknowledgement"}
      </button>
      {gate.error && (
        <div role="alert" style={{ marginTop: "0.3rem", fontSize: "0.75rem", color: "var(--danger, #d66)" }}>
          {gate.error}
        </div>
      )}
    </div>
  );
}
