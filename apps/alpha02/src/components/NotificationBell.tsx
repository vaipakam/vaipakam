/**
 * In-app notification bell (#1213 / E-11) — the connected-app inbox.
 *
 * A free, wallet-native surface for the same loan-lifecycle events the
 * paid Telegram/Push channels deliver, with no setup: a bell in the
 * topbar, an unread count, and a dropdown of the newest rows. Each row
 * deep-links to the position, which re-verifies the exact state on chain
 * (the indexer feed is a convenience hint, never the source of truth).
 *
 * Read/unread is CLIENT-side (`lib/notifSeen`): a per-wallet last-seen
 * cursor keyed on the feed's chain-order `(block, logIndex)`. Opening the
 * panel marks everything currently loaded as read (advances the cursor);
 * a session snapshot keeps the "new" dots visible until the panel closes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlarmClock,
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCircle2,
  Coins,
  Handshake,
  Hourglass,
  Repeat,
  ShieldAlert,
  Siren,
  TrendingDown,
  type LucideIcon,
} from 'lucide-react';
import { useActiveChain } from '../chain/useActiveChain';
import { useNotifications } from '../data/notifications';
import { indexerConfigured, type IndexedNotification } from '../data/indexer';
import {
  isNewer,
  isUnread,
  loadLastSeen,
  storeLastSeen,
  type SeenCursor,
} from '../lib/notifSeen';
import { copy } from '../content/copy';

/** Cap the badge so a first-connect backlog reads "9+", not "237". */
const BADGE_CAP = 9;

const KIND_ICON: Record<string, LucideIcon> = {
  loan_matched: Handshake,
  partial_repay: Coins,
  loan_repaid: CheckCircle2,
  loan_defaulted: AlertTriangle,
  internal_matched: Repeat,
  // Calendar rows (#1213 PR 2) — the indexer's time-derived reminders.
  maturity_7d: CalendarClock,
  maturity_1d: AlarmClock,
  grace_entered: Hourglass,
  // HF-band rows (#1213 PR 2b) — the keeper's loan-health crossings.
  hf_warn: TrendingDown,
  hf_alert: ShieldAlert,
  hf_critical: Siren,
};

/** The newest chain-order cursor among loaded rows (feed is newest-first,
 *  but scan defensively for the first row that actually carries a key).
 *  Carries `id` — the feed's same-log tiebreaker (Codex #1295 r1). */
function newestCursorOf(rows: IndexedNotification[]): SeenCursor | null {
  for (const r of rows) {
    if (r.blockNumber != null && r.logIndex != null) {
      return { block: r.blockNumber, logIndex: r.logIndex, id: r.id };
    }
  }
  return null;
}

