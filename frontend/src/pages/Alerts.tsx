import { useState } from "react";
import { useWallet } from "../context/WalletContext";
import { Bell, MessageCircle, Wallet } from "lucide-react";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { beginStep } from "../lib/journeyLog";

const HF_WATCHER_ORIGIN =
  import.meta.env.VITE_HF_WATCHER_ORIGIN ?? "https://alerts.vaipakam.com";

/**
 * Phase 8a.3 — Settings → Alerts page.
 *
 * Configures per-user HF alert thresholds on the connected chain and
 * links the two delivery rails (Telegram + Push Protocol). All state
 * is written to the off-chain watcher Worker at `HF_WATCHER_ORIGIN`
 * — no contract call, no gas, no approval. The on-chain system is
 * unaware of who subscribed to what; the watcher reads public loan
 * data via `calculateHealthFactor(loanId)` and fans out alerts.
 *
 * Dual-rail means a user can enable Telegram, Push, or both. Both
 * rails share the same threshold config — you don't configure
 * different `warn_hf` per channel.
 */
export default function Alerts() {
  const { address, chainId, isCorrectChain } = useWallet();

  const [warnHf, setWarnHf] = useState(1.5);
  const [alertHf, setAlertHf] = useState(1.2);
  const [criticalHf, setCriticalHf] = useState(1.05);

  const [tgLinkCode, setTgLinkCode] = useState<string | null>(null);
  const [tgBotUrl, setTgBotUrl] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!address) {
    return (
      <div className="page-container">
        <h1>Alerts</h1>
        <p>Connect your wallet to configure HF alerts.</p>
      </div>
    );
  }
  if (!isCorrectChain) {
    return (
      <div className="page-container">
        <h1>Alerts</h1>
        <p>Switch to a supported chain to configure alerts for your loans.</p>
      </div>
    );
  }

  const save = async () => {
    setErr(null);
    setMsg(null);
    if (!(warnHf > alertHf && alertHf > criticalHf)) {
      setErr("Threshold order must be: warn > alert > critical.");
      return;
    }
    if (criticalHf <= 1) {
      setErr(
        "Critical threshold must be greater than 1.00 (liquidation bound).",
      );
      return;
    }
    // Diagnostics drawer instrumentation — every async leg of this
    // page now opens a journey step so failures land in the drawer.
    // Until we added this, fetch failures (CORS rejections, worker
    // 5xx, offline) only set local `err` state and never made it
    // into the exportable journey log, which is exactly the gap the
    // recent Telegram-link CORS chase exposed.
    const step = beginStep({
      area: "alerts",
      flow: "saveThresholds",
      step: "submit",
      wallet: address,
      chainId,
    });
    setSaving(true);
    try {
      const res = await fetch(`${HF_WATCHER_ORIGIN}/thresholds`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: address,
          chain_id: chainId,
          warn_hf: warnHf,
          alert_hf: alertHf,
          critical_hf: criticalHf,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "request failed");
        throw new Error(`HTTP ${res.status} — ${bodyText}`);
      }
      setMsg("Thresholds saved.");
      step.success({ note: `warn=${warnHf} alert=${alertHf} critical=${criticalHf}` });
    } catch (e) {
      setErr((e as Error).message);
      step.failure(e);
    } finally {
      setSaving(false);
    }
  };

  const requestTelegramLink = async () => {
    setErr(null);
    setMsg(null);
    const step = beginStep({
      area: "alerts",
      flow: "requestTelegramLink",
      step: "submit",
      wallet: address,
      chainId,
    });
    setLinking(true);
    try {
      const res = await fetch(`${HF_WATCHER_ORIGIN}/link/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, chain_id: chainId }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "request failed");
        throw new Error(`HTTP ${res.status} — ${bodyText}`);
      }
      const data = (await res.json()) as {
        code?: string;
        bot_url?: string | null;
      };
      if (!data.code) throw new Error("no code returned");
      setTgLinkCode(data.code);
      setTgBotUrl(data.bot_url ?? null);
      step.success({
        note: data.bot_url ? "code+deep-link issued" : "code issued (no bot deep-link)",
      });
    } catch (e) {
      setErr((e as Error).message);
      step.failure(e);
    } finally {
      setLinking(false);
    }
  };

  const subscribePush = async () => {
    setErr(null);
    setMsg(null);
    // TODO(ops): replace with `@pushprotocol/restapi` subscribe call
    // using a wallet-signed message. For now we optimistically write
    // push_channel='subscribed' via /thresholds PUT so the watcher
    // knows to dispatch Push-rail alerts. The real subscription is
    // what makes the notifications land in the user's Push wallet.
    const step = beginStep({
      area: "alerts",
      flow: "subscribePush",
      step: "submit",
      wallet: address,
      chainId,
    });
    setSaving(true);
    try {
      const res = await fetch(`${HF_WATCHER_ORIGIN}/thresholds`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: address,
          chain_id: chainId,
          warn_hf: warnHf,
          alert_hf: alertHf,
          critical_hf: criticalHf,
          push_channel: "subscribed",
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "request failed");
        throw new Error(`HTTP ${res.status} — ${bodyText}`);
      }
      setMsg(
        "Push rail enabled. You'll also need to subscribe to the Vaipakam Push channel from your Push-enabled wallet to actually receive the notifications — see docs for the channel address.",
      );
      step.success({ note: "push_channel=subscribed" });
    } catch (e) {
      setErr((e as Error).message);
      step.failure(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-container">
      <h1>
        <Bell size={22} style={{ verticalAlign: "-4px", marginRight: 8 }} />
        Alerts
      </h1>
      <p style={{ maxWidth: 720 }}>
        Get a heads-up when your Health Factor (HF) falls toward the liquidation
        threshold. The off-chain watcher polls your active loans every 5 minutes
        and alerts on band crossings — no gas, no on-chain state. Alerts fire
        once per downgrade; climbing back to healthy re-arms the ladder.
      </p>

      {err && (
        <ErrorAlert
          message={err}
          style={{ maxWidth: 720, marginTop: 16 }}
          onDismiss={() => setErr(null)}
        />
      )}
      {msg && (
        <div
          className="alert alert-success"
          style={{ maxWidth: 720, marginTop: 16 }}
        >
          {msg}
        </div>
      )}

      {/* Thresholds */}
      <section
        style={{
          marginTop: 20,
          padding: 16,
          border: "1px solid var(--border)",
          borderRadius: 8,
          maxWidth: 720,
        }}
      >
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>Threshold ladder</h2>
        <p style={{ fontSize: "0.85rem", opacity: 0.8, margin: "4px 0 16px" }}>
          A fresh alert fires the first time HF crosses each band downward. Once
          a band fires it re-arms after HF recovers above the next higher band's
          threshold. Default values are conservative — adjust to taste.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(160px, max-content) 120px 1fr",
            gap: 12,
            alignItems: "center",
          }}
        >
          <label style={{ fontSize: "0.92rem" }}>Warn at HF</label>
          <input
            type="number"
            step="0.01"
            min="1.01"
            max="5"
            value={warnHf}
            onChange={(e) => setWarnHf(Number(e.target.value))}
            className="form-input"
          />
          <span style={{ fontSize: "0.82rem", opacity: 0.65 }}>
            First heads-up — plenty of runway still.
          </span>

          <label style={{ fontSize: "0.92rem" }}>Alert at HF</label>
          <input
            type="number"
            step="0.01"
            min="1.01"
            max="5"
            value={alertHf}
            onChange={(e) => setAlertHf(Number(e.target.value))}
            className="form-input"
          />
          <span style={{ fontSize: "0.82rem", opacity: 0.65 }}>
            Meaningful — take a look at adding collateral or repaying.
          </span>

          <label style={{ fontSize: "0.92rem" }}>Critical at HF</label>
          <input
            type="number"
            step="0.01"
            min="1.01"
            max="5"
            value={criticalHf}
            onChange={(e) => setCriticalHf(Number(e.target.value))}
            className="form-input"
          />
          <span style={{ fontSize: "0.82rem", opacity: 0.65 }}>
            Liquidation imminent — HF &lt; 1.00 triggers it on-chain.
          </span>
        </div>

        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={save}
          style={{ marginTop: 16 }}
        >
          {saving ? "Saving…" : "Save thresholds"}
        </button>
      </section>

      {/* Delivery rails */}
      <section
        style={{
          marginTop: 20,
          padding: 16,
          border: "1px solid var(--border)",
          borderRadius: 8,
          maxWidth: 720,
        }}
      >
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>Delivery channels</h2>
        <p style={{ fontSize: "0.85rem", opacity: 0.8, margin: "4px 0 16px" }}>
          Enable one or both. Both rails share the threshold ladder above — you
          don't configure different warn-levels per channel.
        </p>

        {/* Telegram */}
        <div
          style={{
            padding: "12px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <MessageCircle size={18} />
            <strong>Telegram</strong>
          </div>
          <p style={{ fontSize: "0.82rem", opacity: 0.75, margin: "0 0 8px" }}>
            Universal — no wallet plug-in required. Handshake: request a code
            here, DM it to the bot, confirmation arrives back in Telegram.
          </p>
          {tgLinkCode ? (
            <div style={{ fontSize: "0.9rem" }}>
              DM this code to the Vaipakam alerts (@VaipakamBot) bot within 10
              minutes:
              <div
                style={{
                  margin: "6px 0",
                  fontSize: "1.4rem",
                  fontFamily: "var(--font-mono, monospace)",
                  letterSpacing: "0.2em",
                  padding: "8px 12px",
                  background: "var(--bg-muted)",
                  borderRadius: 6,
                  textAlign: "center",
                }}
              >
                {tgLinkCode}
              </div>
              {tgBotUrl && (
                <a href={tgBotUrl} target="_blank" rel="noreferrer">
                  Open Telegram →
                </a>
              )}
            </div>
          ) : (
            <button
              className="btn btn-secondary btn-sm"
              disabled={linking}
              onClick={requestTelegramLink}
            >
              {linking ? "Requesting…" : "Link Telegram"}
            </button>
          )}
        </div>

        {/* Push Protocol */}
        <div style={{ padding: "12px 0" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <Wallet size={18} />
            <strong>Push Protocol</strong>
          </div>
          <p style={{ fontSize: "0.82rem", opacity: 0.75, margin: "0 0 8px" }}>
            On-chain notification channel delivered to Push-enabled wallets
            (Rabby, Push Wallet, MetaMask with Push Snap). Once enabled here,
            you'll also need to subscribe to the Vaipakam channel from your
            wallet — see{" "}
            <a
              href="https://push.org/docs/notifications/build/subscribe-to-channel"
              target="_blank"
              rel="noreferrer"
            >
              docs
            </a>
            .
          </p>
          <button
            className="btn btn-secondary btn-sm"
            disabled={saving}
            onClick={subscribePush}
          >
            Enable Push rail
          </button>
        </div>
      </section>
    </div>
  );
}
