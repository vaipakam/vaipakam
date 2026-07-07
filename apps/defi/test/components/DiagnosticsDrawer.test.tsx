import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DiagnosticsDrawer from '../../src/components/app/DiagnosticsDrawer';
import { emit, clearJourney } from '../../src/lib/journeyLog';

/*
 * #1076: two load-time causes + copy drift.
 *
 * 1) DiagnosticsDrawer now consumes ModeContext (`useMode`) and renders a
 *    <ChainDiagnosticsPanel> inside the open drawer. That panel pulls in the
 *    whole DataFreshness / RealtimePush / Watermark / Diamond stack — heavy
 *    contexts the shared harness deliberately omits. We mock `useMode`
 *    (forced to 'advanced' so the FAB is always visible, matching the tests'
 *    "open the drawer" intent) and stub ChainDiagnosticsPanel to a no-op; it
 *    is an independent sub-component with its own concerns.
 * 2) The drawer's `L`-link to /data-rights needs a router — wrap in
 *    MemoryRouter.
 * 3) Copy drift: the FAB/dialog were relabelled "Report Issue" / "Issue
 *    Details" (aria "Open issue report"); the header count is now
 *    `(visible/total)` and the default status filter is "failure". The
 *    old "Copy JSON" clipboard action was removed — the action row is now
 *    Download + Report + Clear only (see DiagnosticsDrawer.tsx docblock), so
 *    the two clipboard-copy cases are dropped as a removed feature.
 */
vi.mock('../../src/context/ModeContext', () => ({
  useMode: () => ({ mode: 'advanced', setMode: () => {}, toggleMode: () => {} }),
}));
vi.mock('../../src/components/app/ChainDiagnosticsPanel', () => ({
  ChainDiagnosticsPanel: () => null,
}));

function renderDrawer() {
  return render(
    <MemoryRouter>
      <DiagnosticsDrawer />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearJourney();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiagnosticsDrawer', () => {
  it('renders a floating button that opens the drawer on click', () => {
    renderDrawer();
    expect(
      screen.queryByRole('dialog', { name: /Issue Details/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open issue report/i }));
    expect(
      screen.getByRole('dialog', { name: /Issue Details/i }),
    ).toBeInTheDocument();
  });

  it('shows a failure-count badge on the FAB when any event is a failure', () => {
    emit({ area: 'wallet', flow: 'f', step: 's', status: 'failure' });
    emit({ area: 'wallet', flow: 'f', step: 's2', status: 'failure' });
    emit({ area: 'wallet', flow: 'f', step: 's3', status: 'success' });
    renderDrawer();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders the empty-state hint when the buffer is empty', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Open issue report/i }));
    expect(
      screen.getByText(/No events yet — take an action to start recording/i),
    ).toBeInTheDocument();
  });

  it('renders each event with area/flow/status + loanId + error annotations', () => {
    emit({
      area: 'repay',
      flow: 'repayLoan',
      step: 'submit-tx',
      status: 'failure',
      loanId: 42n,
      errorType: 'contract-revert',
      errorMessage: 'Repayment window closed',
    });
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Open issue report/i }));
    expect(screen.getByText(/^repay$/)).toBeInTheDocument();
    expect(screen.getByText(/repayLoan/)).toBeInTheDocument();
    expect(screen.getByText(/submit-tx · loan #42/)).toBeInTheDocument();
    expect(screen.getByText(/contract-revert/)).toBeInTheDocument();
    expect(screen.getByText(/Repayment window closed/)).toBeInTheDocument();
  });

  it('updates the header count live when new events fire while open', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Open issue report/i }));
    // Header now shows `Issue Details (visible/total)`; default filter is
    // "failure" so an info event bumps the total but not the visible count.
    expect(screen.getByText(/Issue Details \(0\/0\)/)).toBeInTheDocument();
    act(() => {
      emit({ area: 'wallet', flow: 'f', step: 's1', status: 'info' });
    });
    expect(screen.getByText(/Issue Details \(0\/1\)/)).toBeInTheDocument();
  });

  it('closes the drawer via the close button', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Open issue report/i }));
    fireEvent.click(screen.getByRole('button', { name: /Close/i }));
    expect(
      screen.queryByRole('dialog', { name: /Issue Details/i }),
    ).toBeNull();
  });

  it('clears the buffer via the "Clear" action', () => {
    emit({ area: 'wallet', flow: 'f', step: 's', status: 'info' });
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Open issue report/i }));
    expect(screen.getByText(/Issue Details \(0\/1\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
    expect(screen.getByText(/Issue Details \(0\/0\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/No events yet — take an action to start recording/i),
    ).toBeInTheDocument();
  });

  it('triggers a blob download directly when "Download" is clicked', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:mock2');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Open issue report/i }));
    fireEvent.click(screen.getByRole('button', { name: /Download/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock2');
  });
});
