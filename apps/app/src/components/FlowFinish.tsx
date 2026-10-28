/**
 * The two ends of a guided flow's signing step, shared by the offer flow
 * and both rental flows (#2532): the review footer (consent, the submit
 * error, back and submit) and the done card. Each was copied into three
 * places, so a fix to one (a label, a spacing, the progress wording) had
 * to be made three times and could be missed in one.
 *
 * The CALLER keeps everything that differs: what consenting stamps, what
 * going back resets, the done card's own actions. These components carry
 * only what is the same in all three.
 */
import type { ReactNode } from 'react';
import { CircleCheck, LoaderCircle } from 'lucide-react';
import { copy } from '../content/copy';
import type { SubmitProgress } from '../lib/submitProgress';
import type { ReviewConsent } from '../hooks/useReviewConsent';
import { ConsentLabel } from './ConsentLabel';
import { ConsentWithdrawnNote } from './ConsentWithdrawnNote';

/**
 * The submit button's label: the flow's own action while idle, "waiting for
 * your wallet" during the checks before the first prompt, then which prompt
 * of how many the wallet is showing (#1037).
 */
export function submitProgressLabel(
  progress: SubmitProgress | null,
  labels: { idle: string; waiting: string },
): string {
  if (progress === null) return labels.idle;
  if (progress.current === 0) return labels.waiting;
  switch (progress.kind) {
    case 'sign':
      return copy.signing.phaseSign(progress.current, progress.total);
    case 'permit':
      return copy.signing.phasePermit(progress.current, progress.total);
    case 'approve':
      return copy.signing.phaseApprove(progress.current, progress.total);
    default:
      return copy.signing.phaseSend(progress.current, progress.total);
  }
}

export function ReviewFooter({
  consent,
  error,
  backLabel,
  onBack,
  busy,
  canSign,
  onSubmit,
  progress,
  submitLabel,
  waitingLabel,
}: {
  /** The review's consent, from `useReviewConsent` (#1696): the box shows
   *  it, it clears itself when the reviewed values change, and the note
   *  beneath says so. Taking the hook's object rather than a boolean keeps
   *  every footer on that one rule. */
  consent: ReviewConsent;
  error: string | null;
  backLabel: string;
  onBack: () => void;
  /** A submission is in flight: back is disabled and the spinner shows. */
  busy: boolean;
  canSign: boolean;
  onSubmit: () => void;
  progress: SubmitProgress | null;
  submitLabel: string;
  waitingLabel: string;
}) {
  return (
    <>
      <label
        className="cluster"
        style={{ marginTop: 16, fontSize: '0.9rem', alignItems: 'flex-start' }}
      >
        <input
          type="checkbox"
          checked={consent.given}
          onChange={(e) => consent.set(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <ConsentLabel />
      </label>
      <ConsentWithdrawnNote consent={consent} />
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
      <div className="cluster" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onBack}
          disabled={busy}
        >
          {backLabel}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          style={{ flex: 1 }}
          disabled={!canSign}
          onClick={onSubmit}
        >
          {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
          {submitProgressLabel(progress, { idle: submitLabel, waiting: waitingLabel })}
        </button>
      </div>
    </>
  );
}

export function FlowDoneCard({
  title,
  body,
  tx,
  children,
}: {
  title: string;
  body: string;
  /** The transaction to link, when one is known. */
  tx: { href: string; label: string } | null;
  /** The flow's own next actions. */
  children: ReactNode;
}) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <CircleCheck aria-hidden size={40} style={{ color: 'var(--ok)', marginBottom: 8 }} />
      <h2>{title}</h2>
      <p className="muted">{body}</p>
      {tx ? (
        <p className="muted">
          <a href={tx.href} target="_blank" rel="noreferrer">
            {tx.label}
          </a>
        </p>
      ) : null}
      {children}
    </div>
  );
}
