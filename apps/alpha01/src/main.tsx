import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { wagmiConfig, walletConnectConfigured } from './lib/wagmiConfig';
import { ThemeProvider } from './context/ThemeContext';
import { WalletProvider } from './context/WalletContext';
import { ChainProvider } from './context/ChainContext';
import { ModeProvider } from './context/ModeContext';
import './styles/global.css';
import App from './App';

if (!walletConnectConfigured) {
  console.warn('[alpha01] VITE_WALLETCONNECT_PROJECT_ID is not set — mobile deep-links disabled.');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: 2 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ConnectKitProvider
            mode="auto"
            options={{
              walletConnectCTA: 'both',
              initialChainId: 0,
              enforceSupportedChains: false,
            }}
          >
            <WalletProvider>
              <ChainProvider>
                <ModeProvider>
                  <App />
                </ModeProvider>
              </ChainProvider>
            </WalletProvider>
          </ConnectKitProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);