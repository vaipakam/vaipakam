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
import { useTheme } from '../app/ThemeContext';
import { useMode } from '../app/ModeContext';
import { useTranslation } from 'react-i18next';
import { bumpEraseEpoch } from '../lib/eraseEpoch';

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
  // Review round 1 P2: the providers sit ABOVE this route and read
  // storage only on their own mount, so clearing the keys left the live
  // theme and mode showing the erased values until a reload — the page
  // promising in copy that preferences return to their defaults while
  // the app visibly kept them.
  const { resetToDefault: resetTheme } = useTheme();
  const { resetToDefault: resetMode } = useMode();
  // Language is the third live preference (review round 2 P2). i18next
  // is a singleton held above this route, so clearing its key left the
  // erased language active and the picker still showing it — while the
  // copy promised the user would be asked again.
  const { i18n } = useTranslation();
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
    // Language goes back to the default BEFORE the erase, deliberately.
    // `changeLanguage` persists — to the key and the shared-domain
    // cookie — so running it afterwards would rewrite what the erase
    // had just removed. Doing it first means the erase clears its
    // write, and the order is the whole mechanism rather than an
    // accident of statement order.
    void i18n.changeLanguage('en');
    setResult(eraseMyData());
    setConfirming(false);
    // The other two reset AFTER, through setters that do not persist:
    // their ordinary setters would write the key back, undoing the very
    // erasure they were called to complete. Two different orderings for
    // two different persistence behaviours, which is why each is
    // spelled out.
    resetTheme();
    resetMode();
    // Everything else that read storage once and kept the value — the
    // notification cursor today — re-reads off this.
    bumpEraseEpoch();
    // Deliberately NO page reload. The retired implementation reloaded
    // so every hook rehydrated from empty storage — but a reload also
    // throws away the result message, so the user is returned to a
    // fresh page with no confirmation that anything happened, which on
    // this page is the whole point. Resetting the live state explicitly
    // — theme, mode, language, and everything on the erase epoch — is
    // what keeps the screen honest without one.
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
              stored === 0 && !refused && result.total > 0
                ? 'banner banner-success'
                : 'banner'
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
              : refused
                ? // Review round 2 P1: a store that REFUSED to be read
                  // contributes nothing to `stored`, so a successful
                  // cookie removal could land here with `stored === 0`
                  // and report a clean success while an unreadable
                  // store still held data. Not knowing is not done.
                  copy.dataRights.eraseBlocked
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
          <li>{copy.dataRights.scopeTabs}</li>
          <li>{copy.dataRights.scopeSite}</li>
          <li>{copy.dataRights.scopeCookies}</li>
        </ul>
      </section>
    </div>
  );
}
