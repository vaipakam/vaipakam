import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { wagmiConfig } from '../src/lib/wagmiConfig';
import { ThemeProvider } from '../src/context/ThemeContext';
import { WalletProvider } from '../src/context/WalletContext';
import { ChainProvider } from '../src/context/ChainContext';
import { ModeProvider } from '../src/context/ModeContext';
import { WatermarkProvider } from '../src/context/WatermarkContext';
import { RealtimePushProvider } from '../src/context/RealtimePushContext';
import { DataFreshnessProvider } from '../src/context/DataFreshnessContext';
import App from '../src/App';

/*
 * #1076: App-level smoke test. Two things rotted:
 *   1. The dead `vi.mock('ethers')` — src/ is 100% viem/wagmi now, so the
 *      mock did nothing but signal staleness. Removed.
 *   2. The provider tree — App mounts WalletProvider (→ wagmi `useAccount`)
 *      and the connected-app shell, which needs the FULL main.tsx provider
 *      stack (Wagmi → Query → Theme → ConnectKit → Wallet → Chain →
 *      Watermark → RealtimePush → DataFreshness → Mode). The old subset
 *      (Theme/Wallet/Mode only) threw `useConfig must be used within
 *      WagmiProvider`. App owns its own <BrowserRouter>, so no router is
 *      supplied here.
 *
 * The old assertion looked for a "Vault-to-Vault Lending" marketing
 * heading. That landing page moved to apps/labs; `/` on the connected-app
 * origin is now the Dashboard shell. The smoke check is now "App mounts
 * and renders its persistent chrome" — the app-wide ConsentBanner, which
 * paints on first mount before any consent choice is stored.
 */
function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ConnectKitProvider mode="auto">
            <WalletProvider>
              <ChainProvider>
                <WatermarkProvider>
                  <RealtimePushProvider>
                    <DataFreshnessProvider>
                      <ModeProvider>
                        <App />
                      </ModeProvider>
                    </DataFreshnessProvider>
                  </RealtimePushProvider>
                </WatermarkProvider>
              </ChainProvider>
            </WalletProvider>
          </ConnectKitProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}

describe('App router', () => {
  it('mounts without crashing', () => {
    renderApp();
    // Persistent app-wide chrome renders → the tree mounted cleanly.
    expect(screen.getByText(/Your privacy choices/i)).toBeInTheDocument();
  });
});
