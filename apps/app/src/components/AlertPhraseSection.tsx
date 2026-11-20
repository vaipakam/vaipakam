/**
 * #3346 — the alert phrase: a short phrase only the owner knows, which our
 * Telegram messages to the owner's private chat lead with, so a message
 * without it (or with another one) is visibly not ours. Telegram only: Push
 * notifications never show it.
 *
 * What this section knows and says:
 *  - whether a phrase is set and since when (the service never returns the
 *    phrase), or that it could not check;
 *  - a phrase is accepted or refused as typed, never cleaned, and a refusal
 *    names the rule it broke;
 *  - setting needs a private Telegram chat linked (the phrase is confirmed
 *    there), and a linked group chat is never shown it.
 *
 * The wallet signs a fingerprint of the phrase, never the phrase, so a
 * contract wallet's approval does not show it. A request waiting for such an
 * approval is kept in this browser without the phrase; finishing it asks the
 * owner to type the phrase again, checked against what was signed.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import {
  alertPhraseProblem,
  clearAlertPhrase,
  fetchAlertPhraseStatus,
  pendingPhraseMatches,
  setAlertPhrase,
} from '../data/alerts';
import type { PendingAlertRequest } from '../data/alertRequest';

interface Props {
  address: `0x${string}`;
  chainId: number;
  signMessage: (message: string) => Promise<string>;
  /** A kept phrase request the owner chose to finish, or null. */
  resume: PendingAlertRequest | null;
  /** Called when a request was answered, kept or dropped. */
  onSettled: () => void;
  /** True while another of the card's requests is running. */
  cardBusy: boolean;
}

/** The refusal copy for a phrase rule. */
function problemText(problem: NonNullable<ReturnType<typeof alertPhraseProblem>>): string {
  switch (problem) {
    case 'too-short':
      return copy.alerts.phraseTooShort;
    case 'too-long':
      return copy.alerts.phraseTooLong;
    case 'bad-characters':
      return copy.alerts.phraseBadCharacters;
    case 'not-normalised':
      return copy.alerts.phraseNotNormalised;
  }
}

export function AlertPhraseSection({ address, chainId, signMessage, resume, onSettled, cardBusy }: Props) {
  const queryClient = useQueryClient();
  const statusKey = ['alertPhraseStatus', address.toLowerCase()];
  const status = useQuery({ queryKey: statusKey, queryFn: () => fetchAlertPhraseStatus(address), staleTime: 30_000 });
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problem = phrase === '' ? null : alertPhraseProblem(phrase);
  const retyping = resume?.kind === 'set-phrase';

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onSettled();
      void queryClient.invalidateQueries({ queryKey: statusKey });
    }
  }

  function submit() {
    if (problem) return;
    if (retyping && resume && !pendingPhraseMatches(resume, phrase)) {
      setError(copy.alerts.phraseMismatch);
      return;
    }
    void run(async () => {
      const outcome = await setAlertPhrase(address, chainId, phrase, signMessage, retyping ? (resume ?? undefined) : undefined);
      if (outcome.kind === 'no-private-chat') {
        setError(copy.alerts.phraseLinkFirst);
        return;
      }
      setPhrase('');
      setNotice(outcome.groupLinked ? `${copy.alerts.phraseSaved} ${copy.alerts.phraseGroupNote}` : copy.alerts.phraseSaved);
    });
  }

  function clear(from?: PendingAlertRequest) {
    void run(async () => {
      await clearAlertPhrase(address, chainId, signMessage, from);
      setNotice(copy.alerts.phraseCleared);
    });
  }

  // A kept removal is finished as it was made, once per request.
  const finished = useRef<string | null>(null);
  useEffect(() => {
    if (resume?.kind === 'clear-phrase' && finished.current !== resume.requestKey) {
      finished.current = resume.requestKey;
      clear(resume);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);

  const disabled = busy || cardBusy;
  const isSet = status.data?.kind === 'set';

  return (
    <div className="stack" style={{ gap: 8 }} data-testid="alert-phrase">
      <strong>{copy.alerts.phraseTitle}</strong>
      <span className="muted">{copy.alerts.phraseBody}</span>
      <span className="muted">{copy.alerts.phraseTelegramOnly}</span>
      <span>
        {status.data?.kind === 'set'
          ? copy.alerts.phraseStatusSet(new Date(status.data.setAt * 1000).toLocaleString())
          : status.data?.kind === 'none'
            ? copy.alerts.phraseStatusNone
            : status.isLoading
              ? null
              : copy.alerts.phraseStatusUnknown}
      </span>
      {retyping ? <span role="status">{copy.alerts.phraseRetype}</span> : null}
      <label className="stack" style={{ gap: 4 }}>
        <span>{copy.alerts.phraseLabel}</span>
        <input
          className="input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          aria-invalid={problem !== null}
          disabled={disabled}
        />
      </label>
      <span className="muted" role={problem ? 'alert' : undefined}>{problem ? problemText(problem) : copy.alerts.phraseRules}</span>
      <div className="cluster" style={{ alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={disabled || phrase === '' || problem !== null}>
          {isSet ? copy.alerts.phraseChangeButton : copy.alerts.phraseSetButton}
        </button>
        {isSet ? (
          <button type="button" className="btn btn-secondary" onClick={() => clear()} disabled={disabled}>
            {copy.alerts.phraseClearButton}
          </button>
        ) : null}
      </div>
      <span className="muted">{copy.alerts.phraseSignNote}</span>
      {notice ? <span role="status">{notice}</span> : null}
      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </div>
  );
}
