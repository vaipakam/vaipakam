import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../context/WalletContext";
import { Bell, MessageCircle, Wallet } from "lucide-react";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { CardInfo } from "../components/CardInfo";
import { beginStep, enrichFetchError } from "../lib/journeyLog";

// Read the off-chain watcher's origin from env. NO production-URL
// fallback by design — a build that forgets to set
// `VITE_HF_WATCHER_ORIGIN` should fail closed (alert features
// disabled with a clear message) rather than silently aim every
// staging / preview / local build at the production worker. That
// silent-fallback bug was what showed up as
// `…placeholder.workers.dev/thresholds net::ERR_FAILED` in a stale
// production bundle.
const HF_WATCHER_ORIGIN: string | null =
  (import.meta.env.VITE_HF_WATCHER_ORIGIN as string | undefined) ?? null;

// Public Push Protocol channel owner address. Used only for the
// "Subscribe on Push" deep link — `https://app.push.org/channels/<addr>`
// drops the user straight on the right channel page so they can
// subscribe in one click. Worker holds the channel SIGNER privkey;
// this is the corresponding public address (same wallet, public side).
// Default mirrors the production channel; set
// `VITE_PUSH_CHANNEL_ADDRESS` per environment to point at a staging
// channel instead. When unset (or zeroed), the Push rail still
// activates the worker-side flag, but the deep-link button is hidden
// and a plain "subscribe to channel address" copy line is shown
// instead so users still know what to look up manually.
const PUSH_CHANNEL_ADDRESS: string | null = (() => {
  const raw = import.meta.env.VITE_PUSH_CHANNEL_ADDRESS as string | undefined;
  if (!raw) return null;
  const trimmed = raw.trim();
  // Validate: must look like a 0x-prefixed 40-hex-char address.
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed;
})();

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
  const { t } = useTranslation();
  const { address, chainId, isCorrectChain } = useWallet();

  const [warnHf, setWarnHf] = useState(1.5);
  const [alertHf, setAlertHf] = useState(1.2);
  const [criticalHf, setCriticalHf] = useState(1.05);

  const [tgLinkCode, setTgLinkCode] = useState<string | null>(null);
  const [tgBotUrl, setTgBotUrl] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  // `msg` is a ReactNode so success banners can embed clickable links
  // (e.g. the "Subscribe on Push" deep link surfaced after the user
  // enables the Push rail). Plain-string callers still work — React
  // narrows automatically.
  const [msg, setMsg] = useState<ReactNode | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!address) {
    return (
      <div className="page-container">
        <h1>{t('appNav.alerts')}</h1>
        <p>{t('alerts.connectBody')}</p>
      </div>
    );
  }
  if (!isCorrectChain) {
    return (
      <div className="page-container">
        <h1>{t('appNav.alerts')}</h1>
        <p>{t('alerts.switchChainBody')}</p>
      </div>
    );
  }
  if (!HF_WATCHER_ORIGIN) {
    // Build-time misconfiguration: VITE_HF_WATCHER_ORIGIN was not
    // baked into the bundle. Refusing to fire requests against a
    // null URL prevents the silent fail-open that previously sent
    // every staging / preview build at the production worker (and
    // still surfaced as net::ERR_FAILED on stale production
    // bundles where the env was missing entirely).
    return (
      <div className="page-container">
        <h1>{t('appNav.alerts')}</h1>
        <p>
          The off-chain alert watcher origin is not configured in this build
          (<code>VITE_HF_WATCHER_ORIGIN</code>). Alert features (HF threshold
          subscriptions, Telegram link, Push rail) are disabled until the
          deployment env is corrected and the frontend is rebuilt. Reach
          out to your operator if you're seeing this on a production URL.
        </p>
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
    const fetchUrl = `${HF_WATCHER_ORIGIN}/thresholds`;
    setSaving(true);
    try {
      const res = await fetch(fetchUrl, {
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
        // Include method + URL + status so the diagnostics drawer
        // captures WHERE the request went, not just what came back.
        // Universal across HTTP failure modes (403, 404, 5xx, …).
        throw new Error(
          `PUT ${fetchUrl} → HTTP ${res.status} — ${bodyText}`,
        );
      }
      setMsg("Thresholds saved.");
      step.success({ note: `warn=${warnHf} alert=${alertHf} critical=${criticalHf}` });
    } catch (e) {
      // User-facing alert stays succinct (the bare error message);
      // the diagnostics drawer gets the enriched version with the
      // target URL + page origin + likely-cause hint synthesized in,
      // since the browser strips CORS reasons from JS-visible errors.
      setErr((e as Error).message);
      step.failure(enrichFetchError(e, fetchUrl));
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
    const fetchUrl = `${HF_WATCHER_ORIGIN}/link/telegram`;
    setLinking(true);
    try {
      const res = await fetch(fetchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, chain_id: chainId }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "request failed");
        throw new Error(
          `POST ${fetchUrl} → HTTP ${res.status} — ${bodyText}`,
        );
      }
      const data = (await res.json()) as {
        code?: string;
        bot_url?: string | null;
      };
      if (!data.code) {
        throw new Error(
          `POST ${fetchUrl} → 200 OK but response body has no \`code\` field`,
        );
      }
      setTgLinkCode(data.code);
      setTgBotUrl(data.bot_url ?? null);
      step.success({
        note: data.bot_url ? "code+deep-link issued" : "code issued (no bot deep-link)",
      });
    } catch (e) {
      // User-facing alert stays succinct (the bare error message);
      // the diagnostics drawer gets the enriched version with the
      // target URL + page origin + likely-cause hint synthesized in,
      // since the browser strips CORS reasons from JS-visible errors.
      setErr((e as Error).message);
      step.failure(enrichFetchError(e, fetchUrl));
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
    const fetchUrl = `${HF_WATCHER_ORIGIN}/thresholds`;
    setSaving(true);
    try {
      const res = await fetch(fetchUrl, {
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
        throw new Error(
          `PUT ${fetchUrl} → HTTP ${res.status} — ${bodyText}`,
        );
      }
      // Surface the Vaipakam Push channel URL inline so the user can
      // jump straight from this banner to their Push wallet's subscribe
      // page — no hunting through docs. When the channel address env
      // var isn't configured (degraded build) we fall back to the
      // text-only message so the rail still surfaces *something*
      // actionable.
      if (PUSH_CHANNEL_ADDRESS) {
        const channelUrl = `https://app.push.org/channels/${PUSH_CHANNEL_ADDRESS}`;
        setMsg(
          <span>
            Push rail enabled. You'll also need to subscribe to the Vaipakam
            Push channel from your Push-enabled wallet so the notifications
            actually land —{" "}
            <a href={channelUrl} target="_blank" rel="noreferrer">
              Subscribe on Push →
            </a>{" "}
            (channel <span className="mono">{PUSH_CHANNEL_ADDRESS}</span>).
          </span>,
        );
      } else {
        setMsg(
          "Push rail enabled. You'll also need to subscribe to the Vaipakam Push channel from your Push-enabled wallet to actually receive the notifications — see docs for the channel address.",
        );
      }
      step.success({ note: "push_channel=subscribed" });
    } catch (e) {
      // User-facing alert stays succinct (the bare error message);
      // the diagnostics drawer gets the enriched version with the
      // target URL + page origin + likely-cause hint synthesized in,
      // since the browser strips CORS reasons from JS-visible errors.
      setErr((e as Error).message);
      step.failure(enrichFetchError(e, fetchUrl));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-container">
      <h1 style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Bell size={22} style={{ verticalAlign: "-4px", marginRight: 8 }} />
        {t('appNav.alerts')}
        <CardInfo id="alerts.overview" />
      </h1>
      <p style={{ maxWidth: 720 }}>{t('alerts.pageSubtitle')}</p>

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
        <h2 style={{ fontSize: "1.05rem", margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
          {t('alerts.thresholdLadderTitle')}
          <CardInfo id="alerts.threshold-ladder" />
        </h2>
        <p style={{ fontSize: "0.85rem", opacity: 0.8, margin: "4px 0 16px" }}>
          {t('alertsPage.thresholdLadderBody')}
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(160px, max-content) 120px 1fr",
            gap: 12,
            alignItems: "center",
          }}
        >
          <label style={{ fontSize: "0.92rem" }}>{t('alertsPage.warnAtHf')}</label>
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
            {t('alertsPage.warnDescription')}
          </span>

          <label style={{ fontSize: "0.92rem" }}>{t('alertsPage.alertAtHf')}</label>
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
            {t('alertsPage.alertDescription')}
          </span>

          <label style={{ fontSize: "0.92rem" }}>{t('alertsPage.criticalAtHf')}</label>
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
            {t('alertsPage.criticalDescription')}
          </span>
        </div>

        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={save}
          style={{ marginTop: 16 }}
        >
          {saving ? t('alertsPage.saving') : t('alertsPage.saveThresholds')}
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
        <h2 style={{ fontSize: "1.05rem", margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
          {t('alerts.deliveryChannelsTitle')}
          <CardInfo id="alerts.delivery-channels" />
        </h2>
        <p style={{ fontSize: "0.85rem", opacity: 0.8, margin: "4px 0 16px" }}>
          {t('alertsPage.deliveryChannelBody')}
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
            <strong>{t('alertsPage.telegramTitle')}</strong>
          </div>
          <p style={{ fontSize: "0.82rem", opacity: 0.75, margin: "0 0 8px" }}>
            {t('alertsPage.telegramBody')}
          </p>
          {tgLinkCode ? (
            <div style={{ fontSize: "0.9rem" }}>
              {t('alerts.telegramHandshakeBody')}
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
                  {t('alerts.openTelegram')}
                </a>
              )}
            </div>
          ) : (
            <button
              className="btn btn-secondary btn-sm"
              disabled={linking}
              onClick={requestTelegramLink}
            >
              {linking ? t('alerts.requesting') : t('alerts.linkTelegram')}
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
            <strong>{t('alertsPage.pushTitle')}</strong>
          </div>
          <p style={{ fontSize: "0.82rem", opacity: 0.75, margin: "0 0 8px" }}>
            {t('alertsPage.pushBody')}
          </p>

          {PUSH_CHANNEL_ADDRESS && (
            <div
              style={{
                fontSize: "0.78rem",
                opacity: 0.85,
                margin: "0 0 8px",
                padding: "8px 10px",
                background: "var(--bg-muted)",
                borderRadius: 6,
              }}
            >
              <div style={{ marginBottom: 4 }}>
                <strong>{t('alertsPage.vaipakamChannel')}</strong>{" "}
                <span
                  className="mono"
                  style={{ wordBreak: "break-all" }}
                >
                  {PUSH_CHANNEL_ADDRESS}
                </span>
              </div>
              <div>
                <a
                  href={`https://app.push.org/channels/${PUSH_CHANNEL_ADDRESS}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('alertsPage.subscribeOnPush')}
                </a>{" "}
                ·{" "}
                <a
                  href="https://comms.push.org/docs/notifications/"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('alertsPage.pushDocs')}
                </a>
              </div>
            </div>
          )}

          <button
            className="btn btn-secondary btn-sm"
            disabled={saving}
            onClick={subscribePush}
          >
            {t('alertsPage.enablePush')}
          </button>
        </div>
      </section>
    </div>
  );
}