export function NotificationBell() {
  const { readChain, address } = useActiveChain();
  const { data } = useNotifications();
  const [open, setOpen] = useState(false);

  // A session snapshot of the cursor as it was when the panel opened, so
  // the "new" dots stay visible after opening advances the real cursor.
  const seenAtOpen = useRef<SeenCursor | null>(null);

  // The persisted last-seen cursor, re-derived whenever the wallet/chain
  // identity changes (a switch must not leak another wallet's read-state).
  // The switch also CLOSES the panel and drops the open-time snapshot
  // (Codex #1295 r2): otherwise the mark-read effect below would treat the
  // new wallet's feed as an already-open panel and clear its badge without
  // the user ever opening that inbox.
  const [lastSeen, setLastSeen] = useState<SeenCursor | null>(null);
  useEffect(() => {
    setLastSeen(address ? loadLastSeen(readChain.chainId, address) : null);
    setOpen(false);
    seenAtOpen.current = null;
  }, [readChain.chainId, address]);

  const rows = data?.notifications ?? [];

  // Unread = rows strictly newer than the persisted cursor.
  const unreadCount = useMemo(
    () => rows.filter((r) => isUnread(r, lastSeen)).length,
    [rows, lastSeen],
  );

  const markAllRead = useCallback(() => {
    if (!address) return;
    const newest = newestCursorOf(rows);
    if (!newest) return;
    storeLastSeen(readChain.chainId, address, newest);
    // Only advance (never a needless re-render / regression) — same
    // guard the store applies.
    setLastSeen((prev) => (prev && !isNewer(newest, prev) ? prev : newest));
  }, [address, readChain.chainId, rows]);

  // Opening the panel: snapshot the pre-open cursor (for the "new" dots).
  // Marking read is handled by the effect below — NOT here — so a panel
  // opened while the first page is still loading still clears the badge
  // once the rows resolve (Codex #1295 r1).
  const toggleOpen = useCallback(() => {
    if (!open) {
      seenAtOpen.current = lastSeen;
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [open, lastSeen]);

  // While the panel is open, mark everything currently loaded as read —
  // re-running when the rows resolve or a later page/refetch brings more,
  // so the badge stays cleared even if the feed arrived after the open.
  useEffect(() => {
    if (open) markAllRead();
  }, [open, markAllRead]);

  // Escape closes the panel (matches the app's other light-dismiss menus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // No per-wallet inbox to show → hide the bell entirely: a disconnected
  // wallet (the ConnectButton beside it is the affordance), or a build
  // with no indexer origin (the feed query is disabled, so the panel
  // could never load — don't offer a dead bell).
  if (!address || !indexerConfigured()) return null;

  const badge =
    unreadCount > BADGE_CAP ? `${BADGE_CAP}+` : String(unreadCount);
  const hasUnread = unreadCount > 0;

  return (
    <div className="notif">
      <button
        type="button"
        className="notif-bell"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          hasUnread
            ? `${copy.notifications.bellLabel} — ${copy.notifications.unreadBadgeTitle(unreadCount)}`
            : copy.notifications.bellLabel
        }
        onClick={toggleOpen}
        data-testid="notif-bell"
      >
        <Bell aria-hidden />
        {hasUnread ? (
          <span
            className="notif-badge"
            title={copy.notifications.unreadBadgeTitle(unreadCount)}
            data-testid="notif-badge"
          >
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div
            className="notif-backdrop"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="notif-panel" role="dialog" aria-label={copy.notifications.title}>
            <div className="notif-panel-head">
              <span className="notif-panel-title">{copy.notifications.title}</span>
            </div>

            <div className="notif-list">
              {data === undefined ? (
                <p className="notif-empty">{copy.notifications.loading}</p>
              ) : data === null ? (
                <p className="notif-empty">{copy.notifications.unavailable}</p>
              ) : rows.length === 0 ? (
                <p className="notif-empty">{copy.notifications.empty}</p>
              ) : (
                rows.map((row) => (
                  <NotificationRow
                    key={row.id}
                    row={row}
                    unread={isUnread(row, seenAtOpen.current)}
                    onNavigate={() => setOpen(false)}
                  />
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function NotificationRow({
  row,
  unread,
  onNavigate,
}: {
  row: IndexedNotification;
  unread: boolean;
  onNavigate: () => void;
}) {
  const Icon = KIND_ICON[row.kind] ?? Bell;
  const title = copy.notifications.line[row.kind] ?? copy.notifications.line.generic;
  // Only a loan-linked row is tappable, so only IT gets the "tap to view"
  // secondary line; a static (no-loanId) row shows no sub rather than a
  // misleading tap prompt with nothing to open (Codex #1295 r2).
  const sub = row.loanId != null ? copy.notifications.loanRef(row.loanId) : null;

  const body = (
    <>
      <span className="notif-row-icon" aria-hidden>
        <Icon />
      </span>
      <span className="notif-row-text">
        <span className="notif-row-title">{title}</span>
        {sub ? <span className="notif-row-sub">{sub}</span> : null}
      </span>
      {unread ? <span className="notif-row-dot" aria-hidden /> : null}
    </>
  );

  // A row with a loan id deep-links to its position (which re-verifies on
  // chain); a row without one (a future cron row) is a non-interactive
  // line rather than a dead link.
  if (row.loanId != null) {
    return (
      <Link
        to={`/positions/${row.loanId}`}
        className={`notif-row ${unread ? 'notif-row-unread' : ''}`}
        onClick={onNavigate}
        data-testid="notif-row"
      >
        {body}
      </Link>
    );
  }
  return (
    <div
      className={`notif-row notif-row-static ${unread ? 'notif-row-unread' : ''}`}
      data-testid="notif-row"
    >
      {body}
    </div>
  );
}
