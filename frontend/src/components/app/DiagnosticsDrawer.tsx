import { useEffect, useState } from 'react';
import { LifeBuoy, Copy, X, FileDown, Trash2, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { L as Link } from '../L';
import {
  subscribe,
  exportDiagnostics,
  clearJourney,
  type JourneyEvent,
} from '../../lib/journeyLog';
import { formatTime } from '../../lib/format';
import { useMode } from '../../context/ModeContext';
import { ReportIssueLink } from './ReportIssueLink';
import './DiagnosticsDrawer.css';

/**
 * Floating "Support" button + slide-over drawer that renders the latest
 * journey events (see lib/journeyLog.ts). Users can copy a redacted JSON
 * blob to paste into a support ticket, download it as a file, or clear the
 * buffer. The button is present in AppLayout so every app page has access.
 */
type StatusFilter = 'all' | 'failure' | 'start' | 'success';

const FILTERS: { key: StatusFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'diagnostics.filterAll' },
  { key: 'failure', labelKey: 'diagnostics.filterFailure' },
  { key: 'start', labelKey: 'diagnostics.filterStart' },
  { key: 'success', labelKey: 'diagnostics.filterSuccess' },
];

/**
 * Master flag — when `VITE_DIAG_DRAWER_ENABLED` is the literal string
 * "false" the drawer (floating LifeBuoy button + slide-over panel)
 * doesn't mount at all. Lets the operator hide the user-facing
 * "report issue" affordance once server-side error capture is the
 * canonical reporting channel — no other major DeFi platform asks
 * users to hand-author bug reports, and the drawer's mere presence
 * signals "this might break". Default behaviour (env var unset OR
 * any value other than "false") is to render the drawer, so existing
 * deploys are unchanged. Read once at module load — no hot-toggle;
 * a redeploy with the new env value flips the behaviour.
 */
const DRAWER_ENABLED = (() => {
  try {
    const raw = (import.meta.env.VITE_DIAG_DRAWER_ENABLED as string | undefined) ?? '';
    return raw.toLowerCase() !== 'false';
  } catch {
    return true;
  }
})();

