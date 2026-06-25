import { useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useDiamondContract } from "../contracts/useDiamond";
import { beginStep } from "../lib/journeyLog";
import { ErrorAlert } from "../components/app/ErrorAlert";
import {
  useRiskAccess,
  RISK_TIER,
  RISK_TIER_LABEL,
  type RiskTier,
} from "../hooks/useRiskAccess";

/**
 * #671 progressive risk access — self-sovereign settings (#728 PR-2e).
 *
 * Every vault starts at the safest tier (Blue-chip only). From here a user opts
 * UP to riskier tiers — and only with explicit consent — exactly as the
 * contract requires. Lowering a tier is immediate; raising one may be subject to
 * an opt-up cooldown, and a governance risk-terms bump re-locks a held tier
 * until it is re-affirmed (both reflected in the on-chain *effective* tier).
 *
 * Per-pair illiquid consent and the strict-mode mid-tier acknowledgement are
 * pair-specific, so they are collected contextually at accept time (the accept
 * flow's risk preflight points back here). This page owns the two GLOBAL,
 * always-relevant controls: the vault's risk tier and the strict-mode opt-in.
 */

const TIER_OPTIONS: Array<{ level: RiskTier; hint: string }> = [
  {
    level: RISK_TIER.BlueChipOnly,
    hint: "Safest. Only blue-chip pairs (the protocol's numeraire basket or deepest-liquidity assets).",
  },
  {
    level: RISK_TIER.BroadLiquid,
    hint: "Adds mid-tier liquid assets. Still backed by the quantitative LTV / health-factor checks.",
  },
  {
    level: RISK_TIER.IlliquidCustom,
    hint: "Allows illiquid / unpriced assets and NFTs. Each illiquid pair also needs a one-time per-pair consent.",
  },
];

