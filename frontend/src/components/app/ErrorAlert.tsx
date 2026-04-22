import { AlertTriangle } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { ReportIssueLink } from './ReportIssueLink';

interface ErrorAlertProps {
  message: ReactNode;
  /** Extra content rendered inside the alert (e.g. retry buttons). */
  children?: ReactNode;
  /** Escape hatch for pages that need to tweak spacing (e.g. KeeperSettings). */
  style?: CSSProperties;
  className?: string;
}

export function ErrorAlert({
  message,
  children,
  style,
  className = '',
}: ErrorAlertProps) {
  return (
    <div
      className={`alert alert-error ${className}`.trim()}
      style={style}
      role="alert"
    >
      <AlertTriangle size={18} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span>{message}</span>
        {children}
      </div>
      <ReportIssueLink variant="inline" />
    </div>
  );
}
