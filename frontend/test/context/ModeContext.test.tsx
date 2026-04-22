import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeProvider, useMode } from '../../src/context/ModeContext';

function Probe() {
  const { mode, setMode, toggleMode } = useMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button onClick={toggleMode}>toggle</button>
      <button onClick={() => setMode('advanced')}>set-adv</button>
      <button onClick={() => setMode('basic')}>set-basic</button>
    </div>
  );
}

describe('ModeContext', () => {
  it('defaults to basic when nothing stored', () => {
    render(<ModeProvider><Probe /></ModeProvider>);
    expect(screen.getByTestId('mode')).toHaveTextContent('basic');
  });

  it('reads advanced from localStorage', () => {
    localStorage.setItem('vaipakam.uiMode', 'advanced');
    render(<ModeProvider><Probe /></ModeProvider>);
    expect(screen.getByTestId('mode')).toHaveTextContent('advanced');
  });

  it('toggleMode flips value and persists', async () => {
    render(<ModeProvider><Probe /></ModeProvider>);
    await userEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('mode')).toHaveTextContent('advanced');
    expect(localStorage.getItem('vaipakam.uiMode')).toBe('advanced');
    await userEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('mode')).toHaveTextContent('basic');
  });

  it('setMode sets explicit value', async () => {
    render(<ModeProvider><Probe /></ModeProvider>);
    await userEvent.click(screen.getByText('set-adv'));
    expect(screen.getByTestId('mode')).toHaveTextContent('advanced');
    await userEvent.click(screen.getByText('set-basic'));
    expect(screen.getByTestId('mode')).toHaveTextContent('basic');
  });

  it('throws without provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/ModeProvider/);
    spy.mockRestore();
  });
});
