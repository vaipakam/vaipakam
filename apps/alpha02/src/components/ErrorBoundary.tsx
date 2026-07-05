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
 * `resetKey={location.pathname}`, so navigating away from a crashed
 * route recovers without a full reload (the nav stays alive because
 * the boundary sits INSIDE the shell). A second instance wraps the
 * whole tree in main.tsx (no resetKey) for shell/provider crashes.
 *
 * Diagnostics stay console-only for now — alpha02 has no journey-log
 * buffer; the diagnostics-drawer half of #1028 will give this a sink.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { copy } from '../content/copy';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** When this value changes, the boundary resets (route navigation). */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/** React production builds throw `Minified React error #NNN` — useless
 *  to a user. Map the likely ones to a one-line plain-English gloss;
 *  anything unlisted falls back to the raw message.
 *  See https://react.dev/errors/<code>. */
const REACT_ERROR_GLOSS: Record<string, string> = {
  '185':
    'Maximum update depth exceeded — a component is updating state on every render. This is an infinite render loop.',
  '300': 'Rendered fewer hooks than expected — a hook was skipped by a conditional return.',
  '301': 'Too many re-renders — a state setter is being called during render.',
  '310': 'Rules of Hooks violation — a hook was called conditionally or out of order.',
  '321': 'Invalid hook call — hooks can only run inside a React function component.',
  '418': 'Hydration mismatch — server and client rendered different markup.',
};

function reactErrorGloss(message: string): string | null {
  const m = /Minified React error #(\d+)/.exec(message);
  if (!m) return null;
  return REACT_ERROR_GLOSS[m[1]] ?? `React error #${m[1]} — see https://react.dev/errors/${m[1]}`;
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
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // componentStack arrives later in componentDidCatch's ErrorInfo.
    return { error, componentStack: null };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Route changed → clear the error so the new route renders clean.
    // Guarded on state.error so healthy renders never churn state.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null, componentStack: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = trimComponentStack(info.componentStack, 12);
    this.setState({ componentStack: componentStack || null });
    // eslint-disable-next-line no-console
    console.error('[vaipakam] uncaught render error:', error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const message = error.message || String(error);
    const gloss = reactErrorGloss(message);
    return (
      <div className="empty-state" role="alert">
        <AlertTriangle aria-hidden />
        <h3>{copy.errorBoundary.title}</h3>
        <p>{copy.errorBoundary.body}</p>
        {gloss ? <p>{gloss}</p> : null}
        <pre
          className="mono"
          aria-label="Error detail"
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
