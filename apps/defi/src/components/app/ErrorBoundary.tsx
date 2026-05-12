/**
 * App-wide render-error boundary.
 *
 * Until this existed, ANY exception thrown during render (a bad
 * `.toLowerCase()` on an undefined field, a viem ABI-decode mismatch
 * surfaced inside a `useMemo`, a context consumed outside its provider,
 * an infinite render→setState loop, …) unmounted the entire React tree
 * and left the user staring at a blank white page with nothing to act
 * on and nothing logged. That's the "page got blank" failure mode
 * reported on the Analytics page after switching the view-chain.
 *
 * This boundary turns that into:
 *   - a recoverable error card (Reload / Back to Dashboard), and
 *   - a `journeyLog` `app-crash` entry carrying the message + stack +
 *     component stack, so the Diagnostics drawer (and an exported
 *     support bundle) shows what actually threw — the next occurrence
 *     is diagnosable instead of a dead end.
 *
 * A note on what a boundary *can't* do: it catches the throw, but for
 * an infinite-update error (React #185, "Maximum update depth
 * exceeded") there is no stable render to fall back to — React aborts
 * the render on purpose to stop the loop. So "just keep showing the
 * page" isn't an option for that class; the fix is to find and stop
 * the loop (the component stack below names where to look).
 *
 * Per the error-visibility split: the page copy stays concise and
 * action-oriented, but a render crash IS something the user should see
 * *something* about — so we surface a plain-English gloss + a trimmed
 * component stack on-card (it's what identifies the culprit) and the
 * full detail (raw stack, cause chain) goes to the diagnostics buffer.
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
  /** React's component stack at the time of the throw (trimmed). */
  componentStack: string | null;
}

/**
 * React production builds throw `Minified React error #NNN; visit …` —
 * useless to a user (and to a maintainer reading a support bundle). Map
 * the ones we've actually hit / are likely to hit to a one-line plain-
 * English gloss. Anything not listed falls back to the raw message.
 * See https://react.dev/errors/<code>.
 */
const REACT_ERROR_GLOSS: Record<string, string> = {
  '185':
    'Maximum update depth exceeded — a component is updating state on every render (a setState in the render body, or an effect/memo whose dependencies change every render). This is an infinite render loop.',
  '300': 'Rendered fewer hooks than expected — a hook was skipped by a conditional return or early branch.',
  '301': 'Too many re-renders — React stopped a render loop. A state setter is being called during render.',
  '310': 'Rules of Hooks violation — a hook was called conditionally or in a different order between renders.',
  '321': 'Invalid hook call — hooks can only be called from a React function component or another hook.',
  '418': 'Hydration mismatch — server and client rendered different markup.',
  '423': 'A component suspended while responding to synchronous input.',
  '425': 'Text content mismatch during hydration.',
};

/** Pull `#185` (etc.) out of React's minified-error message and look up
 *  the gloss; returns `null` when the message isn't a minified-React one. */
function reactErrorGloss(message: string): string | null {
  const m = /Minified React error #(\d+)/.exec(message);
  if (!m) return null;
  return REACT_ERROR_GLOSS[m[1]] ?? `React error #${m[1]} — see https://react.dev/errors/${m[1]}`;
}

/** Trim a React component stack to its top frames (the ones nearest the
 *  throw site, which identify the culprit) and strip the source-location
 *  noise so it reads cleanly on a small card. */
function trimComponentStack(raw: string | null | undefined, max: number): string {
  return (raw ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/^at\s+/, ''))
    .filter(Boolean)
    .slice(0, max)
    .join('\n');
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // componentStack isn't available here — it arrives in
    // componentDidCatch's ErrorInfo. Set the error now so the fallback
    // renders; componentDidCatch fills in the stack.
    return { error, componentStack: null };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Route changed (or whatever drives `resetKey`) → clear the error so
    // the new route gets a clean render. Guard on `state.error` so we
    // don't call setState on every prop change when nothing's wrong.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null, componentStack: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const { message } = classifyError(error);
    const gloss = reactErrorGloss(message);
    const componentStack = trimComponentStack(info.componentStack, 12);
    this.setState({ componentStack: componentStack || null });
    const stack = [
      error.stack,
      componentStack && `--- component stack ---\n${componentStack}`,
    ]
      .filter(Boolean)
      .join('\n');
    emit({
      area: 'app-crash',
      flow: 'render',
      step: 'componentDidCatch',
      status: 'failure',
      errorType: 'unknown',
      // Lead with the gloss when we have one — a support bundle that
      // says "infinite render loop" is worth far more than "#185".
      errorMessage: gloss ? `${gloss} [${message}] @ ${this.props.resetKey ?? '?'}` : message,
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
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const { message } = classifyError(error);
    const gloss = reactErrorGloss(message);
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
          {gloss && <p className="error-boundary-gloss">{gloss}</p>}
          <pre className="error-boundary-detail" aria-label="Error detail">
            {message}
            {componentStack ? `\n\nComponent stack:\n${componentStack}` : ''}
          </pre>
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
