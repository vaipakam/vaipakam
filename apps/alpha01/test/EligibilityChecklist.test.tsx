import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EligibilityChecklist } from '../src/components/EligibilityChecklist';

describe('EligibilityChecklist', () => {
  it('shows fix action for failing items', async () => {
    const onFix = vi.fn();
    render(
      <EligibilityChecklist
        items={[
          { id: 'wallet', label: 'Wallet connected', ok: false, fixLabel: 'Connect', onFix },
          { id: 'chain', label: 'Correct chain', ok: true },
        ]}
      />,
    );
    expect(screen.getByTestId('eligibility-checklist')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onFix).toHaveBeenCalled();
  });
});