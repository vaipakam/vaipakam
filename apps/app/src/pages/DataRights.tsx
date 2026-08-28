/**
 * Data Rights (#1960) — export and local erasure for the state this
 * app keeps in the browser.
 *
 * WHY IT LIVES HERE AND NOT ONLY ON THE MARKETING SITE. `apps/www`
 * has a Data Rights page whose controls work, and they do not reach
 * this app: same-origin isolation means code on the marketing origin
 * can neither read nor clear this origin's storage. Two origins, two
 * stores. The retired `apps/defi` carried its own page; the #1854
 * cutover removed the capability without replacing it.
 *
 * The page's job beyond the two buttons is to be HONEST ABOUT SCOPE.
 * The likeliest way a page like this misleads somebody is by letting
 * them believe an erase reaches further than it does — so what it
 * cannot touch (the chain, the alerts service, the marketing site's
 * own store) is stated as prominently as what it can, and the shared
 * language/theme cookie is called out because clearing it here also
 * clears it there.
 *
 * The count of stored items is shown BEFORE the confirm, so the
 * destructive button is not a leap in the dark, and the result is
 * reported afterwards as a count rather than a blanket "done" — see
 * `eraseMyData` for why "erased", "nothing was stored" and "storage
 * refused" have to stay three different answers.
 */
import { useState } from 'react';
import { Download, ShieldAlert, Trash2, CheckCircle, Info } from 'lucide-react';
import { copy } from '../content/copy';
import { eraseMyData, inspectMyData, type EraseResult } from '../lib/dataRights';

/** Serialise and hand the file to the browser. Kept here rather than
 *  in `dataRights.ts` so that module stays free of DOM side effects
 *  and testable in the node environment this app's vitest uses. */
function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoked on the next tick: revoking synchronously can cancel the
  // download in some browsers before it has actually started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DataRights() {
  const [downloaded, setDownloaded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<EraseResult | null>(null);
  // Read on render rather than held in state: after an erase the page
  // must show the new figure, and a stale count on a data-rights page
  // is the same class of untruth as a false success message. One
  // snapshot, so the count, the refusal state and the downloadable
  // payload all describe the same moment.
  const snapshot = inspectMyData();
  const stored = snapshot.count;
  // Review round 1 P1: "could not read" is not "nothing is here". With
  // them collapsed, a browser refusing to be read disabled both buttons
  // and told the user their storage was empty — the refusal message
  // below unreachable in the one case it was written for.
  const refused = snapshot.refused;

  function onDownload() {
    downloadJson(
      `vaipakam-app-data-${new Date().toISOString().slice(0, 10)}.json`,
      snapshot.payload,
    );
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2500);
  }

  function onErase() {
    setResult(eraseMyData());
    setConfirming(false);
    // Deliberately NO page reload. The retired implementation reloaded
    // so every hook rehydrated from empty storage — but a reload also
    // throws away the result message, so the user is returned to a
    // fresh page with no confirmation that anything happened, which on
    // this page is the whole point. The contexts read storage on mount
    // and fall back to defaults, so what is on screen stays coherent.
  }

  return (
    <div className="stack" style={{ maxWidth: 760, gap: 16 }}>
      <div className="page-header">
        <h1 className="page-title">{copy.dataRights.title}</h1>
        <p className="page-subtitle">{copy.dataRights.subtitle}</p>
      </div>

      <section className="card">
        <div className="card-title">
          <Info size={16} aria-hidden="true" />
          <h2 style={{ margin: 0 }}>{copy.dataRights.holdingTitle}</h2>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {refused
            ? copy.dataRights.holdingUnreadable
            : stored === 0
              ? copy.dataRights.holdingNone
              : copy.dataRights.holdingCount(stored)}
        </p>
      </section>

      <section className="card">
        <div className="card-title">
          <Download size={16} aria-hidden="true" />
          <h2 style={{ margin: 0 }}>{copy.dataRights.downloadTitle}</h2>
        </div>
        <p>{copy.dataRights.downloadBody}</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onDownload}
          disabled={stored === 0}
        >
          {downloaded ? (
            <CheckCircle size={14} aria-hidden="true" />
          ) : (
            <Download size={14} aria-hidden="true" />
          )}
          {downloaded ? copy.dataRights.downloadDone : copy.dataRights.downloadButton}
        </button>
      </section>

      <section className="card">
        <div className="card-title">
          <Trash2 size={16} aria-hidden="true" />
          <h2 style={{ margin: 0 }}>{copy.dataRights.eraseTitle}</h2>
        </div>
        <p>{copy.dataRights.eraseBody}</p>

        {result ? (
          <div
            className={
              stored === 0 && result.total > 0 ? 'banner banner-success' : 'banner'
            }
            role="status"
          >
            {/* Four outcomes, four messages, and anything REMAINING
                outranks anything removed (review round 1 P1). Choosing
                the success message off a positive removed-count while
                items are still there is the false assurance this page
                must not give. */}
            {stored > 0
              ? result.total > 0
                ? copy.dataRights.erasePartial(result.total, stored)
                : copy.dataRights.eraseBlocked
              : result.total > 0
                ? copy.dataRights.eraseDone(result.total)
                : copy.dataRights.eraseNothing}
          </div>
        ) : null}

        {confirming ? (
          <>
            <p className="muted">{copy.dataRights.eraseConfirmPrompt}</p>
            <div className="cluster">
              <button type="button" className="btn btn-danger" onClick={onErase}>
                {copy.dataRights.eraseConfirm}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirming(false)}
              >
                {copy.dataRights.eraseCancel}
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setResult(null);
              setConfirming(true);
            }}
            disabled={stored === 0}
          >
            <Trash2 size={14} aria-hidden="true" />
            {copy.dataRights.eraseButton}
          </button>
        )}
      </section>

      <section className="card">
        <div className="card-title">
          <ShieldAlert size={16} aria-hidden="true" />
          <h2 style={{ margin: 0 }}>{copy.dataRights.scopeTitle}</h2>
        </div>
        <ul className="stack" style={{ gap: 8, paddingLeft: 20, margin: 0 }}>
          <li>{copy.dataRights.scopeChain}</li>
          <li>{copy.dataRights.scopeAlerts}</li>
          <li>{copy.dataRights.scopeDiagnostics}</li>
          <li>{copy.dataRights.scopeSite}</li>
          <li>{copy.dataRights.scopeCookies}</li>
        </ul>
      </section>
    </div>
  );
}
