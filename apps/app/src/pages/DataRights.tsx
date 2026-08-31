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
 * The page's job beyond the two buttons is to be HONEST ABOUT SCOPE,
 * in BOTH directions. Overstating reach is the likelier failure — so
 * what an erase cannot touch (the chain, the alerts service, the
 * marketing site's own store, the diagnostics records support keeps)
 * is stated as prominently as what it can, and the shared
 * language/theme cookie is called out because clearing it here also
 * clears it there. Understating is the same failure pointed the other
 * way, which is why the chain line says the user CAN look their own
 * transactions up even though nobody can erase them.
 *
 * The count of stored items is shown BEFORE the confirm, so the
 * destructive button is not a leap in the dark, and the result is
 * reported afterwards as a count rather than a blanket "done". Four
 * outcomes stay four answers — erased, nothing was stored, storage
 * refused, and partly erased — with anything REMAINING or UNREADABLE
 * outranking anything removed. See `eraseMyData`.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, ShieldAlert, Trash2, CheckCircle, Info } from 'lucide-react';
import { copy } from '../content/copy';
import {
  eraseMyDataFully,
  inspectErasableData,
  inspectMyData,
  isAppStorageKey,
  type FullEraseResult,
} from '../lib/dataRights';
import { useTheme } from '../app/ThemeContext';
import { useMode } from '../app/ModeContext';
import { useTranslation } from 'react-i18next';
import { useAccount, useDisconnect } from 'wagmi';
import { bumpEraseEpoch } from '../lib/eraseEpoch';
import { DiagErasureCard } from '../components/DiagErasureCard';

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
  // `disconnectAsync` rather than `disconnect`: the erasure must not delete
  // the session databases until the teardown has actually finished, and the
  // fire-and-forget variant gives nothing to await.
  const { disconnectAsync } = useDisconnect();
  // #1862 Part 2 round 2 P2 — `disconnectAsync()` RESOLVES when there is no
  // connection, so treating fulfilment as proof of a sign-out told an
  // unconnected visitor they had been signed out. The teardown is supplied
  // only when there is something to tear down, which also keeps
  // `connector.attempted` meaning what it says.
  const { isConnected } = useAccount();
  const [downloaded, setDownloaded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The erase outcome, FROZEN at the moment it happened (review round 3
  // P2). It used to be recomputed against the live `stored` count on
  // every render, so writing any new key afterwards — toggling
  // Basic/Advanced in the still-mounted sidebar is enough — turned a
  // finished "Erased 7 items" into "Erased 7 items, but 1 could not be
  // removed", describing something created AFTER the erasure as a
  // failed removal. A report about a past event must not be rewritten
  // by later events.
  const [result, setResult] = useState<
    (FullEraseResult & { remaining: number; refusedAfter: boolean }) | null
  >(null);
  // #1862 Part 2 — the erasure is asynchronous now: it disconnects the
  // wallet and deletes two databases, and a database another tab is
  // holding open takes up to the delete timeout to give an answer. Without
  // a busy state the button looks dead for those seconds, and a second
  // click would start a second teardown.
  const [erasing, setErasing] = useState(false);
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
  // Review round 7 P2: reading on render only helps when a render
  // happens, and browser storage does not cause one — so the figures
  // sat stale while another tab wrote per-wallet settings. The
  // cross-tab `storage` event is the browser's one signal for that,
  // filtered to keys the scan would actually reach so unrelated
  // tools' writes (a wallet connector's session churn) do not
  // re-render a data-rights page. It never fires for the writing
  // document itself — round 8 corrected this comment's earlier claim
  // that same-tab writes imply a navigation (the still-mounted
  // notification bell writes without one), which is why the controls
  // below are no longer gated on the render-time count at all: this
  // subscription keeps the FIGURES fresh across tabs, and the
  // handlers' own fresh reads keep the CONTROLS truthful everywhere.
  const [, setStorageTick] = useState(0);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      // `key === null` is a whole-store clear — always relevant.
      if (event.key === null || isAppStorageKey(event.key)) {
        setStorageTick((tick) => tick + 1);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // Review round 9 P2 — the same-document half. Round 8 un-gated the
  // CONTROLS, but the "what is stored right now" figure still described
  // a moment that could recede indefinitely: the still-mounted bell
  // writes a lastseen key, no `storage` event fires for the writing
  // document, and nothing re-renders this page. There is no browser
  // signal for a document's own storage writes short of instrumenting
  // every writer, so while this page is mounted it re-checks on a slow
  // poll and re-renders ONLY when the figure it is showing has become
  // wrong. The displayed pair is recorded after each render (an
  // every-render effect, not a render-time ref write) so the poll
  // compares against what the user is actually seeing.
  const shownFigures = useRef({ count: 0, refused: false });
  useEffect(() => {
    const id = setInterval(() => {
      const now = inspectMyData();
      if (
        now.count !== shownFigures.current.count ||
        now.refused !== shownFigures.current.refused
      ) {
        setStorageTick((tick) => tick + 1);
      }
    }, 2_000);
    return () => clearInterval(id);
  }, []);
  // Read on render rather than held in state: after an erase the page
  // must show the new figure, and a stale count on a data-rights page
  // is the same class of untruth as a false success message. One
  // snapshot, so the count, the refusal state and the downloadable
  // payload all describe the same moment.
  const snapshot = inspectMyData();
  // The count offered BEFORE confirming comes from the erasure inventory, not
  // the export one (round 2 P2). They differ now, so a browser holding only
  // connector records would otherwise be told nothing is stored and then have
  // those records erased on confirm. The payload below still comes from the
  // export snapshot — it is what the download would contain.
  const erasable = inspectErasableData();
  const stored = erasable.count;
  // Review round 1 P1: "could not read" is not "nothing is here". With
  // them collapsed, a browser refusing to be read told the user their
  // storage was empty — the refusal message below unreachable in the
  // one case it was written for. (The buttons that gating disabled
  // then are un-gated entirely as of round 8.)
  const refused = snapshot.refused || erasable.refused;
  // What this render is showing, recorded for the poll above to
  // compare against — an every-render effect rather than a render-time
  // ref write, which the refs rule forbids.
  useEffect(() => {
    shownFigures.current = { count: stored, refused };
  });

  function onDownload() {
    // Read FRESH rather than using the render-time snapshot (review
    // round 3 P2). Browser storage does not re-render this page when it
    // changes, so another tab — or a mounted component in this one —
    // could have written since the last paint, and the file would claim
    // to contain everything while missing it. The counts on screen can
    // be a moment stale without lying; a file that says it is complete
    // cannot.
    downloadJson(
      `vaipakam-app-data-${new Date().toISOString().slice(0, 10)}.json`,
      inspectMyData().payload,
    );
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2500);
  }

  async function onErase() {
    // Language goes back to the default BEFORE the erase, deliberately.
    // `changeLanguage` persists — to the key and the shared-domain
    // cookie — so running it afterwards would rewrite what the erase
    // had just removed. Doing it first means the erase clears its
    // write, and the order is the whole mechanism rather than an
    // accident of statement order.
    void i18n.changeLanguage('en');
    setErasing(true);
    let erased: FullEraseResult;
    try {
      // The teardown is injected rather than imported by the library: see
      // `eraseMyDataFully`. It runs FIRST, so a connector holding a
      // database open gets the chance to close it before the deletion.
      erased = await eraseMyDataFully({
        disconnect: isConnected ? () => disconnectAsync() : undefined,
      });
    } finally {
      setErasing(false);
    }
    // Measured immediately, once, and kept with the result — see the
    // state declaration for why this is not recomputed later.
    // The ERASURE inventory, not the export one (#1862 round 1 P1): a
    // connector key that refused removal, or that a live connector wrote
    // straight back, is invisible to the export scan — so the page would
    // report a clean success over storage that is still there.
    const after = inspectErasableData();
    setResult({ ...erased, remaining: after.count, refusedAfter: after.refused });
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
        {/* NOT gated on the render-time count (review round 8 P2).
            A disabled button is a live claim — "there is nothing to
            act on" — resting on a snapshot this document's OWN
            components can silently outdate: the still-mounted
            notification bell writes `app.notif.lastseen.*` on open,
            and same-document writes fire no `storage` event, so the
            round-7 subscription never sees them. The handlers read
            fresh at click time, so an always-enabled button always
            acts on the truth; the on-screen count may run a moment
            behind, but a stale figure beside a working control is a
            smaller untruth than a control that denies data it would
            in fact find. */}
        <button type="button" className="btn btn-secondary" onClick={onDownload}>
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
              result.remaining === 0 &&
              !result.refusedAfter &&
              result.complete &&
              (result.total > 0 || result.indexedDb.records > 0)
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
            {/* Read from the FROZEN result, never the live counts. */}
            {/* STORAGE outcome. Round 2 P2: the wallet is reported
                separately below rather than as one more branch here,
                because the two can fail together — a leftover key AND a
                wallet that refused — and a single-branch ladder showed only
                the first, hiding the one whose remedy is different. */}
            {result.remaining > 0
              ? result.total > 0
                ? copy.dataRights.erasePartial(result.total, result.remaining)
                : copy.dataRights.eraseBlocked
              : result.refusedAfter
                ? // Review round 2 P1: a store that REFUSED to be read
                  // contributes nothing to the remainder, so a
                  // successful cookie removal could land here with a
                  // zero remainder and report a clean success while an
                  // unreadable store still held data. Not knowing is
                  // not done.
                  copy.dataRights.eraseBlocked
                : // Round 2 P2: `unavailable` has an EMPTY refusal list, so
                  // checking `refused` alone let a browser that hides
                  // IndexedDB fall through to a success message. Neither
                  // store was emptied nor seen absent, which is the same
                  // "could not look" case `holdingUnreadable` exists for.
                  result.indexedDb.unavailable
                  ? copy.dataRights.eraseStoresUnreadable
                  : result.indexedDb.refused.length > 0
                    ? copy.dataRights.eraseSessionHeld
                    : // Round 2 P2: `total` counts the synchronous sweep
                      // only, so a browser whose Web Storage was already
                      // empty but whose wallet session was not reported
                      // "nothing was stored" after deleting that session.
                      result.total > 0 || result.indexedDb.records > 0
                      ? result.connector.disconnected
                        ? copy.dataRights.eraseDoneDisconnected(result.total)
                        : copy.dataRights.eraseDone(result.total)
                      : copy.dataRights.eraseNothing}
            {/* WALLET outcome, additive. Its remedy — disconnect in the
                wallet itself — is not reachable from any storage message,
                so it must survive one. */}
            {result.connector.attempted && !result.connector.disconnected ? (
              <span className="block-line">
                {' '}
                {copy.dataRights.eraseWalletHeld}
              </span>
            ) : null}
          </div>
        ) : null}

        {confirming ? (
          <>
            <p className="muted">{copy.dataRights.eraseConfirmPrompt}</p>
            <div className="cluster">
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void onErase()}
                disabled={erasing}
              >
                {/* The label carries the busy state, not just the disabled
                    attribute. Disconnecting a wallet and waiting out a
                    blocked database can take seconds, and a greyed button
                    with its original text reads as broken rather than
                    working. */}
                {erasing
                  ? copy.dataRights.eraseWorking
                  : copy.dataRights.eraseConfirm}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={erasing}
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
          >
            {/* Un-gated for the same round-8 reason as Download: the
                erase reads storage itself and reports what it actually
                removed, so on a truly empty store the outcome is the
                honest "nothing was stored" banner — while a disabled
                button would deny data a same-document write just
                created. */}
            <Trash2 size={14} aria-hidden="true" />
            {copy.dataRights.eraseButton}
          </button>
        )}
      </section>

      {/* #2002 — the server-side counterpart: the error reports the
          support service keeps, erased by signed request. Lives on
          this page because it is the Data Rights control the Privacy
          Policy promises "in the app", and this is the page whose
          scope list used to name it as unreachable. */}
      <DiagErasureCard />

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
