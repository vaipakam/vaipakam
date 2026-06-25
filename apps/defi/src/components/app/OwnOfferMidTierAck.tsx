import { useState } from "react";
import {
  useCreatorBlock,
  useMidTierAckGate,
  type RiskPairId,
} from "../../hooks/useMidTierAckGate";
import { useDiamondContract } from "../../contracts/useDiamond";
import { useWallet } from "../../context/WalletContext";
import { beginStep } from "../../lib/journeyLog";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * #735 item 3 — creator-side mid-tier acknowledgement for an OWN posted offer
 * (Codex #740 r6/r7). When strict mode is enabled (or a terms bump stales the
 * prior ack / drops the tier) AFTER an offer was posted, the accept gate
 * re-checks the creator FIRST, so acceptors stay blocked until the creator acts —
 * but the creator's own offers show a "Your Offer" badge / a Cancel-only row, not
 * an Accept modal, so there was no in-flow way to resolve it.
 *
 * The contract's `previewCreatorBlock` is the authoritative verdict: it folds in
 * the lender-sale SELLER exemption (→ 0, never prompt a seller) and the
 * tier-before-ack ordering (→ 1 when the tier, not the ack, is the blocker), so
 * the dapp doesn't re-derive them. This renders the right affordance for that
 * code: a record action for a mid-tier ack (3), or a neutral "fix it in Risk
 * Access settings" note for tier (1) / illiquid-consent (2). Nothing for 0 (OK /
 * gate-off / seller-exempt) or an unknown read.
 *
 * Shared by the market table (OfferBook) and the single-offer view (OfferDetails,
 * reachable from the Dashboard MyOffersTable rows).
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
  const { address } = useWallet();
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

  // Code-2 (stale per-pair illiquid consent) recovery is a contextual
  // `setIlliquidPairConsent` write for THIS exact pair — the Risk Access settings
  // page has no per-pair consent control, so guidance there would dead-end (Codex
  // #740 r8). Like the mid-tier ack, the consent is version-anchored + cooldown-
  // armed, so it becomes effective only after any configured cooldown.
  const diamondRw = useDiamondContract();
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentDone, setConsentDone] = useState(false);
  const [consentErr, setConsentErr] = useState<string | null>(null);
  async function recordConsent() {
    const step = beginStep({
      area: "profile",
      flow: "setIlliquidPairConsent",
      step: "record",
      wallet: address ?? undefined,
    });
    setConsentBusy(true);
    setConsentErr(null);
    try {
      const rw = diamondRw as unknown as {
        setIlliquidPairConsent: (
          p: RiskPairId,
          consent: boolean,
        ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
      };
      const tx = await rw.setIlliquidPairConsent(pair, true);
      await tx.wait();
      step.success();
      setConsentDone(true);
    } catch (e) {
      setConsentErr((e as Error).message);
      step.failure(e);
    } finally {
      setConsentBusy(false);
    }
  }

  if (gate.recorded) {
    return (
      <div role="status" style={{ marginTop: "0.35rem", fontSize: "0.75rem", opacity: 0.85 }}>
        Acknowledgement recorded — effective after any configured cooldown; until
        then acceptors stay blocked on this offer.
      </div>
    );
  }
  // 0 / null ⇒ OK, gate-off, seller-exempt, or read pending ⇒ nothing.
  if (code === null || code === 0) return null;
  if (code === 1) {
    return (
      <div role="status" style={{ marginTop: "0.35rem", fontSize: "0.75rem", opacity: 0.85 }}>
        This offer's pair now needs a higher risk tier than your vault holds — raise
        (or re-affirm) it in Risk Access settings to make it acceptable again.
      </div>
    );
  }
  if (code === 2) {
    if (consentDone) {
      return (
        <div role="status" style={{ marginTop: "0.35rem", fontSize: "0.75rem", opacity: 0.85 }}>
          Per-pair consent recorded — effective after any configured cooldown; until
          then acceptors stay blocked on this offer.
        </div>
      );
    }
    return (
      <div style={{ marginTop: "0.35rem" }}>
        <div style={{ fontSize: "0.75rem", opacity: 0.85, marginBottom: "0.25rem" }}>
          This offer's pair needs a per-pair consent that is no longer current.
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={consentBusy}
          onClick={() => void recordConsent()}
        >
          {consentBusy ? "Recording consent…" : "Record per-pair consent"}
        </button>
        {consentErr && (
          <div role="alert" style={{ marginTop: "0.3rem", fontSize: "0.75rem", color: "var(--danger, #d66)" }}>
            {consentErr}
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
