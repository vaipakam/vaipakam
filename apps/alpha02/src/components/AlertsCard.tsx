/**
 * Alerts card (#1033) — Telegram + Push rails with naive-user
 * OUTCOME toggles, in Settings.
 *
 * Design decisions this card encodes:
 *  - Outcomes, not numbers: "before a repayment is due" and "if my
 *    loan gets risky" — the raw HF bands live behind the existing
 *    advanced-mode reveal with the same 1.5/1.2/1.05 defaults
 *    apps/defi exposes directly.
 *  - No claim-ready toggle: the backend has no claim-ready detector
 *    yet, and this surface never promises what won't arrive.
 *  - Fail-closed: without VITE_AGENT_ORIGIN the card says so and
 *    fires nothing.
 *  - One honest privacy sentence + a working Unlink (the agent's
 *    /unlink/telegram, added with this feature).
 *  - Linked-state is an optimistic local record: the agent has no
 *    read-back endpoint, so "linked" mirrors what the user completed
 *    on this device; Unlink always works regardless.
 */
import { useMemo, useState } from 'react';
import { BellRing } from 'lucide-react';
import { useAccount } from 'wagmi';
import { useMode } from '../app/ModeContext';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';
import {
  alertsConfigured,
  bandsValid,
  issueTelegramLink,
  loadAlertPrefs,
  pushChannelUrl,
  saveAlertPrefs,
  storeAlertPrefs,
  unlinkTelegram,
  type AlertPrefs,
  type TelegramLink,
} from '../data/alerts';

