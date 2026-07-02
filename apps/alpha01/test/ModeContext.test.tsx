import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeProvider, useMode } from '../src/context/ModeContext';

function Probe() {
  const { mode, toggleMode } = useMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button type="button" onClick={toggleMode}>toggle</button>
    </div>
  );
}

describe('ModeContext', () => {
  it('defaults to basic and toggles to advanced', async () => {
    render(
      <ModeProvider>
        <Probe />
      </ModeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('basic');
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('mode')).toHaveTextContent('advanced');
  });
});