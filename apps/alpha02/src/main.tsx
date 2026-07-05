import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { wagmiConfig } from './chain/wagmi';
import { ThemeProvider, useTheme } from './app/ThemeContext';
import { ModeProvider } from './app/ModeContext';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Indexer reads already carry their own refetch cadence; avoid
      // aggressive window-focus refetch storms on mobile tab switches.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** ConnectKit needs the RESOLVED theme (it has no 'system' mode that
 *  tracks ours), so this bridge lives under ThemeProvider. */
function ConnectKitThemed({ children }: { children: React.ReactNode }) {
  const { resolved } = useTheme();
  return (
    <ConnectKitProvider
      mode={resolved}
      // Let wallets on UNSUPPORTED chains connect — alpha02's own
      // NetworkBanner then guides the switch. ConnectKit's default
      // gate would block the connection before the banner can render.
      options={{ initialChainId: 0, enforceSupportedChains: false }}
    >
      {children}
    </ConnectKitProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ModeProvider>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <ConnectKitThemed>
              <BrowserRouter>
                {/* Outer boundary: catches shell/provider-level render
                    crashes the route-level boundary can't (it lives
                    inside the shell). No resetKey — reload recovers. */}
                <ErrorBoundary>
                  <App />
                </ErrorBoundary>
              </BrowserRouter>
            </ConnectKitThemed>
          </QueryClientProvider>
        </WagmiProvider>
      </ModeProvider>
    </ThemeProvider>
  </StrictMode>,
);
