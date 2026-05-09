import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import DiagnosticsDrawer from '../../src/components/app/DiagnosticsDrawer';
import { emit, clearJourney } from '../../src/lib/journeyLog';

beforeEach(() => {
  clearJourney();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiagnosticsDrawer', () => {
  it('renders a floating button labeled "Diagnostics" that opens the drawer on click', () => {
    render(<DiagnosticsDrawer />);
    expect(
      screen.queryByRole('dialog', { name: /Diagnostics/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
    expect(
      screen.getByRole('dialog', { name: /Diagnostics/i }),
    ).toBeInTheDocument();
  });

  it('shows a failure-count badge on the FAB when any event is a failure', () => {
    emit({ area: 'wallet', flow: 'f', step: 's', status: 'failure' });
    emit({ area: 'wallet', flow: 'f', step: 's2', status: 'failure' });
    emit({ area: 'wallet', flow: 'f', step: 's3', status: 'success' });
    render(<DiagnosticsDrawer />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders the empty-state hint when the buffer is empty', () => {
    render(<DiagnosticsDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
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
    render(<DiagnosticsDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
    expect(screen.getByText(/^repay$/)).toBeInTheDocument();
    expect(screen.getByText(/repayLoan/)).toBeInTheDocument();
    expect(screen.getByText(/submit-tx · loan #42/)).toBeInTheDocument();
    expect(screen.getByText(/contract-revert/)).toBeInTheDocument();
    expect(screen.getByText(/Repayment window closed/)).toBeInTheDocument();
  });

  it('updates the header count live when new events fire while open', () => {
    render(<DiagnosticsDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
    expect(screen.getByText(/Diagnostics \(0\)/)).toBeInTheDocument();
    act(() => {
      emit({ area: 'wallet', flow: 'f', step: 's1', status: 'info' });
    });
    expect(screen.getByText(/Diagnostics \(1\)/)).toBeInTheDocument();
  });

  it('closes the drawer via the close button and the overlay', () => {
    render(<DiagnosticsDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
    fireEvent.click(screen.getByRole('button', { name: /Close/i }));
    expect(
      screen.queryByRole('dialog', { name: /Diagnostics/i }),
    ).toBeNull();
  });

  it('clears the buffer via the "Clear" action', () => {
    emit({ area: 'wallet', flow: 'f', step: 's', status: 'info' });
    render(<DiagnosticsDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
    expect(screen.getByText(/Diagnostics \(1\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
    expect(screen.getByText(/Diagnostics \(0\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/No events yet — take an action to start recording/i),
    ).toBeInTheDocument();
  });

  it('copies redacted JSON to the clipboard when "Copy JSON" is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    emit({ area: 'wallet', flow: 'f', step: 's', status: 'info' });
    render(<DiagnosticsDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Copy JSON/i }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(Array.isArray(payload.events)).toBe(true);
  });

  it('falls back to download when clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('blocked'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const createObjectURL = vi.fn().mockReturnValue('blob:mock');
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
    render(<DiagnosticsDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Copy JSON/i }));
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
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
    render(<DiagnosticsDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /Open diagnostics/i }));
    fireEvent.click(screen.getByRole('button', { name: /Download/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock2');
  });
});
