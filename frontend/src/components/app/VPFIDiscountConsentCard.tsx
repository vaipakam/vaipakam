import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../context/WalletContext";
import { useDiamondContract } from "../../contracts/useDiamond";
import { decodeContractError } from "../../lib/decodeContractError";
import { beginStep } from "../../lib/journeyLog";
import { CardInfo } from "../CardInfo";

/**
 * Platform-level opt-in card for the VPFI fee-discount flow.
 *
 * A single boolean consent applies on both sides of a loan:
 *   - borrower Loan Initiation Fee (LIF), and
 *   - lender Yield Fee
 *
 * When `consent === true` the protocol may deduct VPFI from the user's
 * personal escrow at settlement to pay the discounted fee share. Discount
 * size scales with the escrow-held VPFI balance per the Phase-1 tier table:
 *
 *   - T0 (&lt; 100 VPFI)     →  0% discount
 *   - T1 (≥ 100)             → 10% discount
 *   - T2 (≥ 1,000)           → 15% discount
 *   - T3 (≥ 5,000, ≤ 20,000) → 20% discount
 *   - T4 (&gt; 20,000)       → 24% discount
 *
 * No per-offer or per-loan consent is required — toggling this card is the
 * only user action gating the discount.
 */
export default function VPFIDiscountConsentCard() {
  const { t } = useTranslation();
  const { address } = useWallet();
  const diamond = useDiamondContract();

  const [consent, setConsent] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!address || !diamond) {
      setConsent(null);
      return;
    }
    try {
      const current = await (
        diamond as unknown as {
          getVPFIDiscountConsent: (user: string) => Promise<boolean>;
        }
      ).getVPFIDiscountConsent(address);
      setConsent(Boolean(current));
    } catch {
      setConsent(null);
    }
  }, [address, diamond]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggle = async () => {
    if (!address || !diamond) return;
    setError(null);
    setPending(true);
    const next = !consent;
    const s = beginStep({
      area: "vpfi-buy",
      flow: "setVPFIDiscountConsent",
      step: next ? "enable" : "disable",
    });
    try {
      const tx = await (
        diamond as unknown as {
          setVPFIDiscountConsent: (
            enabled: boolean,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).setVPFIDiscountConsent(next);
      await tx.wait();
      setConsent(next);
      s.success({ note: `consent=${next}` });
    } catch (err) {
      setError(decodeContractError(err, t('vpfiDiscountConsent.errorFallback')));
      s.failure(err);
    } finally {
      setPending(false);
    }
  };

  if (!address) return null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <ShieldCheck
          size={22}
          style={{
            color: consent ? "var(--accent-green)" : "var(--text-tertiary)",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ flex: 1 }}>
          <div className="card-title" style={{ marginBottom: 4 }}>
            {t('vpfiDiscountConsent.title')}
            <CardInfo id="dashboard.fee-discount-consent" />
          </div>
          <p className="stat-label" style={{ margin: "0 0 10px" }}>
            {t('vpfiDiscountConsent.bodyPrefix')}
            <Link to="/app/buy-vpfi" style={{ color: "var(--brand)" }}>
              {t('vpfiDiscountConsent.buyVpfiLink')}
            </Link>
            {t('vpfiDiscountConsent.bodySuffix')}
          </p>
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span
              className="stat-label"
              style={{
                fontWeight: 600,
                color: consent ? "var(--accent-green)" : "var(--text-tertiary)",
              }}
            >
              {consent == null
                ? t('vpfiDiscountConsent.stateLoading')
                : consent
                  ? t('vpfiDiscountConsent.stateEnabled')
                  : t('vpfiDiscountConsent.stateDisabled')}
            </span>
            <button
              className={
                consent ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm"
              }
              onClick={handleToggle}
              disabled={consent == null || pending}
            >
              {pending
                ? t('vpfiDiscountConsent.buttonConfirming')
                : consent
                  ? t('vpfiDiscountConsent.buttonDisable')
                  : t('vpfiDiscountConsent.buttonEnable')}
            </button>
          </div>
          {error && (
            <div
              style={{
                marginTop: 10,
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                color: "var(--accent-red, #ef4444)",
              }}
            >
              <AlertTriangle
                size={14}
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <span className="stat-label" style={{ margin: 0 }}>
                {error}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
