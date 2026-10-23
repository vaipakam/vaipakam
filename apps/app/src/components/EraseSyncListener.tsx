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
 * the keys the erasure removed. That is why theme and mode follow storage
 * through the state-only `followStorage`s rather than their ordinary setters, and
 * why the language reset undoes exactly what `changeLanguage` persists on
 * its way through.
 *
 * **And it clears NO SHARED STORE (#2037).** `localStorage`, cookies and the
 * wallet databases are shared; the originating tab clears them and is the
 * only party that reports on them. This tab used to clear them again after
 * its own teardown, to catch what that teardown writes on the way out — and
 * that second, uncoordinated clearer was a defect class of its own: run late
 * (a slow teardown, a frozen background tab that receives the broadcast on
 * waking), it deleted sessions and records the user created AFTER the
 * erasure, and run early it emptied the databases ahead of the originating
 * tab's counted clear, so that tab reported erasing nothing over records its
 * request had removed. The stores carry no attribution, so "clear only what
 * this teardown wrote" is not expressible; the only fix is not to clear.
 * What that costs — a wallet closing here can write a small connection
 * record back after the originating tab has finished — is stated on the
 * Data Rights page, and erasing again from any tab removes it.
 */
import { useEffect } from 'react';
import { useConfig } from 'wagmi';
import { useTranslation } from 'react-i18next';
import { readStoredLanguage, undoLanguageWrite } from '../lib/dataRights';
import { listenForErase } from '../lib/eraseBroadcast';
import { followPeerErasure } from '../lib/erasureRun';
import { wagmiWalletPort } from '../chain/walletTeardownPort';
import { useTheme } from '../app/ThemeContext';
import { useMode } from '../app/ModeContext';

export function EraseSyncListener() {
  // The wallet connection is per browsing context, like `sessionStorage`
  // (#1862 Part 2 round 1 P1): a tab connected through an injected wallet
  // would sail through an erasure the user was told signed them out. Read
  // from the config at call time, never from refs or hook values captured at
  // render (round 13 P2) — see `chain/walletTeardownPort.ts`.
  const config = useConfig();
  // Round 4 P2 — the live preferences. `ThemeProvider` and `ModeProvider`
  // read storage once at mount and never subscribe to it, so a peer tab went
  // on displaying an erased theme or mode indefinitely. Both `followStorage`s
  // are state-only by construction, which is exactly what this needs, and
  // both ADOPT a choice stored since the erasure (Codex #2670 r2 P2) — the
  // same rule as the language below, so a broadcast heard late cannot paint
  // the default over a newer preference.
  const { followStorage: followThemeStorage } = useTheme();
  const { followStorage: followModeStorage } = useMode();
  const { i18n } = useTranslation();
  // ONLY STABLE DEPENDENCIES. A churning subscription tears the
  // BroadcastChannel down and re-opens it, and a broadcast landing in that gap
  // is simply not heard — the whole failure this listener exists to prevent.
  useEffect(
    () =>
      listenForErase(() =>
        // The work, and the lock it shares with this tab's own erasure
        // (Codex #2670 r2 P1), live in `lib/erasureRun.ts`.
        followPeerErasure({
          wallet: wagmiWalletPort(config),
          followPreferences: () => {
            followThemeStorage();
            followModeStorage();
          },
          // The language. If a preference is stored now, the user set it
          // since the erasure (in some tab), so this tab adopts it rather
          // than overwriting it. Otherwise it goes back to the default and
          // removes exactly what that change persists — the storage key and
          // the parent-scope cookie, each only while it still holds what was
          // written (round 6 P2 found the cookie half; #2037 narrowed the
          // removal from a blanket sweep to the write itself).
          followLanguage: () => {
            const stored = readStoredLanguage();
            if (stored) {
              void i18n.changeLanguage(stored);
            } else {
              void i18n.changeLanguage('en').then(() => undoLanguageWrite('en'));
            }
          },
        }),
      ),
    [config, followThemeStorage, followModeStorage, i18n],
  );
  return null;
}
