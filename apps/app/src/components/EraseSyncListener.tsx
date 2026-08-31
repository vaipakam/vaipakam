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
 * why the language reset removes the key `changeLanguage` writes on its way
 * through.
 */
import { useEffect, useRef } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_STORAGE_KEY } from '@vaipakam/i18n';
import { disconnectEvery, erasePerTabData } from '../lib/dataRights';
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
  const { disconnect, connectors: liveConnectors } = useDisconnect();
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
          void disconnectEvery(connectors, async (args) =>
            disconnect(args),
          )().catch(() => {
            // Unacknowledged either way — there is nobody to report to. The
            // catch exists so a wallet that refuses cannot take the rest of
            // this handler down with it.
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
        void i18n.changeLanguage('en');
        try {
          window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
        } catch {
          // A tab that cannot reach storage has nothing to undo; the
          // on-screen reset above still happened.
        }
        // ...and tell this tab's mounted readers to re-read, exactly as
        // the erasing tab does for its own.
        bumpEraseEpoch();
      }),
    // Only stable values. `disconnect` is react-query's `mutate`, the two
    // `resetToDefault`s are `useCallback`-wrapped, and `i18n` is the instance;
    // the two that change identity per render are read through the refs above.
    [disconnect, resetTheme, resetMode, i18n],
  );
  return null;
}
