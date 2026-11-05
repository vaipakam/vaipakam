import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * The last line of RB-FUNDS on a render fault: a page that throws says it
 * could not be shown and offers a reload, instead of a blank frame that a
 * user might read as "nothing here". It never renders a figure the faulted
 * tree had.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[alpha05] render fault', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="page" role="alert">
        <h1>This page could not be shown</h1>
        <p>
          Something in the page failed before it could render. Nothing was sent to the blockchain. Reload to try
          again; if it keeps happening, the Help page lists how to report it.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