export default function DiagnosticsDrawer() {
  const { t } = useTranslation();
  const { mode } = useMode();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<JourneyEvent[]>([]);
  const [copied, setCopied] = useState(false);
  // Default to "Failure" so users land on what they most likely opened the
  // drawer to investigate. The "Report on GitHub" link always exports the
  // full unfiltered log — the filter is a UI concern only.
  const [filter, setFilter] = useState<StatusFilter>('failure');

  useEffect(() => subscribe(setEvents), []);

  const handleCopy = async () => {
    const blob = exportDiagnostics();
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context). The GDPR-scoped
      // "Download my data" below covers the file-download path
      // including the journey log, so a fallback here would be
      // duplicative — silently no-op and let the user reach for the
      // larger button.
    }
  };

  const failureCount = events.filter((e) => e.status === 'failure').length;
  // Basic mode hides the FAB on the happy path — the drawer is primarily a
  // support-triage surface, so we only surface it once something has gone
  // wrong. Advanced mode keeps it visible at all times so power users can
  // inspect the live event stream proactively. Once opened, we keep it
  // mounted regardless of mode so Clear / Report stay reachable.
  const fabVisible = failureCount > 0 || open || mode === 'advanced';

  const visibleEvents = filter === 'all'
    ? events
    : events.filter((e) => e.status === filter);

  // Master flag (see DRAWER_ENABLED constant above). When the
  // operator has opted out, render nothing — no FAB, no drawer.
  // Server-side error capture in `lib/journeyLog.ts` continues to
  // run in the background regardless, so the support team still
  // sees every failure even when the user-facing affordance is off.
  if (!DRAWER_ENABLED) return null;

  return (
    <>
      {fabVisible && (
        <button
          type="button"
          className="diag-fab"
          onClick={() => setOpen(true)}
          aria-label={t('diagnostics.fabAria')}
          data-tooltip={t('diagnostics.fabTooltip')}
          data-tooltip-placement="left"
        >
          <LifeBuoy size={18} />
          <span>{t('diagnostics.fabLabel')}</span>
          {failureCount > 0 && <span className="diag-fab-badge">{failureCount}</span>}
        </button>
      )}

      {open && (
        <>
          <div className="diag-overlay" onClick={() => setOpen(false)} />
          <aside className="diag-drawer" role="dialog" aria-label={t('diagnostics.drawerAria')}>
            <header className="diag-header">
              <h3>{t('diagnostics.title')} ({visibleEvents.length}/{events.length})</h3>
              <button onClick={() => setOpen(false)} aria-label={t('diagnostics.closeAria')} className="diag-close">
                <X size={18} />
              </button>
            </header>

            <p className="diag-hint">{t('diagnostics.hint')}</p>

            {/* Single row of journey-buffer-scoped support actions.
                The hint paragraph above already establishes the scope
                ("a redacted log of recent steps … report directly on
                GitHub … or copy / download the full JSON"), so the
                buttons read as just `Download` and `Delete` — extra
                "journey log" qualifier would be redundant. The pair
                acts only on the in-memory journey buffer; the
                broader GDPR Download / Delete pair lives on the
                Data Rights page (link below) since the broader
                Delete also wipes cookies and cached event indexes
                (a reflexive click from this support drawer would be
                surprising). */}
            <div className="diag-actions">
              <ReportIssueLink variant="button" label={t('diagnostics.reportOnGithub')} />
              <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
                <Copy size={14} />
                {copied ? t('diagnostics.copied') : t('diagnostics.copyJson')}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  const blob = new Blob([exportDiagnostics()], {
                    type: 'application/json',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `vaipakam-journey-${Date.now()}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <FileDown size={14} />
                {t('diagnostics.download')}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => clearJourney()}
              >
                <Trash2 size={14} />
                {t('diagnostics.delete')}
              </button>
            </div>

            <Link
              to="/app/data-rights"
              onClick={() => setOpen(false)}
              style={{
                marginTop: 8,
                fontSize: '0.78rem',
                color: 'var(--brand)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Lock size={12} />
              {t('diagnostics.dataRightsLink')}
            </Link>

            <div className="diag-filters" role="tablist" aria-label={t('diagnostics.filterAriaLabel')}>
              {FILTERS.map((f) => {
                const count = f.key === 'all'
                  ? events.length
                  : events.filter((e) => e.status === f.key).length;
                return (
                  <button
                    key={f.key}
                    type="button"
                    role="tab"
                    aria-selected={filter === f.key}
                    className={`diag-filter ${filter === f.key ? 'active' : ''}`}
                    onClick={() => setFilter(f.key)}
                  >
                    {t(f.labelKey)}
                    <span className="diag-filter-count">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="diag-events">
              {events.length === 0 ? (
                <p className="diag-empty">{t('diagnostics.noEventsYet')}</p>
              ) : visibleEvents.length === 0 ? (
                <p className="diag-empty">
                  {t('diagnostics.noFilterMatches', { filter: t(`diagnostics.filter${filter.charAt(0).toUpperCase()}${filter.slice(1)}`).toLowerCase() })}
                </p>
              ) : (
                [...visibleEvents].reverse().map((ev) => (
                  <div key={ev.id} className={`diag-event diag-event-${ev.status}`}>
                    <div className="diag-event-row">
                      <span className="diag-event-area">{ev.area}</span>
                      <span className="diag-event-flow">{ev.flow}</span>
                      <span className={`diag-event-status diag-event-status-${ev.status}`}>
                        {ev.status}
                      </span>
                    </div>
                    <div className="diag-event-step">
                      {ev.step}
                      {ev.loanId !== undefined && ` · ${t('diagnostics.loanSuffix', { id: ev.loanId })}`}
                      {ev.offerId !== undefined && ` · ${t('diagnostics.offerSuffix', { id: ev.offerId })}`}
                    </div>
                    {ev.errorMessage && (
                      <div className="diag-event-error">
                        <strong>{ev.errorType ?? t('diagnostics.errorFallback')}:</strong> {ev.errorMessage}
                        <span style={{ marginLeft: 8 }}>
                          <ReportIssueLink />
                        </span>
                      </div>
                    )}
                    <div className="diag-event-time">
                      {formatTime(ev.timestamp)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
