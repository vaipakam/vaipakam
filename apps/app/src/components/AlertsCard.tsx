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
 *  - Push is offered only when the agent says its rail can send
 *    (#2251), and the subscribe link opens the channel the agent posts
 *    as. An unavailable rail, or one the card could not ask about, is
 *    stated instead of offering an opt-in that would do nothing.
 *  - The on-chain consent to be charged for paid Push (#2723) sits below
 *    the rail, in `PaidPushConsent`, read from the chain and offered only
 *    where the agent says Push is billed; withdrawing it always works.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { useAccount, useSignMessage } from 'wagmi';
import { useMode } from '../app/ModeContext';
import { chainDisplayName } from '../chain/chains';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';
import { useTermsBlockNonExitWrites } from '../contracts/diamond';
import { PaidPushConsent } from './PaidPushConsent';
import {
  addsAlertOptIn,
  alertsConfigured,
  bandsValid,
  issueTelegramLink,
  loadAlertPrefs,
  fetchPushStatus,
  saveAlertPrefs,
  sendTestTelegramAlert,
  storeAlertPrefs,
  unlinkTelegram,
  type AlertPrefs,
  type TelegramLink,
} from '../data/alerts';

export function AlertsCard() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const termsVerdict = useTermsBlockNonExitWrites();
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
  // #2251 — whether Push can be sent is the AGENT's answer, read before the
  // opt-in is offered, and the channel the subscribe link opens is the one
  // the agent posts as. Never inferred from a build-time address.
  const pushStatus = useQuery({
    queryKey: ['pushStatus'],
    queryFn: fetchPushStatus,
    enabled: configured,
    staleTime: 60_000,
  });
  const pushRail = pushStatus.data?.rail;


  /**
   * #1961 review round 8 P1 — enrolment is gated, opting out is not.
   *
   * `/settings` is exempt so a held user can revoke a token allowance,
   * which also exposed every control on this card. None of them reaches
   * `useDiamondWrite` — linking signs and posts to the agent, saving
   * writes the agent's threshold record — so the write gate cannot see
   * them, and neither the agent nor the indexer carries a Terms check.
   *
   * The direction decides: turning something ON, or linking a channel,
   * is enrolment and waits for acceptance. Turning something OFF, or
   * unlinking, is an opt-out and must always work — the same rule as
   * keeper and fee-consent revocation, applied to a surface that never
   * touches the chain.
   */
  function termsBlockEnrolment(): string | null {
    const v = termsVerdict();
    if (v === 'ok') return null;
    return v === 'unknown'
      ? copy.errors.termsCheckUnavailable
      : copy.errors.termsNotAccepted;
  }

  async function persist(
    next: AlertPrefs,
    opts?: { dueDateChanged?: boolean; bandsChanged?: boolean },
  ) {
    // `prefs` is the direction baseline and is required, not optional —
    // every caller below is inside the branch that renders only once it
    // is loaded, and the guard makes that reachability explicit rather
    // than papering over it with a nullable comparison.
    if (!address || !prefs) return;
    // Only an ENROLMENT is held — a save that ADDS an opt-in. Turning
    // one off, or tuning bands, goes through whatever the Terms say.
    // The direction is compared per field against what is stored now;
    // see `addsAlertOptIn` for why the round-8 "is anything still on
    // afterwards" test was the wrong question.
    if (addsAlertOptIn(prefs, next)) {
      const blocked = termsBlockEnrolment();
      if (blocked) {
        setError(blocked);
        return;
      }
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // dueDateChanged rides through so the field is sent ONLY when
      // this save is the user flipping that toggle — any other save
      // omits it and the agent preserves the stored value (a fresh
      // device's defaults must not undo an opt-out made elsewhere).
      // Every save is signed by the wallet over a message naming what it
      // changes (#2754); the agent stores nothing unsigned.
      // bandsChanged mirrors it for the risky lane (#2000): the bands
      // carry that lane's state, so they are sent only when this save
      // is the user touching the toggle or the advanced numbers — any
      // other save omits them and the agent preserves what is stored.
      const push = await saveAlertPrefs(address, chainId, next, {
        dueDateChanged: opts?.dueDateChanged,
        bandsChanged: opts?.bandsChanged,
        signMessage: (message) => signMessageAsync({ message }),
      });
      // #2251 — the agent stores a NEW Push opt-in only where it can send,
      // and keeps one already stored. `unavailable` therefore means Push is
      // not stored for this wallet (the rest of the save landed): it shows
      // off here too, and the card re-reads the rail's status.
      const refusedEnable = push === 'unavailable';
      const saved = refusedEnable ? { ...next, pushEnabled: false } : next;
      storeAlertPrefs(chainId, address, saved);
      setPrefs(saved);
      if (refusedEnable) {
        void pushStatus.refetch();
        setNotice(copy.alerts.pushNotSaved);
      } else {
        setNotice(copy.alerts.saved);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startLink() {
    const blockedLink = termsBlockEnrolment();
    if (blockedLink) {
      setError(blockedLink);
      return;
    }
    if (!address) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Deliberately NO pre-save here: on a fresh device the local
      // prefs are the DEFAULTS, and writing them before the handshake
      // would clobber whatever the wallet already configured
      // elsewhere. The agent tolerates a missing row during the
      // handshake (locale falls back to 'en'), so linking alone must
      // never write settings.
      //
      // The wallet signs a free ownership proof first — the agent
      // refuses to issue a link code without it, so nobody can point
      // another wallet's alerts at their own Telegram.
      setLink(
        await issueTelegramLink(address, chainId, (message) =>
          signMessageAsync({ message }),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // UX-012 — a REAL round-trip replaces the old self-attested "I've
  // done it" button: the agent pushes a test message to the linked
  // chat, and we only record "linked" once that send succeeds. A
  // fumbled handshake (code never sent to the bot) now surfaces as an
  // honest "we couldn't find your chat" instead of silently dropping
  // every future alert.
  async function sendTest() {
    if (!address || !prefs) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendTestTelegramAlert(address, chainId, (message) =>
        signMessageAsync({ message }),
      );
      if (result === 'sent') {
        const next = { ...prefs, telegramLinked: true };
        storeAlertPrefs(chainId, address, next);
        setPrefs(next);
        setLink(null);
        setNotice(copy.alerts.testAlertSent);
      } else if (result === 'not-linked') {
        setError(copy.alerts.testAlertNotLinked);
      } else {
        setError(copy.alerts.testAlertError);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // UX-012 / Codex #1175 — abandon the issued (possibly expired, 10-min
  // TTL) code and return to the Link step, so a stale code isn't a dead
  // end: "send the code above" can't succeed once it's expired, and the
  // start-link button is hidden while `link` is set.
  function startOver() {
    setLink(null);
    setError(null);
    setNotice(null);
  }

  async function doUnlink() {
    if (!address || !prefs) return;
    // Captured at the click (#2013 r6): the completion can land after
    // a network switch, and the chain-scoped notice must name the
    // network the unlink actually covered — never "this network".
    const forChain = chainId;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Signed like linking — otherwise anyone could silently switch
      // off another wallet's risk alerts.
      const scope = await unlinkTelegram(address, forChain, (message) =>
        signMessageAsync({ message }),
      );
      const next = { ...prefs, telegramLinked: false };
      storeAlertPrefs(forChain, address, next);
      setPrefs(next);
      setNotice(
        scope === 'chain'
          ? copy.alerts.unlinkedChainOnly(
              chainDisplayName(forChain) ?? String(forChain),
            )
          : copy.alerts.unlinked,
      );
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
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted" style={{ margin: 0 }}>{copy.alerts.notConfigured}</p>
          {/* #2723 — a consent stored on chain stays withdrawable even from a
              deployment with no alert service; with no service to ask, the
              billing posture is unknown and nothing is offered but that. */}
          {address ? <PaidPushConsent billing={undefined} /> : null}
        </div>
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
                {/* UX-012 — prove the link with a real message instead
                    of the old self-attested confirm. */}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void sendTest()}
                  disabled={busy}
                >
                  {busy
                    ? copy.alerts.testAlertSending
                    : copy.alerts.testAlertButton}
                </button>
                {/* UX-012 — recover from an expired code (10-min TTL):
                    abandon it and return to the Link step for a fresh
                    one, instead of being stuck showing a dead code. */}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={startOver}
                  disabled={busy}
                >
                  {copy.alerts.startOver}
                </button>
              </div>
              <span className="muted">{copy.alerts.testAlertNote}</span>
            </div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {/* UX3-013 — say what this browser knows: no link was made
                  from here. It cannot see a link made on another device,
                  and says so instead of implying "not linked anywhere". */}
              <p style={{ margin: 0 }}>{copy.alerts.notLinkedHere}</p>
              <div className="cluster" style={{ alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void startLink()}
                  disabled={busy}
                  title={copy.alerts.linkSignNote}
                >
                  {copy.alerts.linkButton}
                </button>
                <span className="muted" style={{ flexBasis: '100%' }}>
                  {copy.alerts.linkSignNote}
                </span>
              </div>
              {/* UX-043 — the linked flag is a LOCAL mirror, so a wallet
                  linked from another device (or after clearing storage)
                  still needs its privacy control. A clearly-labelled
                  block with its own explanation, not an ambiguous
                  centered link (server-side unlink is idempotent). */}
              <div className="stack" style={{ gap: 4 }}>
                <strong>{copy.alerts.unlinkElsewhereTitle}</strong>
                <span className="muted">{copy.alerts.unlinkElsewhereBody}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void doUnlink()}
                  disabled={busy}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {copy.alerts.unlinkElsewhere}
                </button>
              </div>
            </div>
          )}

          <label className="cluster" style={{ alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={prefs.repayDue}
              disabled={busy}
              onChange={(e) =>
                void persist(
                  { ...prefs, repayDue: e.target.checked },
                  { dueDateChanged: true },
                )
              }
              style={{ marginTop: 3 }}
            />
            <span style={{ flex: 1 }}>{copy.alerts.toggleRepayDue}</span>
          </label>
          <label className="cluster" style={{ alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={prefs.risky}
              disabled={busy}
              onChange={(e) =>
                void persist(
                  { ...prefs, risky: e.target.checked },
                  { bandsChanged: true },
                )
              }
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
              onSave={(b) => void persist({ ...prefs, ...b }, { bandsChanged: true })}
            />
          ) : null}

          <div>
            <h3 style={{ marginBottom: 4 }}>{copy.alerts.pushTitle}</h3>
            <p className="muted" style={{ marginTop: 0 }}>{copy.alerts.pushBody}</p>
            {pushRail?.kind === 'available' ? (
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
                <a
                  className="btn btn-secondary"
                  href={pushRail.channelUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {copy.alerts.pushButton}
                </a>
                {/* Codex #2665 r1 — the answer covers the agent's rail only
                    (payment reminders); the risky-loan warnings come from
                    the keeper, which this check cannot see. Said, not
                    implied, until a combined answer exists. */}
                {pushRail.scope === 'agent' ? (
                  <p className="muted" style={{ margin: 0, flexBasis: '100%' }}>
                    {copy.alerts.pushScopeAgent}
                  </p>
                ) : null}
              </div>
            ) : (
              // Not offered unless the agent says the rail can send: an
              // unavailable rail and one we could not ask about are both
              // stated, never shown as an option that would do nothing.
              <p className="muted" role="status" style={{ margin: 0 }}>
                {pushRail === undefined
                  ? copy.alerts.pushChecking
                  : pushRail.kind === 'unavailable'
                    ? copy.alerts.pushUnavailable
                    : copy.alerts.pushUnknown}
                {pushRail !== undefined && prefs.pushEnabled
                  ? ` ${copy.alerts.pushKeptNote}`
                  : ''}
              </p>
            )}
          </div>

          {/* #2723 — the on-chain consent to be charged for paid Push. It is
              read whenever the billing posture is known or not, because a
              stored consent must always be withdrawable. */}
          {pushStatus.data !== undefined ? (
            <PaidPushConsent billing={pushStatus.data.billing} />
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
        {field(copy.alerts.bandWarn, warn, setWarn)}
        {field(copy.alerts.bandAlert, alert, setAlert)}
        {field(copy.alerts.bandCritical, critical, setCritical)}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !valid}
          onClick={() => onSave(bands)}
        >
          {copy.alerts.bandsSave}
        </button>
      </div>
      {!valid ? (
        <p className="muted" style={{ marginTop: 8 }}>{copy.alerts.bandsInvalid}</p>
      ) : null}
    </div>
  );
}
