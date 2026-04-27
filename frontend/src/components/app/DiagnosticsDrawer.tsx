import { useEffect, useState } from 'react';
import { LifeBuoy, Copy, X, FileDown, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  subscribe,
  exportDiagnostics,
  type JourneyEvent,
} from '../../lib/journeyLog';
import { formatTime } from '../../lib/format';
import { downloadMyData, deleteMyData } from '../../lib/gdpr';
import { useMode } from '../../context/ModeContext';
import { ReportIssueLink } from './ReportIssueLink';
import { InfoTip } from '../InfoTip';
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

            <div className="diag-actions">
              {/* Two complementary support actions:
                  • Report on GitHub — one-click prefilled issue.
                  • Copy JSON       — paste-into-chat workflow.
                  The previous Download / Clear buttons were removed
                  in favour of the broader GDPR row below — Download
                  my data covers the file-export case (and exports
                  more than the journey log), and Delete my data
                  covers the wipe case (and clears the rest of the
                  client-side namespace too). */}
              <ReportIssueLink variant="button" label={t('diagnostics.reportOnGithub')} />
              <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
                <Copy size={14} />
                {copied ? t('diagnostics.copied') : t('diagnostics.copyJson')}
              </button>
            </div>

            {/* Phase 4.4 — GDPR data-subject-rights surface. Distinct
                from the Copy / Download / Clear row above (which is a
                support-debug flow for the journey buffer only): these
                two buttons export or erase EVERY piece of client-side
                data Vaipakam has on the user — journey log, consent
                choice, cached event index — and cover the Privacy
                Policy's "right to access" + "right to erasure" boxes
                end-to-end. On-chain positions are unaffected; the
                banner text on the button tooltips makes this clear. */}
            <div
              className="diag-actions"
              style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}
            >
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-tertiary)',
                  width: '100%',
                  marginBottom: 4,
                }}
              >
                {t('diagnostics.dataRights')}
              </span>
              {/* Each action is wrapped with its own InfoTip so the
                  helper text stays anchored next to its button when
                  the row wraps on narrow viewports. The (i) icon is
                  the same surface mobile users tap to read the
                  explanation — desktop users still get hover. The
                  bubble is portal-rendered, so the drawer's
                  `transform`/`overflow` clipping context can't
                  truncate it. */}
              <span className="diag-action-with-info">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    downloadMyData();
                  }}
                >
                  <FileDown size={14} />
                  {t('diagnostics.downloadMyData')}
                </button>
                <InfoTip ariaLabel={t('diagnostics.downloadMyDataAria')}>
                  {t('diagnostics.downloadMyDataTip')}
                </InfoTip>
              </span>
              <span className="diag-action-with-info">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    // Two-step confirm — delete is irreversible on the
                    // client side (though everything is restorable by
                    // re-using the app; on-chain state stays).
                    const ok = window.confirm(t('diagnostics.deleteConfirm'));
                    if (!ok) return;
                    deleteMyData();
                    // Reload so every hook / banner rehydrates from
                    // the now-empty storage.
                    window.location.reload();
                  }}
                >
                  <ShieldAlert size={14} />
                  {t('diagnostics.deleteMyData')}
                </button>
                <InfoTip ariaLabel={t('diagnostics.deleteMyDataAria')}>
                  {t('diagnostics.deleteMyDataTip')}
                </InfoTip>
              </span>
            </div>

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
