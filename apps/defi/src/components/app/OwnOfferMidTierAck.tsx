import {
  useAcceptMidTierPair,
  useCreatorBlock,
  useMidTierAckGate,
} from "../../hooks/useMidTierAckGate";

/**
 * #735 item 3 — creator-side risk recovery for an OWN posted offer (Codex #740
 * r6/r7/r9/r10). When strict mode is enabled (or a terms bump stales the prior
 * ack / drops the tier / stales the consent) AFTER an offer was posted, the accept
 * gate re-checks the creator FIRST, so acceptors stay blocked until the creator
 * acts — but the creator's own offers show a "Your Offer" badge / a Cancel-only
 * row, not an Accept modal.
 *
 * The contract's `previewCreatorBlock` is the authoritative verdict (folds in the
 * lender-sale SELLER exemption → 0 and the tier→illiquid→mid-tier ordering); the
 * EXACT pair the recovery writes target is resolved on-chain via
 * `acceptMidTierAckPair` so a legacy/indexer-skew row that omits NFT-shape fields
 * can't record under the wrong pairKey (Codex #740 r10). Records are suppressed
 * while a prior ack/consent is still cooling down (`*Pending`). Shared by the
 * market table (OfferBook) and the single-offer view (OfferDetails, reachable from
 * the Dashboard MyOffersTable row links).
 */
export interface OwnOfferMidTierAckProps {
  offerId: bigint;
}

const noteStyle = { marginTop: "0.35rem", fontSize: "0.75rem", opacity: 0.85 } as const;
const dangerStyle = { marginTop: "0.3rem", fontSize: "0.75rem", color: "var(--danger, #d66)" } as const;

export function OwnOfferMidTierAck({ offerId }: OwnOfferMidTierAckProps) {
  const code = useCreatorBlock(offerId);
  // Resolve the EXACT gated pair on-chain (no defaulting of NFT-shape fields).
  const resolvedPair = useAcceptMidTierPair(offerId);
  const gate = useMidTierAckGate(
    resolvedPair === "unknown" ? null : resolvedPair,
  );

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
  // Code 2/3 need a CONCRETE pair for the recovery write — `useMidTierAckGate`'s
  // callbacks no-op while `pair` is null. Don't render a dead button before the
  // resolver lands / when it failed (Codex #740 r11); show a status note instead.
  if (resolvedPair !== "unknown" && resolvedPair === null) {
    return (
      <div role="status" style={noteStyle}>
        Checking this offer's risk requirement…
      </div>
    );
  }
  if (resolvedPair === "unknown") {
    return (
      <div role="status" style={noteStyle}>
        Couldn't determine this offer's risk pair right now — reload before
        recording.
      </div>
    );
  }
  if (code === 2) {
    // Already recorded and cooling down — don't restamp the unlock (Codex r10).
    if (gate.consentPending) {
      return (
        <div role="status" style={noteStyle}>
          Per-pair consent is recorded and cooling down — it becomes effective once
          the cooldown elapses; no need to record it again.
        </div>
      );
    }
    // Hold the write until the cooldown reads settle (Codex r12).
    if (!gate.pendingKnown) {
      return <div role="status" style={noteStyle}>Checking consent status…</div>;
    }
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
          <div role="alert" style={dangerStyle}>{gate.consentError}</div>
        )}
      </div>
    );
  }
  // code === 3 — strict-mode mid-tier acknowledgement.
  if (gate.midTierAckPending) {
    return (
      <div role="status" style={noteStyle}>
        The mid-tier acknowledgement is recorded and cooling down — it becomes
        effective once the cooldown elapses; no need to record it again.
      </div>
    );
  }
  // Hold the write until the cooldown reads settle (Codex r12).
  if (!gate.pendingKnown) {
    return <div role="status" style={noteStyle}>Checking acknowledgement status…</div>;
  }
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
      {gate.error && <div role="alert" style={dangerStyle}>{gate.error}</div>}
    </div>
  );
}