export function AlertsCard() {
  const { address } = useAccount();
  const { readChain } = useActiveChain();
  const { isAdvanced } = useMode();
  const chainId = readChain.chainId;

  const initial = useMemo(
    () => (address ? loadAlertPrefs(chainId, address) : null),
    [address, chainId],
  );
  const [prefs, setPrefs] = useState<AlertPrefs | null>(initial);
  const [link, setLink] = useState<TelegramLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Re-derive when the wallet/chain changes (state init runs once).
  const [scope, setScope] = useState(`${chainId}:${address ?? ''}`);
  if (scope !== `${chainId}:${address ?? ''}`) {
    setScope(`${chainId}:${address ?? ''}`);
    setPrefs(address ? loadAlertPrefs(chainId, address) : null);
    setLink(null);
    setNotice(null);
    setError(null);
  }

  const configured = alertsConfigured();
  const pushUrl = pushChannelUrl();

  async function persist(next: AlertPrefs) {
    if (!address) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveAlertPrefs(address, chainId, next);
      storeAlertPrefs(chainId, address, next);
      setPrefs(next);
      setNotice(copy.alerts.saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startLink() {
    if (!address) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Ensure the thresholds row exists before the handshake so the
      // bot's confirmation lands on a real row (the agent tolerates
      // either order; this removes the race).
      if (prefs) await saveAlertPrefs(address, chainId, prefs);
      setLink(await issueTelegramLink(address, chainId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmLinked() {
    if (!address || !prefs) return;
    const next = { ...prefs, telegramLinked: true };
    storeAlertPrefs(chainId, address, next);
    setPrefs(next);
    setLink(null);
  }

  async function doUnlink() {
    if (!address || !prefs) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await unlinkTelegram(address, chainId);
      const next = { ...prefs, telegramLinked: false };
      storeAlertPrefs(chainId, address, next);
      setPrefs(next);
      setNotice(copy.alerts.unlinked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-title">
        <BellRing aria-hidden />
        <h2 style={{ margin: 0 }}>{copy.alerts.title}</h2>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>{copy.alerts.lede}</p>

      {!configured ? (
        <p className="muted">{copy.alerts.notConfigured}</p>
      ) : !address || !prefs ? (
        <p className="muted">{copy.alerts.connectFirst}</p>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted" style={{ margin: 0 }}>{copy.alerts.privacy}</p>

          {prefs.telegramLinked ? (
            <div className="cluster" style={{ alignItems: 'center' }}>
              <span>{copy.alerts.linked}</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void doUnlink()}
                disabled={busy}
              >
                {copy.alerts.unlink}
              </button>
            </div>
          ) : link ? (
            <div className="stack" style={{ gap: 8 }}>
              <p style={{ margin: 0 }}>{copy.alerts.linkIssued}</p>
              <pre className="mono" style={{ fontSize: 18, margin: 0 }}>{link.code}</pre>
              <div className="cluster">
                {link.botUrl ? (
                  <a
                    className="btn btn-primary"
                    href={link.botUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {copy.alerts.openBot}
                  </a>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={confirmLinked}
                >
                  {copy.alerts.linkConfirm}
                </button>
              </div>
            </div>
          ) : (
            <div className="cluster" style={{ alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void startLink()}
                disabled={busy}
              >
                {copy.alerts.linkButton}
              </button>
              {/* The linked flag is a LOCAL mirror — a wallet linked
                  from another device (or after clearing storage)
                  still deserves its privacy control, so unlink stays
                  reachable here too (server-side it's idempotent). */}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void doUnlink()}
                disabled={busy}
              >
                {copy.alerts.unlinkElsewhere}
              </button>
            </div>
          )}

          <label className="cluster" style={{ alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={prefs.repayDue}
              disabled={busy}
              onChange={(e) => void persist({ ...prefs, repayDue: e.target.checked })}
              style={{ marginTop: 3 }}
            />
            <span style={{ flex: 1 }}>{copy.alerts.toggleRepayDue}</span>
          </label>
          <label className="cluster" style={{ alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={prefs.risky}
              disabled={busy}
              onChange={(e) => void persist({ ...prefs, risky: e.target.checked })}
              style={{ marginTop: 3 }}
            />
            <span style={{ flex: 1 }}>
              {copy.alerts.toggleRisky}
              {!prefs.risky ? (
                <>
                  <br />
                  <span className="muted">{copy.alerts.riskyOffNote}</span>
                </>
              ) : null}
            </span>
          </label>

          {isAdvanced && prefs.risky ? (
            // Keyed by scope so a wallet/chain switch can never leave
            // the previous scope's numbers in the inputs and write
            // them to the new scope on Save.
            <AdvancedBands
              key={scope}
              prefs={prefs}
              busy={busy}
              onSave={(b) => void persist({ ...prefs, ...b })}
            />
          ) : null}

          {pushUrl ? (
            <div>
              <h3 style={{ marginBottom: 4 }}>{copy.alerts.pushTitle}</h3>
              <p className="muted" style={{ marginTop: 0 }}>{copy.alerts.pushBody}</p>
              <div className="cluster">
                {/* Delivery needs BOTH halves: the service-side flag
                    (push_channel, written here) AND the wallet-side
                    channel subscription (done on app.push.org). */}
                {!prefs.pushEnabled ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void persist({ ...prefs, pushEnabled: true })}
                  >
                    {copy.alerts.pushEnable}
                  </button>
                ) : (
                  <span className="muted">{copy.alerts.pushEnabled}</span>
                )}
                <a className="btn btn-secondary" href={pushUrl} target="_blank" rel="noreferrer">
                  {copy.alerts.pushButton}
                </a>
              </div>
            </div>
          ) : null}

          {notice ? <p className="muted" style={{ margin: 0 }}>{notice}</p> : null}
          {error ? (
            <div className="banner banner-danger" role="alert">
              <span className="banner-body">{error}</span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Advanced-mode reveal: the raw HF bands behind the "risky" toggle.
 *  Same semantics as apps/defi's three-number form, same defaults. */
function AdvancedBands({
  prefs,
  busy,
  onSave,
}: {
  prefs: AlertPrefs;
  busy: boolean;
  onSave: (bands: { warnHf: number; alertHf: number; criticalHf: number }) => void;
}) {
  const [warn, setWarn] = useState(String(prefs.warnHf));
  const [alert, setAlert] = useState(String(prefs.alertHf));
  const [critical, setCritical] = useState(String(prefs.criticalHf));
  const bands = {
    warnHf: Number(warn),
    alertHf: Number(alert),
    criticalHf: Number(critical),
  };
  const valid =
    [bands.warnHf, bands.alertHf, bands.criticalHf].every(Number.isFinite) &&
    bandsValid(bands);
  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
  ) => (
    <label className="field" style={{ flex: 1, minWidth: 90 }}>
      <span className="field-hint">{label}</span>
      <input
        className="input"
        type="number"
        step="0.01"
        min="1.01"
        max="5"
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
  return (
    <div>
      <p className="muted" style={{ marginBottom: 8 }}>{copy.alerts.advancedBands}</p>
      <div className="cluster">
        {field('Warn', warn, setWarn)}
        {field('Alert', alert, setAlert)}
        {field('Critical', critical, setCritical)}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !valid}
          onClick={() => onSave(bands)}
        >
          Save
        </button>
      </div>
      {!valid ? (
        <p className="muted" style={{ marginTop: 8 }}>{copy.alerts.bandsInvalid}</p>
      ) : null}
    </div>
  );
}
