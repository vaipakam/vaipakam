import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { wagmiConfig } from '../../src/lib/wagmiConfig';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ChainProvider } from '../../src/context/ChainContext';
import { ModeProvider } from '../../src/context/ModeContext';

// #1076: the topbar renders <IndexerStatusBadge>, which calls
// useLiveWatermark — that hook opens a per-chain WebSocket on mount and
// is DELIBERATELY unprovided by the test harness. Stub it (same shape the
// hook tests use). useDataFreshness / useRealtimePush both no-provider
// fallback, so they don't need stubbing.
vi.mock('../../src/hooks/useLiveWatermark', () => ({
  useLiveWatermark: () => ({ version: 0, snapshot: null, status: 'unreachable' }),
}));

const walletMock: any = {
  address: null,
  isConnecting: false,
  isCorrectChain: true,
  error: null,
  warning: null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  switchToDefaultChain: vi.fn(),
  switchToChain: vi.fn(),
  chainId: undefined,
  activeChain: null,
};
// #1076: useWallet is fully stubbed so tests can drive connection state.
// WalletProvider is a pass-through here — the real provider's wagmi reads
// are irrelevant once the hook itself is mocked.
vi.mock('../../src/context/WalletContext', () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  useWallet: () => walletMock,
}));

import AppLayout from '../../src/pages/AppLayout';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

// #1076: AppLayout needs nested routes (its own `/app/*` shell with an
// index child, plus a `/` home target the brand navigates to), which the
// single-route `renderWithProviders` can't express — so we mirror that
// helper's full provider tree here and add the routing the test needs.
function renderLayout() {
  const queryClient = makeQueryClient();
  return render(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ConnectKitProvider mode="auto">
            <ChainProvider>
              <ModeProvider>
                <MemoryRouter initialEntries={['/app']}>
                  <Routes>
                    <Route path="/app/*" element={<AppLayout />}>
                      <Route index element={<div>dashboard-content</div>} />
                    </Route>
                    <Route path="/" element={<div>home</div>} />
                  </Routes>
                </MemoryRouter>
              </ModeProvider>
            </ChainProvider>
          </ConnectKitProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}

// #1076: the mode/theme controls now live inside the topbar Settings
// popover (gear icon), not inline on the topbar — open it first.
async function openSettings() {
  await userEvent.click(screen.getByRole('button', { name: /^Settings$/i }));
}

describe('AppLayout', () => {
  beforeEach(() => {
    walletMock.address = null;
    walletMock.isConnecting = false;
    walletMock.isCorrectChain = true;
    walletMock.error = null;
    walletMock.warning = null;
    walletMock.chainId = undefined;
    walletMock.activeChain = null;
    walletMock.disconnect.mockReset();
    walletMock.switchToDefaultChain.mockReset();
    localStorage.removeItem('vaipakam.uiMode');
  });

  it('renders nav + connect button when no wallet', () => {
    walletMock.address = null;
    renderLayout();
    expect(screen.getAllByText(/Dashboard/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Connect Wallet/i })).toBeInTheDocument();
  });

  it('toggles theme', async () => {
    renderLayout();
    // #1076: theme toggle moved into the Settings popover; its label is
    // now "Switch to light/dark theme" (was "Toggle theme").
    await openSettings();
    const themeBtn = screen.getByRole('button', { name: /Switch to (light|dark) theme/i });
    await userEvent.click(themeBtn);
  });

  it('toggles mode via Settings Basic/Advanced switch', async () => {
    // #1076: the Basic/Advanced segmented switch moved from the topbar into
    // the Settings popover. The sidebar reveals its "Advanced" group label +
    // nested links (e.g. Keepers) only when mode is advanced.
    localStorage.removeItem('vaipakam.uiMode');
    renderLayout();
    await openSettings();
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
    // #1076: connected pill (<WalletMenu>) renders the address in compact
    // 2+4 form (`0x12…5678`) via <AddressDisplay compact>.
    expect(screen.getByText('0x12…5678')).toBeInTheDocument();
    // Disconnect now lives inside the wallet-menu popover — open it first.
    // #1076: the trigger's aria-label contains the word "disconnect", so
    // match the menuitem by its exact role+name to avoid hitting the pill.
    await userEvent.click(screen.getByRole('button', { name: /Wallet menu/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /^Disconnect$/i }));
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
    for (const b of buttons) { try { await userEvent.click(b); } catch { /* smoke */ } }
    // Nav links fire navigation and unmount; clicking just the first is enough to exercise handler
    const links = screen.queryAllByRole('link');
    if (links.length) { try { await userEvent.click(links[0]); } catch { /* smoke */ } }
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

  it('brand affordance navigates home', async () => {
    // #1076: the standalone "Back to Home" button was consolidated into the
    // sidebar brand link; home navigation is exercised via that affordance.
    renderLayout();
    const brand = document.querySelector('.sidebar-brand') as HTMLElement;
    expect(brand).toBeTruthy();
    await userEvent.click(brand);
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
