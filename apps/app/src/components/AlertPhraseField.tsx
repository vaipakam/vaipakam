/**
 * #3346 — the owner's anti-phishing phrase, inside the Alerts card.
 *
 * The owner types a phrase, signs a free message naming it, and the
 * alert service starts every Telegram alert to this wallet with it. A
 * message without it did not come from Vaipakam. Removing it is the same
 * signed request with no phrase.
 *
 * The phrase is never shown back and never stored in this browser: the
 * input is cleared once the request is sent, and the service has no route
 * that reads it back. Push notifications never carry it, because they are
 * not private to the owner; the copy says so.
 *
 * Scope follows the signer's authority: an ordinary wallet's signature
 * sets it on every network the service covers, a smart account's on the
 * signed network only, and the confirmation names which.
 */
import { useState } from 'react';
import { normaliseAlertPhrase } from '@vaipakam/lib/alertPhrase';
import { chainDisplayName } from '../chain/chains';
import { copy } from '../content/copy';
import { setAlertPhrase } from '../data/alerts';

export interface AlertPhraseFieldProps {
  address: `0x${string}`;
  chainId: number;
  signMessage: (message: string) => Promise<string>;
  /** Disabled while another alerts request is in flight. */
  disabled: boolean;
}

export function AlertPhraseField({ address, chainId, signMessage, disabled }: AlertPhraseFieldProps) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = normaliseAlertPhrase(draft) !== null;

  async function submit(remove: boolean) {
    // Captured at the click: the reply can land after a network switch,
    // and a per-network confirmation must name the network it covered.
    const forChain = chainId;
    if (!remove && !valid) {
      setError(copy.alerts.phraseInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await setAlertPhrase(address, forChain, remove ? null : draft, signMessage);
      if (result.kind === 'saved') {
        setDraft('');
        const network = chainDisplayName(forChain) ?? String(forChain);
        if (remove) {
          setNotice(
            result.scope === 'chain' ? copy.alerts.phraseRemovedChainOnly(network) : copy.alerts.phraseRemoved,
          );
        } else {
          setNotice(
            result.scope === 'chain' ? copy.alerts.phraseSavedChainOnly(network) : copy.alerts.phraseSaved,
          );
        }
      } else if (result.kind === 'invalid') {
        setError(copy.alerts.phraseInvalid);
      } else {
        setError(copy.alerts.phraseError);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const off = disabled || busy;
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="alert-phrase">
      <strong>{copy.alerts.phraseTitle}</strong>
      <span className="muted">{copy.alerts.phraseBody}</span>
      <label className="stack" style={{ gap: 4 }}>
        <span>{copy.alerts.phraseLabel}</span>
        <input
          type="text"
          className="input"
          value={draft}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          disabled={off}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="alert-phrase-input"
        />
        <span className="muted">{copy.alerts.phraseHint}</span>
      </label>
      <div className="cluster" style={{ alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit(false)}
          disabled={off || !valid}
          data-testid="alert-phrase-save"
        >
          {busy ? copy.alerts.phraseSaving : copy.alerts.phraseSave}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void submit(true)}
          disabled={off}
          data-testid="alert-phrase-remove"
        >
          {copy.alerts.phraseRemove}
        </button>
      </div>
      <span className="muted">{copy.alerts.phraseSignNote}</span>
      {notice ? (
        <p role="status" className="muted" style={{ margin: 0 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </div>
  );
}
