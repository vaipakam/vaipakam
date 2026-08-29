/**
 * Clears this tab's per-context data when another tab erases (#1960,
 * review round 2 P2).
 *
 * `localStorage` and cookies are shared, so the originating tab has
 * already cleared them for everyone. `sessionStorage` and the
 * in-memory last-error slot are per browsing context, so only the tab
 * that owns them can. Without this, a user with two tabs open could
 * erase in one and leave a captured error — its message and route — in
 * the other, while being told their browser had been cleared.
 *
 * Renders nothing. Mounted in `AppShell` beside `ReceiptSyncListener`,
 * which is the same shape of concern: a cross-tab signal that has to be
 * live wherever the app is, not only on the page that emits it.
 */
import { useEffect } from 'react';
import { erasePerTabData } from '../lib/dataRights';
import { bumpEraseEpoch } from '../lib/eraseEpoch';
import { listenForErase } from '../lib/eraseBroadcast';

export function EraseSyncListener() {
  useEffect(
    () =>
      listenForErase(() => {
        erasePerTabData();
        // ...and tell this tab's mounted readers to re-read, exactly as
        // the erasing tab does for its own.
        bumpEraseEpoch();
      }),
    [],
  );
  return null;
}
