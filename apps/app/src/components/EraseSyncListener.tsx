/**
 * Brings a tab into line when ANOTHER tab erases (#1960, review round 2 P2).
 *
 * `localStorage` and cookies are shared, so the originating tab has
 * already cleared them for everyone. What it cannot reach is everything
 * PER BROWSING CONTEXT: `sessionStorage`, the in-memory last-error slot,
 * the wallet connection, and the live preference state React is holding.
 * Without this, a user with two tabs open could erase in one and leave the
 * other holding a captured error — its message and route — a connected
 * wallet, and their erased theme still on screen, while being told their
 * browser had been cleared.
 *
 * Renders nothing. Mounted in `AppShell` beside `ReceiptSyncListener`,
 * which is the same shape of concern: a cross-tab signal that has to be
 * live wherever the app is, not only on the page that emits it.
 *
 * **Every reset here must be NON-PERSISTING.** The originating tab's sweep
 * has already run by the time this fires, so anything written here lands in
 * storage that was just cleared and stays there — a peer tab resurrecting
 * the keys the erasure removed. That is why the theme and mode resets are
 * the state-only `resetToDefault`s rather than their ordinary setters, and
 * why the language reset is followed by a quiet sweep that removes what
 * `changeLanguage` persists on its way through — the storage key AND the
 * parent-scope cookie, since it writes both.
 */
import { useEffect, useRef } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { useTranslation } from 'react-i18next';
import {
  disconnectEvery,
  eraseConnectorStorageQuietly,
  erasePerTabData,
  eraseWebStorageQuietly,
} from '../lib/dataRights';
import { bumpEraseEpoch } from '../lib/eraseEpoch';
import { listenForErase } from '../lib/eraseBroadcast';
import { useTheme } from '../app/ThemeContext';
import { useMode } from '../app/ModeContext';

