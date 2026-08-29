/**
 * Cross-tab reach for the data-rights erasure (#1960, review round 2).
 *
 * WHY. `localStorage` and cookies are shared by every tab on the
 * origin, so erasing them in one tab erases them everywhere.
 * `sessionStorage` is not: it belongs to a single browsing context. So
 * does the in-memory `lastError` slot. A user with the app open twice
 * could therefore erase from one tab and leave the other holding a
 * captured error — its message and the route it happened on — plus the
 * chunk-reload flag, while the page told them their browser had been
 * cleared.
 *
 * The claim was the problem, not the leftovers' size: this page is not
 * allowed to say "this browser" and mean "this tab". Either the reach
 * matches the sentence or the sentence has to shrink, and here the
 * reach is cheap to extend.
 *
 * ERASURE is broadcast. Every listening tab clears its own session
 * storage and memory slot, which is the half that can be made true.
 *
 * EXPORT is not, and the copy says so instead. Collecting another tab's
 * session data would mean an async round-trip with acknowledgements
 * before a file could be written, and a download that waits on tabs
 * that may not answer is worse than one that states its scope. A user
 * who wants a complete picture can export from each tab; the page tells
 * them that rather than leaving them to discover it.
 *
 * Fire-and-forget by design. A tab that is not listening — an older
 * build, a browser without BroadcastChannel — simply keeps its own
 * session data, which is the state before this existed. Nothing here
 * may throw: a data-rights control must not become a crash source.
 */

const CHANNEL = 'vaipakam-data-erase-v1';

function open(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** Tell every other tab on this origin to clear its own per-tab data. */
export function announceErase(): void {
  const channel = open();
  if (!channel) return;
  try {
    channel.postMessage({ type: 'erase' });
  } catch {
    // Non-fatal: the erasure in THIS tab has already happened.
  } finally {
    try {
      channel.close();
    } catch {
      /* nothing useful to do */
    }
  }
}

/**
 * Listen for another tab's erasure. Returns an unsubscribe function.
 *
 * The handler is supplied rather than baked in so the module stays free
 * of imports from the storage layer — it is a transport, and keeping it
 * one is what lets it be tested without touching storage at all.
 */
export function listenForErase(onErase: () => void): () => void {
  const channel = open();
  if (!channel) return () => {};
  const handler = (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type !== 'erase') return;
    try {
      onErase();
    } catch {
      // A failure to clear one tab must not take that tab down.
    }
  };
  channel.addEventListener('message', handler);
  return () => {
    try {
      channel.removeEventListener('message', handler);
      channel.close();
    } catch {
      /* nothing useful to do */
    }
  };
}
