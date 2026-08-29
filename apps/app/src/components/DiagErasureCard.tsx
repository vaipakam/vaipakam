/**
 * Signed erasure of the error reports support keeps (#2002).
 *
 * The Privacy Policy promises this control as a statement of legal
 * right: erasure of the server-side error-diagnostics records "by
 * signing an erasure request with that wallet in the app". The
 * service has existed since T-075; this card is the promised way in,
 * on the page whose scope list used to name these records as the one
 * thing it could not reach.
 *
 * WHAT THIS CARD MUST NOT DO is out-inform the service. The erasure
 * response is deliberately uniform — it never says whether records
 * existed, were deleted, or were retained under a (possibly gagged)
 * legal hold — so the card renders ONE confirmation for every
 * outcome the service reports as processed, with a static,
 * unconditional explainer saying exactly that. The status check
 * surfaces retention only where an operator has explicitly enabled
 * disclosure; its quiet answer is phrased as "no retained records
 * are REPORTED", never "nothing is retained", because the two are
 * different claims and only the first is knowable.
 */
import { useState } from 'react';
import { FileX2, ShieldCheck } from 'lucide-react';
import { useAccount, useSignMessage } from 'wagmi';
import { copy } from '../content/copy';
import {
  diagErasureConfigured,
  requestDiagErasure,
  requestDiagErasureStatus,
  type DiagErasureStatus,
} from '../data/diagErasure';
import { isUserRejection } from '../lib/errors';

type CardResult =
  | { kind: 'erased' }
  | { kind: 'status'; status: DiagErasureStatus }
  | { kind: 'unavailable' }
  | { kind: 'error' };

export function DiagErasureCard() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CardResult | null>(null);

  const configured = diagErasureConfigured();

  async function run(kind: 'erase' | 'status') {
    if (!address) return;
    setBusy(true);
    setResult(null);
    try {
      if (kind === 'erase') {
        const outcome = await requestDiagErasure(address, (message) =>
          signMessageAsync({ message }),
        );
        setResult(
          outcome === 'processed'
            ? { kind: 'erased' }
            : outcome === 'unavailable'
              ? { kind: 'unavailable' }
              : { kind: 'error' },
        );
      } else {
        const status = await requestDiagErasureStatus(address, (message) =>
          signMessageAsync({ message }),
        );
        setResult(
          status.status === 'unavailable'
            ? { kind: 'unavailable' }
            : status.status === 'error'
              ? { kind: 'error' }
              : { kind: 'status', status },
        );
      }
    } catch (e) {
      // A dismissed wallet prompt is a cancel, not a failure — the
      // card simply returns to rest. Anything else is reported.
      if (!isUserRejection(e)) setResult({ kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-title">
        <FileX2 size={16} aria-hidden="true" />
        <h2 style={{ margin: 0 }}>{copy.dataRights.diagTitle}</h2>
      </div>
      <p>{copy.dataRights.diagBody}</p>

      {!configured ? (
        <p className="muted">{copy.dataRights.diagNotConfigured}</p>
      ) : !address ? (
        <p className="muted">{copy.dataRights.diagConnect}</p>
      ) : (
        <>
          {result?.kind === 'erased' ? (
            <div className="banner banner-success" role="status">
              {copy.dataRights.diagProcessed}
            </div>
          ) : null}
          {result?.kind === 'status' ? (
            <div
              className={
                result.status.status === 'retained_by_law'
                  ? 'banner'
                  : 'banner banner-success'
              }
              role="status"
            >
              {result.status.status === 'retained_by_law' ? (
                <>
                  {copy.dataRights.diagRetainedLabel}
                  <br />
                  {/* The operator-authored disclosure note, verbatim —
                      the one message the service chose to surface. */}
                  {result.status.note}
                </>
              ) : (
                copy.dataRights.diagStatusClear
              )}
            </div>
          ) : null}
          {result?.kind === 'unavailable' ? (
            <div className="banner banner-danger" role="alert">
              {copy.dataRights.diagUnavailable}
            </div>
          ) : null}
          {result?.kind === 'error' ? (
            <div className="banner banner-danger" role="alert">
              {copy.dataRights.diagError}
            </div>
          ) : null}

          <div className="cluster">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void run('erase')}
              disabled={busy}
            >
              <FileX2 size={14} aria-hidden="true" />
              {busy ? copy.dataRights.diagBusy : copy.dataRights.diagEraseButton}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void run('status')}
              disabled={busy}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              {copy.dataRights.diagStatusButton}
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            {copy.dataRights.diagSignNote}
          </p>
          {/* Static and unconditional — shown to everyone identically,
              so the explainer itself carries no signal about anyone's
              records. */}
          <p className="muted" style={{ marginBottom: 0 }}>
            {copy.dataRights.diagUniformNote}
          </p>
        </>
      )}
    </section>
  );
}
