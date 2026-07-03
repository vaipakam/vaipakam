import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { ReviewReceipt } from '../src/components/ReviewReceipt';
import { ModeProvider } from '../src/context/ModeContext';

const data = {
  youReceive: { label: 'You receive', value: '100 USDC' },
  youLock: { label: 'You lock', value: '0.5 ETH' },
  youMayOwe: { label: 'You may owe', value: '105 USDC' },
  youCanLose: { label: 'You can lose', value: 'Collateral' },
  fees: { label: 'Fees', value: '1% protocol fee' },
  whenEnds: { label: 'When this ends', value: '30 days' },
};

function wrap(ui: ReactNode) {
  return render(<ModeProvider>{ui}</ModeProvider>);
}

describe('ReviewReceipt', () => {
  it('renders all six receipt fields', () => {
    wrap(<ReviewReceipt data={data} />);
    expect(screen.getByTestId('review-receipt')).toBeInTheDocument();
    expect(screen.getByText('100 USDC')).toBeInTheDocument();
    expect(screen.getByText('0.5 ETH')).toBeInTheDocument();
    expect(screen.getByText('When this ends')).toBeInTheDocument();
  });
});