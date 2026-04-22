import { Bug } from 'lucide-react';
import { buildGithubIssueUrl } from '../../lib/journeyLog';
import './ReportIssueLink.css';

/**
 * One-click "Report on GitHub" link that opens a prefilled issue on the
 * Vaipakam issue tracker. Use this wherever an error is surfaced to the
 * user so support has a zero-friction path from a visible failure to an
 * actionable bug report.
 *
 * The URL is regenerated at click-time (not at render-time) so that
 * events logged BETWEEN the component mount and the click (e.g. retry
 * attempts, downstream cascaded failures) are included in the body.
 *
 * Redaction + safety guarantees are enforced inside {buildGithubIssueUrl}:
 * wallet addresses are shortened to `0x…abcd`, free-form error text is
 * truncated to 140 chars, and the user-agent is never published. See
 * lib/journeyLog.ts for the full redaction contract.
 */
interface ReportIssueLinkProps {
  /** Visual variant. `inline` renders as a small underlined link next to
   *  error text; `button` renders as a ghost-style button for standalone
   *  placement in error banners / empty states. */
  variant?: 'inline' | 'button';
  /** Optional override for the link label; defaults to "Report on GitHub". */
  label?: string;
  /** Optional extra className the parent wants to pin on. */
  className?: string;
}

export function ReportIssueLink({
  variant = 'inline',
  label = 'Report on GitHub',
  className = '',
}: ReportIssueLinkProps) {
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Rebuild at click-time so the URL captures the latest buffer state.
    const url = buildGithubIssueUrl();
    e.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const base = variant === 'button' ? 'btn btn-ghost btn-sm' : 'report-issue-link';
  return (
    <a
      href="https://github.com/vaipakam/vaipakam/issues"
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className={`${base} ${className}`.trim()}
      aria-label="Report this issue on GitHub"
      data-tooltip="Opens a prefilled issue form. No wallet address, user-agent, or free-form input is shared."
    >
      <Bug size={variant === 'button' ? 14 : 12} />
      <span>{label}</span>
    </a>
  );
}
