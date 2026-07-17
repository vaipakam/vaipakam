/**
 * App-wide render-error boundary (ported from apps/defi, #1028 item 1).
 *
 * Without it, ANY exception thrown during render (a bad property read
 * on an undefined field, an ABI-decode mismatch inside a useMemo, a
 * context consumed outside its provider, an infinite render loop, …)
 * unmounts the whole React tree and leaves the user on a blank white
 * page — at the worst possible moment if a transaction was mid-flight.
 * The boundary turns that into a recoverable card that says plainly:
 * this is a display-side fault, your funds and on-chain positions are
 * unaffected, and a transaction you just signed may still have gone
 * through (check your positions after reloading).
 *
 * What a boundary CAN'T do: for an infinite-update error (React #185)
 * there is no stable render to fall back to — React aborts the render
 * on purpose. The gloss + trimmed component stack on the card name the
 * culprit so the next report is diagnosable.
 *
 * Reset behaviour: mounted around the route Outlet with
 * `resetKey={pathname + search}` (query changes count: a crashed
 * ?offer deep link must recover when the user opens a different
 * one on the same path), so navigating away recovers without a full
 * reload (the nav stays alive because the boundary sits INSIDE the
 * shell). A second instance wraps the whole tree ABOVE the provider
 * stack in main.tsx (no resetKey) for provider/router crashes.
 *
 * Diagnostics: every caught crash is recorded into the last-error
 * sink (diagnostics/lastError.ts) so the Support drawer's pre-filled
 * report carries it — the sink the original console-only note
 * anticipated (#1028 item 4).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { copy } from '../content/copy';
import { recordLastError } from '../diagnostics/lastError';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** When this value changes, the boundary resets (route navigation). */
  resetKey?: string;
  /** Optional quiet fallback: when set, a caught error renders THIS
   *  instead of the full recovery card. For ADVISORY, non-critical
   *  children (e.g. a lazy-loaded banner whose chunk may fail to fetch)
   *  where the right degradation is to render nothing, not to replace
   *  the surrounding chrome with a crash card (Codex #1200 r2). */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  /** True whenever a descendant threw — REGARDLESS of what it threw.
   *  React reports thrown null/undefined to boundaries too; keying the
   *  fallback on the error VALUE would treat those as healthy and
   *  re-render the failed children. */
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

/** Whatever a descendant threw → a real Error for display. */
function normalizeThrown(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(
    value === null || value === undefined
      ? `A component threw ${String(value)} during render`
      : String(value),
  );
}

/** React production builds throw `Minified React error #NNN` — useless
 *  to a user. The likely codes map to a one-line plain-English gloss in
 *  the copy catalog (`copy.errorBoundary.glosses`, keyed by code);
 *  anything unlisted falls back to the raw message. Resolved INSIDE the
 *  function so the i18n copy proxy translates at access time (a
 *  module-scope map would freeze the English strings).
 *  See https://react.dev/errors/<code>. */
function reactErrorGloss(message: string): string | null {
  const m = /Minified React error #(\d+)/.exec(message);
  if (!m) return null;
  const glosses: Record<string, string | undefined> = {
    ...copy.errorBoundary.glosses,
  };
  return glosses[m[1]] ?? `React error #${m[1]} — see https://react.dev/errors/${m[1]}`;
}

/** Top frames of the component stack (nearest the throw — they name
 *  the culprit), stripped of source-location noise. */
function trimComponentStack(raw: string | null | undefined, max: number): string {
  return (raw ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/^at\s+/, ''))
    .filter(Boolean)
    .slice(0, max)
    .join('\n');
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, componentStack: null };

  static getDerivedStateFromError(thrown: unknown): ErrorBoundaryState {
    // componentStack arrives later in componentDidCatch's ErrorInfo.
    return { hasError: true, error: normalizeThrown(thrown), componentStack: null };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Route changed → clear the error so the new route renders clean.
    // Guarded on state.error so healthy renders never churn state.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null, componentStack: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = trimComponentStack(info.componentStack, 12);
    this.setState({ componentStack: componentStack || null });
    recordLastError({
      message: error?.message || String(error),
      componentStack: componentStack || undefined,
      // Search params carry the deep-link state (?offer=, ?chain=)
      // support needs to reproduce route-specific crashes; the report
      // builder redacts and caps this before anything leaves the
      // device.
      path: window.location.pathname + window.location.search,
      at: Date.now(),
    });
    // eslint-disable-next-line no-console
    console.error('[vaipakam] uncaught render error:', error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { hasError, error, componentStack } = this.state;
    if (!hasError) return this.props.children;

    // Advisory children opt into a quiet fallback (render nothing / a
    // small placeholder) instead of the full-page recovery card.
    if (this.props.fallback !== undefined) return this.props.fallback;

    const message = error?.message || String(error);
    const gloss = reactErrorGloss(message);
    return (
      <div className="empty-state" role="alert">
        <AlertTriangle aria-hidden />
        <h3>{copy.errorBoundary.title}</h3>
        <p>{copy.errorBoundary.body}</p>
        {gloss ? <p>{gloss}</p> : null}
        <pre
          className="mono"
          aria-label={copy.errorBoundary.detailAria}
          style={{
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 12,
            maxWidth: 560,
            margin: '8px auto',
            opacity: 0.75,
          }}
        >
          {message}
          {componentStack ? `\n\nComponent stack:\n${componentStack}` : ''}
        </pre>
        <div className="cluster" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn btn-primary" onClick={this.handleReload}>
            {copy.errorBoundary.reload}
          </button>
          <a href="/" className="btn btn-secondary">
            {copy.errorBoundary.home}
          </a>
        </div>
      </div>
    );
  }
}
