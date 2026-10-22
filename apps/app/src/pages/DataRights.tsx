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
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, ShieldAlert, Trash2, CheckCircle, Info } from 'lucide-react';
import { copy } from '../content/copy';
import {
  erasedItemCount,
  inspectErasableData,
  inspectIndexedDbData,
  inspectMyData,
  isAppStorageKey,
  type IndexedDbInventory,
} from '../lib/dataRights';
import {
  dismissErasureReport,
  getErasureRun,
  runErasure,
  subscribeErasureRun,
} from '../lib/erasureRun';
import { wagmiWalletPort } from '../chain/walletTeardownPort';
import { useTheme } from '../app/ThemeContext';
import { useMode } from '../app/ModeContext';
import { useTranslation } from 'react-i18next';
import { useConfig } from 'wagmi';
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
  // The wallet is reached through the config, read at call time, rather than
  // through hooks: the erasure outlives this component (#2038) — see
  // `lib/erasureRun.ts` and `chain/walletTeardownPort.ts`.
  const config = useConfig();
  const [downloaded, setDownloaded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The erasure and its report live OUTSIDE this component (#2038). Erasing
  // in any language but English resets the language first, and
  // `LanguageRemount` replaces this whole page on that event while the
  // erasure is still running — so a busy flag or a result held in this
  // component's state was lost mid-operation: the replacement page allowed a
  // second erasure, and the first one's report went to an instance that no
  // longer existed. The page now starts the operation and renders what the
  // module store reports; the store also brings a report back after a
  // wallet reloads the page (#2035).
  //
  // The report is FROZEN at the moment it happened (review round 3 P2). It
  // used to be recomputed against the live count on every render, so writing
  // any new key afterwards turned a finished "Erased 7 items" into "Erased 7
  // items, but 1 could not be removed", describing something created AFTER
  // the erasure as a failed removal.
  const run = useSyncExternalStore(subscribeErasureRun, getErasureRun);
  // #1862 Part 2 — the erasure is asynchronous: it disconnects the wallet and
  // clears two databases, and either can take seconds. The busy state keeps
  // the button from looking dead and a second click from starting a second
  // teardown; the guard itself is in `runErasure`.
  const erasing = run.phase === 'running';
  const result = run.phase === 'done' ? run.report : null;
  // The confirmation shows while the user is confirming, and stays up while
  // the erasure runs — including in a replacement page that never saw the
  // click. A finished report closes it.
  const showConfirm = erasing || (confirming && run.phase === 'idle');
  // Review round 1 P2: the providers sit ABOVE this route and read
  // storage only on their own mount, so clearing the keys left the live
  // theme and mode showing the erased values until a reload — the page
  // promising in copy that preferences return to their defaults while
  // the app visibly kept them.
  const { followStorage: followThemeStorage } = useTheme();
  const { followStorage: followModeStorage } = useMode();
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
  // The tick VALUE is read (round 4 P2): the asynchronous database inventory
  // below re-runs off it, so the two halves of the pre-confirm figure refresh
  // on one signal rather than drifting apart.
  const [storageTick, setStorageTick] = useState(0);
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
  //
  // It records the SYNCHRONOUS half of the displayed figure, and the poll
  // recomputes the same half — corrected by self-review after round 4, where
  // it was `inspectMyData()` (the EXPORT inventory) compared against the
  // displayed count. Those became different sets in round 2, when the
  // displayed figure moved to the ERASURE inventory, so any browser holding a
  // connector key had a permanently unequal comparison and bumped the tick
  // every two seconds for the life of the page. Harmless while a tick meant
  // only a re-render; adding the database inventory below hangs an IndexedDB
  // open-and-count on the same signal, which would have turned a spurious
  // re-render into a spurious database read every two seconds. A guard that
  // compares two different things is not a guard.
  //
  // The asynchronous half is deliberately NOT in the comparison: it cannot be
  // recomputed cheaply, and re-reading it is the very thing the tick triggers.
  const shownFigures = useRef({ count: 0, refused: false });
  useEffect(() => {
    const id = setInterval(() => {
      const now = inspectErasableData();
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
  // Round 4 P2 — the databases count too, and they can only be read
  // asynchronously. Without this the pre-confirm figure covered a strictly
  // narrower set than the erasure it introduces: a browser holding a wallet
  // session and one app key was offered "1 item" and then erased four, and one
  // whose Web Storage was already empty was told nothing was stored right
  // before the session was removed. That is round 2's "the page contradicts
  // itself across a single click" with the session in the gap.
  //
  // Re-read on the same tick the synchronous figure changes, so the two halves
  // of one sentence describe one moment. `refused` folds in: a store that will
  // not answer means the figure is a floor, and this page has a "could not
  // look" state precisely so a floor is never shown as a total.
  //
  // PENDING IS NOT "READ, AND EMPTY" (round 6 P2). The first render happens
  // before the asynchronous inspection has run, and defaulting to
  // `{records: 0, refused: false}` asserted both halves of an answer nobody
  // had yet — so on a slow open the page said "Nothing is stored" and let the
  // user confirm an erasure that then removed a wallet session. This page's
  // governing rule is that not knowing is not nothing, and a loading state is
  // the purest case of not knowing. It starts UNREADABLE, which renders the
  // "could not look" message until a real answer replaces it.
  //
  // The answer is stored WITH the generation it answers for, and pendingness
  // is DERIVED rather than assigned (round 8 P2). Invalidating by writing
  // `refused: true` at the top of the effect is the obvious shape and this
  // repo's `set-state-in-effect` rule rejects it, correctly — it is a
  // cascading render for a value the render can work out for itself. A
  // generation that has not been answered yet IS the pending state.
  const inventoryGen = `${storageTick}|${showConfirm}|${result ? 1 : 0}`;
  const [dbInventory, setDbInventory] = useState<{
    gen: string;
    value: IndexedDbInventory;
  }>({ gen: '', value: { records: 0, refused: true } });
  useEffect(() => {
    let live = true;
    // INVALIDATE BEFORE RE-READING (round 8 P2). Adding `confirming` as a
    // trigger started the refresh and left the PREVIOUS answer on screen, so
    // the user could open the confirmation and press it while a stale
    // definitive total was still displayed — the figure claiming to describe
    // the button beside it, and describing an earlier moment instead. Going
    // back to unreadable means the page shows "could not look" until the new
    // answer lands, and the confirm is withheld while it does.
    void inspectIndexedDbData().then((inventory) => {
      if (live) setDbInventory({ gen: inventoryGen, value: inventory });
    });
    return () => {
      live = false;
    };
    // `confirming` IS a refresh trigger (round 7 P2). IndexedDB emits no
    // `storage` event, connector keys are filtered out of the one this page
    // subscribes to, and the fallback poll compares COUNTS — so a wallet
    // session added while an existing connector key kept the count steady
    // could leave this at zero indefinitely, and the figure shown next to the
    // confirm button is exactly where that matters. Re-reading when the user
    // asks to confirm makes the promise fresh at the moment it is made.
  }, [inventoryGen]);
  // Unanswered generation = pending, and pending reads as UNREADABLE. Round 6
  // P2 established that a not-yet-known count must not render as "read, and
  // empty"; round 8 P2 extended it to a REFRESH, where the previous answer
  // stayed on screen as a definitive total while a new one was in flight —
  // the figure claiming to describe the button beside it and describing an
  // earlier moment instead.
  const dbPending = dbInventory.gen !== inventoryGen;
  const dbAnswer: IndexedDbInventory = dbPending
    ? { records: 0, refused: true }
    : dbInventory.value;
  const stored = erasable.count + dbAnswer.records;
  // Review round 1 P1: "could not read" is not "nothing is here". With
  // them collapsed, a browser refusing to be read told the user their
  // storage was empty — the refusal message below unreachable in the
  // one case it was written for. (The buttons that gating disabled
  // then are un-gated entirely as of round 8.)
  const refused = snapshot.refused || erasable.refused || dbAnswer.refused;
  // The SYNCHRONOUS half of what this render is showing, recorded for the
  // poll above to compare against — an every-render effect rather than a
  // render-time ref write, which the refs rule forbids. Sync-only on both
  // sides, so the two figures being compared are the same figure; see the
  // poll's own note for what went wrong when they were not.
  //
  // STRICTLY the erasure inventory on both sides, including the refusal flag.
  // The displayed `refused` is a union with the export snapshot's and the
  // database inventory's, and recording that union here would reintroduce the
  // same defect one field along: the poll recomputes only this inventory, so a
  // union that was true for a reason the poll cannot see would never compare
  // equal. The two read the same stores and would agree in practice — which is
  // exactly the reasoning this PR has already been caught by twice, so the
  // comparison is made symmetric by construction instead.
  useEffect(() => {
    shownFigures.current = {
      count: erasable.count,
      refused: erasable.refused,
    };
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

  function onErase() {
    void runErasure({
      wallet: wagmiWalletPort(config),
      // Language goes back to the default BEFORE the erase, deliberately:
      // `changeLanguage` persists — to the key and the shared-domain cookie —
      // so the erase must run after it to clear its write.
      resetLanguage: () => void i18n.changeLanguage('en'),
      // Theme and mode follow the swept storage AFTER, through setters that
      // do not persist: their ordinary setters would write the key back.
      // Both providers sit above `LanguageRemount`, so these stay valid when
      // this page does not.
      resetPreferences: () => {
        followThemeStorage();
        followModeStorage();
      },
    });
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
              // A report brought back after a reload does not know how its
              // last step ended (#2035), so it is never shown as a success.
              !result.reloadedDuringLast &&
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
              ? // Round 4 P2 — `erasedItemCount`, not `total`, here too. Both
                // SUCCESS branches took the wider figure in round 3 and this
                // PARTIAL one was left on the synchronous count, so a mixed
                // outcome — some Web Storage removed, some left, database
                // records cleared — omitted every record from the number it
                // reported. The figure has to mean the same thing in all
                // three sentences or it means nothing in any of them.
                erasedItemCount(result) > 0
                ? copy.dataRights.erasePartial(
                    erasedItemCount(result),
                    result.remaining,
                  )
                : copy.dataRights.eraseBlocked
              : result.refusedAfter
                ? // Round 14 P2 — "nothing was removed" is false when the
                  // wallet store WAS reachable and gave up records. The
                  // ordinary storage could not be verified; that is a
                  // different statement from nothing having happened, and
                  // conflating them understates the erasure in the one case
                  // where the count is the only thing the page can be sure of.
                  erasedItemCount(result) > 0
                  ? copy.dataRights.erasePartlyUnverifiable(
                      erasedItemCount(result),
                    )
                  : // Review round 2 P1: a store that REFUSED to be read
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
 // Round 2 P2: `total` counts the synchronous sweep
                      // only, so a browser whose Web Storage was already
                      // empty but whose wallet session was not reported
                      // "nothing was stored" after deleting that session.
                      result.total > 0 || result.indexedDb.records > 0
                      ? // Round 11 P2 — the cross-tab claim is only made when
                        // the request actually went out. `announceErase`
                        // returns false where BroadcastChannel is missing or
                        // blocked, and the page was promising peers had been
                        // asked in exactly the browser where none had.
                        // Not after a reload (#2035): the kept report
                        // predates the last teardown, so it cannot vouch
                        // for a sign-out — the reload line below says what
                        // is known instead.
                        result.connector.disconnected &&
                        !result.reloadedDuringLast
                        ? result.peersNotified
                          ? copy.dataRights.eraseDoneDisconnected(
                              erasedItemCount(result),
                            )
                          : copy.dataRights.eraseDoneDisconnectedNoPeers(
                              erasedItemCount(result),
                            )
                        : result.peersNotified
                          ? copy.dataRights.eraseDone(erasedItemCount(result))
                          : copy.dataRights.eraseDoneNoPeers(
                              erasedItemCount(result),
                            )
                      : copy.dataRights.eraseNothing}
            {/* SESSION-STORE outcome, additive (round 12 P2). It used to be
                a branch in the ladder above, so a Web Storage leftover or an
                unreadable inspection won first and the wallet-session holdout
                was suppressed entirely — with `erasePartial` then quoting a
                remainder that counted only Web Storage. The two arise from
                the same locked-down storage policy, so they co-occur readily,
                and their remedies differ. Same reasoning as the wallet line
                below, reached one store along. */}
            {result.indexedDb.unavailable ||
            result.indexedDb.refused.length > 0 ? (
              <span className="block-line">
                {' '}
                {/* `unavailable` is additive too (round 13 P2). Round 12 made
                    the session REFUSAL additive and left its sibling as a
                    ladder branch, so a Web Storage failure alongside a hidden
                    IndexedDB reported only the first — omitting that the
                    wallet store could not even be opened. Both are the same
                    kind of statement and want the same treatment; only the
                    wording differs, because "could not open" and "would not
                    clear" have different remedies. */}
                {result.indexedDb.unavailable
                  ? copy.dataRights.eraseStoresUnreadable
                  : copy.dataRights.eraseSessionHeld}
              </span>
            ) : null}
            {/* WALLET outcome, additive. Its remedy — disconnect in the
                wallet itself — is not reachable from any storage message,
                so it must survive one. */}
            {result.connector.attempted && !result.connector.disconnected ? (
              <span className="block-line">
                {' '}
                {/* #2039 — still restoring is not a refusal: nothing said
                    no, the connection did not exist yet in a form that can
                    be closed, and the remedy is to wait and erase again. */}
                {result.connector.reconnectPending
                  ? copy.dataRights.eraseWalletReconnecting
                  : copy.dataRights.eraseWalletHeld}
              </span>
            ) : null}
            {/* #2035 — what is known after a wallet reloaded the page, and
                no more: the step ran last, after everything else, and its
                own outcome is not in this report. */}
            {result.reloadedDuringLast ? (
              <span className="block-line">
                {' '}
                {copy.dataRights.eraseWalletReloaded}
              </span>
            ) : null}
          </div>
        ) : null}

        {showConfirm ? (
          <>
            <p className="muted">{copy.dataRights.eraseConfirmPrompt}</p>
            <div className="cluster">
              <button
                type="button"
                className="btn btn-danger"
                onClick={onErase}
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
              dismissErasureReport();
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
          <li>{copy.dataRights.scopeOtherTabs}</li>
          <li>{copy.dataRights.scopeSite}</li>
          <li>{copy.dataRights.scopeCookies}</li>
        </ul>
      </section>
    </div>
  );
}
