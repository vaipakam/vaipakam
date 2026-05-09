import { AlertTriangle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ReportIssueLink } from './ReportIssueLink';

interface ErrorAlertProps {
  message: ReactNode;
  /** Extra content rendered inside the alert (e.g. retry buttons). */
  children?: ReactNode;
  /** Escape hatch for pages that need to tweak spacing (e.g. KeeperSettings). */
  style?: CSSProperties;
  className?: string;
  /** Optional callback when the user clicks the dismiss button. When omitted,
   *  the alert hides itself locally; the parent's error state is untouched
   *  but the banner disappears until `message` changes. */
  onDismiss?: () => void;
}

export function ErrorAlert({
  message,
  children,
  style,
  className = '',
  onDismiss,
}: ErrorAlertProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  // Reset the dismissed state whenever the message changes — a new error
  // should surface even if the user had dismissed the previous one.
  useEffect(() => {
    setDismissed(false);
  }, [message]);

  if (dismissed) return null;

  const handleDismiss = () => {
    if (onDismiss) onDismiss();
    else setDismissed(true);
  };

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
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t('shared.dismiss')}
        className="alert-dismiss-btn"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          padding: 4,
          marginLeft: 4,
          cursor: 'pointer',
          color: 'inherit',
          opacity: 0.7,
          borderRadius: 4,
          flex: '0 0 auto',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = '1';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = '0.7';
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
