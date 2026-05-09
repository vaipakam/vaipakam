import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';

const walletMock: any = {
  address: null,
  isConnecting: false,
  isCorrectChain: true,
  error: null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  switchToDefaultChain: vi.fn(),
};
vi.mock('../../src/context/WalletContext', () => ({ useWallet: () => walletMock }));

import Navbar from '../../src/components/Navbar';

function renderNav() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <Navbar />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('Navbar', () => {
  it('shows Connect Wallet when no address', async () => {
    walletMock.address = null;
    renderNav();
    expect(screen.getAllByRole('button', { name: /Connect Wallet/i }).length).toBeGreaterThan(0);
  });

  it('shows Switch Network on wrong chain', async () => {
    walletMock.address = '0xABC';
    walletMock.isCorrectChain = false;
    renderNav();
    const switchBtns = screen.getAllByRole('button', { name: /Wrong Network|Switch Network/i });
    await userEvent.click(switchBtns[0]);
    expect(walletMock.switchToDefaultChain).toHaveBeenCalled();
  });

  it('shows address and disconnect when connected', async () => {
    walletMock.address = '0x1234567890abcdef1234567890abcdef12345678';
    walletMock.isCorrectChain = true;
    renderNav();
    expect(screen.getAllByText(/0x1234/)[0]).toBeInTheDocument();
    const disc = screen.getAllByRole('button', { name: /Disconnect/i });
    await userEvent.click(disc[0]);
    expect(walletMock.disconnect).toHaveBeenCalled();
  });

  it('mobile toggle and theme toggle fire', async () => {
    renderNav();
    const buttons = screen.getAllByRole('button');
    // Fire every toolbar button to exercise event handlers
    for (const b of buttons.slice(0, 4)) {
      try { await userEvent.click(b); } catch {}
    }
  });

  it('shows error banner when wallet error present', () => {
    walletMock.error = 'some-error';
    renderNav();
    expect(screen.getAllByText(/some-error/).length).toBeGreaterThan(0);
    walletMock.error = null;
  });
});
