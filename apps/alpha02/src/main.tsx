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
    {/* Outermost boundary: ABOVE the provider stack, because a
        boundary only catches its descendants — a throw inside
        ThemeProvider/Wagmi/QueryClient/ConnectKit/router would
        otherwise still white-screen. ErrorBoundary itself uses no
        hooks or context, so it is safe out here. No resetKey —
        reload recovers. */}
    <ErrorBoundary>
    <ThemeProvider>
      <ModeProvider>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <ConnectKitThemed>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ConnectKitThemed>
          </QueryClientProvider>
        </WagmiProvider>
      </ModeProvider>
    </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
