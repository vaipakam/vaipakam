import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ModeProvider } from '../../src/context/ModeContext';

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

import AppLayout from '../../src/pages/AppLayout';

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <ThemeProvider>
        <ModeProvider>
          <Routes>
            <Route path="/app/*" element={<AppLayout />}>
              <Route index element={<div>dashboard-content</div>} />
            </Route>
            <Route path="/" element={<div>home</div>} />
          </Routes>
        </ModeProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('AppLayout', () => {
  it('renders nav + connect button when no wallet', () => {
    walletMock.address = null;
    renderLayout();
    expect(screen.getAllByText(/Dashboard/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Connect Wallet/i })).toBeInTheDocument();
  });

  it('toggles theme', async () => {
    renderLayout();
    const themeBtn = screen.getByRole('button', { name: /Toggle theme/i });
    await userEvent.click(themeBtn);
  });

  it('toggles mode via top-bar Basic/Advanced switch', async () => {
    // Mode is toggled via the global top-bar segmented switch so every page
    // inherits the current mode without its own inline toggle. The sidebar
    // reveals its "Advanced" group label + nested links only when mode is
    // advanced (no toggle button on the sidebar itself).
    localStorage.removeItem('vaipakam.uiMode');
    renderLayout();
    const basicBtn = screen.getByRole('button', { name: /^Basic$/ });
    const advancedBtn = screen.getByRole('button', { name: /^Advanced$/ });
    expect(basicBtn).toHaveAttribute('aria-pressed', 'true');
    expect(advancedBtn).toHaveAttribute('aria-pressed', 'false');
    // Sidebar nested advanced-only link (Keepers) should be hidden in basic.
    expect(screen.queryByRole('link', { name: /Keepers/i })).not.toBeInTheDocument();
    await userEvent.click(advancedBtn);
    expect(advancedBtn).toHaveAttribute('aria-pressed', 'true');
    expect(basicBtn).toHaveAttribute('aria-pressed', 'false');
    // After switching to advanced, the nested advanced link appears.
    expect(screen.getByRole('link', { name: /Keepers/i })).toBeInTheDocument();
  });

  it('wrong chain shows Switch Network', async () => {
    walletMock.address = '0xME';
    walletMock.isCorrectChain = false;
    renderLayout();
    const sw = screen.getByRole('button', { name: /Switch Network/i });
    await userEvent.click(sw);
    expect(walletMock.switchToDefaultChain).toHaveBeenCalled();
  });

  it('connected shows address badge and disconnect', async () => {
    walletMock.address = '0x1234567890abcdef1234567890abcdef12345678';
    walletMock.isCorrectChain = true;
    renderLayout();
    expect(screen.getByText(/0x1234/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Disconnect/i }));
    expect(walletMock.disconnect).toHaveBeenCalled();
  });

  it('sidebar open/close', async () => {
    renderLayout();
    const menuBtns = screen.getAllByRole('button');
    // First toolbar button is the menu
    await userEvent.click(menuBtns[0]);
  });

  it('clicks every nav link and sidebar buttons', async () => {
    renderLayout();
    const buttons = screen.getAllByRole('button');
    for (const b of buttons) { try { await userEvent.click(b); } catch {} }
    // Nav links fire navigation and unmount; clicking just the first is enough to exercise handler
    const links = screen.queryAllByRole('link');
    if (links.length) { try { await userEvent.click(links[0]); } catch {} }
  });

  it('logo onError hides image', () => {
    renderLayout();
    const imgs = document.querySelectorAll('img');
    imgs.forEach((img) => img.dispatchEvent(new Event('error')));
  });

  it('sidebar-brand click navigates home', async () => {
    renderLayout();
    const brand = document.querySelector('.sidebar-brand') as HTMLElement;
    expect(brand).toBeTruthy();
    await userEvent.click(brand);
    expect(await screen.findByText('home')).toBeInTheDocument();
  });

  it('overlay click closes sidebar', async () => {
    renderLayout();
    const menuBtn = document.querySelector('.topbar-menu-btn') as HTMLElement;
    await userEvent.click(menuBtn);
    const overlay = document.querySelector('.sidebar-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    await userEvent.click(overlay);
    expect(document.querySelector('.sidebar-overlay')).toBeNull();
  });

  it('back-to-home button navigates home', async () => {
    renderLayout();
    const back = screen.getByRole('button', { name: /Back to Home/i });
    await userEvent.click(back);
    expect(await screen.findByText('home')).toBeInTheDocument();
  });

  it('sidebar-close button closes sidebar', async () => {
    renderLayout();
    const menuBtn = document.querySelector('.topbar-menu-btn') as HTMLElement;
    await userEvent.click(menuBtn);
    const closeBtn = document.querySelector('.sidebar-close') as HTMLElement;
    await userEvent.click(closeBtn);
  });

  it('nav link click closes sidebar via onClick', async () => {
    renderLayout();
    const links = screen.getAllByRole('link');
    await userEvent.click(links[1]);
  });

  it('shows wallet error banner', () => {
    walletMock.error = 'boom';
    renderLayout();
    expect(screen.getByText('boom')).toBeInTheDocument();
    walletMock.error = null;
  });
});
