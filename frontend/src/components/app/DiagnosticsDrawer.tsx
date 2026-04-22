import { useEffect, useState } from 'react';
import { LifeBuoy, Download, Trash2, X } from 'lucide-react';
import {
  subscribe,
  exportDiagnostics,
  clearJourney,
  resetReportId,
  type JourneyEvent,
} from '../../lib/journeyLog';
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

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'failure', label: 'Failure' },
  { key: 'start', label: 'Start' },
  { key: 'success', label: 'Success' },
];

export default function DiagnosticsDrawer() {
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
      // Clipboard blocked (e.g. insecure context) — fall through to download.
      handleDownload();
    }
  };

  const handleDownload = () => {
    const blob = new Blob([exportDiagnostics()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaipakam-diagnostics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
          aria-label="Open diagnostics"
          data-tooltip="Troubleshooting / diagnostics"
          data-tooltip-placement="left"
        >
          <LifeBuoy size={18} />
          <span>Diagnostics</span>
          {failureCount > 0 && <span className="diag-fab-badge">{failureCount}</span>}
        </button>
      )}

      {open && (
        <>
          <div className="diag-overlay" onClick={() => setOpen(false)} />
          <aside className="diag-drawer" role="dialog" aria-label="Diagnostics">
            <header className="diag-header">
              <h3>Diagnostics ({visibleEvents.length}/{events.length})</h3>
              <button onClick={() => setOpen(false)} aria-label="Close" className="diag-close">
                <X size={18} />
              </button>
            </header>

            <p className="diag-hint">
              A redacted log of your recent steps is kept here to help support
              diagnose problems. Report directly on GitHub (prefilled &
              redacted), or copy / download the full JSON for support. Wallet
              addresses are shortened to <code>0x…abcd</code>; user-agent
              and free-form error text are not published.
            </p>

            <div className="diag-actions">
              {/* Primary CTA for Phase 1: publish straight to GitHub with
                  a redacted body. Copy/Download stay available for deeper
                  support tickets that want the full local buffer. */}
              <ReportIssueLink variant="button" label="Report on GitHub" />
              <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
                <Download size={14} />
                {copied ? 'Copied!' : 'Copy JSON'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={handleDownload}>
                <Download size={14} />
                Download
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  clearJourney();
                  resetReportId();
                }}
              >
                <Trash2 size={14} />
                Clear
              </button>
            </div>

            <div className="diag-filters" role="tablist" aria-label="Filter by status">
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
                    {f.label}
                    <span className="diag-filter-count">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="diag-events">
              {events.length === 0 ? (
                <p className="diag-empty">No events yet — take an action to start recording.</p>
              ) : visibleEvents.length === 0 ? (
                <p className="diag-empty">
                  No {filter} events. Switch the filter to see other steps.
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
                      {ev.loanId !== undefined && ` · loan #${ev.loanId}`}
                      {ev.offerId !== undefined && ` · offer #${ev.offerId}`}
                    </div>
                    {ev.errorMessage && (
                      <div className="diag-event-error">
                        <strong>{ev.errorType ?? 'error'}:</strong> {ev.errorMessage}
                        <span style={{ marginLeft: 8 }}>
                          <ReportIssueLink />
                        </span>
                      </div>
                    )}
                    <div className="diag-event-time">
                      {new Date(ev.timestamp).toLocaleTimeString()}
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
