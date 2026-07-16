/**
 * In-app notification read-state (#1213 / E-11) — CLIENT-side, per wallet.
 *
 * The indexer serves the inbox feed but tracks NO server read-state: an
 * unauthenticated server mark-read would be griefable (anyone could clear
 * a victim's badge) and a per-action signature is poor UX, so read/unread
 * lives here as a per-wallet "last-seen" cursor in localStorage (see the
 * PR-1 indexer fragment + design doc).
 *
 * The cursor is the SAME chain-order key `(block, logIndex)` the feed
 * orders + paginates by — NOT `createdAt`, which is only a best-effort
 * display timestamp (wall-clock fallback on a mid-catch-up read failure).
 * A row is UNREAD when its chain-order key is strictly newer than the
 * stored cursor; opening the panel advances the cursor to the newest row,
 * clearing the badge. No cursor yet → every fetched row is unread (an
 * honest first-connect state that the first panel-open clears).
 *
 * localStorage failures are swallowed on purpose: losing the cursor only
 * re-shows an "unread" affordance, never funds.
 */

/** A chain-order position — the feed's `(blockNumber, logIndex)` key. */
export interface SeenCursor {
  block: number;
  logIndex: number;
}

const PREFIX = 'alpha02.notif.lastseen';

const key = (chainId: number, wallet: string) =>
  `${PREFIX}.${chainId}.${wallet.toLowerCase()}`;

/** The wallet's last-seen cursor, or `null` if it has never opened the
 *  inbox on this chain (→ treat every row as unread). */
export function loadLastSeen(chainId: number, wallet: string): SeenCursor | null {
  try {
    const raw = window.localStorage.getItem(key(chainId, wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SeenCursor>;
    if (
      typeof parsed.block === 'number' &&
      Number.isFinite(parsed.block) &&
      typeof parsed.logIndex === 'number' &&
      Number.isFinite(parsed.logIndex)
    ) {
      return { block: parsed.block, logIndex: parsed.logIndex };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the wallet's last-seen cursor. Advancing NEVER moves the cursor
 *  backwards (a stale write from an out-of-order render can't re-surface
 *  already-seen rows). */
export function storeLastSeen(
  chainId: number,
  wallet: string,
  cursor: SeenCursor,
): void {
  try {
    const prev = loadLastSeen(chainId, wallet);
    if (prev && !isNewer(cursor, prev)) return; // never regress
    window.localStorage.setItem(key(chainId, wallet), JSON.stringify(cursor));
  } catch {
    // See module doc — cursor loss is affordance loss only.
  }
}

/** Strict chain-order "is `a` newer than `b`" — (block, logIndex) desc. */
export function isNewer(a: SeenCursor, b: SeenCursor): boolean {
  if (a.block !== b.block) return a.block > b.block;
  return a.logIndex > b.logIndex;
}

/** A row is unread when its chain-order key is strictly newer than the
 *  last-seen cursor. A null cursor (never opened) makes every row unread.
 *  A row missing its chain-order key (e.g. a future cron row with no block)
 *  is treated as read here — it can't be ordered against the cursor, so it
 *  must not inflate the badge. */
export function isUnread(
  row: { blockNumber: number | null; logIndex: number | null },
  lastSeen: SeenCursor | null,
): boolean {
  if (row.blockNumber == null || row.logIndex == null) return false;
  const at: SeenCursor = { block: row.blockNumber, logIndex: row.logIndex };
  if (!lastSeen) return true;
  return isNewer(at, lastSeen);
}