export default function RiskAccessSettings() {
  const { address } = useWallet();
  const diamondRw = useDiamondContract();
  const risk = useRiskAccess();

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rw = diamondRw as unknown as {
    setVaultRiskTier: (
      level: number,
    ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
  };

  // Submit a `setVaultRiskTier(level)` write. Shared by choosing a new tier and
  // by re-affirming the current one in place (#735) — re-affirm re-stamps the tier
  // anchor to the live risk-terms version, which is how a tier made STALE by a
  // governance terms bump is restored without forcing a lower-then-raise. (A
  // merely-cooling tier is left informational — re-clicking would restart the
  // cooldown.) `risk.tierStaleAfterBump` distinguishes the two from an on-chain
  // per-user version read (`getVaultRiskTierVersion`), replacing the fragile
  // local-clock heuristics that were removed in #734 r8.
  async function submitTier(level: RiskTier, notice: string) {
    const step = beginStep({
      area: "profile",
      flow: "setVaultRiskTier",
      step: "submit",
      wallet: address ?? undefined,
    });
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const tx = await rw.setVaultRiskTier(level);
      await tx.wait();
      step.success();
      setNotice(notice);
      await risk.refresh();
    } catch (e) {
      setErr((e as Error).message);
      step.failure(e);
    } finally {
      setBusy(false);
    }
  }

  async function chooseTier(level: RiskTier) {
    if (level === risk.rawTier) return;
    await submitTier(
      level,
      level > risk.rawTier
        ? "Tier raised. If an opt-up cooldown is configured it becomes effective once the cooldown elapses."
        : "Tier updated.",
    );
  }

  // #735 — re-affirm the currently-held tier against the latest risk-terms
  // version, restoring a tier that a governance terms bump made stale.
  async function reaffirmTier() {
    await submitTier(
      risk.rawTier,
      "Tier re-affirmed against the latest risk terms — it's effective again.",
    );
  }


  if (!address) {
    return (
      <div style={{ padding: "1.5rem", maxWidth: 720 }}>
        <h1>Risk Access</h1>
        <p>Connect a wallet to view and manage your vault's risk-access tier.</p>
      </div>
    );
  }

  // The reads are wallet-specific; on a chain without a deployed Diamond they'd
  // show another chain's / a default state while writes can't settle, so don't
  // render the controls (Codex #734 P2).
  if (risk.wrongChain) {
    return (
      <div style={{ padding: "1.5rem", maxWidth: 720 }}>
        <h1>Risk Access</h1>
        <ErrorAlert message="Switch to a supported network to view and manage your vault's risk-access tier." />
      </div>
    );
  }

  if (!risk.supported) {
    return (
      <div style={{ padding: "1.5rem", maxWidth: 720 }}>
        <h1>Risk Access</h1>
        <ErrorAlert message="Progressive risk access isn't available on this deployment yet." />
      </div>
    );
  }

  // Avoid flashing default values (Blue-chip / gate off) before the first read
  // resolves on a slow RPC (Claude review #734 P3).
  if (risk.loading) {
    return (
      <div style={{ padding: "1.5rem", maxWidth: 720 }}>
        <h1>Risk Access</h1>
        <p>Loading…</p>
      </div>
    );
  }

  // A critical tier read failed — don't render controls over an untrustworthy
  // (default) tier, which could drive a wrong / cooldown-restarting write
  // (Codex #734 r7).
  if (risk.criticalReadFailed) {
    return (
      <div style={{ padding: "1.5rem", maxWidth: 720 }}>
        <h1>Risk Access</h1>
        <ErrorAlert
          message={`Couldn't read your current risk-access tier${risk.error ? `: ${risk.error}` : ""}. Reload to try again before changing it.`}
        />
        <button
          type="button"
          onClick={() => void risk.refresh()}
          style={{ marginTop: "0.75rem" }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: "1.5rem", maxWidth: 720 }}>
      <h1>Risk Access</h1>
      <p>
        Choose how risky the assets your offers may involve can be. Your vault
        starts at the safest tier and opts up only with your explicit consent.
      </p>

      {risk.error && (
        <ErrorAlert
          message={`Couldn't read your current risk-access state, so the values below may be incomplete: ${risk.error}`}
        />
      )}
      {err && <ErrorAlert message={err} onDismiss={() => setErr(null)} />}
      {notice && (
        <div
          role="status"
          style={{
            margin: "0.75rem 0",
            padding: "0.6rem 0.8rem",
            borderRadius: 8,
            background: "rgba(40,160,90,0.12)",
            border: "1px solid rgba(40,160,90,0.35)",
          }}
        >
          {notice}
        </div>
      )}

      <section style={{ margin: "1rem 0", fontSize: "0.9rem", opacity: 0.85 }}>
        <div>
          Effective tier: <strong>{RISK_TIER_LABEL[risk.effectiveTier]}</strong>
          {risk.rawTier !== risk.effectiveTier && (
            <>
              {" "}
              (opted in to <strong>{RISK_TIER_LABEL[risk.rawTier]}</strong>,
              re-locked pending cooldown / terms re-affirmation)
            </>
          )}
        </div>
        <div>
          Enforcement:{" "}
          <strong>
            {!risk.gateEnabledKnown
              ? "unknown (couldn't read the master switch)"
              : risk.gateEnabled
                ? "on"
                : "off (not yet enforced)"}
          </strong>
        </div>
      </section>

      <h2 id="risk-tier-label" style={{ fontSize: "1.05rem" }}>
        Vault risk tier
      </h2>
      <div
        role="radiogroup"
        aria-labelledby="risk-tier-label"
        style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
      >
        {TIER_OPTIONS.map((opt) => {
          const selected = risk.rawTier === opt.level;
          const current = selected && risk.effectiveTier === risk.rawTier;
          // Held but not yet effective — either cooling down from a recent raise
          // OR stale after a governance terms bump. `tierStaleAfterBump` tells the
          // two apart (#735): stale offers an in-place re-affirm; cooling stays
          // informational (re-clicking would restart the cooldown).
          const heldNotEffective = selected && !current;
          const staleHere = heldNotEffective && risk.tierStaleAfterBump;
          const coolingHere = heldNotEffective && !risk.tierStaleAfterBump;
          const locked = busy || selected;
          return (
            <button
              key={opt.level}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={locked}
              onClick={() => chooseTier(opt.level)}
              style={{
                textAlign: "left",
                padding: "0.7rem 0.9rem",
                borderRadius: 10,
                border: selected
                  ? "2px solid var(--accent, #4a7dff)"
                  : "1px solid rgba(255,255,255,0.18)",
                background: selected ? "rgba(74,125,255,0.10)" : "transparent",
                cursor: locked ? "default" : "pointer",
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {RISK_TIER_LABEL[opt.level]} {current && "✓"}
                {coolingHere && (
                  <span style={{ fontWeight: 400, opacity: 0.8 }}>
                    {" "}
                    — selected; effective once the opt-up cooldown elapses
                  </span>
                )}
                {staleHere && (
                  <span style={{ fontWeight: 400, opacity: 0.8 }}>
                    {" "}
                    — not effective: the risk terms changed since you set this.
                    Re-affirm to restore it.
                  </span>
                )}
              </div>
              <div style={{ fontSize: "0.82rem", opacity: 0.8 }}>{opt.hint}</div>
            </button>
          );
        })}
      </div>
      {risk.tierStaleAfterBump && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void reaffirmTier()}
          style={{ marginTop: "0.6rem" }}
        >
          {busy ? "Re-affirming…" : "Re-affirm current tier"}
        </button>
      )}
      <p style={{ fontSize: "0.8rem", opacity: 0.7, marginTop: "0.5rem" }}>
        Lowering your tier takes effect immediately. Raising it may be subject to
        an opt-up cooldown before it becomes effective.
      </p>

      {/* Strict mode (the per-pair mid-tier acknowledgement opt-in) is
          deliberately not exposed here yet: enabling it requires a
          `setMidTierPairAck` path per pair, which lands together with the
          per-pair consent collection in a follow-up (it needs the offer's
          prepay token threaded through the offer cache to rebuild the exact
          pair). Exposing the toggle without that path would let a vault brick
          its own mid-tier accepts (Codex #734). */}
    </div>
  );
}
