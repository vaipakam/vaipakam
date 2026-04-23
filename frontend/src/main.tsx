import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { wagmiConfig } from './lib/wagmiConfig'
import { ThemeProvider } from './context/ThemeContext'
import { WalletProvider } from './context/WalletContext'
import { ChainProvider } from './context/ChainContext'
import { ModeProvider } from './context/ModeContext'
import './styles/global.css'
import App from './App.tsx'

// Single QueryClient for the whole app — wagmi v2 uses React Query for
// connection state, balance polling, contract-read caching. Keeping one
// instance module-scoped so HMR hot-reloads don't discard the cache.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 2,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {/* ConnectKitProvider reads the current theme from ThemeProvider
              via document.documentElement's `data-theme` (or equivalent)
              set by our theme toggle, so the wallet-picker modal's look
              tracks the rest of the app. `mode="auto"` follows the
              prefers-color-scheme hint as a fallback. */}
          <ConnectKitProvider mode="auto">
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
)
