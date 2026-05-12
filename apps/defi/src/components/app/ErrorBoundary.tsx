/**
 * App-wide render-error boundary.
 *
 * Until this existed, ANY exception thrown during render (a bad
 * `.toLowerCase()` on an undefined field, a viem ABI-decode mismatch
 * surfaced inside a `useMemo`, a context consumed outside its provider,
 * …) unmounted the entire React tree and left the user staring at a
 * blank white page with nothing to act on and nothing logged. That's
 * exactly the "page got blank" failure mode reported on the Analytics
 * page after switching the view-chain.
 *
 * This boundary turns that into:
 *   - a recoverable error card (Reload / Back to Dashboard), and
 *   - a `journeyLog` `app-crash` entry carrying the message + stack,
 *     so the Diagnostics drawer (and an exported support bundle) shows
 *     what actually threw — the next occurrence is diagnosable instead
 *     of a dead end.
 *
 * Full detail (stack, cause chain) goes to the diagnostics buffer, per
 * the error-visibility split: the page-inline copy stays concise and
 * action-oriented; the operator-grade detail lives in the drawer.
 *
 * Reset behaviour: the boundary clears its error state whenever
 * `resetKey` changes (wired to `location.pathname` by the caller) so
 * navigating away from the crashed route recovers without a full page
 * reload — without remounting the whole route subtree on every
 * navigation the way a `key={pathname}` on the boundary would.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { classifyError, emit } from '../../lib/journeyLog';
import './ErrorBoundary.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** When this value changes, the boundary resets (route navigation). */
  resetKey?: string;
}

interface ErrorBoundaryState {
  /** The caught error, or `null` while the subtree is healthy. */
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Route changed (or whatever drives `resetKey`) → clear the error so
    // the new route gets a clean render. Guard on `state.error` so we
    // don't call setState on every prop change when nothing's wrong.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const { message } = classifyError(error);
    // Truncate the component stack — the top few frames identify the
    // offending component; the full tree would balloon the log entry.
    const componentStack = (info.componentStack ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join('\n');
    const stack = [error.stack, componentStack && `--- component stack ---\n${componentStack}`]
      .filter(Boolean)
      .join('\n');
    emit({
      area: 'app-crash',
      flow: 'render',
      step: 'componentDidCatch',
      status: 'failure',
      errorType: 'unknown',
      errorMessage: message,
      errorStack: stack || undefined,
    });
    // Also surface it to the console so it isn't swallowed in dev.
    // eslint-disable-next-line no-console
    console.error('[vaipakam] uncaught render error:', error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { message } = classifyError(error);
    return (
      <div className="error-boundary-fallback" role="alert">
        <div className="error-boundary-card">
          <div className="error-boundary-icon">
            <AlertTriangle size={28} aria-hidden="true" />
          </div>
          <h1 className="error-boundary-title">Something went wrong on this page</h1>
          <p className="error-boundary-body">
            The page hit an unexpected error and stopped rendering. Your funds
            and on-chain positions are unaffected — this is a display-side
            fault. Reloading usually clears it.
          </p>
          {message && (
            <pre className="error-boundary-detail" aria-label="Error detail">
              {message}
            </pre>
          )}
          <p className="error-boundary-hint">
            Full diagnostics were recorded — open the Diagnostics drawer
            (footer) to export a support bundle if it keeps happening.
          </p>
          <div className="error-boundary-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={this.handleReload}>
              Reload page
            </button>
            <a href="/" className="btn btn-secondary btn-sm">
              Back to Dashboard
            </a>
          </div>
        </div>
      </div>
    );
  }
}