export function EraseSyncListener() {
  // #1862 Part 2 round 1 P1 — the wallet connection is per browsing context
  // too, in the same way `sessionStorage` is. The erasing tab tears down its
  // OWN connection; another tab connected through an injected wallet holds a
  // connection that shares neither of the cleared stores, so it would have
  // sailed through an erasure the user was told signed them out.
  //
  // EVERY connector, not the current one (round 4 P1). Round 3 fixed this on
  // the originating page and left the listener on the no-argument action,
  // which resolves its connector from `state.current` and then promotes the
  // next connection rather than clearing the map — so a peer tab holding two
  // wallets dropped one, kept the other, and persisted the surviving map
  // straight back into the `wagmi.store` the sweep had just removed.
  //
  // `disconnectAsync`, NOT `disconnect` (round 7 P1). The fire-and-forget
  // `mutate` returns `void`, so wrapping it in an `async` arrow handed
  // `disconnectEvery` an already-fulfilled promise: the loop and its cleanup
  // finished before wagmi had disconnected anything, so the re-sweep ran
  // BEFORE the write it exists to undo, and a rejection was invisible to the
  // aggregation. The listener still acknowledges nothing — awaiting is about
  // ordering its own cleanup, not about reporting.
  const { disconnectAsync, connectors: liveConnectors } = useDisconnect();
  // #1862 Part 2 round 3 P1 — a disconnect with nothing to disconnect is NOT
  // free here. `@wagmi/core`'s action calls `config.setState` unconditionally,
  // outside the `if (connector)` branch, and the config's store is wrapped in
  // zustand's `persist`, so every such call rewrites `wagmi.store`. An open tab
  // that was already signed out would therefore re-create an erasable key in
  // the storage the erasing tab had just swept — reported as a leftover if the
  // erasing tab's final inspection runs after the broadcast, and left behind
  // silently if it runs before. The originating page gained this guard in
  // round 2; the listener is the same hazard reached from the other side.
  const { isConnected } = useAccount();
  // Round 4 P2 — the live preferences. `ThemeProvider` and `ModeProvider`
  // read storage once at mount and never subscribe to it, so a peer tab went
  // on displaying an erased non-default theme or mode indefinitely: the
  // values were gone from the device and still on the screen. Both
  // `resetToDefault`s are state-only by construction (their ordinary setters
  // persist, and would rewrite what the erasure removed), which is exactly
  // the property this listener needs.
  const { resetToDefault: resetTheme } = useTheme();
  const { resetToDefault: resetMode } = useMode();
  const { i18n } = useTranslation();
  // THE SUBSCRIPTION MUST NOT CHURN — found by self-review, and introduced by
  // this round's own fix. `useDisconnect` builds `connectors` with a `.map`
  // over the live connections, so it is a NEW ARRAY on every render whether or
  // not anything connected changed. Naming it in the effect's dependencies
  // therefore tore down and re-opened the BroadcastChannel on every render of
  // a component with half a dozen re-render sources — and an erase broadcast
  // landing in one of those gaps is simply not heard, which for this listener
  // is the whole failure it exists to prevent. The value is read through a ref
  // at handler time instead, which is also FRESHER than a captured dependency:
  // what matters is the set connected when the broadcast arrives.
  const connectorsRef = useRef(liveConnectors);
  const connectedRef = useRef(isConnected);
  useEffect(() => {
    connectorsRef.current = liveConnectors;
    connectedRef.current = isConnected;
  });
  useEffect(
    () =>
      listenForErase(() => {
        erasePerTabData();
        // Best effort and deliberately unacknowledged, exactly like the
        // per-tab storage clear above: a listener cannot report back to a
        // page that may already have navigated. That is why the copy says
        // other tabs have been ASKED, and claims confirmation only for the
        // tab the user is looking at.
        const connectors = connectorsRef.current;
        if (connectedRef.current && connectors.length > 0) {
          // RE-SWEEP AFTERWARDS, on both outcomes (round 6 P1). This teardown
          // runs after the ORIGINATING tab has already swept shared storage,
          // and wagmi persists `wagmi.store` through `config.setState` once
          // the connector's own asynchronous disconnect finishes — so a slow
          // peer recreates that key after the erasing tab's final inspection
          // and leaves data behind under a reported success. The guard above
          // stops a no-op write; this covers the write a genuine disconnect
          // NECESSARILY makes.
          //
          // On rejection as well as fulfilment, because since the aggregation
          // fix a rejection no longer means nothing was written: one
          // connector can let go — persisting the store — before a later one
          // refuses and makes the whole thing reject.
          void disconnectEvery(connectors, disconnectAsync, {
            // A connector the per-target bound gave up on can still complete
            // later and write (round 7 P2) — this fires after the last one
            // actually settles, which the `finally` below cannot wait for.
            onAllSettled: eraseConnectorStorageQuietly,
          })()
            .catch(() => {
              // Unacknowledged either way — there is nobody to report to. The
              // catch exists so a wallet that refuses cannot take the rest of
              // this handler down with it.
            })
            .finally(() => {
              // CONNECTOR KEYS ONLY (round 7 P2). This runs seconds after the
              // broadcast on a slow teardown, and the tab stays usable in
              // between — a blanket sweep here would delete preferences,
              // receipts or notification state the user created AFTER asking
              // to be erased. The cleanup undoes the teardown's own write and
              // nothing else.
              eraseConnectorStorageQuietly();
            });
        }
        resetTheme();
        resetMode();
        // Language LAST among the resets and cleaned up after itself. The
        // originating page can put this first, because its own sweep then
        // removes what `changeLanguage` persists; here the sweep has already
        // happened elsewhere, so the write would restore an erased key in
        // shared storage. Changing the language is what updates the screen,
        // and removing the key is what keeps the erasure true.
        //
        // BOTH stores, not just the key (round 6 P2). `createI18n`'s
        // `languageChanged` listener writes the `vaipakam_lang` COOKIE at the
        // parent scope as well as the storage key, so undoing only the key
        // restored an erased preference by half and left the cookie standing
        // — and retrying the erase reproduced it every time. The quiet sweep
        // covers Web Storage and cookies alike, which is the same set the
        // erasure itself covers; anything narrower is a cleanup that has to
        // be kept in step with a writer it cannot see.
        void i18n.changeLanguage('en');
        eraseWebStorageQuietly();
        // ...and tell this tab's mounted readers to re-read, exactly as
        // the erasing tab does for its own.
        bumpEraseEpoch();
      }),
    // Only stable values. `disconnect` is react-query's `mutate`, the two
    // `resetToDefault`s are `useCallback`-wrapped, and `i18n` is the instance;
    // the two that change identity per render are read through the refs above.
    [disconnectAsync, resetTheme, resetMode, i18n],
  );
  return null;
}
